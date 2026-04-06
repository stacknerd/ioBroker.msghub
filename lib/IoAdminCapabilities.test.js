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
	it('buildBootstrap returns the stable AP3 shape with empty capabilities', () => {
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
		expect(result.capabilities).to.deep.equal({});
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

	it('accepts both supported host classes without changing the AP3 capability block', () => {
		const capabilities = new IoAdminCapabilities(makeAdapter());
		expect(capabilities.buildCapabilities({ host: 'admin' })).to.deep.equal({});
		expect(capabilities.buildCapabilities({ host: 'webExtension' })).to.deep.equal({});
	});

	it('rejects unsupported bootstrap hosts', () => {
		const capabilities = new IoAdminCapabilities(makeAdapter());
		expect(() => capabilities.buildBootstrap({ host: 'invalid-host' })).to.throw(
			/Unsupported bootstrap host/,
		);
	});
});
