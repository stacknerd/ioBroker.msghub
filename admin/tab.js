/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/* global window, document, location, MutationObserver */
'use strict';

const win = /** @type {any} */ (window);
const io = win.io;

/**
 * AdminTab UI registry (Phase 1 Contracts)
 *
 * Single source of truth for:
 * - Panels (ids, mount points, assets, init entry)
 * - Compositions/views (layout + panel list + deviceMode)
 *
 * Intentionally bundler/framework-free and attached to `window`.
 */
(() => {
	if (win.MsghubAdminTabRegistry) {
		return;
	}

	const panels = Object.freeze({
		stats: Object.freeze({
			id: 'stats',
			mountId: 'stats-root',
			titleKey: 'msghub.i18n.core.admin.ui.tabs.stats.label',
			initGlobal: 'MsghubAdminTabStats',
			assets: Object.freeze({
				css: Object.freeze(['tab.stats.css']),
				js: Object.freeze(['tab.stats.js']),
			}),
		}),

		messages: Object.freeze({
			id: 'messages',
			mountId: 'messages-root',
			titleKey: 'msghub.i18n.core.admin.ui.tabs.messages.label',
			initGlobal: 'MsghubAdminTabMessages',
			assets: Object.freeze({
				css: Object.freeze(['tab.messages.css']),
				js: Object.freeze(['tab.messages.js']),
			}),
		}),

		plugins: Object.freeze({
			id: 'plugins',
			mountId: 'plugins-root',
			titleKey: 'msghub.i18n.core.admin.ui.tabs.plugins.label',
			initGlobal: 'MsghubAdminTabPlugins',
			assets: Object.freeze({
				css: Object.freeze(['tab.plugins.css', 'tab.plugins.tools.ingeststates.css']),
				js: Object.freeze(['tab.plugins.js']),
			}),
		}),
	});

	const compositions = Object.freeze({
		adminTab: Object.freeze({
			id: 'adminTab',
			layout: 'tabs',
			panels: Object.freeze(['stats', 'messages', 'plugins']),
			defaultPanel: 'plugins',
			deviceMode: 'pc',
		}),
		dashboardStats: Object.freeze({
			id: 'dashboardStats',
			layout: 'single',
			panels: Object.freeze(['stats']),
			defaultPanel: 'stats',
			deviceMode: 'screenOnly',
		}),
	});

	win.MsghubAdminTabRegistry = Object.freeze({ panels, compositions });
})();

function createNotSupportedError(message) {
	const err = new Error(String(message || 'Not supported'));
	err.name = 'NotSupportedError';
	// @ts-ignore - non-standard, used as a lightweight discriminator
	err.code = 'NOT_SUPPORTED';
	return err;
}

function createAsyncCache(fetchFn, { maxAgeMs = Infinity } = {}) {
	let value = undefined;
	let hasValue = false;
	let pending = null;
	let fetchedAt = 0;

	const isFresh = () => {
		if (!hasValue) {
			return false;
		}
		if (maxAgeMs === Infinity) {
			return true;
		}
		const age = Date.now() - fetchedAt;
		return age >= 0 && age <= maxAgeMs;
	};

	const invalidate = () => {
		value = undefined;
		hasValue = false;
		pending = null;
		fetchedAt = 0;
	};

	const get = () => {
		if (isFresh()) {
			return Promise.resolve(value);
		}
		if (pending) {
			return pending;
		}
		pending = Promise.resolve()
			.then(() => fetchFn())
			.then(v => {
				value = v;
				hasValue = true;
				fetchedAt = Date.now();
				pending = null;
				return v;
			})
			.catch(err => {
				// Do not poison the cache on errors; allow retry.
				pending = null;
				throw err;
			});
		return pending;
	};

	return Object.freeze({ get, invalidate });
}

