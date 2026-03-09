/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule } = require('./_test.utils');

/**
 * Loads data.plugins.js with state.js already present in the sandbox.
 *
 * @param {object} [extras] Additional sandbox globals (e.g. mock fetch).
 * @returns {Promise<object>} Sandbox with MsghubAdminTabPluginsData exposed.
 */
async function loadDataPluginsModule(extras = {}) {
	// state.js must be loaded first so the sandbox has MsghubAdminTabPluginsState.
	const stateSandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
	const merged = {
		MsghubAdminTabPluginsState: stateSandbox.window.MsghubAdminTabPluginsState,
		...extras,
	};
	return loadPanelModule('admin/tab/panels/plugins/data.plugins.js', merged);
}

/**
 * Returns a fresh state object via the canonical factory.
 *
 * @param {object} sandbox - Loaded state sandbox.
 * @returns {object} New plugins state.
 */
function makeState(sandbox) {
	// MsghubAdminTabPluginsState was injected as a top-level extra into the VM
	// sandbox context, not into sandbox.window (windowObject). Access it directly.
	const pluginsState = sandbox.MsghubAdminTabPluginsState || sandbox.window.MsghubAdminTabPluginsState;
	return pluginsState.createPluginsState();
}

describe('admin/tab/panels/plugins/data.plugins.js', function () {
	it('exposes createPluginsDataApi factory', async function () {
		const sandbox = await loadDataPluginsModule();
		const api = sandbox.window.MsghubAdminTabPluginsData;
		assert.equal(typeof api.createPluginsDataApi, 'function');
	});

	it('createPluginsDataApi returns frozen object with all expected methods', async function () {
		const sandbox = await loadDataPluginsModule();
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi: null });

		assert.equal(typeof data.ensureConstantsLoaded, 'function');
		assert.equal(typeof data.ensurePluginReadmesLoaded, 'function');
		assert.equal(typeof data.getCatalog, 'function');
		assert.equal(typeof data.listInstances, 'function');
		assert.equal(typeof data.createInstance, 'function');
		assert.equal(typeof data.updateInstance, 'function');
		assert.equal(typeof data.setEnabled, 'function');
		assert.equal(typeof data.deleteInstance, 'function');
	});

	// --- ensureConstantsLoaded ---

	it('ensureConstantsLoaded() returns constants from API on first call', async function () {
		const sandbox = await loadDataPluginsModule();
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const constants = { level: { info: 1 } };
		const constantsApi = { get: async () => constants };
		const data = createPluginsDataApi({ state, constantsApi, pluginsApi: null });

		const result = await data.ensureConstantsLoaded();
		assert.equal(result, constants);
		assert.equal(state.cachedConstants, constants);
	});

	it('ensureConstantsLoaded() returns cached value on second call without re-fetching', async function () {
		const sandbox = await loadDataPluginsModule();
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		let callCount = 0;
		const constants = { level: { info: 1 } };
		const constantsApi = {
			get: async () => {
				callCount += 1;
				return constants;
			},
		};
		const data = createPluginsDataApi({ state, constantsApi, pluginsApi: null });

		await data.ensureConstantsLoaded();
		await data.ensureConstantsLoaded();
		assert.equal(callCount, 1);
	});

	it('ensureConstantsLoaded() returns null and caches null when API throws', async function () {
		const sandbox = await loadDataPluginsModule();
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const constantsApi = {
			get: async () => {
				throw new Error('network error');
			},
		};
		const data = createPluginsDataApi({ state, constantsApi, pluginsApi: null });

		const result = await data.ensureConstantsLoaded();
		assert.equal(result, null);
		assert.equal(state.cachedConstants, null);
	});

	it('ensureConstantsLoaded() returns null when constantsApi is unavailable', async function () {
		const sandbox = await loadDataPluginsModule();
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi: null });

		const result = await data.ensureConstantsLoaded();
		assert.equal(result, null);
	});

	// --- ensurePluginReadmesLoaded ---

	it('ensurePluginReadmesLoaded() returns empty map when fetch fails', async function () {
		const sandbox = await loadDataPluginsModule({
			fetch: async () => {
				throw new Error('network error');
			},
		});
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi: null });

		const result = await data.ensurePluginReadmesLoaded();
		assert.equal(typeof result.get, 'function');
		assert.equal(result.size, 0);
	});

	it('ensurePluginReadmesLoaded() returns empty map when fetch returns !ok', async function () {
		const sandbox = await loadDataPluginsModule({
			fetch: async () => ({ ok: false }),
		});
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi: null });

		const result = await data.ensurePluginReadmesLoaded();
		assert.equal(result.size, 0);
	});

	it('ensurePluginReadmesLoaded() parses valid readme data and caches by type', async function () {
		const readmeData = {
			IngestFoo: { md: '# Foo\nHello', source: 'https://example.com' },
			IngestBar: { md: '# Bar', source: '' },
			'  ': { md: 'ignored', source: '' }, // blank key — ignored
			BadEntry: null, // null — ignored
		};
		const sandbox = await loadDataPluginsModule({
			fetch: async () => ({
				ok: true,
				json: async () => readmeData,
			}),
		});
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi: null });

		const result = await data.ensurePluginReadmesLoaded();
		assert.equal(result.size, 2);
		assert.equal(result.get('IngestFoo').md, '# Foo\nHello');
		assert.equal(result.get('IngestBar').md, '# Bar');
	});

	it('ensurePluginReadmesLoaded() ignores entries with empty md', async function () {
		const readmeData = { IngestFoo: { md: '   ', source: '' } };
		const sandbox = await loadDataPluginsModule({
			fetch: async () => ({ ok: true, json: async () => readmeData }),
		});
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi: null });

		const result = await data.ensurePluginReadmesLoaded();
		assert.equal(result.size, 0);
	});

	it('ensurePluginReadmesLoaded() resolves to same promise on concurrent calls', async function () {
		let fetchCount = 0;
		const sandbox = await loadDataPluginsModule({
			fetch: async () => {
				fetchCount += 1;
				return { ok: true, json: async () => ({}) };
			},
		});
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi: null });

		const [r1, r2] = await Promise.all([
			data.ensurePluginReadmesLoaded(),
			data.ensurePluginReadmesLoaded(),
		]);
		// Both resolve to the same map (single-flight)
		assert.equal(r1, r2);
		assert.equal(fetchCount, 1);
	});

	// --- CRUD wrappers ---

	it('getCatalog() delegates to pluginsApi.getCatalog', async function () {
		const sandbox = await loadDataPluginsModule();
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const catalog = { plugins: [] };
		const pluginsApi = { getCatalog: async () => catalog };
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi });

		const result = await data.getCatalog();
		assert.equal(result, catalog);
	});

	it('getCatalog() throws when pluginsApi is unavailable', async function () {
		const sandbox = await loadDataPluginsModule();
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi: null });

		await assert.rejects(() => data.getCatalog(), /Plugins API/);
	});

	it('listInstances() delegates to pluginsApi.listInstances', async function () {
		const sandbox = await loadDataPluginsModule();
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const instances = { instances: [{ type: 'IngestFoo', instanceId: 0 }] };
		const pluginsApi = { listInstances: async () => instances };
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi });

		const result = await data.listInstances();
		assert.equal(result, instances);
	});

	it('createInstance() passes params to pluginsApi.createInstance', async function () {
		const sandbox = await loadDataPluginsModule();
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		let receivedParams;
		const pluginsApi = {
			createInstance: async params => {
				receivedParams = params;
				return { instanceId: 0 };
			},
		};
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi });

		await data.createInstance({ type: 'IngestFoo', category: 'ingest' });
		assert.equal(receivedParams.type, 'IngestFoo');
	});

	it('updateInstance() throws when pluginsApi is unavailable', async function () {
		const sandbox = await loadDataPluginsModule();
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi: null });

		await assert.rejects(() => data.updateInstance({}), /Plugins API/);
	});

	it('setEnabled() passes params to pluginsApi.setEnabled', async function () {
		const sandbox = await loadDataPluginsModule();
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		let receivedParams;
		const pluginsApi = {
			setEnabled: async params => {
				receivedParams = params;
			},
		};
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi });

		await data.setEnabled({ type: 'IngestFoo', instanceId: 0, enabled: true });
		assert.equal(receivedParams.type, 'IngestFoo');
		assert.equal(receivedParams.enabled, true);
	});

	it('deleteInstance() throws when pluginsApi is unavailable', async function () {
		const sandbox = await loadDataPluginsModule();
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;
		const state = makeState(sandbox);
		const data = createPluginsDataApi({ state, constantsApi: null, pluginsApi: null });

		await assert.rejects(() => data.deleteInstance({}), /Plugins API/);
	});

	it('createPluginsDataApi handles missing options gracefully', async function () {
		const sandbox = await loadDataPluginsModule({
			fetch: async () => ({ ok: false }),
		});
		const { createPluginsDataApi } = sandbox.window.MsghubAdminTabPluginsData;

		// Should not throw — opts defaults to {}
		const data = createPluginsDataApi(null);
		assert.equal(typeof data.ensureConstantsLoaded, 'function');
	});
});
