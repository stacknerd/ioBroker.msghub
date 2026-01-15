/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/* global window, document, location, MutationObserver */
'use strict';

const win = /** @type {any} */ (window);
const M = win.M;
const io = win.io;

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

let adminDict = Object.freeze({});
let adminDictPromise = null;

function normalizeLang(x) {
	const s = typeof x === 'string' ? x.trim().toLowerCase() : '';
	return s || 'en';
}

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

function ensureAdminI18nLoaded() {
	if (adminDictPromise) {
		return adminDictPromise;
	}
	adminDictPromise = Promise.resolve()
		.then(() => loadAdminI18nDictionary())
		.catch(() => undefined);
	return adminDictPromise;
}

function hasAdminKey(key) {
	const k = String(key || '');
	return !!k && Object.prototype.hasOwnProperty.call(adminDict, k);
}

function t(key, ...args) {
	const k = String(key ?? '');
	let out = hasAdminKey(k) ? adminDict[k] : k;
	out = String(out ?? '');
	for (const arg of args) {
		out = out.replace('%s', String(arg));
	}
	return out;
}

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
	} catch (_err) {
		return 'light';
	}
}

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
				} catch (_err) {
					// ignore
				}
		}
		return null;
	} catch (_err) {
		return null;
	}
}

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
	} catch (_err) {
		return null;
	}
}

function applyTheme(nextTheme) {
	const t = nextTheme === 'dark' ? 'dark' : 'light';
	const prev = document.documentElement.getAttribute('data-msghub-theme');
	if (prev === t) {
		return;
	}
	try {
		document.documentElement.setAttribute('data-msghub-theme', t);
	} catch (_err) {
		// ignore
	}
	if (debugTheme) {
		win.__msghubAdminTabTheme = t;
	}
}

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
	} catch (_err) {
		return 'light';
	}
}

applyTheme(detectTheme());

window.addEventListener('message', ev => {
	const dataRaw = ev?.data;
	let data = null;
	if (typeof dataRaw === 'string') {
		const s = dataRaw.trim();
		if (s === 'dark' || s === 'light') {
			data = { theme: s };
		} else {
			try {
				data = JSON.parse(s);
				} catch (_err) {
					data = null;
				}
		}
	} else if (dataRaw && typeof dataRaw === 'object') {
		data = dataRaw;
	}
	if (!data || typeof data !== 'object') {
		return;
	}
	const t =
		typeof data.theme === 'string'
			? data.theme
			: typeof data.mode === 'string'
				? data.mode
				: typeof data.paletteType === 'string'
					? data.paletteType
					: null;
	if (t === 'dark' || t === 'light') {
		applyTheme(t);
		return;
	}
	const dark =
		data.dark === true ||
		data.isDark === true ||
		data.mode === 'dark' ||
		data.paletteType === 'dark' ||
		data.theme === 'dark';
	const light =
		data.light === true ||
		data.isLight === true ||
		data.mode === 'light' ||
		data.paletteType === 'light' ||
		data.theme === 'light';
	if (dark || light) {
		applyTheme(dark ? 'dark' : 'light');
	}
});

window.addEventListener('storage', () => {
	applyTheme(detectTheme());
});

window.setInterval(() => {
	applyTheme(detectTheme());
}, 1500);

try {
	const topDoc = window.top && window.top.document ? window.top.document : null;
	if (topDoc) {
		const observer = new MutationObserver(() => {
			const t = readThemeFromTopWindow();
			if (t) {
				applyTheme(t);
			}
		});
		observer.observe(topDoc.documentElement, {
			attributes: true,
			subtree: true,
			attributeFilter: ['class', 'data-theme', 'data-react-theme'],
		});
	}
} catch (_err) {
	// ignore
}

function sendTo(command, message) {
	return new Promise((resolve, reject) => {
		socket.emit('sendTo', adapterInstance, command, message, res => {
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

function h(tag, attrs, children) {
	const el = document.createElement(tag);
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
				el.addEventListener(k.slice(2), v);
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
			el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
		}
	}
	return el;
}

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

const elements = Object.freeze({
	connection: document.getElementById('msghub-connection'),
	pluginsRoot: document.getElementById('plugins-root'),
	statsRoot: document.getElementById('stats-root'),
	messagesRoot: document.getElementById('messages-root'),
});

const ctx = Object.freeze({
	args,
	adapterInstance,
	socket,
	sendTo,
	h,
	t,
	pickText,
	M,
	lang,
	elements,
});

const setConnText = text => {
	if (elements.connection) {
		elements.connection.textContent = text;
	}
};

const setConnStatus = isOnline => {
	if (!elements.connection) {
		return;
	}
	elements.connection.classList.remove('online', 'offline');
	elements.connection.classList.add(isOnline ? 'online' : 'offline');
};

let pluginsSection = null;
let statsSection = null;
let messagesSection = null;

async function initSectionsIfAvailable() {
	await ensureAdminI18nLoaded();

	const pluginsApi = win.MsghubAdminTabPlugins;
	if (!pluginsSection && pluginsApi?.init) {
		pluginsSection = pluginsApi.init(ctx);
		if (socket?.connected) {
			pluginsSection?.onConnect?.();
		}
	}

	const statsApi = win.MsghubAdminTabStats;
	if (!statsSection && statsApi?.init) {
		statsSection = statsApi.init(ctx);
		if (socket?.connected) {
			statsSection?.onConnect?.();
		}
	}

	const messagesApi = win.MsghubAdminTabMessages;
	if (!messagesSection && messagesApi?.init) {
		messagesSection = messagesApi.init(ctx);
		if (socket?.connected) {
			messagesSection?.onConnect?.();
		}
	}
}

window.addEventListener('DOMContentLoaded', () => {
	M.Tabs.init(document.querySelectorAll('.tabs'), {});
	void initSectionsIfAvailable();
});

socket.on('connect', () => {
	setConnText(`connected (${adapterInstance})`);
	setConnStatus(true);
	void initSectionsIfAvailable();
	pluginsSection?.onConnect?.();
	statsSection?.onConnect?.();
	messagesSection?.onConnect?.();
});

socket.on('disconnect', () => {
	setConnText('disconnected');
	setConnStatus(false);
});