function createAdminApi({ sendTo, socket, adapterInstance, lang, t, ui }) {
	const registry = win.MsghubAdminTabRegistry || null;
	const viewIdRaw = document?.documentElement?.getAttribute?.('data-msghub-view') || '';
	const viewId = String(viewIdRaw || '').trim() || 'adminTab';
	const composition =
		registry && registry.compositions && typeof registry.compositions === 'object' ? registry.compositions[viewId] : null;
	const panelIds = Array.isArray(composition?.panels) ? composition.panels.filter(Boolean).map(v => String(v)) : [];
	const defaultPanelId = typeof composition?.defaultPanel === 'string' ? composition.defaultPanel : '';

	const logPrefix = `msghub:${viewId}`;
	const log = Object.freeze({
		debug: (...args) => console.debug(logPrefix, ...args),
		info: (...args) => console.info(logPrefix, ...args),
		warn: (...args) => console.warn(logPrefix, ...args),
		error: (...args) => console.error(logPrefix, ...args),
	});

	const i18n = Object.freeze({
		lang: () => String(lang || 'en'),
		t: (key, ...args) => t(String(key ?? ''), ...args),
	});

	const uiApi = Object.freeze({
		toast: opts => ui?.toast?.(opts),
		overlayLarge: ui?.overlayLarge || Object.freeze({ open: () => {}, close: () => {}, isOpen: () => false }),
		dialog: ui?.dialog || Object.freeze({ confirm: () => Promise.resolve(false), close: () => {}, isOpen: () => false }),
		closeAll: () => ui?.closeAll?.(),
	});

	const host = Object.freeze({
		viewId,
		layout: composition?.layout || 'tabs',
		deviceMode: composition?.deviceMode || 'pc',
		panels: Object.freeze(panelIds),
		defaultPanel: defaultPanelId,
		adapterInstance,
		isConnected: () => !!socket?.connected,
	});

	const notSupported = method => {
		throw createNotSupportedError(method);
	};

	const constantsCache = createAsyncCache(() => sendTo('admin.constants.get', {}), { maxAgeMs: Infinity });
	const ingestStatesConstantsCache = createAsyncCache(() => sendTo('admin.ingestStates.constants.get', {}), { maxAgeMs: Infinity });

	const constants = Object.freeze({
		get: () => constantsCache.get(),
		invalidate: () => constantsCache.invalidate(),
	});

	const stats = Object.freeze({
		get: params => sendTo('admin.stats.get', params || {}),
	});

	const messages = Object.freeze({
		query: params => sendTo('admin.messages.query', params || {}),
		delete: refs => sendTo('admin.messages.delete', { refs }),
	});

	const plugins = Object.freeze({
		getCatalog: () => sendTo('admin.plugins.getCatalog', {}),
		listInstances: () => sendTo('admin.plugins.listInstances', {}),
		createInstance: params => sendTo('admin.plugins.createInstance', params || {}),
		updateInstance: params => sendTo('admin.plugins.updateInstance', params || {}),
		setEnabled: params => sendTo('admin.plugins.setEnabled', params || {}),
		deleteInstance: params => sendTo('admin.plugins.deleteInstance', params || {}),
	});

	const ingestStates = Object.freeze({
		constants: Object.freeze({
			get: () => ingestStatesConstantsCache.get(),
			invalidate: () => ingestStatesConstantsCache.invalidate(),
		}),
		schema: Object.freeze({
			get: () => sendTo('admin.ingestStates.schema.get', {}),
		}),
		custom: Object.freeze({
			read: params => sendTo('admin.ingestStates.custom.read', params || {}),
		}),
		bulkApply: Object.freeze({
			preview: params => sendTo('admin.ingestStates.bulkApply.preview', params || {}),
			apply: params => sendTo('admin.ingestStates.bulkApply.apply', params || {}),
		}),
		presets: Object.freeze({
			list: () => sendTo('admin.ingestStates.presets.list', {}),
			get: params => sendTo('admin.ingestStates.presets.get', params || {}),
			delete: params => sendTo('admin.ingestStates.presets.delete', params || {}),
			upsert: params => sendTo('admin.ingestStates.presets.upsert', params || {}),
		}),
	});

	// Stable API surface: Panels should use ctx.api.* and not talk to sendTo/socket directly.
	return Object.freeze({
		i18n,
		ui: uiApi,
		log,
		host,
		constants,
		stats,
		messages,
		plugins,
		ingestStates,
		notSupported,
	});
}

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
	let dialogPrevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	let dialogPendingResolve = undefined;

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
			dialogPendingResolve = undefined;
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

			dialogPrevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;

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

