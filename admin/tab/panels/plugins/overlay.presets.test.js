/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule, createH } = require('./_test.utils');

/** Minimal preset template required by renderIngestStatesMessagePresetsTool. */
const MINIMAL_PRESET_TEMPLATE = {
	schema: '',
	presetId: '',
	description: '',
	source: 'user',
	ownedBy: null,
	subset: null,
	message: {
		kind: '',
		level: 0,
		icon: '',
		title: '',
		text: '',
		textRecovered: '',
		timing: { timeBudget: 0, dueInMs: 0, expiresInMs: 0, cooldown: 0, remindEvery: 0 },
		details: { task: '', reason: '', tools: [], consumables: [] },
		audience: { tags: [], channels: { include: [], exclude: [] } },
		actions: [],
	},
	policy: { resetOnNormal: true },
};

const PRESET_SCHEMA = 'msghub.IngestStatesMessagePreset.v1';
const BINDING_NONE_VALUE = '__msghub_none__';
const PRESET_BINDING_CATALOG = Object.freeze({
	threshold: Object.freeze({
		ownedBy: 'Threshold',
		headerKey: 'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.header.text',
		subsetFieldKey: 'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.field.mode.label',
		subsets: Object.freeze([
			Object.freeze({
				value: 'lt',
				labelKey: 'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.field.mode.option.lt.label',
			}),
			Object.freeze({
				value: 'gt',
				labelKey: 'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.field.mode.option.gt.label',
			}),
		]),
	}),
	session: Object.freeze({
		ownedBy: 'Session',
		headerKey: 'msghub.i18n.IngestStates.admin.jsonCustom.rules.session.header.text',
		subsetFieldKey: 'msghub.i18n.IngestStates.admin.jsonCustom.rules.session.field.summary.label',
		subsets: Object.freeze([
			Object.freeze({
				value: 'start',
				labelKey: 'msghub.i18n.IngestStates.admin.jsonCustom.rules.session.field.summary.option.start.label',
			}),
			Object.freeze({
				value: 'end',
				labelKey: 'msghub.i18n.IngestStates.admin.jsonCustom.rules.session.field.summary.option.end.label',
			}),
		]),
	}),
});
const RULE_TEMPLATE_CATALOG = Object.freeze({
	threshold: Object.freeze({
		metrics: Object.freeze({
			'state-name': Object.freeze({
				type: 'string',
				labelKey: 'metric.stateName.label',
				helpKey: 'metric.stateName.help',
				subset: null,
			}),
			'state-min': Object.freeze({
				type: 'number',
				labelKey: 'metric.stateMin.label',
				helpKey: 'metric.stateMin.help',
				subset: Object.freeze(['lt']),
			}),
			'state-max': Object.freeze({
				type: 'number',
				labelKey: 'metric.stateMax.label',
				helpKey: 'metric.stateMax.help',
				subset: Object.freeze(['gt']),
			}),
		}),
	}),
	session: Object.freeze({
		metrics: Object.freeze({
			'session-counter': Object.freeze({
				type: 'number',
				labelKey: 'metric.sessionCounter.label',
				helpKey: 'metric.sessionCounter.help',
				subset: null,
			}),
		}),
	}),
});

/**
 * Loads overlay.presets.js into a VM sandbox.
 *
 * @param {object} [extras] Additional sandbox globals.
 * @returns {Promise<object>} Sandbox with MsghubAdminTabPluginsPresets exposed.
 */
async function loadPresetsModule(extras = {}) {
	return loadPanelModule('admin/tab/panels/plugins/overlay.presets.js', extras);
}

/**
 * Creates a createPluginsPresetsApi instance with test defaults.
 *
 * @param {object} sandbox - Loaded module sandbox.
 * @param {object} [overrides] - Options to pass to createPluginsPresetsApi.
 * @returns {object} Frozen presets API.
 */
function makePresetsApi(sandbox, overrides = {}) {
	const { createPluginsPresetsApi } = sandbox.window.MsghubAdminTabPluginsPresets;
	return createPluginsPresetsApi({
		h: createH(),
		ui: null,
		confirmDialog: async () => false,
		formApi: null,
		pickText: v => String(v ?? ''),
		ingestStatesDataApi: {
			listPresets: async () => [],
			getPreset: async () => ({ preset: null }),
			createPreset: async () => ({ ok: false }),
			updatePreset: async () => ({ ok: false }),
			deletePreset: async () => ({ ok: false }),
		},
		...overrides,
	});
}

