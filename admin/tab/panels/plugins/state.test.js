/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/plugins/state.js', function () {
	it('exposes the state factory and utility helpers', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const api = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(typeof api.createPluginsState, 'function');
		assert.equal(typeof api.pick, 'function');
		assert.equal(typeof api.cssSafe, 'function');
		assert.equal(typeof api.formatPluginLabel, 'function');
		assert.equal(typeof api.normalizeUnit, 'function');
		assert.equal(typeof api.isUnitless, 'function');
		assert.equal(typeof api.pickDefaultTimeUnit, 'function');
		assert.equal(typeof api.getTimeFactor, 'function');
		assert.equal(typeof api.isTextEditableElement, 'function');
		assert.equal(typeof api.isTextEditableTarget, 'function');
		assert.ok(Array.isArray(api.CATEGORY_ORDER));
		assert.ok(Array.isArray(api.TIME_UNITS));
		assert.equal(typeof api.CATEGORY_I18N, 'object');
	});

	// --- pick() ---

	it('pick() reads a nested path from an object', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { pick } = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(pick({ a: { b: 2 } }, 'a.b'), 2);
		assert.equal(pick({ a: 1 }, 'a'), 1);
	});

	it('pick() returns undefined for missing path segments', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { pick } = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(pick({ a: 1 }, 'a.b'), undefined);
		assert.equal(pick({}, 'x'), undefined);
	});

	it('pick() handles null/invalid input without throwing', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { pick } = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(pick(null, 'a'), undefined);
		assert.equal(pick(undefined, 'a'), undefined);
		assert.equal(pick({ a: 1 }, 123), undefined);
	});

	// --- cssSafe() ---

	it('cssSafe() lowercases and replaces non-alphanumeric chars with dashes', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { cssSafe } = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(cssSafe('IngestFoo'), 'ingestfoo');
		assert.equal(cssSafe('foo bar'), 'foo-bar');
		assert.equal(cssSafe('foo--bar'), 'foo-bar');
		assert.equal(cssSafe('Foo_Bar'), 'foo_bar');
	});

	it('cssSafe() returns "unknown" for empty or whitespace-only input', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { cssSafe } = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(cssSafe(''), 'unknown');
		assert.equal(cssSafe('  '), 'unknown');
		assert.equal(cssSafe(null), 'unknown');
	});

	// --- normalizeUnit() / isUnitless() ---

	it('normalizeUnit() trims and lowercases the unit string', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { normalizeUnit } = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(normalizeUnit('  MS  '), 'ms');
		assert.equal(normalizeUnit('S'), 's');
		assert.equal(normalizeUnit(''), '');
		assert.equal(normalizeUnit(null), '');
	});

	it('isUnitless() returns true for empty or "none" units', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { isUnitless } = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(isUnitless(''), true);
		assert.equal(isUnitless('none'), true);
		assert.equal(isUnitless('NONE'), true);
		assert.equal(isUnitless('ms'), false);
		assert.equal(isUnitless('s'), false);
	});

	// --- pickDefaultTimeUnit() ---

	it('pickDefaultTimeUnit() selects the most readable time unit', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { pickDefaultTimeUnit } = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(pickDefaultTimeUnit(3600000), 'h');
		assert.equal(pickDefaultTimeUnit(7200000), 'h');
		assert.equal(pickDefaultTimeUnit(60000), 'min');
		assert.equal(pickDefaultTimeUnit(120000), 'min');
		assert.equal(pickDefaultTimeUnit(1000), 's');
		assert.equal(pickDefaultTimeUnit(5000), 's');
		assert.equal(pickDefaultTimeUnit(500), 'ms');
		assert.equal(pickDefaultTimeUnit(1), 'ms');
	});

	it('pickDefaultTimeUnit() returns "ms" for zero, negative, or non-finite input', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { pickDefaultTimeUnit } = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(pickDefaultTimeUnit(0), 'ms');
		assert.equal(pickDefaultTimeUnit(-1), 'ms');
		assert.equal(pickDefaultTimeUnit(NaN), 'ms');
		assert.equal(pickDefaultTimeUnit(Infinity), 'ms');
	});

	// --- getTimeFactor() ---

	it('getTimeFactor() returns the correct millisecond multiplier', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { getTimeFactor } = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(getTimeFactor('ms'), 1);
		assert.equal(getTimeFactor('s'), 1000);
		assert.equal(getTimeFactor('min'), 60000);
		assert.equal(getTimeFactor('h'), 3600000);
	});

	it('getTimeFactor() returns 1 for unknown unit keys', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { getTimeFactor } = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(getTimeFactor(''), 1);
		assert.equal(getTimeFactor('week'), 1);
		assert.equal(getTimeFactor(null), 1);
	});

	// --- CATEGORY_ORDER / CATEGORY_I18N ---

	it('CATEGORY_ORDER contains the four canonical categories in order', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { CATEGORY_ORDER } = sandbox.window.MsghubAdminTabPluginsState;

		assert.deepEqual(Array.from(CATEGORY_ORDER), ['ingest', 'notify', 'bridge', 'engage']);
	});

	it('CATEGORY_I18N has titleKey and descKey for each known category', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { CATEGORY_I18N } = sandbox.window.MsghubAdminTabPluginsState;

		for (const key of ['ingest', 'notify', 'bridge', 'engage']) {
			assert.ok(typeof CATEGORY_I18N[key].titleKey === 'string', `${key}.titleKey missing`);
			assert.ok(typeof CATEGORY_I18N[key].descKey === 'string', `${key}.descKey missing`);
			assert.ok(typeof CATEGORY_I18N[key].fallbackTitle === 'string', `${key}.fallbackTitle missing`);
		}
	});

	// --- createPluginsState() ---

	it('createPluginsState() initializes null caches and an empty Map', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { createPluginsState } = sandbox.window.MsghubAdminTabPluginsState;
		const state = createPluginsState();

		assert.equal(state.cachedConstants, null);
		assert.equal(state.cachedIngestStatesConstants, null);
		assert.equal(state.pluginReadmesLoadPromise, null);
		assert.equal(state.ingestStatesSchemaPromise, null);
		// Use duck-type check: VM-context Map and test-context Map are different realms,
		// so instanceof would fail even for a genuine Map instance.
		assert.equal(typeof state.pluginReadmesByType.set, 'function');
		assert.equal(typeof state.pluginReadmesByType.get, 'function');
		assert.equal(state.pluginReadmesByType.size, 0);
	});

	it('createPluginsState() returns a new independent state object each call', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { createPluginsState } = sandbox.window.MsghubAdminTabPluginsState;
		const a = createPluginsState();
		const b = createPluginsState();

		assert.notEqual(a, b);
		assert.notEqual(a.pluginReadmesByType, b.pluginReadmesByType);
	});

	// --- isTextEditableElement() / isTextEditableTarget() ---

	it('isTextEditableElement() returns false for null and plain objects', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { isTextEditableElement } = sandbox.window.MsghubAdminTabPluginsState;

		// In Node VM context HTMLInputElement etc. are not defined, so instanceof
		// checks short-circuit via typeof guard and the function returns false.
		assert.equal(isTextEditableElement(null), false);
		assert.equal(isTextEditableElement(undefined), false);
		assert.equal(isTextEditableElement({}), false);
		assert.equal(isTextEditableElement({ type: 'text' }), false);
	});

	it('isTextEditableTarget() returns false when target has no matching closest', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { isTextEditableTarget } = sandbox.window.MsghubAdminTabPluginsState;

		assert.equal(isTextEditableTarget(null), false);
		assert.equal(isTextEditableTarget({}), false);
		assert.equal(isTextEditableTarget({ closest: () => null }), false);
	});

	// --- formatPluginLabel() ---

	it('formatPluginLabel() returns primary=type and empty secondary when no distinct title', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { formatPluginLabel } = sandbox.window.MsghubAdminTabPluginsState;

		// Cross-realm objects (VM context vs test context) differ in prototype identity,
		// so deepStrictEqual would fail. Compare properties individually instead.
		const r1 = formatPluginLabel({ type: 'IngestFoo' });
		assert.equal(r1.primary, 'IngestFoo');
		assert.equal(r1.secondary, '');

		const r2 = formatPluginLabel({ type: 'IngestFoo', title: 'IngestFoo' });
		assert.equal(r2.primary, 'IngestFoo');
		assert.equal(r2.secondary, '');
	});

	it('formatPluginLabel() returns secondary when title differs from type', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { formatPluginLabel } = sandbox.window.MsghubAdminTabPluginsState;

		const r = formatPluginLabel({ type: 'IngestFoo', title: 'Foo Ingest Plugin' });
		assert.equal(r.primary, 'IngestFoo');
		assert.equal(r.secondary, 'Foo Ingest Plugin');
	});

	it('formatPluginLabel() handles missing or null plugin gracefully', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
		const { formatPluginLabel } = sandbox.window.MsghubAdminTabPluginsState;

		const rNull = formatPluginLabel(null);
		assert.equal(rNull.primary, '');
		assert.equal(rNull.secondary, '');

		const rEmpty = formatPluginLabel({});
		assert.equal(rEmpty.primary, '');
		assert.equal(rEmpty.secondary, '');
	});
});
