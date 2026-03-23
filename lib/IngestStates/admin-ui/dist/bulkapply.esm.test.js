/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

// ── Mock DOM helpers (verbatim from presets.esm.test.js) ─────────────────────

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
	const classes =
		typeof node.className === 'string' ? node.className.split(/\s+/).filter(Boolean) : [];
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

// ── Bundle loader ─────────────────────────────────────────────────────────────

/**
 * Load the bulkapply ESM bundle into a vm sandbox.
 *
 * Strips the `export` keywords, appends a CommonJS module.exports shim,
 * and runs the source in a new vm context.  An optional localStorage mock
 * can be injected to test persistence behaviour.
 *
 * @param {object} [localStorageMock] Optional localStorage stub with getItem/setItem.
 * @returns {Promise<{ mount: Function, unmount: Function }>} Exported bundle functions.
 */
async function loadBundleModule(localStorageMock) {
	const file = path.join(process.cwd(), 'lib/IngestStates/admin-ui/dist/bulkapply.esm.js');
	let source = await fs.readFile(file, 'utf8');
	source = source.replace('export async function mount', 'async function mount');
	source = source.replace('export async function unmount', 'async function unmount');
	source += '\nmodule.exports = { mount, unmount };';
	const sandbox = {
		module: { exports: {} },
		exports: {},
		document: { createElement, createTextNode },
		console,
	};
	if (localStorageMock) {
		sandbox.localStorage = localStorageMock;
	}
	vm.runInNewContext(source, sandbox, { filename: 'bulkapply.esm.js' });
	return sandbox.module.exports;
}

/** Drain the microtask queue so all pending promises can resolve. */
async function flushAsync() {
	await new Promise(resolve => setImmediate(resolve));
}

// ── Context factory ───────────────────────────────────────────────────────────

/**
 * Build a minimal host context for the bulk apply bundle.
 *
 * @param {object} [overrides] Optional overrides.
 * @param {Function} [overrides.request] Custom request handler.
 * @param {Function} [overrides.confirmDialog] Custom confirm dialog handler.
 * @returns {{ ctx: object, calls: Array, spinnerCalls: Array, toastCalls: Array }}
 */
function makeCtx(overrides = {}) {
	const calls = [];
	const spinnerCalls = [];
	const toastCalls = [];
	const root = createElement('div');

	const defaultRequest = async (command, payload) => {
		calls.push({ command, payload });
		if (command === 'bulkapply.bootstrap') {
			return {
				ok: true,
				data: {
					namespace: 'msghub.0.IngestStates.0',
					jsonCustomDefaults: { foo: 'bar' },
				},
			};
		}
		if (command === 'bulkapply.configRead') {
			return {
				ok: true,
				data: { custom: { myKey: 'myValue' } },
			};
		}
		if (command === 'bulkapply.preview') {
			return {
				ok: true,
				data: {
					pattern: payload?.pattern,
					totalObjects: 10,
					matchedStates: 5,
					willChange: 3,
					unchanged: 2,
					sample: [
						{ id: 'state.1', changed: true },
						{ id: 'state.2', changed: false },
					],
				},
			};
		}
		if (command === 'bulkapply.apply') {
			return { ok: true, data: { errors: [] } };
		}
		return { ok: false, error: { message: `Unexpected command: ${command}` } };
	};

	const ctx = {
		root,
		dom: { h: createH() },
		api: {
			request: overrides.request ?? defaultRequest,
			i18n: {
				t: (key, ...args) => (args.length ? `${key}:${args.join(',')}` : key),
			},
			ui: {
				toast: msg => toastCalls.push(msg),
				spinner: {
					show: opts => {
						spinnerCalls.push({ type: 'show', opts });
						return opts?.id ?? 'spinner-1';
					},
					hide: id => spinnerCalls.push({ type: 'hide', id }),
				},
				dialog: { confirm: overrides.confirmDialog ?? (async () => true) },
			},
		},
	};

	return { ctx, calls, spinnerCalls, toastCalls };
}

// ── Test helper ───────────────────────────────────────────────────────────────

