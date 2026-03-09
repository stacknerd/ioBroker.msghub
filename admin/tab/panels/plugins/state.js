/// <reference lib="dom" />
/* global window, HTMLInputElement, HTMLTextAreaElement, HTMLElement */
(function () {
	'use strict';

	const win = window;

	/**
	 * Plugins panel state and utility module.
	 *
	 * Contains:
	 * - Panel-wide constants (category order, i18n keys, time units).
	 * - Stateless helper utilities shared across plugins submodules.
	 * - Plugins panel state factory.
	 *
	 * Integration:
	 * - Loaded before all other plugins panel modules (registry load order).
	 * - Used by `index.js` as the single source for state creation and shared utilities.
	 *
	 * Public API:
	 * - `createPluginsState()`
	 * - `pick()`, `cssSafe()`, `formatPluginLabel()`
	 * - `normalizeUnit()`, `isUnitless()`, `pickDefaultTimeUnit()`, `getTimeFactor()`
	 * - `isTextEditableElement()`, `isTextEditableTarget()`
	 * - `CATEGORY_ORDER`, `CATEGORY_I18N`, `TIME_UNITS`
	 */

	/**
	 * Ordered list of plugin categories for display rendering.
	 */
	const CATEGORY_ORDER = Object.freeze(['ingest', 'notify', 'bridge', 'engage']);

	/**
	 * i18n key map and fallback titles for known plugin categories.
	 */
	const CATEGORY_I18N = Object.freeze({
		ingest: Object.freeze({
			titleKey: 'msghub.i18n.core.admin.ui.plugins.category.ingest.title',
			descKey: 'msghub.i18n.core.admin.ui.plugins.category.ingest.desc',
			fallbackTitle: 'Ingest',
		}),
		notify: Object.freeze({
			titleKey: 'msghub.i18n.core.admin.ui.plugins.category.notify.title',
			descKey: 'msghub.i18n.core.admin.ui.plugins.category.notify.desc',
			fallbackTitle: 'Notify',
		}),
		bridge: Object.freeze({
			titleKey: 'msghub.i18n.core.admin.ui.plugins.category.bridge.title',
			descKey: 'msghub.i18n.core.admin.ui.plugins.category.bridge.desc',
			fallbackTitle: 'Bridge',
		}),
		engage: Object.freeze({
			titleKey: 'msghub.i18n.core.admin.ui.plugins.category.engage.title',
			descKey: 'msghub.i18n.core.admin.ui.plugins.category.engage.desc',
			fallbackTitle: 'Engage',
		}),
	});

	/**
	 * Supported time unit definitions for duration form fields.
	 */
	const TIME_UNITS = Object.freeze([
		{ key: 'ms', label: 'ms', factor: 1 },
		{ key: 's', label: 's', factor: 1000 },
		{ key: 'min', label: 'min', factor: 60 * 1000 },
		{ key: 'h', label: 'h', factor: 60 * 60 * 1000 },
	]);

	/**
	 * Reads a value at a dotted path from an object.
	 *
	 * @param {object} obj - Source object.
	 * @param {string} path - Dot-notation path string.
	 * @returns {any} Resolved value, or undefined if any segment is missing.
	 */
	function pick(obj, path) {
		if (typeof path !== 'string') {
			return undefined;
		}
		const parts = path.split('.');
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
	 * Converts a raw string to a CSS-safe identifier.
	 *
	 * Strips leading/trailing whitespace, lowercases, replaces non-alphanumeric
	 * characters with dashes, and collapses repeated dashes.
	 *
	 * @param {string} s - Raw identifier string.
	 * @returns {string} CSS-safe lowercase identifier, or 'unknown' for empty input.
	 */
	function cssSafe(s) {
		return (
			String(s || '')
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9_-]+/g, '-')
				.replace(/-{2,}/g, '-')
				.replace(/^-+|-+$/g, '') || 'unknown'
		);
	}

	/**
	 * Formats a plugin descriptor into a primary/secondary label pair.
	 *
	 * Uses the raw string `title` field when present and distinct from the type.
	 * Does not apply i18n resolution; use `api.i18n.pickText` in render modules for
	 * localized multi-language title objects.
	 *
	 * @param {object} plugin - Plugin descriptor with `type` and optional `title`.
	 * @returns {{primary:string, secondary:string}} Primary type and optional secondary label.
	 */
	function formatPluginLabel(plugin) {
		const type = String(plugin?.type || '');
		const title = typeof plugin?.title === 'string' ? plugin.title.trim() : '';
		if (title && title !== type) {
			return { primary: type, secondary: title };
		}
		return { primary: type, secondary: '' };
	}

	/**
	 * Normalizes a unit string to a trimmed lowercase form.
	 *
	 * @param {string} unit - Raw unit string.
	 * @returns {string} Lowercase trimmed unit key, or empty string.
	 */
	function normalizeUnit(unit) {
		const u = typeof unit === 'string' ? unit.trim().toLowerCase() : '';
		return u;
	}

	/**
	 * Returns true when the unit is absent or explicitly set to 'none'.
	 *
	 * @param {string} unit - Unit string.
	 * @returns {boolean} True when there is no meaningful unit.
	 */
	function isUnitless(unit) {
		const u = normalizeUnit(unit);
		return !u || u === 'none';
	}

	/**
	 * Picks the most human-readable time unit for a given millisecond value.
	 *
	 * Returns 'h' for exact hours, 'min' for exact minutes, 's' for exact seconds,
	 * and 'ms' for all other values.
	 *
	 * @param {number} ms - Duration in milliseconds.
	 * @returns {string} Best-fit unit key ('h', 'min', 's', or 'ms').
	 */
	function pickDefaultTimeUnit(ms) {
		const n = typeof ms === 'number' ? ms : Number(ms);
		if (!Number.isFinite(n) || n <= 0) {
			return 'ms';
		}
		if (n % (60 * 60 * 1000) === 0) {
			return 'h';
		}
		if (n % (60 * 1000) === 0) {
			return 'min';
		}
		if (n % 1000 === 0) {
			return 's';
		}
		return 'ms';
	}

	/**
	 * Returns the millisecond factor for a given time unit key.
	 *
	 * Unknown unit keys fall back to 1 (millisecond identity).
	 *
	 * @param {string} unitKey - Time unit key ('ms', 's', 'min', 'h').
	 * @returns {number} Factor to multiply by to convert from unit to milliseconds.
	 */
	function getTimeFactor(unitKey) {
		const u = normalizeUnit(unitKey);
		const found = TIME_UNITS.find(x => x.key === u);
		return found ? found.factor : 1;
	}

	/**
	 * Returns true when the given element is a text-editable input, textarea, or
	 * contentEditable element.
	 *
	 * Guards against missing DOM globals for test environments by using typeof checks.
	 *
	 * @param {Element|null} el - DOM element to test.
	 * @returns {boolean} True when the element accepts direct text input.
	 */
	function isTextEditableElement(el) {
		if (!el || typeof el !== 'object') {
			return false;
		}
		try {
			if (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement) {
				return true;
			}
			if (typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement) {
				const type = String(el.type || '').toLowerCase();
				return ![
					'button',
					'submit',
					'reset',
					'image',
					'checkbox',
					'radio',
					'range',
					'color',
					'file',
					'hidden',
				].includes(type);
			}
			if (typeof HTMLElement !== 'undefined' && el instanceof HTMLElement && el.isContentEditable === true) {
				return true;
			}
		} catch {
			// Guard against environments where DOM globals are absent.
		}
		return false;
	}

	/**
	 * Returns true when the event target is or is inside a text-editable element.
	 *
	 * Used to preserve native browser context menus for text fields while
	 * the custom context menu handles all other right-click targets.
	 *
	 * @param {object|null} target - Event target or DOM element to test.
	 * @returns {boolean} True when the target is within an editable element.
	 */
	function isTextEditableTarget(target) {
		if (!target || typeof target !== 'object' || typeof target.closest !== 'function') {
			return false;
		}
		// Cast via the runtime-guarded closest call — type is narrowed by the typeof check above.
		const anyTarget = target;
		const el =
			anyTarget.closest(
				'textarea, input, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
			) || null;
		return isTextEditableElement(el);
	}

	/**
	 * Creates the canonical plugins panel state container.
	 *
	 * Holds mutable caches shared across plugins submodules. Each cache starts
	 * null or empty and is populated on first use by the relevant data functions.
	 *
	 * @returns {object} Mutable state object shared across plugins submodules.
	 */
	function createPluginsState() {
		return {
			/** Cached MsgConstants from the constants API. */
			cachedConstants: null,
			/** Cached IngestStates constants from the ingestStates API. */
			cachedIngestStatesConstants: null,
			/** Readme data keyed by plugin type. */
			pluginReadmesByType: new Map(),
			/** In-flight or resolved readme load promise. */
			pluginReadmesLoadPromise: null,
			/** In-flight or resolved IngestStates schema promise. */
			ingestStatesSchemaPromise: null,
		};
	}

	win.MsghubAdminTabPluginsState = Object.freeze({
		CATEGORY_ORDER,
		CATEGORY_I18N,
		TIME_UNITS,
		pick,
		cssSafe,
		formatPluginLabel,
		normalizeUnit,
		isUnitless,
		pickDefaultTimeUnit,
		getTimeFactor,
		isTextEditableElement,
		isTextEditableTarget,
		createPluginsState,
	});
})();
