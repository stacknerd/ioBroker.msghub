/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/* global window, document, location, MutationObserver */
'use strict';

const win = /** @type {any} */ (window);
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

function createUi() {
	const root = document.querySelector('.msghub-root');

	const toastHost =
		document.getElementById('msghub-toast-host') ||
		(() => {
			const el = document.createElement('div');
			el.id = 'msghub-toast-host';
			el.className = 'msghub-toast-host is-hidden';
			el.setAttribute('aria-hidden', 'true');
			el.setAttribute('aria-live', 'polite');
			el.setAttribute('aria-atomic', 'true');
			el.setAttribute('aria-relevant', 'additions text');
			(root || document.body).appendChild(el);
			return el;
		})();

	const overlayBackdrop =
		document.getElementById('msghub-overlay-large') ||
		(() => {
			const el = document.createElement('div');
			el.id = 'msghub-overlay-large';
			el.className = 'msghub-overlay-backdrop is-hidden';
			el.setAttribute('aria-hidden', 'true');
			(root || document.body).appendChild(el);
			return el;
		})();
	const overlayTitle = /** @type {HTMLElement | null} */ (document.getElementById('msghub-overlay-large-title'));
	const overlayBody = /** @type {HTMLElement | null} */ (document.getElementById('msghub-overlay-large-body'));
	const overlayClose = /** @type {HTMLButtonElement | null} */ (document.getElementById('msghub-overlay-large-close'));

	const dialogBackdrop =
		document.getElementById('msghub-dialog-small') ||
		(() => {
			const el = document.createElement('div');
			el.id = 'msghub-dialog-small';
			el.className = 'msghub-dialog-backdrop is-hidden';
			el.setAttribute('aria-hidden', 'true');
			(root || document.body).appendChild(el);
			return el;
		})();
	const dialogTitle = /** @type {HTMLElement | null} */ (document.getElementById('msghub-dialog-small-title'));
	const dialogBody = /** @type {HTMLElement | null} */ (document.getElementById('msghub-dialog-small-body'));
	const dialogBtnCancel = /** @type {HTMLButtonElement | null} */ (document.getElementById('msghub-dialog-small-cancel'));
	const dialogBtnConfirm = /** @type {HTMLButtonElement | null} */ (document.getElementById('msghub-dialog-small-confirm'));

	const setRootModalOpen = isOpen => {
		if (root) {
			root.classList.toggle('is-modal-open', isOpen);
		}
	};

	// Toasts
	const toast = opts => {
		const text = typeof opts === 'string' ? opts : String(opts?.text ?? opts?.html ?? '');
		const timeoutMsRaw = typeof opts === 'object' && opts ? opts.timeoutMs : undefined;
		const timeoutMs = Number.isFinite(Number(timeoutMsRaw)) ? Math.max(250, Math.trunc(Number(timeoutMsRaw))) : 2500;
		if (!text.trim()) {
			return;
		}

		const el = document.createElement('div');
		el.className = 'msghub-toast';
		el.textContent = text;
		toastHost.appendChild(el);
		toastHost.classList.remove('is-hidden');
		toastHost.setAttribute('aria-hidden', 'false');

		window.setTimeout(() => {
			try {
				el.remove();
				if (!toastHost.childElementCount) {
					toastHost.classList.add('is-hidden');
					toastHost.setAttribute('aria-hidden', 'true');
				}
			} catch {
				// ignore
			}
		}, timeoutMs);
	};

	// Large overlay (viewer)
	let overlayIsOpen = false;
	let overlayPrevActive = /** @type {HTMLElement | null} */ (null);

	const overlaySetOpen = isOpen => {
		overlayIsOpen = isOpen;
		overlayBackdrop.classList.toggle('is-hidden', !isOpen);
		overlayBackdrop.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
		setRootModalOpen(isOpen || dialogIsOpen);
	};

	const overlayCloseFn = () => {
		if (!overlayIsOpen) {
			return;
		}
		overlaySetOpen(false);
		if (overlayBody) {
			overlayBody.replaceChildren();
		}
		try {
			overlayPrevActive?.focus?.();
		} catch {
			// ignore
		}
		overlayPrevActive = null;
	};

	const overlayOpen = opts => {
		const title = typeof opts?.title === 'string' ? opts.title : '';
		const bodyEl = opts?.bodyEl;

		overlayPrevActive = /** @type {HTMLElement | null} */ (document.activeElement instanceof HTMLElement ? document.activeElement : null);
		if (overlayTitle) {
			overlayTitle.textContent = title || '';
		}
		if (overlayBody) {
			if (bodyEl instanceof Node) {
				overlayBody.replaceChildren(bodyEl);
			} else if (typeof opts?.bodyText === 'string') {
				overlayBody.textContent = opts.bodyText;
			} else {
				overlayBody.replaceChildren();
			}
		}
		overlaySetOpen(true);
		try {
			overlayClose?.focus?.();
		} catch {
			// ignore
		}
	};

	if (overlayClose) {
		overlayClose.addEventListener('click', () => overlayCloseFn());
	}
	overlayBackdrop.addEventListener('click', e => {
		if (e?.target === overlayBackdrop) {
			overlayCloseFn();
		}
	});

	// Small dialog (confirm/prompt)
	let dialogIsOpen = false;
	let dialogPrevActive = /** @type {HTMLElement | null} */ (null);
	/** @type {(ok: boolean) => void | null} */
	let dialogPendingResolve = null;

	const dialogSetOpen = isOpen => {
		dialogIsOpen = isOpen;
		dialogBackdrop.classList.toggle('is-hidden', !isOpen);
		dialogBackdrop.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
		setRootModalOpen(isOpen || overlayIsOpen);
	};

	const dialogCloseFn = ok => {
		if (!dialogIsOpen) {
			return;
		}
		dialogSetOpen(false);
		if (typeof dialogPendingResolve === 'function') {
			const r = dialogPendingResolve;
			dialogPendingResolve = null;
			r(ok === true);
		}
		if (dialogBody) {
			dialogBody.replaceChildren();
		}
		try {
			dialogPrevActive?.focus?.();
		} catch {
			// ignore
		}
		dialogPrevActive = null;
	};

	if (dialogBtnCancel) {
		dialogBtnCancel.addEventListener('click', () => dialogCloseFn(false));
	}
	if (dialogBtnConfirm) {
		dialogBtnConfirm.addEventListener('click', () => dialogCloseFn(true));
	}
	dialogBackdrop.addEventListener('click', e => {
		if (e?.target === dialogBackdrop) {
			dialogCloseFn(false);
		}
	});

	document.addEventListener('keydown', e => {
		if (e.key !== 'Escape' && e.key !== 'Esc') {
			return;
		}
		if (dialogIsOpen) {
			e.preventDefault();
			dialogCloseFn(false);
			return;
		}
		if (overlayIsOpen) {
			e.preventDefault();
			overlayCloseFn();
		}
	});

	document.addEventListener('msghub:tabSwitch', () => {
		overlayCloseFn();
		dialogCloseFn(false);
	});

	const confirm = opts =>
		new Promise(resolve => {
			if (typeof dialogPendingResolve === 'function') {
				resolve(false);
				return;
			}

			dialogPrevActive = /** @type {HTMLElement | null} */ (
				document.activeElement instanceof HTMLElement ? document.activeElement : null
			);

			const title = typeof opts?.title === 'string' ? opts.title : '';
			const text = typeof opts?.text === 'string' ? opts.text : '';
			const bodyEl = opts?.bodyEl;
			const confirmText = typeof opts?.confirmText === 'string' ? opts.confirmText : 'OK';
			const cancelText = typeof opts?.cancelText === 'string' ? opts.cancelText : 'Cancel';
			const isDanger = opts?.danger === true;

			if (dialogTitle) {
				dialogTitle.textContent = title || '';
			}
			if (dialogBody) {
				if (bodyEl instanceof Node) {
					dialogBody.replaceChildren(bodyEl);
				} else {
					dialogBody.textContent = text;
				}
			}
			if (dialogBtnConfirm) {
				dialogBtnConfirm.textContent = confirmText;
				dialogBtnConfirm.classList.toggle('msghub-danger', isDanger);
			}
			if (dialogBtnCancel) {
				dialogBtnCancel.textContent = cancelText;
			}

			dialogPendingResolve = resolve;
			dialogSetOpen(true);
			try {
				dialogBtnCancel?.blur?.();
				dialogBtnConfirm?.focus?.();
			} catch {
				// ignore
			}
		});

	const closeAll = () => {
		overlayCloseFn();
		dialogCloseFn(false);
	};

	return Object.freeze({
		toast,
		overlayLarge: Object.freeze({
			open: overlayOpen,
			close: overlayCloseFn,
			isOpen: () => overlayIsOpen,
		}),
		dialog: Object.freeze({
			confirm,
			close: dialogCloseFn,
			isOpen: () => dialogIsOpen,
		}),
		closeAll,
	});
}