/**
 * Renders the presets tool element.
 *
 * @param {object} presetsApi - API instance from makePresetsApi.
 * @param {object} [ingestConstantsOverrides] - Overrides for ingestConstants.
 * @returns {object} Tool root element.
 */
function renderTool(presetsApi, ingestConstantsOverrides = {}) {
	return presetsApi.renderIngestStatesMessagePresetsTool({
		ingestConstants: {
			presetSchema: PRESET_SCHEMA,
			presetTemplateV1: MINIMAL_PRESET_TEMPLATE,
			presetBindingCatalog: PRESET_BINDING_CATALOG,
			ruleTemplateCatalog: RULE_TEMPLATE_CATALOG,
			...ingestConstantsOverrides,
		},
	});
}

/**
 * Creates a minimal formApi stub for editor rendering tests.
 *
 * @returns {object} formApi replacement.
 */
function makeFormApiStub() {
	const h = createH();
	return {
		resolveDynamicOptions: () => [],
		buildFieldInput({ type, key, label, value, options }) {
			if (type === 'header') {
				return { wrapper: h('div', { class: 'msghub-field-header', text: String(label || '') }) };
			}
			if ((type === 'string' || type === 'number') && Array.isArray(options) && options.length > 0) {
				const input = h('select', { 'data-key': String(key || '') });
				for (const option of options) {
					input.appendChild(
						h('option', {
							value: String(option?.value ?? ''),
							text: String(option?.label ?? option?.value ?? ''),
						}),
					);
				}
				input.value = value == null ? '' : String(value);
				return {
					wrapper: h('div', { class: 'msghub-field' }, [input, h('label', { text: String(label || '') })]),
					input,
					getValue: () => input.value,
				};
			}
			const input = h('input', {
				type: type === 'boolean' ? 'checkbox' : 'text',
				'data-key': String(key || ''),
				value: type === 'boolean' ? undefined : String(value ?? ''),
			});
			if (type === 'boolean') {
				input.checked = value === true;
			}
			return {
				wrapper: h('div', { class: 'msghub-field' }, [input, h('label', { text: String(label || '') })]),
				input,
				getValue: () => (type === 'boolean' ? input.checked === true : input.value),
			};
		},
	};
}

/** Drains the microtask queue so async loadList() calls settle. */
async function settle() {
	await new Promise(r => setImmediate(r));
}

/**
 * Returns all preset table row elements from the rendered tool.
 *
 * DOM path: el > .msghub-tools-presets-grid > elList > [listHeader, items]
 *         > table > tbody > tr x N
 *
 * @param {object} el - Root element returned by renderTool.
 * @returns {object[]} Preset row elements.
 */
function getPresetRows(el) {
	const grid = el.children[0];
	if (!grid) return [];
	const elList = grid.children[0];
	if (!elList || elList.children.length < 2) return [];
	const items = elList.children[1];
	if (!items || !items.children || !items.children[0]) return [];
	const table = items.children[0];
	if (!Array.isArray(table.children)) return [];
	const tbody = table.children.find(c => c && c.tagName === 'TBODY');
	if (!tbody || !Array.isArray(tbody.children)) return [];
	return tbody.children.filter(c => c && c.tagName === 'TR');
}

/**
 * Recursively finds the first element matching a predicate.
 *
 * @param {object} node Root node.
 * @param {Function} predicate Match callback.
 * @returns {object|null} Matching element or null.
 */
function findNode(node, predicate) {
	if (!node || typeof predicate !== 'function') {
		return null;
	}
	if (predicate(node)) {
		return node;
	}
	const children = Array.isArray(node.children) ? node.children : [];
	for (const child of children) {
		const found = findNode(child, predicate);
		if (found) {
			return found;
		}
	}
	return null;
}

/**
 * Returns all nodes matching a predicate.
 *
 * @param {object} node Root node.
 * @param {Function} predicate Match callback.
 * @returns {object[]} Matching nodes.
 */
function findNodes(node, predicate) {
	const matches = [];
	if (!node || typeof predicate !== 'function') {
		return matches;
	}
	if (predicate(node)) {
		matches.push(node);
	}
	const children = Array.isArray(node.children) ? node.children : [];
	for (const child of children) {
		matches.push(...findNodes(child, predicate));
	}
	return matches;
}

