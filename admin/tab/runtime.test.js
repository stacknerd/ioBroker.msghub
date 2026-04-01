/* eslint-env mocha */
'use strict';

/**
 * Runtime module tests for admin/tab/runtime.js.
 *
 * Contents:
 * - Sandbox-based loading of the browser runtime module.
 * - Query parsing, socket bootstrap, i18n helpers, and theme behavior tests.
 *
 * Integration:
 * - Executes `runtime.js` inside a VM-backed browser-like sandbox.
 * - Exposes selected runtime globals through `window.__runtime` for assertions.
 *
 * Interfaces:
 * - `loadRuntimeSandbox(options)` creates an isolated runtime fixture for each test.
 */

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRepoFile } = require('./_test.utils');

/**
 * Loads `admin/tab/runtime.js` into an isolated browser-like sandbox.
 *
 * @param {object} [options={}] - Sandbox overrides for location, storage, fetch, and socket behavior.
 * @returns {Promise<object>} Sandbox with `window.__runtime` plus test metadata in `__meta`.
 */
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
		pickText,
		resolveExplicitUrlTheme,
		resolveTheme,
		readThemeFromLocalStorage,
		readThemeFromTopWindow,
		applyTheme,
		detectTheme,
		urlThemeLocked,
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
			matchMedia: query => ({ matches: query.includes('dark') ? !!options.prefersDark : false }),
		};
		windowObject.window = windowObject;
		windowObject.top = topDocument ? { document: topDocument } : windowObject;

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
	describe('parseQuery()', function () {
		async function parse(search) {
			const sandbox = await loadRuntimeSandbox({ search });
			return sandbox.window.__runtime.parseQuery();
		}

		it('keeps theme and react as raw strings while normalizing composition and expert', async function () {
			const result = await parse('?theme=%20dark%20&react=%20light%20&composition=%20adminTab%20&expert=true');

			assert.equal(result.theme, ' dark ');
			assert.equal(result.react, ' light ');
			assert.equal(result.composition, 'adminTab');
			assert.equal(result.expert, true);
		});

		it('trims locale and keeps it when non-empty', async function () {
			const result = await parse('?locale=%20de-DE%20');
			assert.equal(result.locale, 'de-DE');
		});

		it('removes locale when it is blank after trimming', async function () {
			const result = await parse('?locale=%20%20%20');
			assert.equal(result.locale, undefined);
		});

		it('removes composition when it is blank after trimming', async function () {
			const result = await parse('?composition=%20%20%20');
			assert.equal(result.composition, undefined);
		});

		it('removes composition when it is a bare flag without a value', async function () {
			const result = await parse('?composition');
			assert.equal(result.composition, undefined);
		});

		it('treats a bare expert flag and numeric expert flag as true', async function () {
			assert.equal((await parse('?expert')).expert, true);
			assert.equal((await parse('?expert=1')).expert, true);
		});

		it('normalizes present invalid expert values to false and preserves unknown keys', async function () {
			const result = await parse('?expert=maybe&unknown=value');
			assert.equal(result.expert, false);
			assert.equal(result.unknown, 'value');
		});

		it('normalizes explicit expert=false to false', async function () {
			assert.equal((await parse('?expert=false')).expert, false);
		});

		it('keeps expert undefined when the query does not contain the key', async function () {
			const result = await parse('?instance=0');
			assert.equal(result.expert, undefined);
		});

		it('falls back to raw fragments for invalid percent-encoding instead of throwing', async function () {
			const sandbox = await loadRuntimeSandbox({
				search: '?composition=%E0%A4%A&%E0%A4%A=value',
			});
			const result = sandbox.window.__runtime.parseQuery();

			assert.equal(result.composition, '%E0%A4%A');
			assert.equal(result['%E0%A4%A'], 'value');
		});

		it('keeps instance and lang fallback behavior intact', async function () {
			const result = await parse('?instance=oops&lang=');
			assert.equal(result.instance, 0);
			assert.equal(result.lang, 'en');
			assert.equal(result.expert, undefined);
		});

		describe('panel parameter', function () {
			it('preserves a valid core panel id unchanged', async function () {
				const result = await parse('?panel=tab-messages');
				assert.equal(result.panel, 'tab-messages');
			});

			it('preserves a full plugin panel id unchanged', async function () {
				const result = await parse('?panel=tab-plugin-IngestStates-0-presets');
				assert.equal(result.panel, 'tab-plugin-IngestStates-0-presets');
			});

			it('trims surrounding whitespace from the panel value', async function () {
				const result = await parse('?panel=%20tab-messages%20');
				assert.equal(result.panel, 'tab-messages');
			});

			it('removes panel when it is a bare flag without a value', async function () {
				const result = await parse('?panel');
				assert.equal(result.panel, undefined);
			});

			it('removes panel when its value is empty', async function () {
				const result = await parse('?panel=');
				assert.equal(result.panel, undefined);
			});

			it('removes panel when its value is blank after trimming', async function () {
				const result = await parse('?panel=%20%20');
				assert.equal(result.panel, undefined);
			});

			it('coexists with composition without interfering with either value', async function () {
				const result = await parse('?composition=adminTab&panel=tab-messages');
				assert.equal(result.composition, 'adminTab');
				assert.equal(result.panel, 'tab-messages');
			});
		});
	});

	describe('pickText()', function () {
		async function loadPickText(opts = {}) {
			const sandbox = await loadRuntimeSandbox({
				fetchMap: { 'i18n/en.json': { 'known.key': 'Translated', 'msghub.i18n.core.x': 'Core X' }, ...opts.fetchMap },
				...opts,
			});
			// Wait for i18n to load so hasAdminKey / t are functional.
			await sandbox.window.__runtime.ensureAdminI18nLoaded();
			return sandbox.window.__runtime.pickText;
		}

		it('returns a plain string unchanged', async function () {
			const pickText = await loadPickText();
			assert.equal(pickText('plain text'), 'plain text');
		});

		it('translates an msghub.i18n. prefixed string via t()', async function () {
			const pickText = await loadPickText();
			assert.equal(pickText('msghub.i18n.core.x'), 'Core X');
		});

		it('translates a known admin key via t()', async function () {
			const pickText = await loadPickText();
			assert.equal(pickText('known.key'), 'Translated');
		});

		it('resolves language-mapped objects using active lang', async function () {
			// lang defaults to 'en' in the sandbox.
			const pickText = await loadPickText();
			assert.equal(pickText({ en: 'Hello', de: 'Hallo' }), 'Hello');
		});

		it('falls back to en when active lang is absent in the object', async function () {
			const pickText = await loadPickText();
			assert.equal(pickText({ de: 'Hallo', en: 'Hello' }), 'Hello');
		});

		it('returns empty string for null / non-object non-string values', async function () {
			const pickText = await loadPickText();
			assert.equal(pickText(null), '');
			assert.equal(pickText(undefined), '');
			assert.equal(pickText(42), '');
		});
	});

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

		it('resolves explicit URL themes with canonical theme semantics and react as absent-only fallback', async function () {
			const sandbox = await loadRuntimeSandbox({
				search: '?instance=1',
			});
			const runtime = sandbox.window.__runtime;

			assert.equal(runtime.resolveExplicitUrlTheme({ theme: 'dark', react: 'light' }), 'dark');
			assert.equal(runtime.resolveExplicitUrlTheme({ theme: ' light ', react: 'dark' }), 'light');
			assert.equal(runtime.resolveExplicitUrlTheme({ react: 'dark' }), 'dark');
			assert.equal(runtime.resolveExplicitUrlTheme({ theme: 'blue', react: 'light' }), null);
			assert.equal(runtime.resolveExplicitUrlTheme({ theme: 'blue' }), null);
			assert.equal(runtime.resolveExplicitUrlTheme({}), null);
			assert.equal(runtime.resolveTheme({ theme: 'dark' }), 'dark');
			assert.equal(runtime.resolveTheme({ react: 'light' }), 'light');
		});

		it('detectTheme keeps explicit theme= override ahead of host, storage, and prefers-color-scheme', async function () {
			const topDocument = {
				documentElement: { getAttribute: key => (key === 'data-theme' ? 'light' : null), className: '' },
				body: null,
				getElementById: () => null,
			};
			const sandbox = await loadRuntimeSandbox({
				search: '?instance=1&theme=dark&react=light',
				topDocument,
				prefersDark: false,
				localStorage: {
					'app.theme': 'light',
				},
			});
			const runtime = sandbox.window.__runtime;

			assert.equal(runtime.urlThemeLocked, true);
			assert.equal(runtime.detectTheme(), 'dark');
		});

		it('react=light does not enable the theme lock and still allows the host theme to win', async function () {
			const topDocument = {
				documentElement: { getAttribute: key => (key === 'data-theme' ? 'dark' : null), className: '' },
				body: null,
				getElementById: () => null,
			};
			const sandbox = await loadRuntimeSandbox({
				search: '?instance=1&react=light',
				topDocument,
				prefersDark: false,
			});
			const runtime = sandbox.window.__runtime;

			assert.equal(runtime.urlThemeLocked, false);
			assert.equal(runtime.readThemeFromTopWindow(), 'dark');
			assert.equal(runtime.detectTheme(), 'dark');
		});

		it('react=light does not enable the theme lock and still allows localStorage to win', async function () {
			const sandbox = await loadRuntimeSandbox({
				search: '?instance=1&react=light',
				prefersDark: false,
				localStorage: {
					'app.theme': 'dark',
				},
			});
			const runtime = sandbox.window.__runtime;

			assert.equal(runtime.urlThemeLocked, false);
			assert.equal(runtime.readThemeFromLocalStorage(), 'dark');
			assert.equal(runtime.detectTheme(), 'dark');
		});

		it('detectTheme follows the host theme before localStorage when embedded without explicit override', async function () {
			const topDocument = {
				documentElement: { getAttribute: key => (key === 'data-theme' ? 'dark' : null), className: '' },
				body: null,
				getElementById: () => null,
			};
			const sandbox = await loadRuntimeSandbox({
				search: '?instance=1',
				topDocument,
				prefersDark: false,
				localStorage: {
					'app.theme': 'light',
				},
			});
			const runtime = sandbox.window.__runtime;

			assert.equal(runtime.urlThemeLocked, false);
			assert.equal(runtime.readThemeFromTopWindow(), 'dark');
			assert.equal(runtime.readThemeFromLocalStorage(), 'light');
			assert.equal(runtime.detectTheme(), 'dark');
		});

		it('detectTheme uses localStorage before prefers-color-scheme when standalone', async function () {
			const sandbox = await loadRuntimeSandbox({
				search: '?instance=1',
				prefersDark: true,
			localStorage: {
				'app.theme': 'light',
			},
		});
			const runtime = sandbox.window.__runtime;

			assert.equal(runtime.normalizeLang('DE-DE'), 'de-de');
			assert.equal(runtime.readThemeFromTopWindow(), null);
			assert.equal(runtime.readThemeFromLocalStorage(), 'light');
			assert.equal(runtime.detectTheme(), 'light', 'storage should win over prefers-color-scheme');
		});

		it('falls back to prefers-color-scheme and light when no higher-priority source exists', async function () {
			const darkSandbox = await loadRuntimeSandbox({
				search: '?instance=1',
				prefersDark: true,
			});
			assert.equal(darkSandbox.window.__runtime.detectTheme(), 'dark');

			const lightSandbox = await loadRuntimeSandbox({
				search: '?instance=1',
				prefersDark: false,
			});
			assert.equal(lightSandbox.window.__runtime.detectTheme(), 'light');
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

	it('treats bare debugTheme as enabled at module load', async function () {
		const sandbox = await loadRuntimeSandbox({
			search: '?instance=0&debugTheme&theme=dark',
		});
		const runtime = sandbox.window.__runtime;

		runtime.applyTheme('dark');
		assert.equal(sandbox.window.__msghubAdminTabTheme, 'dark');
	});

	it('treats debugTheme=true as enabled at module load', async function () {
		const sandbox = await loadRuntimeSandbox({
			search: '?instance=0&debugTheme=true&theme=light',
		});
		const runtime = sandbox.window.__runtime;

		runtime.applyTheme('light');
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
