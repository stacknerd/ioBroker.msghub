/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule, createElement } = require('./_test.utils');

/**
 * Loads menus.js with state.js already present in the sandbox.
 *
 * @param {object} [extras] Additional sandbox globals.
 * @returns {Promise<object>} Sandbox with MsghubAdminTabPluginsMenus exposed.
 */
async function loadMenusModule(extras = {}) {
	const stateSandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
	const merged = {
		MsghubAdminTabPluginsState: stateSandbox.window.MsghubAdminTabPluginsState,
		...extras,
	};
	return loadPanelModule('admin/tab/panels/plugins/menus.js', merged);
}

/**
 * Creates a minimal mock element that acts as an instance wrap.
 *
 * @param {object} [attrs] - Data attributes to set (key → value).
 * @returns {object} Mock element with getAttribute and querySelector support.
 */
function makeInstanceWrap(attrs = {}) {
	const wrap = createElement('div');
	for (const [k, v] of Object.entries(attrs)) {
		wrap.setAttribute(k, v);
	}
	return wrap;
}

/**
 * Creates a minimal accordion input element inside a wrap.
 *
 * @param {boolean} checked - Initial checked state.
 * @returns {object} Mock INPUT element.
 */
function makeAccordionInput(checked = false) {
	const input = createElement('input');
	input.tagName = 'INPUT';
	input.checked = checked;
	input.dispatchedEvents = [];
	input.dispatchEvent = evt => {
		input.dispatchedEvents.push(evt?.type || evt);
	};
	return input;
}

/**
 * Returns a createPluginsMenusApi instance with sensible test defaults.
 *
 * @param {object} sandbox - Loaded menus.js sandbox.
 * @param {object} [overrides] - Options to override defaults.
 * @returns {object} Frozen menus facade.
 */
function makeMenusApi(sandbox, overrides = {}) {
	const state = sandbox.MsghubAdminTabPluginsState || sandbox.window.MsghubAdminTabPluginsState;
	const { createPluginsMenusApi } = sandbox.window.MsghubAdminTabPluginsMenus;

	const elRoot = createElement('div');
	const openedMenus = [];
	const ui = {
		contextMenu: {
			open: opts => openedMenus.push(opts),
		},
	};

	return {
		api: createPluginsMenusApi({
			elRoot,
			CATEGORY_I18N: state.CATEGORY_I18N,
			tOr: (k, fb) => fb || k,
			t: (k, ...args) => (args.length ? `${k}(${args.join(',')})` : k),
			ui,
			isTextEditableTarget: () => false,
			pluginsDataApi: null,
			onRefreshAll: async () => {},
			...overrides,
		}),
		elRoot,
		openedMenus,
	};
}

