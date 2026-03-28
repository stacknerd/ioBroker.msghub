/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

function createElement(tag) {
	const attrs = new Map();
	const listeners = new Map();
	const el = {
		tagName: String(tag).toUpperCase(),
		className: '',
		title: '',
		textContent: '',
		value: '',
		checked: false,
		disabled: false,
		children: [],
		setAttribute(k, v) {
			const key = String(k);
			const value = String(v);
			attrs.set(key, value);
			if (key === 'class') {
				this.className = value;
			} else if (key === 'title') {
				this.title = value;
			} else if (key === 'value') {
				this.value = value;
			} else if (key === 'checked') {
				this.checked = value === 'true';
			} else if (key === 'disabled') {
				this.disabled = value === 'true';
			}
		},
		getAttribute(k) {
			return attrs.has(String(k)) ? attrs.get(String(k)) : null;
		},
		appendChild(child) {
			this.children.push(child);
			return child;
		},
		replaceChildren(...nodes) {
			this.children = [...nodes];
		},
		addEventListener(type, handler) {
			const key = String(type);
			const list = listeners.get(key) || [];
			list.push(handler);
			listeners.set(key, list);
		},
		dispatchEvent(event) {
			const type = String(event?.type || '');
			for (const handler of listeners.get(type) || []) {
				handler.call(this, event);
			}
		},
	};
	Object.defineProperty(el, 'classList', {
		value: {
			contains(cls) {
				return String(el.className || '')
					.split(/\s+/)
					.filter(Boolean)
					.includes(String(cls));
			},
			toggle(cls, force) {
				const tokens = new Set(String(el.className || '').split(/\s+/).filter(Boolean));
				const present = tokens.has(cls);
				const next = force === undefined ? !present : !!force;
				if (next) {
					tokens.add(cls);
				} else {
					tokens.delete(cls);
				}
				el.className = Array.from(tokens).join(' ');
				return next;
			},
		},
	});
	Object.defineProperty(el, 'options', {
		get() {
			return el.tagName === 'SELECT' ? el.children.filter(child => child?.tagName === 'OPTION') : [];
		},
	});
	Object.defineProperty(el, 'selectedOptions', {
		get() {
			return el.options.filter(option => option?.selected === true);
		},
	});
	return el;
}

function createTextNode(text) {
	return {
		nodeType: 3,
		textContent: String(text),
	};
}

function createH() {
	return function h(tag, attrs, children) {
		const el = createElement(String(tag || 'div'));
		if (attrs) {
			for (const [k, v] of Object.entries(attrs)) {
				if (v === undefined || v === null) {
					continue;
				}
				if (k === 'class') {
					el.className = String(v);
				} else if (k === 'html') {
					el.innerHTML = String(v);
				} else if (k === 'text') {
					el.textContent = String(v);
				} else if (k.startsWith('on') && typeof v === 'function') {
					el.addEventListener(k.slice(2), v);
				} else {
					el.setAttribute(k, String(v));
				}
			}
		}
		if (children) {
			const list = Array.isArray(children) ? children : [children];
			for (const child of list) {
				if (child === null || child === undefined) {
					continue;
				}
				el.appendChild(typeof child === 'string' ? createTextNode(child) : child);
			}
		}
		return el;
	};
}

function collectText(node) {
	if (!node) {
		return '';
	}
	if (node.nodeType === 3) {
		return String(node.textContent || '');
	}
	const own = typeof node.textContent === 'string' ? node.textContent : '';
	return own + (Array.isArray(node.children) ? node.children.map(collectText).join('') : '');
}

function findAllByClass(node, className, out = []) {
	if (!node || typeof node !== 'object') {
		return out;
	}
	const classes = typeof node.className === 'string' ? node.className.split(/\s+/).filter(Boolean) : [];
	if (classes.includes(className)) {
		out.push(node);
	}
	for (const child of Array.isArray(node.children) ? node.children : []) {
		findAllByClass(child, className, out);
	}
	return out;
}