function initTabs({ defaultPanelId = '' } = {}) {
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
		const fallback = defaultPanelId ? `tab-${String(defaultPanelId)}` : 'tab-plugins';
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

function getRegistry() {
	const r = win.MsghubAdminTabRegistry;
	return r && typeof r === 'object' ? r : null;
}

function getActiveComposition() {
	const registry = getRegistry();
	const viewIdRaw = document?.documentElement?.getAttribute?.('data-msghub-view') || '';
	const viewId = String(viewIdRaw || '').trim() || 'adminTab';
	const comp =
		registry && registry.compositions && typeof registry.compositions === 'object' ? registry.compositions[viewId] : null;
	return comp && typeof comp === 'object' ? comp : null;
}

function buildLayoutFromRegistry() {
	const registry = getRegistry();
	const comp = getActiveComposition() || { layout: 'tabs', panels: [], defaultPanel: '' };
	const layout = comp.layout === 'single' ? 'single' : 'tabs';
	const panelIds = Array.isArray(comp.panels) ? comp.panels.map(v => String(v)) : [];
	const defaultPanelId = typeof comp.defaultPanel === 'string' ? comp.defaultPanel : '';

	const root = document.querySelector('.msghub-root');
	const layoutHost = document.getElementById('msghub-layout') || root;
	if (!layoutHost) {
		return { layout, panelIds, defaultPanelId };
	}

	const getPanelDef = id => {
		const panels = registry?.panels && typeof registry.panels === 'object' ? registry.panels : null;
		const p = panels ? panels[id] : null;
		return p && typeof p === 'object' ? p : null;
	};

	const fragment = document.createDocumentFragment();

	if (layout === 'tabs') {
		const nav = h('nav', { class: 'msghub-tabs', role: 'tablist', 'aria-label': 'MsgHub' });
		for (const pid of panelIds) {
			const def = getPanelDef(pid);
			if (!def) {
				continue;
			}
			const tabId = `tab-${pid}`;
			nav.appendChild(
				h('a', {
					class: `msghub-tab${pid === defaultPanelId ? ' is-active' : ''}`,
					href: `#${tabId}`,
					role: 'tab',
					'aria-controls': tabId,
					'data-i18n': def.titleKey || '',
					text: pid,
				}),
			);
		}
		fragment.appendChild(nav);
	}

	for (const pid of panelIds) {
		const def = getPanelDef(pid);
		if (!def) {
			continue;
		}
		const tabId = `tab-${pid}`;
		const mountId = String(def.mountId || '').trim();
		const panel = h('div', {
			id: tabId,
			class: `msghub-panel msghub-${pid}`,
			role: 'tabpanel',
		});
		if (mountId) {
			panel.appendChild(h('div', { id: mountId }));
		}
		fragment.appendChild(panel);
	}

	layoutHost.replaceChildren(fragment);
	return { layout, panelIds, defaultPanelId };
}

function loadCssFiles(files) {
	const list = (Array.isArray(files) ? files : []).map(x => String(x || '').trim()).filter(Boolean);
	if (list.length === 0) {
		return Promise.resolve({ failed: [] });
	}
	const head = document.head || document.getElementsByTagName('head')[0];
	const existing = new Set(Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(l => l.getAttribute('href') || ''));

	const loads = [];
	const failed = [];
	for (const href of list) {
		if (existing.has(href)) {
			continue;
		}
		existing.add(href);
		loads.push(
			new Promise(resolve => {
				const link = document.createElement('link');
				link.rel = 'stylesheet';
				link.href = href;
				link.onload = () => resolve(undefined);
				link.onerror = () => {
					failed.push(href);
					resolve(undefined);
				};
				head.appendChild(link);
			}),
		);
	}
	return Promise.all(loads).then(() => ({ failed }));
}

function loadJsFilesSequential(files) {
	const list = (Array.isArray(files) ? files : []).map(x => String(x || '').trim()).filter(Boolean);
	if (list.length === 0) {
		return Promise.resolve();
	}
	const head = document.head || document.getElementsByTagName('head')[0];
	const existing = new Set(Array.from(document.querySelectorAll('script[src]')).map(s => s.getAttribute('src') || ''));

	const loadOne = src =>
		new Promise((resolve, reject) => {
			if (existing.has(src)) {
				return resolve(undefined);
			}
			existing.add(src);
			const script = document.createElement('script');
			script.src = src;
			script.async = false;
			script.defer = false;
			script.onload = () => resolve(undefined);
			script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
			head.appendChild(script);
		});

	let chain = Promise.resolve();
	for (const src of list) {
		chain = chain.then(() => loadOne(src));
	}
	return chain;
}

function computeAssetsForComposition(panelIds) {
	const registry = getRegistry();
	const panels = registry?.panels && typeof registry.panels === 'object' ? registry.panels : null;
	const css = [];
	const js = [];

	for (const pid of panelIds || []) {
		const def = panels ? panels[pid] : null;
		if (!def || typeof def !== 'object') {
			continue;
		}
		const assets = def.assets && typeof def.assets === 'object' ? def.assets : null;
		const cssList = Array.isArray(assets?.css) ? assets.css : [];
		const jsList = Array.isArray(assets?.js) ? assets.js : [];
		for (const c of cssList) {
			const s = String(c || '').trim();
			if (s && !css.includes(s)) {
				css.push(s);
			}
		}
		for (const s0 of jsList) {
			const s = String(s0 || '').trim();
			if (s && !js.includes(s)) {
				js.push(s);
			}
		}
	}

	return { css, js };
}

function getPanelDefinition(panelId) {
	const registry = getRegistry();
	const panels = registry?.panels && typeof registry.panels === 'object' ? registry.panels : null;
	const def = panels ? panels[panelId] : null;
	return def && typeof def === 'object' ? def : null;
}

function renderPanelBootError(panelId, err) {
	const panelEl = document.getElementById(`tab-${panelId}`);
	if (!panelEl) {
		return;
	}
	const msg = String(err?.message || err || 'Unknown error');
	panelEl.replaceChildren(
		h('div', { class: 'msghub-error', text: `Failed to load panel '${panelId}'.\n${msg}` }),
	);
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
	get connection() {
		return document.getElementById('msghub-connection');
	},
	get pluginsRoot() {
		return document.getElementById('plugins-root');
	},
	get statsRoot() {
		return document.getElementById('stats-root');
	},
	get messagesRoot() {
		return document.getElementById('messages-root');
	},
});

