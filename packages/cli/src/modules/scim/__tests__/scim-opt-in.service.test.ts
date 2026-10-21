import { SCIM_OPT_IN_FLAG } from '@n8n/api-types';
import type { Logger, ModuleRegistry } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Container } from '@n8n/di';
import type { NextFunction, Request, Response } from 'express';
import type { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import { PostHogClient } from '@/posthog';

import {
	SCIM_OPT_IN_REFRESH_INTERVAL_MS,
	SCIM_OPT_IN_REFRESH_MARGIN_MS,
	ScimOptInService,
} from '../scim-opt-in.service';
import type { ScimConfig } from '../scim.config';

describe('ScimOptInService', () => {
	const scimConfig = mock<ScimConfig>();
	const postHogClient = mock<PostHogClient>();
	const moduleRegistry = mock<ModuleRegistry>();

	let service: ScimOptInService;

	beforeEach(() => {
		vi.clearAllMocks();
		scimConfig.optIn = false;
		postHogClient.getFeatureFlagForInstance.mockResolvedValue(undefined);
		// A new service for each test, because the service caches the flag result.
		service = new ScimOptInService(mock<Logger>(), scimConfig, postHogClient, moduleRegistry);
	});

	describe('evaluate', () => {
		it('is on with source config when the config switch is on', async () => {
			scimConfig.optIn = true;

			await expect(service.evaluate()).resolves.toEqual({ available: true, source: 'config' });
			// The switch wins, so a PostHog outage cannot close the routes.
			expect(postHogClient.getFeatureFlagForInstance).not.toHaveBeenCalled();
		});

		it('is on with source flag when the instance flag is on', async () => {
			postHogClient.getFeatureFlagForInstance.mockResolvedValue(true);

			await expect(service.evaluate()).resolves.toEqual({ available: true, source: 'flag' });
			expect(postHogClient.getFeatureFlagForInstance).toHaveBeenCalledWith(SCIM_OPT_IN_FLAG);
		});

		it.each([undefined, false, 'true'])(
			'is off when the switch is off and the flag is %j',
			async (flag) => {
				postHogClient.getFeatureFlagForInstance.mockResolvedValue(flag);

				await expect(service.evaluate()).resolves.toEqual({ available: false, source: null });
			},
		);
	});

	describe('flag cache', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it.each([
			['on', true],
			['off', false],
			['empty', undefined],
		])('keeps an %s flag result for the refresh interval', async (_, flag) => {
			postHogClient.getFeatureFlagForInstance.mockResolvedValue(flag);

			const first = await service.evaluate();
			const second = await service.evaluate();

			expect(second).toEqual(first);
			expect(postHogClient.getFeatureFlagForInstance).toHaveBeenCalledTimes(1);
		});

		it('calls PostHog once for many gate calls while PostHog fails', async () => {
			postHogClient.getFeatureFlagForInstance.mockRejectedValue(new Error('PostHog unreachable'));
			const res = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
			const next: NextFunction = vi.fn();

			await Promise.all(
				Array.from(
					{ length: 100 },
					async () => await service.gate(mock<Request>(), res as unknown as Response, next),
				),
			);
			await service.gate(mock<Request>(), res as unknown as Response, next);

			expect(postHogClient.getFeatureFlagForInstance).toHaveBeenCalledTimes(1);
			expect(res.status).toHaveBeenCalledTimes(101);
			expect(res.status).toHaveBeenCalledWith(404);
			expect(next).not.toHaveBeenCalled();
		});

		it('evaluates the flag again after the refresh interval', async () => {
			vi.useFakeTimers();
			postHogClient.getFeatureFlagForInstance.mockResolvedValue(false);
			await expect(service.evaluate()).resolves.toEqual({ available: false, source: null });

			postHogClient.getFeatureFlagForInstance.mockResolvedValue(true);
			vi.advanceTimersByTime(SCIM_OPT_IN_REFRESH_INTERVAL_MS + 1);

			await expect(service.evaluate()).resolves.toEqual({ available: true, source: 'flag' });
			expect(postHogClient.getFeatureFlagForInstance).toHaveBeenCalledTimes(2);
		});
	});

	describe('N8N_FEATURE_FLAG_OVERRIDES', () => {
		// A real client with no `init()` call has no PostHog connection, which is
		// the state with diagnostics off.
		const evaluateWithEnv = async (overrides: string | undefined) => {
			if (overrides === undefined) delete process.env.N8N_FEATURE_FLAG_OVERRIDES;
			else process.env.N8N_FEATURE_FLAG_OVERRIDES = overrides;
			Container.reset();

			const realClient = new PostHogClient(
				mock<InstanceSettings>({ instanceId: 'instance-1' }),
				Container.get(GlobalConfig),
			);
			const withRealClient = new ScimOptInService(
				mock<Logger>(),
				scimConfig,
				realClient,
				moduleRegistry,
			);

			return await withRealClient.evaluate();
		};

		afterEach(() => {
			delete process.env.N8N_FEATURE_FLAG_OVERRIDES;
			Container.reset();
		});

		it('turns the opt-in on when PostHog is not available', async () => {
			await expect(evaluateWithEnv(JSON.stringify({ [SCIM_OPT_IN_FLAG]: true }))).resolves.toEqual({
				available: true,
				source: 'flag',
			});
		});

		it('keeps the opt-in off without the override', async () => {
			await expect(evaluateWithEnv(undefined)).resolves.toEqual({
				available: false,
				source: null,
			});
		});
	});

	describe('gate', () => {
		const makeRes = () => {
			const res = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() };
			return res as unknown as Response & { status: typeof res.status; send: typeof res.send };
		};

		it('passes the request on while the opt-in is on', async () => {
			scimConfig.optIn = true;
			const res = makeRes();
			const next: NextFunction = vi.fn();

			await service.gate(mock<Request>(), res, next);

			expect(next).toHaveBeenCalledWith();
			expect(res.status).not.toHaveBeenCalled();
		});

		it('answers 404 while the opt-in is off', async () => {
			const res = makeRes();
			const next: NextFunction = vi.fn();

			await service.gate(mock<Request>(), res, next);

			expect(res.status).toHaveBeenCalledWith(404);
			expect(next).not.toHaveBeenCalled();
		});
	});

	describe('settings refresh', () => {
		const INTERVAL = SCIM_OPT_IN_REFRESH_INTERVAL_MS;
		const MARGIN = SCIM_OPT_IN_REFRESH_MARGIN_MS;

		/** The module settings read the opt-in through `evaluate`, as in production. */
		const snapshotEvaluates = () =>
			moduleRegistry.refreshModuleSettings.mockImplementation(async () => {
				await service.evaluate();
				return null;
			});

		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			service.stopSettingsRefresh();
			vi.useRealTimers();
		});

		it('makes the module settings again after one interval', async () => {
			moduleRegistry.refreshModuleSettings.mockResolvedValue(null);

			service.startSettingsRefresh();
			await vi.advanceTimersByTimeAsync(INTERVAL + MARGIN);

			expect(moduleRegistry.refreshModuleSettings).toHaveBeenCalledWith('scim');
		});

		it('does not clear a flag result before it expires', async () => {
			snapshotEvaluates();
			service.startSettingsRefresh();
			await vi.advanceTimersByTimeAsync(INTERVAL / 2);
			await service.evaluate();

			// The first refresh runs while the result is still fresh.
			await vi.advanceTimersByTimeAsync(INTERVAL / 2 + MARGIN);
			expect(moduleRegistry.refreshModuleSettings).toHaveBeenCalledTimes(1);
			expect(postHogClient.getFeatureFlagForInstance).toHaveBeenCalledTimes(1);

			// The next refresh runs after the result expires.
			await vi.advanceTimersByTimeAsync(INTERVAL / 2);
			expect(moduleRegistry.refreshModuleSettings).toHaveBeenCalledTimes(2);
			expect(postHogClient.getFeatureFlagForInstance).toHaveBeenCalledTimes(2);
		});

		// PostHogClient caches the flag for the same interval. A refresh that
		// cleared a fresh result got the old PostHog value and kept it for one
		// more interval.
		it('shows a flag change within one interval, although PostHog caches the flag too', async () => {
			let flagInPostHog = false;
			let postHogCache: { value: boolean; expiresAt: number } | undefined;
			postHogClient.getFeatureFlagForInstance.mockImplementation(async () => {
				if (!postHogCache || postHogCache.expiresAt <= Date.now()) {
					postHogCache = { value: flagInPostHog, expiresAt: Date.now() + INTERVAL };
				}
				return postHogCache.value;
			});
			snapshotEvaluates();
			service.startSettingsRefresh();
			await vi.advanceTimersByTimeAsync(INTERVAL / 2);
			await expect(service.evaluate()).resolves.toEqual({ available: false, source: null });

			flagInPostHog = true;
			await vi.advanceTimersByTimeAsync(INTERVAL + MARGIN);

			await expect(service.evaluate()).resolves.toEqual({ available: true, source: 'flag' });
			expect(moduleRegistry.refreshModuleSettings).toHaveBeenCalledTimes(2);
		});

		it('keeps the schedule when a refresh fails', async () => {
			moduleRegistry.refreshModuleSettings.mockRejectedValue(new Error('db down'));

			service.startSettingsRefresh();
			await vi.advanceTimersByTimeAsync(2 * (INTERVAL + MARGIN));

			expect(moduleRegistry.refreshModuleSettings).toHaveBeenCalledTimes(2);
		});

		it('does not refresh while the config switch is on', async () => {
			scimConfig.optIn = true;

			service.startSettingsRefresh();
			await vi.advanceTimersByTimeAsync(INTERVAL + MARGIN);

			expect(moduleRegistry.refreshModuleSettings).not.toHaveBeenCalled();
		});

		it('stops on shutdown', async () => {
			service.startSettingsRefresh();
			service.stopSettingsRefresh();
			await vi.advanceTimersByTimeAsync(INTERVAL + MARGIN);

			expect(moduleRegistry.refreshModuleSettings).not.toHaveBeenCalled();
		});
	});
});
