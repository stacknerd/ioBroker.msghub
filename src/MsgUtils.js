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

/**
 * Normalize a routing channel string for matching (trim + lower-case).
 *
 * @param {any} value Input value.
 * @returns {string} Normalized channel (or empty string).
 */
function normalizeRoutingChannel(value) {
	return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Normalize a list of routing channel strings.
 *
 * @param {any} list Input list.
 * @returns {string[]} Normalized channel list.
 */
function normalizeRoutingList(list) {
	if (!Array.isArray(list)) {
		return [];
	}
	const out = [];
	for (const item of list) {
		const s = normalizeRoutingChannel(item);
		if (s) {
			out.push(s);
		}
	}
	return out;
}

/**
 * Decide whether a message should be dispatched to a given plugin routing channel.
 *
 * Semantics:
 * - plugin channel empty => only unscoped messages (include empty)
 * - plugin channel set => exclude blocks, include restricts
 *
 * @param {any} message Message-like object (expects `audience.channels.include/exclude`).
 * @param {any} pluginChannel Plugin channel value.
 * @returns {boolean} True when the message should be dispatched.
 */
function shouldDispatchByAudienceChannels(message, pluginChannel) {
	const channel = normalizeRoutingChannel(pluginChannel);
	if (channel === '*' || channel === 'all') {
		return true;
	}

	const audience = message && typeof message === 'object' ? message.audience : null;
	const channels = audience && typeof audience === 'object' ? audience.channels : null;

	const include = normalizeRoutingList(channels && typeof channels === 'object' ? channels.include : null);
	const exclude = normalizeRoutingList(channels && typeof channels === 'object' ? channels.exclude : null);

	// Semantics
	// - If plugin channel is empty: deliver only for "unscoped" messages (include empty).
	//   Exclude is ignored for empty plugin channels.
	// - If plugin channel is set:
	//   - exclude wins
	//   - include restricts when non-empty
	if (!channel) {
		return include.length === 0;
	}

	if (exclude.includes(channel)) {
		return false;
	}
	if (include.length > 0 && !include.includes(channel)) {
		return false;
	}
	return true;
}

module.exports = {
	DEFAULT_MAP_TYPE_MARKER,
	serializeWithMaps,
	deserializeWithMaps,
	ensureMetaObject,
	ensureBaseDir,
	createOpQueue,
	isObject,
	normalizeRoutingChannel,
	normalizeRoutingList,
	shouldDispatchByAudienceChannels,
};