describe('admin/tab/panels/plugins/menus.js', function () {
	// --- module exposure ---

	it('exposes createPluginsMenusApi factory', async function () {
		const sandbox = await loadMenusModule();
		const mod = sandbox.window.MsghubAdminTabPluginsMenus;
		assert.equal(typeof mod.createPluginsMenusApi, 'function');
	});

	it('createPluginsMenusApi returns frozen object with all expected methods', async function () {
		const sandbox = await loadMenusModule();
		const { api } = makeMenusApi(sandbox);
		assert.equal(typeof api.getAllInstanceWraps, 'function');
		assert.equal(typeof api.getCategoryTitle, 'function');
		assert.equal(typeof api.setAccordionChecked, 'function');
		assert.equal(typeof api.getEnabledStats, 'function');
		assert.equal(typeof api.setEnabledForWraps, 'function');
		assert.equal(typeof api.openPluginsContextMenu, 'function');
	});

	// --- getAllInstanceWraps ---

	it('getAllInstanceWraps returns empty array when elRoot has no instances', async function () {
		const sandbox = await loadMenusModule();
		const { api } = makeMenusApi(sandbox);
		assert.equal(api.getAllInstanceWraps().length, 0);
	});

	it('getAllInstanceWraps returns empty array when elRoot is null', async function () {
		const sandbox = await loadMenusModule();
		const state = sandbox.MsghubAdminTabPluginsState || sandbox.window.MsghubAdminTabPluginsState;
		const { createPluginsMenusApi } = sandbox.window.MsghubAdminTabPluginsMenus;
		const api = createPluginsMenusApi({
			elRoot: null,
			CATEGORY_I18N: state.CATEGORY_I18N,
			tOr: (k, fb) => fb || k,
			t: k => k,
			ui: null,
			isTextEditableTarget: () => false,
		});
		assert.equal(api.getAllInstanceWraps().length, 0);
	});

	// --- getCategoryTitle ---

	it('getCategoryTitle returns fallback for unknown category', async function () {
		const sandbox = await loadMenusModule();
		const { api } = makeMenusApi(sandbox);
		const result = api.getCategoryTitle('unknown-cat');
		assert.equal(typeof result, 'string');
		assert.ok(result.length > 0);
	});

	it('getCategoryTitle resolves known CATEGORY_I18N entries', async function () {
		const sandbox = await loadMenusModule();
		const { createPluginsMenusApi } = sandbox.window.MsghubAdminTabPluginsMenus;
		const api = createPluginsMenusApi({
			CATEGORY_I18N: { notify: { titleKey: 'notify.title.key', fallbackTitle: 'Notify' } },
			tOr: (k, fb) => fb || k,
			t: k => k,
			ui: null,
			isTextEditableTarget: () => false,
		});
		const result = api.getCategoryTitle('notify');
		assert.equal(result, 'Notify');
	});

	// --- setAccordionChecked ---

	it('setAccordionChecked sets checked on INPUT elements', async function () {
		const sandbox = await loadMenusModule();
		const { api } = makeMenusApi(sandbox);

		const wrap = makeInstanceWrap();
		const input = makeAccordionInput(false);
		wrap.querySelector = sel => (sel === '.msghub-acc-input--instance' ? input : null);

		api.setAccordionChecked([wrap], true);
		assert.equal(input.checked, true);
	});

	it('setAccordionChecked dispatches change event when state changes', async function () {
		const sandbox = await loadMenusModule();
		const { api } = makeMenusApi(sandbox);

		const wrap = makeInstanceWrap();
		const input = makeAccordionInput(false);
		wrap.querySelector = sel => (sel === '.msghub-acc-input--instance' ? input : null);

		api.setAccordionChecked([wrap], true);
		assert.equal(input.dispatchedEvents.length, 1);
		assert.equal(input.dispatchedEvents[0], 'change');
	});

	it('setAccordionChecked skips elements already at target state', async function () {
		const sandbox = await loadMenusModule();
		const { api } = makeMenusApi(sandbox);

		const wrap = makeInstanceWrap();
		const input = makeAccordionInput(true);
		wrap.querySelector = sel => (sel === '.msghub-acc-input--instance' ? input : null);

		api.setAccordionChecked([wrap], true);
		assert.equal(input.dispatchedEvents.length, 0);
	});

	it('setAccordionChecked skips non-INPUT elements', async function () {
		const sandbox = await loadMenusModule();
		const { api } = makeMenusApi(sandbox);

		const wrap = makeInstanceWrap();
		const div = createElement('div');
		wrap.querySelector = () => div;

		// Should not throw or modify the div
		api.setAccordionChecked([wrap], true);
		assert.equal(div.checked, false); // createElement initialises checked:false; must not change to true
	});

	// --- getEnabledStats ---

	it('getEnabledStats counts enabled and disabled wraps', async function () {
		const sandbox = await loadMenusModule();
		const { api } = makeMenusApi(sandbox);

		const w1 = makeInstanceWrap({ 'data-enabled': '1' });
		const w2 = makeInstanceWrap({ 'data-enabled': '0' });
		const w3 = makeInstanceWrap({ 'data-enabled': '1' });

		const stats = api.getEnabledStats([w1, w2, w3]);
		assert.equal(stats.enabledCount, 2);
		assert.equal(stats.disabledCount, 1);
		assert.equal(stats.total, 3);
	});

	it('getEnabledStats returns zeros for empty array', async function () {
		const sandbox = await loadMenusModule();
		const { api } = makeMenusApi(sandbox);
		const stats = api.getEnabledStats([]);
		assert.equal(stats.total, 0);
		assert.equal(stats.enabledCount, 0);
		assert.equal(stats.disabledCount, 0);
	});

	// --- setEnabledForWraps ---

	it('setEnabledForWraps calls pluginsDataApi.setEnabled for changed wraps', async function () {
		const sandbox = await loadMenusModule();
		const calls = [];
		const pluginsDataApi = {
			setEnabled: async params => {
				calls.push(params);
			},
		};
		const { api } = makeMenusApi(sandbox, { pluginsDataApi, onRefreshAll: async () => {} });

		const w1 = makeInstanceWrap({
			'data-plugin-type': 'IngestFoo',
			'data-instance-id': '0',
			'data-enabled': '1',
		});

		await api.setEnabledForWraps([w1], false);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].type, 'IngestFoo');
		assert.equal(calls[0].instanceId, 0);
		assert.equal(calls[0].enabled, false);
	});

	it('setEnabledForWraps skips wraps already at target enabled state', async function () {
		const sandbox = await loadMenusModule();
		const calls = [];
		const pluginsDataApi = { setEnabled: async p => calls.push(p) };
		const { api } = makeMenusApi(sandbox, { pluginsDataApi, onRefreshAll: async () => {} });

		// Already disabled, target is false — should skip
		const w1 = makeInstanceWrap({
			'data-plugin-type': 'IngestFoo',
			'data-instance-id': '0',
			'data-enabled': '0',
		});

		await api.setEnabledForWraps([w1], false);
		assert.equal(calls.length, 0);
	});

	it('setEnabledForWraps calls onRefreshAll after all setEnabled calls', async function () {
		const sandbox = await loadMenusModule();
		let refreshed = false;
		const pluginsDataApi = { setEnabled: async () => {} };
		const { api } = makeMenusApi(sandbox, {
			pluginsDataApi,
			onRefreshAll: async () => {
				refreshed = true;
			},
		});

		const w1 = makeInstanceWrap({
			'data-plugin-type': 'IngestFoo',
			'data-instance-id': '0',
			'data-enabled': '1',
		});
		await api.setEnabledForWraps([w1], false);
		assert.equal(refreshed, true);
	});

	// --- openPluginsContextMenu ---

	it('openPluginsContextMenu does nothing when event is not an object', async function () {
		const sandbox = await loadMenusModule();
		const { api, openedMenus } = makeMenusApi(sandbox);
		api.openPluginsContextMenu(null, { kind: 'all' });
		assert.equal(openedMenus.length, 0);
	});

	it('openPluginsContextMenu bypasses when ctrlKey is true', async function () {
		const sandbox = await loadMenusModule();
		const { api, openedMenus } = makeMenusApi(sandbox);
		api.openPluginsContextMenu({ ctrlKey: true, preventDefault() {} }, { kind: 'all' });
		assert.equal(openedMenus.length, 0);
	});

	it('openPluginsContextMenu bypasses when target is text-editable', async function () {
		const sandbox = await loadMenusModule();
		const { api, openedMenus } = makeMenusApi(sandbox, { isTextEditableTarget: () => true });
		api.openPluginsContextMenu({ ctrlKey: false, preventDefault() {} }, { kind: 'all' });
		assert.equal(openedMenus.length, 0);
	});

	it('openPluginsContextMenu does nothing when ui.contextMenu is unavailable', async function () {
		const sandbox = await loadMenusModule();
		const state = sandbox.MsghubAdminTabPluginsState || sandbox.window.MsghubAdminTabPluginsState;
		const { createPluginsMenusApi } = sandbox.window.MsghubAdminTabPluginsMenus;
		const api = createPluginsMenusApi({
			CATEGORY_I18N: state.CATEGORY_I18N,
			tOr: (k, fb) => fb || k,
			t: k => k,
			ui: {},
			isTextEditableTarget: () => false,
		});
		// Should not throw
		api.openPluginsContextMenu({ ctrlKey: false, preventDefault() {} }, { kind: 'all' });
	});

	it('openPluginsContextMenu opens the context menu for kind=all', async function () {
		const sandbox = await loadMenusModule();
		const { api, openedMenus } = makeMenusApi(sandbox);
		const prevented = [];
		api.openPluginsContextMenu(
			{ ctrlKey: false, preventDefault: () => prevented.push(true), clientX: 10, clientY: 20 },
			{ kind: 'all' },
		);
		assert.equal(openedMenus.length, 1);
		assert.equal(prevented.length, 1);
		const menu = openedMenus[0];
		assert.ok(Array.isArray(menu.items));
	});

	it('openPluginsContextMenu adds help/tools/remove items for kind=instance', async function () {
		const sandbox = await loadMenusModule();
		const { api, openedMenus } = makeMenusApi(sandbox);
		api.openPluginsContextMenu(
			{ ctrlKey: false, preventDefault() {}, clientX: 0, clientY: 0 },
			{ kind: 'instance', pluginType: 'IngestFoo', instanceName: 'Foo #0', hasReadme: true },
		);
		const menu = openedMenus[0];
		const ids = menu.items.map(i => i.id).filter(Boolean);
		assert.ok(ids.includes('help'));
		assert.ok(ids.includes('tools'));
		assert.ok(ids.includes('remove'));
	});

	// --- null-safe factory init ---

	it('createPluginsMenusApi handles null options gracefully', async function () {
		const sandbox = await loadMenusModule();
		const { createPluginsMenusApi } = sandbox.window.MsghubAdminTabPluginsMenus;
		const api = createPluginsMenusApi(null);
		assert.equal(typeof api.openPluginsContextMenu, 'function');
	});
});
