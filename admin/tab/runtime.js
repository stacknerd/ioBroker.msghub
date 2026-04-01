/* global window, document, io, win */
'use strict';

/**
 * MsgHub Admin Tab runtime foundations (query parsing, socket, i18n, theme).
 *
 * Docs: ../../docs/ui/tab-runtime.md
 *
 * Contents:
 * - URL query parsing and normalization for adapter/runtime bootstrap values.
 * - Admin backend socket setup.
 * - Admin i18n dictionary loading and translation helpers.
 * - Theme detection from query, storage, host window, and fallbacks.
 *
 * Integration:
 * - Exposes runtime globals (`args`, `window.msghubSocket`, `lang`, ...) consumed by
 *   `api.js`, `layout.js`, and `boot.js`.
 *
 * Canonical query parameters:
 * - `instance` {number}, default `0`, consumed by `adapterInstance` bootstrap in this module.
 * - `lang` {string}, default browser base language, consumed by `lang` bootstrap and i18n loading here.
 * - `locale` {string}, default absent, trimmed here and consumed downstream as an optional frontend format-locale override.
 * - `composition` {string}, default absent, parsed here and preserved on `args` for downstream consumers.
 * - `panel` {string}, default absent, parsed here and preserved on `args` for panel-mode activation by downstream consumers.
 * - `expert` {boolean}, default absent, normalized here only when the key is present and preserved on `args`.
 * - `theme` {string}, default absent, preserved raw in `args` and consumed by the theme helpers here.
 * - `react` {string}, default absent, preserved raw in `args` and consumed as a legacy theme alias here.
 * - `debugTheme` {boolean|string}, default absent, preserved raw in `args` and normalized at module load by `debugTheme`.
 *
 * Interfaces:
 * - Utility functions such as `t`, `ensureAdminI18nLoaded`, and `detectTheme`.
 * - No DOM mutation except setting the root theme attribute.
 */

/**
 * Reads URL query parameters and normalizes canonical runtime values.
 *
 * Normalization:
 * - `instance`: integer, defaults to `0` when absent or invalid.
 * - `lang`: browser base language when absent or blank.
 * - `locale`: trimmed string; empty after trim is removed.
 * - `composition`: trimmed string; empty after trim is removed.
 * - `panel`: trimmed string; empty after trim is removed.
 * - `expert`: normalized only when present; `true`, `1`, and bare `?expert` become `true`.
 * - `theme` / `react`: kept as raw strings, including whitespace.
 * - `debugTheme`: kept raw here and normalized later at module load.
 * - Unknown keys are preserved.
 *
 * Invalid URL encoding is handled defensively: undecodable keys or values fall back
 * to their raw query fragments instead of throwing during bootstrap.
 *
 * @returns {object} Normalized query values including `instance` and `lang`.
 */
