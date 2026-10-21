import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Container } from '@n8n/di';
import { getErrorMessage } from '@n8n/utils/errors/get-error-message';

import { OtelSdk } from './otel-sdk';

export async function bootObservability(): Promise<void> {
	await loadSentryHook();
	startOtelSdk();
}

async function loadSentryHook(): Promise<void> {
	try {
		if (isSentryTracingEnabled(Container.get(GlobalConfig))) await import('@sentry/node/import');
	} catch (error) {
		Container.get(Logger).error(
			'Failed to load the Sentry load hook, so Sentry traces have no route names',
			{ error: getErrorMessage(error) },
		);
	}
}

function startOtelSdk(): void {
	try {
		Container.get(OtelSdk).start();
	} catch (error) {
		Container.get(Logger).error('Failed to set up observability at startup, so tracing stays off', {
			error: getErrorMessage(error),
		});
	}
}

function isSentryTracingEnabled({ sentry }: GlobalConfig): boolean {
	return sentry.backendDsn !== '' && sentry.tracesSampleRate > 0;
}
