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

function computeContextMenuPosition({
	anchorX,
	anchorY,
	menuWidth,
	menuHeight,
	viewportWidth,
	viewportHeight,
	mode,
	alignHeight,
	viewportPadding,
	cursorOffset,
}) {
	const VIEWPORT_PADDING = Number.isFinite(Number(viewportPadding)) ? Math.max(0, Math.trunc(Number(viewportPadding))) : 8;
	const CURSOR_OFFSET = Number.isFinite(Number(cursorOffset)) ? Math.max(0, Math.trunc(Number(cursorOffset))) : 2;

	const vw = Math.max(0, Math.trunc(Number(viewportWidth) || 0));
	const vh = Math.max(0, Math.trunc(Number(viewportHeight) || 0));
	const w = Math.max(0, Math.trunc(Number(menuWidth) || 0));
	const h = Math.max(0, Math.trunc(Number(menuHeight) || 0));

	const ax = Math.max(0, Math.trunc(Number(anchorX) || 0));
	const ay = Math.max(0, Math.trunc(Number(anchorY) || 0));

	const m = mode === 'submenu' ? 'submenu' : mode === 'anchor' ? 'anchor' : 'cursor';
	const ah = Math.max(0, Math.trunc(Number(alignHeight) || 0));

	// Initial preference:
	// - cursor: bottom-right-ish (so the cursor is not "inside" the menu)
	// - anchor: below-start (aligned to anchor left; add a small gap)
	// - submenu: right-start (aligned with parent top)
	let x = m === 'submenu' ? ax : m === 'anchor' ? ax : ax + CURSOR_OFFSET;
	let y = m === 'submenu' ? ay : ay + CURSOR_OFFSET;

	// Flip if we would overflow the viewport.
	if (vw && w && x + w > vw - VIEWPORT_PADDING) {
		x = ax - w - (m === 'cursor' ? CURSOR_OFFSET : 0);
	}
	if (vh && h && y + h > vh - VIEWPORT_PADDING) {
		if (m === 'submenu' && ah > 0) {
			// Align submenu to the parent bottom when flipping up, so it "sticks" to the row.
			y = ay + ah - h;
		} else {
			y = ay - h - CURSOR_OFFSET;
		}
	}

	// Clamp to viewport padding.
	if (vw) {
		x = Math.max(VIEWPORT_PADDING, Math.min(x, Math.max(VIEWPORT_PADDING, vw - VIEWPORT_PADDING - w)));
	} else {
		x = Math.max(VIEWPORT_PADDING, x);
	}
	if (vh) {
		y = Math.max(VIEWPORT_PADDING, Math.min(y, Math.max(VIEWPORT_PADDING, vh - VIEWPORT_PADDING - h)));
	} else {
		y = Math.max(VIEWPORT_PADDING, y);
	}

	return { x, y };
}

