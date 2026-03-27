'use strict';

// IoRuntimeI18n — source-aware i18n registry for the backend runtime.
//
// Manages multiple i18n sources (core-runtime, root-admin-overlay, plugin-runtime),
// merges them lazily by priority, and provides closure-based translator facades.
//
// Sources are registered via addSource() / removeSource(). The materialized
// word table is invalidated on every source change and rebuilt lazily on the
// next t() call.
//
// Closure-binding (A8): createTranslator() returns a closure that holds a live
// reference to this registry. Translations from newly added sources are visible
// immediately without recreating the facade.
//
// System: lib/IoRuntimeI18n.js
// Interfaces: addSource(), removeSource(), createTranslator(), getSourceIds()
// Used by: main.js (_i18ninit), lib/IoPlugins.js (_loadPluginI18n / _registerOne)

/**
 * Priority order for source types. Lower number = lower priority (overwritten by higher).
 * plugin-runtime sources are namespace-guarded by IoPlugins before being passed here.
 */
const SOURCE_PRIORITY = {
	'core-runtime': 0, // msghub.i18n.core.* keys
	'root-admin-overlay': 1, // msghub.i18n.core.admin.* keys — wins over core-runtime
	'plugin-runtime': 2, // msghub.i18n.<PluginTypeName>.* keys only (namespace-guarded by IoPlugins)
};

/**
 * Returns true if value is a plain object (not null, not array).
 *
 * @param {unknown} value - Value to check.
 * @returns {boolean} True if value is a plain object, false otherwise.
 */
function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Source-aware i18n registry for the backend runtime.
 * Manages multiple named sources and merges them by priority into a unified word table.
 * Translator facades returned by createTranslator() hold a live reference to this registry
 * and reflect source changes immediately (A8 closure-binding).
 */
class IoRuntimeI18n {
	/**
	 * Creates a new IoRuntimeI18n.
	 *
	 * @param {object} [options] - Optional configuration.
	 * @param {{warn: Function}|null} [options.log] - Logger for collision warnings.
	 */
	constructor({ log } = {}) {
		this._sources = [];
		this._materialized = null;
		this._log = log ?? null;
	}

	/**
	 * Adds (or replaces) an i18n source.
	 * Validates inputs before any state mutation.
	 * Invalidates the materialized cache.
	 *
	 * @param {string} id - Unique source identifier (e.g. 'core-runtime', 'plugin:IngestStates:0').
	 * @param {string} type - Source type; must be one of the known SOURCE_PRIORITY keys.
	 * @param {object} wordsByLang - Map of lang to key-translation pairs. Must be a plain object.
	 * @throws {Error} If type is unknown or wordsByLang is not a plain object.
	 */
	addSource(id, type, wordsByLang) {
		if (!Object.prototype.hasOwnProperty.call(SOURCE_PRIORITY, type)) {
			throw new Error(
				`IoRuntimeI18n: unknown source type "${type}". Valid types: ${Object.keys(SOURCE_PRIORITY).join(', ')}`,
			);
		}
		if (!isPlainObject(wordsByLang)) {
			throw new Error(`IoRuntimeI18n: wordsByLang must be a plain object (got ${typeof wordsByLang})`);
		}
		// Validation passed — mutate state.
		const priority = SOURCE_PRIORITY[type];
		this._sources = this._sources.filter(s => s.id !== id);
		this._sources.push({ id, type, priority, wordsByLang });
		this._materialized = null;
	}

	/**
	 * Removes an i18n source by ID.
	 * No-op if the ID is not found (safe to call even if the source was never added).
	 * Invalidates the materialized cache.
	 *
	 * @param {string} id - Source ID to remove.
	 */
	removeSource(id) {
		const before = this._sources.length;
		this._sources = this._sources.filter(s => s.id !== id);
		if (this._sources.length !== before) {
			this._materialized = null;
		}
	}

	/**
	 * Returns an array of currently registered source IDs (for diagnostics).
	 *
	 * @returns {string[]} Array of registered source IDs in registration order.
	 */
	getSourceIds() {
		return this._sources.map(s => s.id);
	}

	/**
	 * Returns (and if needed, rebuilds) the materialized word table.
	 * Format: words[key][lang] = translatedValue
	 *
	 * Sources are merged in ascending priority order; higher priority overwrites lower.
	 * A collision warning is logged when a key-lang pair is overwritten with a different value.
	 *
	 * @returns {{[key: string]: {[lang: string]: string}}} Merged translation table keyed by i18n key then language code.
	 */
	_getMaterialized() {
		if (this._materialized !== null) {
			return this._materialized;
		}
		const words = Object.create(null);
		const sorted = [...this._sources].sort((a, b) => a.priority - b.priority);

		for (const source of sorted) {
			const { id, wordsByLang } = source;
			for (const lang of Object.keys(wordsByLang)) {
				const langMap = wordsByLang[lang];
				if (!isPlainObject(langMap)) {
					continue;
				}
				for (const [key, value] of Object.entries(langMap)) {
					if (!words[key]) {
						words[key] = Object.create(null);
					}
					if (words[key][lang] !== undefined && words[key][lang] !== value) {
						this._log?.warn(
							`IoRuntimeI18n: key collision for "${key}" [${lang}] — overwritten by source "${id}"`,
						);
					}
					words[key][lang] = value;
				}
			}
		}

		this._materialized = words;
		return words;
	}

	/**
	 * Creates a translator facade bound live to this registry.
	 * The returned closure sees any source changes made after createTranslator() was called
	 * without needing to recreate the facade (A8 closure-binding).
	 *
	 * @param {string} lang - Primary language code (e.g. 'en', 'de'). Falls back to 'en'.
	 * @returns {{t: Function, getTranslatedObject: Function}} Translator facade with t() and getTranslatedObject().
	 */
	createTranslator(lang) {
		const effectiveLang = lang || 'en';

		/**
		 * Translates a key into the configured language.
		 * Falls back to 'en' if the key has no translation for the target language.
		 * Falls back to the key string itself if no translation is found at all.
		 *
		 * @param {string} key - i18n key.
		 * @param {...unknown} args - Arguments for %s substitution (in order).
		 * @returns {string} The translated string, with %s placeholders replaced by args.
		 */
		const t = (key, ...args) => {
			const words = this._getMaterialized();
			let text = words[key]?.[effectiveLang] ?? words[key]?.en ?? key;
			for (const arg of args) {
				text = text.replace('%s', arg === null ? 'null' : String(arg));
			}
			return text;
		};

		/**
		 * Returns an object with translations for all available languages for a key.
		 * Falls back to { en: key } if the key is unknown.
		 * Applies %s substitution to all languages when the en translation contains %s.
		 *
		 * @param {string} key - i18n key.
		 * @param {...unknown} args - Arguments for %s substitution (in order).
		 * @returns {{[lang: string]: string}} Map of language code to translated string.
		 */
		const getTranslatedObject = (key, ...args) => {
			const words = this._getMaterialized();
			if (!words[key]) {
				return { en: key };
			}
			const word = words[key];
			if (word.en && word.en.includes('%s')) {
				return Object.fromEntries(
					Object.keys(word).map(l => {
						let s = word[l];
						for (const arg of args) {
							s = s.replace('%s', arg === null ? 'null' : String(arg));
						}
						return [l, s];
					}),
				);
			}
			return { ...word };
		};

		return { t, getTranslatedObject };
	}
}

module.exports = { IoRuntimeI18n };
