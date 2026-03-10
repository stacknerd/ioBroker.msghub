/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule, createElement, createH } = require('./_test.utils');

/**
 * Loads render.instance.js with state.js and render.form.js in the sandbox.
 *
 * @param {object} [extras] Additional sandbox globals.
 * @returns {Promise<object>} Sandbox with MsghubAdminTabPluginsInstance exposed.
 */
async function loadInstanceModule(extras = {}) {
	const stateSandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
	const formSandbox = await loadPanelModule('admin/tab/panels/plugins/render.form.js', {
		MsghubAdminTabPluginsState: stateSandbox.window.MsghubAdminTabPluginsState,
	});
	const merged = {
		MsghubAdminTabPluginsState: stateSandbox.window.MsghubAdminTabPluginsState,
		MsghubAdminTabPluginsForm: formSandbox.window.MsghubAdminTabPluginsForm,
		...extras,
	};
	return loadPanelModule('admin/tab/panels/plugins/render.instance.js', merged);
}

/**
 * Builds a minimal formApi stub based on the real render.form.js factory.
 *
 * @param {object} stateSandbox - Loaded state.js sandbox.
 * @param {object} formSandbox - Loaded render.form.js sandbox.
 * @returns {object} Form API instance.
 */
function makeFormApi(stateSandbox, formSandbox) {
	const state = stateSandbox.window.MsghubAdminTabPluginsState;
	const { createPluginsFormApi } = formSandbox.window.MsghubAdminTabPluginsForm;
	return createPluginsFormApi({
		h: createH(),
		pickText: v => (typeof v === 'string' ? v : String(v ?? '')),
		getConstants: () => null,
		pick: state.pick,
		normalizeUnit: state.normalizeUnit,
		isUnitless: state.isUnitless,
		pickDefaultTimeUnit: state.pickDefaultTimeUnit,
		getTimeFactor: state.getTimeFactor,
		TIME_UNITS: state.TIME_UNITS,
	});
}

/**
 * Returns a createPluginsInstanceApi instance with sensible test defaults.
 *
 * @param {object} sandbox - Loaded render.instance.js sandbox.
 * @param {object} [overrides] - Options to override defaults.
 * @returns {object} Frozen instance API.
 */
function makeInstanceApi(sandbox, overrides = {}) {
	const state = sandbox.MsghubAdminTabPluginsState || sandbox.window.MsghubAdminTabPluginsState;
	const formModule = sandbox.MsghubAdminTabPluginsForm || sandbox.window.MsghubAdminTabPluginsForm;
	const { createPluginsInstanceApi } = sandbox.window.MsghubAdminTabPluginsInstance;
	const formApi = formModule
		? formModule.createPluginsFormApi({
				h: createH(),
				pickText: v => (typeof v === 'string' ? v : String(v ?? '')),
				getConstants: () => null,
				pick: state.pick,
				normalizeUnit: state.normalizeUnit,
				isUnitless: state.isUnitless,
				pickDefaultTimeUnit: state.pickDefaultTimeUnit,
				getTimeFactor: state.getTimeFactor,
				TIME_UNITS: state.TIME_UNITS,
			})
		: null;

	return createPluginsInstanceApi({
		h: createH(),
		t: (k, ...args) => (args.length ? `${k}(${args.join(',')})` : k),
		cssSafe: state.cssSafe,
		pickText: v => (typeof v === 'string' ? v : String(v ?? '')),
		formApi,
		catalogApi: {
			toAccKey: ({ kind, type, instanceId }) =>
				Number.isFinite(instanceId)
					? `${kind}:msghub.0:${type}:${instanceId}`
					: `${kind}:msghub.0:${type}`,
			renderMarkdownLite: () => createElement('div'),
			openViewer: () => {},
		},
		openContextMenu: () => {},
		pluginsDataApi: null,
		ingestStatesDataApi: null,
		ui: null,
		toast: () => {},
		confirmDialog: async () => false,
		onRefreshAll: async () => {},
		adapterInstance: 0,
		...overrides,
	});
}

/** Minimal plugin descriptor for tests. */
const PLUGIN_NO_OPTIONS = Object.freeze({ type: 'IngestFoo', category: 'ingest' });

/** Plugin with one schema field. */
const PLUGIN_WITH_OPTIONS = Object.freeze({
	type: 'IngestFoo',
	category: 'ingest',
	options: { host: { type: 'string', order: 1, default: 'localhost', label: 'Host' } },
});