function initTabs() {
	const tabs = Array.from(document.querySelectorAll('.msghub-tab'));
	if (!tabs.length) {
		return;
	}

	const getTargetId = tab => {
		const href = tab.getAttribute('href') || '';
		return href.startsWith('#') ? href.slice(1) : '';
	};

	const panels = new Map();
	for (const tab of tabs) {
		const id = getTargetId(tab);
		if (!id) {
			continue;
		}
		const el = document.getElementById(id);
		if (el) {
			panels.set(id, el);
		}
	}

	let activeId = '';

	const setActive = id => {
		for (const tab of tabs) {
			const tid = getTargetId(tab);
			const isActive = tid === id;
			tab.classList.toggle('is-active', isActive);
			tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
			tab.setAttribute('tabindex', isActive ? '0' : '-1');
		}
		for (const [pid, panel] of panels.entries()) {
			panel.toggleAttribute('hidden', pid !== id);
		}
		if (activeId && activeId !== id) {
			try {
				document.dispatchEvent(new CustomEvent('msghub:tabSwitch', { detail: { from: activeId, to: id } }));
			} catch {
				// ignore
			}
		}
		activeId = id;
	};

	const initial = (() => {
		const h = String(location.hash || '');
		const candidate = h.startsWith('#') ? h.slice(1) : '';
		if (candidate && panels.has(candidate)) {
			return candidate;
		}
		const fromMarkup = tabs.find(t => t.classList.contains('is-active')) || null;
		const fromMarkupId = fromMarkup ? getTargetId(fromMarkup) : '';
		if (fromMarkupId && panels.has(fromMarkupId)) {
			return fromMarkupId;
		}
		const fallback = 'tab-plugins';
		return panels.has(fallback) ? fallback : panels.keys().next().value;
	})();

	setActive(initial);

	for (const tab of tabs) {
		tab.addEventListener('click', e => {
			e.preventDefault();
			const id = getTargetId(tab);
			if (!id || !panels.has(id)) {
				return;
			}
			try {
				history.replaceState(null, '', `#${id}`);
			} catch {
				// ignore
			}
			setActive(id);
		});
	}
}

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

