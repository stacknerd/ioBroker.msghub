'use strict';

const { expect } = require('chai');

const { DEFAULT_COMPOSITION_ID, IoUiCatalog } = require('./IoUiCatalog');

describe('IoUiCatalog', () => {
	let catalog;
	let pluginPanelResolver;
	let resolverCalls;
	let registry;

	function buildResolvedPluginPanel(overrides = {}) {
		return {
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
			app: {
				name: 'plugin.app.name',
				url: '?panel=tab-plugin-IngestStates-0-presets',
				icons: {
					any192: 'plugin-owned-192.png',
					any512: 'plugin-owned-512.png',
				},
			},
			...overrides,
		};
	}

	beforeEach(() => {
		registry = {
			panels: {
				alpha: {
					id: 'alpha',
					label: 'fixture.core.alpha.label',
					category: 'dashboard',
					app: {
						name: 'fixture.core.alpha.app.name',
						shortName: 'fixture.core.alpha.app.shortName',
						url: '?panel=tab-alpha',
						display: 'standalone',
						themeColor: '#112233',
						backgroundColor: '#ffffff',
						icons: {
							any192: 'alpha-192.png',
							any512: 'alpha-512.png',
							maskable192: 'alpha-maskable-192.png',
							maskable512: 'alpha-maskable-512.png',
							apple180: 'alpha-apple-180.png',
						},
					},
				},
				beta: {
					id: 'beta',
					label: 'fixture.core.beta.label',
					category: 'admin',
				},
			},
			compositions: {
				adminTab: {
					id: 'adminTab',
					layout: 'tabs',
					panels: [
						{ type: 'corePanel', panelId: 'alpha' },
						{ type: 'corePanel', panelId: 'beta' },
						{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
					],
					defaultPanel: 'alpha',
					deviceMode: 'pc',
				},
				web: {
					id: 'web',
					layout: 'tabs',
					panels: [
						{ type: 'corePanel', panelId: 'alpha' },
						{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
					],
					defaultPanel: 'alpha',
					deviceMode: 'pc',
				},
				full: {
					id: 'full',
					layout: 'tabs',
					panels: ['*'],
					defaultPanel: 'alpha',
					deviceMode: 'pc',
				},
			},
		};
		resolverCalls = {
			byRuntimeId: [],
			byRef: [],
		};
		pluginPanelResolver = {
			async getPanelsByRuntimeId(options) {
				resolverCalls.byRuntimeId.push(options);
				return {
					'plugin-IngestStates-0-presets': buildResolvedPluginPanel(),
				};
			},
			async getPanelByRef(options) {
				resolverCalls.byRef.push(options);
				if (
					options?.pluginType === 'IngestStates' &&
					options?.instanceId === 0 &&
					options?.panelId === 'presets'
				) {
					return buildResolvedPluginPanel();
				}
				return null;
			},
		};
		catalog = new IoUiCatalog({ registry, pluginPanelResolver });
	});

	it('returns the default composition when composition mode omits targetId', async () => {
		const view = await catalog.getView({ mode: 'composition' });
		expect(DEFAULT_COMPOSITION_ID).to.equal('adminTab');
		expect(view.request).to.deep.equal({ mode: 'composition', targetId: 'adminTab' });
		expect(view.composition.id).to.equal('adminTab');
		expect(view.corePanels).to.have.keys(['alpha', 'beta']);
		expect(view.pluginPanels).to.have.keys(['plugin-IngestStates-0-presets']);
		expect(view.corePanels.alpha.resolvedAppIcons).to.deep.equal({
			any192: 'admin/icons/alpha/alpha-192.png',
			any512: 'admin/icons/alpha/alpha-512.png',
			maskable192: 'admin/icons/alpha/alpha-maskable-192.png',
			maskable512: 'admin/icons/alpha/alpha-maskable-512.png',
			apple180: 'admin/icons/alpha/alpha-apple-180.png',
		});
		expect(view.corePanels.beta.resolvedAppIcons).to.deep.equal({});
		expect(view.pluginPanels['plugin-IngestStates-0-presets'].resolvedAppIcons).to.deep.equal({
			any192: 'admin/icons/pluginUI/pluginUI-192.png',
			any512: 'admin/icons/pluginUI/pluginUI-512.png',
			maskable192: 'admin/icons/pluginUI/pluginUI-maskable-192.png',
			maskable512: 'admin/icons/pluginUI/pluginUI-maskable-512.png',
			apple180: 'admin/icons/pluginUI/pluginUI-apple-180.png',
		});
		expect(resolverCalls.byRuntimeId).to.deep.equal([undefined]);
	});

	it('returns the requested composition for the language-free plugin panel view path', async () => {
		const view = await catalog.getView({ mode: 'composition', targetId: 'web' });
		expect(view.request).to.deep.equal({ mode: 'composition', targetId: 'web' });
		expect(view.composition.id).to.equal('web');
		expect(view.composition.panels).to.deep.equal([
			{ type: 'corePanel', panelId: 'alpha' },
			{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
		]);
		expect(view.corePanels).to.have.keys(['alpha']);
		expect(view.pluginPanels).to.deep.equal({
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
					resolvedAppIcons: {
						any192: 'admin/icons/pluginUI/pluginUI-192.png',
						any512: 'admin/icons/pluginUI/pluginUI-512.png',
					maskable192: 'admin/icons/pluginUI/pluginUI-maskable-192.png',
					maskable512: 'admin/icons/pluginUI/pluginUI-maskable-512.png',
					apple180: 'admin/icons/pluginUI/pluginUI-apple-180.png',
				},
			},
		});
	});

	it('materializes wildcard compositions backend-side', async () => {
		const view = await catalog.getView({ mode: 'composition', targetId: 'full' });
		expect(view.composition.panels).to.deep.equal([
			{ type: 'corePanel', panelId: 'alpha' },
			{ type: 'corePanel', panelId: 'beta' },
			{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
		]);
		expect(view.corePanels).to.have.keys(['alpha', 'beta']);
		expect(view.pluginPanels).to.have.keys(['plugin-IngestStates-0-presets']);
	});

	it('builds a synthetic single composition for a core panel target', async () => {
		const view = await catalog.getView({ mode: 'panel', targetId: 'tab-alpha' });
		expect(view.request).to.deep.equal({ mode: 'panel', targetId: 'tab-alpha' });
		expect(view.composition).to.deep.equal({
			id: 'comp-tab-alpha',
			layout: 'single',
			panels: [{ type: 'corePanel', panelId: 'alpha' }],
			defaultPanel: 'alpha',
			deviceMode: 'pc',
		});
		expect(view.corePanels).to.have.keys(['alpha']);
		expect(view.pluginPanels).to.deep.equal({});
	});

	it('builds a synthetic single composition for a plugin panel target and resolves pluginPanels when available', async () => {
		const view = await catalog.getView({ mode: 'panel', targetId: 'tab-plugin-IngestStates-0-presets' });
		expect(view.composition).to.deep.equal({
			id: 'comp-tab-plugin-IngestStates-0-presets',
			layout: 'single',
			panels: [{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' }],
			defaultPanel: 'plugin-IngestStates-0-presets',
			deviceMode: 'pc',
		});
		expect(view.corePanels).to.deep.equal({});
		expect(view.pluginPanels).to.have.keys(['plugin-IngestStates-0-presets']);
		expect(view.pluginPanels['plugin-IngestStates-0-presets'].app).to.deep.equal({
			name: 'plugin.app.name',
			url: '?panel=tab-plugin-IngestStates-0-presets',
		});
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
			panels: [{ type: 'corePanel', panelId: 'unknown' }],
			defaultPanel: 'unknown',
			deviceMode: 'pc',
		});
		expect(view.corePanels).to.deep.equal({});
		expect(view.pluginPanels).to.deep.equal({});
	});

	it('getApp returns the canonical core panel entry with resolved app icons', async () => {
		const app = await catalog.getApp({ mode: 'panel', targetId: 'tab-alpha' });
		expect(app).to.deep.equal({
			id: 'alpha',
			label: 'fixture.core.alpha.label',
			category: 'dashboard',
			app: {
				name: 'fixture.core.alpha.app.name',
				shortName: 'fixture.core.alpha.app.shortName',
				url: '?panel=tab-alpha',
				display: 'standalone',
				themeColor: '#112233',
				backgroundColor: '#ffffff',
				icons: {
					any192: 'alpha-192.png',
					any512: 'alpha-512.png',
					maskable192: 'alpha-maskable-192.png',
					maskable512: 'alpha-maskable-512.png',
					apple180: 'alpha-apple-180.png',
				},
			},
			resolvedAppIcons: {
				any192: 'admin/icons/alpha/alpha-192.png',
				any512: 'admin/icons/alpha/alpha-512.png',
				maskable192: 'admin/icons/alpha/alpha-maskable-192.png',
				maskable512: 'admin/icons/alpha/alpha-maskable-512.png',
				apple180: 'admin/icons/alpha/alpha-apple-180.png',
			},
		});
	});

	it('getApp returns null for core panels without an app block or unknown core panels', async () => {
		expect(await catalog.getApp({ mode: 'panel', targetId: 'tab-beta' })).to.equal(null);
		expect(await catalog.getApp({ mode: 'panel', targetId: 'tab-unknown' })).to.equal(null);
	});

	it('getApp returns the resolved plugin panel entry with the fixed host icon set', async () => {
		const app = await catalog.getApp({ mode: 'panel', targetId: 'tab-plugin-IngestStates-0-presets' });
		expect(app).to.deep.equal({
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
			app: {
				name: 'plugin.app.name',
				url: '?panel=tab-plugin-IngestStates-0-presets',
			},
			resolvedAppIcons: {
				any192: 'admin/icons/pluginUI/pluginUI-192.png',
				any512: 'admin/icons/pluginUI/pluginUI-512.png',
				maskable192: 'admin/icons/pluginUI/pluginUI-maskable-192.png',
				maskable512: 'admin/icons/pluginUI/pluginUI-maskable-512.png',
				apple180: 'admin/icons/pluginUI/pluginUI-apple-180.png',
			},
		});
		expect(resolverCalls.byRef).to.deep.equal([
			{ pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
		]);
	});

	it('strips plugin-owned app.icons from getView and getApp payloads', async () => {
		const compositionView = await catalog.getView({ mode: 'composition', targetId: 'web' });
		const app = await catalog.getApp({ mode: 'panel', targetId: 'tab-plugin-IngestStates-0-presets' });

		expect(compositionView.pluginPanels['plugin-IngestStates-0-presets'].app).to.deep.equal({
			name: 'plugin.app.name',
			url: '?panel=tab-plugin-IngestStates-0-presets',
		});
		expect(app.app).to.deep.equal({
			name: 'plugin.app.name',
			url: '?panel=tab-plugin-IngestStates-0-presets',
		});
		expect(compositionView.pluginPanels['plugin-IngestStates-0-presets'].app).to.not.have.property('icons');
		expect(app.app).to.not.have.property('icons');
	});

	it('getApp returns null when the plugin panel is not runtime-resolvable or has no valid app block', async () => {
		const unavailableCatalog = new IoUiCatalog({
			pluginPanelResolver: {
				async getPanelByRef() {
					return null;
				},
			},
		});
		const missingAppCatalog = new IoUiCatalog({
			pluginPanelResolver: {
				async getPanelByRef() {
					return buildResolvedPluginPanel({ app: undefined });
				},
			},
		});

		expect(await unavailableCatalog.getApp({ mode: 'panel', targetId: 'tab-plugin-IngestStates-0-presets' })).to.equal(
			null,
		);
		expect(await missingAppCatalog.getApp({ mode: 'panel', targetId: 'tab-plugin-IngestStates-0-presets' })).to.equal(
			null,
		);
	});

	it('getApp tolerates NOT_READY from the plugin runtime and returns null', async () => {
		const unavailableCatalog = new IoUiCatalog({
			pluginPanelResolver: {
				async getPanelByRef() {
					throw Object.assign(new Error('Plugin runtime not ready'), { code: 'NOT_READY' });
				},
			},
		});
		expect(await unavailableCatalog.getApp({ mode: 'panel', targetId: 'tab-plugin-IngestStates-0-presets' })).to.equal(
			null,
		);
	});

	it('getApp keeps core icon normalization partial when only some slots exist', async () => {
		const boundaryCatalog = new IoUiCatalog({
			registry: {
				panels: {
					boundary: {
						id: 'boundary',
						label: 'boundary.label',
						app: {
							name: 'boundary.app.name',
							url: '?panel=tab-boundary',
							icons: {
								any192: 'boundary-192.png',
							},
						},
					},
				},
				compositions: {
					adminTab: {
						id: 'adminTab',
						layout: 'single',
						panels: [{ type: 'corePanel', panelId: 'boundary' }],
						defaultPanel: 'boundary',
						deviceMode: 'pc',
					},
				},
			},
		});

		expect(await boundaryCatalog.getApp({ mode: 'panel', targetId: 'tab-boundary' })).to.deep.equal({
			id: 'boundary',
			label: 'boundary.label',
			app: {
				name: 'boundary.app.name',
				url: '?panel=tab-boundary',
				icons: {
					any192: 'boundary-192.png',
				},
			},
			resolvedAppIcons: {
				any192: 'admin/icons/boundary/boundary-192.png',
			},
		});
	});

	it('getApp rethrows unexpected plugin resolver errors', async () => {
		const failingCatalog = new IoUiCatalog({
			pluginPanelResolver: {
				async getPanelByRef() {
					throw new Error('boom');
				},
			},
		});
		try {
			await failingCatalog.getApp({ mode: 'panel', targetId: 'tab-plugin-IngestStates-0-presets' });
			throw new Error('Expected resolver failure');
		} catch (error) {
			expect(error.message).to.equal('boom');
		}
	});

	it('rejects invalid getView and getApp requests with BAD_REQUEST', async () => {
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

		for (const request of [
			{},
			{ mode: 'composition' },
			{ mode: 'panel' },
			{ mode: 'panel', targetId: 'bad-target' },
			{ mode: 'panel', targetId: 'tab-plugin-X-0' },
		]) {
			try {
				await catalog.getApp(request);
				throw new Error('Expected BAD_REQUEST');
			} catch (error) {
				expect(error).to.have.property('code', 'BAD_REQUEST');
			}
		}
	});
});
