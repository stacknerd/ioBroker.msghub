/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRepoFile } = require('../../test/adminTabCoreTestUtils');

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
	t,
	resolveTheme,
	readThemeFromLocalStorage,
	readThemeFromTopWindow,
	applyTheme,
	detectTheme,
	args,
	adapterInstance,
	socket,
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
	const ioMock = {
		connect: (url, connectOptions) => {
			ioCalls.push({ url, options: connectOptions });
			return { connected: true, on() {} };
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
});