function findFirst(node, predicate) {
	if (!node || typeof node !== 'object') {
		return null;
	}
	if (predicate(node)) {
		return node;
	}
	for (const child of Array.isArray(node.children) ? node.children : []) {
		const found = findFirst(child, predicate);
		if (found) {
			return found;
		}
	}
	return null;
}

async function loadBundleModule() {
	const file = path.join(process.cwd(), 'lib/IngestStates/admin-ui/dist/presets.esm.js');
	let source = await fs.readFile(file, 'utf8');
	source = source.replace('export async function mount', 'async function mount');
	source = source.replace('export async function unmount', 'async function unmount');
	source += '\nmodule.exports = { mount, unmount };';
	const stripCalls = [];
	const sandbox = {
		module: { exports: {} },
		exports: {},
		document: {
			createElement,
			createTextNode,
		},
		window: {
			MsghubScrollStrip: {
				initStrip: element => {
					stripCalls.push(element);
				},
			},
		},
		console,
	};
	vm.runInNewContext(source, sandbox, { filename: 'presets.esm.js' });
	return { ...sandbox.module.exports, __stripCalls: stripCalls };
}

async function flushAsync() {
	await new Promise(resolve => setImmediate(resolve));
}

function makeCtx(options = {}) {
	const calls = [];
	const spinnerCalls = [];
	const root = createElement('div');
	const translations = {
		'msghub.i18n.core.admin.ui.action.refresh': 'Refresh',
		'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.header.text': 'Threshold Rule',
		'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.field.mode.option.gt.label': 'Zulu subset',
		'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.field.mode.option.lt.label': 'Alpha subset',
		'msghub.i18n.IngestStates.ui.presets.field.description.label': 'Display name',
		'msghub.i18n.IngestStates.ui.presets.field.schema.label': 'Schema',
		'msghub.i18n.IngestStates.ui.presets.field.ownedBy.label': 'Rule',
		'msghub.i18n.IngestStates.ui.presets.field.subset.label': 'Subset',
		'msghub.i18n.IngestStates.ui.presets.field.message.kind.label': 'Kind',
		'msghub.i18n.IngestStates.ui.presets.field.message.level.label': 'Level',
		'msghub.i18n.IngestStates.ui.presets.field.message.title.label': 'Title',
		'msghub.i18n.IngestStates.ui.presets.field.message.icon.label': 'Icon',
		'msghub.i18n.IngestStates.ui.presets.field.message.text.label': 'Text',
		'msghub.i18n.IngestStates.ui.presets.field.message.textRecovered.label': 'Text (recovered)',
		'msghub.i18n.IngestStates.ui.presets.field.message.timing.timeBudget.label': 'Time budget',
		'msghub.i18n.IngestStates.ui.presets.field.message.timing.dueIn.label': 'Due in',
		'msghub.i18n.IngestStates.ui.presets.field.message.timing.expiresIn.label': 'Expires in',
		'msghub.i18n.IngestStates.ui.presets.field.message.timing.cooldown.label': 'Cooldown',
		'msghub.i18n.IngestStates.ui.presets.field.message.timing.remindEvery.label': 'Reminder',
		'msghub.i18n.IngestStates.ui.presets.field.message.details.task.label': 'Task',
		'msghub.i18n.IngestStates.ui.presets.field.message.details.reason.label': 'Reason',
		'msghub.i18n.IngestStates.ui.presets.field.message.details.toolsCsv.label': 'Tools (CSV)',
		'msghub.i18n.IngestStates.ui.presets.field.message.details.consumablesCsv.label': 'Consumables (CSV)',
		'msghub.i18n.IngestStates.ui.presets.field.message.audience.tagsCsv.label': 'Tags (CSV)',
		'msghub.i18n.IngestStates.ui.presets.field.message.audience.channelsIncludeCsv.label': 'Channels include (CSV)',
		'msghub.i18n.IngestStates.ui.presets.field.message.audience.channelsExcludeCsv.label': 'Channels exclude (CSV)',
		'msghub.i18n.IngestStates.ui.presets.field.message.actions.label': 'Actions array',
		'msghub.i18n.IngestStates.ui.presets.field.policy.resetOnNormal.label': 'Reset on normal (auto-close)',
		'msghub.i18n.IngestStates.ui.presets.section.general.label': 'General',
		'msghub.i18n.IngestStates.ui.presets.section.message.label': 'Message',
		'msghub.i18n.IngestStates.ui.presets.section.timing.label': 'Timing',
		'msghub.i18n.IngestStates.ui.presets.section.details.label': 'Details',
		'msghub.i18n.IngestStates.ui.presets.section.audience.label': 'Audience',
		'msghub.i18n.IngestStates.ui.presets.section.policy.label': 'Policy',
		'msghub.i18n.IngestStates.ui.presets.section.actions.label': 'Actions',
		'msghub.i18n.IngestStates.ui.presets.toolbar.add.action': 'Add Preset',
		'msghub.i18n.IngestStates.ui.presets.toolbar.copy.action': 'Copy Preset',
		'msghub.i18n.IngestStates.ui.presets.toolbar.delete.action': 'Delete Preset',
		'msghub.i18n.core.admin.common.time.ms.label': 'ms',
		'msghub.i18n.core.admin.common.time.s.label': 's',
		'msghub.i18n.core.admin.common.time.min.label': 'min',
		'msghub.i18n.core.admin.common.time.h.label': 'h',
		'msghub.i18n.core.admin.common.time.d.label': 'd',
		...(options.translations || {}),
	};
	const listData = Array.isArray(options.listData)
		? options.listData
		: [
				{
					value: 'preset-user',
					source: 'user',
					ownedBy: null,
					subset: null,
					kind: 'status',
					level: 20,
					name: 'Preset User',
					usageCount: 2,
				},
				{
					value: 'preset-builtin',
					source: 'builtin',
					ownedBy: 'Threshold',
					subset: 'gt',
					kind: 'task',
					level: 30,
					name: 'Preset Builtin',
					usageCount: 0,
				},
			];
	const getData =
		typeof options.getData === 'function'
			? options.getData
			: payload => ({
					presetId: payload?.presetId,
					preset: {
						presetId: payload?.presetId,
						schema: 'msghub.IngestStatesMessagePreset.v1',
						source: 'user',
						description: 'Loaded',
						message: { kind: 'status', level: 20, title: 'T', text: 'X' },
						policy: { resetOnNormal: true },
					},
				});
	const ctx = {
		root,
		dom: {
			h: createH(),
		},
		api: {
			request: async (command, payload) => {
				calls.push({ command, payload });
				if (command === 'presets.bootstrap') {
					return {
						ok: true,
						data: {
							ingestConstants: {
								presetSchema: 'msghub.IngestStatesMessagePreset.v1',
								presetTemplate: {
									schema: 'msghub.IngestStatesMessagePreset.v1',
									presetId: '',
									description: '',
									source: 'user',
									ownedBy: null,
									subset: null,
									message: { kind: 'status', level: 20 },
									policy: { resetOnNormal: true },
								},
								presetBindingCatalog: {
									threshold: {
										ownedBy: 'Threshold',
										headerKey: 'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.header.text',
										subsets: [
											{
												value: 'gt',
												labelKey:
													'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.field.mode.option.gt.label',
											},
											{
												value: 'lt',
												labelKey:
													'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.field.mode.option.lt.label',
											},
										],
									},
								},
							},
							msgConstants: {
								kind: { status: 'status', task: 'task' },
								level: { notice: 20, warning: 30 },
							},
						},
					};
				}
				if (command === 'presets.list') {
					return {
						ok: true,
						data: listData,
					};
				}
				if (command === 'presets.get') {
					return {
						ok: true,
						data: getData(payload),
					};
				}
				if (command === 'presets.delete') {
					return { ok: true, data: { deleted: true, presetId: payload?.presetId } };
				}
				return { ok: false, error: { message: `Unexpected command ${command}` } };
				},
				i18n: {
					t: (key, ...args) => {
						const text = translations[key] ?? key;
						return args.length ? text.replace(/%s/g, () => String(args.shift())) : text;
					},
				},
			ui: {
				toast: () => {},
				spinner: {
					show: opts => {
						spinnerCalls.push({ type: 'show', opts });
						return opts?.id || 'spinner-1';
					},
					hide: id => {
						spinnerCalls.push({ type: 'hide', id });
					},
				},
				dialog: {
					confirm: async () => true,
				},
			},
		},
	};
	return { ctx, calls, spinnerCalls };
}

