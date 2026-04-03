'use strict';

/**
 * EngageSendTo transport helpers.
 *
 * Purpose:
 * - Keep messagebox-facing transport normalization plugin-owned inside `lib/EngageSendTo/**`.
 * - Accept JSON-safe request payloads and convert them into the in-memory shapes expected by the
 *   MsgHub factory/store boundary used by this plugin.
 * - Encode response payloads into JSON-safe values so `Map` instances can cross the `sendTo(...)`
 *   boundary without leaking core-internal helpers into the runtime layer.
 *
 * Scope:
 * - Used exclusively by `lib/EngageSendTo/index.js`.
 * - Does not import from `src/**`; this preserves the runtime/core layer boundary required by the
 *   architecture roadmap and keeps the behavior fully plugin-owned.
 */

const MAP_TYPE_MARKER = '__msghubType';

/**
 * Test whether a value is a plain object suitable for transport processing.
 *
 * Arrays are intentionally excluded because EngageSendTo payload shapes are object-based.
 *
 * @param {unknown} v Candidate value.
 * @returns {boolean} `true` when the value is a non-null object and not an array.
 */
function isObject(v) {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Serialize a value into JSON while preserving `Map` instances via a marker object.
 *
 * The result is transport-safe and can be passed through ioBroker's messagebox callback channel.
 *
 * @param {any} value Value to serialize.
 * @param {string} [mapTypeMarker] Marker key used for encoded maps.
 * @returns {string} JSON string with map payloads encoded as plain objects.
 */
function serializeWithMaps(value, mapTypeMarker = MAP_TYPE_MARKER) {
	return JSON.stringify(value, (key, val) => {
		if (val instanceof Map) {
			return { [mapTypeMarker]: 'Map', value: Array.from(val.entries()) };
		}
		return val;
	});
}

/**
 * Convert a runtime value into a plain JSON-safe structure.
 *
 * This is the response-side companion to the request reviver below and mirrors the documented
 * `Map` transport shape used by EngageSendTo.
 *
 * @param {any} value Runtime value that may contain `Map` instances.
 * @returns {any} Plain JSON-safe clone with maps encoded.
 */
function toJsonSafe(value) {
	return JSON.parse(serializeWithMaps(value));
}

/**
 * Recursively revive transport payload values into the richer runtime shapes used inside the plugin.
 *
 * Currently this restores the documented encoded-`Map` representation back into real `Map`
 * instances. All other objects are cloned recursively so callers receive a detached structure.
 *
 * @param {any} value Transport payload value.
 * @param {string} [mapTypeMarker] Marker key used for encoded maps.
 * @returns {any} Revived runtime value.
 */
function reviveTransportValue(value, mapTypeMarker = MAP_TYPE_MARKER) {
	if (Array.isArray(value)) {
		return value.map(item => reviveTransportValue(item, mapTypeMarker));
	}
	if (!value || typeof value !== 'object') {
		return value;
	}
	if (value[mapTypeMarker] === 'Map' && Array.isArray(value.value)) {
		return new Map(value.value.map(([key, item]) => [key, reviveTransportValue(item, mapTypeMarker)]));
	}
	const out = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] = reviveTransportValue(item, mapTypeMarker);
	}
	return out;
}

/**
 * Normalize a create-like payload (`create`, `createIfAbsent`, `upsert` create-path).
 *
 * Ergonomic rule:
 * - `metrics` may be supplied as a plain object keyed by metric id.
 * - Encoded maps are also accepted and revived before the factory sees the payload.
 *
 * The output is suitable for `factory.createMessage(...)`, which expects `metrics` as a `Map`.
 *
 * @param {any} payload Incoming transport payload.
 * @returns {any} Normalized payload ready for create-like processing.
 */
function normalizeCreateLikePayload(payload) {
	if (!isObject(payload)) {
		return payload;
	}
	const out = reviveTransportValue(payload);
	if (isObject(out.metrics) && !('set' in out.metrics) && !('delete' in out.metrics)) {
		out.metrics = new Map(Object.entries(out.metrics));
	}
	return out;
}

/**
 * Normalize a patch-like payload (`patch`, `patchIfPresent`).
 *
 * Unlike create-like payloads, patch payloads must preserve the patch semantics owned by the
 * factory/store layer. Therefore this helper revives encoded maps but does not coerce plain
 * `metrics` objects into full replacement maps.
 *
 * @param {any} payload Incoming transport payload.
 * @returns {any} Normalized payload ready for patch-like processing.
 */
function normalizePatchLikePayload(payload) {
	return reviveTransportValue(payload);
}

module.exports = {
	MAP_TYPE_MARKER,
	isObject,
	normalizeCreateLikePayload,
	normalizePatchLikePayload,
	reviveTransportValue,
	serializeWithMaps,
	toJsonSafe,
};
