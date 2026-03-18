/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule, createElement, createH } = require('./_test.utils');

/**
 * Loads render.catalog.js with state.js already present in the sandbox.
 *
 * @param {object} [extras] Additional sandbox globals.
 * @returns {Promise<object>} Sandbox with MsghubAdminTabPluginsCatalog exposed.
 */
async function loadCatalogModule(extras = {}) {
	const stateSandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
	const merged = {
		MsghubAdminTabPluginsState: stateSandbox.window.MsghubAdminTabPluginsState,
		...extras,
	};
	return loadPanelModule('admin/tab/panels/plugins/render.catalog.js', merged);
}

/**
 * Returns a createPluginsCatalogApi instance with sensible test defaults.
 *
 * @param {object} sandbox - Loaded render.catalog.js sandbox.
 * @param {object} [overrides] - Options to override defaults.
 * @returns {object} Frozen catalog API.
 */
function makeCatalogApi(sandbox, overrides = {}) {
	const state = sandbox.MsghubAdminTabPluginsState || sandbox.window.MsghubAdminTabPluginsState;
	const { createPluginsCatalogApi } = sandbox.window.MsghubAdminTabPluginsCatalog;
	const elRoot = createElement('div');
	return createPluginsCatalogApi({
		h: createH(),
		t: (k, ...args) => (args.length ? `${k}(${args.join(',')})` : k),
		tOr: (k, fb) => fb || k,
		cssSafe: state.cssSafe,
		CATEGORY_ORDER: state.CATEGORY_ORDER,
		CATEGORY_I18N: state.CATEGORY_I18N,
		getCategoryTitle: cat => cat,
		openContextMenu: () => {},
		pluginsDataApi: null,
		ui: null,
		toast: () => {},
		onRefreshAll: async () => {},
		elRoot,
		adapterNamespace: 'msghub.0',
		...overrides,
	});
}

