/* global window */
(function () {
	'use strict';

	const win = window;
	let fallbackFormatter = null;
	let formatTsImpl = null;

	/**
	 * Messages panel state and utility module.
	 *
	 * Contains:
	 * - Shared panel state factory.
	 * - Stateless value/path helpers used across messages submodules.
	 * - Expert mode detection from admin host/session.
	 *
	 * Integration:
	 * - Loaded before all other messages panel modules.
	 * - Used by `index.js` as the single source for state creation.
	 *
	 * Public API:
	 * - `createMessagesState()`
	 * - `detectExpertMode()`
	 * - `isObject()`, `safeStr()`, `pick()`, `formatTs()`
	 */

	/**
	 * Returns true for non-null plain objects and false for arrays/primitives.
	 *
	 * @param {any} value - Candidate value.
	 * @returns {boolean} True when value is an object and not an array.
	 */
	function isObject(value) {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	/**
	 * Converts values to safe string representation.
	 *
	 * @param {any} value - Source value.
	 * @returns {string} String value or empty string for nullish values.
	 */
	function safeStr(value) {
		return typeof value === 'string' ? value : value == null ? '' : String(value);
	}

	/**
	 * Reads a dotted path from an object.
	 *
	 * @param {object} obj - Source object.
	 * @param {string} path - Dot notation path.
	 * @returns {any} Resolved value or undefined.
	 */
	function pick(obj, path) {
		const parts = typeof path === 'string' ? path.split('.') : [];
		let cur = obj;
		for (const key of parts) {
			if (!cur || typeof cur !== 'object') {
				return undefined;
			}
			cur = cur[key];
		}
		return cur;
	}

	/**
	 * Formats epoch milliseconds with the active timezone formatter.
	 *
	 * @param {number} ts - Epoch timestamp in milliseconds.
	 * @returns {string} Formatted timestamp or empty string.
	 */
	function formatTs(ts) {
		if (typeof ts !== 'number' || !Number.isFinite(ts)) {
			return '';
		}
		try {
			if (typeof formatTsImpl === 'function') {
				return String(formatTsImpl(ts) || '');
			}
			if (!fallbackFormatter) {
				fallbackFormatter = new Intl.DateTimeFormat(undefined, {
					timeZone: 'UTC',
					year: 'numeric',
					month: '2-digit',
					day: '2-digit',
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit',
				});
			}
			return fallbackFormatter.format(new Date(ts));
		} catch {
			return String(ts);
		}
	}

	/**
	 * Sets the global timestamp formatter used by this panel module.
	 *
	 * @param {Function|null} formatter - Formatter `(ts:number) => string`.
	 */
	function setFormatTsFormatter(formatter) {
		formatTsImpl = typeof formatter === 'function' ? formatter : null;
	}

	/**
	 * Detects whether expert mode is enabled in current admin session.
	 *
	 * @returns {boolean} True when expert mode is active.
	 */
	function detectExpertMode() {
		try {
			const storage = win.sessionStorage;
			if (storage && typeof storage.getItem === 'function') {
				if (storage.getItem('App.expertMode') === 'true') {
					return true;
				}
			}
		} catch {
			// Ignore host/session access errors.
		}
		try {
			const sys = win._system || win.top?._system;
			return !!sys?.expertMode;
		} catch {
			return false;
		}
	}

	/**
	 * Creates the canonical messages panel state.
	 *
	 * @returns {object} Mutable state object shared across submodules.
	 */
	function createMessagesState() {
		const state = {
			autoRefreshMs: 15000,
			loading: false,
			silentLoading: false,
			autoRefresh: true,
			autoTimer: null,
			requestSeq: 0,
			hasLoadedOnce: false,
			lastError: null,
			constants: null,
			items: [],
			total: 0,
			pages: 1,
			lastMeta: null,
			serverTz: null,
			pageIndex: 1,
			pageSize: 50,
			sortField: 'timing.createdAt',
			sortDir: 'desc',
			expertMode: false,
			selectedRefs: new Set(),
			syncSelectionUI: () => undefined,
			suppressRowClickUntil: 0,
			headerSelectAllInput: null,
			tableColCount: 11,
			columnFilters: Object.create(null),

			// Archive-ready state contract (not active in this step).
			archiveMode: 'follow',
			archiveEdgeOldest: null,
			archiveEdgeNewest: null,
			archiveHasMoreBackward: false,
			archiveHasMoreForward: false,
			archivePendingNewCount: 0,
			archiveActiveRef: '',
			archiveItemsByRef: new Map(),
		};

		// Default lifecycle filter:
		// acked=true, closed=true, deleted=false, expired=false, open=true, snoozed=true
		state.columnFilters['lifecycle.state'] = new Set(['acked', 'closed', 'open', 'snoozed']);
		return state;
	}

	win.MsghubAdminTabMessagesState = Object.freeze({
		createMessagesState,
		detectExpertMode,
		isObject,
		safeStr,
		pick,
		formatTs,
		setFormatTsFormatter,
	});
})();
