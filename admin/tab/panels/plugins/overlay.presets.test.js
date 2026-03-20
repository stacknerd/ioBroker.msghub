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
 * Returns the rendered preset table element.
 *
 * DOM path: el > .msghub-tools-presets-grid > elList > [listHeader, items]
 *         > table
 *
 * @param {object} el - Root element returned by renderTool.
 * @returns {object|null} Preset table element.
 */
function getPresetTable(el) {
	const grid = el.children[0];
	if (!grid) return null;
	const elList = grid.children[0];
	if (!elList || elList.children.length < 2) return null;
	const items = elList.children[1];
	if (!items || !items.children || !items.children[0]) return null;
	const table = items.children[0];
	return Array.isArray(table?.children) ? table : null;
}

/**
 * Returns all grouped tbody elements from the rendered presets table.
 *
 * @param {object} el - Root element returned by renderTool.
 * @returns {object[]} Group tbody elements.
 */
function getPresetGroups(el) {
	const table = getPresetTable(el);
	if (!table) return [];
	return table.children.filter(
		c => c && c.tagName === 'TBODY' && String(c.className || '').includes('msghub-table-group'),
	);
}

/**
 * Returns all actual preset data rows across all groups.
 *
 * @param {object} el - Root element returned by renderTool.
 * @returns {object[]} Preset data row elements.
 */
function getPresetRows(el) {
	return getPresetGroups(el).flatMap(group =>
		(Array.isArray(group.children) ? group.children : []).filter(
			c => c && c.tagName === 'TR' && String(c.className || '').includes('msghub-table-data-row'),
		),
	);
}

/**
 * Returns a flattened text snapshot of all group labels.
 *
 * @param {object} el - Root element returned by renderTool.
 * @returns {string[]} Group titles.
 */