function parseQuery() {
	const q = (window.location.search || '').replace(/^\?/, '').replace(/#.*$/, '');
	const out = {};
	for (const pair of q.split('&')) {
		const p = pair.trim();
		if (!p) {
			continue;
		}
		const [k, v] = p.split('=');
		let key = k;
		let value = v === undefined ? true : v;
		try {
			key = decodeURIComponent(k);
		} catch {
			key = k;
		}
		if (v !== undefined) {
			try {
				value = decodeURIComponent(v);
			} catch {
				value = v;
			}
		}
		out[key] = value;
	}
	if (out.instance !== undefined) {
		const n = Number(out.instance);
		out.instance = Number.isFinite(n) ? Math.trunc(n) : 0;
	} else {
		out.instance = 0;
	}
	if (typeof out.lang !== 'string' || !out.lang.trim()) {
		out.lang = (navigator.language || 'en').split('-')[0].toLowerCase();
	}
	if (out.locale !== undefined) {
		const locale = typeof out.locale === 'string' ? out.locale.trim() : '';
		if (locale) {
			out.locale = locale;
		} else {
			delete out.locale;
		}
	}
	if (out.composition !== undefined) {
		const composition = typeof out.composition === 'string' ? out.composition.trim() : '';
		if (composition) {
			out.composition = composition;
		} else {
			delete out.composition;
		}
	}
	if (out.panel !== undefined) {
		const panel = typeof out.panel === 'string' ? out.panel.trim() : '';
		if (panel) {
			out.panel = panel;
		} else {
			delete out.panel;
		}
	}
	if (out.expert !== undefined) {
		out.expert = out.expert === true || out.expert === '1' || out.expert === 'true';
	}
	return out;
}

/**
 * Builds the socket.io connection for admin contexts.
 *
 * @returns {any} Socket.io client instance.
 */
function createSocket() {
	// ioBroker always serves socket.io at /socket.io — regardless of the tab URL path.
	return io.connect('/', { path: '/socket.io' });
}

const args = parseQuery();
const adapterInstance = `msghub.${args.instance}`;
// Expose on a dedicated property that the admin host will not override.
window.msghubSocket = createSocket();

/**
 * Sends an admin command to the backend over socket.io.
 *
 * @param {string} command - Backend command (e.g. `admin.stats.get`).
 * @param {object} message - Payload for the command.
 * @returns {Promise<any>} Resolved backend data or error.
 */
function msghubRequest(command, message) {
	return new Promise((resolve, reject) => {
		window.msghubSocket.emit('sendTo', adapterInstance, command, message, res => {
			if (!res) {
				return reject(new Error('No response'));
			}
			if (res.ok) {
				return resolve(res.data);
			}
			const msg = res?.error?.message || res?.error || 'Unknown error';
			return reject(new Error(String(msg)));
		});
	});
}
let lang = typeof args.lang === 'string' ? args.lang : 'en';
const isEmbeddedInAdmin = window !== window.top;
// `debugTheme` remains raw in `args` and is normalized here at module load for debug marker handling.
const debugTheme = args.debugTheme === true || args.debugTheme === '1' || args.debugTheme === 'true';
const initialThemeFromQuery = resolveExplicitUrlTheme(args);
const urlThemeLocked =
	Object.prototype.hasOwnProperty.call(args || {}, 'theme') &&
	(initialThemeFromQuery === 'dark' || initialThemeFromQuery === 'light');
// Dictionary state and load promise stay in module scope on purpose.
let adminDict = Object.freeze({});
let adminDictPromise = null;

/**
 * Normalizes language codes to a stable base format.
 *
 * @param {string} x - Raw value (for example `de-DE` or `EN`).
 * @returns {string} Base language in lowercase.
 */
function normalizeLang(x) {
	const s = typeof x === 'string' ? x.trim().toLowerCase() : '';
	return s || 'en';
}

/**
 * Overrides the active language and forces the dictionary to reload.
 *
 * @param {string} newLang - New language code (for example `de` or `en`).
 */
function overrideLang(newLang) {
	const normalized = normalizeLang(newLang);
	if (normalized === lang) {
		return;
	}
	lang = normalized;
	adminDictPromise = null;
}

/**
 * Loads JSON via fetch and validates the root type.
 *
 * @param {string} url - Relative or absolute JSON path.
 * @returns {Promise<object>} Parsed JSON object.
 */
async function fetchJson(url) {
	if (typeof fetch !== 'function') {
		throw new Error('fetch is not available');
	}
	const res = await fetch(url, { cache: 'no-cache' });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} for ${url}`);
	}
	const json = await res.json();
	return json && typeof json === 'object' ? json : {};
}

/**
 * Loads the admin i18n dictionary with `en` fallback plus the active language.
 *
 * @returns {Promise<void>}
 */
async function loadAdminI18nDictionary() {
	const l = normalizeLang(lang);
	const enUrl = 'i18n/en.json';
	const langUrl = `i18n/${l}.json`;

	const [enRes, langRes] = await Promise.allSettled([
		fetchJson(enUrl),
		l === 'en' ? Promise.resolve({}) : fetchJson(langUrl),
	]);

	const enDict = enRes.status === 'fulfilled' ? enRes.value : {};
	const locDict = langRes.status === 'fulfilled' ? langRes.value : {};
	adminDict = Object.freeze({ ...enDict, ...locDict });
}

/**
 * Ensures that the admin dictionary is loaded only once per language state.
 *
 * @returns {Promise<void>} Promise for the load process.
 */
function ensureAdminI18nLoaded() {
	if (adminDictPromise) {
		return adminDictPromise;
	}
	adminDictPromise = Promise.resolve()
		.then(() => loadAdminI18nDictionary())
		.catch(() => undefined);
	return adminDictPromise;
}

/**
 * Checks whether an i18n key exists in the loaded admin dictionary.
 *
 * @param {string} key - Fully qualified i18n key.
 * @returns {boolean} `true` when the key exists.
 */
function hasAdminKey(key) {
	const k = String(key || '');
	return !!k && Object.prototype.hasOwnProperty.call(adminDict, k);
}

/**
 * Host-internal: merges plugin-owned i18n translations into the runtime dictionary.
 * This is the actual mutation boundary. Both rules are enforced here, not in the caller:
 * 1. Namespace filter — only keys beginning with `msghub.i18n.<pluginType>.ui.` are admitted.
 * 2. No-overwrite — keys already present in the dictionary are never replaced.
 * Called exclusively by plugin-ui-host.js; not exposed via ctx.api.
 *
 * @param {string} pluginType - Plugin type identifier (e.g. 'IngestStates').
 * @param {Record<string, unknown>} translations - Raw key-value pairs from the bundle response.
 */
function mergePluginI18n(pluginType, translations) {
	if (!translations || typeof translations !== 'object' || Array.isArray(translations)) {
		return;
	}
	const prefix = `msghub.i18n.${pluginType}.ui.`;
	const additions = {};
	for (const [k, v] of Object.entries(translations)) {
		const ks = String(k ?? '');
		// Namespace filter: only keys in the plugin's own ui namespace are admitted.
		if (!ks.startsWith(prefix)) {
			continue;
		}
		// No-overwrite: existing core/plugin keys are never replaced.
		if (!hasAdminKey(ks)) {
			additions[ks] = String(v ?? '');
		}
	}
	if (Object.keys(additions).length > 0) {
		adminDict = Object.freeze({ ...adminDict, ...additions });
	}
}

/**
 * Translates an i18n key with simple `%s` placeholder replacement.
 *
 * @param {string} key - i18n key.
 * @param {...any} args - Placeholder values in order.
 * @returns {string} Translated value or the unchanged key.
 */
function t(key, ...args) {
	const k = String(key ?? '');
	let out = hasAdminKey(k) ? adminDict[k] : k;
	out = String(out ?? '');
	for (const arg of args) {
		out = out.replace('%s', String(arg));
	}
	return out;
}

/**
 * Resolves localizable text values defensively.
 *
 * Supports:
 * - direct strings, including i18n keys
 * - language-mapped objects such as `{ en: "...", de: "..." }`
 *
 * @param {any} value - Source value.
 * @returns {string} Resolved text.
 */
function pickText(value) {
	if (typeof value === 'string') {
		const s = value;
		return s.startsWith('msghub.i18n.') || hasAdminKey(s) ? t(s) : s;
	}
	if (!value || typeof value !== 'object') {
		return '';
	}
	const v = value[lang] ?? value.en ?? value.de;
	if (typeof v === 'string') {
		return v.startsWith('msghub.i18n.') || hasAdminKey(v) ? t(v) : v;
	}
	return '';
}

/**
 * Resolves an explicit URL theme override from query input only.
 *
 * `theme` is the canonical query parameter. When `theme` is present, `react` is
 * not consulted at all. The legacy `react` alias is only used as a fallback when
 * `theme` is absent.
 *
 * @param {object} query - Query object returned by `parseQuery()`.
 * @returns {'dark'|'light'|null} Explicit URL theme override or `null`.
 */
function resolveExplicitUrlTheme(query) {
	if (query && Object.prototype.hasOwnProperty.call(query, 'theme')) {
		const qTheme = typeof query?.theme === 'string' ? query.theme.trim().toLowerCase() : '';
		if (qTheme === 'dark' || qTheme === 'light') {
			return qTheme;
		}
		return null;
	}
	const qReact = typeof query?.react === 'string' ? query.react.trim().toLowerCase() : '';
	if (qReact === 'dark' || qReact === 'light') {
		return qReact;
	}
	return null;
}

/**
 * Resolves a theme from URL input with prefers-color-scheme fallback.
 *
 * @param {object} query - Query object returned by `parseQuery()`.
 * @returns {'dark'|'light'} Resolved theme value.
 */
function resolveTheme(query) {
	const fromUrl = resolveExplicitUrlTheme(query);
	if (fromUrl === 'dark' || fromUrl === 'light') {
		return fromUrl;
	}
	try {
		return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	} catch {
		return 'light';
	}
}

/**
 * Tries to derive the theme from localStorage-like keys.
 *
 * @returns {'dark'|'light'|null} Detected theme or `null`.
 */
function readThemeFromLocalStorage() {
	try {
		const ls = window.localStorage;
		if (!ls) {
			return null;
		}
		const keys = Object.keys(ls || {});
		for (const key of keys) {
			if (!/theme|mode|palette/i.test(key)) {
				continue;
			}
			const raw = ls.getItem(key);
			if (!raw) {
				continue;
			}
			const s = String(raw).toLowerCase();
			if (s === 'dark' || s.includes('"dark"') || s.includes(':dark') || s.includes('=dark')) {
				return 'dark';
			}
			if (s === 'light' || s.includes('"light"') || s.includes(':light') || s.includes('=light')) {
				return 'light';
			}
			try {
				const parsed = JSON.parse(raw);
				const t =
					typeof parsed?.theme === 'string'
						? parsed.theme
						: typeof parsed?.mode === 'string'
							? parsed.mode
							: typeof parsed?.paletteType === 'string'
								? parsed.paletteType
								: null;
				if (t === 'dark' || t === 'light') {
					return t;
				}
				if (parsed?.dark === true || parsed?.isDark === true) {
					return 'dark';
				}
				if (parsed?.light === true || parsed?.isLight === true) {
					return 'light';
				}
			} catch {
				// ignore
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Reads theme hints from the parent window used by the admin host.
 *
 * @returns {'dark'|'light'|null} Detected theme or `null`.
 */
function readThemeFromTopWindow() {
	try {
		if (!isEmbeddedInAdmin) {
			return null;
		}
		const topDoc = window.top && window.top.document ? window.top.document : null;
		if (!topDoc) {
			return null;
		}

		const html = topDoc.documentElement;
		const body = topDoc.body;
		const root = topDoc.getElementById('root');
		const candidates = [
			html && (html.getAttribute('data-theme') || html.getAttribute('data-react-theme') || html.className),
			body && (body.getAttribute('data-theme') || body.getAttribute('data-react-theme') || body.className),
			root && (root.getAttribute('data-theme') || root.getAttribute('data-react-theme') || root.className),
		]
			.filter(Boolean)
			.map(v => String(v).toLowerCase());

		for (const s of candidates) {
			if (/\bdark\b/.test(s) || /\btheme-dark\b/.test(s) || /\bdark-theme\b/.test(s)) {
				return 'dark';
			}
			if (/\blight\b/.test(s) || /\btheme-light\b/.test(s) || /\blight-theme\b/.test(s)) {
				return 'light';
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Writes the detected theme to the root element.
 *
 * @param {'dark'|'light'} nextTheme - Requested theme.
 */
function applyTheme(nextTheme) {
	const t = nextTheme === 'dark' ? 'dark' : 'light';
	const prev = document.documentElement.getAttribute('data-msghub-theme');
	if (prev === t) {
		return;
	}
	try {
		document.documentElement.setAttribute('data-msghub-theme', t);
	} catch {
		// ignore
	}
	if (debugTheme) {
		win.__msghubAdminTabTheme = t;
	}
}

/**
 * Combines all theme sources in fixed priority order.
 *
 * @returns {'dark'|'light'} Resulting theme.
 */
function detectTheme() {
	if (urlThemeLocked && (initialThemeFromQuery === 'dark' || initialThemeFromQuery === 'light')) {
		return initialThemeFromQuery;
	}
	if (isEmbeddedInAdmin) {
		const fromTop = readThemeFromTopWindow();
		if (fromTop === 'dark' || fromTop === 'light') {
			return fromTop;
		}
	}
	const fromStorage = readThemeFromLocalStorage();
	if (fromStorage === 'dark' || fromStorage === 'light') {
		return fromStorage;
	}
	if (!isEmbeddedInAdmin) {
		const fromTop = readThemeFromTopWindow();
		if (fromTop === 'dark' || fromTop === 'light') {
			return fromTop;
		}
	}
	if (initialThemeFromQuery === 'dark' || initialThemeFromQuery === 'light') {
		return initialThemeFromQuery;
	}
	try {
		return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	} catch {
		return 'light';
	}
}

void adapterInstance;
void msghubRequest;
void isEmbeddedInAdmin;
void overrideLang;
void ensureAdminI18nLoaded;
void mergePluginI18n;
void t;
void pickText;
void resolveTheme;
void urlThemeLocked;

// Apply the theme as early as possible to reduce visual flicker.
applyTheme(detectTheme());
