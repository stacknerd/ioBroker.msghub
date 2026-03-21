/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRepoFile } = require('./_test.utils');

async function loadRuntimeSandbox(options = {}) {
	const source = await readRepoFile('admin/tab/runtime.js');
	const expose = `
window.__runtime = {
	parseQuery,
	createSocket,
	normalizeLang,
	fetchJson,
	loadAdminI18nDictionary,
	ensureAdminI18nLoaded,
	hasAdminKey,
	mergePluginI18n,
	t,
	resolveTheme,
	readThemeFromLocalStorage,
	readThemeFromTopWindow,
	applyTheme,
	detectTheme,
	args,
	adapterInstance,
	msghubSocket: window.msghubSocket,
	msghubRequest,
	lang
};
`;

	const attrs = new Map();
	const documentObject = {
		documentElement: {
			getAttribute: key => attrs.get(String(key)) || null,
			setAttribute: (key, value) => attrs.set(String(key), String(value)),
		},
	};

	const localStorageSeed = { ...(options.localStorage || {}) };
	const localStorage = {
		...localStorageSeed,
		getItem(key) {
			const normalized = String(key);
			return Object.prototype.hasOwnProperty.call(this, normalized) ? this[normalized] : null;
		},
		setItem(key, value) {
			this[String(key)] = String(value);
		},
		removeItem(key) {
			delete this[String(key)];
		},
		clear() {
			for (const key of Object.keys(this)) {
				if (!['getItem', 'setItem', 'removeItem', 'clear'].includes(key)) {
					delete this[key];
				}
			}
		},
	};
	const topDocument = options.topDocument || null;

	const ioCalls = [];
	const socketEmit = options.socketEmit || function () {};
	const ioMock = {
		connect: (url, connectOptions) => {
			ioCalls.push({ url, options: connectOptions });
			return { connected: true, on() {}, emit: socketEmit };
		},
	};

	const fetchCalls = [];
	const fetchMap = options.fetchMap || {};
	const fetchMock =
		options.fetch ||
		(async url => {
			fetchCalls.push(String(url));
			if (Object.prototype.hasOwnProperty.call(fetchMap, url)) {
				return {
					ok: true,
					status: 200,
					json: async () => fetchMap[url],
				};
			}
			return {
				ok: false,
				status: 404,
				json: async () => ({}),
			};
		});

	const locationObject = {
		search: options.search || '',
		pathname: options.pathname || '/admin/index_m.html',
	};

	const windowObject = {
		location: locationObject,
		navigator: { language: options.navigatorLanguage || 'en-US' },
		localStorage,
		top: topDocument ? { document: topDocument } : {},
		matchMedia: query => ({ matches: query.includes('dark') ? !!options.prefersDark : false }),
	};
	windowObject.window = windowObject;

	const sandbox = {
		window: windowObject,
		location: locationObject,
		navigator: windowObject.navigator,
		document: documentObject,
		io: ioMock,
		win: windowObject,
		fetch: fetchMock,
		console: { debug() {}, info() {}, warn() {}, error() {} },
	};

	vm.runInNewContext(`${source}\n${expose}`, sandbox, { filename: 'admin/tab/runtime.js' });
	sandbox.__meta = { ioCalls, fetchCalls, attrs };
	return sandbox;
}

