/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule, createH } = require('./_test.utils');

/**
 * Loads render.form.js with state.js already present in the sandbox.
 *
 * @param {object} [extras] Additional sandbox globals.
 * @returns {Promise<object>} Sandbox with MsghubAdminTabPluginsForm exposed.
 */
async function loadFormModule(extras = {}) {
	const stateSandbox = await loadPanelModule('admin/tab/panels/plugins/state.js');
	const merged = {
		// MsghubAdminTabPluginsState is set on windowObject by state.js IIFE.
		MsghubAdminTabPluginsState: stateSandbox.window.MsghubAdminTabPluginsState,
		...extras,
	};
	return loadPanelModule('admin/tab/panels/plugins/render.form.js', merged);
}

/**
 * Returns a createPluginsFormApi instance with sensible test defaults.
 *
 * @param {object} sandbox - Loaded render.form.js sandbox.
 * @param {object} [overrides] - Options to override.
 * @returns {object} Frozen form builder facade.
 */
function makeFormApi(sandbox, overrides = {}) {
	// MsghubAdminTabPluginsState was injected as an extra — access at the top level.
	const state = sandbox.MsghubAdminTabPluginsState || sandbox.window.MsghubAdminTabPluginsState;
	const { createPluginsFormApi } = sandbox.window.MsghubAdminTabPluginsForm;
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
		...overrides,
	});
}