const ui = createUi();

const api = createAdminApi({ sendTo, socket, adapterInstance, lang, t, ui });

const ctx = Object.freeze({
	args,
	adapterInstance,
	socket,
	sendTo,
	api,
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

const setConnLayout = (layout, deviceMode) => {
	const el = elements.connection;
	const l = layout === 'single' ? 'single' : 'tabs';
	const d = deviceMode === 'mobile' || deviceMode === 'screenOnly' ? deviceMode : 'pc';
	try {
		document.documentElement.setAttribute('data-msghub-layout', l);
		document.documentElement.setAttribute('data-msghub-device', d);
	} catch {
		// ignore
	}
	if (el) {
		el.removeAttribute('data-msghub-layout');
		el.removeAttribute('data-msghub-device');
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

const panelSections = new Map();

function initPanelById(panelId) {
	const id = String(panelId || '').trim();
	if (!id) {
		return null;
	}
	if (panelSections.has(id)) {
		return panelSections.get(id) || null;
	}

	const def = getPanelDefinition(id);
	if (!def) {
		throw new Error(`Unknown panel '${id}'`);
	}
	const initGlobal = String(def.initGlobal || '').trim();
	if (!initGlobal) {
		throw new Error(`Panel '${id}' is missing initGlobal`);
	}

	const panelApi = win[initGlobal];
	if (!panelApi?.init) {
		throw new Error(`Panel '${id}' did not register '${initGlobal}.init'`);
	}

	const mountId = String(def.mountId || '').trim();
	const mountEl = mountId ? document.getElementById(mountId) : null;
	if (mountId && !mountEl) {
		throw new Error(`Panel '${id}' mountId '${mountId}' is missing in DOM`);
	}

	const section = panelApi.init(ctx);
	panelSections.set(id, section || null);
	return section || null;
}

async function initPanelsForComposition(panelIds) {
	const list = Array.isArray(panelIds) ? panelIds : [];
	for (const panelId of list) {
		const def = getPanelDefinition(panelId);
		if (!def) {
			continue;
		}
		const assets = def.assets && typeof def.assets === 'object' ? def.assets : null;
		const jsList = Array.isArray(assets?.js) ? assets.js : [];

		try {
			await loadJsFilesSequential(jsList);
		} catch (err) {
			renderPanelBootError(panelId, err);
			try {
				ui?.toast?.(String(err?.message || err));
			} catch {
				// ignore
			}
			continue;
		}

		try {
			const section = initPanelById(panelId);
			if (section && socket?.connected) {
				section?.onConnect?.();
			}
		} catch (err) {
			renderPanelBootError(panelId, err);
			try {
				ui?.toast?.(String(err?.message || err));
			} catch {
				// ignore
			}
		}
	}
}

let bootPromise = null;

function ensureBooted() {
	if (bootPromise) {
		return bootPromise;
	}
	bootPromise = Promise.resolve()
		.then(async () => {
			const { layout, panelIds, defaultPanelId } = buildLayoutFromRegistry();
			const comp = getActiveComposition();
			setConnLayout(layout, comp?.deviceMode);
			const assets = computeAssetsForComposition(panelIds);

			await ensureAdminI18nLoaded();
			const cssRes = await loadCssFiles(assets.css);
			if (cssRes?.failed?.length) {
				ui?.toast?.(`Failed to load CSS: ${cssRes.failed.join(', ')}`);
			}

			applyStaticI18n();
			setConnTextFromState();

			if (layout === 'tabs') {
				initTabs({ defaultPanelId });
			}

			await initPanelsForComposition(panelIds);
		})
		.catch(err => {
			try {
				ui?.toast?.(String(err?.message || err));
			} catch {
				// ignore
			}
		});
	return bootPromise;
}

window.addEventListener('DOMContentLoaded', () => {
	void ensureBooted();
});

socket.on('connect', () => {
	connOnline = true;
	setConnStatus(true);
	void ensureBooted().then(() => {
		applyStaticI18n();
		setConnTextFromState();
	});
	void ensureBooted().then(() => {
		for (const section of panelSections.values()) {
			section?.onConnect?.();
		}
	});
});

socket.on('disconnect', () => {
	connOnline = false;
	setConnStatus(false);
	void ensureAdminI18nLoaded().then(() => {
		applyStaticI18n();
		setConnTextFromState();
	});
});
