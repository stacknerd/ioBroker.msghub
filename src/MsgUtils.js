/**
 * Shared helper utilities for message storage and archive.
 *
 * Docs: ../docs/modules/MsgUtils.md
 */

const DEFAULT_MAP_TYPE_MARKER = '__msghubType';

/**
 * Test whether a value is a plain object (and not an Array).
 *
 * @param {unknown} v Candidate value.
 * @returns {boolean} `true` when `v` is a non-null object and not an Array.
 */
function isObject(v) {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

function localeCandidates(locale) {
	const loc = typeof locale === 'string' ? locale.trim() : '';
	if (!loc) {
		return [];
	}
	const base = loc.includes('-') ? loc.split('-')[0] : loc;
	const lower = loc.toLowerCase();
	const lowerBase = base.toLowerCase();
	const candidates = [];
	if (loc) {
		candidates.push(loc);
	}
	if (base && base !== loc) {
		candidates.push(base);
	}
	if (lower && lower !== loc) {
		candidates.push(lower);
	}
	if (lowerBase && lowerBase !== base && lowerBase !== lower) {
		candidates.push(lowerBase);
	}
	return Array.from(new Set(candidates));
}

/**
 * Pick a localized string from a string or i18n map (ioBroker-style: `{ en: "...", de: "..." }`).
 *
 * @param {unknown} value String or i18n map.
 * @param {string} [locale] Locale to prefer (e.g. "de", "de-DE").
 * @param {string[]} [fallbackLocales] Fallback locale keys (default: ["en","de"]).
 * @returns {string} The best matching localized string, or "".
 */
function pickI18n(value, locale, fallbackLocales = ['en', 'de']) {
	if (typeof value === 'string') {
		return value;
	}
	if (!isObject(value)) {
		return '';
	}

	for (const cand of localeCandidates(locale)) {
		if (typeof value[cand] === 'string') {
			return value[cand];
		}
	}
	for (const cand of fallbackLocales || []) {
		if (typeof value[cand] === 'string') {
			return value[cand];
		}
	}
	const first = Object.values(value).find(v => typeof v === 'string');
	return typeof first === 'string' ? first : '';
}

/**
 * Very small template formatter: replaces `{key}` with `params[key]`.
 *
 * @param {string} template Template text.
 * @param {Record<string, any>} [params] Values to substitute.
 * @returns {string} Formatted string.
 */
function formatI18n(template, params = {}) {
	if (typeof template !== 'string' || !template) {
		return '';
	}
	return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_m, key) => {
		const v = params ? params[key] : undefined;
		return v == null ? '' : String(v);
	});
}

/**
 * Serialize data to JSON while preserving Map values.
 *
 * @param {any} value Data to serialize.
 * @param {string} [mapTypeMarker] Type marker to encode Map values.
 * @returns {string} JSON string with Map values encoded.
 */
function serializeWithMaps(value, mapTypeMarker = DEFAULT_MAP_TYPE_MARKER) {
	return JSON.stringify(value, (key, val) => {
		if (val instanceof Map) {
			return { [mapTypeMarker]: 'Map', value: Array.from(val.entries()) };
		}
		return val;
	});
}

/**
 * Parse JSON and revive Map values created by serializeWithMaps.
 *
 * @param {string} text JSON string to parse.
 * @param {string} [mapTypeMarker] Type marker used for Map encoding.
 * @returns {any} Parsed value with Map instances restored.
 */
function deserializeWithMaps(text, mapTypeMarker = DEFAULT_MAP_TYPE_MARKER) {
	return JSON.parse(text, (key, val) => {
		if (val && typeof val === 'object' && val[mapTypeMarker] === 'Map' && Array.isArray(val.value)) {
			return new Map(val.value);
		}
		return val;
	});
}

/**
 * Ensure the ioBroker file meta object exists and has the correct type.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance.
 * @param {string} metaId Meta object id.
 * @returns {Promise<void>} Resolves once the meta object exists.
 */
async function ensureMetaObject(adapter, metaId) {
	const obj = await adapter.getObjectAsync(metaId);

	if (obj) {
		if (obj.type !== 'meta') {
			throw new Error(
				`File-Storage Root "${metaId}" exists but is type "${obj.type}", not "meta". ` +
					`Choose another metaId (e.g. "${metaId}.__files") or delete/rename the existing object "${metaId}".`,
			);
		}
		return;
	}

	await adapter.setObjectAsync(metaId, {
		type: 'meta',
		common: {
			name: `${adapter.name} file storage`,
			type: 'meta.user',
		},
		native: {},
	});
}

/**
 * Ensure the base directory exists in file storage.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance.
 * @param {string} metaId Meta object id.
 * @param {string} baseDir Base directory path.
 * @returns {Promise<void>} Resolves after attempting to create each path segment.
 */
async function ensureBaseDir(adapter, metaId, baseDir) {
	if (!baseDir || typeof adapter.mkdirAsync !== 'function') {
		return;
	}
	const parts = String(baseDir).split('/').filter(Boolean);
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		try {
			await adapter.mkdirAsync(metaId, current);
		} catch {
			// ignore; some backends auto-create folders on write
		}
	}
}

/**
 * Create a serialized async operation queue.
 *
 * @returns {(fn: () => Promise<any>) => Promise<any>} Queue function with a `current` Promise.
 */
function createOpQueue() {
	let op = Promise.resolve();
	const queue = fn => {
		op = op.then(fn, fn);
		queue.current = op;
		return op;
	};
	queue.current = op;
	return queue;
}

module.exports = {
	DEFAULT_MAP_TYPE_MARKER,
	serializeWithMaps,
	deserializeWithMaps,
	ensureMetaObject,
	ensureBaseDir,
	createOpQueue,
	pickI18n,
	formatI18n,
	isObject,
};