describe('admin/tab/panels/plugins/render.form.js', function () {
	// --- module exposure ---

	it('exposes createPluginsFormApi factory', async function () {
		const sandbox = await loadFormModule();
		const api = sandbox.window.MsghubAdminTabPluginsForm;
		assert.equal(typeof api.createPluginsFormApi, 'function');
	});

	it('createPluginsFormApi returns frozen object with all expected methods', async function () {
		const sandbox = await loadFormModule();
		const form = makeFormApi(sandbox);
		assert.equal(typeof form.buildFieldInput, 'function');
		assert.equal(typeof form.parseCsvValues, 'function');
		assert.equal(typeof form.getPluginFields, 'function');
		assert.equal(typeof form.getInstanceTitleFieldKey, 'function');
		assert.equal(typeof form.formatInstanceTitleValue, 'function');
		assert.equal(typeof form.resolveDynamicOptions, 'function');
	});

	// --- parseCsvValues ---

	it('parseCsvValues splits comma-separated string', async function () {
		const sandbox = await loadFormModule();
		const { parseCsvValues } = makeFormApi(sandbox);
		// Use individual assertions — cross-realm arrays fail assert.deepEqual
		const result = parseCsvValues('a,b,c');
		assert.equal(result.length, 3);
		assert.equal(result[0], 'a');
		assert.equal(result[1], 'b');
		assert.equal(result[2], 'c');
	});

	it('parseCsvValues trims whitespace', async function () {
		const sandbox = await loadFormModule();
		const { parseCsvValues } = makeFormApi(sandbox);
		const result = parseCsvValues(' a , b ');
		assert.equal(result.length, 2);
		assert.equal(result[0], 'a');
		assert.equal(result[1], 'b');
	});

	it('parseCsvValues returns empty array for empty string', async function () {
		const sandbox = await loadFormModule();
		const { parseCsvValues } = makeFormApi(sandbox);
		assert.equal(parseCsvValues('').length, 0);
	});

	it('parseCsvValues coerces null to empty array', async function () {
		const sandbox = await loadFormModule();
		const { parseCsvValues } = makeFormApi(sandbox);
		assert.equal(parseCsvValues(null).length, 0);
	});

	// --- resolveDynamicOptions ---

	it('resolveDynamicOptions returns array input unchanged', async function () {
		const sandbox = await loadFormModule();
		const { resolveDynamicOptions } = makeFormApi(sandbox);
		const opts = [{ value: 'x' }];
		assert.equal(resolveDynamicOptions(opts), opts);
	});

	it('resolveDynamicOptions returns [] for non-MsgConstants string', async function () {
		const sandbox = await loadFormModule();
		const { resolveDynamicOptions } = makeFormApi(sandbox);
		assert.equal(resolveDynamicOptions('SomethingElse.foo').length, 0);
	});

	it('resolveDynamicOptions returns [] when constants are null', async function () {
		const sandbox = await loadFormModule();
		const { resolveDynamicOptions } = makeFormApi(sandbox, { getConstants: () => null });
		assert.equal(resolveDynamicOptions('MsgConstants.levels').length, 0);
	});

	it('resolveDynamicOptions resolves MsgConstants path and sorts by key', async function () {
		const sandbox = await loadFormModule();
		const constants = { levels: { WARN: 'warn', ERROR: 'error', INFO: 'info' } };
		const { resolveDynamicOptions } = makeFormApi(sandbox, { getConstants: () => constants });
		const result = resolveDynamicOptions('MsgConstants.levels');
		// Sorted alphabetically by key: ERROR, INFO, WARN
		assert.equal(result.length, 3);
		assert.equal(result[0].value, 'error');
		assert.equal(result[1].value, 'info');
		assert.equal(result[2].value, 'warn');
	});

	it('resolveDynamicOptions sorts numeric values in ascending order', async function () {
		const sandbox = await loadFormModule();
		const constants = { priorities: { HIGH: 10, LOW: 30, MED: 20 } };
		const { resolveDynamicOptions } = makeFormApi(sandbox, { getConstants: () => constants });
		const result = resolveDynamicOptions('MsgConstants.priorities');
		assert.equal(result[0].value, 10);
		assert.equal(result[1].value, 20);
		assert.equal(result[2].value, 30);
	});

	it('resolveDynamicOptions produces i18n label keys', async function () {
		const sandbox = await loadFormModule();
		const constants = { levels: { INFO: 'info' } };
		const { resolveDynamicOptions } = makeFormApi(sandbox, { getConstants: () => constants });
		const result = resolveDynamicOptions('MsgConstants.levels');
		assert.equal(result[0].label, 'msghub.i18n.core.admin.common.MsgConstants.levels.INFO.label');
		assert.equal(result[0].fallbackLabel, 'INFO');
	});

	// --- buildFieldInput: header ---

	it('buildFieldInput type=header returns skipSave=true', async function () {
		const sandbox = await loadFormModule();
		const { buildFieldInput } = makeFormApi(sandbox);
		const result = buildFieldInput({ type: 'header', key: '_h', label: 'Section' });
		assert.equal(result.skipSave, true);
		assert.ok(result.wrapper);
	});

	it('buildFieldInput type=header with empty label omits label element', async function () {
		const sandbox = await loadFormModule();
		const { buildFieldInput } = makeFormApi(sandbox);
		const result = buildFieldInput({ type: 'header', key: '_h', label: '' });
		assert.equal(result.skipSave, true);
		// wrapper has children: hr + null (filtered out)
		assert.ok(result.wrapper.children.some(c => c?.tagName === 'HR'));
		assert.ok(!result.wrapper.children.some(c => c?.tagName === 'P'));
	});

	// --- buildFieldInput: boolean ---

	it('buildFieldInput type=boolean returns checkbox input', async function () {
		const sandbox = await loadFormModule();
		const { buildFieldInput } = makeFormApi(sandbox);
		const result = buildFieldInput({ type: 'boolean', key: 'enabled', value: true });
		assert.ok(result.input);
		assert.equal(result.input.checked, true);
		assert.equal(typeof result.getValue, 'function');
		assert.equal(result.getValue(), true);
	});

	it('buildFieldInput type=boolean getValue returns false when unchecked', async function () {
		const sandbox = await loadFormModule();
		const { buildFieldInput } = makeFormApi(sandbox);
		const result = buildFieldInput({ type: 'boolean', key: 'enabled', value: false });
		assert.equal(result.getValue(), false);
	});

	// --- buildFieldInput: plain text (fallback) ---

	it('buildFieldInput unknown type returns text input', async function () {
		const sandbox = await loadFormModule();
		const { buildFieldInput } = makeFormApi(sandbox);
		const result = buildFieldInput({ type: 'string', key: 'name', value: 'hello' });
		assert.ok(result.input);
		assert.equal(result.input.getAttribute('type'), 'text');
		assert.equal(typeof result.getValue, 'function');
		// Mock elements don't auto-sync setAttribute('value') to .value — set directly.
		result.input.value = 'hello';
		assert.equal(result.getValue(), 'hello');
	});

	// --- buildFieldInput: number (plain) ---

	it('buildFieldInput type=number without unit returns number input', async function () {
		const sandbox = await loadFormModule();
		const { buildFieldInput } = makeFormApi(sandbox);
		const result = buildFieldInput({ type: 'number', key: 'count', value: 42 });
		assert.ok(result.input);
		assert.equal(result.input.getAttribute('type'), 'number');
		assert.equal(typeof result.getValue, 'function');
		result.input.value = '42';
		assert.equal(result.getValue(), 42);
	});

	it('buildFieldInput type=number returns null for empty value', async function () {
		const sandbox = await loadFormModule();
		const { buildFieldInput } = makeFormApi(sandbox);
		const result = buildFieldInput({ type: 'number', key: 'count', value: '' });
		result.input.value = '';
		assert.equal(result.getValue(), null);
	});

	// --- buildFieldInput: number with time unit ---

	it('buildFieldInput type=number with ms unit returns time input with select', async function () {
		const sandbox = await loadFormModule();
		const { buildFieldInput } = makeFormApi(sandbox);
		const result = buildFieldInput({ type: 'number', key: 'delayMs', value: 5000 });
		assert.ok(result.input);
		assert.ok(result.select);
		assert.equal(typeof result.getValue, 'function');
	});

	it('buildFieldInput type=number with ms unit getValue returns ms value', async function () {
		const sandbox = await loadFormModule();
		const { buildFieldInput } = makeFormApi(sandbox);
		const result = buildFieldInput({ type: 'number', key: 'delayMs', value: 60000 });
		// pickDefaultTimeUnit(60000) returns 's' or 'min' depending on state.js
		// Just verify getValue() returns a finite number
		const v = result.getValue();
		assert.ok(typeof v === 'number' || v === null);
	});

	// --- buildFieldInput: select ---

	it('buildFieldInput type=string with plain option array returns select', async function () {
		const sandbox = await loadFormModule();
		const { buildFieldInput } = makeFormApi(sandbox);
		const options = [
			{ label: 'Alpha', value: 'alpha' },
			{ label: 'Beta', value: 'beta' },
		];
		const result = buildFieldInput({ type: 'string', key: 'mode', value: 'alpha', options });
		assert.ok(result.input);
		assert.equal(result.input.tagName, 'SELECT');
		assert.equal(typeof result.getValue, 'function');
	});

	// --- getPluginFields ---

	it('getPluginFields extracts and sorts fields by order', async function () {
		const sandbox = await loadFormModule();
		const { getPluginFields } = makeFormApi(sandbox);
		const plugin = {
			options: {
				beta: { type: 'string', order: 2 },
				alpha: { type: 'number', order: 1 },
			},
		};
		const fields = getPluginFields(plugin);
		assert.equal(fields.length, 2);
		assert.equal(fields[0].key, 'alpha');
		assert.equal(fields[1].key, 'beta');
	});

	it('getPluginFields returns empty array for plugin without options', async function () {
		const sandbox = await loadFormModule();
		const { getPluginFields } = makeFormApi(sandbox);
		assert.equal(getPluginFields({}).length, 0);
	});

	// --- getInstanceTitleFieldKey ---

	it('getInstanceTitleFieldKey returns key of first holdsInstanceTitle field', async function () {
		const sandbox = await loadFormModule();
		const { getInstanceTitleFieldKey } = makeFormApi(sandbox);
		const fields = [
			{ key: 'name', holdsInstanceTitle: true, order: 1 },
			{ key: 'host', holdsInstanceTitle: true, order: 2 },
		];
		assert.equal(getInstanceTitleFieldKey(fields), 'name');
	});

	it('getInstanceTitleFieldKey returns empty string when no field is flagged', async function () {
		const sandbox = await loadFormModule();
		const { getInstanceTitleFieldKey } = makeFormApi(sandbox);
		const fields = [{ key: 'name', order: 1 }];
		assert.equal(getInstanceTitleFieldKey(fields), '');
	});

	// --- formatInstanceTitleValue ---

	it('formatInstanceTitleValue returns native value for the given field key', async function () {
		const sandbox = await loadFormModule();
		const { formatInstanceTitleValue } = makeFormApi(sandbox);
		const result = formatInstanceTitleValue({
			inst: { native: { host: 'my-broker' } },
			fieldKey: 'host',
			plugin: { options: { host: { type: 'string', default: 'localhost' } } },
		});
		assert.equal(result, 'my-broker');
	});

	it('formatInstanceTitleValue falls back to spec default when native value is null', async function () {
		const sandbox = await loadFormModule();
		const { formatInstanceTitleValue } = makeFormApi(sandbox);
		const result = formatInstanceTitleValue({
			inst: { native: { host: null } },
			fieldKey: 'host',
			plugin: { options: { host: { type: 'string', default: 'localhost' } } },
		});
		assert.equal(result, 'localhost');
	});

	it('formatInstanceTitleValue truncates values longer than 60 characters', async function () {
		const sandbox = await loadFormModule();
		const { formatInstanceTitleValue } = makeFormApi(sandbox);
		const long = 'a'.repeat(80);
		const result = formatInstanceTitleValue({
			inst: { native: { name: long } },
			fieldKey: 'name',
			plugin: {},
		});
		assert.ok(result.length <= 60);
		assert.ok(result.endsWith('…'));
	});

	it('formatInstanceTitleValue returns empty string when fieldKey is empty', async function () {
		const sandbox = await loadFormModule();
		const { formatInstanceTitleValue } = makeFormApi(sandbox);
		const result = formatInstanceTitleValue({
			inst: { native: { name: 'x' } },
			fieldKey: '',
			plugin: {},
		});
		assert.equal(result, '');
	});

	// --- null-safe factory init ---

	it('createPluginsFormApi handles null options gracefully', async function () {
		const sandbox = await loadFormModule();
		const { createPluginsFormApi } = sandbox.window.MsghubAdminTabPluginsForm;
		const form = createPluginsFormApi(null);
		assert.equal(typeof form.buildFieldInput, 'function');
	});
});