describe('admin/tab/panels/plugins/overlay.presets.js', function () {
	// --- module exposure ---

	it('exposes createPluginsPresetsApi factory', async function () {
		const sandbox = await loadPresetsModule();
		const mod = sandbox.window.MsghubAdminTabPluginsPresets;
		assert.equal(typeof mod.createPluginsPresetsApi, 'function');
	});

	it('createPluginsPresetsApi returns object with renderIngestStatesMessagePresetsTool', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox);
		assert.equal(typeof api.renderIngestStatesMessagePresetsTool, 'function');
	});

	it('renderIngestStatesMessagePresetsTool exposes initial readiness promise on the root element', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox);
		const el = renderTool(api);
		assert.equal(typeof el.__msghubReady?.then, 'function');
		await el.__msghubReady;
	});

	it('renderIngestStatesMessagePresetsTool returns a DOM element', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox);
		const el = renderTool(api);
		assert.ok(el, 'element should be returned');
		assert.equal(typeof el.tagName, 'string');
	});

	// --- table structure ---

	it('renderList builds a table with 5 header columns after presets load', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Name', ownedBy: null, kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		const grid = el.children[0];
		const elList = grid.children[0];
		const items = elList.children[1];
		const table = items.children[0];
		assert.equal(table.tagName, 'TABLE', 'list items container should hold a TABLE');
		const thead = table.children.find(c => c && c.tagName === 'THEAD');
		assert.ok(thead, 'table should have a thead');
		assert.equal(thead.children[0].children.length, 5, 'header row should have 5 th elements');
	});

	it('renderList adds consistent column classes to colgroup, header and body cells', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Name', ownedBy: 'Session', kind: 'status', level: 20, subset: 'end' },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		const grid = el.children[0];
		const elList = grid.children[0];
		const items = elList.children[1];
		const table = items.children[0];
		const colgroup = table.children.find(c => c && c.tagName === 'COLGROUP');
		const thead = table.children.find(c => c && c.tagName === 'THEAD');
		const tbody = table.children.find(c => c && c.tagName === 'TBODY');
		const columnClasses = [
			'msghub-col--preset-ownedBy',
			'msghub-col--preset-subset',
			'msghub-col--preset-kind',
			'msghub-col--preset-level',
			'msghub-col--preset-name',
		];
		assert.equal(colgroup.children.length, columnClasses.length);
		assert.equal(thead.children[0].children.length, columnClasses.length);
		assert.equal(tbody.children[0].children.length, columnClasses.length);
		for (let i = 0; i < columnClasses.length; i += 1) {
			const className = columnClasses[i];
			assert.ok(colgroup.children[i].className.includes(className));
			assert.ok(thead.children[0].children[i].className.includes(className));
			assert.ok(tbody.children[0].children[i].className.includes(className));
		}
	});

	// --- loadList field mapping ---

	it('loadList uses name field from API response as preset description', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'My Preset Name', ownedBy: null, kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		const rows = getPresetRows(el);
		assert.equal(rows.length, 1);
		// Name is in column 4 (ownedBy | subset | kind | level | name)
		assert.equal(
			rows[0].children[4].textContent,
			'My Preset Name',
			`Expected name in name column, got: ${rows[0].children[4].textContent}`,
		);
	});

	it('loadList maps kind into kind column', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Preset', ownedBy: null, kind: 'task', level: 30, subset: null },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		const rows = getPresetRows(el);
		assert.equal(rows.length, 1);
		// Kind column (index 2): t() falls back to key, which contains the kind name
		assert.ok(
			rows[0].children[2].textContent.includes('task'),
			`Expected kind 'task' in kind column, got: ${rows[0].children[2].textContent}`,
		);
	});

	it('loadList maps level into level column as numeric fallback when constants absent', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Preset', ownedBy: null, kind: 'task', level: 30, subset: null },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		const rows = getPresetRows(el);
		assert.equal(rows.length, 1);
		// No getMsgConstants provided → levelKeyMap empty → level shown as numeric string
		assert.equal(
			rows[0].children[3].textContent,
			'30',
			`Expected numeric level '30' in level column, got: ${rows[0].children[3].textContent}`,
		);
	});

	it('getMsgConstants level map is used to resolve level label when provided', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Preset', ownedBy: null, kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => ({ preset: null }),
			},
			getMsgConstants: () => ({ level: { notice: 20, warning: 30 } }),
			t: key => (key.endsWith('.label') ? key.split('.').slice(-2, -1)[0] : key),
		});
		const el = renderTool(api);
		await settle();
		const rows = getPresetRows(el);
		assert.equal(rows.length, 1);
		// level 20 → key 'notice' → t('...notice.label') → 'notice' (via test t)
		assert.equal(
			rows[0].children[3].textContent,
			'notice',
			`Expected 'notice' in level column, got: ${rows[0].children[3].textContent}`,
		);
	});

	// --- sort order ---

	it('custom presets appear before owned presets regardless of alphabetical order', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'pFree', name: 'AAA Free', ownedBy: null, kind: 'status', level: 20, subset: null },
					{ value: 'pOwned', name: 'ZZZ Owned', ownedBy: 'Session', kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		const rows = getPresetRows(el);
		assert.equal(rows.length, 2);
		assert.equal(
			rows[0].children[4].textContent,
			'AAA Free',
			`Expected custom preset first, got: ${rows[0].children[4].textContent}`,
		);
		assert.equal(
			rows[1].children[4].textContent,
			'ZZZ Owned',
			`Expected owned preset second, got: ${rows[1].children[4].textContent}`,
		);
	});

	it('within custom group presets sort alphabetically by description', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'pBeta', name: 'Beta', ownedBy: null, kind: 'status', level: 20, subset: null },
					{ value: 'pAlpha', name: 'Alpha', ownedBy: null, kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		const rows = getPresetRows(el);
		assert.equal(rows.length, 2);
		assert.equal(rows[0].children[4].textContent, 'Alpha', `Expected Alpha first, got: ${rows[0].children[4].textContent}`);
		assert.equal(rows[1].children[4].textContent, 'Beta', `Expected Beta second, got: ${rows[1].children[4].textContent}`);
	});

	it('within owned presets sorting uses ownedBy then subset then description', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p3', name: 'Beta', ownedBy: 'Session', kind: 'status', level: 20, subset: 'end' },
					{ value: 'p1', name: 'Zulu', ownedBy: 'Alert', kind: 'status', level: 20, subset: 'core' },
					{ value: 'p4', name: 'Alpha', ownedBy: 'Session', kind: 'status', level: 20, subset: 'end' },
					{ value: 'p2', name: 'Alpha', ownedBy: 'Session', kind: 'status', level: 20, subset: 'begin' },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		const rows = getPresetRows(el);
		assert.equal(rows.length, 4);
		assert.equal(rows[0].children[4].textContent, 'Zulu');
		assert.equal(rows[1].children[4].textContent, 'Alpha');
		assert.equal(rows[2].children[4].textContent, 'Alpha');
		assert.equal(rows[3].children[4].textContent, 'Beta');
	});

	// --- null subset handling ---

	it('preset with null subset is included without errors', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Name', ownedBy: null, kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		let thrown = null;
		try {
			const el = renderTool(api);
			await settle();
			const rows = getPresetRows(el);
			assert.equal(rows.length, 1);
			// null subset → subset column shows empty string
			assert.equal(rows[0].children[1].textContent, '');
		} catch (err) {
			thrown = err;
		}
		assert.equal(thrown, null, `Unexpected error: ${thrown}`);
	});

	it('preset with string subset resolves via i18n when SUBSET_FIELD mapping exists', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Preset', ownedBy: 'Session', kind: 'status', level: 20, subset: 'end' },
				],
				getPreset: async () => ({ preset: null }),
			},
			t: key => (key.endsWith('.option.end.label') ? 'Session end' : key),
		});
		const el = renderTool(api);
		await settle();
		const rows = getPresetRows(el);
		assert.equal(rows.length, 1, 'Preset with subset should be rendered');
		assert.equal(rows[0].children[1].textContent, 'Session end', 'subset column should show i18n-resolved option label');
	});

	it('setSelected uses spinner toast instead of inline loading text while preset details load', async function () {
		const sandbox = await loadPresetsModule();
		const spinnerCalls = [];
		let resolvePreset;
		const presetPromise = new Promise(resolve => {
			resolvePreset = resolve;
		});
		const api = makePresetsApi(sandbox, {
			ui: {
				spinner: {
					show: opts => {
						spinnerCalls.push({ kind: 'show', opts });
						return opts.id;
					},
					hide: id => spinnerCalls.push({ kind: 'hide', id }),
				},
			},
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Preset', ownedBy: null, kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => presetPromise,
			},
		});
		const el = renderTool(api);
		await el.__msghubReady;
		const rows = getPresetRows(el);
		assert.equal(rows.length, 1);

		rows[0].dispatchEvent({ type: 'click' });
		await settle();

		const editor = el.children[0].children[1];
		assert.equal(editor.children[0].textContent, 'Select a preset or create a new one.');
		assert.deepEqual(spinnerCalls.map(call => call.kind), ['show']);
		assert.equal(spinnerCalls[0].opts.id, 'msghub-presets-item-load');

		resolvePreset({ preset: null });
		await settle();

		assert.deepEqual(spinnerCalls.map(call => call.kind), ['show', 'hide']);
		assert.equal(spinnerCalls[1].id, 'msghub-presets-item-load');
	});

	it('user presets keep rule and subset editable in the editor', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			formApi: makeFormApiStub(),
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Preset', source: 'user', ownedBy: 'Session', kind: 'status', level: 20, subset: 'start' },
				],
				getPreset: async () => ({
					preset: {
						...MINIMAL_PRESET_TEMPLATE,
						schema: PRESET_SCHEMA,
						presetId: 'p1',
						description: 'Preset',
						source: 'user',
						ownedBy: 'Session',
						subset: 'start',
						message: { ...MINIMAL_PRESET_TEMPLATE.message, kind: 'status', level: 20, title: 'T', text: 'X' },
					},
				}),
			},
		});
		const el = renderTool(api);
		await el.__msghubReady;
		const rows = getPresetRows(el);
		assert.equal(rows.length, 1);

		rows[0].dispatchEvent({ type: 'click' });
		await settle();

		const editor = el.children[0].children[1];
		const ownedByInput = findNode(editor, node => node?.getAttribute?.('data-key') === 'ownedBy');
		const subsetInput = findNode(editor, node => node?.getAttribute?.('data-key') === 'subset');
		assert.equal(ownedByInput?.tagName, 'SELECT');
		assert.equal(subsetInput?.tagName, 'SELECT');
		assert.equal(ownedByInput?.disabled, false);
		assert.equal(subsetInput?.disabled, false);
	});

	it('builtin presets remain view-only in the editor', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			formApi: makeFormApiStub(),
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Preset', source: 'builtin', ownedBy: 'Session', kind: 'status', level: 20, subset: 'start' },
				],
				getPreset: async () => ({
					preset: {
						...MINIMAL_PRESET_TEMPLATE,
						schema: PRESET_SCHEMA,
						presetId: 'p1',
						description: 'Preset',
						source: 'builtin',
						ownedBy: 'Session',
						subset: 'start',
						message: { ...MINIMAL_PRESET_TEMPLATE.message, kind: 'status', level: 20, title: 'T', text: 'X' },
					},
				}),
			},
		});
		const el = renderTool(api);
		await el.__msghubReady;
		const rows = getPresetRows(el);
		assert.equal(rows.length, 1);

		rows[0].dispatchEvent({ type: 'click' });
		await settle();

		const editor = el.children[0].children[1];
		const ownedByInput = findNode(editor, node => node?.getAttribute?.('data-key') === 'ownedBy');
		const subsetInput = findNode(editor, node => node?.getAttribute?.('data-key') === 'subset');
		const saveButton = findNode(editor, node => node?.tagName === 'BUTTON' && node?.textContent === 'Save');
		assert.equal(ownedByInput?.disabled, true);
		assert.equal(subsetInput?.disabled, true);
		assert.equal(saveButton?.getAttribute?.('disabled'), 'true');
	});

	it('ownedBy and subset dropdowns expose null options first', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			formApi: makeFormApiStub(),
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Preset', source: 'user', ownedBy: null, kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => ({
					preset: {
						...MINIMAL_PRESET_TEMPLATE,
						schema: PRESET_SCHEMA,
						presetId: 'p1',
						description: 'Preset',
						source: 'user',
						ownedBy: null,
						subset: null,
						message: { ...MINIMAL_PRESET_TEMPLATE.message, kind: 'status', level: 20, title: 'T', text: 'X' },
					},
				}),
			},
		});
		const el = renderTool(api);
		await el.__msghubReady;
		getPresetRows(el)[0].dispatchEvent({ type: 'click' });
		await settle();

		const editor = el.children[0].children[1];
		const ownedByInput = findNode(editor, node => node?.getAttribute?.('data-key') === 'ownedBy');
		const subsetInput = findNode(editor, node => node?.getAttribute?.('data-key') === 'subset');
		assert.equal(ownedByInput.children[0].textContent, '(keine spezifische Regel)');
		assert.equal(subsetInput.children[0].textContent, '(keine weitere Eingrenzung)');
		assert.equal(ownedByInput.value, BINDING_NONE_VALUE);
		assert.equal(subsetInput.value, BINDING_NONE_VALUE);
		assert.equal(subsetInput.children.length, 1);
	});

	it('changing ownedBy resets invalid subset to null and replaces subset options', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			formApi: makeFormApiStub(),
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Preset', source: 'user', ownedBy: 'Session', kind: 'status', level: 20, subset: 'start' },
				],
				getPreset: async () => ({
					preset: {
						...MINIMAL_PRESET_TEMPLATE,
						schema: PRESET_SCHEMA,
						presetId: 'p1',
						description: 'Preset',
						source: 'user',
						ownedBy: 'Session',
						subset: 'start',
						message: { ...MINIMAL_PRESET_TEMPLATE.message, kind: 'status', level: 20, title: 'T', text: 'X' },
					},
				}),
				updatePreset: async () => ({ ok: true }),
			},
		});
		const el = renderTool(api);
		await el.__msghubReady;
		getPresetRows(el)[0].dispatchEvent({ type: 'click' });
		await settle();

		const editor = el.children[0].children[1];
		const ownedByInput = findNode(editor, node => node?.getAttribute?.('data-key') === 'ownedBy');
		const subsetInput = findNode(editor, node => node?.getAttribute?.('data-key') === 'subset');
		assert.equal(subsetInput.value, 'start');
		assert.deepEqual(
			findNodes(subsetInput, node => node?.tagName === 'OPTION').map(node => node.textContent),
			[
				'(keine weitere Eingrenzung)',
				'msghub.i18n.IngestStates.admin.jsonCustom.rules.session.field.summary.option.start.label',
				'msghub.i18n.IngestStates.admin.jsonCustom.rules.session.field.summary.option.end.label',
			],
		);

		ownedByInput.value = 'Threshold';
		ownedByInput.dispatchEvent({ type: 'change' });
		await settle();

		assert.equal(subsetInput.value, BINDING_NONE_VALUE);
		assert.deepEqual(
			findNodes(subsetInput, node => node?.tagName === 'OPTION').map(node => node.textContent),
			[
				'(keine weitere Eingrenzung)',
				'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.field.mode.option.lt.label',
				'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.field.mode.option.gt.label',
			],
		);

		ownedByInput.value = BINDING_NONE_VALUE;
		ownedByInput.dispatchEvent({ type: 'change' });
		await settle();

		assert.equal(subsetInput.value, BINDING_NONE_VALUE);
		assert.deepEqual(
			findNodes(subsetInput, node => node?.tagName === 'OPTION').map(node => node.textContent),
			['(keine weitere Eingrenzung)'],
		);
	});

	it('shows allowed templates below message text based on ownedBy and subset', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			formApi: makeFormApiStub(),
			t: key => {
				const map = {
					'metric.stateName.label': 'State name',
					'metric.stateName.help': 'Name of the monitored state.',
					'metric.stateMin.label': 'Lower limit',
					'metric.stateMin.help': 'Available for lt.',
					'metric.stateMax.label': 'Upper limit',
					'metric.stateMax.help': 'Available for gt.',
					'msghub.i18n.IngestStates.admin.presets.allowedTemplates.label': 'Allowed templates',
					'msghub.i18n.IngestStates.admin.presets.allowedTemplates.empty.text': 'No rule-specific templates available.',
				};
				return map[key] || key;
			},
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Preset', source: 'user', ownedBy: 'Threshold', kind: 'status', level: 20, subset: 'lt' },
				],
				getPreset: async () => ({
					preset: {
						...MINIMAL_PRESET_TEMPLATE,
						schema: PRESET_SCHEMA,
						presetId: 'p1',
						description: 'Preset',
						source: 'user',
						ownedBy: 'Threshold',
						subset: 'lt',
						message: { ...MINIMAL_PRESET_TEMPLATE.message, kind: 'status', level: 20, title: 'T', text: 'X' },
					},
				}),
			},
		});
		const el = renderTool(api);
		await el.__msghubReady;
		getPresetRows(el)[0].dispatchEvent({ type: 'click' });
		await settle();

		const editor = el.children[0].children[1];
		const texts = findNodes(editor, node => typeof node?.textContent === 'string' && node.textContent)
			.map(node => node.textContent);

		assert.ok(texts.includes('Allowed templates'));
		assert.ok(texts.includes('{{m.state-name}} - State name'));
		assert.ok(texts.includes('Name of the monitored state.'));
		assert.ok(texts.includes('{{m.state-min}} - Lower limit'));
		assert.ok(texts.includes('Available for lt.'));
		assert.equal(texts.includes('{{m.state-max}} - Upper limit'), false);
	});

	it('shows only subset-agnostic templates when ownedBy is set and subset stays empty', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			formApi: makeFormApiStub(),
			t: key => {
				const map = {
					'metric.stateName.label': 'State name',
					'metric.stateName.help': 'Name of the monitored state.',
					'metric.stateMin.label': 'Lower limit',
					'metric.stateMin.help': 'Available for lt.',
					'metric.stateMax.label': 'Upper limit',
					'metric.stateMax.help': 'Available for gt.',
					'msghub.i18n.IngestStates.admin.presets.allowedTemplates.label': 'Allowed templates',
					'msghub.i18n.IngestStates.admin.presets.allowedTemplates.empty.text': 'No rule-specific templates available.',
				};
				return map[key] || key;
			},
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Preset', source: 'user', ownedBy: 'Threshold', kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => ({
					preset: {
						...MINIMAL_PRESET_TEMPLATE,
						schema: PRESET_SCHEMA,
						presetId: 'p1',
						description: 'Preset',
						source: 'user',
						ownedBy: 'Threshold',
						subset: null,
						message: { ...MINIMAL_PRESET_TEMPLATE.message, kind: 'status', level: 20, title: 'T', text: 'X' },
					},
				}),
			},
		});
		const el = renderTool(api);
		await el.__msghubReady;
		getPresetRows(el)[0].dispatchEvent({ type: 'click' });
		await settle();

		const editor = el.children[0].children[1];
		const texts = findNodes(editor, node => typeof node?.textContent === 'string' && node.textContent).map(node => node.textContent);

		assert.ok(texts.includes('Allowed templates'));
		assert.ok(texts.includes('{{m.state-name}} - State name'));
		assert.ok(texts.includes('Name of the monitored state.'));
		assert.equal(texts.includes('{{m.state-min}} - Lower limit'), false);
		assert.equal(texts.includes('Available for lt.'), false);
		assert.equal(texts.includes('{{m.state-max}} - Upper limit'), false);
		assert.equal(texts.includes('Available for gt.'), false);
	});

	it('duplicate save creates a preset without frontend presetId input', async function () {
		const sandbox = await loadPresetsModule();
		let listCalls = 0;
		let createParams = null;
		const translations = {
			'msghub.i18n.IngestStates.admin.presets.presetId.label': 'Preset ID',
			'msghub.i18n.IngestStates.admin.presets.presetId.pending.text':
				'Generated automatically on first save.',
		};
		const api = makePresetsApi(sandbox, {
			formApi: makeFormApiStub(),
			t: key => translations[key] || key,
			ingestStatesDataApi: {
				listPresets: async () => {
					listCalls += 1;
					return listCalls === 1
						? [{ value: 'p1', name: 'Preset', source: 'user', ownedBy: null, kind: 'status', level: 20, subset: null }]
						: [
								{ value: 'p1', name: 'Preset', source: 'user', ownedBy: null, kind: 'status', level: 20, subset: null },
								{
									value: 'preset-2',
									name: 'Preset',
									source: 'user',
									ownedBy: null,
									kind: 'status',
									level: 20,
									subset: null,
								},
							];
				},
				getPreset: async ({ presetId }) => ({
					preset: {
						...MINIMAL_PRESET_TEMPLATE,
						schema: PRESET_SCHEMA,
						presetId,
						description: 'Preset',
						source: 'user',
						ownedBy: null,
						subset: null,
						message: {
							...MINIMAL_PRESET_TEMPLATE.message,
							kind: 'status',
							level: 20,
							title: 'T',
							text: 'X',
						},
					},
				}),
				createPreset: async params => {
					createParams = params;
					return { presetId: 'preset-2' };
				},
			},
		});
		const el = renderTool(api);
		await el.__msghubReady;
		getPresetRows(el)[0].dispatchEvent({ type: 'click' });
		await settle();

		const list = el.children[0].children[0];
		const duplicateButton = findNode(list, node => node?.tagName === 'BUTTON' && node?.textContent === '⧉');
		duplicateButton.dispatchEvent({ type: 'click' });
		await settle();
		await settle();

		const editor = el.children[0].children[1];
		assert.equal(findNode(editor, node => node?.getAttribute?.('data-key') === 'presetId'), null);

		const saveButton = findNode(editor, node => node?.tagName === 'BUTTON' && node?.textContent === 'Save');
		saveButton.dispatchEvent({ type: 'click' });
		await settle();
		await settle();

		assert.deepEqual(JSON.parse(JSON.stringify(createParams)), {
			preset: {
				schema: PRESET_SCHEMA,
				description: 'Preset',
				source: 'user',
				ownedBy: null,
				subset: null,
				message: {
					kind: 'status',
					level: 20,
					icon: '',
					title: 'T',
					text: 'X',
					textRecovered: '',
					timing: { timeBudget: 0, dueInMs: 0, expiresInMs: 0, cooldown: 0, remindEvery: 0 },
					details: { task: '', reason: '', tools: [], consumables: [] },
					audience: { tags: [], channels: { include: [], exclude: [] } },
					actions: [],
				},
				policy: { resetOnNormal: true },
			},
		});
	});

	it('editing an existing preset saves via updatePreset with payload presetId only', async function () {
		const sandbox = await loadPresetsModule();
		let listCalls = 0;
		let updateParams = null;
		const api = makePresetsApi(sandbox, {
			formApi: makeFormApiStub(),
			ingestStatesDataApi: {
				listPresets: async () => {
					listCalls += 1;
					return [
						{
							value: 'p1',
							name: listCalls === 1 ? 'Preset' : 'Renamed Preset',
							source: 'user',
							ownedBy: 'Session',
							kind: 'status',
							level: 20,
							subset: 'start',
						},
					];
				},
				getPreset: async () => ({
					preset: {
						...MINIMAL_PRESET_TEMPLATE,
						schema: PRESET_SCHEMA,
						presetId: 'p1',
						description: listCalls === 1 ? 'Preset' : 'Renamed Preset',
						source: 'user',
						ownedBy: 'Session',
						subset: 'start',
						message: {
							...MINIMAL_PRESET_TEMPLATE.message,
							kind: 'status',
							level: 20,
							title: 'T',
							text: 'X',
						},
					},
				}),
				updatePreset: async params => {
					updateParams = params;
					return { presetId: 'p1' };
				},
			},
		});
		const el = renderTool(api);
		await el.__msghubReady;
		getPresetRows(el)[0].dispatchEvent({ type: 'click' });
		await settle();

		const editor = el.children[0].children[1];
		const descriptionInput = findNode(editor, node => node?.getAttribute?.('data-key') === 'description');
		descriptionInput.value = 'Renamed Preset';
		descriptionInput.dispatchEvent({ type: 'input' });
		await settle();

		const saveButton = findNode(editor, node => node?.tagName === 'BUTTON' && node?.textContent === 'Save');
		saveButton.dispatchEvent({ type: 'click' });
		await settle();
		await settle();

		assert.deepEqual(JSON.parse(JSON.stringify(updateParams)), {
			presetId: 'p1',
			preset: {
				schema: PRESET_SCHEMA,
				description: 'Renamed Preset',
				source: 'user',
				ownedBy: 'Session',
				subset: 'start',
				message: {
					kind: 'status',
					level: 20,
					icon: '',
					title: 'T',
					text: 'X',
					textRecovered: '',
					timing: { timeBudget: 0, dueInMs: 0, expiresInMs: 0, cooldown: 0, remindEvery: 0 },
					details: { task: '', reason: '', tools: [], consumables: [] },
					audience: { tags: [], channels: { include: [], exclude: [] } },
					actions: [],
				},
				policy: { resetOnNormal: true },
			},
		});
	});
});
