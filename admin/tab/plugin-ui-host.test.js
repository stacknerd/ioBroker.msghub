/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRepoFile } = require('./_test.utils');

// Creates a minimal DOM element mock with attribute and child support.
function createElement(tag) {
	const attrs = new Map();
	return {
		tagName: String(tag).toUpperCase(),
		textContent: '',
		children: [],
		setAttribute(k, v) {
			attrs.set(String(k), String(v));
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
	};
}

// Creates a plain container div mock — no Shadow DOM; plugin panels use Light DOM.
function createContainer() {
	return createElement('div');
}

function createH() {
	return function h(tag, attrs, children) {
		const el = createElement(tag);
		if (attrs) {
			for (const [k, v] of Object.entries(attrs)) {
				if (v === undefined || v === null) {
					continue;
				}
				if (k === 'class') {
					el.className = v;
				} else if (k === 'html') {
					el.innerHTML = v;
				} else if (k === 'text') {
					el.textContent = v;
				} else if (k.startsWith('on') && typeof v === 'function') {
					el.addEventListener?.(k.slice(2), v);
				} else {
					el.setAttribute(k, String(v));
				}
			}
		}
		if (children) {
			const list = Array.isArray(children) ? children : [children];
			for (const c of list) {
				if (c === null || c === undefined) {
					continue;
				}
				el.appendChild(typeof c === 'string' ? { nodeType: 3, textContent: c } : c);
			}
		}
		return el;
	};
}

/**
 * Loads plugin-ui-host.js in an isolated VM context and returns the factory.
 * mergeI18nCalls records every mergePluginI18n(pluginType, translations) invocation.
 * sandbox is exposed so tests can mutate sandbox.lang between mount() calls.
 *
 * @param {{ lang?: string }} [opts]
 * @returns {Promise<{ createHost: Function, mergeI18nCalls: Array, sandbox: object }>}
 */
async function loadHostSandbox({ lang: sandboxLang = 'en' } = {}) {
	const source = await readRepoFile('admin/tab/plugin-ui-host.js');
	const windowObject = {};
	const documentObject = {
		createElement: tag => createElement(tag),
	};
	const mergeI18nCalls = [];
	const sandbox = {
		window: windowObject,
		document: documentObject,
		lang: sandboxLang,
		t: key => key,
		h: createH(),
		mergePluginI18n: (pluginType, translations) => mergeI18nCalls.push({ pluginType, translations }),
		Blob: class {
			constructor(parts, opts) {
				this.parts = parts;
				this.type = opts?.type;
			}
		},
		URL: {
			createObjectURL: () => 'blob:test-url',
			revokeObjectURL: () => {},
		},
	};
	vm.runInNewContext(source, sandbox, { filename: 'admin/tab/plugin-ui-host.js' });
	const createHost = sandbox.window.createMsghubPluginUiHost;
	return { createHost, mergeI18nCalls, sandbox };
}

// Sentinel: distinguishes "rpcResponse not provided" from an explicit response object.
// Using an object default lets TypeScript infer rpcResponse as {} (accepts any object).
const _noRpcResponse = {};

// Builds a request stub that serves bundle.get and optionally rpc.
// i18n defaults to null (not present) to reflect the common no-i18n case.
function makeRequest({ hash = 'test-hash', js = 'export function mount(){}', css = null, i18n = null, rpcResponse = _noRpcResponse } = {}) {
	const calls = [];
	const fn = async (cmd, payload) => {
		calls.push({ cmd, payload });
		if (cmd === 'admin.pluginUi.bundle.get') {
			// msghubRequest resolves with res.data directly — return raw payload, not {ok,data} envelope.
			return { hash, js, css, i18n };
		}
		if (cmd === 'admin.pluginUi.rpc') {
			// Same transport convention: return raw data; ctx.api.request wraps it into {ok,data}.
			return rpcResponse !== _noRpcResponse ? rpcResponse : {};
		}
		return { ok: false, error: { message: 'unexpected command' } };
	};
	fn.calls = calls;
	return fn;
}

describe('admin/tab/plugin-ui-host.js', function () {
	it('exposes createMsghubPluginUiHost on window', async function () {
		const { createHost } = await loadHostSandbox();
		assert.equal(typeof createHost, 'function');
	});

	it('factory returns mount, unmount, and retry', async function () {
		const { createHost } = await loadHostSandbox();
		const host = createHost({ request: makeRequest(), api: {}, _importFn: async () => ({}) });
		assert.equal(typeof host.mount, 'function');
		assert.equal(typeof host.unmount, 'function');
		assert.equal(typeof host.retry, 'function');
	});

	describe('mount()', function () {
		it('fetches bundle, mounts module, returns mounted handle', async function () {
			const { createHost } = await loadHostSandbox();
			const container = createContainer();
			const request = makeRequest({ hash: 'h1' });
			const mountArgs = [];
			const mockModule = { mount: async ctx => { mountArgs.push(ctx); } };

			const host = createHost({
				request,
				api: {
					host: { adapterInstance: 'msghub.0' },
					i18n: { t: (k, ...args) => [k, ...args].join(':') },
					ui: {},
				},
				_importFn: async () => mockModule,
			});

			const handle = await host.mount({
				container,
				pluginType: 'IngestStates',
				instanceId: '0',
				panelId: 'presets',
				hash: '',
			});

			assert.equal(request.calls.length, 1);
			assert.equal(request.calls[0].cmd, 'admin.pluginUi.bundle.get');
			// JSON round-trip strips VM-realm prototype so deepEqual works across realms.
			assert.deepEqual(JSON.parse(JSON.stringify(request.calls[0].payload)), {
				pluginType: 'IngestStates',
				instanceId: '0',
				panelId: 'presets',
				lang: 'en',
			});

			assert.equal(mountArgs.length, 1);
			assert.equal(mountArgs[0].plugin.type, 'IngestStates');
			assert.equal(mountArgs[0].plugin.instanceId, '0');
			assert.equal(mountArgs[0].panel.id, 'presets');
			assert.equal(mountArgs[0].host.adapterInstance, 'msghub.0');
			assert.equal(mountArgs[0].host.uiTextLanguage, 'en');
			assert.equal(
				mountArgs[0].api.i18n.t('msghub.i18n.core.admin.ui.loadingWithSubject.text', 'Vorlagen'),
				"msghub.i18n.core.admin.ui.loadingWithSubject.text:Vorlagen",
			);
			assert.equal(typeof mountArgs[0].api.request, 'function');
			assert.equal(typeof mountArgs[0].api.ui.spinner.show, 'function');
			assert.equal(typeof mountArgs[0].api.ui.spinner.hide, 'function');
			assert.equal(typeof mountArgs[0].dom.h, 'function');
			// Light DOM: ctx.root is the mount wrapper div in container; no shadowRoot in ctx.
			assert.equal(mountArgs[0].root, container.children[0], 'ctx.root is the mount wrapper in container');
			assert.equal(mountArgs[0].shadowRoot, undefined, 'no shadowRoot in Light DOM ctx');

			assert.equal(handle._mounted, true);
		});

		it('injects companion CSS as sibling next to the mount wrapper', async function () {
			const { createHost } = await loadHostSandbox();
			const container = createContainer();
			const request = makeRequest({ css: '.x { color: red; }' });
			const host = createHost({
				request,
				api: {},
				_importFn: async () => ({ mount: async () => {} }),
			});

			await host.mount({ container, pluginType: 'T', instanceId: '0', panelId: 'p', hash: '' });

			// Light DOM: mount wrapper stays the render root; companion CSS lives as sibling
			// so root.replaceChildren(...) in the bundle cannot wipe it on first render.
			const mountWrapper = container.children[0];
			const styleEl = container.children[1];
			assert.ok(mountWrapper, 'mount wrapper should be in container');
			assert.equal(mountWrapper.getAttribute('class'), 'msghub-plugin-ui-mount');
			assert.equal(mountWrapper.getAttribute('data-plugin-type'), 'T');
			assert.equal(mountWrapper.getAttribute('data-plugin-instance-id'), '0');
			assert.equal(mountWrapper.getAttribute('data-panel-id'), 'p');
			assert.equal(styleEl.tagName, 'STYLE');
			assert.equal(styleEl.textContent, '.x { color: red; }');
		});

		it('skips style tag when bundle has no css', async function () {
			const { createHost } = await loadHostSandbox();
			const container = createContainer();
			const host = createHost({
				request: makeRequest({ css: null }),
				api: {},
				_importFn: async () => ({ mount: async () => {} }),
			});

			await host.mount({ container, pluginType: 'T', instanceId: '0', panelId: 'p', hash: '' });

			// Mount wrapper exists; no sibling style tag when companion CSS is absent.
			const mountWrapper = container.children[0];
			assert.ok(mountWrapper, 'mount wrapper should be in container');
			assert.equal(container.children.length, 1, 'no sibling style tag when no CSS');
		});

		it('skips bundle.get when hash already in cache (fast path)', async function () {
			const { createHost } = await loadHostSandbox();
			const request = makeRequest({ hash: 'known-hash' });
			const host = createHost({
				request,
				api: {},
				_importFn: async () => ({ mount: async () => {} }),
			});

			// First mount — hash not yet in cache, bundle.get is called and response caches as 'known-hash'.
			await host.mount({
				container: createContainer(),
				pluginType: 'T',
				instanceId: '1',
				panelId: 'p',
				hash: 'known-hash',
			});
			assert.equal(request.calls.length, 1);

			// Second mount — passes the same hash; cache hit must skip bundle.get.
			await host.mount({
				container: createContainer(),
				pluginType: 'T',
				instanceId: '1',
				panelId: 'p',
				hash: 'known-hash',
			});
			assert.equal(request.calls.length, 1, 'bundle.get must not be called again on cache hit');
		});

		it('renders error in mount wrapper when module.mount() throws', async function () {
			const { createHost } = await loadHostSandbox();
			const container = createContainer();
			const host = createHost({
				request: makeRequest(),
				api: {},
				_importFn: async () => ({
					mount: async () => {
						throw new Error('kaboom');
					},
				}),
			});

			// Must not throw.
			const handle = await host.mount({ container, pluginType: 'T', instanceId: '0', panelId: 'p', hash: '' });

			assert.ok(handle, 'handle returned after mount error');
			assert.equal(handle._mounted, false);

			// Error element is written to the mount wrapper (bundle loaded, wrapper was created).
			const mountWrapper = container.children[0];
			assert.ok(mountWrapper, 'mount wrapper should exist after mount error');
			const errorEl = mountWrapper.children[0];
			assert.equal(errorEl.getAttribute('class'), 'msghub-plugin-panel-error');
			assert.equal(errorEl.getAttribute('role'), 'alert');
		});

		it('renders error in container when bundle fetch fails', async function () {
			const { createHost } = await loadHostSandbox();
			const container = createContainer();
			const host = createHost({
				request: async () => ({ ok: false, error: { message: 'not found' } }),
				api: {},
				_importFn: async () => {
					throw new Error('should not reach _importFn');
				},
			});

			const handle = await host.mount({ container, pluginType: 'T', instanceId: '0', panelId: 'p', hash: '' });

			assert.ok(handle, 'handle returned after load error');
			assert.equal(handle._mounted, false);
			// Bundle fetch failed before any mount wrapper was created — error goes directly into container.
			const errorEl = container.children[0];
			assert.equal(errorEl?.getAttribute('class'), 'msghub-plugin-panel-error');
			assert.equal(errorEl?.getAttribute('role'), 'alert');
		});

		it('sends sandbox lang in bundle.get request', async function () {
			const { createHost, sandbox } = await loadHostSandbox({ lang: 'de' });
			const container = createContainer();
			const request = makeRequest();
			const host = createHost({ request, api: {}, _importFn: async () => ({ mount: async () => {} }) });

			sandbox.lang = 'de';
			await host.mount({ container, pluginType: 'T', instanceId: '0', panelId: 'p', hash: '' });

			assert.equal(request.calls[0].cmd, 'admin.pluginUi.bundle.get');
			assert.equal(JSON.parse(JSON.stringify(request.calls[0].payload)).lang, 'de');
		});

		it('calls mergePluginI18n with pluginType and translations when i18n is present', async function () {
			const { createHost, mergeI18nCalls } = await loadHostSandbox();
			const container = createContainer();
			const translations = { 'msghub.i18n.IngestStates.ui.foo': 'Foo' };
			const request = makeRequest({ i18n: { lang: 'en', translations } });
			const host = createHost({ request, api: {}, _importFn: async () => ({ mount: async () => {} }) });

			await host.mount({ container, pluginType: 'IngestStates', instanceId: '0', panelId: 'presets', hash: '' });

			assert.equal(mergeI18nCalls.length, 1);
			assert.equal(mergeI18nCalls[0].pluginType, 'IngestStates');
			assert.deepEqual(JSON.parse(JSON.stringify(mergeI18nCalls[0].translations)), translations);
		});

		it('does not call mergePluginI18n when i18n is null', async function () {
			const { createHost, mergeI18nCalls } = await loadHostSandbox();
			const host = createHost({
				request: makeRequest({ i18n: null }),
				api: {},
				_importFn: async () => ({ mount: async () => {} }),
			});

			await host.mount({ container: createContainer(), pluginType: 'T', instanceId: '0', panelId: 'p', hash: '' });

			assert.equal(mergeI18nCalls.length, 0, 'mergePluginI18n must not be called when i18n is null');
		});

		it('does not call mergePluginI18n when i18n.translations is absent', async function () {
			const { createHost, mergeI18nCalls } = await loadHostSandbox();
			const host = createHost({
				// i18n present but no translations field
				request: makeRequest({ i18n: { lang: 'en' } }),
				api: {},
				_importFn: async () => ({ mount: async () => {} }),
			});

			await host.mount({ container: createContainer(), pluginType: 'T', instanceId: '0', panelId: 'p', hash: '' });

			assert.equal(mergeI18nCalls.length, 0, 'mergePluginI18n must not be called without translations');
		});

		it('cache key includes lang: different lang triggers new bundle.get call', async function () {
			const { createHost, sandbox } = await loadHostSandbox({ lang: 'de' });
			const request = makeRequest({ hash: 'same-hash' });
			const host = createHost({ request, api: {}, _importFn: async () => ({ mount: async () => {} }) });

			// First mount — lang='de'; cache miss → bundle.get called; cached as ...same-hash:de
			await host.mount({ container: createContainer(), pluginType: 'T', instanceId: '0', panelId: 'p', hash: 'same-hash' });
			assert.equal(request.calls.length, 1);

			// Change lang to 'en' — different cache key → cache miss → bundle.get called again
			sandbox.lang = 'en';
			await host.mount({ container: createContainer(), pluginType: 'T', instanceId: '0', panelId: 'p', hash: 'same-hash' });
			assert.equal(request.calls.length, 2, 'different lang must produce a separate cache entry');
		});
	});

	describe('unmount()', function () {
		it('calls module.unmount() and removes mount wrapper from container', async function () {
			const { createHost } = await loadHostSandbox();
			const container = createContainer();
			const unmountArgs = [];
			const mockModule = {
				mount: async () => {},
				unmount: async ctx => {
					unmountArgs.push(ctx);
				},
			};
			const host = createHost({
				request: makeRequest(),
				api: {},
				_importFn: async () => mockModule,
			});

			const handle = await host.mount({ container, pluginType: 'T', instanceId: '0', panelId: 'p', hash: '' });
			assert.equal(handle._mounted, true);
			assert.equal(container.children.length, 1, 'mount wrapper present before unmount');

			await host.unmount(handle);

			assert.equal(unmountArgs.length, 1, 'module.unmount() should be called');
			assert.equal(handle._mounted, false);
			assert.equal(handle._module, null);
			assert.equal(handle._ctx, null);
			assert.equal(container.children.length, 0, 'mount wrapper removed from container');
		});

		it('is a no-op when module has no unmount export', async function () {
			const { createHost } = await loadHostSandbox();
			const container = createContainer();
			const host = createHost({
				request: makeRequest(),
				api: {},
				_importFn: async () => ({ mount: async () => {} }),
			});

			const handle = await host.mount({ container, pluginType: 'T', instanceId: '0', panelId: 'p', hash: '' });
			// Should not throw.
			await host.unmount(handle);
			assert.equal(handle._mounted, false);
		});

		it('is a no-op for null handle', async function () {
			const { createHost } = await loadHostSandbox();
			const host = createHost({ request: makeRequest(), api: {}, _importFn: async () => ({}) });
			// Should not throw.
			await host.unmount(null);
		});
	});

	describe('retry()', function () {
		it('clears cache for the panel, re-fetches bundle, re-mounts', async function () {
			const { createHost } = await loadHostSandbox();
			const container = createContainer();
			let mountCount = 0;
			const mockModule = { mount: async () => { mountCount++; } };
			const request = makeRequest({ hash: 'r-hash' });
			const host = createHost({ request, api: {}, _importFn: async () => mockModule });

			const handle = await host.mount({ container, pluginType: 'T', instanceId: '0', panelId: 'p', hash: '' });
			assert.equal(request.calls.length, 1);
			assert.equal(mountCount, 1);

			const handle2 = await host.retry(handle);
			assert.equal(request.calls.length, 2, 'retry must re-fetch after cache clear');
			assert.equal(mountCount, 2, 'retry must re-mount');
			assert.ok(handle2, 'retry returns new handle');
		});

		it('returns null for null handle without crashing', async function () {
			const { createHost } = await loadHostSandbox();
			const host = createHost({ request: makeRequest(), api: {}, _importFn: async () => ({}) });
			const result = await host.retry(null);
			assert.equal(result, null);
		});
	});

	describe('ctx.api.request()', function () {
		it('routes through admin.pluginUi.rpc with correct envelope', async function () {
			const { createHost } = await loadHostSandbox();
			const container = createContainer();
			let capturedCtx = null;
			const mockModule = {
				mount: async ctx => {
					capturedCtx = ctx;
				},
			};
			// rpcResponse is raw data (transport resolves res.data directly); ctx.api.request wraps it.
		const request = makeRequest({ rpcResponse: { result: 42 } });
			const host = createHost({ request, api: {}, _importFn: async () => mockModule });

			await host.mount({
				container,
				pluginType: 'IngestStates',
				instanceId: '0',
				panelId: 'presets',
				hash: '',
			});

			const rpcResult = await capturedCtx.api.request('presets.list', { filter: 'all' });

			const rpcCall = request.calls.find(c => c.cmd === 'admin.pluginUi.rpc');
			assert.ok(rpcCall, 'rpc call must be made');
			// JSON round-trip strips VM-realm prototype so deepEqual works across realms.
			assert.deepEqual(JSON.parse(JSON.stringify(rpcCall.payload)), {
				pluginType: 'IngestStates',
				instanceId: '0',
				panelId: 'presets',
				command: 'presets.list',
				payload: { filter: 'all' },
			});
			assert.deepEqual(JSON.parse(JSON.stringify(rpcResult)), { ok: true, data: { result: 42 } });
		});
	});
});
