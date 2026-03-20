/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule } = require('./_test.utils');

/**
 * Loads data.ingeststates.js with state.js already present in the sandbox.
 *
 * @param {object} [extras] Additional sandbox globals.
 * @returns {Promise<object>} Sandbox with MsghubAdminTabPluginsIngestStatesData exposed.
 */
async function loadDataIngestStatesModule(extras = {}) {
	const stateSandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
	const merged = {
		MsghubAdminTabPluginsState: stateSandbox.window.MsghubAdminTabPluginsState,
		...extras,
	};
	return loadPanelModule('admin/tab/panels/plugins/data.ingeststates.js', merged);
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

describe('admin/tab/panels/plugins/data.ingeststates.js', function () {
	it('exposes createIngestStatesDataApi factory', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const api = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		assert.equal(typeof api.createIngestStatesDataApi, 'function');
	});

	it('createIngestStatesDataApi returns frozen object with all expected methods', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const data = createIngestStatesDataApi({ state, ingestStatesApi: null });

		assert.equal(typeof data.ensureIngestStatesConstantsLoaded, 'function');
		assert.equal(typeof data.ensureIngestStatesSchema, 'function');
		assert.equal(typeof data.listPresets, 'function');
		assert.equal(typeof data.getPreset, 'function');
		assert.equal(typeof data.deletePreset, 'function');
		assert.equal(typeof data.createPreset, 'function');
		assert.equal(typeof data.updatePreset, 'function');
		assert.equal(typeof data.bulkApplyPreview, 'function');
		assert.equal(typeof data.bulkApplyApply, 'function');
		assert.equal(typeof data.customRead, 'function');
	});

	// --- ensureIngestStatesConstantsLoaded ---

	it('ensureIngestStatesConstantsLoaded() fetches and caches constants', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const constants = { ruleTemplateCatalog: [] };
		const ingestStatesApi = { constants: { get: async () => constants } };
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		const result = await data.ensureIngestStatesConstantsLoaded();
		assert.equal(result, constants);
		assert.equal(state.cachedIngestStatesConstants, constants);
	});

	it('ensureIngestStatesConstantsLoaded() uses cache on second call', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		let callCount = 0;
		const ingestStatesApi = {
			constants: {
				get: async () => {
					callCount += 1;
					return {};
				},
			},
		};
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		await data.ensureIngestStatesConstantsLoaded();
		await data.ensureIngestStatesConstantsLoaded();
		assert.equal(callCount, 1);
	});

	it('ensureIngestStatesConstantsLoaded() returns null and caches null on error', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const ingestStatesApi = {
			constants: {
				get: async () => {
					throw new Error('fail');
				},
			},
		};
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		const result = await data.ensureIngestStatesConstantsLoaded();
		assert.equal(result, null);
		assert.equal(state.cachedIngestStatesConstants, null);
	});

	it('ensureIngestStatesConstantsLoaded() returns null when API is unavailable', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const data = createIngestStatesDataApi({ state, ingestStatesApi: null });

		const result = await data.ensureIngestStatesConstantsLoaded();
		assert.equal(result, null);
	});

	// --- ensureIngestStatesSchema ---

	it('ensureIngestStatesSchema() fetches and caches schema', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const schema = { type: 'object', properties: {} };
		const ingestStatesApi = { schema: { get: async () => schema } };
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		const result = await data.ensureIngestStatesSchema();
		assert.equal(result, schema);
	});

	it('ensureIngestStatesSchema() uses single-flight caching', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		let callCount = 0;
		const ingestStatesApi = {
			schema: {
				get: async () => {
					callCount += 1;
					return { type: 'object' };
				},
			},
		};
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		const [r1, r2] = await Promise.all([
			data.ensureIngestStatesSchema(),
			data.ensureIngestStatesSchema(),
		]);
		assert.equal(r1, r2);
		assert.equal(callCount, 1);
	});

	it('ensureIngestStatesSchema() throws when API is unavailable', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const data = createIngestStatesDataApi({ state, ingestStatesApi: null });

		await assert.rejects(() => data.ensureIngestStatesSchema(), /IngestStates schema API/);
	});

	it('ensureIngestStatesSchema() throws when schema response is not an object', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const ingestStatesApi = { schema: { get: async () => null } };
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		await assert.rejects(() => data.ensureIngestStatesSchema(), /Invalid schema response/);
	});

	it('ensureIngestStatesSchema() throws when schema response is a string', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const ingestStatesApi = { schema: { get: async () => 'not-an-object' } };
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		await assert.rejects(() => data.ensureIngestStatesSchema(), /Invalid schema response/);
	});

	// --- presets wrappers ---

	it('listPresets() delegates to ingestStatesApi.presets.list', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const presets = [{ id: 'p1' }];
		let received;
		const ingestStatesApi = {
			presets: {
				list: async params => {
					received = params;
					return presets;
				},
			},
		};
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		const result = await data.listPresets({ includeUsage: true });
		assert.equal(result, presets);
		assert.deepEqual(received, { includeUsage: true });
	});

	it('listPresets() throws when presets API is unavailable', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const data = createIngestStatesDataApi({ state, ingestStatesApi: null });

		await assert.rejects(() => data.listPresets(), /IngestStates presets API/);
	});

	it('getPreset() passes presetId to ingestStatesApi.presets.get', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		let received;
		const ingestStatesApi = {
			presets: {
				get: async params => {
					received = params;
					return { id: params.presetId };
				},
			},
		};
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		await data.getPreset({ presetId: 'p1' });
		assert.equal(received.presetId, 'p1');
	});

	it('deletePreset() throws when presets API is unavailable', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const data = createIngestStatesDataApi({ state, ingestStatesApi: null });

		await assert.rejects(() => data.deletePreset({ presetId: 'p1' }), /IngestStates presets API/);
	});

	it('createPreset() passes preset to ingestStatesApi.presets.create', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const preset = { id: 'p1', name: 'My Preset' };
		let received;
		const ingestStatesApi = {
			presets: {
				create: async params => {
					received = params;
					return preset;
				},
			},
		};
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		await data.createPreset({ preset });
		assert.equal(received.preset, preset);
	});

	it('updatePreset() passes presetId and preset to ingestStatesApi.presets.update', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const preset = { name: 'Updated Preset' };
		let received;
		const ingestStatesApi = {
			presets: {
				update: async params => {
					received = params;
					return { ok: true };
				},
			},
		};
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		await data.updatePreset({ presetId: 'p1', preset });
		assert.equal(received.presetId, 'p1');
		assert.equal(received.preset, preset);
	});

	// --- bulkApply wrappers ---

	it('bulkApplyPreview() delegates to ingestStatesApi.bulkApply.preview', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const preview = { changes: [] };
		const ingestStatesApi = { bulkApply: { preview: async () => preview } };
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		const result = await data.bulkApplyPreview({});
		assert.equal(result, preview);
	});

	it('bulkApplyPreview() throws when bulkApply API is unavailable', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const data = createIngestStatesDataApi({ state, ingestStatesApi: null });

		await assert.rejects(() => data.bulkApplyPreview({}), /IngestStates bulkApply API/);
	});

	it('bulkApplyApply() delegates to ingestStatesApi.bulkApply.apply', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const response = { applied: 3 };
		const ingestStatesApi = { bulkApply: { apply: async () => response } };
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		const result = await data.bulkApplyApply({});
		assert.equal(result, response);
	});

	it('bulkApplyApply() throws when bulkApply API is unavailable', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const data = createIngestStatesDataApi({ state, ingestStatesApi: null });

		await assert.rejects(() => data.bulkApplyApply({}), /IngestStates bulkApply API/);
	});

	// --- customRead ---

	it('customRead() delegates to ingestStatesApi.custom.read', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const customConfig = { thresholds: {} };
		let received;
		const ingestStatesApi = {
			custom: {
				read: async params => {
					received = params;
					return customConfig;
				},
			},
		};
		const data = createIngestStatesDataApi({ state, ingestStatesApi });

		const result = await data.customRead({ id: 'IngestFoo:0' });
		assert.equal(result, customConfig);
		assert.equal(received.id, 'IngestFoo:0');
	});

	it('customRead() throws when custom API is unavailable', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;
		const state = makeState(sandbox);
		const data = createIngestStatesDataApi({ state, ingestStatesApi: null });

		await assert.rejects(() => data.customRead({ id: 'x' }), /IngestStates custom API/);
	});

	// --- null-safe factory init ---

	it('createIngestStatesDataApi handles null options gracefully', async function () {
		const sandbox = await loadDataIngestStatesModule();
		const { createIngestStatesDataApi } = sandbox.window.MsghubAdminTabPluginsIngestStatesData;

		const data = createIngestStatesDataApi(null);
		assert.equal(typeof data.ensureIngestStatesConstantsLoaded, 'function');
	});
});