/** IngestStates plugin with tools availability. */
const PLUGIN_INGESTSTATES = Object.freeze({
	type: 'IngestStates',
	category: 'ingest',
});

/** Minimal instance descriptor. */
function makeInst(overrides = {}) {
	return Object.assign({ type: 'IngestFoo', instanceId: 0, enabled: true, native: {}, status: 'ok' }, overrides);
}

describe('admin/tab/panels/plugins/render.instance.js', function () {
	// --- module exposure ---

	it('exposes createPluginsInstanceApi factory', async function () {
		const sandbox = await loadInstanceModule();
		const mod = sandbox.window.MsghubAdminTabPluginsInstance;
		assert.equal(typeof mod.createPluginsInstanceApi, 'function');
	});

	it('createPluginsInstanceApi returns frozen object with renderInstanceRow', async function () {
		const sandbox = await loadInstanceModule();
		const api = makeInstanceApi(sandbox);
		assert.equal(typeof api.renderInstanceRow, 'function');
	});

	it('createPluginsInstanceApi handles null options gracefully', async function () {
		const sandbox = await loadInstanceModule();
		const { createPluginsInstanceApi } = sandbox.window.MsghubAdminTabPluginsInstance;
		const api = createPluginsInstanceApi(null);
		assert.equal(typeof api.renderInstanceRow, 'function');
	});

	// --- renderInstanceRow: basic structure ---

	it('renderInstanceRow returns a div with msghub-plugin-instance class', async function () {
		const sandbox = await loadInstanceModule();
		const { renderInstanceRow } = makeInstanceApi(sandbox);
		const el = renderInstanceRow({
			plugin: PLUGIN_NO_OPTIONS,
			inst: makeInst(),
			instList: [],
			expandedById: new Map(),
			readmesByType: new Map(),
		});
		assert.ok(el);
		assert.ok(el.classList.contains('msghub-plugin-instance'));
	});

	it('renderInstanceRow sets data-plugin-type attribute', async function () {
		const sandbox = await loadInstanceModule();
		const { renderInstanceRow } = makeInstanceApi(sandbox);
		const el = renderInstanceRow({
			plugin: PLUGIN_NO_OPTIONS,
			inst: makeInst(),
			instList: [],
			expandedById: new Map(),
			readmesByType: new Map(),
		});
		assert.equal(el.getAttribute('data-plugin-type'), 'IngestFoo');
	});

	it('renderInstanceRow sets data-instance-id attribute', async function () {
		const sandbox = await loadInstanceModule();
		const { renderInstanceRow } = makeInstanceApi(sandbox);
		const el = renderInstanceRow({
			plugin: PLUGIN_NO_OPTIONS,
			inst: makeInst({ instanceId: 3 }),
			instList: [],
			expandedById: new Map(),
			readmesByType: new Map(),
		});
		assert.equal(el.getAttribute('data-instance-id'), '3');
	});

	it('renderInstanceRow sets data-enabled="1" for enabled instance', async function () {
		const sandbox = await loadInstanceModule();
		const { renderInstanceRow } = makeInstanceApi(sandbox);
		const el = renderInstanceRow({
			plugin: PLUGIN_NO_OPTIONS,
			inst: makeInst({ enabled: true }),
			instList: [],
			expandedById: new Map(),
			readmesByType: new Map(),
		});
		assert.equal(el.getAttribute('data-enabled'), '1');
	});

	it('renderInstanceRow sets data-enabled="0" for disabled instance', async function () {
		const sandbox = await loadInstanceModule();
		const { renderInstanceRow } = makeInstanceApi(sandbox);
		const el = renderInstanceRow({
			plugin: PLUGIN_NO_OPTIONS,
			inst: makeInst({ enabled: false }),
			instList: [],
			expandedById: new Map(),
			readmesByType: new Map(),
		});
		assert.equal(el.getAttribute('data-enabled'), '0');
	});

	// --- accordion input ---

	it('renderInstanceRow adds accordion input when plugin has options', async function () {
		const sandbox = await loadInstanceModule();
		const { renderInstanceRow } = makeInstanceApi(sandbox);
		const el = renderInstanceRow({
			plugin: PLUGIN_WITH_OPTIONS,
			inst: makeInst(),
			instList: [],
			expandedById: new Map(),
			readmesByType: new Map(),
		});
		const accInput = el.children.find(c => c?.getAttribute?.('type') === 'checkbox');
		assert.ok(accInput, 'should have a checkbox accordion input');
	});

	it('renderInstanceRow omits accordion input when plugin has no options', async function () {
		const sandbox = await loadInstanceModule();
		const { renderInstanceRow } = makeInstanceApi(sandbox);
		const el = renderInstanceRow({
			plugin: PLUGIN_NO_OPTIONS,
			inst: makeInst(),
			instList: [],
			expandedById: new Map(),
			readmesByType: new Map(),
		});
		const accInput = el.children.find(c => c?.getAttribute?.('type') === 'checkbox');
		assert.equal(accInput, undefined);
	});

	// --- instance-head ---

	it('renderInstanceRow includes msghub-instance-head child', async function () {
		const sandbox = await loadInstanceModule();
		const { renderInstanceRow } = makeInstanceApi(sandbox);
		const el = renderInstanceRow({
			plugin: PLUGIN_NO_OPTIONS,
			inst: makeInst(),
			instList: [],
			expandedById: new Map(),
			readmesByType: new Map(),
		});
		const head = el.children.find(c => c?.classList?.contains('msghub-instance-head'));
		assert.ok(head, 'should have msghub-instance-head');
	});

	// --- options body ---

	it('renderInstanceRow includes instance-body when plugin has options', async function () {
		const sandbox = await loadInstanceModule();
		const { renderInstanceRow } = makeInstanceApi(sandbox);
		const el = renderInstanceRow({
			plugin: PLUGIN_WITH_OPTIONS,
			inst: makeInst(),
			instList: [],
			expandedById: new Map(),
			readmesByType: new Map(),
		});
		const body = el.children.find(c => c?.classList?.contains('msghub-instance-body'));
		assert.ok(body, 'should have msghub-instance-body');
	});

	it('renderInstanceRow omits instance-body when plugin has no options', async function () {
		const sandbox = await loadInstanceModule();
		const { renderInstanceRow } = makeInstanceApi(sandbox);
		const el = renderInstanceRow({
			plugin: PLUGIN_NO_OPTIONS,
			inst: makeInst(),
			instList: [],
			expandedById: new Map(),
			readmesByType: new Map(),
		});
		const body = el.children.find(c => c?.classList?.contains('msghub-instance-body'));
		assert.equal(body, undefined);
	});

	// --- tools availability ---

	it('renderInstanceRow does not show tools button as visible for non-IngestStates plugins', async function () {
		const sandbox = await loadInstanceModule();
		const { renderInstanceRow } = makeInstanceApi(sandbox);
		const el = renderInstanceRow({
			plugin: PLUGIN_NO_OPTIONS,
			inst: makeInst(),
			instList: [],
			expandedById: new Map(),
			readmesByType: new Map(),
		});
		const head = el.children.find(c => c?.classList?.contains('msghub-instance-head'));
		const toolsBtn = head?.children?.find(c => c?.classList?.contains('msghub-instance-tools'));
		assert.ok(toolsBtn?.classList?.contains('is-invisible'));
	});

	it('renderInstanceRow opens tools menu on right click for IngestStates', async function () {
		const sandbox = await loadInstanceModule();
		const openCalls = [];
		const { renderInstanceRow } = makeInstanceApi(sandbox, {
			ui: {
				contextMenu: {
					open: payload => openCalls.push(payload),
				},
			},
		});
		const el = renderInstanceRow({
			plugin: PLUGIN_INGESTSTATES,
			inst: makeInst({ type: 'IngestStates' }),
			instList: [makeInst({ type: 'IngestStates', instanceId: 0, enabled: true })],
			expandedById: new Map(),
			readmesByType: new Map(),
		});
		const head = el.children.find(c => c?.classList?.contains('msghub-instance-head'));
		const toolsBtn = head?.children?.find(c => c?.classList?.contains('msghub-instance-tools'));

		toolsBtn.dispatchEvent({ type: 'contextmenu', preventDefault() {}, clientX: 10, clientY: 20 });

		assert.equal(openCalls.length, 1);
		assert.equal(openCalls[0].anchorEl, toolsBtn);
		assert.equal(openCalls[0].placement, 'bottom-start');
		assert.equal(openCalls[0].items.map(item => item.id).join(','), 'ingeststates_bulk,ingeststates_presets');
	});
});