/**
 * Mount the bundle into the given ctx and drive it to a state where a preview
 * result with willChange > 0 is present.  Uses generateEmpty to fill the
 * custom JSON field so the test does not depend on a specific textarea value.
 *
 * @param {object} ctx Host context produced by makeCtx().
 * @returns {Promise<{ mount: Function, unmount: Function }>} Loaded bundle module.
 */
async function mountWithPreview(ctx) {
	const mod = await loadBundleModule();
	await mod.mount(ctx);
	await ctx.root.__msghubReady;

	// Fill pattern field.
	const patternInput = findFirst(
		ctx.root,
		n => n?.tagName === 'INPUT' && n?.getAttribute?.('id') === 'msghub-bulk-pattern',
	);
	patternInput.dispatchEvent({ type: 'input', target: { value: 'msghub.0.IngestStates.*' } });

	// Fill custom JSON via generate-empty (synchronous — no flush needed).
	const btnGenerate = findFirst(
		ctx.root,
		n => n?.tagName === 'BUTTON' && n?.textContent === 'Generate empty config',
	);
	btnGenerate.dispatchEvent({ type: 'click' });

	// Run preview.
	const btnPreview = findFirst(
		ctx.root,
		n => n?.tagName === 'BUTTON' && n?.textContent === 'Preview',
	);
	btnPreview.dispatchEvent({ type: 'click' });
	await flushAsync();
	await flushAsync();

	return mod;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('bulkapply.esm.js', () => {
	// ── Happy Path ────────────────────────────────────────────────────────────

	it('mount renders four section headings', async () => {
		const mod = await loadBundleModule();
		const { ctx } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const headings = findAllByClass(ctx.root, 'msghub-bulk-section-head');
		assert.equal(headings.length, 4);
	});

	it('bootstrap RPC is called on mount', async () => {
		const mod = await loadBundleModule();
		const { ctx, calls } = makeCtx();

		await mod.mount(ctx);

		assert.equal(calls[0]?.command, 'bulkapply.bootstrap');
	});

	it('load calls configRead and fills textarea with the object custom config', async () => {
		const mod = await loadBundleModule();
		const { ctx, calls } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const inputSourceId = findFirst(
			ctx.root,
			n => n?.tagName === 'INPUT' && n?.getAttribute?.('id') === 'msghub-bulk-sourceId',
		);
		inputSourceId.dispatchEvent({ type: 'input', target: { value: 'my-object-id' } });

		const btnLoad = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Load config from object',
		);
		btnLoad.dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		assert.ok(
			calls.some(c => c.command === 'bulkapply.configRead' && c.payload?.id === 'my-object-id'),
		);
		const textarea = findFirst(ctx.root, n => n?.tagName === 'TEXTAREA');
		assert.ok(textarea.value.includes('myKey'), 'textarea value contains loaded key');
	});

	it('generate empty fills textarea with default JSON from bootstrap', async () => {
		const mod = await loadBundleModule();
		const { ctx } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const btnGenerate = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Generate empty config',
		);
		btnGenerate.dispatchEvent({ type: 'click' });

		const textarea = findFirst(ctx.root, n => n?.tagName === 'TEXTAREA');
		assert.equal(textarea.value, JSON.stringify({ foo: 'bar' }, null, 2));
	});

	it('preview calls preview RPC and renders counts and sample ids', async () => {
		const mod = await loadBundleModule();
		const { ctx, calls } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const patternInput = findFirst(
			ctx.root,
			n => n?.tagName === 'INPUT' && n?.getAttribute?.('id') === 'msghub-bulk-pattern',
		);
		patternInput.dispatchEvent({ type: 'input', target: { value: 'msghub.0.*' } });

		const btnGenerate = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Generate empty config',
		);
		btnGenerate.dispatchEvent({ type: 'click' });

		const btnPreview = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Preview',
		);
		btnPreview.dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		assert.ok(calls.some(c => c.command === 'bulkapply.preview'));
		const previewContainer = findFirst(ctx.root, n => n?.className === 'msghub-bulk-preview');
		const text = collectText(previewContainer);
		// matchedStates=5, totalObjects=10, sample id
		assert.match(text, /5/);
		assert.match(text, /10/);
		assert.match(text, /state\.1/);
	});

	it('apply button is disabled before any preview', async () => {
		const mod = await loadBundleModule();
		const { ctx } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const btnApply = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Apply',
		);
		assert.equal(btnApply.disabled, true);
	});

	it('apply button is enabled after preview with willChange > 0', async () => {
		const { ctx } = makeCtx();
		await mountWithPreview(ctx);

		const btnApply = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Apply',
		);
		assert.equal(btnApply.disabled, false);
	});

	it('apply → confirm → apply RPC called → success toast shown', async () => {
		const { ctx, calls, toastCalls } = makeCtx();
		await mountWithPreview(ctx);

		const btnApply = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Apply',
		);
		btnApply.dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		assert.ok(calls.some(c => c.command === 'bulkapply.apply'), 'apply RPC was called');
		assert.ok(
			toastCalls.some(t => !t.variant),
			'success toast shown (no danger variant)',
		);
	});

	it('localStorage is written after state change', async () => {
		const stored = {};
		const lsMock = {
			setItem(k, v) {
				stored[k] = v;
			},
			getItem(k) {
				return Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : null;
			},
		};
		const mod = await loadBundleModule(lsMock);
		const { ctx } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const inputSourceId = findFirst(
			ctx.root,
			n => n?.tagName === 'INPUT' && n?.getAttribute?.('id') === 'msghub-bulk-sourceId',
		);
		inputSourceId.dispatchEvent({ type: 'input', target: { value: 'test-id' } });

		const expectedKey = 'msghub.bulkApply.msghub.0.IngestStates.0';
		assert.ok(
			Object.prototype.hasOwnProperty.call(stored, expectedKey),
			'localStorage.setItem called with expected key',
		);
		const parsed = JSON.parse(stored[expectedKey]);
		assert.equal(parsed.sourceId, 'test-id');
	});

	// ── Boundary ──────────────────────────────────────────────────────────────

	it('apply button stays disabled when willChange = 0', async () => {
		const { ctx } = makeCtx({
			request: async (command, payload) => {
				if (command === 'bulkapply.bootstrap') {
					return { ok: true, data: { namespace: 'ns', jsonCustomDefaults: {} } };
				}
				if (command === 'bulkapply.preview') {
					return {
						ok: true,
						data: {
							pattern: payload?.pattern,
							totalObjects: 10,
							matchedStates: 5,
							willChange: 0,
							unchanged: 5,
							sample: [],
						},
					};
				}
				return { ok: false, error: { message: `Unexpected: ${command}` } };
			},
		});

		const mod = await loadBundleModule();
		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const patternInput = findFirst(
			ctx.root,
			n => n?.tagName === 'INPUT' && n?.getAttribute?.('id') === 'msghub-bulk-pattern',
		);
		patternInput.dispatchEvent({ type: 'input', target: { value: 'msghub.*' } });

		// jsonCustomDefaults: {} -> JSON.stringify({}, null, 2) = '{}' -> valid object
		const btnGenerate = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Generate empty config',
		);
		btnGenerate.dispatchEvent({ type: 'click' });

		const btnPreview = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Preview',
		);
		btnPreview.dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		const btnApply = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Apply',
		);
		assert.equal(btnApply.disabled, true, 'apply disabled when willChange = 0');
	});

	it('apply button is disabled after successful apply (preview result cleared)', async () => {
		const { ctx } = makeCtx();
		await mountWithPreview(ctx);

		const btnApply = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Apply',
		);
		assert.equal(btnApply.disabled, false, 'apply enabled before apply');

		btnApply.dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		assert.equal(btnApply.disabled, true, 'apply disabled after successful apply (preview cleared)');
	});

	it('partial apply errors → danger toast shown, no plain success toast', async () => {
		const { ctx, toastCalls } = makeCtx({
			request: async (command, payload) => {
				if (command === 'bulkapply.bootstrap') {
					return { ok: true, data: { namespace: 'ns', jsonCustomDefaults: { a: 1 } } };
				}
				if (command === 'bulkapply.preview') {
					return {
						ok: true,
						data: {
							pattern: payload?.pattern,
							totalObjects: 5,
							matchedStates: 3,
							willChange: 3,
							unchanged: 0,
							sample: [{ id: 's1', changed: true }],
						},
					};
				}
				if (command === 'bulkapply.apply') {
					return { ok: true, data: { errors: [{ id: 's1', message: 'write failed' }] } };
				}
				return { ok: false, error: { message: `Unexpected: ${command}` } };
			},
		});

		await mountWithPreview(ctx);

		const btnApply = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Apply',
		);
		btnApply.dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		assert.ok(
			toastCalls.some(t => t.variant === 'danger'),
			'danger toast shown when apply has partial errors',
		);
		assert.ok(
			!toastCalls.some(t => !t.variant),
			'no plain success toast when apply has partial errors',
		);
	});

	// ── Invalid Input ─────────────────────────────────────────────────────────

	it('load with empty sourceId → configRead RPC not called', async () => {
		const mod = await loadBundleModule();
		const { ctx, calls } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		// sourceId is empty by default — click load without setting it
		const btnLoad = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Load config from object',
		);
		btnLoad.dispatchEvent({ type: 'click' });
		await flushAsync();

		assert.ok(
			!calls.some(c => c.command === 'bulkapply.configRead'),
			'configRead RPC not called for empty sourceId',
		);
	});

	it('preview with empty pattern → preview RPC not called', async () => {
		const mod = await loadBundleModule();
		const { ctx, calls } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		// Fill customJson but leave pattern empty
		const btnGenerate = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Generate empty config',
		);
		btnGenerate.dispatchEvent({ type: 'click' });

		const btnPreview = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Preview',
		);
		btnPreview.dispatchEvent({ type: 'click' });
		await flushAsync();

		assert.ok(
			!calls.some(c => c.command === 'bulkapply.preview'),
			'preview RPC not called for empty pattern',
		);
	});

	it('preview with invalid JSON in textarea → preview RPC not called', async () => {
		const mod = await loadBundleModule();
		const { ctx, calls } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const patternInput = findFirst(
			ctx.root,
			n => n?.tagName === 'INPUT' && n?.getAttribute?.('id') === 'msghub-bulk-pattern',
		);
		patternInput.dispatchEvent({ type: 'input', target: { value: 'msghub.*' } });

		// Inject invalid JSON into the textarea via oninput
		const textarea = findFirst(ctx.root, n => n?.tagName === 'TEXTAREA');
		textarea.dispatchEvent({ type: 'input', target: { value: 'NOT_VALID_JSON{{{' } });

		const btnPreview = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Preview',
		);
		btnPreview.dispatchEvent({ type: 'click' });
		await flushAsync();

		assert.ok(
			!calls.some(c => c.command === 'bulkapply.preview'),
			'preview RPC not called for invalid JSON',
		);
	});

	// ── Error Path ────────────────────────────────────────────────────────────

	it('bootstrap RPC failure → error node rendered in root', async () => {
		const mod = await loadBundleModule();
		const { ctx } = makeCtx({
			request: async () => ({ ok: false, error: { message: 'Bootstrap error' } }),
		});

		await mod.mount(ctx);

		const errorNode = findFirst(ctx.root, n => n?.className === 'msghub-error');
		assert.ok(errorNode, 'error node present in root after bootstrap failure');
	});

	it('configRead RPC error → error toast shown', async () => {
		const mod = await loadBundleModule();
		const { ctx, toastCalls } = makeCtx({
			request: async command => {
				if (command === 'bulkapply.bootstrap') {
					return { ok: true, data: { namespace: 'ns', jsonCustomDefaults: {} } };
				}
				return { ok: false, error: { message: 'Config read failed' } };
			},
		});

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const inputSourceId = findFirst(
			ctx.root,
			n => n?.tagName === 'INPUT' && n?.getAttribute?.('id') === 'msghub-bulk-sourceId',
		);
		inputSourceId.dispatchEvent({ type: 'input', target: { value: 'some-id' } });

		const btnLoad = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Load config from object',
		);
		btnLoad.dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		assert.ok(toastCalls.some(t => t.variant === 'danger'), 'danger toast shown on configRead error');
	});

	it('preview RPC error → apply button stays disabled', async () => {
		const mod = await loadBundleModule();
		const { ctx } = makeCtx({
			request: async command => {
				if (command === 'bulkapply.bootstrap') {
					return { ok: true, data: { namespace: 'ns', jsonCustomDefaults: { x: 1 } } };
				}
				return { ok: false, error: { message: 'Preview failed' } };
			},
		});

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const patternInput = findFirst(
			ctx.root,
			n => n?.tagName === 'INPUT' && n?.getAttribute?.('id') === 'msghub-bulk-pattern',
		);
		patternInput.dispatchEvent({ type: 'input', target: { value: 'msghub.*' } });

		const btnGenerate = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Generate empty config',
		);
		btnGenerate.dispatchEvent({ type: 'click' });

		const btnPreview = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Preview',
		);
		btnPreview.dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		const btnApply = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Apply',
		);
		assert.equal(btnApply.disabled, true, 'apply disabled after preview RPC error');
	});

	it('apply RPC error → error toast shown', async () => {
		const { ctx, toastCalls } = makeCtx({
			request: async (command, payload) => {
				if (command === 'bulkapply.bootstrap') {
					return { ok: true, data: { namespace: 'ns', jsonCustomDefaults: { a: 1 } } };
				}
				if (command === 'bulkapply.preview') {
					return {
						ok: true,
						data: {
							pattern: payload?.pattern,
							totalObjects: 5,
							matchedStates: 3,
							willChange: 3,
							unchanged: 0,
							sample: [{ id: 's1', changed: true }],
						},
					};
				}
				if (command === 'bulkapply.apply') {
					return { ok: false, error: { message: 'Apply failed' } };
				}
				return { ok: false, error: { message: `Unexpected: ${command}` } };
			},
		});

		await mountWithPreview(ctx);

		const btnApply = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Apply',
		);
		btnApply.dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		assert.ok(toastCalls.some(t => t.variant === 'danger'), 'danger toast shown on apply RPC error');
	});

	// ── Async / Timing ────────────────────────────────────────────────────────

	it('load button is disabled while configRead is in flight and re-enabled after', async () => {
		let resolveConfigRead;
		// This promise keeps the configRead call suspended until we resolve it.
		const configReadPending = new Promise(resolve => {
			resolveConfigRead = resolve;
		});

		const mod = await loadBundleModule();
		const { ctx } = makeCtx({
			request: async command => {
				if (command === 'bulkapply.bootstrap') {
					return { ok: true, data: { namespace: 'ns', jsonCustomDefaults: {} } };
				}
				if (command === 'bulkapply.configRead') {
					return configReadPending;
				}
				return { ok: false, error: { message: 'unexpected' } };
			},
		});

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		const inputSourceId = findFirst(
			ctx.root,
			n => n?.tagName === 'INPUT' && n?.getAttribute?.('id') === 'msghub-bulk-sourceId',
		);
		inputSourceId.dispatchEvent({ type: 'input', target: { value: 'test-id' } });

		const btnLoad = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Load config from object',
		);

		// Click fires loadConfig() synchronously up to its first await.
		// setBusy(true) + renderAll() run before that await — button is disabled immediately.
		btnLoad.dispatchEvent({ type: 'click' });
		assert.equal(btnLoad.disabled, true, 'load button disabled while in flight');

		// Resolve the pending RPC so the finally block can run.
		resolveConfigRead({ ok: true, data: { custom: {} } });
		await flushAsync();
		await flushAsync();

		assert.equal(btnLoad.disabled, false, 'load button re-enabled after completion');
	});

	it('confirm cancel → apply RPC not called', async () => {
		const { ctx, calls } = makeCtx({ confirmDialog: async () => false });
		await mountWithPreview(ctx);

		const btnApply = findFirst(
			ctx.root,
			n => n?.tagName === 'BUTTON' && n?.textContent === 'Apply',
		);
		btnApply.dispatchEvent({ type: 'click' });
		await flushAsync();
		await flushAsync();

		assert.ok(
			!calls.some(c => c.command === 'bulkapply.apply'),
			'apply RPC not called when user cancels the confirm dialog',
		);
	});

	it('unmount clears the root', async () => {
		const mod = await loadBundleModule();
		const { ctx } = makeCtx();

		await mod.mount(ctx);
		await ctx.root.__msghubReady;

		assert.ok(ctx.root.children.length > 0, 'root has content after mount');

		await mod.unmount(ctx);
		assert.equal(ctx.root.children.length, 0, 'root is cleared after unmount');
	});
});