describe('admin/tab/panels/plugins/render.catalog.js', function () {
	// --- module exposure ---

	it('exposes createPluginsCatalogApi factory', async function () {
		const sandbox = await loadCatalogModule();
		const mod = sandbox.window.MsghubAdminTabPluginsCatalog;
		assert.equal(typeof mod.createPluginsCatalogApi, 'function');
	});

	it('createPluginsCatalogApi returns frozen object with all expected methods', async function () {
		const sandbox = await loadCatalogModule();
		const api = makeCatalogApi(sandbox);
		assert.equal(typeof api.renderMarkdownLite, 'function');
		assert.equal(typeof api.openViewer, 'function');
		assert.equal(typeof api.captureAccordionState, 'function');
		assert.equal(typeof api.toAccKey, 'function');
		assert.equal(typeof api.buildInstancesByType, 'function');
		assert.equal(typeof api.buildPluginsViewModel, 'function');
		assert.equal(typeof api.buildAddMenuItems, 'function');
		assert.equal(typeof api.renderAddToolbar, 'function');
		assert.equal(typeof api.renderCatalog, 'function');
	});

	// --- createPluginsCatalogApi null-safe init ---

	it('createPluginsCatalogApi handles null options gracefully', async function () {
		const sandbox = await loadCatalogModule();
		const { createPluginsCatalogApi } = sandbox.window.MsghubAdminTabPluginsCatalog;
		const api = createPluginsCatalogApi(null);
		assert.equal(typeof api.renderMarkdownLite, 'function');
	});

	// --- buildInstancesByType ---

	it('buildInstancesByType groups instances by type and sorts by instanceId', async function () {
		const sandbox = await loadCatalogModule();
		const { buildInstancesByType } = makeCatalogApi(sandbox);
		const instances = [
			{ type: 'IngestFoo', instanceId: 2 },
			{ type: 'IngestFoo', instanceId: 0 },
			{ type: 'IngestBar', instanceId: 1 },
		];
		const byType = buildInstancesByType(instances);
		assert.equal(typeof byType.get, 'function');
		const foo = byType.get('IngestFoo');
		assert.equal(foo.length, 2);
		assert.equal(foo[0].instanceId, 0);
		assert.equal(foo[1].instanceId, 2);
		assert.equal(byType.get('IngestBar').length, 1);
	});

	it('buildInstancesByType returns empty Map for empty input', async function () {
		const sandbox = await loadCatalogModule();
		const { buildInstancesByType } = makeCatalogApi(sandbox);
		const byType = buildInstancesByType([]);
		assert.equal(typeof byType.get, 'function');
		assert.equal(byType.size, 0);
	});

	// --- buildPluginsViewModel ---

	it('buildPluginsViewModel returns frozen object with byType and metaByType', async function () {
		const sandbox = await loadCatalogModule();
		const { buildPluginsViewModel } = makeCatalogApi(sandbox);
		const vm = buildPluginsViewModel({
			plugins: [{ type: 'IngestFoo', category: 'ingest', options: {}, discoverable: true }],
			instances: [{ type: 'IngestFoo', instanceId: 0, enabled: true }],
			readmesByType: new Map(),
		});
		assert.equal(typeof vm.byType.get, 'function');
		assert.equal(typeof vm.metaByType.get, 'function');
		assert.equal(vm.byType.get('IngestFoo').length, 1);
		assert.equal(vm.metaByType.get('IngestFoo').category, 'ingest');
	});

	it('buildPluginsViewModel handles empty plugins and instances', async function () {
		const sandbox = await loadCatalogModule();
		const { buildPluginsViewModel } = makeCatalogApi(sandbox);
		const vm = buildPluginsViewModel({ plugins: [], instances: [], readmesByType: new Map() });
		assert.equal(vm.plugins.length, 0);
		assert.equal(vm.byType.size, 0);
	});

	// --- buildAddMenuItems ---

	it('buildAddMenuItems returns empty array when no discoverable plugins', async function () {
		const sandbox = await loadCatalogModule();
		const { buildAddMenuItems } = makeCatalogApi(sandbox);
		const vm = { plugins: [{ type: 'IngestFoo', category: 'ingest', discoverable: false }], byType: new Map() };
		const items = buildAddMenuItems(vm);
		assert.equal(items.length, 0);
	});

	it('buildAddMenuItems marks entry disabled when not supportsMultiple and already exists', async function () {
		const sandbox = await loadCatalogModule();
		const { buildAddMenuItems } = makeCatalogApi(sandbox);
		const byType = new Map([['IngestFoo', [{ type: 'IngestFoo', instanceId: 0 }]]]);
		const vm = {
			plugins: [{ type: 'IngestFoo', category: 'ingest', discoverable: true, supportsMultiple: false }],
			byType,
		};
		const items = buildAddMenuItems(vm);
		assert.equal(items.length, 1);
		assert.equal(items[0].items[0].disabled, true);
	});

	it('buildAddMenuItems marks entry enabled when supportsMultiple is true', async function () {
		const sandbox = await loadCatalogModule();
		const { buildAddMenuItems } = makeCatalogApi(sandbox);
		const byType = new Map([['IngestFoo', [{ type: 'IngestFoo', instanceId: 0 }]]]);
		const vm = {
			plugins: [{ type: 'IngestFoo', category: 'ingest', discoverable: true, supportsMultiple: true }],
			byType,
		};
		const items = buildAddMenuItems(vm);
		assert.equal(items[0].items[0].disabled, false);
	});

	// --- renderAddToolbar ---

	it('renderAddToolbar returns null when no discoverable plugins', async function () {
		const sandbox = await loadCatalogModule();
		const { renderAddToolbar } = makeCatalogApi(sandbox);
		const result = renderAddToolbar({ plugins: [], byType: new Map() });
		assert.equal(result, null);
	});

	it('renderAddToolbar returns toolbar element with add button', async function () {
		const sandbox = await loadCatalogModule();
		const { renderAddToolbar } = makeCatalogApi(sandbox);
		const vm = {
			plugins: [{ type: 'IngestFoo', category: 'ingest', discoverable: true, supportsMultiple: true }],
			byType: new Map(),
		};
		const toolbar = renderAddToolbar(vm);
		assert.ok(toolbar);
		assert.ok(
			toolbar.children.some(c =>
				c?.children?.some(btn => btn?.classList?.contains('msghub-plugin-toolbar-add')),
			),
		);
	});

	// --- toAccKey ---

	it('toAccKey returns category key without instanceId', async function () {
		const sandbox = await loadCatalogModule();
		const { toAccKey } = makeCatalogApi(sandbox);
		const key = toAccKey({ kind: 'cat', type: 'IngestFoo' });
		assert.equal(key, 'cat:msghub.0:IngestFoo');
	});

	it('toAccKey returns instance key with instanceId', async function () {
		const sandbox = await loadCatalogModule();
		const { toAccKey } = makeCatalogApi(sandbox);
		const key = toAccKey({ kind: 'inst', type: 'IngestFoo', instanceId: 2 });
		assert.equal(key, 'inst:msghub.0:IngestFoo:2');
	});

	it('toAccKey returns empty string when kind or type is missing', async function () {
		const sandbox = await loadCatalogModule();
		const { toAccKey } = makeCatalogApi(sandbox);
		assert.equal(toAccKey({ kind: '', type: 'IngestFoo' }), '');
		assert.equal(toAccKey({ kind: 'inst', type: '' }), '');
	});

	// --- captureAccordionState ---

	it('captureAccordionState returns empty Map when elRoot is null', async function () {
		const sandbox = await loadCatalogModule();
		const api = makeCatalogApi(sandbox, { elRoot: null });
		const map = api.captureAccordionState();
		assert.equal(typeof map.get, 'function');
		assert.equal(map.size, 0);
	});

	it('captureAccordionState returns empty Map when no accordion inputs', async function () {
		const sandbox = await loadCatalogModule();
		const api = makeCatalogApi(sandbox);
		const map = api.captureAccordionState();
		assert.equal(typeof map.get, 'function');
		assert.equal(map.size, 0);
	});

	// --- renderMarkdownLite ---

	it('renderMarkdownLite returns a div element', async function () {
		const sandbox = await loadCatalogModule();
		const { renderMarkdownLite } = makeCatalogApi(sandbox);
		const el = renderMarkdownLite('# Hello\n\nParagraph.');
		assert.ok(el);
		assert.equal(el.tagName, 'DIV');
	});

	it('renderMarkdownLite produces an HR element for --- lines', async function () {
		const sandbox = await loadCatalogModule();
		const { renderMarkdownLite } = makeCatalogApi(sandbox);
		const el = renderMarkdownLite('---');
		assert.ok(el.children.some(c => c?.tagName === 'HR'));
	});

	it('renderMarkdownLite produces a UL for bullet items', async function () {
		const sandbox = await loadCatalogModule();
		const { renderMarkdownLite } = makeCatalogApi(sandbox);
		const el = renderMarkdownLite('- item one\n- item two');
		assert.ok(el.children.some(c => c?.tagName === 'UL'));
	});

	// --- renderCatalog ---

	it('renderCatalog returns a DocumentFragment', async function () {
		const sandbox = await loadCatalogModule();
		const api = makeCatalogApi(sandbox);
		const vm = api.buildPluginsViewModel({ plugins: [], instances: [], readmesByType: new Map() });
		const frag = api.renderCatalog({ vm, expandedById: new Map(), readmesByType: new Map(), renderInstanceRow: () => createElement('div') });
		// DocumentFragment has no tagName — check it has appendChild
		assert.equal(typeof frag.appendChild, 'function');
	});

	it('renderCatalog calls renderInstanceRow for each instance', async function () {
		const sandbox = await loadCatalogModule();
		const api = makeCatalogApi(sandbox);
		const vm = api.buildPluginsViewModel({
			plugins: [{ type: 'IngestFoo', category: 'ingest', options: { host: { type: 'string', order: 1 } }, discoverable: true }],
			instances: [
				{ type: 'IngestFoo', instanceId: 0, enabled: true },
				{ type: 'IngestFoo', instanceId: 1, enabled: true },
			],
			readmesByType: new Map(),
		});
		const calls = [];
		api.renderCatalog({
			vm,
			expandedById: new Map(),
			readmesByType: new Map(),
			renderInstanceRow: args => {
				calls.push(args);
				return createElement('div');
			},
		});
		assert.equal(calls.length, 2);
	});
});
