/* global window, location, document, io, win */
'use strict';

/**
 * MsgHub Admin Tab: Laufzeitgrundlagen (Query, Socket, i18n, Theme).
 *
 * Inhalt:
 * - Parsing der URL-Parameter und Ableitung von Adapter-Instanz/Language.
 * - Aufbau der Socket-Verbindung zum Admin-Backend.
 * - Laden und Zugriff auf Admin-i18n-Dictionaries.
 * - Theme-Ermittlung aus Query, Storage, Parent-Window und Fallbacks.
 *
 * Systemeinbindung:
 * - Stellt globale Runtime-Variablen bereit (`args`, `socket`, `lang`, ...),
 *   die von `api.js`, `layout.js` und `boot.js` verwendet werden.
 *
 * Schnittstellen:
 * - Utility-Funktionen wie `t`, `ensureAdminI18nLoaded`, `detectTheme`.
 * - Keine UI-Manipulation außer Setzen des Root-Theme-Attributs.
 */

/**
 * Liest Query-Parameter aus der URL und normalisiert Kernwerte.
 *
 * @returns {object} Normalisierte Query-Werte inkl. `instance` und `lang`.
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
		out[decodeURIComponent(k)] = v === undefined ? true : decodeURIComponent(v);
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
	return out;
}

/**
 * Baut die socket.io-Verbindung für Admin-Kontexte auf.
 *
 * @returns {any} Socket.io-Clientinstanz.
 */
function createSocket() {
	const path = location.pathname;
	const parts = path.split('/');
	parts.splice(-3);
	if (location.pathname.match(/^\/admin\//)) {
		parts.length = 0;
	}
	return io.connect('/', { path: `${parts.join('/')}/socket.io` });
}

const args = parseQuery();
const adapterInstance = `msghub.${args.instance}`;
const socket = createSocket();
const lang = typeof args.lang === 'string' ? args.lang : 'en';
const debugTheme = args.debugTheme === true || args.debugTheme === '1' || args.debugTheme === 'true';
const initialThemeFromQuery = resolveTheme(args);
// Wörterbuch und Lade-Promise sind bewusst im Modulzustand gehalten.
let adminDict = Object.freeze({});
let adminDictPromise = null;

/**
 * Normalisiert Sprach-Codes auf ein robustes Basisschema.
 *
 * @param {string} x - Rohwert (z. B. `de-DE`, `EN`).
 * @returns {string} Basissprache in lowercase.
 */
function normalizeLang(x) {
	const s = typeof x === 'string' ? x.trim().toLowerCase() : '';
	return s || 'en';
}

/**
 * Lädt JSON robust per Fetch und validiert den Grundtyp.
 *
 * @param {string} url - Relativer oder absoluter JSON-Pfad.
 * @returns {Promise<object>} Geparstes JSON-Objekt.
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
 * Lädt das Admin-i18n-Dictionary (Fallback `en` + aktuelle Sprache).
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
 * Sichert, dass das Dictionary nur einmal initial geladen wird.
 *
 * @returns {Promise<void>} Promise auf den Ladeprozess.
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
 * Prüft, ob ein i18n-Key im geladenen Admin-Dictionary existiert.
 *
 * @param {string} key - Vollständiger i18n-Key.
 * @returns {boolean} `true`, wenn der Key existiert.
 */
function hasAdminKey(key) {
	const k = String(key || '');
	return !!k && Object.prototype.hasOwnProperty.call(adminDict, k);
}

/**
 * Übersetzt einen i18n-Key mit einfacher `%s`-Platzhalterersetzung.
 *
 * @param {string} key - i18n-Key.
 * @param {...any} args - Platzhalterwerte in Reihenfolge.
 * @returns {string} Übersetzter oder unveränderter Schlüssel.
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
 * Ermittelt ein initiales Theme aus Query/Fallback.
 *
 * @param {object} query - Query-Objekt aus `parseQuery`.
 * @returns {'dark'|'light'} Ermitteltes Theme.
 */
function resolveTheme(query) {
	const qReact = typeof query?.react === 'string' ? query.react.trim().toLowerCase() : '';
	if (qReact === 'dark' || qReact === 'light') {
		return qReact;
	}
	const qTheme = typeof query?.theme === 'string' ? query.theme.trim().toLowerCase() : '';
	if (qTheme === 'dark' || qTheme === 'light') {
		return qTheme;
	}
	try {
		return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	} catch {
		return 'light';
	}
}

/**
 * Versucht, das Theme aus localStorage-ähnlichen Schlüsseln abzuleiten.
 *
 * @returns {'dark'|'light'|null} Erkanntes Theme oder `null`.
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
 * Liest Theme-Hinweise aus dem übergeordneten Fenster (Admin-Host).
 *
 * @returns {'dark'|'light'|null} Erkanntes Theme oder `null`.
 */
function readThemeFromTopWindow() {
	try {
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
 * Schreibt das erkannte Theme auf das Root-Element.
 *
 * @param {'dark'|'light'} nextTheme - Gewünschtes Theme.
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
 * Führt alle Theme-Quellen in fester Priorität zusammen.
 *
 * @returns {'dark'|'light'} Ergebnis-Theme.
 */
function detectTheme() {
	const fromStorage = readThemeFromLocalStorage();
	if (fromStorage === 'dark' || fromStorage === 'light') {
		return fromStorage;
	}
	const fromTop = readThemeFromTopWindow();
	if (fromTop === 'dark' || fromTop === 'light') {
		return fromTop;
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
void socket;
void ensureAdminI18nLoaded;
void t;

// Theme so früh wie möglich setzen, um visuelles Flackern zu reduzieren.
applyTheme(detectTheme());
