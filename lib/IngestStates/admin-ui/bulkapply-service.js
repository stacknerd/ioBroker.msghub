/**
 * bulkapply-service.js
 * ====================
 *
 * Bulk Apply admin service for the IngestStates admin UI.
 *
 * createBulkApplyService(ctx) is the single export.
 * All domain logic (pattern matching, config merge, managedMeta preservation)
 * and all I/O (ioBroker objects via plugin ctx) are encapsulated within the factory.
 * Nothing is exposed at module level.
 *
 * Integration:
 *   Instantiated in IngestStates/index.js start() and injected into createRpcHandler.
 *   All I/O uses the same ctx handles as presets-service.js.
 */

'use strict';

const { jsonCustomDefaults } = require('../constants');

/**
 * Create the Bulk Apply admin service.
 *
 * @param {object} ctx Plugin context injected by IoPlugins at plugin start.
 * @returns {object} Bulk Apply service: { bootstrap, configRead, preview, apply }.
 */
function createBulkApplyService(ctx) {
	// ── I/O handles ──────────────────────────────────────────────────────────

	const ioObjects = ctx.api.iobroker.objects;
	const ids = ctx.api.iobroker.ids;
	const baseFullId = ctx.meta.plugin.baseFullId;

	// Adapter namespace (e.g. 'msghub.0') — used as the common.custom key for IngestStates data.
	const customKey = ids.namespace;

	// Prefix for own adapter objects — skipped during bulk operations.
	const ownPrefix = `${customKey}.`;

	// ── Generic value helpers ─────────────────────────────────────────────────

	/**
	 * Deep-clone a plain JSON value.
	 *
	 * @param {any} value Source value.
	 * @returns {any} Deep-cloned value.
	 */
	function cloneJson(value) {
		return JSON.parse(JSON.stringify(value ?? null));
	}

	/**
	 * Check whether a value is a non-array plain object.
	 *
	 * @param {any} value Candidate value.
	 * @returns {boolean} True when the value is a plain object.
	 */
	function isPlainObject(value) {
		return value !== null && typeof value === 'object' && !Array.isArray(value);
	}

	// ── IngestStates custom-config helpers (ported from IoAdminTab verbatim) ──

	/**
	 * Sanitize an IngestStates custom config entry.
	 * Removes dot-containing keys and any value that is itself an object (Level 3 data).
	 *
	 * @param {any} entry Raw custom config entry.
	 * @returns {any} Sanitized entry (or cloned non-object value).
	 */
	function sanitizeCustom(entry) {
		const out = cloneJson(entry);
		if (!isPlainObject(out)) {
			return out;
		}

		for (const [key, value] of Object.entries(out)) {
			if (typeof key !== 'string' || !key || key.includes('.')) {
				delete out[key];
				continue;
			}
			if (isPlainObject(value)) {
				delete out[key];
			}
		}

		return out;
	}

	/**
	 * Strip managedMeta keys from a custom config entry.
	 * managedMeta keys are written by the runtime and must not be overwritten by bulk ops.
	 *
	 * @param {any} entry Custom config entry.
	 * @returns {any} Cloned entry without managedMeta-* keys.
	 */
	function stripManagedMeta(entry) {
		const x = cloneJson(entry);
		if (!isPlainObject(x)) {
			return x;
		}

		for (const k of Object.keys(x)) {
			if (String(k).startsWith('managedMeta-')) {
				delete x[k];
			}
		}
		return x;
	}

	/**
	 * Pick existing managedMeta keys from a custom entry so they can be preserved on write.
	 *
	 * @param {any} entry Custom config entry.
	 * @returns {object} Cloned object containing only managedMeta-* keys.
	 */
	function pickManagedMeta(entry) {
		if (!isPlainObject(entry)) {
			return {};
		}

		const keep = {};
		for (const [k, v] of Object.entries(entry)) {
			if (String(k).startsWith('managedMeta-')) {
				keep[k] = cloneJson(v);
			}
		}
		return keep;
	}

	/**
	 * Re-attach preserved managedMeta keys to a new custom payload.
	 *
	 * @param {any} base Existing custom entry (source of managedMeta keys).
	 * @param {any} next Next custom entry to write (must already be managedMeta-free).
	 * @returns {object} Next entry with preserved managedMeta keys re-attached.
	 */
	function attachManagedMeta(base, next) {
		const out = isPlainObject(next) ? cloneJson(next) : {};
		const keep = pickManagedMeta(base);
		for (const [k, v] of Object.entries(keep)) {
			out[k] = v;
		}
		return out;
	}

	/**
	 * Deep-merge a patch object into a base object.
	 * Non-object values in the patch overwrite the base directly.
	 *
	 * @param {any} base Base object.
	 * @param {any} patch Patch to apply.
	 * @returns {any} Merged result.
	 */
	function mergeDeep(base, patch) {
		if (!isPlainObject(base) || !isPlainObject(patch)) {
			return cloneJson(patch);
		}
		const out = { ...base };
		for (const [k, v] of Object.entries(patch)) {
			if (isPlainObject(v) && isPlainObject(out[k])) {
				out[k] = mergeDeep(out[k], v);
			} else {
				out[k] = cloneJson(v);
			}
		}
		return out;
	}

	// ── Service methods ───────────────────────────────────────────────────────

	/**
	 * Return bootstrap data needed to initialise the Bulk Apply panel.
	 *
	 * @returns {Promise<{ ok: true, data: { namespace: string, jsonCustomDefaults: object } }>} Successful bootstrap response.
	 */
	async function bootstrap() {
		return {
			ok: true,
			data: {
				namespace: baseFullId,
				jsonCustomDefaults,
			},
		};
	}

	/**
	 * Read the current IngestStates custom config for a single ioBroker object.
	 *
	 * @param {{ id?: string }} payload Request payload.
	 * @returns {Promise<{ ok: boolean, data?: { custom: object|null }, error?: object }>} RPC response with the object custom config.
	 */
	async function configRead(payload) {
		const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
		if (!id) {
			return { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing id' } };
		}

		const obj = await ioObjects.getForeignObject(id);
		if (!obj) {
			return { ok: false, error: { code: 'NOT_FOUND', message: `Object not found: '${id}'` } };
		}

		const entry =
			obj?.common && isPlainObject(obj.common) && obj.common.custom && isPlainObject(obj.common.custom)
				? obj.common.custom[customKey]
				: null;

		const entryNoMeta = entry && isPlainObject(entry) ? stripManagedMeta(entry) : null;
		const custom = entryNoMeta && isPlainObject(entryNoMeta) ? sanitizeCustom(entryNoMeta) : null;

		return { ok: true, data: { custom } };
	}

	/**
	 * Preview the effect of applying a custom config patch to all matching ioBroker state objects.
	 *
	 * @param {{ pattern?: string, custom?: object, replace?: boolean, limit?: number }} payload Preview request payload.
	 * @returns {Promise<{ ok: boolean, data?: { pattern, totalObjects, matchedStates, willChange, unchanged, sample }, error?: object }>} RPC response with preview statistics.
	 */
	async function preview(payload) {
		const pattern = typeof payload?.pattern === 'string' ? payload.pattern.trim() : '';
		if (!pattern) {
			return { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing pattern' } };
		}

		if (!isPlainObject(payload?.custom)) {
			return { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing custom config (object)' } };
		}

		const replace = payload?.replace === true;
		const limitRaw = Number(payload?.limit);
		const limit = Number.isFinite(limitRaw) ? Math.max(0, Math.min(500, Math.trunc(limitRaw))) : 50;

		const customPatch = sanitizeCustom(stripManagedMeta(payload.custom));

		const objects = await ioObjects.getForeignObjects(pattern);

		let total = 0;
		let matchedStates = 0;
		let willChange = 0;
		let unchanged = 0;
		const sample = [];

		for (const [id, obj] of Object.entries(objects || {})) {
			total += 1;
			if (typeof id !== 'string' || !id || id.startsWith(ownPrefix)) {
				continue;
			}
			if (obj?.type !== 'state') {
				continue;
			}
			matchedStates += 1;

			const existing =
				obj?.common && isPlainObject(obj.common) && obj.common.custom && isPlainObject(obj.common.custom)
					? obj.common.custom[customKey]
					: null;

			const existingNoMeta =
				existing && isPlainObject(existing) ? sanitizeCustom(stripManagedMeta(existing)) : null;
			const nextNoMeta = replace
				? customPatch
				: mergeDeep(existingNoMeta && isPlainObject(existingNoMeta) ? existingNoMeta : {}, customPatch);
			const next = attachManagedMeta(existing, nextNoMeta);

			const existingJson = JSON.stringify(existing && isPlainObject(existing) ? existing : null);
			const nextJson = JSON.stringify(next);
			const isChanged = existingJson !== nextJson;

			if (isChanged) {
				willChange += 1;
			} else {
				unchanged += 1;
			}

			if (sample.length < limit) {
				sample.push({ id, changed: isChanged });
			}
		}

		return {
			ok: true,
			data: { pattern, totalObjects: total, matchedStates, willChange, unchanged, sample },
		};
	}

	/**
	 * Apply a custom config patch to all matching ioBroker state objects.
	 *
	 * Per-object errors are collected but do not abort the whole operation.
	 * The caller must inspect errors[] to distinguish full success from partial failure.
	 *
	 * @param {{ pattern?: string, custom?: object, replace?: boolean }} payload Apply request payload.
	 * @returns {Promise<{ ok: boolean, data?: { errors: Array<{id: string, message: string}> }, error?: object }>} RPC response with per-object write errors.
	 */
	async function apply(payload) {
		const pattern = typeof payload?.pattern === 'string' ? payload.pattern.trim() : '';
		if (!pattern) {
			return { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing pattern' } };
		}

		if (!isPlainObject(payload?.custom)) {
			return { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing custom config (object)' } };
		}

		const replace = payload?.replace === true;
		const customPatch = sanitizeCustom(stripManagedMeta(payload.custom));

		const objects = await ioObjects.getForeignObjects(pattern);

		const errors = [];

		for (const [id, obj] of Object.entries(objects || {})) {
			if (typeof id !== 'string' || !id || id.startsWith(ownPrefix)) {
				continue;
			}
			if (obj?.type !== 'state') {
				continue;
			}

			const common = isPlainObject(obj?.common) ? obj.common : {};
			const existing =
				isPlainObject(common.custom) && common.custom[customKey] && isPlainObject(common.custom[customKey])
					? common.custom[customKey]
					: null;

			const existingNoMeta =
				existing && isPlainObject(existing) ? sanitizeCustom(stripManagedMeta(existing)) : null;
			const nextNoMeta = replace
				? customPatch
				: mergeDeep(existingNoMeta && isPlainObject(existingNoMeta) ? existingNoMeta : {}, customPatch);
			const next = attachManagedMeta(existing, nextNoMeta);

			const existingJson = JSON.stringify(existing && isPlainObject(existing) ? existing : null);
			const nextJson = JSON.stringify(next);
			if (existingJson === nextJson) {
				continue;
			}

			try {
				await ioObjects.extendForeignObject(id, { common: { custom: { [customKey]: next } } });
			} catch (e) {
				errors.push({ id, message: String(e?.message || e) });
			}
		}

		return { ok: true, data: { errors } };
	}

	return Object.freeze({ bootstrap, configRead, preview, apply });
}

module.exports = { createBulkApplyService };
