/**
 * IoAdminTab
 * ==========
 * Adapter-side Admin Tab command facade for MsgHub.
 *
 * Responsibilities
 * - Handle adminTab sendTo commands (`admin.*`) and map them to runtime services.
 * - Normalize payloads and shape responses (DTOs) for the frontend.
 * - Perform non-blocking diagnostics useful for users (e.g. warn about unknown native keys).
 *
 * Non-responsibilities
 * - Plugin runtime orchestration (start/stop/restart) → owned by `IoPlugins`.
 * - ioBroker messagebox dispatch for Engage plugins → owned by `IoPlugins`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isObject, serializeWithMaps } = require(`${__dirname}/../src/MsgUtils`);
const { MsgConstants } = require(`${__dirname}/../src/MsgConstants`);
const { IoArchiveResolver } = require(`${__dirname}/IoArchiveResolver`);
const { presetSchema, presetTemplateV1, fallbackPresetId, jsonCustomDefaults } = require('./IngestStates/constants');

/**
 * Adapter-side Admin Tab command facade for MsgHub.
 *
 * Routes `sendTo` commands from the Admin tab (e.g. `admin.plugins.*`) to the
 * runtime services (currently `IoPlugins`) and returns frontend-friendly DTOs.
 */
class IoAdminTab {
	static INGEST_STATES_PRESET_SCHEMA = 'msghub.IngestStatesMessagePreset.v1';

	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} adapter
	 *   ioBroker adapter instance (used for logging and namespace).
	 * @param {import('./IoPlugins').IoPlugins|null} ioPlugins
	 *   Plugin runtime manager to delegate admin actions to (can be null if plugin wiring failed).
	 * @param {object} [options] Optional runtime services.
	 * @param {import('../src/MsgAi').MsgAi|null} [options.ai] Optional MsgAi instance for diagnostics.
	 * @param {any} [options.msgStore] Optional MsgStore instance for diagnostics.
	 * @param {(options: object) => Promise<{ok:boolean, reason:string}>} [options.archiveProbeNative]
	 *   Optional native archive probe function (test hook). Defaults to `IoArchiveResolver.probeNativeFor`.
	 */
	constructor(adapter, ioPlugins, { ai = null, msgStore = null, archiveProbeNative } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoAdminTab: adapter is required');
		}
		this.adapter = adapter;
		this.ioPlugins = ioPlugins && typeof ioPlugins === 'object' ? ioPlugins : null;
		this.ai = ai && typeof ai === 'object' ? ai : null;
		this.msgStore = msgStore && typeof msgStore === 'object' ? msgStore : null;
		this._archiveProbeNative = typeof archiveProbeNative === 'function' ? archiveProbeNative : null;

		// Cache to prevent log spam: instanceKey -> "k1,k2,k3"
		this._unknownNativeKeysCache = new Map();

		// Cache for schema parsing (admin/jsonCustom.json -> Bulk Apply schema)
		this._ingestStatesSchemaCache = null;
	}

	/**
	 * Standard error response when IoPlugins is not wired.
	 *
	 * @returns {{ ok: false, error: { code: string, message: string } }} Error response wrapper.
	 */
	_pluginsNotReady() {
		return this._err('NOT_READY', 'Plugin runtime not ready');
	}

	/**
	 * Wrap a successful response payload for the Admin tab.
	 *
	 * @param {any} data Response payload.
	 * @returns {{ ok: true, data: any, native?: any }} Ok response wrapper.
	 */
	_ok(data) {
		return { ok: true, data: data || {} };
	}

	/**
	 * Wrap an error response for the Admin tab.
	 *
	 * @param {string} code Error code.
	 * @param {string} message Error message.
	 * @returns {{ ok: false, error: { code: string, message: string }, native?: any }} Error response wrapper.
	 */
	_err(code, message) {
		return { ok: false, error: { code: String(code || 'ERROR'), message: String(message || 'Error') } };
	}

	/**
	 * Translate an i18n key via `adapter.i18n.t`.
	 *
	 * This helper centralizes the "is i18n available" guard so call sites stay readable.
	 * It intentionally throws when i18n is not ready because AdminTab strings should not silently degrade.
	 *
	 * @param {string} key i18n key.
	 * @returns {string} Translated string.
	 */
	_t(key) {
		const adapter = this.adapter;
		if (!adapter || typeof adapter !== 'object' || !('i18n' in adapter)) {
			throw new Error('IoAdminTab: i18n not ready');
		}

		const i18n = adapter.i18n;
		if (!i18n || typeof i18n !== 'object' || !('t' in i18n)) {
			throw new Error('IoAdminTab: i18n not ready');
		}
		const t = i18n.t;
		if (typeof t !== 'function') {
			throw new Error('IoAdminTab: i18n not ready');
		}
		return t(key);
	}

	/**
	 * Capitalize the first character of a string (after trimming).
	 *
	 * Used for display labels in the Admin UI; empty/non-string inputs return `''`.
	 *
	 * @param {any} str Input.
	 * @returns {string} Capitalized string (or empty string).
	 */
	_capitalizeFirstChar(str) {
		const s = typeof str === 'string' ? str.trim() : '';
		if (!s) {
			return '';
		}
		return s.length === 1 ? s.toUpperCase() : `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
	}

	/**
	 * Resolve a MsgConstants level name (key) from a numeric level value.
	 *
	 * Example: `20` -> `'notice'` (depending on `MsgConstants.level` mapping).
	 *
	 * @param {any} level Candidate level value.
	 * @returns {string} Level key or `''` when unknown/invalid.
	 */
	_levelKey(level) {
		if (typeof level !== 'number' || !Number.isFinite(level)) {
			return '';
		}
		const map = MsgConstants?.level && typeof MsgConstants.level === 'object' ? MsgConstants.level : {};
		for (const [k, v] of Object.entries(map)) {
			if (v === level) {
				return k;
			}
		}
		return '';
	}

	/**
	 * Normalize a message kind into a translation key suffix.
	 *
	 * @param {any} kind Candidate kind.
	 * @returns {string} Lowercased kind token or `''`.
	 */
	_kindKey(kind) {
		return typeof kind === 'string' && kind.trim() ? kind.trim().toLowerCase() : '';
	}

	/**
	 * Build a human-friendly preset label for Admin UI lists.
	 *
	 * The label combines:
	 * - owner (`preset.ownedBy`) mapped to a localized rule header, and
	 * - message kind + level, and
	 * - the ioBroker object name (or `presetId` as fallback).
	 *
	 * @param {object} info Inputs.
	 * @param {string} info.presetId Preset id (fallback label component).
	 * @param {object} info.obj ioBroker preset object (used for name).
	 * @param {object} info.preset Preset JSON payload (used for ownedBy/kind/level).
	 * @returns {string} Display label.
	 */
	_presetLabel({ presetId, obj, preset }) {
		const rawName =
			typeof obj?.common?.name === 'string'
				? obj.common.name
				: obj?.common?.name && typeof obj.common.name === 'object'
					? obj.common.name.en || obj.common.name.de || ''
					: '';
		const name = this._capitalizeFirstChar(rawName) || presetId;

		const ownedBy = typeof preset?.ownedBy === 'string' ? preset.ownedBy.trim() : '';
		const ownerKey = ownedBy.toLowerCase();

		const ownerText = ownedBy
			? this._t(`msghub.i18n.IngestStates.admin.jsonCustom.rules.${ownerKey}.header.text`)
			: this._t(`msghub.i18n.IngestStates.admin.jsonCustom.preset.custom.label`);

		const kindKey = this._kindKey(preset?.message?.kind);
		const kindText = this._t(`msghub.i18n.core.admin.common.MsgConstants.kind.${kindKey}.label`);

		const levelKey = this._levelKey(preset?.message?.level);
		const levelText = levelKey ? this._t(`msghub.i18n.core.admin.common.MsgConstants.level.${levelKey}.label`) : '';

		return `${ownerText} ${kindText}${levelText ? ` (${levelText})` : ''}: ${name}`;
	}

	/**
	 * Best-effort warn about unknown `native.*` keys for plugin instances.
	 *
	 * This helps detect config drift, but does not block or mutate any data.
	 *
	 * @param {{ plugins: any[], instances: any[] }} data Plugin catalog + instances.
	 * @returns {void} Nothing.
	 */
	_warnUnknownNativeKeys({ plugins, instances }) {
		try {
			const allowedByType = new Map();
			for (const p of plugins || []) {
				if (!p?.type) {
					continue;
				}
				// `native.*` keys that are not part of the manifest options schema, but are still valid.
				// - `enabled`: mirrored desired enable state (for admin UI)
				// - `channel`: optional routing channel for message audience filtering (Notify/Bridge/Engage)
				const allowed = new Set(['enabled', 'channel']);
				if (isObject(p.options)) {
					for (const k of Object.keys(p.options)) {
						allowed.add(k);
					}
				}
				if (isObject(p.defaultOptions)) {
					for (const k of Object.keys(p.defaultOptions)) {
						allowed.add(k);
					}
				}
				allowedByType.set(p.type, allowed);
			}

			for (const inst of instances || []) {
				const type = typeof inst?.type === 'string' ? inst.type : '';
				const instanceId = Number.isFinite(inst?.instanceId) ? Math.trunc(inst.instanceId) : NaN;
				if (!type || !Number.isFinite(instanceId)) {
					continue;
				}
				const allowed = allowedByType.get(type);
				if (!allowed) {
					continue;
				}
				const native = isObject(inst?.native) ? inst.native : {};
				const unknown = Object.keys(native)
					.filter(k => !allowed.has(k))
					.sort();
				if (unknown.length === 0) {
					this._unknownNativeKeysCache.delete(`${type}.${instanceId}`);
					continue;
				}
				const sig = unknown.join(',');
				const key = `${type}.${instanceId}`;
				if (this._unknownNativeKeysCache.get(key) === sig) {
					continue;
				}
				this._unknownNativeKeysCache.set(key, sig);
				this.adapter?.log?.warn?.(
					`AdminTab: unknown native keys for '${this.adapter.namespace}.${type}.${instanceId}': ${unknown.join(', ')}`,
				);
			}
		} catch {
			// swallow
		}
	}

	/**
	 * Handle `admin.plugins.getCatalog`.
	 *
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Catalog response wrapper.
	 */
	async _pluginsGetCatalog() {
		if (!this.ioPlugins || typeof this.ioPlugins.getCatalog !== 'function') {
			return this._pluginsNotReady();
		}
		const plugins = this.ioPlugins.getCatalog();
		return this._ok({ plugins });
	}

	/**
	 * Handle `admin.plugins.listInstances`.
	 *
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Instances response wrapper.
	 */
	async _pluginsListInstances() {
		if (
			!this.ioPlugins ||
			typeof this.ioPlugins.getCatalog !== 'function' ||
			typeof this.ioPlugins.listInstances !== 'function'
		) {
			return this._pluginsNotReady();
		}
		const plugins = this.ioPlugins.getCatalog();
		const instances = await this.ioPlugins.listInstances();
		this._warnUnknownNativeKeys({ plugins, instances });
		return this._ok({ instances });
	}

	/**
	 * Handle `admin.plugins.createInstance`.
	 *
	 * @param {any} payload Create payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Create response wrapper.
	 */
	async _pluginsCreateInstance(payload) {
		if (!this.ioPlugins || typeof this.ioPlugins.createInstance !== 'function') {
			return this._pluginsNotReady();
		}
		return this._ok(await this.ioPlugins.createInstance(payload));
	}

	/**
	 * Handle `admin.plugins.deleteInstance`.
	 *
	 * @param {any} payload Delete payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Delete response wrapper.
	 */
	async _pluginsDeleteInstance(payload) {
		if (!this.ioPlugins || typeof this.ioPlugins.deleteInstance !== 'function') {
			return this._pluginsNotReady();
		}
		await this.ioPlugins.deleteInstance(payload);
		return this._ok({});
	}

	/**
	 * Handle `admin.plugins.updateInstance`.
	 *
	 * @param {any} payload Update payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Update response wrapper.
	 */
	async _pluginsUpdateInstance(payload) {
		if (!this.ioPlugins || typeof this.ioPlugins.updateInstanceNative !== 'function') {
			return this._pluginsNotReady();
		}
		await this.ioPlugins.updateInstanceNative(payload);
		return this._ok({});
	}

	/**
	 * Handle `admin.plugins.setEnabled`.
	 *
	 * @param {any} payload Enable payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Enable response wrapper.
	 */
	async _pluginsSetEnabled(payload) {
		if (!this.ioPlugins || typeof this.ioPlugins.setInstanceEnabled !== 'function') {
			return this._pluginsNotReady();
		}
		await this.ioPlugins.setInstanceEnabled(payload);
		return this._ok({});
	}

	/**
	 * Resolve whether `IngestStates` is available + enabled.
	 *
	 * @returns {Promise<{ ok: true, enabled: true } | { ok: false, error: { code: string, message: string } }>}
	 *   Enabled status wrapper (error when missing/disabled/not ready).
	 */
	async _ingestStatesEnsureEnabled() {
		if (!this.ioPlugins || typeof this.ioPlugins.listInstances !== 'function') {
			return this._pluginsNotReady();
		}

		const instances = await this.ioPlugins.listInstances();
		const inst = (instances || []).find(x => x?.type === 'IngestStates' && x?.instanceId === 0) || null;
		if (!inst) {
			return this._err('PLUGIN_NOT_FOUND', 'IngestStates is not configured (create/enable the plugin first)');
		}
		if (inst.enabled !== true) {
			return this._err('PLUGIN_DISABLED', 'IngestStates is disabled (enable the plugin first)');
		}
		return { ok: true, enabled: true };
	}

	/**
	 * Read foreign objects by wildcard pattern.
	 *
	 * @param {string} pattern ioBroker object id pattern.
	 * @returns {Promise<Record<string, any>>} Objects by id.
	 */
	async _getForeignObjects(pattern) {
		const adapter = this.adapter;
		if (typeof adapter?.getForeignObjectsAsync === 'function') {
			return await adapter.getForeignObjectsAsync(pattern);
		}
		if (typeof adapter?.getForeignObjects === 'function') {
			return await new Promise((resolve, reject) => {
				adapter.getForeignObjects(pattern, (err, res) => (err ? reject(err) : resolve(res || {})));
			});
		}
		throw new Error('adapter.getForeignObjects is not available');
	}

	/**
	 * Read a single foreign object by id.
	 *
	 * @param {string} id ioBroker object id.
	 * @returns {Promise<any|null>} Object or null.
	 */
	async _getForeignObject(id) {
		const adapter = this.adapter;
		if (typeof adapter?.getForeignObjectAsync === 'function') {
			return await adapter.getForeignObjectAsync(id);
		}
		if (typeof adapter?.getForeignObject === 'function') {
			return await new Promise((resolve, reject) => {
				adapter.getForeignObject(id, (err, res) => (err ? reject(err) : resolve(res || null)));
			});
		}
		throw new Error('adapter.getForeignObject is not available');
	}

	/**
	 * Read a foreign state by id.
	 *
	 * @param {string} id ioBroker state id.
	 * @returns {Promise<any|null>} State or null.
	 */
	async _getForeignState(id) {
		const adapter = this.adapter;
		if (typeof adapter?.getForeignStateAsync === 'function') {
			return await adapter.getForeignStateAsync(id);
		}
		if (typeof adapter?.getForeignState === 'function') {
			return await new Promise((resolve, reject) => {
				adapter.getForeignState(id, (err, res) => (err ? reject(err) : resolve(res || null)));
			});
		}
		throw new Error('adapter.getForeignState is not available');
	}

	/**
	 * Write a foreign state (ack).
	 *
	 * @param {string} id ioBroker state id.
	 * @param {any} value State value.
	 * @returns {Promise<void>} Resolves when written.
	 */
	async _setForeignStateAck(id, value) {
		const adapter = this.adapter;
		if (typeof adapter?.setForeignStateAsync === 'function') {
			await adapter.setForeignStateAsync(id, value, true);
			return;
		}
		if (typeof adapter?.setForeignState === 'function') {
			await new Promise((resolve, reject) => {
				adapter.setForeignState(id, value, true, err => (err ? reject(err) : resolve(undefined)));
			});
			return;
		}
		throw new Error('adapter.setForeignState is not available');
	}

	/**
	 * Delete a foreign object by id (best-effort).
	 *
	 * @param {string} id ioBroker object id.
	 * @returns {Promise<void>} Resolves when deleted or missing.
	 */
	async _delForeignObject(id) {
		const adapter = this.adapter;
		if (typeof adapter?.delForeignObjectAsync === 'function') {
			await adapter.delForeignObjectAsync(id);
			return;
		}
		if (typeof adapter?.delForeignObject === 'function') {
			await new Promise((resolve, reject) => {
				adapter.delForeignObject(id, err => (err ? reject(err) : resolve(undefined)));
			});
			return;
		}
		throw new Error('adapter.delForeignObject is not available');
	}

	/**
	 * @param {string} presetId Preset id.
	 * @returns {boolean} True when presetId is valid.
	 */
	_isValidPresetId(presetId) {
		const s = typeof presetId === 'string' ? presetId.trim() : '';
		return !!s && /^[A-Za-z0-9_-]+$/.test(s);
	}

	/**
	 * Validate a preset object.
	 *
	 * For Etappe 2 we keep this intentionally minimal and only guard against invalid/empty presets.
	 *
	 * @param {any} preset Candidate preset object.
	 * @param {string} [expectedPresetId] Optional presetId to match.
	 * @returns {string|null} Error string or null when valid.
	 */
	_validateIngestStatesPreset(preset, expectedPresetId = '') {
		if (!isObject(preset)) {
			return 'Missing preset object';
		}
		const schema = typeof preset.schema === 'string' ? preset.schema.trim() : '';
		if (schema !== IoAdminTab.INGEST_STATES_PRESET_SCHEMA) {
			return `Invalid schema (expected '${IoAdminTab.INGEST_STATES_PRESET_SCHEMA}')`;
		}
		const presetId = typeof preset.presetId === 'string' ? preset.presetId.trim() : '';
		if (!this._isValidPresetId(presetId)) {
			return 'Invalid presetId';
		}
		if (expectedPresetId && presetId !== expectedPresetId) {
			return `presetId mismatch (expected '${expectedPresetId}')`;
		}

		const msg = preset.message;
		if (!isObject(msg)) {
			return 'Missing message object';
		}
		const kind = typeof msg.kind === 'string' ? msg.kind.trim() : '';
		if (!kind) {
			return 'Missing message.kind';
		}
		const level = msg.level;
		if (typeof level !== 'number' || !Number.isFinite(level)) {
			return 'Missing/invalid message.level';
		}
		const title = typeof msg.title === 'string' ? msg.title.trim() : '';
		if (!title) {
			return 'Missing message.title';
		}
		const text = typeof msg.text === 'string' ? msg.text.trim() : '';
		if (!text) {
			return 'Missing message.text';
		}

		const policy = preset.policy;
		if (policy !== undefined && policy !== null && !isObject(policy)) {
			return 'Invalid policy object';
		}

		return null;
	}

	/**
	 * @param {string} presetId Preset id.
	 * @returns {string} Full preset state id.
	 */
	_ingestStatesPresetFullId(presetId) {
		const ns = String(this.adapter?.namespace || '').trim();
		return `${ns}.IngestStates.0.presets.${presetId}`;
	}

	/**
	 * Ensure the presets channel exists (best-effort).
	 *
	 * @returns {Promise<void>} Resolves after best-effort ensure.
	 */
	async _ingestStatesEnsurePresetsRoot() {
		const adapter = this.adapter;
		const ns = String(adapter?.namespace || '').trim();
		if (!ns) {
			return;
		}

		const id = `${ns}.IngestStates.0.presets`;
		try {
			const existing = await this._getForeignObject(id);
			if (existing) {
				return;
			}
		} catch {
			// ignore
		}

		try {
			await this._setForeignObject(id, {
				type: 'channel',
				common: { name: 'IngestStates presets' },
				native: {},
			});
		} catch {
			// ignore
		}
	}

	/**
	 * Handle `admin.ingestStates.presets.list`.
	 *
	 * Optional filtering (used by jsonCustom selectSendTo):
	 * - when `payload.rule` is set, presets are returned when `preset.ownedBy` matches the rule
	 *   OR when `preset.ownedBy` is empty (manual/global presets).
	 *
	 * @param {any} payload List payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Options array wrapper.
	 */
	async _ingestStatesPresetsList(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const filterRuleRaw = typeof payload?.rule === 'string' ? payload.rule.trim() : '';
		const filterRule = filterRuleRaw ? filterRuleRaw.toLowerCase() : '';

		const filterSubsetRaw = typeof payload?.subset === 'string' ? payload.subset.trim() : '';
		const filterSubset = filterSubsetRaw ? filterSubsetRaw.toLowerCase() : '';

		await this._ingestStatesEnsurePresetsRoot();

		const ns = String(this.adapter?.namespace || '').trim();
		const prefix = `${ns}.IngestStates.0.presets.`;
		const objects = await this._getForeignObjects(`${prefix}*`);

		const candidates = [];
		for (const [id, obj] of Object.entries(objects || {})) {
			if (typeof id !== 'string' || !id.startsWith(prefix)) {
				continue;
			}
			const presetId = id.slice(prefix.length);
			if (!this._isValidPresetId(presetId)) {
				continue;
			}
			candidates.push({ presetId, obj });
		}

		const reads = await Promise.all(
			candidates.map(async c => {
				try {
					const fullId = this._ingestStatesPresetFullId(c.presetId);
					const st = await this._getForeignState(fullId);
					const raw = typeof st?.val === 'string' ? st.val.trim() : '';
					if (!raw) {
						return null;
					}
					const parsed = JSON.parse(raw);
					const err = this._validateIngestStatesPreset(parsed, c.presetId);
					if (err) {
						return null;
					}
					if (filterRule) {
						const ownedBy = typeof parsed?.ownedBy === 'string' ? parsed.ownedBy.trim() : '';
						const ownerKey = ownedBy ? ownedBy.toLowerCase() : '';
						if (ownerKey && ownerKey !== filterRule) {
							return null;
						}
					}
					if (filterSubset) {
						const subset = typeof parsed?.subset === 'string' ? parsed.subset.trim() : '';
						const subsetKey = subset ? subset.toLowerCase() : '';
						if (subsetKey && subsetKey !== filterSubset) {
							return null;
						}
					}
					const label = this._presetLabel({ presetId: c.presetId, obj: c.obj, preset: parsed });
					const ownedByRaw = typeof parsed?.ownedBy === 'string' ? parsed.ownedBy.trim() : '';
					const hasOwner = !!ownedByRaw;
					return { value: c.presetId, label, hasOwner };
				} catch {
					return null;
				}
			}),
		);

		const out = reads.filter(Boolean);

		out.sort((a, b) => {
			// Order owned presets first, then global/unowned presets.
			// Within each group, sort alphabetically by label.
			const aHasOwner = a?.hasOwner === true;
			const bHasOwner = b?.hasOwner === true;
			if (aHasOwner !== bHasOwner) {
				return aHasOwner ? -1 : 1;
			}
			return String(a?.label || '').localeCompare(String(b?.label || ''));
		});
		const list = [];
		for (const item of out) {
			if (!item) {
				continue;
			}
			list.push({ value: item.value, label: item.label });
		}
		return this._ok(list);
	}

	/**
	 * Handle `admin.ingestStates.presets.get`.
	 *
	 * @param {any} payload Get payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Preset wrapper.
	 */
	async _ingestStatesPresetsGet(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const presetId = typeof payload?.presetId === 'string' ? payload.presetId.trim() : '';
		if (!this._isValidPresetId(presetId)) {
			return this._err('BAD_REQUEST', 'Invalid presetId');
		}

		const fullId = this._ingestStatesPresetFullId(presetId);
		const obj = await this._getForeignObject(fullId);
		if (!obj) {
			return this._err('NOT_FOUND', `Preset '${presetId}' not found`);
		}

		const state = await this._getForeignState(fullId);
		const raw = typeof state?.val === 'string' ? state.val.trim() : '';
		if (!raw) {
			return this._err('INVALID_PRESET', `Preset '${presetId}' has no JSON value`);
		}

		let parsed = null;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return this._err('INVALID_PRESET', `Preset '${presetId}' has invalid JSON`);
		}

		const err = this._validateIngestStatesPreset(parsed, presetId);
		if (err) {
			return this._err('INVALID_PRESET', `Preset '${presetId}' is invalid: ${err}`);
		}

		return this._ok({ presetId, preset: parsed, object: this._cloneJson(obj), state: this._cloneJson(state) });
	}

	/**
	 * Handle `admin.ingestStates.presets.upsert`.
	 *
	 * @param {any} payload Upsert payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Upsert wrapper.
	 */
	async _ingestStatesPresetsUpsert(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const preset = payload?.preset;
		if (!isObject(preset)) {
			return this._err('BAD_REQUEST', 'Missing preset object');
		}
		const presetId = typeof preset.presetId === 'string' ? preset.presetId.trim() : '';
		if (!this._isValidPresetId(presetId)) {
			return this._err('BAD_REQUEST', 'Invalid presetId');
		}

		const err = this._validateIngestStatesPreset(preset, presetId);
		if (err) {
			return this._err('BAD_REQUEST', `Invalid preset: ${err}`);
		}

		const fullId = this._ingestStatesPresetFullId(presetId);
		const existing = await this._getForeignObject(fullId);
		if (existing) {
			let existingPreset = null;
			try {
				const st = await this._getForeignState(fullId);
				const raw = typeof st?.val === 'string' ? st.val.trim() : '';
				existingPreset = raw ? JSON.parse(raw) : null;
			} catch {
				existingPreset = null;
			}
			const ownedBy = typeof existingPreset?.ownedBy === 'string' ? existingPreset.ownedBy.trim() : '';
			if (ownedBy) {
				return this._err('FORBIDDEN', `Preset is owned by '${ownedBy}'`);
			}
		}

		const ownedBy = typeof preset?.ownedBy === 'string' ? preset.ownedBy.trim() : '';
		if (ownedBy) {
			return this._err('FORBIDDEN', 'Preset cannot be created/updated as owned via admin');
		}

		await this._ingestStatesEnsurePresetsRoot();

		const desc = typeof preset.description === 'string' ? preset.description.trim() : '';
		const name = desc || presetId;

		await this._setForeignObject(fullId, {
			_id: fullId,
			type: 'state',
			common: {
				name,
				type: 'string',
				role: 'json',
				read: true,
				write: false,
			},
			native: {},
		});

		await this._setForeignStateAck(fullId, JSON.stringify(preset));
		return this._ok({ presetId });
	}

	/**
	 * Handle `admin.ingestStates.presets.delete`.
	 *
	 * @param {any} payload Delete payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Delete wrapper.
	 */
	async _ingestStatesPresetsDelete(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const presetId = typeof payload?.presetId === 'string' ? payload.presetId.trim() : '';
		if (!this._isValidPresetId(presetId)) {
			return this._err('BAD_REQUEST', 'Invalid presetId');
		}

		const fullId = this._ingestStatesPresetFullId(presetId);
		const obj = await this._getForeignObject(fullId);
		if (!obj) {
			return this._ok({ deleted: false, presetId });
		}

		let existingPreset = null;
		try {
			const st = await this._getForeignState(fullId);
			const raw = typeof st?.val === 'string' ? st.val.trim() : '';
			existingPreset = raw ? JSON.parse(raw) : null;
		} catch {
			existingPreset = null;
		}
		const ownedBy = typeof existingPreset?.ownedBy === 'string' ? existingPreset.ownedBy.trim() : '';
		if (ownedBy) {
			return this._err('FORBIDDEN', `Preset is owned by '${ownedBy}'`);
		}

		await this._delForeignObject(fullId);
		return this._ok({ deleted: true, presetId });
	}

	/**
	 * Write a foreign object (full replace).
	 *
	 * @param {string} id ioBroker object id.
	 * @param {any} obj Object payload.
	 * @returns {Promise<void>} Resolves when written.
	 */
	async _setForeignObject(id, obj) {
		const adapter = this.adapter;
		if (typeof adapter?.setForeignObjectAsync === 'function') {
			await adapter.setForeignObjectAsync(id, obj);
			return;
		}
		if (typeof adapter?.setForeignObject === 'function') {
			await new Promise((resolve, reject) => {
				adapter.setForeignObject(id, obj, err => (err ? reject(err) : resolve(undefined)));
			});
			return;
		}
		throw new Error('adapter.setForeignObject is not available');
	}

	/**
	 * Deep clone (JSON-safe) for config payloads.
	 *
	 * @param {any} value Input.
	 * @returns {any} Cloned value.
	 */
	_cloneJson(value) {
		return JSON.parse(JSON.stringify(value ?? null));
	}

	/**
	 * Deep merge plain objects (arrays/primitives are replaced).
	 *
	 * @param {any} base Base value.
	 * @param {any} patch Patch value.
	 * @returns {any} Merged value.
	 */
	_mergeDeep(base, patch) {
		if (!isObject(base) || !isObject(patch)) {
			return this._cloneJson(patch);
		}
		const out = { ...base };
		for (const [k, v] of Object.entries(patch)) {
			if (isObject(v) && isObject(out[k])) {
				out[k] = this._mergeDeep(out[k], v);
			} else {
				out[k] = this._cloneJson(v);
			}
		}
		return out;
	}

	/**
	 * Sanitize IngestStates Custom configs (flat keys only; no objects; no dot keys).
	 *
	 * @param {any} entry Custom entry (should already be `managedMeta`-free).
	 * @returns {any} Sanitized clone.
	 */
	_sanitizeIngestStatesCustom(entry) {
		const out = this._cloneJson(entry);
		if (!isObject(out)) {
			return out;
		}

		for (const [key, value] of Object.entries(out)) {
			if (typeof key !== 'string' || !key || key.includes('.')) {
				delete out[key];
				continue;
			}
			if (isObject(value)) {
				delete out[key];
			}
		}

		return out;
	}

	/**
	 * Remove managed meta keys from a Custom entry so bulk operations never touch `managedMeta`.
	 *
	 * This removes both:
	 * - `managedMeta-*` (flat managed meta keys)
	 *
	 * @param {any} entry Custom entry.
	 * @returns {any} Cloned entry without managedMeta.
	 */
	_stripManagedMeta(entry) {
		const x = this._cloneJson(entry);
		if (!isObject(x)) {
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
	 * Pick existing managed meta keys from a Custom entry so we can preserve them on write.
	 *
	 * @param {any} entry Custom entry.
	 * @returns {any} Cloned managed meta payload (flat keys).
	 */
	_pickManagedMeta(entry) {
		if (!isObject(entry)) {
			return {};
		}

		const keep = {};
		for (const [k, v] of Object.entries(entry)) {
			if (String(k).startsWith('managedMeta-')) {
				keep[k] = this._cloneJson(v);
			}
		}
		return keep;
	}

	/**
	 * Re-attach preserved `managedMeta` keys to a new custom payload.
	 *
	 * @param {any} base Existing custom entry.
	 * @param {any} next Next custom entry to write (must already be managedMeta-free).
	 * @returns {any} Next custom entry with preserved managedMeta re-attached.
	 */
	_attachManagedMeta(base, next) {
		const out = isObject(next) ? this._cloneJson(next) : {};
		const keep = this._pickManagedMeta(base);
		for (const [k, v] of Object.entries(keep)) {
			out[k] = v;
		}
		return out;
	}

	/**
	 * Resolve the Bulk Apply schema from `admin/jsonCustom.json` (best-effort).
	 *
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Response wrapper.
	 */
	async _ingestStatesSchemaGet() {
		try {
			if (this._ingestStatesSchemaCache) {
				return this._ok(this._cloneJson(this._ingestStatesSchemaCache));
			}

			const allowedKeys = new Set(Object.keys(jsonCustomDefaults || {}));

			const file = path.join(__dirname, '..', 'admin', 'jsonCustom.json');
			const raw = fs.readFileSync(file, 'utf8');
			const parsed = JSON.parse(raw);
			const rootItems = isObject(parsed?.items) ? parsed.items : {};

			const fields = {};

			const addField = (key, node) => {
				if (typeof key !== 'string' || !key.trim()) {
					return;
				}
				if (key.startsWith('managedMeta-')) {
					return;
				}
				if (!allowedKeys.has(key)) {
					return;
				}
				if (!node || typeof node !== 'object') {
					return;
				}
				const type = typeof node.type === 'string' ? node.type : '';
				if (!type || type === 'header' || type === 'staticText' || type === 'panel') {
					return;
				}
				const out = {};
				out.type = type;
				if (node.default !== undefined) {
					out.default = node.default;
				}
				if (type === 'select' && Array.isArray(node.options)) {
					out.options = node.options.map(o => o?.value).filter(v => v !== undefined && v !== null);
				}
				if (typeof node.min === 'number' && Number.isFinite(node.min)) {
					out.min = node.min;
				}
				if (typeof node.max === 'number' && Number.isFinite(node.max)) {
					out.max = node.max;
				}
				fields[key] = out;
			};

			const walk = items => {
				if (!isObject(items)) {
					return;
				}
				for (const [key, node] of Object.entries(items)) {
					addField(key, node);
					if (isObject(node?.items)) {
						walk(node.items);
					}
				}
			};

			walk(rootItems);

			// Defaults for fields without explicit defaults in jsonCustom.json
			const defaultByType = type => {
				if (type === 'checkbox') {
					return false;
				}
				if (type === 'number') {
					return 0;
				}
				if (type === 'select') {
					return undefined;
				}
				// `text`, `objectId`, etc.
				return '';
			};

			const defaults = {
				enabled: true,
				mode: 'threshold',
			};

			for (const [key, info] of Object.entries(fields)) {
				if (info.default !== undefined) {
					defaults[key] = info.default;
					continue;
				}
				if (Array.isArray(info.options) && info.options.length) {
					defaults[key] = info.options[0];
					continue;
				}
				defaults[key] = defaultByType(info.type);
			}

			const schema = Object.freeze({
				version: 1,
				generatedAt: Date.now(),
				fields,
				defaults,
			});

			this._ingestStatesSchemaCache = schema;
			return this._ok(this._cloneJson(schema));
		} catch (e) {
			return this._err('INTERNAL', `Failed to load schema: ${String(e?.message || e)}`);
		}
	}

	/**
	 * Read an existing `common.custom.<msghub.X>` entry from a source object.
	 *
	 * @param {{ id?: string }} payload Command payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Response wrapper.
	 */
	async _ingestStatesReadCustom(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
		if (!id) {
			return this._err('BAD_REQUEST', 'Missing id');
		}

		const obj = await this._getForeignObject(id);
		if (!obj) {
			return this._err('NOT_FOUND', `Object not found: '${id}'`);
		}

		const customKey = this.adapter.namespace;
		const entry =
			obj?.common && isObject(obj.common) && obj.common.custom && isObject(obj.common.custom)
				? obj.common.custom[customKey]
				: null;

		const customNoMeta = entry && isObject(entry) ? this._stripManagedMeta(entry) : null;
		const custom = customNoMeta && isObject(customNoMeta) ? this._sanitizeIngestStatesCustom(customNoMeta) : null;
		return this._ok({ id, customKey, custom });
	}

	/**
	 * Preview a bulk-apply operation for `common.custom.<msghub.X>`.
	 *
	 * @param {{ pattern?: string, custom?: any, replace?: boolean, limit?: number }} payload Command payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Response wrapper.
	 */
	async _ingestStatesBulkApplyPreview(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const pattern = typeof payload?.pattern === 'string' ? payload.pattern.trim() : '';
		if (!pattern) {
			return this._err('BAD_REQUEST', 'Missing pattern');
		}

		if (!isObject(payload?.custom)) {
			return this._err('BAD_REQUEST', 'Missing custom config (object)');
		}

		const replace = payload?.replace === true;
		const limitRaw = Number(payload?.limit);
		const limit = Number.isFinite(limitRaw) ? Math.max(0, Math.min(500, Math.trunc(limitRaw))) : 50;

		const customPatch = this._sanitizeIngestStatesCustom(this._stripManagedMeta(payload.custom));
		const ownPrefix = `${this.adapter.namespace}.`;
		const customKey = this.adapter.namespace;

		const objects = await this._getForeignObjects(pattern);

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
				obj?.common && isObject(obj.common) && obj.common.custom && isObject(obj.common.custom)
					? obj.common.custom[customKey]
					: null;

			const existingNoMeta =
				existing && isObject(existing)
					? this._sanitizeIngestStatesCustom(this._stripManagedMeta(existing))
					: null;
			const nextNoMeta = replace
				? customPatch
				: this._mergeDeep(existingNoMeta && isObject(existingNoMeta) ? existingNoMeta : {}, customPatch);
			const next = this._attachManagedMeta(existing, nextNoMeta);
			const existingJson = JSON.stringify(existing && isObject(existing) ? existing : null);
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

		return this._ok({
			customKey,
			pattern,
			replace,
			totalObjects: total,
			matchedStates,
			willChange,
			unchanged,
			sample,
		});
	}

	/**
	 * Apply a bulk-apply operation for `common.custom.<msghub.X>`.
	 *
	 * @param {{ pattern?: string, custom?: any, replace?: boolean }} payload Command payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Response wrapper.
	 */
	async _ingestStatesBulkApplyApply(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const pattern = typeof payload?.pattern === 'string' ? payload.pattern.trim() : '';
		if (!pattern) {
			return this._err('BAD_REQUEST', 'Missing pattern');
		}

		if (!isObject(payload?.custom)) {
			return this._err('BAD_REQUEST', 'Missing custom config (object)');
		}

		const replace = payload?.replace === true;
		const customPatch = this._sanitizeIngestStatesCustom(this._stripManagedMeta(payload.custom));

		const ownPrefix = `${this.adapter.namespace}.`;
		const customKey = this.adapter.namespace;

		const objects = await this._getForeignObjects(pattern);

		let total = 0;
		let matchedStates = 0;
		let updated = 0;
		let unchanged = 0;
		const errors = [];

		for (const [id, obj] of Object.entries(objects || {})) {
			total += 1;
			if (typeof id !== 'string' || !id || id.startsWith(ownPrefix)) {
				continue;
			}
			if (obj?.type !== 'state') {
				continue;
			}
			matchedStates += 1;

			const common = isObject(obj?.common) ? obj.common : {};
			const custom = isObject(common.custom) ? common.custom : {};
			const existing = custom[customKey] && isObject(custom[customKey]) ? custom[customKey] : null;

			const existingNoMeta =
				existing && isObject(existing)
					? this._sanitizeIngestStatesCustom(this._stripManagedMeta(existing))
					: null;
			const nextNoMeta = replace
				? customPatch
				: this._mergeDeep(existingNoMeta && isObject(existingNoMeta) ? existingNoMeta : {}, customPatch);
			const next = this._attachManagedMeta(existing, nextNoMeta);
			const existingJson = JSON.stringify(existing && isObject(existing) ? existing : null);
			const nextJson = JSON.stringify(next);
			if (existingJson === nextJson) {
				unchanged += 1;
				continue;
			}

			try {
				const nextObj = this._cloneJson(obj);
				if (!isObject(nextObj.common)) {
					nextObj.common = {};
				}
				if (!isObject(nextObj.common.custom)) {
					nextObj.common.custom = {};
				}
				nextObj.common.custom[customKey] = next;
				await this._setForeignObject(id, nextObj);
				updated += 1;
			} catch (e) {
				errors.push({ id, message: String(e?.message || e) });
			}
		}

		return this._ok({
			customKey,
			pattern,
			replace,
			totalObjects: total,
			matchedStates,
			updated,
			unchanged,
			errors,
		});
	}

	/**
	 * Handle `admin.ai.test`.
	 *
	 * This is a diagnostics helper for the instance config (jsonConfig):
	 * it performs a minimal AI request and returns a `native.*` patch via `useNative`.
	 *
	 * @param {any} payload Test request payload.
	 * @returns {Promise<{ ok?: boolean, data?: any, error?: any, native?: any }>} Response wrapper.
	 */
	async _aiTest(payload) {
		const baseAi = this.ai;
		if (!baseAi || typeof baseAi.createCallerApi !== 'function') {
			return { native: { aiTestLastResult: 'ERROR NOT_READY: AI runtime not wired' } };
		}

		const safe = payload && typeof payload === 'object' ? payload : {};
		const purpose = typeof safe.purpose === 'string' && safe.purpose.trim() ? safe.purpose.trim() : 'ai-test';
		const quality = typeof safe.quality === 'string' && safe.quality.trim() ? safe.quality.trim() : 'balanced';
		const prompt =
			typeof safe.prompt === 'string' && safe.prompt.trim()
				? safe.prompt.trim()
				: 'Respond with a short sentence: pong';

		// Allow config-page tests without requiring an adapter restart:
		// when provider options are passed explicitly, build a temporary MsgAi instance.
		let ai = baseAi;
		const provider = typeof safe.provider === 'string' && safe.provider.trim() ? safe.provider.trim() : '';
		const openai = safe.openai && typeof safe.openai === 'object' ? safe.openai : null;
		const apiKey = typeof openai?.apiKey === 'string' ? openai.apiKey.trim() : '';
		const wantsOverrides = !!(
			provider ||
			apiKey ||
			openai?.baseUrl ||
			(openai?.modelsByQuality && typeof openai.modelsByQuality === 'object') ||
			Array.isArray(openai?.purposeModelOverrides)
		);

		if (wantsOverrides) {
			try {
				const { MsgAi } = require(`${__dirname}/../src/MsgAi`);
				ai = new MsgAi(this.adapter, {
					enabled: true,
					provider: provider || 'openai',
					openai: {
						apiKey,
						baseUrl: openai?.baseUrl,
						modelsByQuality: openai?.modelsByQuality,
						purposeModelOverrides: openai?.purposeModelOverrides,
					},
					timeoutMs: 15000,
					maxConcurrency: 1,
				});
			} catch (e) {
				return {
					native: {
						aiTestLastResult: `ERROR INTERNAL: Failed to build test AI runtime: ${String(e?.message || e)}`,
					},
				};
			}
		}

		const api = ai.createCallerApi({ regId: 'Admin:jsonConfig' });
		const res = await api.text({
			purpose,
			messages: [
				{ role: 'system', content: 'You are a connectivity test. Reply concisely.' },
				{ role: 'user', content: prompt },
			],
			hints: { quality },
			timeoutMs: 15000,
		});

		const out =
			res?.ok === true
				? String(res.value || '')
				: `ERROR ${String(res?.error?.code || 'ERROR')}: ${String(res?.error?.message || 'Error')}`;

		const meta = res?.meta && typeof res.meta === 'object' ? res.meta : {};
		const summary = [
			`ok=${res?.ok === true ? 'true' : 'false'}`,
			meta.provider ? `provider=${meta.provider}` : null,
			meta.model ? `model=${meta.model}` : null,
			meta.quality ? `quality=${meta.quality}` : null,
			typeof meta.durationMs === 'number' ? `durationMs=${meta.durationMs}` : null,
			meta.cached ? `cached=${meta.cached}` : null,
		]
			.filter(Boolean)
			.join(' ');

		return { native: { aiTestLastResult: `${summary}\n\n${out}`.trim() } };
	}

	/**
	 * Handle `admin.stats.get`.
	 *
	 * @param {any} payload Stats request payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Stats response wrapper.
	 */
	async _statsGet(payload) {
		const store = this.msgStore;
		if (!store || typeof store.getStats !== 'function') {
			return this._err('NOT_READY', 'Stats runtime not ready');
		}

		const safe = payload && typeof payload === 'object' ? payload : {};
		const includeRaw = isObject(safe.include) ? safe.include : {};
		const include = {};

		include.archiveSize = includeRaw.archiveSize === true;
		const maxAgeRaw = includeRaw.archiveSizeMaxAgeMs;
		if (typeof maxAgeRaw === 'number' && Number.isFinite(maxAgeRaw)) {
			include.archiveSizeMaxAgeMs = Math.max(0, Math.trunc(maxAgeRaw));
		}

		try {
			const stats = await store.getStats({ include });
			return this._ok(stats);
		} catch (e) {
			return this._err('INTERNAL', `Stats failed: ${String(e?.message || e)}`);
		}
	}

	/**
	 * Handle `admin.messages.query`.
	 *
	 * This is intentionally a thin proxy to `MsgStore.queryMessages(...)` so the Admin tab can render
	 * a message table without requiring any direct backend coupling.
	 *
	 * @param {any} payload Query payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Query response wrapper.
	 */
	async _messagesQuery(payload) {
		const store = this.msgStore;
		if (!store || typeof store.queryMessages !== 'function') {
			return this._err('NOT_READY', 'Store runtime not ready');
		}

		let tz = null;
		try {
			tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
		} catch {
			tz = null;
		}

		const safe = payload && typeof payload === 'object' ? payload : {};
		const queryRaw = isObject(safe.query) ? safe.query : {};

		const query = {};
		if (isObject(queryRaw.where)) {
			query.where = queryRaw.where;
		}
		if (isObject(queryRaw.page)) {
			query.page = queryRaw.page;
		}
		if (Array.isArray(queryRaw.sort)) {
			query.sort = queryRaw.sort;
		} else if (isObject(queryRaw.sort)) {
			query.sort = queryRaw.sort;
		}

		try {
			const res = store.queryMessages(query);
			const itemsRaw = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
			const items = itemsRaw.map(item => {
				if (!item || typeof item !== 'object') {
					return item;
				}
				try {
					return JSON.parse(serializeWithMaps(item));
				} catch {
					return item;
				}
			});
			const total = typeof res?.total === 'number' && Number.isFinite(res.total) ? Math.trunc(res.total) : null;
			const pages = typeof res?.pages === 'number' && Number.isFinite(res.pages) ? Math.trunc(res.pages) : null;
			return this._ok({
				meta: {
					generatedAt: Date.now(),
					tz,
				},
				items,
				...(total != null ? { total } : {}),
				...(pages != null ? { pages } : {}),
			});
		} catch (e) {
			return this._err('BAD_REQUEST', `Query failed: ${String(e?.message || e)}`);
		}
	}

	/**
	 * Handle `admin.messages.delete`.
	 *
	 * Performs a soft delete via `MsgStore.removeMessage(ref)` for each ref.
	 *
	 * @param {any} payload Delete payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Delete response wrapper.
	 */
	async _messagesDelete(payload) {
		const store = this.msgStore;
		if (!store || typeof store.removeMessage !== 'function') {
			return this._err('NOT_READY', 'Store runtime not ready');
		}

		const safe = payload && typeof payload === 'object' ? payload : {};
		const refsRaw = Array.isArray(safe.refs) ? safe.refs : [];
		const refs = refsRaw
			.filter(r => typeof r === 'string')
			.map(r => r.trim())
			.filter(Boolean);
		const uniqueRefs = Array.from(new Set(refs));

		if (uniqueRefs.length === 0) {
			return this._err('BAD_REQUEST', 'Missing refs');
		}
		if (uniqueRefs.length > 5000) {
			return this._err('BAD_REQUEST', `Too many refs (${uniqueRefs.length})`);
		}

		let deleted = 0;
		const missing = [];
		for (const ref of uniqueRefs) {
			try {
				const ok = store.removeMessage(ref, { actor: 'AdminTab' });
				if (ok) {
					deleted += 1;
				} else {
					missing.push(ref);
				}
			} catch {
				missing.push(ref);
			}
		}

		return this._ok({ requested: uniqueRefs.length, deleted, missing });
	}

	/**
	 * Handle `admin.constants.get`.
	 *
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Constants response wrapper.
	 */
	async _constantsGet() {
		const store = this.msgStore;
		const msgConstants = store?.msgConstants;
		if (!msgConstants || typeof msgConstants !== 'object') {
			return this._err('NOT_READY', 'Constants not ready');
		}

		const kind = msgConstants.kind && typeof msgConstants.kind === 'object' ? msgConstants.kind : {};
		const lifecycle =
			msgConstants.lifecycle && typeof msgConstants.lifecycle === 'object' ? msgConstants.lifecycle : {};
		const level = msgConstants.level && typeof msgConstants.level === 'object' ? msgConstants.level : {};
		const notfication =
			msgConstants.notfication && typeof msgConstants.notfication === 'object' ? msgConstants.notfication : {};

		return this._ok({
			kind,
			lifecycle: lifecycle?.state && typeof lifecycle.state === 'object' ? { state: lifecycle.state } : {},
			level,
			notfication:
				notfication?.events && typeof notfication.events === 'object' ? { events: notfication.events } : {},
		});
	}

	/**
	 * Handle `admin.ingestStates.constants.get`.
	 *
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Constants response wrapper.
	 */
	async _ingestStatesConstantsGet() {
		return this._ok(
			this._cloneJson({
				presetSchema,
				fallbackPresetId,
				presetTemplateV1,
				jsonCustomDefaults,
			}),
		);
	}

	/**
	 * Build a compact archive status snapshot for admin diagnostics.
	 *
	 * @returns {{ configuredStrategyLock: string, effectiveStrategy: string, effectiveStrategyReason: string, runtimeRoot: string, nativeProbeError: string } | null}
	 *   Archive status snapshot, or null when archive runtime is not available.
	 */
	_archiveStatusSnapshot() {
		const archive = this.msgStore?.msgArchive;
		if (!archive || typeof archive.getStatus !== 'function') {
			return null;
		}
		const status = archive.getStatus();
		return {
			configuredStrategyLock:
				typeof status?.configuredStrategyLock === 'string' ? status.configuredStrategyLock : '',
			effectiveStrategy: typeof status?.effectiveStrategy === 'string' ? status.effectiveStrategy : '',
			effectiveStrategyReason:
				typeof status?.effectiveStrategyReason === 'string' ? status.effectiveStrategyReason : '',
			runtimeRoot: typeof status?.runtimeRoot === 'string' ? status.runtimeRoot : '',
			nativeProbeError: typeof status?.nativeProbeError === 'string' ? status.nativeProbeError : '',
		};
	}

	/**
	 * Build `native` patch fields that mirror current runtime archive status.
	 *
	 * @returns {{ archiveRuntimeStrategy: string, archiveRuntimeReason: string, archiveRuntimeRoot: string }}
	 *   Native patch payload.
	 */
	_archiveRuntimeNativePatch() {
		const snap = this._archiveStatusSnapshot();
		return {
			archiveRuntimeStrategy: snap?.effectiveStrategy || '',
			archiveRuntimeReason: snap?.effectiveStrategyReason || '',
			archiveRuntimeRoot: snap?.runtimeRoot || '',
		};
	}

	/**
	 * Handle `admin.archive.status`.
	 *
	 * Returns a runtime status snapshot and mirrors it into `native.*` fields for jsonConfig visibility.
	 *
	 * @returns {{ ok: boolean, data?: any, error?: any, native?: any }} Response wrapper.
	 */
	_archiveStatus() {
		const snap = this._archiveStatusSnapshot();
		if (!snap) {
			return this._err('NOT_READY', 'Archive runtime not ready');
		}
		return {
			ok: true,
			data: { archive: snap },
			native: this._archiveRuntimeNativePatch(),
		};
	}

	/**
	 * Handle `admin.archive.retryNative`.
	 *
	 * Runs a native archive probe against the current runtime root. On success it returns a `native`
	 * patch that requests switching the strategy lock to native on next restart.
	 *
	 * @returns {Promise<{ ok?: boolean, data?: any, error?: any, native?: any }>} Response wrapper.
	 */
	async _archiveRetryNative() {
		const archive = this.msgStore?.msgArchive;
		if (!archive || typeof archive !== 'object') {
			return this._err('NOT_READY', 'Archive runtime not ready');
		}
		if (typeof archive.getStatus !== 'function') {
			return this._err('NOT_READY', 'Archive runtime status not available');
		}
		const status = archive.getStatus();
		const probeNative =
			typeof this._archiveProbeNative === 'function'
				? this._archiveProbeNative
				: options => IoArchiveResolver.probeNativeFor(options);
		let probe;
		try {
			probe = await probeNative({
				adapter: this.adapter,
				metaId: this.adapter.namespace,
				baseDir:
					typeof status?.baseDir === 'string' && status.baseDir.trim()
						? status.baseDir.trim()
						: 'data/archive',
				fileExtension:
					typeof status?.fileExtension === 'string' && status.fileExtension.trim()
						? status.fileExtension.trim()
						: 'jsonl',
				instanceDataDir:
					typeof status?.nativeRootDir === 'string' && status.nativeRootDir.trim()
						? status.nativeRootDir.trim()
						: '',
			});
		} catch (e) {
			probe = { ok: false, reason: `native-probe-failed:${String(e?.message || e)}` };
		}
		if (!probe || probe.ok !== true) {
			const reason =
				typeof probe?.reason === 'string' && probe.reason.trim() ? probe.reason.trim() : 'native-probe-failed';
			return this._err('NATIVE_PROBE_FAILED', reason);
		}

		const lockedAt = Date.now();
		return {
			ok: true,
			data: {
				archive: this._archiveStatusSnapshot(),
				nextLock: 'native',
				reason: 'manual-upgrade',
				lockedAt,
				restartRequired: true,
			},
			native: {
				archiveEffectiveStrategyLock: 'native',
				archiveLockReason: 'manual-upgrade',
				archiveLockedAt: lockedAt,
			},
		};
	}

	/**
	 * Handle `admin.archive.forceIobroker`.
	 *
	 * Returns a `native` patch that requests switching the strategy lock to ioBroker file API on next restart.
	 *
	 * @returns {{ ok: boolean, data: any, native: any }} Response wrapper.
	 */
	_archiveForceIobroker() {
		const lockedAt = Date.now();
		return {
			ok: true,
			data: {
				archive: this._archiveStatusSnapshot(),
				nextLock: 'iobroker',
				reason: 'manual-downgrade',
				lockedAt,
				restartRequired: true,
			},
			native: {
				archiveEffectiveStrategyLock: 'iobroker',
				archiveLockReason: 'manual-downgrade',
				archiveLockedAt: lockedAt,
			},
		};
	}

	/**
	 * Main entry point for `main.js` to handle adminTab sendTo commands.
	 *
	 * @param {string} cmd Command name (e.g. `admin.plugins.getCatalog`).
	 * @param {any} payload Command payload.
	 * @returns {Promise<{ ok?: boolean, data?: any, error?: any, native?: any }>} Response wrapper for the Admin tab.
	 */
	async handleCommand(cmd, payload) {
		const c = typeof cmd === 'string' ? cmd.trim() : '';
		if (!c) {
			return this._err('BAD_REQUEST', 'Missing command');
		}

		// New (preferred) namespace
		if (c === 'admin.plugins.getCatalog') {
			return await this._pluginsGetCatalog();
		}
		if (c === 'admin.plugins.listInstances') {
			return await this._pluginsListInstances();
		}
		if (c === 'admin.plugins.createInstance') {
			return await this._pluginsCreateInstance(payload);
		}
		if (c === 'admin.plugins.deleteInstance') {
			return await this._pluginsDeleteInstance(payload);
		}
		if (c === 'admin.plugins.updateInstance') {
			return await this._pluginsUpdateInstance(payload);
		}
		if (c === 'admin.plugins.setEnabled') {
			return await this._pluginsSetEnabled(payload);
		}
		if (c === 'admin.ai.test') {
			return await this._aiTest(payload);
		}
		if (c === 'admin.stats.get') {
			return await this._statsGet(payload);
		}
		if (c === 'admin.messages.query') {
			return await this._messagesQuery(payload);
		}
		if (c === 'admin.messages.delete') {
			return await this._messagesDelete(payload);
		}
		if (c === 'admin.constants.get') {
			return await this._constantsGet();
		}
		if (c === 'admin.archive.status') {
			return this._archiveStatus();
		}
		if (c === 'admin.archive.retryNative') {
			return await this._archiveRetryNative();
		}
		if (c === 'admin.archive.forceIobroker') {
			return this._archiveForceIobroker();
		}
		if (c === 'admin.ingestStates.custom.read') {
			return await this._ingestStatesReadCustom(payload);
		}
		if (c === 'admin.ingestStates.schema.get') {
			return await this._ingestStatesSchemaGet();
		}
		if (c === 'admin.ingestStates.constants.get') {
			return await this._ingestStatesConstantsGet();
		}
		if (c === 'admin.ingestStates.bulkApply.preview') {
			return await this._ingestStatesBulkApplyPreview(payload);
		}
		if (c === 'admin.ingestStates.bulkApply.apply') {
			return await this._ingestStatesBulkApplyApply(payload);
		}
		if (c === 'admin.ingestStates.presets.list') {
			return await this._ingestStatesPresetsList(payload);
		}
		if (c === 'admin.ingestStates.presets.get') {
			return await this._ingestStatesPresetsGet(payload);
		}
		if (c === 'admin.ingestStates.presets.upsert') {
			return await this._ingestStatesPresetsUpsert(payload);
		}
		if (c === 'admin.ingestStates.presets.delete') {
			return await this._ingestStatesPresetsDelete(payload);
		}

		return this._err('UNKNOWN_COMMAND', `Unknown admin command '${c}'`);
	}
}

module.exports = { IoAdminTab };
