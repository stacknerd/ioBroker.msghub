/* global hasAdminKey, resolveViewId, getActiveComposition, args, window */
'use strict';

/**
 * MsgHub Admin Tab API facade between UI panels and the ioBroker backend.
 *
 * Docs: ../../docs/ui/tab-api.md
 *
 * Contents:
 * - Utility helpers (`createAsyncCache`, `computeContextMenuPosition`, icon normalization).
 * - Construction of the stable `ctx.api` surface for panels.
 * - Encapsulation of all `sendTo` commands in clearly named API groups.
 *
 * Integration:
 * - `boot.js` creates the only supported backend interface through `createAdminApi(...)`.
 * - Panels work exclusively against `ctx.api`, never directly against socket or `sendTo`.
 *
 * Interfaces:
 * - `createAdminApi(...)` returns a frozen API object.
 * - Supporting helpers stay file-local but are documented for maintenance clarity.
 */

/**
 * Creates a consistent error for API branches that are intentionally unsupported.
 *
 * @param {string} message - Message describing which operation is unsupported.
 * @returns {Error} Error object with a stable name and code.
 */
function createNotSupportedError(message) {
	const err = Object.assign(new Error(String(message || 'Not supported')), { code: 'NOT_SUPPORTED' });
	err.name = 'NotSupportedError';
	return err;
}

/**
 * Builds an asynchronous in-memory cache with optional expiration.
 *
 * @param {Function} fetchFn - Function that loads the value on cache miss.
 * @param {object} [options] - Optional cache configuration.
 * @param {number} [options.maxAgeMs] - Maximum entry age in milliseconds.
 * @returns {{get: Function, invalidate: Function}} Cache API.
 */
function createAsyncCache(fetchFn, { maxAgeMs = Infinity } = {}) {
	let value = undefined;
	let hasValue = false;
	let pending = null;
	let fetchedAt = 0;

	/**
	 * Checks whether the current cache value is still valid.
	 *
	 * @returns {boolean} `true` when a fresh cache value exists.
	 */
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

	/**
	 * Clears the cache explicitly.
	 */
	const invalidate = () => {
		value = undefined;
		hasValue = false;
		pending = null;
		fetchedAt = 0;
	};

	/**
	 * Returns the cache value and loads it on demand when needed.
	 *
	 * @returns {Promise<any>} Resolved cache value.
	 */
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

/**
 * Computes screen coordinates for a context menu including flip/clamp logic.
 *
 * @param {object} params - Position and viewport parameters.
 * @param {number} params.anchorX - X coordinate of the menu anchor.
 * @param {number} params.anchorY - Y coordinate of the menu anchor.
 * @param {number} params.menuWidth - Measured menu width.
 * @param {number} params.menuHeight - Measured menu height.
 * @param {number} params.viewportWidth - Width of the visible viewport.
 * @param {number} params.viewportHeight - Height of the visible viewport.
 * @param {'cursor'|'anchor'|'submenu'} [params.mode] - Positioning mode.
 * @param {number} [params.alignHeight] - Reference height for submenu alignment.
 * @param {number} [params.viewportPadding] - Minimum distance to the viewport edge.
 * @param {number} [params.cursorOffset] - Offset from the cursor or anchor.
 * @returns {{x:number,y:number}} Pixel coordinates for CSS `left` and `top`.
 */
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
	const VIEWPORT_PADDING = Number.isFinite(Number(viewportPadding))
		? Math.max(0, Math.trunc(Number(viewportPadding)))
		: 8;
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

/**
 * Converts an icon name into a CSS variable reference.
 *
 * @param {string} iconName - Technical icon key.
 * @returns {string} CSS value (`var(--msghub-icon-...)`) or an empty string for invalid input.
 */
function toContextMenuIconVar(iconName) {
	const name = typeof iconName === 'string' ? iconName.trim() : '';
	if (!/^[a-z0-9-]+$/.test(name)) {
		return '';
	}
	return `var(--msghub-icon-${name})`;
}

/**
 * Validates and normalizes an IANA timezone identifier.
 *
 * @param {any} value - Candidate timezone value.
 * @returns {string} Normalized timezone or empty string if invalid.
 */
function normalizeTimeZone(value) {
	const tz = typeof value === 'string' ? value.trim() : '';
	if (!tz) {
		return '';
	}
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
		return tz;
	} catch {
		return '';
	}
}

/**
 * Normalizes a timezone policy object and enforces UTC fallback.
 *
 * @param {any} policy - Raw policy candidate.
 * @returns {{timeZone:string,source:string,isFallbackUtc:boolean,warning:string}} Normalized timezone policy.
 */