describe('presets.esm.js', () => {
	it('mounts the toolbar above the grid and initializes the strip wrapper', async () => {
		const mod = await loadBundleModule();
		const { ctx, calls } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		assert.deepEqual(
			calls.map(call => call.command),
			['presets.bootstrap', 'presets.list'],
		);

		assert.equal(ctx.root.children.length, 2);
		assert.equal(ctx.root.children[0].classList.contains('msghub-toolbar'), true);
		assert.equal(ctx.root.children[0].classList.contains('msghub-tools-presets-toolbar'), true);
		assert.equal(ctx.root.children[1].classList.contains('msghub-tools-presets-grid'), true);
		assert.equal(mod.__stripCalls.length, 1);
		assert.equal(mod.__stripCalls[0], ctx.root.children[0]);

		const toolbarText = collectText(ctx.root.children[0]);
		assert.match(toolbarText, /Add Preset/);
		assert.match(toolbarText, /Copy Preset/);
		assert.match(toolbarText, /Delete Preset/);
		const copyButton = findFirst(ctx.root, node => node?.classList?.contains('msghub-tools-presets-toolbar-copy'));
		const deleteButton = findFirst(ctx.root, node => node?.classList?.contains('msghub-tools-presets-toolbar-delete'));
		assert.equal(copyButton?.disabled, true);
		assert.equal(deleteButton?.disabled, true);
	});

	it('renders grouped preset rows from bootstrap + list', async () => {
		const mod = await loadBundleModule();
		const { ctx } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const tables = findAllByClass(ctx.root, 'msghub-presets-table');
		assert.equal(tables.length, 1);
		const selectCells = findAllByClass(ctx.root, 'msghub-tools-presets-select');
		assert.equal(selectCells.length, 2);
		const text = collectText(ctx.root);
		assert.match(text, /Preset User/);
		assert.match(text, /Preset Builtin/);
		assert.match(text, /msghub\.i18n\.IngestStates\.ui\.presets\.group\.user\.label/);
		assert.match(text, /msghub\.i18n\.IngestStates\.ui\.presets\.group\.builtin\.label/);
	});

	it('sorts rows by translated display labels for ownedBy and subset', async () => {
		const mod = await loadBundleModule();
		const { ctx } = makeCtx({
			listData: [
				{
					value: 'preset-zulu',
					source: 'builtin',
					ownedBy: 'Threshold',
					subset: 'gt',
					kind: 'status',
					level: 20,
					name: 'Zulu preset',
					usageCount: 0,
				},
				{
					value: 'preset-alpha',
					source: 'builtin',
					ownedBy: 'Threshold',
					subset: 'lt',
					kind: 'status',
					level: 20,
					name: 'Alpha preset',
					usageCount: 0,
				},
			],
		});

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const rows = findAllByClass(ctx.root, 'msghub-table-data-row');
		assert.equal(rows.length, 2);
		assert.match(collectText(rows[0]), /Alpha preset/);
		assert.match(collectText(rows[1]), /Zulu preset/);
	});

	it('marks a clicked row as selected after loading the full preset', async () => {
		const mod = await loadBundleModule();
		const { ctx, calls } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const rows = findAllByClass(ctx.root, 'msghub-table-data-row');
		assert.equal(rows.length, 2);

		rows[0].dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		assert.equal(calls[calls.length - 1].command, 'presets.get');
		const selectedRows = findAllByClass(ctx.root, 'is-selected');
		assert.equal(selectedRows.length, 1);
		assert.match(collectText(selectedRows[0]), /Preset User/);
		const selectedCheckbox = findFirst(
			selectedRows[0],
			node => node?.tagName === 'INPUT' && node?.classList?.contains('msghub-uicheckbox__input'),
		);
		assert.equal(selectedCheckbox?.checked, true);
		const copyButton = findFirst(ctx.root, node => node?.classList?.contains('msghub-tools-presets-toolbar-copy'));
		const deleteButton = findFirst(ctx.root, node => node?.classList?.contains('msghub-tools-presets-toolbar-delete'));
		assert.equal(copyButton?.disabled, false);
		assert.equal(deleteButton?.disabled, false);
	});

	it('prefers editorPreset for readonly builtin editor rendering', async () => {
		const mod = await loadBundleModule();
		const { ctx } = makeCtx({
			getData: payload => ({
				presetId: payload?.presetId,
				preset: {
					presetId: payload?.presetId,
					schema: 'msghub.IngestStatesMessagePreset.v1',
					source: 'builtin',
					description: 'Builtin raw',
					message: {
						kind: 'status',
						level: 20,
						title: 'msghub.i18n.IngestStates.msg.threshold.gt.title',
						text: 'msghub.i18n.IngestStates.msg.threshold.gt.text',
					},
					policy: { resetOnNormal: true },
				},
				editorPreset: {
					presetId: payload?.presetId,
					schema: 'msghub.IngestStatesMessagePreset.v1',
					source: 'builtin',
					description: 'Builtin raw',
					message: {
						kind: 'status',
						level: 20,
						title: 'Translated title',
						text: 'Translated text',
					},
					policy: { resetOnNormal: true },
				},
			}),
		});

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const rows = findAllByClass(ctx.root, 'msghub-table-data-row');
		assert.equal(rows.length, 2);

		rows[1].dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		const translatedTitleInput = findFirst(
			ctx.root,
			node => node?.tagName === 'INPUT' && node?.value === 'Translated title',
		);
		const rawTitleInput = findFirst(
			ctx.root,
			node => node?.tagName === 'INPUT' && node?.value === 'msghub.i18n.IngestStates.msg.threshold.gt.title',
		);
		const translatedTextArea = findFirst(
			ctx.root,
			node => node?.tagName === 'TEXTAREA' && node?.value === 'Translated text',
		);

		assert.ok(translatedTitleInput, 'editor should render translated builtin title');
		assert.equal(rawTitleInput, null);
		assert.ok(translatedTextArea, 'editor should render translated builtin text');
	});

	it('renders timing values in readable units and recalculates on unit changes', async () => {
		const mod = await loadBundleModule();
		const { ctx } = makeCtx({
			getData: payload => ({
				presetId: payload?.presetId,
				preset: {
					presetId: payload?.presetId,
					schema: 'msghub.IngestStatesMessagePreset.v1',
					source: 'user',
					description: 'Loaded',
					message: {
						kind: 'status',
						level: 20,
						title: 'T',
						text: 'X',
						timing: { dueInMs: 60000 },
					},
					policy: { resetOnNormal: true },
				},
			}),
		});

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const rows = findAllByClass(ctx.root, 'msghub-table-data-row');
		assert.equal(rows.length, 2);
		rows[0].dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		const dueInRow = findFirst(ctx.root, node => node?.getAttribute?.('data-row-key') === 'timing_dueInMs');
		assert.ok(dueInRow, 'dueIn row should exist');
		const dueInInput = findFirst(dueInRow, node => node?.tagName === 'INPUT' && node?.getAttribute?.('type') === 'number');
		const dueInSelect = findFirst(dueInRow, node => node?.tagName === 'SELECT' && node?.classList?.contains('msghub-time-unit'));
		assert.ok(dueInInput, 'dueIn numeric input should exist');
		assert.ok(dueInSelect, 'dueIn unit select should exist');

		assert.equal(dueInSelect.value, 'min');
		assert.equal(dueInInput.value, '1');

		dueInSelect.value = 's';
		dueInSelect.dispatchEvent({ type: 'change' });

		assert.equal(dueInInput.value, '60');
	});

	it('supports days as a timing unit for full-day values', async () => {
		const mod = await loadBundleModule();
		const { ctx } = makeCtx({
			getData: payload => ({
				presetId: payload?.presetId,
				preset: {
					presetId: payload?.presetId,
					schema: 'msghub.IngestStatesMessagePreset.v1',
					source: 'user',
					description: 'Loaded',
					message: {
						kind: 'status',
						level: 20,
						title: 'T',
						text: 'X',
						timing: { expiresInMs: 2 * 24 * 60 * 60 * 1000 },
					},
					policy: { resetOnNormal: true },
				},
			}),
		});

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const rows = findAllByClass(ctx.root, 'msghub-table-data-row');
		assert.equal(rows.length, 2);
		rows[0].dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		const expiresRow = findFirst(ctx.root, node => node?.getAttribute?.('data-row-key') === 'timing_expiresInMs');
		assert.ok(expiresRow, 'expires row should exist');
		const expiresInput = findFirst(
			expiresRow,
			node => node?.tagName === 'INPUT' && node?.getAttribute?.('type') === 'number',
		);
		const expiresSelect = findFirst(
			expiresRow,
			node => node?.tagName === 'SELECT' && node?.classList?.contains('msghub-time-unit'),
		);

		assert.ok(expiresInput, 'expires numeric input should exist');
		assert.ok(expiresSelect, 'expires unit select should exist');
		assert.equal(expiresSelect.value, 'd');
		assert.equal(expiresInput.value, '2');

		expiresSelect.value = 'h';
		expiresSelect.dispatchEvent({ type: 'change' });

		assert.equal(expiresInput.value, '48');
	});

	it('reload button keeps using the spinner path instead of hard list replacement semantics', async () => {
		const mod = await loadBundleModule();
		const { ctx, calls, spinnerCalls } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const reloadButton = findFirst(ctx.root, node => node?.classList?.contains('msghub-tools-presets-toolbar-refresh'));
		assert.ok(reloadButton, 'reload button exists');

		reloadButton.dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		assert.equal(
			calls.filter(call => call.command === 'presets.list').length,
			2,
			'reload should trigger a second list RPC',
		);
		assert.deepEqual(
			spinnerCalls.map(call => call.type),
			['show', 'hide'],
		);
	});

	it('renders the editor sections after selecting a preset row', async () => {
		const mod = await loadBundleModule();
		const { ctx } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const rows = findAllByClass(ctx.root, 'msghub-table-data-row');
		assert.equal(rows.length, 2);

		rows[0].dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		const sections = findAllByClass(ctx.root, 'msghub-preset-editor-section');
		assert.equal(sections.length, 7);
		const text = collectText(ctx.root);
		assert.match(text, /General/);
		assert.match(text, /Message/);
		assert.match(text, /Timing/);
		assert.match(text, /Details/);
		assert.match(text, /Audience/);
		assert.match(text, /Policy/);
		assert.match(text, /Actions/);
		assert.match(text, /Display name/);
		assert.match(text, /Text \(recovered\)/);
	});
});