function getPresetGroupTitles(el) {
	return getPresetGroups(el).map(group => {
		const row = Array.isArray(group.children) ? group.children[0] : null;
		const cell = row?.children?.[0];
		return cell?.textContent || '';
	});
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

	it('renderList builds a table with 6 header columns after presets load', async function () {
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
		assert.equal(thead.children[0].children.length, 6, 'header row should have 6 th elements');
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
		const firstDataRow = getPresetRows(el)[0];
		const columnClasses = [
			'msghub-col--preset-usage',
			'msghub-col--preset-ownedBy',
			'msghub-col--preset-subset',
			'msghub-col--preset-kind',
			'msghub-col--preset-level',
			'msghub-col--preset-name',
		];
		assert.equal(colgroup.children.length, columnClasses.length);
		assert.equal(thead.children[0].children.length, columnClasses.length);
		assert.equal(firstDataRow.children.length, columnClasses.length);
		for (let i = 0; i < columnClasses.length; i += 1) {
			const className = columnClasses[i];
			assert.ok(colgroup.children[i].className.includes(className));
			assert.ok(thead.children[0].children[i].className.includes(className));
			assert.ok(firstDataRow.children[i].className.includes(className));
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
		// Name is in column 5 (usage | ownedBy | subset | kind | level | name)
		assert.equal(
			rows[0].children[5].textContent,
			'My Preset Name',
			`Expected name in name column, got: ${rows[0].children[5].textContent}`,
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
		// Kind column (index 3): t() falls back to key, which contains the kind name
		assert.ok(
			rows[0].children[3].textContent.includes('task'),
			`Expected kind 'task' in kind column, got: ${rows[0].children[3].textContent}`,
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
			rows[0].children[4].textContent,
			'30',
			`Expected numeric level '30' in level column, got: ${rows[0].children[4].textContent}`,
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
			rows[0].children[4].textContent,
			'notice',
			`Expected 'notice' in level column, got: ${rows[0].children[4].textContent}`,
		);
	});

	it('usage column renders count values and keeps 0 or missing values empty', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Used', ownedBy: null, kind: 'status', level: 20, subset: null, usageCount: 3 },
					{ value: 'p2', name: 'Unused', ownedBy: null, kind: 'status', level: 20, subset: null, usageCount: 0 },
					{ value: 'p3', name: 'Unknown', ownedBy: null, kind: 'status', level: 20, subset: null, usageCount: null },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		const rows = getPresetRows(el);
		assert.equal(rows.length, 3);
		const usageByName = Object.fromEntries(rows.map(row => [row.children[5].textContent, row.children[0].textContent]));
		assert.equal(usageByName.Used, '3');
		assert.equal(usageByName.Unused, '');
		assert.equal(usageByName.Unknown, '');
	});

	// --- sort order ---

	it('renders fixed user and builtin groups with translated headings', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			t: key => {
				const map = {
					'msghub.i18n.IngestStates.admin.presets.group.user.label': 'Benutzerdefinierte Presets',
					'msghub.i18n.IngestStates.admin.presets.group.builtin.label': 'MessageHub Standard-Presets',
					'msghub.i18n.IngestStates.admin.presets.group.empty.text': 'keine entsprechenden Presets vorhanden',
				};
				return map[key] || key;
			},
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'pFree', name: 'AAA Free', source: 'user', ownedBy: null, kind: 'status', level: 20, subset: null },
					{ value: 'pOwned', name: 'ZZZ Owned', source: 'builtin', ownedBy: 'Session', kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		assert.deepEqual(getPresetGroupTitles(el), ['Benutzerdefinierte Presets', 'MessageHub Standard-Presets']);
		const rows = getPresetRows(el);
		assert.equal(rows.length, 2);
		assert.equal(rows[0].children[5].textContent, 'AAA Free');
		assert.equal(rows[1].children[5].textContent, 'ZZZ Owned');
	});

	it('renders empty group rows when one source block has no presets', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			t: key => {
				const map = {
					'msghub.i18n.IngestStates.admin.presets.group.user.label': 'Benutzerdefinierte Presets',
					'msghub.i18n.IngestStates.admin.presets.group.builtin.label': 'MessageHub Standard-Presets',
					'msghub.i18n.IngestStates.admin.presets.group.empty.text': 'keine entsprechenden Presets vorhanden',
				};
				return map[key] || key;
			},
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'pAlpha', name: 'Alpha', source: 'user', ownedBy: null, kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		const groups = getPresetGroups(el);
		assert.equal(groups.length, 2);
		const builtinRows = groups[1].children;
		assert.equal(builtinRows[0].children[0].textContent, 'MessageHub Standard-Presets');
		assert.equal(builtinRows[1].children[0].textContent, 'keine entsprechenden Presets vorhanden');
	});

	it('within user group presets keep the existing semantic sort order', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p3', name: 'Beta', source: 'user', ownedBy: 'Session', kind: 'status', level: 20, subset: 'end' },
					{ value: 'p1', name: 'Zulu', source: 'user', ownedBy: 'Alert', kind: 'status', level: 20, subset: 'core' },
					{ value: 'p4', name: 'Alpha', source: 'user', ownedBy: 'Session', kind: 'status', level: 20, subset: 'end' },
					{ value: 'p2', name: 'Alpha', source: 'user', ownedBy: 'Session', kind: 'status', level: 20, subset: 'begin' },
					{ value: 'p0', name: 'Custom', source: 'user', ownedBy: null, kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		const firstGroup = getPresetGroups(el)[0];
		const rows = firstGroup.children.filter(
			child => child?.tagName === 'TR' && String(child.className || '').includes('msghub-table-data-row'),
		);
		assert.equal(rows.length, 5);
		assert.equal(rows[0].children[5].textContent, 'Custom');
		assert.equal(rows[1].children[5].textContent, 'Zulu');
		assert.equal(rows[2].children[5].textContent, 'Alpha');
		assert.equal(rows[3].children[5].textContent, 'Alpha');
		assert.equal(rows[4].children[5].textContent, 'Beta');
	});

	it('within builtin group presets keep the existing semantic sort order', async function () {
		const sandbox = await loadPresetsModule();
		const api = makePresetsApi(sandbox, {
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p3', name: 'Beta', source: 'builtin', ownedBy: 'Session', kind: 'status', level: 20, subset: 'end' },
					{ value: 'p1', name: 'Zulu', source: 'builtin', ownedBy: 'Alert', kind: 'status', level: 20, subset: 'core' },
					{ value: 'p4', name: 'Alpha', source: 'builtin', ownedBy: 'Session', kind: 'status', level: 20, subset: 'end' },
					{ value: 'p2', name: 'Alpha', source: 'builtin', ownedBy: 'Session', kind: 'status', level: 20, subset: 'begin' },
					{ value: 'p0', name: 'Custom', source: 'builtin', ownedBy: null, kind: 'status', level: 20, subset: null },
				],
				getPreset: async () => ({ preset: null }),
			},
		});
		const el = renderTool(api);
		await settle();
		const secondGroup = getPresetGroups(el)[1];
		const rows = secondGroup.children.filter(
			child => child?.tagName === 'TR' && String(child.className || '').includes('msghub-table-data-row'),
		);
		assert.equal(rows.length, 5);
		assert.equal(rows[0].children[5].textContent, 'Custom');
		assert.equal(rows[1].children[5].textContent, 'Zulu');
		assert.equal(rows[2].children[5].textContent, 'Alpha');
		assert.equal(rows[3].children[5].textContent, 'Alpha');
		assert.equal(rows[4].children[5].textContent, 'Beta');
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
			assert.equal(rows[0].children[2].textContent, '');
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
		assert.equal(rows[0].children[2].textContent, 'Session end', 'subset column should show i18n-resolved option label');
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

	it('does not mark presets with empty ownedBy/subset as dirty on unchanged input events', async function () {
		const sandbox = await loadPresetsModule();
		let confirmCalls = 0;
		const api = makePresetsApi(sandbox, {
			formApi: makeFormApiStub(),
			confirmDialog: async () => {
				confirmCalls += 1;
				return false;
			},
			ingestStatesDataApi: {
				listPresets: async () => [
					{ value: 'p1', name: 'Preset One', source: 'user', ownedBy: null, kind: 'status', level: 20, subset: null },
					{ value: 'p2', name: 'Preset Two', source: 'user', ownedBy: null, kind: 'status', level: 20, subset: null },
				],
				getPreset: async ({ presetId }) => ({
					preset: {
						...MINIMAL_PRESET_TEMPLATE,
						schema: PRESET_SCHEMA,
						presetId,
						description: presetId === 'p1' ? 'Preset One' : 'Preset Two',
						source: 'user',
						ownedBy: '',
						subset: '',
						message: {
							...MINIMAL_PRESET_TEMPLATE.message,
							kind: 'status',
							level: 20,
							title: 'T',
							text: 'X',
						},
					},
				}),
			},
		});
		const el = renderTool(api);
		await el.__msghubReady;
		const rows = getPresetRows(el);
		rows[0].dispatchEvent({ type: 'click' });
		await settle();

		const editor = el.children[0].children[1];
		const descriptionInput = findNode(editor, node => node?.getAttribute?.('data-key') === 'description');
		assert.ok(descriptionInput, 'description input should exist');
		descriptionInput.dispatchEvent({ type: 'input' });
		await settle();

		getPresetRows(el)[1].dispatchEvent({ type: 'click' });
		await settle();

		assert.equal(confirmCalls, 0, 'unchanged empty bindings must not trigger discard confirmation');
	});
});
