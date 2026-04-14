'use strict';

const { expect } = require('chai');

const { IoAdminCapabilities } = require('./IoAdminCapabilities');

/**
 * Build a minimal adapter stub for IoAdminCapabilities tests.
 *
 * @returns {object} Adapter stub.
 */
function makeAdapter() {
	return {
		namespace: 'msghub.0',
		i18nBackend: { i18nlocale: 'de' },
		i18nCore: { i18nlocale: 'en', locale: 'de-DE' },
		_coreConnection: {
			getRuntimeAbout() {
				return { scope: 'core-link', connected: true, mode: 'local' };
			},
		},
	};
}

describe('IoAdminCapabilities', () => {
	it('buildBootstrap returns capability tokens for the admin host', () => {
		const capabilities = new IoAdminCapabilities(makeAdapter(), {
			ioPackage: {
				common: {
					version: '1.2.3',
					titleLang: { en: 'Message Hub', de: 'Message Hub' },
				},
			},
		});

		const result = capabilities.buildBootstrap({ host: 'admin' });
		expect(result).to.have.keys(['capabilities', 'about']);
		expect(result.capabilities).to.have.keys(['admin', 'config', 'web']);
		for (const key of ['admin', 'config', 'web']) {
			expect(result.capabilities[key]).to.have.keys(['token', 'expiresAt']);
			expect(result.capabilities[key].token).to.be.a('string').and.not.equal('');
			expect(Date.parse(result.capabilities[key].expiresAt)).to.be.a('number');
		}
		expect(result.about).to.include({
			title: 'Message Hub',
			version: '1.2.3',
		});
		expect(result.about.lang).to.deep.equal({
			backendTextLanguage: 'de',
			coreTextLanguage: 'en',
			coreFormatLocale: 'de-DE',
		});
		expect(result.about.connection).to.deep.equal({
			scope: 'core-link',
			connected: true,
			mode: 'local',
		});
	});

	it('returns host-specific capability sets', () => {
		const capabilities = new IoAdminCapabilities(makeAdapter());
		expect(capabilities.buildCapabilities({ host: 'admin' })).to.have.keys(['admin', 'config', 'web']);
		expect(capabilities.buildCapabilities({ host: 'webExtension' })).to.have.keys(['web']);
	});

	it('buildBootstrap returns only the web token for the webExtension host', () => {
		const capabilities = new IoAdminCapabilities(makeAdapter());
		const result = capabilities.buildBootstrap({ host: 'webExtension' });
		expect(result.capabilities).to.deep.equal({
			web: {
				token: result.capabilities.web.token,
				expiresAt: result.capabilities.web.expiresAt,
			},
		});
		expect(result.capabilities.web.token).to.be.a('string').and.not.equal('');
	});

	it('rejects unsupported bootstrap hosts', () => {
		const capabilities = new IoAdminCapabilities(makeAdapter());
		expect(() => capabilities.buildBootstrap({ host: 'invalid-host' })).to.throw(
			/Unsupported bootstrap host/,
		);
	});

	it('validates tokens only for the original host and capability', () => {
		const capabilities = new IoAdminCapabilities(makeAdapter());
		const grant = capabilities.mintToken({ host: 'admin', capability: 'web' });

		expect(
			capabilities.validateToken({
				host: 'admin',
				capability: 'web',
				token: grant.token,
			}),
		).to.deep.equal(grant);
		expect(() =>
			capabilities.validateToken({
				host: 'webExtension',
				capability: 'web',
				token: grant.token,
			}),
		).to.throw(/Token host mismatch/);
		expect(() =>
			capabilities.validateToken({
				host: 'admin',
				capability: 'config',
				token: grant.token,
			}),
		).to.throw(/Token capability mismatch/);
	});

	it('expires tokens after the AP14 TTL window', () => {
		const capabilities = new IoAdminCapabilities(makeAdapter());
		let now = 1_000_000;
		capabilities.getNow = () => now;

		const grant = capabilities.mintToken({ host: 'admin', capability: 'admin' });
		expect(
			capabilities.validateToken({
				host: 'admin',
				capability: 'admin',
				token: grant.token,
			}),
		).to.deep.equal(grant);

		now += IoAdminCapabilities.TOKEN_TTL_MS + 1;
		expect(() =>
			capabilities.validateToken({
				host: 'admin',
				capability: 'admin',
				token: grant.token,
			}),
		).to.throw(/Invalid or expired token/);
	});

	it('consumes payload.token and returns the cleaned business payload', () => {
		const capabilities = new IoAdminCapabilities(makeAdapter());
		const grant = capabilities.mintToken({ host: 'admin', capability: 'config' });

		const cleanedPayload = capabilities.consumePayloadToken({
			host: 'admin',
			capability: 'config',
			payload: {
				token: grant.token,
				foo: 'bar',
				nested: { ok: true },
			},
		});

		expect(cleanedPayload).to.deep.equal({
			foo: 'bar',
			nested: { ok: true },
		});
	});

	it('rejects missing payload.token in the canonical payload contract', () => {
		const capabilities = new IoAdminCapabilities(makeAdapter());
		expect(() =>
			capabilities.consumePayloadToken({
				host: 'admin',
				capability: 'web',
				payload: { hello: 'world' },
			}),
		).to.throw(/Missing token/);
	});
});
