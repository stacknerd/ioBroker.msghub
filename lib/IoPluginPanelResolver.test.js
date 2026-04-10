'use strict';

const { expect } = require('chai');

const { IoPluginPanelResolver, normalizePluginUiLang } = require('./IoPluginPanelResolver');

describe('IoPluginPanelResolver', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	function makeIoPlugins() {
		return {
			getAdminUiContributions() {
				return [
					{
						pluginType: 'IngestStates',
						instanceId: 0,
						panelId: 'presets',
						label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
						description: 'msghub.i18n.IngestStates.ui.panels.presets.description.text',
						category: 'user',
						app: { name: 'plugin.app.name', url: '?panel=tab-plugin-IngestStates-0-presets' },
						apiVersion: '1',
						bundle: { hash: '' },
					},
				];
			},
			async computeAdminUiBundleHash() {
				return 'sha256-testhash';
			},
			async readAdminUiTranslations({ type, lang }) {
				return { lang, translations: { [`msghub.i18n.${type}.ui.foo`]: 'Foo' } };
			},
		};
	}

	it('normalizes plugin UI lang to safe lowercase tags with en fallback', () => {
		expect(normalizePluginUiLang('DE')).to.equal('de');
		expect(normalizePluginUiLang('de-DE')).to.equal('de-de');
		expect(normalizePluginUiLang('@@')).to.equal('en');
		expect(normalizePluginUiLang()).to.equal('en');
	});

	it('resolves runtime-id and direct lookups through one canonical runtime DTO', async () => {
		const resolver = new IoPluginPanelResolver({ ioPlugins: makeIoPlugins(), log: createAdapter().log });
		const panelsByRuntimeId = await resolver.getPanelsByRuntimeId({ lang: 'de' });
		expect(panelsByRuntimeId).to.deep.equal({
			'plugin-IngestStates-0-presets': {
			id: 'plugin-IngestStates-0-presets',
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
			description: 'msghub.i18n.IngestStates.ui.panels.presets.description.text',
			category: 'user',
			ui: {
				kind: 'plugin',
				loader: 'esm',
				apiVersion: '1',
				bundle: { hash: 'sha256-testhash' },
				i18n: { lang: 'de', translations: { 'msghub.i18n.IngestStates.ui.foo': 'Foo' } },
			},
			app: { name: 'plugin.app.name', url: '?panel=tab-plugin-IngestStates-0-presets' },
			},
		});

		expect(
			await resolver.getPanelByRuntimeId({ runtimePanelId: 'plugin-IngestStates-0-presets', lang: 'de' }),
		).to.deep.equal(panelsByRuntimeId['plugin-IngestStates-0-presets']);
		expect(
			await resolver.getPanelByRef({ pluginType: 'IngestStates', instanceId: 0, panelId: 'presets', lang: 'de' }),
		).to.deep.equal(panelsByRuntimeId['plugin-IngestStates-0-presets']);
	});

	it('throws NOT_READY when runtime dependencies are missing', async () => {
		const resolver = new IoPluginPanelResolver({ ioPlugins: null, log: createAdapter().log });
		try {
			await resolver.getPanelsByRuntimeId({ lang: 'de' });
			throw new Error('Expected NOT_READY');
		} catch (error) {
			expect(error).to.have.property('code', 'NOT_READY');
		}
	});
});
