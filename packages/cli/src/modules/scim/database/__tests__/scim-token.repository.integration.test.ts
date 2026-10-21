import { testDb, testModules } from '@n8n/backend-test-utils';
import { Container } from '@n8n/di';

import { ScimTokenRepository } from '../scim-token.repository';

let repository: ScimTokenRepository;

const at = (second: number) => new Date(Date.UTC(2026, 9, 19, 12, 0, second));

beforeAll(async () => {
	await testModules.loadModules(['scim']);
	await testDb.init();

	repository = Container.get(ScimTokenRepository);
});

afterAll(async () => {
	await testDb.terminate();
});

beforeEach(async () => {
	await repository.delete({});
	await repository.replace(null, { tokenHash: 'a-hash', tokenHint: 'abcd', createdById: null }, {});
});

const lastUsedAt = async () => (await repository.findInstanceToken({}))?.lastUsedAt;

describe('ScimTokenRepository.markUsed', () => {
	it('sets the first use', async () => {
		await repository.markUsed('a-hash', at(1), {});

		expect(await lastUsedAt()).toEqual(at(1));
	});

	it('sets a later use', async () => {
		await repository.markUsed('a-hash', at(1), {});

		await repository.markUsed('a-hash', at(2), {});

		expect(await lastUsedAt()).toEqual(at(2));
	});

	// Another main, or a slow commit, can write an older time last.
	it('keeps the later use when an older write comes last', async () => {
		await repository.markUsed('a-hash', at(2), {});

		await repository.markUsed('a-hash', at(1), {});

		expect(await lastUsedAt()).toEqual(at(2));
	});

	it('does not mark a token with another hash', async () => {
		await repository.markUsed('other-hash', at(1), {});

		expect(await lastUsedAt()).toBeNull();
	});
});