const ui = createUi();

const ctx = Object.freeze({
	args,
	adapterInstance,
	socket,
	sendTo,
	h,
	t,
	pickText,
	ui,
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

let connOnline = false;

function applyStaticI18n() {
	for (const el of document.querySelectorAll('[data-i18n]')) {
		const key = String(el.getAttribute('data-i18n') || '').trim();
		if (!key) {
			continue;
		}
		el.textContent = pickText(key);
	}
}

function setConnTextFromState() {
	const key = connOnline
		? 'msghub.i18n.core.admin.ui.connection.connected.text'
		: 'msghub.i18n.core.admin.ui.connection.disconnected.text';
	setConnText(t(key, adapterInstance));
}

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
	initTabs();
	void ensureAdminI18nLoaded().then(() => {
		applyStaticI18n();
		setConnTextFromState();
	});
	void initSectionsIfAvailable();
});

socket.on('connect', () => {
	connOnline = true;
	setConnStatus(true);
	void ensureAdminI18nLoaded().then(() => {
		applyStaticI18n();
		setConnTextFromState();
	});
	void initSectionsIfAvailable();
	pluginsSection?.onConnect?.();
	statsSection?.onConnect?.();
	messagesSection?.onConnect?.();
});

socket.on('disconnect', () => {
	connOnline = false;
	setConnStatus(false);
	void ensureAdminI18nLoaded().then(() => {
		applyStaticI18n();
		setConnTextFromState();
	});
});