function toContextMenuIconVar(iconName) {
	const name = typeof iconName === 'string' ? iconName.trim() : '';
	if (!/^[a-z0-9-]+$/.test(name)) {
		return '';
	}
	return `var(--msghub-icon-${name})`;
}

	function createAdminApi({ sendTo, socket, adapterInstance, lang, t, pickText, ui }) {
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
			has: key => hasAdminKey(String(key ?? '')),
			t: (key, ...args) => t(String(key ?? ''), ...args),
			tOr: (key, fallback, ...args) => {
				const k = String(key ?? '');
				const out = t(k, ...args);
				return out === k ? String(fallback ?? '') : out;
			},
			pickText: value => pickText(value),
		});

	const rawContextMenu =
		ui?.contextMenu ||
		Object.freeze({
			open: () => {},
			close: () => {},
			isOpen: () => false,
		});

	const wrapContextMenuItems = items => {
		const list = Array.isArray(items) ? items : [];
		return list
			.filter(Boolean)
			.map(item => {
				const it = item && typeof item === 'object' ? item : {};
				const children = it.items ? wrapContextMenuItems(it.items) : undefined;
				const onSelectRaw = typeof it.onSelect === 'function' ? it.onSelect : null;

				const onSelect =
					onSelectRaw &&
					(() => {
						try {
							rawContextMenu.close();
						} catch {
							// ignore
						}

						let waitShown = false;
						let waitTimer = null;

						try {
							waitTimer = window.setTimeout(() => {
								waitShown = true;
								try {
									ui?.toast?.({ text: t('msghub.i18n.core.admin.ui.contextMenu.wait.text') });
								} catch {
									// ignore
								}
							}, 100);
						} catch {
							// ignore
						}

						const clearWaitTimer = () => {
							if (waitTimer == null) {
								return;
							}
							try {
								window.clearTimeout(waitTimer);
							} catch {
								// ignore
							}
							waitTimer = null;
						};

						return Promise.resolve()
							.then(() => onSelectRaw())
							.then(result => {
								clearWaitTimer();
								if (waitShown) {
									try {
										ui?.toast?.({ text: t('msghub.i18n.core.admin.ui.contextMenu.done.text') });
									} catch {
										// ignore
									}
								}
								return result;
							})
							.catch(err => {
								clearWaitTimer();
								const msg =
									typeof err?.message === 'string' && err.message.trim()
										? err.message.trim()
										: typeof err === 'string' && err.trim()
											? err.trim()
											: 'Error';
								try {
									ui?.toast?.({ text: t('msghub.i18n.core.admin.ui.contextMenu.failed.text', msg) });
								} catch {
									// ignore
								}
								throw err;
							});
					});

				return Object.freeze({
					...it,
					...(children ? { items: children } : {}),
					...(onSelect ? { onSelect } : {}),
				});
			});
	};

	const uiApi = Object.freeze({
		toast: opts => ui?.toast?.(opts),
		contextMenu: Object.freeze({
			open: opts => {
				const o = opts && typeof opts === 'object' ? opts : {};
				const items = wrapContextMenuItems(o.items);
				return rawContextMenu.open({ ...o, items });
			},
			close: () => rawContextMenu.close(),
			isOpen: () => rawContextMenu.isOpen(),
		}),
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

	const runtime = Object.freeze({
		about: () => sendTo('runtime.about', {}),
	});

	// Stable API surface: Panels should use ctx.api.* and not talk to sendTo/socket directly.
	return Object.freeze({
		i18n,
		ui: uiApi,
		log,
		host,
		constants,
		runtime,
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

	// Context menu (Phase 2: DOM + minimal CSS; always in DOM, default-hidden)
	const contextMenuHost =
		document.getElementById('msghub-contextmenu') ||
		(() => {
			const el = document.createElement('div');
			el.id = 'msghub-contextmenu';
			el.className = 'msghub-contextmenu-host is-hidden';
			el.setAttribute('aria-hidden', 'true');
			(root || document.body).appendChild(el);
			return el;
		})();

	const contextMenuEl = document.createElement('div');
	contextMenuEl.className = 'msghub-contextmenu';
	contextMenuHost.appendChild(contextMenuEl);

	const contextMenuList = document.createElement('ul');
	contextMenuList.className = 'msghub-contextmenu-list';
	contextMenuList.setAttribute('role', 'menu');
	contextMenuEl.appendChild(contextMenuList);

	let contextMenuBrandingText = 'Message Hub v0.0.1';

	let contextMenuIsOpen = false;
	/** @type {any} */
	let contextMenuState = null;
	/** @type {Array<{ menuEl: HTMLDivElement, listEl: HTMLUListElement, parentButton: HTMLButtonElement | null }>} */
	const contextMenuStack = [];

	const contextMenuSetOpen = isOpen => {
		contextMenuIsOpen = !!isOpen;
		contextMenuHost.classList.toggle('is-hidden', !contextMenuIsOpen);
		contextMenuHost.setAttribute('aria-hidden', contextMenuIsOpen ? 'false' : 'true');
	};

	const ensureMenuInStack = (menuEl, listEl, parentButton) => {
		if (!contextMenuStack.length) {
			contextMenuStack.push({ menuEl, listEl, parentButton: parentButton || null });
		}
	};

	const closeContextMenuLevel = depth => {
		const d = Math.max(0, Math.trunc(Number(depth) || 0));
		while (contextMenuStack.length > d + 1) {
			const last = contextMenuStack.pop();
			try {
				last?.parentButton?.classList?.remove?.('is-submenu-open');
			} catch {
				// ignore
			}
			try {
				last?.menuEl?.remove?.();
			} catch {
				// ignore
			}
		}
	};

	const closeAllContextMenus = () => {
		closeContextMenuLevel(0);
		contextMenuState = null;
		contextMenuSetOpen(false);
	};

	const renderContextMenuItems = (listEl, items, depth = 0) => {
		const hoverEnabled = (() => {
			try {
				return window.matchMedia && !window.matchMedia('(pointer: coarse)').matches;
			} catch {
				return true;
			}
		})();
		const HOVER_DELAY_MS = 150;
		let hoverTimer = null;
		/** @type {HTMLButtonElement | null} */
		let hoverBtn = null;

		const list = Array.isArray(items) ? items : [];
		const nodes = [];

		for (const item of list) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const type = typeof item.type === 'string' ? item.type : 'item';

			if (type === 'separator') {
				const li = document.createElement('li');
				li.setAttribute('role', 'none');
				const sep = document.createElement('div');
				sep.className = 'msghub-contextmenu-separator';
				sep.setAttribute('aria-hidden', 'true');
				li.appendChild(sep);
				nodes.push(li);
				continue;
			}

			if (type === 'label') {
				const label = typeof item.label === 'string' ? item.label : '';
				if (!label) {
					continue;
				}
				const li = document.createElement('li');
				li.setAttribute('role', 'none');

				const heading = document.createElement('div');
				heading.className = 'msghub-contextmenu-heading';

				const slot = document.createElement('span');
				slot.className = 'msghub-contextmenu-icon-slot';
				heading.appendChild(slot);

				const text = document.createElement('span');
				text.className = 'msghub-contextmenu-heading-text';
				text.textContent = label;
				heading.appendChild(text);

				li.appendChild(heading);
				nodes.push(li);
				continue;
			}

			if (type === 'checkbox') {
				const label = typeof item.label === 'string' ? item.label : '';
				const shortcut = typeof item.shortcut === 'string' ? item.shortcut : '';
				const disabled = !!item.disabled;
				const danger = item.danger === true;
				const primary = item.primary === true;
				const checked = item.checked === true;
				const id = typeof item.id === 'string' ? item.id.trim() : '';

				const li = document.createElement('li');
				li.setAttribute('role', 'none');

				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'msghub-contextmenu-item';
				btn.classList.add('msghub-contextmenu-item--checkbox');
				btn.setAttribute('role', 'menuitemcheckbox');
				btn.setAttribute('aria-checked', checked ? 'true' : 'false');
				if (id) {
					btn.setAttribute('data-msghub-contextmenu-id', id);
				}
				btn.disabled = disabled;
				if (disabled) {
					btn.setAttribute('aria-disabled', 'true');
				}
				if (danger) {
					btn.classList.add('is-danger');
				}
				if (primary) {
					btn.classList.add('is-primary');
				}

				const row = document.createElement('span');
				row.className = 'msghub-contextmenu-row';

				/** @type {HTMLElement | null} */
				let checkIconEl = null;
				{
					const slot = document.createElement('span');
					slot.className = 'msghub-contextmenu-icon-slot';
					const iconEl = document.createElement('span');
					iconEl.className = 'msghub-contextmenu-icon';
					iconEl.setAttribute('aria-hidden', 'true');
					iconEl.style.setProperty('--msghub-contextmenu-icon', toContextMenuIconVar('check'));
					slot.appendChild(iconEl);
					checkIconEl = iconEl;
					row.appendChild(slot);
				}

				const labelEl = document.createElement('span');
				labelEl.className = 'msghub-contextmenu-label';
				labelEl.textContent = label;
				row.appendChild(labelEl);

				const meta = document.createElement('span');
				meta.className = 'msghub-contextmenu-meta';
				if (shortcut) {
					const s = document.createElement('span');
					s.className = 'msghub-contextmenu-shortcut';
					s.textContent = shortcut;
					meta.appendChild(s);
				}
				row.appendChild(meta);

				btn.appendChild(row);

				const setCheckedUI = isChecked => {
					btn.setAttribute('aria-checked', isChecked ? 'true' : 'false');
					if (checkIconEl) {
						checkIconEl.style.opacity = isChecked ? '1' : '0';
					}
				};

				setCheckedUI(checked);

				if (!disabled && typeof item.onToggle === 'function') {
					btn.addEventListener('click', () => {
						const next = btn.getAttribute('aria-checked') !== 'true';
						setCheckedUI(next);
						Promise.resolve()
							.then(() => item.onToggle(next))
							.catch(() => {
								// On error: revert optimistic UI.
								setCheckedUI(!next);
							});
					});
				} else if (!disabled && typeof item.onSelect === 'function') {
					btn.addEventListener('click', () => {
						Promise.resolve()
							.then(() => item.onSelect())
							.catch(() => undefined);
					});
				}

				li.appendChild(btn);
				nodes.push(li);
				continue;
			}

			const label = typeof item.label === 'string' ? item.label : '';
			const shortcut = typeof item.shortcut === 'string' ? item.shortcut : '';
			const hasSubmenu = Array.isArray(item.items) && item.items.length > 0;
			const disabled = !!item.disabled;
			const danger = item.danger === true;
			const primary = item.primary === true;
			const icon = toContextMenuIconVar(item.icon);
			const id = typeof item.id === 'string' ? item.id.trim() : '';

			const li = document.createElement('li');
			li.setAttribute('role', 'none');

			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'msghub-contextmenu-item';
			btn.setAttribute('role', 'menuitem');
			if (id) {
				btn.setAttribute('data-msghub-contextmenu-id', id);
			}
			btn.disabled = disabled;
			if (disabled) {
				btn.setAttribute('aria-disabled', 'true');
			}
			if (danger) {
				btn.classList.add('is-danger');
			}
			if (primary) {
				btn.classList.add('is-primary');
			}
			if (hasSubmenu) {
				btn.classList.add('has-submenu');
			}

			const row = document.createElement('span');
			row.className = 'msghub-contextmenu-row';

			{
				const slot = document.createElement('span');
				slot.className = 'msghub-contextmenu-icon-slot';
				if (icon) {
					const iconEl = document.createElement('span');
					iconEl.className = 'msghub-contextmenu-icon';
					iconEl.setAttribute('aria-hidden', 'true');
					iconEl.style.setProperty('--msghub-contextmenu-icon', icon);
					slot.appendChild(iconEl);
				}
				row.appendChild(slot);
			}

			const labelEl = document.createElement('span');
			labelEl.className = 'msghub-contextmenu-label';
			labelEl.textContent = label;
			row.appendChild(labelEl);

			const meta = document.createElement('span');
			meta.className = 'msghub-contextmenu-meta';

			if (shortcut) {
				const s = document.createElement('span');
				s.className = 'msghub-contextmenu-shortcut';
				s.textContent = shortcut;
				meta.appendChild(s);
			}

			if (hasSubmenu) {
				const arrow = document.createElement('span');
				arrow.className = 'msghub-contextmenu-submenu';
				arrow.setAttribute('aria-hidden', 'true');
				arrow.textContent = '›';
				meta.appendChild(arrow);
			}

			row.appendChild(meta);
			btn.appendChild(row);

			if (!disabled && hasSubmenu) {
				btn.addEventListener('click', () => {
					openSubmenu(depth + 1, btn, item.items);
				});

				if (hoverEnabled) {
					btn.addEventListener('pointerenter', () => {
						try {
							if (hoverTimer != null) {
								window.clearTimeout(hoverTimer);
							}
						} catch {
							// ignore
						}
						hoverBtn = btn;
						try {
							hoverTimer = window.setTimeout(() => {
								if (hoverBtn === btn) {
									openSubmenu(depth + 1, btn, item.items);
								}
							}, HOVER_DELAY_MS);
						} catch {
							// ignore
						}
					});
					btn.addEventListener('pointerleave', () => {
						try {
							if (hoverTimer != null) {
								window.clearTimeout(hoverTimer);
							}
						} catch {
							// ignore
						}
						hoverTimer = null;
						if (hoverBtn === btn) {
							hoverBtn = null;
						}
					});
				}
			} else if (!disabled && typeof item.onSelect === 'function') {
				btn.addEventListener('click', () => {
					Promise.resolve()
						.then(() => item.onSelect())
						.catch(() => undefined);
				});
			}

			li.appendChild(btn);
			nodes.push(li);
		}

		if (depth === 0) {
			// Branding footer (always present on root, disabled/non-interactive).
			const footerLi = document.createElement('li');
			footerLi.setAttribute('role', 'none');

			const footer = document.createElement('div');
			footer.className = 'msghub-contextmenu-footer';

			const slot = document.createElement('span');
			slot.className = 'msghub-contextmenu-icon-slot';
			footer.appendChild(slot);

			const text = document.createElement('span');
			text.className = 'msghub-contextmenu-footer-text';
			text.textContent = String(contextMenuBrandingText || '').trim() || 'Message Hub';
			footer.appendChild(text);

			footerLi.appendChild(footer);
			nodes.push(footerLi);
		}

		listEl.replaceChildren(...nodes);
	};

	const applyContextMenuAnchor = state => {
		const s = state && typeof state === 'object' ? state : {};
		const p = s.anchorPoint && typeof s.anchorPoint === 'object' ? s.anchorPoint : null;
		const el = s.anchorEl instanceof HTMLElement ? s.anchorEl : null;

		let x = 0;
		let y = 0;
		if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
			x = Math.max(0, Math.trunc(Number(p.x)));
			y = Math.max(0, Math.trunc(Number(p.y)));
		} else if (el) {
			try {
				const r = el.getBoundingClientRect();
				x = Math.max(0, Math.trunc(r.left));
				y = Math.max(0, Math.trunc(r.bottom));
			} catch {
				// ignore
			}
		}
		return { x, y };
	};

	const positionMenuWithClamp = (menuEl, anchorX, anchorY, { mode = 'cursor', alignHeight = 0, cursorOffset = 2 } = {}) => {
		// Force layout: measure menu after it's in DOM and visible (visibility:hidden is fine).
		let rect;
		try {
			rect = menuEl.getBoundingClientRect();
		} catch {
			rect = null;
		}
		const w = rect ? Math.max(0, Math.ceil(rect.width)) : 0;
		const h = rect ? Math.max(0, Math.ceil(rect.height)) : 0;
		const vw = Math.max(0, Math.trunc(Number(window.innerWidth) || 0));
		const vh = Math.max(0, Math.trunc(Number(window.innerHeight) || 0));

		const pos = computeContextMenuPosition({
			anchorX,
			anchorY,
			menuWidth: w,
			menuHeight: h,
			viewportWidth: vw,
			viewportHeight: vh,
			mode,
			alignHeight,
			viewportPadding: 8,
			cursorOffset,
		});

		menuEl.style.left = `${pos.x}px`;
		menuEl.style.top = `${pos.y}px`;
	};

	const onContextMenuDocPointerDown = ev => {
		if (!contextMenuIsOpen) {
			return;
		}
		const target = ev?.target;
		if (target && contextMenuHost.contains(target)) {
			return;
		}
		contextMenuClose();
	};

	document.addEventListener('pointerdown', onContextMenuDocPointerDown, true);

	const onContextMenuWheel = ev => {
		if (!contextMenuIsOpen) {
			return;
		}
		const target = ev?.target;
		if (target && contextMenuHost.contains(target)) {
			return;
		}
		contextMenuClose();
	};
	document.addEventListener('wheel', onContextMenuWheel, { capture: true, passive: true });

	const onContextMenuScroll = ev => {
		if (!contextMenuIsOpen) {
			return;
		}
		const target = ev?.target;
		if (target && contextMenuHost.contains(target)) {
			return;
		}
		contextMenuClose();
	};
	// Use capture to also catch scroll on nested containers (scroll doesn't bubble).
	window.addEventListener('scroll', onContextMenuScroll, true);

	const onContextMenuResize = () => {
		if (!contextMenuIsOpen) {
			return;
		}
		contextMenuClose();
	};
	window.addEventListener('resize', onContextMenuResize, { passive: true });

	const onContextMenuVisibility = () => {
		if (!contextMenuIsOpen) {
			return;
		}
		if (document.visibilityState === 'hidden') {
			contextMenuClose();
		}
	};
	document.addEventListener('visibilitychange', onContextMenuVisibility);

	const contextMenuOpen = opts => {
		const o = opts && typeof opts === 'object' ? opts : {};
		const items = Array.isArray(o.items) ? o.items : [];
		const anchorPoint = o.anchorPoint && typeof o.anchorPoint === 'object' ? o.anchorPoint : null;
		const anchorEl = o.anchorEl instanceof HTMLElement ? o.anchorEl : null;
		const placement = typeof o.placement === 'string' ? o.placement : '';
		const ariaLabel = typeof o.ariaLabel === 'string' ? o.ariaLabel : '';

		contextMenuState = Object.freeze({ items, anchorPoint, anchorEl, placement, ariaLabel });
		contextMenuList.setAttribute('aria-label', ariaLabel || 'Context menu');
		ensureMenuInStack(contextMenuEl, contextMenuList, null);
		closeContextMenuLevel(0);
		renderContextMenuItems(contextMenuList, items, 0);
		contextMenuSetOpen(true);

		// Positioning (Phase 3): measure, flip/clamp to viewport, avoid cursor-on-item.
		const anchor = applyContextMenuAnchor(contextMenuState);
		contextMenuEl.style.visibility = 'hidden';
		const mode = placement === 'anchor' || placement === 'below-start' ? 'anchor' : 'cursor';
		positionMenuWithClamp(contextMenuEl, anchor.x, anchor.y, { mode, cursorOffset: mode === 'anchor' ? 4 : 2 });
		contextMenuEl.style.visibility = '';

		try {
			document.dispatchEvent(new CustomEvent('msghub:contextMenuOpen', { detail: contextMenuState }));
		} catch {
			// ignore
		}
	};

	const contextMenuClose = () => {
		if (!contextMenuIsOpen) {
			return;
		}
		closeAllContextMenus();
		try {
			document.dispatchEvent(new CustomEvent('msghub:contextMenuClose'));
		} catch {
			// ignore
		}
	};

	const openSubmenu = (depth, parentButton, items) => {
		if (!contextMenuIsOpen) {
			return;
		}
		const d = Math.max(1, Math.trunc(Number(depth) || 1));
		if (!(parentButton instanceof HTMLButtonElement)) {
			return;
		}
		const childItems = Array.isArray(items) ? items : [];

		closeContextMenuLevel(d - 1);

		// Mark the triggering item as active while its submenu is open.
		try {
			for (const entry of contextMenuStack) {
				entry?.parentButton?.classList?.remove?.('is-submenu-open');
			}
		} catch {
			// ignore
		}
		try {
			parentButton.classList.add('is-submenu-open');
		} catch {
			// ignore
		}

		const menuEl = document.createElement('div');
		menuEl.className = 'msghub-contextmenu';
		contextMenuHost.appendChild(menuEl);

		const listEl = document.createElement('ul');
		listEl.className = 'msghub-contextmenu-list';
		listEl.setAttribute('role', 'menu');
		menuEl.appendChild(listEl);

		contextMenuStack.push({ menuEl, listEl, parentButton });

		menuEl.style.visibility = 'hidden';
		renderContextMenuItems(listEl, childItems, d);
		try {
			const r = parentButton.getBoundingClientRect();
			positionMenuWithClamp(menuEl, r.right, r.top, { mode: 'submenu', alignHeight: Math.ceil(r.height) });
		} catch {
			// ignore
		}
		menuEl.style.visibility = '';
	};

	const contextMenu = Object.freeze({
		open: contextMenuOpen,
		close: contextMenuClose,
		isOpen: () => contextMenuIsOpen,
		setBrandingText: text => {
			contextMenuBrandingText = String(text ?? '').trim() || contextMenuBrandingText;
		},
	});

	// Large overlay (viewer)
	let overlayIsOpen = false;
	let overlayPrevActive = /** @type {HTMLElement | null} */ (null);

	const parseCssTimeToMs = s => {
		const str = String(s || '').trim();
		if (!str) {
			return 0;
		}
		if (str.endsWith('ms')) {
			const n = Number(str.slice(0, -2).trim());
			return Number.isFinite(n) ? n : 0;
		}
		if (str.endsWith('s')) {
			const n = Number(str.slice(0, -1).trim());
			return Number.isFinite(n) ? n * 1000 : 0;
		}
		const n = Number(str);
		return Number.isFinite(n) ? n : 0;
	};

	const getMaxTransitionMs = el => {
		try {
			const cs = window.getComputedStyle(el);
			const durs = String(cs.transitionDuration || '0s')
				.split(',')
				.map(x => parseCssTimeToMs(x));
			const delays = String(cs.transitionDelay || '0s')
				.split(',')
				.map(x => parseCssTimeToMs(x));
			const n = Math.max(durs.length, delays.length);
			let max = 0;
			for (let i = 0; i < n; i++) {
				const dur = durs[i % durs.length] || 0;
				const delay = delays[i % delays.length] || 0;
				max = Math.max(max, dur + delay);
			}
			return Number.isFinite(max) ? max : 0;
		} catch {
			return 0;
		}
	};

	const setBackdropOpenAnimated = (el, isOpen) => {
		if (!el) {
			return;
		}
		try {
			if (el._msghubHideTimer) {
				clearTimeout(el._msghubHideTimer);
			}
		} catch {
			// ignore
		}

		if (isOpen) {
			el.classList.remove('is-hidden');
			el.classList.remove('is-closing');
			el.classList.remove('is-open');
			window.requestAnimationFrame(() => {
				el.classList.add('is-open');
			});
			return;
		}

		el.classList.remove('is-open');
		el.classList.add('is-closing');

		const ms = getMaxTransitionMs(el);
		el._msghubHideTimer = window.setTimeout(() => {
			el.classList.add('is-hidden');
			el.classList.remove('is-closing');
		}, Math.max(0, ms) + 30);
	};

	const overlaySetOpen = isOpen => {
		overlayIsOpen = isOpen;
		overlayBackdrop.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
		setBackdropOpenAnimated(overlayBackdrop, isOpen);
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
		dialogBackdrop.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
		setBackdropOpenAnimated(dialogBackdrop, isOpen);
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
			if (contextMenuIsOpen) {
				e.preventDefault();
				// Phase 6: close submenu first, then root menu.
				if (Array.isArray(contextMenuStack) && contextMenuStack.length > 1) {
					closeContextMenuLevel(contextMenuStack.length - 2);
				} else {
					contextMenuClose();
				}
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
		contextMenuClose();
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
		contextMenuClose();
	};

	return Object.freeze({
		toast,
		contextMenu,
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
		ui?.contextMenu?.setBrandingText?.('Message Hub');

		const api = createAdminApi({ sendTo, socket, adapterInstance, lang, t, pickText, ui });

			const ctx = Object.freeze({
				args,
				adapterInstance,
				socket,
				sendTo,
				api,
				h,
				ui,
				lang,
				elements,
			});

			void api?.runtime
				?.about?.()
				.then(res => {
					const data = res && typeof res === 'object' ? res : null;
					const title = typeof data?.title === 'string' ? data.title.trim() : '';
					const version = typeof data?.version === 'string' ? data.version.trim() : '';
					const label = `${title || 'Message Hub'} v${version || '0.0.0'}`;
					ui?.contextMenu?.setBrandingText?.(label);
				})
				.catch(() => undefined);

		function findEditableTarget(el) {
			const node = el instanceof HTMLElement ? el : null;
			if (!node) {
				return null;
		}
		const input = node.closest('input');
		if (input instanceof HTMLInputElement) {
			const type = String(input.type || '').toLowerCase();
			const textLike =
				!type ||
				type === 'text' ||
				type === 'search' ||
				type === 'url' ||
				type === 'tel' ||
				type === 'email' ||
				type === 'password' ||
				type === 'number';
			if (textLike && !input.readOnly && !input.disabled) {
				return input;
			}
		}
		const ta = node.closest('textarea');
		if (ta instanceof HTMLTextAreaElement && !ta.readOnly && !ta.disabled) {
			return ta;
		}
		const ce = node.closest('[contenteditable]');
		if (ce instanceof HTMLElement && ce.isContentEditable) {
			return ce;
		}
		return null;
	}

	function getEditableSelectionInfo(editable) {
		if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
			const start = Number.isFinite(Number(editable.selectionStart)) ? Number(editable.selectionStart) : 0;
			const end = Number.isFinite(Number(editable.selectionEnd)) ? Number(editable.selectionEnd) : 0;
			const hasSelection = end > start;
			const value = String(editable.value || '');
			const selectedText = hasSelection ? value.slice(start, end) : '';
			return { hasSelection, selectedText, start, end };
		}
		if (editable instanceof HTMLElement) {
			const sel = window.getSelection ? window.getSelection() : null;
			if (!sel || sel.rangeCount <= 0) {
				return { hasSelection: false, selectedText: '', start: 0, end: 0 };
			}
			const text = sel.toString();
			const range = sel.getRangeAt(0);
			const inEl = !!range && editable.contains(range.commonAncestorContainer);
			return { hasSelection: inEl && !!text, selectedText: inEl ? text : '', start: 0, end: 0 };
		}
		return { hasSelection: false, selectedText: '', start: 0, end: 0 };
	}

	function selectAllInEditable(editable) {
		if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
			editable.focus();
			editable.select();
			return;
		}
		if (editable instanceof HTMLElement) {
			editable.focus();
			const sel = window.getSelection ? window.getSelection() : null;
			if (!sel) {
				return;
			}
			const range = document.createRange();
			range.selectNodeContents(editable);
			sel.removeAllRanges();
			sel.addRange(range);
		}
	}

	function execCommandSafe(cmd) {
		try {
			if (typeof document.execCommand === 'function') {
				return document.execCommand(cmd);
			}
		} catch {
			// ignore
		}
		return false;
	}

	async function copySelectionFromEditable(editable) {
		editable.focus();
		if (execCommandSafe('copy')) {
			return;
		}
		const info = getEditableSelectionInfo(editable);
		if (!info.selectedText) {
			return;
		}
		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			await navigator.clipboard.writeText(info.selectedText);
			return;
		}
		throw new Error('Copy not supported');
	}

	async function cutSelectionFromEditable(editable) {
		editable.focus();
		if (execCommandSafe('cut')) {
			return;
		}
		const info = getEditableSelectionInfo(editable);
		if (!info.selectedText) {
			return;
		}
		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			await navigator.clipboard.writeText(info.selectedText);
		}
		if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
			const value = String(editable.value || '');
			const next = value.slice(0, info.start) + value.slice(info.end);
			editable.value = next;
			try {
				editable.setSelectionRange(info.start, info.start);
			} catch {
				// ignore
			}
			return;
		}
		throw new Error('Cut not supported');
	}

	async function pasteIntoEditable(editable) {
		editable.focus();
		if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
			const text = await navigator.clipboard.readText();
			const s = String(text ?? '');
			if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
				const info = getEditableSelectionInfo(editable);
				const value = String(editable.value || '');
				const start = Math.max(0, Math.trunc(Number(info.start) || 0));
				const end = Math.max(start, Math.trunc(Number(info.end) || 0));
				editable.value = value.slice(0, start) + s + value.slice(end);
				const caret = start + s.length;
				try {
					editable.setSelectionRange(caret, caret);
				} catch {
					// ignore
				}
				return;
			}
			if (editable instanceof HTMLElement) {
				const sel = window.getSelection ? window.getSelection() : null;
				if (!sel || sel.rangeCount <= 0) {
					return;
				}
				const range = sel.getRangeAt(0);
				if (!editable.contains(range.commonAncestorContainer)) {
					return;
				}
				range.deleteContents();
				range.insertNode(document.createTextNode(s));
				range.collapse(false);
				sel.removeAllRanges();
				sel.addRange(range);
				return;
			}
			return;
		}
		throw new Error('Paste not supported');
	}

	function buildInputContextMenuItems(editable) {
		const info = getEditableSelectionInfo(editable);
		const canPaste = !!navigator.clipboard && typeof navigator.clipboard.readText === 'function';

		return [
			{
				id: 'cut',
				label: 'Cut',
				disabled: !info.hasSelection,
				onSelect: () => cutSelectionFromEditable(editable),
			},
			{
				id: 'copy',
				label: 'Copy',
				disabled: !info.hasSelection,
				onSelect: () => copySelectionFromEditable(editable),
			},
			{
				id: 'paste',
				label: 'Paste',
				disabled: !canPaste,
				onSelect: () => pasteIntoEditable(editable),
			},
			{
				id: 'selectAll',
				label: 'Select all',
				onSelect: () => selectAllInEditable(editable),
			},
		].map(it => Object.freeze(it));
	}

		// Global ContextMenu: replaces browser right-click within MsgHub root.
		document.addEventListener('contextmenu', e => {
			try {
				if (!e || typeof e !== 'object') {
					return;
				}
				// Secret bypass: Ctrl+RightClick opens the native browser context menu.
				if (e.ctrlKey === true) {
					try {
						ctx.api.ui.contextMenu.close();
					} catch {
						// ignore
					}
					return;
				}
				if (ctx.api.ui.dialog?.isOpen?.()) {
					return;
				}
				const target = e.target instanceof HTMLElement ? e.target : null;
				if (!target) {
					return;
				}
				const rootEl = target.closest('.msghub-root');
				if (!rootEl) {
					return;
				}
					const insideMenu = target.closest('.msghub-contextmenu');
					if (insideMenu) {
						// Prevent the native browser context menu on our own context menu UI.
						// (Ctrl+RightClick bypass is handled above.)
						e.preventDefault();
						return;
					}
				// If a panel wants to own the context menu, it can `preventDefault()` and open its own.
				if (e.defaultPrevented) {
					return;
				}

				const editable = findEditableTarget(target);

				e.preventDefault();

				const items = editable ? buildInputContextMenuItems(editable) : [];
				const anchorPoint = { x: e.clientX, y: e.clientY };
			ctx.api.ui.contextMenu.open({ items, anchorPoint, ariaLabel: 'Context menu', placement: 'bottom-start' });
		} catch (_err) {
			// ignore
		}
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

	let connectWarmupToken = 0;
	let connectWarmupPromise = null;

	const sleepMs = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.trunc(Number(ms) || 0))));

	async function warmupAdminApis() {
		const token = ++connectWarmupToken;
		const startedAt = Date.now();
		const maxWaitMs = 30000;
		let delayMs = 200;

		while (socket?.connected && connectWarmupToken === token && Date.now() - startedAt <= maxWaitMs) {
			try {
				await api.constants.get();
				await api.ingestStates?.constants?.get?.();
				return true;
			} catch (_err) {
				await sleepMs(delayMs + Math.trunc(Math.random() * 250));
				delayMs = Math.min(2000, Math.trunc(delayMs * 1.5));
			}
		}
		return false;
	}

	function triggerWarmupReconnect() {
		if (connectWarmupPromise) {
			return connectWarmupPromise;
		}
		connectWarmupPromise = Promise.resolve()
			.then(async () => {
				const ok = await warmupAdminApis();
				if (!ok || !socket?.connected) {
					return;
				}
				for (const section of panelSections.values()) {
					try {
						await section?.onConnect?.();
					} catch (_err) {
						// ignore: panel should render its own error state
					}
				}
			})
			.finally(() => {
				connectWarmupPromise = null;
			});
		return connectWarmupPromise;
	}

	socket.on('connect', () => {
		connOnline = true;
		setConnStatus(true);
		void ensureBooted().then(() => {
			applyStaticI18n();
			setConnTextFromState();
			for (const section of panelSections.values()) {
				section?.onConnect?.();
			}
			void triggerWarmupReconnect();
		});
	});

	socket.on('disconnect', () => {
		connOnline = false;
		setConnStatus(false);
		connectWarmupToken++;
		connectWarmupPromise = null;
		void ensureAdminI18nLoaded().then(() => {
			applyStaticI18n();
			setConnTextFromState();
		});
	});