function normalizeTimePolicy(policy) {
	const raw = policy && typeof policy === 'object' ? policy : {};
	const requestedTimeZone = typeof raw.timeZone === 'string' ? raw.timeZone.trim() : '';
	const timeZone = normalizeTimeZone(requestedTimeZone);
	const source = typeof raw.source === 'string' ? raw.source.trim() : '';
	if (timeZone) {
		return Object.freeze({
			timeZone,
			source: source || 'server',
			isFallbackUtc: false,
			warning: '',
		});
	}
	const reason = requestedTimeZone ? 'invalid_timezone' : 'missing_timezone';
	return Object.freeze({
		timeZone: 'UTC',
		source: 'fallback-utc',
		isFallbackUtc: true,
		warning: `timezone_fallback_utc:${reason}`,
	});
}

/**
 * Detects whether expert mode is enabled for the current admin session.
 *
 * The URL flag is additive only: `true` forces expert mode on, while `false`
 * does not disable host-provided expert mode from session storage or `_system`.
 *
 * @param {any} argsExpert - Optional normalized `args.expert` value.
 * @returns {boolean} `true` when expert mode is active.
 */
function detectHostExpertMode(argsExpert) {
	if (argsExpert === true || argsExpert === '1' || argsExpert === 'true') {
		return true;
	}

	try {
		const storage = window?.sessionStorage;
		if (storage && typeof storage.getItem === 'function') {
			if (storage.getItem('App.expertMode') === 'true') {
				return true;
			}
		}
	} catch {
		// Ignore host/session access errors.
	}

	try {
		const sys = window?._system || window?.top?._system;
		return !!sys?.expertMode;
	} catch {
		return false;
	}
}

/**
 * Creates the stable API facade for all panels.
 *
 * @param {object} deps - Runtime dependencies from bootstrapping.
 * @param {Function} deps.msghubRequest - Backend bridge for msghub commands.
 * @param {any} deps.msghubSocket - Socket instance for connection state checks.
 * @param {string} deps.adapterInstance - Adapter instance id.
 * @param {string} deps.lang - Active language code.
 * @param {Function} deps.t - Translation function.
 * @param {Function} deps.pickText - Text resolver for localized fields.
 * @param {object} deps.ui - UI facade (`toast`, `contextMenu`, `dialog`, ...).
 * @returns {object} Frozen API surface (`ctx.api`).
 */
