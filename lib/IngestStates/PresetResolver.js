'use strict';

const PRESET_SCHEMA = 'msghub.IngestStatesMessagePreset.v1';

/**
 * Create a preset resolver for this plugin instance.
 *
 * This is intentionally read-only: it only reads a preset state value and parses/validates it.
 *
 * @param {object} ctx Plugin runtime context (`ctx.api.*`, `ctx.meta.plugin.*`).
 * @returns {{ resolvePreset: (presetId: string) => Promise<{ presetId: string, preset: any, objectId: string }|null> }}
 *   Resolver API.
 */
function createPresetResolver(ctx) {
	/**
	 * Narrow "plain object" check used throughout validation.
	 *
	 * Note: Arrays are intentionally rejected because presets are expected to be JSON objects.
	 *
	 * @param {any} value Candidate value.
	 * @returns {boolean} True when value is a non-array object.
	 */
	function isObject(value) {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	/**
	 * Validate the user-facing preset id token (the suffix after `.presets.`).
	 *
	 * This is deliberately strict: preset ids must be safe for ioBroker object ids and for use
	 * in refs/logging without escaping.
	 *
	 * @param {any} presetId Candidate preset id.
	 * @returns {boolean} True when presetId is a safe identifier.
	 */
	function isValidPresetId(presetId) {
		const s = typeof presetId === 'string' ? presetId.trim() : '';
		return !!s && /^[A-Za-z0-9_-]+$/.test(s);
	}

	/**
	 * Best-effort: pick a readable name from an ioBroker translated string.
	 *
	 * Used only for diagnostics/log output (never for correctness decisions).
	 *
	 * @param {any} value `common.name` value.
	 * @returns {string} Chosen string or empty string.
	 */
	function translatedName(value) {
		if (typeof value === 'string') {
			return value.trim();
		}
		if (!value || typeof value !== 'object') {
			return '';
		}
		const preferred = value.en || value.de;
		if (typeof preferred === 'string' && preferred.trim()) {
			return preferred.trim();
		}
		return '';
	}

	/**
	 * Validate the minimal preset shape for runtime consumption.
	 *
	 * This is intentionally minimal (Etappe 3): we only guard against missing schema/id and missing
	 * required message fields that would otherwise cause silent empty messages or runtime errors.
	 *
	 * @param {any} preset Parsed preset JSON object.
	 * @param {string} expectedPresetId Expected preset id (from object id suffix).
	 * @returns {string|null} Error string or null when valid.
	 */
	function validatePreset(preset, expectedPresetId) {
		if (!isObject(preset)) {
			return 'missing preset object';
		}
		if (typeof preset.schema !== 'string' || preset.schema.trim() !== PRESET_SCHEMA) {
			return `invalid schema (expected '${PRESET_SCHEMA}')`;
		}
		if (typeof preset.presetId !== 'string' || preset.presetId.trim() !== expectedPresetId) {
			return `presetId mismatch (expected '${expectedPresetId}')`;
		}

		const msg = preset.message;
		if (!isObject(msg)) {
			return 'missing message object';
		}
		const kind = typeof msg.kind === 'string' ? msg.kind.trim() : '';
		if (!kind) {
			return 'missing message.kind';
		}
		if (typeof msg.level !== 'number' || !Number.isFinite(msg.level)) {
			return 'missing/invalid message.level';
		}
		const title = typeof msg.title === 'string' ? msg.title.trim() : '';
		if (!title) {
			return 'missing message.title';
		}
		const text = typeof msg.text === 'string' ? msg.text.trim() : '';
		if (!text) {
			return 'missing message.text';
		}

		if (preset.policy !== undefined && preset.policy !== null && !isObject(preset.policy)) {
			return 'invalid policy object';
		}

		return null;
	}

	const log = ctx?.api?.log;
	const getObj = ctx?.api?.iobroker?.objects?.getForeignObject;
	const getState = ctx?.api?.iobroker?.states?.getForeignState;

	// Resolve preset ids relative to this adapter instance (namespace) and this plugin instance id.
	const ns = typeof ctx?.api?.iobroker?.ids?.namespace === 'string' ? ctx.api.iobroker.ids.namespace.trim() : '';
	const instanceId = ctx?.meta?.plugin?.instanceId;
	const inst = Number.isFinite(instanceId) ? Math.trunc(instanceId) : 0;
	const baseFullId =
		typeof ctx?.meta?.plugin?.baseFullId === 'string' && ctx.meta.plugin.baseFullId.trim()
			? ctx.meta.plugin.baseFullId.trim()
			: '';

	// Prefix all log output with the plugin base id so logs are searchable across instances.
	const prefix = baseFullId ? `${baseFullId}: IngestStates presets: ` : 'IngestStates presets: ';

	/**
	 * Resolve a preset id into a validated preset object.
	 *
	 * Semantics:
	 * - returns `{ presetId, preset, objectId }` on success
	 * - returns `null` on any failure and logs an error (no fallback in Etappe 3 by design)
	 *
	 * I/O:
	 * - reads object metadata (for existence + optional display name in log)
	 * - reads the state value (JSON string) and parses/validates it
	 *
	 * @param {string} presetId Preset id token (e.g. `sensorRepair`).
	 * @returns {Promise<{ presetId: string, preset: any, objectId: string }|null>} Resolved preset or null.
	 */
	const resolvePreset = async presetId => {
		// Step 1: validate the id token early (cheap guard; keeps logs clean).
		const id = typeof presetId === 'string' ? presetId.trim() : '';
		if (!isValidPresetId(id)) {
			if (typeof log?.error === 'function') {
				log.error(`${prefix}invalid presetId '${String(presetId)}'`);
			}
			return null;
		}

		// Step 2: ensure we have the required ioBroker read APIs on ctx.api.
		if (typeof getObj !== 'function' || typeof getState !== 'function') {
			if (typeof log?.error === 'function') {
				log.error(`${prefix}iobroker objects/states API not available`);
			}
			return null;
		}

		// Step 3: build the full state id and fetch object + state.
		const objectId = ns ? `${ns}.IngestStates.${inst}.presets.${id}` : `IngestStates.${inst}.presets.${id}`;

		try {
			const obj = await getObj(objectId);
			if (!obj) {
				log?.error?.(`${prefix}missing preset object '${objectId}'`);
				return null;
			}

			const st = await getState(objectId);
			const raw = typeof st?.val === 'string' ? st.val.trim() : '';
			if (!raw) {
				log?.error?.(`${prefix}missing preset JSON in state '${objectId}'`);
				return null;
			}

			// Step 4: parse JSON and validate minimal schema.
			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				log?.error?.(`${prefix}invalid preset JSON in state '${objectId}'`);
				return null;
			}

			const err = validatePreset(parsed, id);
			if (err) {
				// Attach the human-friendly preset name to the log when available to help debugging.
				const name = translatedName(obj?.common?.name);
				const nameSuffix = name ? ` (name='${name}')` : '';
				log?.error?.(`${prefix}invalid preset '${id}'${nameSuffix}: ${err}`);
				return null;
			}

			return { presetId: id, preset: parsed, objectId };
		} catch (e) {
			// Any unexpected ioBroker errors are swallowed but surfaced via log for diagnosis.
			log?.error?.(`${prefix}failed to resolve preset '${id}': ${e?.message || e}`);
			return null;
		}
	};

	// Public API for the engine/writer: resolve by presetId token, return preset or null.
	return Object.freeze({ resolvePreset });
}

module.exports = { createPresetResolver, PRESET_SCHEMA };
