'use strict';

const { expect } = require('chai');

const { IoPluginPanelResolver } = require('./IoPluginPanelResolver');

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
		};
	}

	it('resolves runtime-id and direct lookups through one canonical runtime DTO', async () => {
		const resolver = new IoPluginPanelResolver({ ioPlugins: makeIoPlugins(), log: createAdapter().log });
		const panelsByRuntimeId = await resolver.getPanelsByRuntimeId();
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
				},
				app: { name: 'plugin.app.name', url: '?panel=tab-plugin-IngestStates-0-presets' },
			},
		});

		expect(await resolver.getPanelByRuntimeId({ runtimePanelId: 'plugin-IngestStates-0-presets' })).to.deep.equal(
			panelsByRuntimeId['plugin-IngestStates-0-presets'],
		);
		expect(
			await resolver.getPanelByRef({ pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' }),
		).to.deep.equal(panelsByRuntimeId['plugin-IngestStates-0-presets']);
	});

	it('throws NOT_READY when runtime dependencies are missing', async () => {
		const resolver = new IoPluginPanelResolver({ ioPlugins: null, log: createAdapter().log });
		try {
			await resolver.getPanelsByRuntimeId();
			throw new Error('Expected NOT_READY');
		} catch (error) {
			expect(error).to.have.property('code', 'NOT_READY');
		}
	});
});
