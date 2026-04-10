'use strict';

const { expect } = require('chai');

const { DEFAULT_COMPOSITION_ID, IoUiCatalog } = require('./IoUiCatalog');

describe('IoUiCatalog', () => {
	let catalog;
	let pluginPanelResolver;

	beforeEach(() => {
		pluginPanelResolver = {
			async getPanelsByRuntimeId({ lang }) {
				if (lang === 'none') {
					return {};
				}
				return {
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
							i18n: {
								lang,
								translations: { 'msghub.i18n.IngestStates.ui.panels.presets.label': 'Presets' },
							},
						},
						app: { name: 'plugin.app.name', url: '?panel=tab-plugin-IngestStates-0-presets' },
					},
				};
			},
		};
		catalog = new IoUiCatalog({ pluginPanelResolver });
	});

	it('returns the default composition when composition mode omits targetId', async () => {
		const view = await catalog.getView({ mode: 'composition' });
		expect(DEFAULT_COMPOSITION_ID).to.equal('adminTab');
		expect(view.request).to.deep.equal({ mode: 'composition', targetId: 'adminTab', lang: 'en' });
		expect(view.composition.id).to.equal('adminTab');
		expect(view.corePanels).to.have.keys(['messages', 'plugins']);
		expect(view.pluginPanels).to.have.keys(['plugin-IngestStates-0-presets']);
	});

	it('returns the requested composition, request.lang, and resolved pluginPanels', async () => {
		const view = await catalog.getView({ mode: 'composition', targetId: 'web', lang: 'de' });
		expect(view.request).to.deep.equal({ mode: 'composition', targetId: 'web', lang: 'de' });
		expect(view.composition.id).to.equal('web');
		expect(view.composition.panels).to.deep.equal([
			'messages',
			{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
		]);
		expect(view.corePanels).to.have.keys(['messages']);
		expect(view.pluginPanels).to.deep.equal({
			'plugin-IngestStates-0-presets': {
				id: 'plugin-IngestStates-0-presets',
				label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
				description: 'msghub.i18n.IngestStates.ui.panels.presets.description.text',
				category: 'user',
				ui: {
					kind: 'plugin',
					loader: 'esm',
					apiVersion: '1',
					bundle: { hash: 'sha256-testhash' },
					i18n: {
						lang: 'de',
						translations: { 'msghub.i18n.IngestStates.ui.panels.presets.label': 'Presets' },
					},
				},
				app: { name: 'plugin.app.name', url: '?panel=tab-plugin-IngestStates-0-presets' },
			},
		});
	});

	it('materializes wildcard compositions backend-side', async () => {
		const view = await catalog.getView({ mode: 'composition', targetId: 'full', lang: 'de' });
		expect(view.composition.panels).to.deep.equal([
			'messages',
			'plugins',
			{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
		]);
		expect(view.corePanels).to.have.keys(['messages', 'plugins']);
		expect(view.pluginPanels).to.have.keys(['plugin-IngestStates-0-presets']);
	});

	it('builds a synthetic single composition for a core panel target', async () => {
		const view = await catalog.getView({ mode: 'panel', targetId: 'tab-messages', lang: 'de' });
		expect(view.request).to.deep.equal({ mode: 'panel', targetId: 'tab-messages', lang: 'de' });
		expect(view.composition).to.deep.equal({
			id: 'comp-tab-messages',
			layout: 'single',
			panels: ['messages'],
			defaultPanel: 'messages',
			deviceMode: 'pc',
		});
		expect(view.corePanels).to.have.keys(['messages']);
		expect(view.pluginPanels).to.deep.equal({});
	});

	it('builds a synthetic single composition for a plugin panel target and resolves pluginPanels when available', async () => {
		const view = await catalog.getView({ mode: 'panel', targetId: 'tab-plugin-IngestStates-0-presets', lang: 'de' });
		expect(view.composition).to.deep.equal({
			id: 'comp-tab-plugin-IngestStates-0-presets',
			layout: 'single',
			panels: [{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' }],
			defaultPanel: 'plugin-IngestStates-0-presets',
			deviceMode: 'pc',
		});
		expect(view.corePanels).to.deep.equal({});
		expect(view.pluginPanels).to.have.keys(['plugin-IngestStates-0-presets']);
	});

	it('keeps explicit plugin refs when the panel is currently unavailable', async () => {
		const unavailableCatalog = new IoUiCatalog({
			pluginPanelResolver: {
				async getPanelsByRuntimeId() {
					return {};
				},
			},
		});
		const view = await unavailableCatalog.getView({
			mode: 'panel',
			targetId: 'tab-plugin-IngestStates-0-presets',
			lang: 'de',
		});
		expect(view.composition.panels).to.deep.equal([
			{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
		]);
		expect(view.pluginPanels).to.deep.equal({});
	});

	it('accepts formally valid but unknown core panel targets without existence checks', async () => {
		const view = await catalog.getView({ mode: 'panel', targetId: 'tab-unknown' });
		expect(view.composition).to.deep.equal({
			id: 'comp-tab-unknown',
			layout: 'single',
			panels: ['unknown'],
			defaultPanel: 'unknown',
			deviceMode: 'pc',
		});
		expect(view.corePanels).to.deep.equal({});
		expect(view.pluginPanels).to.deep.equal({});
	});

	it('rejects invalid requests with BAD_REQUEST', async () => {
		for (const request of [
			{},
			{ mode: 'composition', targetId: 'missing' },
			{ mode: 'panel' },
			{ mode: 'panel', targetId: 'bad-target' },
			{ mode: 'panel', targetId: 'tab-plugin-X-0' },
		]) {
			try {
				await catalog.getView(request);
				throw new Error('Expected BAD_REQUEST');
			} catch (error) {
				expect(error).to.have.property('code', 'BAD_REQUEST');
			}
		}
	});
});
