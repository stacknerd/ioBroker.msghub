/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { createElement, createH, loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/plugins/index.js', function () {
	/**
	 * Loads index.js into a fresh VM sandbox.
	 *
	 * @returns {Promise<object>} Sandbox object after module execution.
	 */
	async function loadIndexModule() {
		return loadPanelModule('admin/tab/panels/plugins/index.js');
	}

	/**
	 * Returns a minimal plugins state object for use in stubs.
	 *
	 * @returns {object} Plain mutable state.
	 */
	function makePluginsState() {
		return {
			cachedConstants: null,
			cachedIngestStatesConstants: null,
			pluginReadmesLoadPromise: null,
			pluginReadmesByType: new Map(),
			ingestStatesSchemaPromise: null,
		};
	}

	/**
	 * Returns stub globals for all nine plugins submodules.
	 * Each factory ignores its options and returns a minimal stub API.
	 *
	 * @returns {object} Map of window global name → stub module object.
	 */
	function makeStubModules() {
		const pluginsState = makePluginsState();

		const pluginsDataApiStub = {
			ensureConstantsLoaded: async () => null,
			ensurePluginReadmesLoaded: async () => new Map(),
			getCatalog: async () => ({ plugins: [] }),
			listInstances: async () => ({ instances: [] }),
			createInstance: async () => ({}),
			updateInstance: async () => ({}),
			setEnabled: async () => undefined,
			deleteInstance: async () => undefined,
		};

		const ingestStatesDataApiStub = {
			getConstants: async () => null,
			getSchema: async () => null,
		};

		const menusApiStub = {
			getCategoryTitle: c => String(c || ''),
			openPluginsContextMenu: () => {},
		};

		const catalogApiStub = {
			captureAccordionState: () => new Map(),
			buildPluginsViewModel: () => ({ plugins: [], byType: new Map(), metaByType: new Map() }),
			renderCatalog: () => createElement('fragment'),
		};

		const instanceApiStub = {
			renderInstanceRow: () => createElement('div'),
		};

		return {
			MsghubAdminTabPluginsState: {
				cssSafe: s => String(s || ''),
				isTextEditableTarget: () => false,
				CATEGORY_ORDER: [],
				CATEGORY_I18N: {},
				createPluginsState: () => pluginsState,
				pick: (obj, path) =>
					String(path || '')
						.split('.')
						.reduce((cur, k) => (cur ? cur[k] : undefined), obj),
				normalizeUnit: u => u,
				isUnitless: () => false,
				pickDefaultTimeUnit: () => 's',
				getTimeFactor: () => 1000,
				TIME_UNITS: [],
			},
			MsghubAdminTabPluginsData: { createPluginsDataApi: () => pluginsDataApiStub },
			MsghubAdminTabPluginsIngestStatesData: { createIngestStatesDataApi: () => ingestStatesDataApiStub },
			MsghubAdminTabPluginsForm: { createPluginsFormApi: () => ({}) },
			MsghubAdminTabPluginsMenus: { createPluginsMenusApi: () => menusApiStub },
			MsghubAdminTabPluginsCatalog: { createPluginsCatalogApi: () => catalogApiStub },
			MsghubAdminTabPluginsInstance: { createPluginsInstanceApi: () => instanceApiStub },
			MsghubAdminTabPluginsBulkApply: {
				createPluginsBulkApplyApi: () => ({ renderIngestStatesBulkApply: () => createElement('div') }),
			},
			MsghubAdminTabPluginsPresets: {
				createPluginsPresetsApi: () => ({
					renderIngestStatesMessagePresetsTool: () => createElement('div'),
				}),
			},
		};
	}

	/**
	 * Returns a minimal ctx object for init(ctx) calls.
	 *
	 * @param {object} [overrides] Top-level fields to merge into the default ctx.
	 * @returns {object} ctx suitable for passing to MsghubAdminTabPlugins.init.
	 */
	function makeCtx(overrides = {}) {
		return {
			api: {
				i18n: { t: k => k, tOr: (k, fb) => fb, pickText: v => v },
				constants: null,
				plugins: null,
				ingestStates: null,
				ui: null,
			},
			h: createH(),
			elements: { pluginsRoot: createElement('div') },
			adapterInstance: 0,
			...overrides,
		};
	}

	// --- Module exposure ---

	it('exposes frozen MsghubAdminTabPlugins global with init function', async function () {
		const sandbox = await loadIndexModule();
		const global = sandbox.window.MsghubAdminTabPlugins;
		assert.equal(typeof global?.init, 'function');
		assert.equal(Object.isFrozen(global), true);
	});

	// --- init() guard checks ---

	it('init() throws when pluginsRoot element is missing', async function () {
		const sandbox = await loadIndexModule();
		assert.throws(
			() =>
				sandbox.window.MsghubAdminTabPlugins.init({
					api: { i18n: { t: k => k, tOr: (k, fb) => fb, pickText: v => v } },
					h: createH(),
					elements: {},
				}),
			/missing pluginsRoot element/,
		);
	});

	it('init() throws when a required submodule global is missing', async function () {
		const sandbox = await loadIndexModule();
		// No submodule globals set in the sandbox → first check fails.
		assert.throws(
			() => sandbox.window.MsghubAdminTabPlugins.init(makeCtx()),
			/missing MsghubAdminTabPluginsState/,
		);
	});

	it('init() throws on each missing submodule in dependency order', async function () {
		const sandbox = await loadIndexModule();
		const stubs = makeStubModules();

		// Register all but one module and verify the correct error is thrown.
		const keys = Object.keys(stubs);
		for (let i = 0; i < keys.length; i++) {
			const partial = Object.fromEntries(keys.slice(0, i).map(k => [k, stubs[k]]));
			Object.assign(sandbox.window, partial);
			assert.throws(
				() => sandbox.window.MsghubAdminTabPlugins.init(makeCtx()),
				new RegExp(`missing ${keys[i]}`),
				`Expected error for missing ${keys[i]}`,
			);
			// Reset for next iteration — remove the partial assignments.
			for (const k of keys.slice(0, i)) {
				delete sandbox.window[k];
			}
		}
	});

	// --- Architectural fix: contextmenu registration ---

	it('init() registers contextmenu listener on elRoot synchronously (not deferred)', async function () {
		const sandbox = await loadIndexModule();
		const stubs = makeStubModules();
		Object.assign(sandbox.window, stubs);

		const elRoot = createElement('div');
		let contextmenuRegistered = false;
		const origAddEventListener = elRoot.addEventListener.bind(elRoot);
		elRoot.addEventListener = (type, handler) => {
			if (type === 'contextmenu') {
				contextmenuRegistered = true;
			}
			origAddEventListener(type, handler);
		};

		sandbox.window.MsghubAdminTabPlugins.init(makeCtx({ elements: { pluginsRoot: elRoot } }));

		// Must be registered synchronously during init() — not deferred to the first readme load.
		assert.equal(contextmenuRegistered, true);
	});

	// --- Handle shape ---

	it('init() returns handle with onConnect and refreshPlugin functions', async function () {
		const sandbox = await loadIndexModule();
		const stubs = makeStubModules();
		Object.assign(sandbox.window, stubs);

		const panel = sandbox.window.MsghubAdminTabPlugins.init(makeCtx());
		assert.equal(typeof panel.onConnect, 'function');
		assert.equal(typeof panel.refreshPlugin, 'function');
	});

	// --- Spinner lifecycle ---

	it('onConnect() shows and hides a non-blocking spinner during refreshAll', async function () {
		const sandbox = await loadIndexModule();
		const spinnerCalls = [];
		const ui = {
			spinner: {
				show: opts => {
					spinnerCalls.push({ action: 'show', message: opts?.message });
					return 'sid-1';
				},
				hide: id => {
					spinnerCalls.push({ action: 'hide', id });
				},
			},
		};

		const stubs = makeStubModules();
		Object.assign(sandbox.window, stubs);

		const panel = sandbox.window.MsghubAdminTabPlugins.init(
			makeCtx({
				api: {
					i18n: { t: k => k, tOr: (k, fb) => fb, pickText: v => v },
					constants: null,
					plugins: null,
					ingestStates: null,
					ui,
				},
			}),
		);

		await panel.onConnect();

		const showCall = spinnerCalls.find(c => c.action === 'show');
		const hideCall = spinnerCalls.find(c => c.action === 'hide');
		assert.ok(showCall, 'spinner.show must be called');
		assert.ok(hideCall, 'spinner.hide must be called');
		assert.equal(hideCall.id, 'sid-1');
	});

	it('onConnect() hides spinner even when refreshAll throws', async function () {
		const sandbox = await loadIndexModule();
		const spinnerCalls = [];
		const ui = {
			spinner: {
				show: () => {
					spinnerCalls.push('show');
					return 'sid';
				},
				hide: () => {
					spinnerCalls.push('hide');
				},
			},
		};

		const baseStubs = makeStubModules();
		const stubs = {
			...baseStubs,
			MsghubAdminTabPluginsData: {
				createPluginsDataApi: () => ({
					ensureConstantsLoaded: async () => {
						throw new Error('network failure');
					},
					ensurePluginReadmesLoaded: async () => new Map(),
					getCatalog: async () => ({ plugins: [] }),
					listInstances: async () => ({ instances: [] }),
					createInstance: async () => ({}),
					updateInstance: async () => ({}),
					setEnabled: async () => undefined,
					deleteInstance: async () => undefined,
				}),
			},
		};
		Object.assign(sandbox.window, stubs);

		const panel = sandbox.window.MsghubAdminTabPlugins.init(
			makeCtx({
				api: {
					i18n: { t: k => k, tOr: (k, fb) => fb, pickText: v => v },
					constants: null,
					plugins: null,
					ingestStates: null,
					ui,
				},
			}),
		);

		await panel.onConnect();

		assert.ok(spinnerCalls.includes('show'), 'spinner.show must be called');
		assert.ok(spinnerCalls.includes('hide'), 'spinner.hide must be called even on error');
	});

	it('onConnect() collapses overlapping refreshes into a single in-flight refresh', async function () {
		const sandbox = await loadIndexModule();
		const spinnerCalls = [];
		let resolveConstants;
		let constantsCalls = 0;
		const ui = {
			spinner: {
				show: () => {
					spinnerCalls.push('show');
					return 'sid';
				},
				hide: () => {
					spinnerCalls.push('hide');
				},
			},
		};

		const baseStubs = makeStubModules();
		const stubs = {
			...baseStubs,
			MsghubAdminTabPluginsData: {
				createPluginsDataApi: () => ({
					ensureConstantsLoaded: async () => {
						constantsCalls += 1;
						await new Promise(resolve => {
							resolveConstants = resolve;
						});
					},
					ensurePluginReadmesLoaded: async () => new Map(),
					getCatalog: async () => ({ plugins: [] }),
					listInstances: async () => ({ instances: [] }),
					createInstance: async () => ({}),
					updateInstance: async () => ({}),
					setEnabled: async () => undefined,
					deleteInstance: async () => undefined,
				}),
			},
		};
		Object.assign(sandbox.window, stubs);

		const panel = sandbox.window.MsghubAdminTabPlugins.init(
			makeCtx({
				api: {
					i18n: { t: k => k, tOr: (k, fb) => fb, pickText: v => v },
					constants: null,
					plugins: null,
					ingestStates: null,
					ui,
				},
			}),
		);

		const p1 = panel.onConnect();
		const p2 = panel.onConnect();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(constantsCalls, 1, 'connect refresh must only start once while in flight');
		resolveConstants();
		await Promise.all([p1, p2]);

		assert.deepEqual(spinnerCalls, ['show', 'hide']);
	});

	it('onConnect() suppresses immediate follow-up connect refreshes after a successful refresh', async function () {
		const sandbox = await loadIndexModule();
		const spinnerCalls = [];
		let constantsCalls = 0;
		const ui = {
			spinner: {
				show: () => {
					spinnerCalls.push('show');
					return 'sid';
				},
				hide: () => {
					spinnerCalls.push('hide');
				},
			},
		};

		const baseStubs = makeStubModules();
		const stubs = {
			...baseStubs,
			MsghubAdminTabPluginsData: {
				createPluginsDataApi: () => ({
					ensureConstantsLoaded: async () => {
						constantsCalls += 1;
					},
					ensurePluginReadmesLoaded: async () => new Map(),
					getCatalog: async () => ({ plugins: [] }),
					listInstances: async () => ({ instances: [] }),
					createInstance: async () => ({}),
					updateInstance: async () => ({}),
					setEnabled: async () => undefined,
					deleteInstance: async () => undefined,
				}),
			},
		};
		Object.assign(sandbox.window, stubs);

		const panel = sandbox.window.MsghubAdminTabPlugins.init(
			makeCtx({
				api: {
					i18n: { t: k => k, tOr: (k, fb) => fb, pickText: v => v },
					constants: null,
					plugins: null,
					ingestStates: null,
					ui,
				},
			}),
		);

		await panel.onConnect();
		await panel.onConnect();

		assert.equal(constantsCalls, 1, 'immediate follow-up connect refresh must be suppressed');
		assert.deepEqual(spinnerCalls, ['show', 'hide']);
	});

	// --- refreshPlugin ---

	it('refreshPlugin() resolves without throwing', async function () {
		const sandbox = await loadIndexModule();
		const stubs = makeStubModules();
		Object.assign(sandbox.window, stubs);

		const panel = sandbox.window.MsghubAdminTabPlugins.init(makeCtx());
		await panel.refreshPlugin('IngestStates');
	});
});