function createAdminApi({ msghubRequest, msghubSocket, adapterInstance, lang, t, pickText, ui }) {
	// Panel mode: args.panel takes precedence over composition resolution.
	// Guard: args may be undeclared in early-boot or test contexts.
	const rawPanelArg = typeof args !== 'undefined' && typeof args?.panel === 'string' ? args.panel.trim() : '';
	const isPanelMode = !!rawPanelArg;
	let viewId, layout, deviceMode, panelIds, defaultPanelId;
	if (isPanelMode) {
		const panelTabId = rawPanelArg;
		const panelKey = panelTabId.slice('tab-'.length);
		viewId = null;
		layout = 'single';
		deviceMode = 'pc';
		panelIds = [panelKey];
		defaultPanelId = panelKey;
	} else {
		viewId = typeof resolveViewId === 'function' ? resolveViewId() : 'adminTab';
		const composition = typeof getActiveComposition === 'function' ? getActiveComposition() : null;
		// Filter to string entries only — structured plugin panel refs are not native panels.
		panelIds = Array.isArray(composition?.panels) ? composition.panels.filter(v => typeof v === 'string' && v) : [];
		defaultPanelId = typeof composition?.defaultPanel === 'string' ? composition.defaultPanel : '';
		layout = composition?.layout || 'tabs';
		deviceMode = composition?.deviceMode || 'pc';
	}

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

	let timePolicy = normalizeTimePolicy(null);
	const timeFormatterCache = new Map();
	const queryFormatLocale = (() => {
		const candidate = typeof args !== 'undefined' && typeof args?.locale === 'string' ? args.locale.trim() : '';
		if (!candidate) {
			return '';
		}
		try {
			return new Intl.DateTimeFormat(candidate).resolvedOptions().locale || candidate;
		} catch {
			return '';
		}
	})();

	/**
	 * Returns a cached date formatter for one locale/timezone tuple.
	 *
	 * @param {string} locale - Resolved locale.
	 * @param {string} timeZone - IANA timezone.
	 * @param {boolean} includeTimeZone - Include timezone suffix.
	 * @returns {Intl.DateTimeFormat} Formatter instance.
	 */
	const getTimeFormatter = (locale, timeZone, includeTimeZone) => {
		const key = `${locale || ''}|${timeZone}|${includeTimeZone ? '1' : '0'}`;
		const cached = timeFormatterCache.get(key);
		if (cached) {
			return cached;
		}
		const formatter = new Intl.DateTimeFormat(locale || undefined, {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			...(includeTimeZone ? { timeZoneName: 'short' } : {}),
		});
		timeFormatterCache.set(key, formatter);
		return formatter;
	};

	const rawContextMenu =
		ui?.contextMenu ||
		Object.freeze({
			open: () => {},
			close: () => {},
			isOpen: () => false,
		});

	/**
	 * Wraps context menu items recursively so select actions close reliably
	 * and failure scenarios are surfaced consistently.
	 *
	 * @param {Array<any>} items - Raw item array from the calling panel.
	 * @returns {Array<any>} Defensively wrapped item array.
	 */
	const wrapContextMenuItems = items => {
		const list = Array.isArray(items) ? items : [];
		return list.filter(Boolean).map(item => {
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
					return Promise.resolve().then(() => onSelectRaw());
				});

			return Object.freeze({
				...it,
				...(children ? { items: children } : {}),
				...(onSelect ? { onSelect } : {}),
			});
		});
	};

	// `uiApi` is the sole UI entry point for panels.
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
		dialog:
			ui?.dialog ||
			Object.freeze({ confirm: () => Promise.resolve(false), close: () => {}, isOpen: () => false }),
		spinner: Object.freeze({
			/** @param {{ message?: string, blocking?: boolean, id?: string } | undefined} opts - Spinner options. */
			show: opts => {
				const message =
					(typeof opts?.message === 'string' ? opts.message.trim() : '') ||
					t('msghub.i18n.core.admin.ui.spinner.pleaseWait.text');
				return ui?.spinner?.show({ ...opts, message });
			},
			/** @param {string} [id] - Spinner id; without an argument all spinners are closed. */
			hide: id => ui?.spinner?.hide(id),
			/** @param {string} [id] - Spinner id; without an argument checks whether any spinner is open. */
			isOpen: id => ui?.spinner?.isOpen(id) ?? false,
		}),
		/** @param {string} id - Toast ID to close. */
		toastClose: id => ui?.toastClose?.(String(id ?? '')),
		closeAll: () => ui?.closeAll?.(),
	});

	// Host metadata gives panels context about the active composition and connection state.
	const host = Object.freeze({
		viewId,
		layout,
		deviceMode,
		panels: Object.freeze(panelIds),
		defaultPanel: defaultPanelId,
		adapterInstance,
		isConnected: () => !!msghubSocket?.connected,
		isExpertMode: () => detectHostExpertMode(typeof args !== 'undefined' ? args?.expert : undefined),
	});

	/**
	 * Helper for intentionally disabled API branches.
	 *
	 * @param {string} method - Name of the requested operation.
	 * @throws {Error} Always.
	 */
	const notSupported = method => {
		throw createNotSupportedError(method);
	};

	// Constants are heavily cached as they rarely change at runtime.
	const constantsCache = createAsyncCache(() => msghubRequest('admin.constants.get', {}), { maxAgeMs: Infinity });

	const constants = Object.freeze({
		get: () => constantsCache.get(),
		invalidate: () => constantsCache.invalidate(),
	});

	const stats = Object.freeze({
		get: params => msghubRequest('admin.stats.get', params || {}),
	});

	const messages = Object.freeze({
		query: params => msghubRequest('admin.messages.query', params || {}),
		delete: refs => msghubRequest('admin.messages.delete', { refs }),
		executeAction: params => msghubRequest('admin.messages.action', params || {}),
	});

	const plugins = Object.freeze({
		getCatalog: () => msghubRequest('admin.plugins.getCatalog', {}),
		listInstances: () => msghubRequest('admin.plugins.listInstances', {}),
		createInstance: params => msghubRequest('admin.plugins.createInstance', params || {}),
		updateInstance: params => msghubRequest('admin.plugins.updateInstance', params || {}),
		setEnabled: params => msghubRequest('admin.plugins.setEnabled', params || {}),
		deleteInstance: params => msghubRequest('admin.plugins.deleteInstance', params || {}),
	});

	const runtime = Object.freeze({
		about: () => msghubRequest('runtime.about', {}),
	});

	const time = Object.freeze({
		getPolicy: () => timePolicy,
		setPolicy: policy => {
			timePolicy = normalizeTimePolicy(policy);
			return timePolicy;
		},
		formatTs: (ts, options) => {
			if (typeof ts !== 'number' || !Number.isFinite(ts)) {
				return '';
			}
			try {
				const opts = options && typeof options === 'object' ? options : {};
				const explicitLocale = typeof opts.locale === 'string' ? opts.locale.trim() : '';
				const locale = explicitLocale || queryFormatLocale;
				const includeTimeZone = opts.includeTimeZone === true;
				const formatter = getTimeFormatter(locale, timePolicy.timeZone, includeTimeZone);
				return formatter.format(new Date(ts));
			} catch {
				return String(ts);
			}
		},
		formatDate: (date, options) => {
			if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
				return '';
			}
			return time.formatTs(date.getTime(), options);
		},
	});

	// Stable API surface: panels interact exclusively with `ctx.api`.
	return Object.freeze({
		i18n,
		ui: uiApi,
		log,
		host,
		constants,
		runtime,
		time,
		stats,
		messages,
		plugins,
		notSupported,
	});
}

void computeContextMenuPosition;
void toContextMenuIconVar;
void createAdminApi;