describe('admin/tab/runtime.js', function () {
	it('parses query args and derives adapter/lang', async function () {
		const sandbox = await loadRuntimeSandbox({
			search: '?instance=2&lang=de&theme=dark',
		});
		const runtime = sandbox.window.__runtime;

		assert.equal(runtime.args.instance, 2);
		assert.equal(runtime.args.lang, 'de');
		assert.equal(runtime.lang, 'de');
		assert.equal(runtime.adapterInstance, 'msghub.2');
	});

	it('builds socket path via io.connect for admin paths', async function () {
		const sandbox = await loadRuntimeSandbox({
			pathname: '/admin/index_m.html',
			search: '?instance=0',
		});
		assert.equal(sandbox.__meta.ioCalls.length, 1);
		const call = sandbox.__meta.ioCalls[0];
		assert.equal(call.url, '/');
		assert.equal(call.options.path, '/socket.io');
	});

	it('uses /socket.io path for adapter tab URLs', async function () {
		const sandbox = await loadRuntimeSandbox({
			pathname: '/adapter/msghub/tab.html',
			search: '?instance=0',
		});
		assert.equal(sandbox.__meta.ioCalls.length, 1);
		const call = sandbox.__meta.ioCalls[0];
		assert.equal(call.url, '/');
		assert.equal(call.options.path, '/socket.io');
	});

	it('normalizes language and resolves theme precedence', async function () {
		const sandbox = await loadRuntimeSandbox({
			search: '?instance=1',
			prefersDark: true,
			localStorage: {
				'app.theme': 'light',
			},
		});
		const runtime = sandbox.window.__runtime;

		assert.equal(runtime.normalizeLang('DE-DE'), 'de-de');
		assert.equal(runtime.resolveTheme({ theme: 'dark' }), 'dark');
		assert.equal(runtime.resolveTheme({ react: 'light' }), 'light');
		assert.equal(runtime.readThemeFromLocalStorage(), 'light');
		assert.equal(runtime.detectTheme(), 'light', 'storage should win over prefers-color-scheme');
	});

	it('loads i18n dictionary once and translates with fallback', async function () {
		const sandbox = await loadRuntimeSandbox({
			search: '?instance=0&lang=de',
			fetchMap: {
				'i18n/en.json': { 'msg.key': 'hello', fallback: 'fallback' },
				'i18n/de.json': { 'msg.key': 'hallo' },
			},
		});
		const runtime = sandbox.window.__runtime;

		await runtime.ensureAdminI18nLoaded();
		await runtime.ensureAdminI18nLoaded();

		assert.equal(runtime.hasAdminKey('msg.key'), true);
		assert.equal(runtime.t('msg.key'), 'hallo');
		assert.equal(runtime.t('missing.key'), 'missing.key');
		assert.equal(sandbox.__meta.fetchCalls.length, 2, 'dictionary load should be cached');
	});

	it('msghubRequest sends sendTo via socket and resolves on ok response', async function () {
		const sandbox = await loadRuntimeSandbox({
			search: '?instance=2',
			socketEmit(event, adapter, command, message, callback) {
				callback({ ok: true, data: { command, adapter } });
			},
		});
		const runtime = sandbox.window.__runtime;
		const result = await runtime.msghubRequest('admin.stats.get', { q: 1 });

		assert.equal(result.command, 'admin.stats.get');
		assert.equal(result.adapter, 'msghub.2');
		assert.equal(runtime.msghubSocket, sandbox.window.msghubSocket);
	});

	it('applies theme to document root and keeps debug marker when enabled', async function () {
		const sandbox = await loadRuntimeSandbox({
			search: '?instance=0&debugTheme=1&theme=dark',
		});
		const runtime = sandbox.window.__runtime;

		runtime.applyTheme('dark');
		assert.equal(sandbox.__meta.attrs.get('data-msghub-theme'), 'dark');
		assert.equal(sandbox.window.__msghubAdminTabTheme, 'dark');

		runtime.applyTheme('light');
		assert.equal(sandbox.__meta.attrs.get('data-msghub-theme'), 'light');
		assert.equal(sandbox.window.__msghubAdminTabTheme, 'light');
	});

	describe('mergePluginI18n()', function () {
		it('admits keys in the plugin ui namespace and makes them accessible via t()', async function () {
			const sandbox = await loadRuntimeSandbox();
			const runtime = sandbox.window.__runtime;

			runtime.mergePluginI18n('IngestStates', {
				'msghub.i18n.IngestStates.ui.foo': 'Foo label',
				'msghub.i18n.IngestStates.ui.bar': 'Bar label',
			});

			assert.equal(runtime.hasAdminKey('msghub.i18n.IngestStates.ui.foo'), true);
			assert.equal(runtime.t('msghub.i18n.IngestStates.ui.foo'), 'Foo label');
			assert.equal(runtime.hasAdminKey('msghub.i18n.IngestStates.ui.bar'), true);
			assert.equal(runtime.t('msghub.i18n.IngestStates.ui.bar'), 'Bar label');
		});

		it('drops keys outside the plugin ui namespace', async function () {
			const sandbox = await loadRuntimeSandbox();
			const runtime = sandbox.window.__runtime;

			runtime.mergePluginI18n('IngestStates', {
				// correct pluginType but missing .ui. segment
				'msghub.i18n.IngestStates.foo': 'should be dropped',
				// different pluginType
				'msghub.i18n.OtherPlugin.ui.key': 'should be dropped',
				// core namespace
				'msghub.i18n.core.admin.bad': 'should be dropped',
				// unrelated
				'unrelated.key': 'should be dropped',
			});

			assert.equal(runtime.hasAdminKey('msghub.i18n.IngestStates.foo'), false);
			assert.equal(runtime.hasAdminKey('msghub.i18n.OtherPlugin.ui.key'), false);
			assert.equal(runtime.hasAdminKey('msghub.i18n.core.admin.bad'), false);
			assert.equal(runtime.hasAdminKey('unrelated.key'), false);
		});

		it('does not overwrite a key already merged from a prior call', async function () {
			const sandbox = await loadRuntimeSandbox();
			const runtime = sandbox.window.__runtime;

			runtime.mergePluginI18n('IngestStates', { 'msghub.i18n.IngestStates.ui.label': 'original' });
			assert.equal(runtime.t('msghub.i18n.IngestStates.ui.label'), 'original');

			runtime.mergePluginI18n('IngestStates', { 'msghub.i18n.IngestStates.ui.label': 'overwrite attempt' });
			assert.equal(runtime.t('msghub.i18n.IngestStates.ui.label'), 'original', 'existing key must not be overwritten');
		});

		it('does not overwrite a key already present in the core dictionary', async function () {
			// Key must be in the .ui. namespace so the namespace filter admits it and
			// the no-overwrite rule is the actual guard under test.
			const sandbox = await loadRuntimeSandbox({
				fetchMap: { 'i18n/en.json': { 'msghub.i18n.IngestStates.ui.preloaded': 'core value' } },
			});
			const runtime = sandbox.window.__runtime;
			await runtime.ensureAdminI18nLoaded();

			runtime.mergePluginI18n('IngestStates', { 'msghub.i18n.IngestStates.ui.preloaded': 'plugin overwrite attempt' });

			assert.equal(runtime.t('msghub.i18n.IngestStates.ui.preloaded'), 'core value', 'core dict key must not be overwritten');
		});

		it('is a no-op and does not throw for null payload', async function () {
			const sandbox = await loadRuntimeSandbox();
			const runtime = sandbox.window.__runtime;
			// Must not throw.
			runtime.mergePluginI18n('P', null);
		});

		it('is a no-op and does not throw for array payload', async function () {
			const sandbox = await loadRuntimeSandbox();
			const runtime = sandbox.window.__runtime;
			runtime.mergePluginI18n('P', ['a', 'b']);
		});

		it('is a no-op and does not throw for non-object payload', async function () {
			const sandbox = await loadRuntimeSandbox();
			const runtime = sandbox.window.__runtime;
			runtime.mergePluginI18n('P', 'a string');
			runtime.mergePluginI18n('P', 42);
		});
	});
});
