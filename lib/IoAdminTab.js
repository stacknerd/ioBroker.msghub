/**
 * IoAdminTab
 * ==========
 * Adapter-side Admin Tab command facade for MsgHub.
 *
 * Docs: ../docs/io/IoAdminTab.md
 *
 * Responsibilities
 * - Handle adminTab sendTo commands (`admin.*`) and map them to runtime services.
 * - Normalize payloads and shape responses (DTOs) for the frontend.
 * - Perform non-blocking diagnostics useful for users (e.g. warn about unknown native keys).
 * - Serve only AdminTab runtime commands; config commands are owned by `IoAdminConfig`.
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
const {
	presetSchema,
	presetTemplateV1,
	fallbackPresetId,
	jsonCustomDefaults,
	presetBindingCatalog,
	ruleTemplateCatalog,
} = require('./IngestStates/constants');
const {
	extractPresetName,
	normalizePreset,
	parsePresetState,
	toPresetSummary,
	validatePreset,
} = require('./IngestStates/AdminPresets');

/**
 * Adapter-side Admin Tab command facade for MsgHub.
 *
 * Routes `sendTo` commands from the Admin tab (e.g. `admin.plugins.*`) to the
 * runtime services (currently `IoPlugins`) and returns frontend-friendly DTOs.
 */
class IoAdminTab {
	static INGEST_STATES_PRESET_SCHEMA = presetSchema;

	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string, i18nBackend: any }} adapter
	 *   ioBroker adapter instance (used for logging and namespace).
	 * @param {import('./IoPlugins').IoPlugins|null} ioPlugins
	 *   Plugin runtime manager to delegate admin actions to (can be null if plugin wiring failed).
	 * @param {object} [options] Optional runtime services.
	 * @param {any} [options.msgStore] Optional MsgStore instance for diagnostics.
	 */
	constructor(adapter, ioPlugins, { msgStore = null } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoAdminTab: adapter is required');
		}
		this.adapter = adapter;
		this.ioPlugins = ioPlugins && typeof ioPlugins === 'object' ? ioPlugins : null;
		this.msgStore = msgStore && typeof msgStore === 'object' ? msgStore : null;

		// Cache to prevent log spam: instanceKey -> "k1,k2,k3"
		this._unknownNativeKeysCache = new Map();

		// Cache for schema parsing (admin/jsonCustom.json -> Bulk Apply schema)
		this._ingestStatesSchemaCache = null;

		// In-memory cache for plugin admin UI bundles: key = `${type}:${instanceId}:${panelId}:${hash}`
		this._bundleCache = new Map();
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
	 * Translate an i18n key via `adapter.i18nBackend` (backend language translator).
	 *
	 * Used for strings surfaced in ioBroker-native output (e.g. jsonCustom dropdown labels).
	 * Throws when the backend translator is not ready — these strings must not silently degrade.
	 *
	 * @param {string} key i18n key.
	 * @param {...any} args Optional formatter args for i18n placeholders.
	 * @returns {string} Translated string.
	 */
	_t(key, ...args) {
		const adapter = this.adapter;
		if (!adapter || typeof adapter !== 'object') {
			throw new Error('IoAdminTab: i18n not ready');
		}

		const i18n = adapter.i18nBackend;
		if (!i18n || typeof i18n !== 'object' || typeof i18n.t !== 'function') {
			throw new Error('IoAdminTab: i18n not ready');
		}
		return i18n.t(key, ...args);
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
		const name = this._capitalizeFirstChar(extractPresetName({ presetId, obj, preset })) || presetId;

		const ownedBy = typeof preset?.ownedBy === 'string' ? preset.ownedBy.trim() : '';
		const ownerKey = ownedBy ? ownedBy.charAt(0).toLowerCase() + ownedBy.slice(1) : '';

		const ownerText = ownedBy
			? this._t(`msghub.i18n.IngestStates.admin.jsonCustom.rules.${ownerKey}.header.text`)
			: this._t(`msghub.i18n.IngestStates.admin.jsonCustom.preset.global.label`);

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
	 * Handle `admin.pluginUi.discover`.
	 *
	 * Returns all admin UI panel contributions from currently registered (running) plugin instances.
	 * Plugins that are configured but not started are excluded.
	 *
	 * @returns {{ ok: boolean, data?: any, error?: any }} Discover response wrapper.
	 */
	_pluginUiDiscover() {
		if (!this.ioPlugins || typeof this.ioPlugins.getAdminUiContributions !== 'function') {
			return this._pluginsNotReady();
		}
		return this._ok(this.ioPlugins.getAdminUiContributions());
	}

	/**
	 * Handle `admin.pluginUi.bundle.get`.
	 *
	 * Fetches the ESM bundle (and optional CSS) for a plugin admin UI panel.
	 * Bundles are cached in-memory keyed by (pluginType, instanceId, panelId, hash).
	 * Bundle JS is limited to 512 KB; companion CSS to 64 KB.
	 *
	 * @param {any} payload Request payload: `{ pluginType, instanceId?, panelId }`.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Bundle response wrapper.
	 */
	async _pluginUiBundleGet(payload) {
		if (
			!this.ioPlugins ||
			typeof this.ioPlugins.getAdminUiContributions !== 'function' ||
			typeof this.ioPlugins.readAdminUiBundle !== 'function'
		) {
			return this._pluginsNotReady();
		}

		const pluginType = typeof payload?.pluginType === 'string' ? payload.pluginType.trim() : '';
		const panelId = typeof payload?.panelId === 'string' ? payload.panelId.trim() : '';
		const instanceId =
			typeof payload?.instanceId === 'number' && Number.isFinite(payload.instanceId)
				? Math.trunc(payload.instanceId)
				: 0;

		if (!pluginType || !panelId) {
			return this._err('BAD_REQUEST', 'pluginType and panelId are required');
		}

		// Validate: plugin is running and panel exists.
		const contributions = this.ioPlugins.getAdminUiContributions();
		const contrib = contributions.find(
			c => c.pluginType === pluginType && c.instanceId === instanceId && c.panelId === panelId,
		);
		if (!contrib) {
			return this._err(
				'NOT_FOUND',
				`Plugin UI panel '${pluginType}:${instanceId}/${panelId}' not found or plugin not started`,
			);
		}

		const cacheKey = `${pluginType}:${instanceId}:${panelId}:${contrib.bundle.hash}`;
		if (this._bundleCache.has(cacheKey)) {
			return this._ok(this._bundleCache.get(cacheKey));
		}

		let bundle;
		try {
			bundle = await this.ioPlugins.readAdminUiBundle({ type: pluginType, instanceId, panelId });
		} catch (e) {
			if (e?.code === 'NOT_FOUND') {
				return this._err('NOT_FOUND', `Bundle file not found for '${pluginType}:${instanceId}/${panelId}'`);
			}
			if (e?.code === 'FORBIDDEN') {
				return this._err(
					'FORBIDDEN',
					`Bundle entry path is not allowed for '${pluginType}:${instanceId}/${panelId}'`,
				);
			}
			this.adapter?.log?.error?.(
				`AdminTab: bundle read failed for '${pluginType}:${instanceId}/${panelId}': ${e?.message || e}`,
			);
			return this._err('INTERNAL', 'Bundle read failed');
		}

		const JS_LIMIT = 512 * 1024;
		const CSS_LIMIT = 64 * 1024;
		if (Buffer.byteLength(bundle.js, 'utf8') > JS_LIMIT) {
			return this._err('INTERNAL', `Bundle JS exceeds ${JS_LIMIT} byte limit`);
		}
		if (bundle.css != null && Buffer.byteLength(bundle.css, 'utf8') > CSS_LIMIT) {
			return this._err('INTERNAL', `Bundle CSS exceeds ${CSS_LIMIT} byte limit`);
		}

		const data = {
			apiVersion: contrib.apiVersion,
			moduleFormat: 'esm',
			hash: contrib.bundle.hash,
			js: bundle.js,
			...(bundle.css != null ? { css: bundle.css } : {}),
		};
		this._bundleCache.set(cacheKey, data);
		return this._ok(data);
	}

	/**
	 * Handle `admin.pluginUi.rpc`.
	 *
	 * Dispatches an RPC call to the plugin's `handleAdminUiRpc` method.
	 * Identity is host-bound: the bundle cannot override pluginType, instanceId, or panelId.
	 * Payload is limited to 64 KB serialized. Timeout: 10 000 ms.
	 *
	 * @param {any} payload RPC payload: `{ pluginType, instanceId?, panelId, command, payload? }`.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} RPC response wrapper.
	 */
	async _pluginUiRpc(payload) {
		if (!this.ioPlugins || typeof this.ioPlugins.getAdminUiContributions !== 'function') {
			return this._pluginsNotReady();
		}

		const pluginType = typeof payload?.pluginType === 'string' ? payload.pluginType.trim() : '';
		const panelId = typeof payload?.panelId === 'string' ? payload.panelId.trim() : '';
		const command = typeof payload?.command === 'string' ? payload.command.trim() : '';
		const instanceId =
			typeof payload?.instanceId === 'number' && Number.isFinite(payload.instanceId)
				? Math.trunc(payload.instanceId)
				: 0;

		if (!pluginType || !panelId || !command) {
			return this._err('BAD_REQUEST', 'pluginType, panelId, and command are required');
		}

		// Validate RPC payload size (64 KB serialized).
		const rpcPayload = payload?.payload ?? null;
		try {
			const serialized = JSON.stringify(rpcPayload);
			if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
				return this._err('BAD_REQUEST', 'RPC payload exceeds 64 KB limit');
			}
		} catch {
			return this._err('BAD_REQUEST', 'RPC payload is not serializable');
		}

		// Validate: plugin is running and panel is declared.
		const contributions = this.ioPlugins.getAdminUiContributions();
		const contrib = contributions.find(
			c => c.pluginType === pluginType && c.instanceId === instanceId && c.panelId === panelId,
		);
		if (!contrib) {
			return this._err(
				'NOT_FOUND',
				`Plugin '${pluginType}:${instanceId}' not started or panel '${panelId}' not found`,
			);
		}

		// Call plugin runtime — identity (pluginType, instanceId, panelId) is host-bound.
		const rpcResult = this.ioPlugins.callPluginRuntime({
			type: pluginType,
			instanceId,
			method: 'handleAdminUiRpc',
			args: [{ panelId, command, payload: rpcPayload }],
		});

		if (rpcResult == null) {
			return this._err('NOT_READY', `Plugin '${pluginType}:${instanceId}' runtime is not available`);
		}

		let result;
		try {
			const timeoutPromise = new Promise((_, reject) =>
				setTimeout(() => reject(Object.assign(new Error('RPC timeout'), { code: 'TIMEOUT' })), 10000),
			);
			result = await Promise.race([rpcResult, timeoutPromise]);
		} catch (e) {
			if (e?.code === 'TIMEOUT') {
				return this._err('TIMEOUT', 'RPC call timed out');
			}
			this.adapter?.log?.error?.(
				`AdminTab: RPC error for '${pluginType}:${instanceId}/${panelId}/${command}': ${e?.message || e}`,
			);
			return this._err('INTERNAL', 'RPC call failed');
		}

		// Plugin is responsible for returning { ok, data } or { ok: false, error: { code, message } }.
		if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
			return result;
		}

		return this._err('INTERNAL', 'Plugin RPC returned unexpected response format');
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
	 * Builds a normalized preset-id base from a user-facing description.
	 *
	 * The generated id is lowercase, whitespace-safe, and limited to the
	 * persisted preset id alphabet (`a-z`, `0-9`, `_`, `-`).
	 *
	 * @param {any} description Candidate preset description.
	 * @returns {string} Normalized preset id base.
	 */
	_normalizePresetIdBase(description) {
		let text = typeof description === 'string' ? description.trim().toLowerCase() : '';
		if (!text) {
			return 'preset';
		}

		text = text.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
		if (typeof text.normalize === 'function') {
			text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
		}

		text = text
			.replace(/[^a-z0-9_-]+/g, '-')
			.replace(/-{2,}/g, '-')
			.replace(/^[-_]+|[-_]+$/g, '');

		return text || 'preset';
	}

	/**
	 * Returns all valid stored preset ids.
	 *
	 * @returns {Promise<Set<string>>} Stored preset ids.
	 */
	async _ingestStatesPresetIds() {
		await this._ingestStatesEnsurePresetsRoot();

		const ns = String(this.adapter?.namespace || '').trim();
		const prefix = `${ns}.IngestStates.0.presets.`;
		const objects = await this._getForeignObjects(`${prefix}*`);
		const ids = new Set();

		for (const id of Object.keys(objects || {})) {
			if (typeof id !== 'string' || !id.startsWith(prefix)) {
				continue;
			}
			const presetId = id.slice(prefix.length);
			if (this._isValidPresetId(presetId)) {
				ids.add(presetId);
			}
		}

		return ids;
	}

	/**
	 * Generates a unique preset id from a description.
	 *
	 * @param {any} description User-facing preset description.
	 * @returns {Promise<string>} Unique preset id.
	 */
	async _generatePresetId(description) {
		const base = this._normalizePresetIdBase(description);
		const existingIds = await this._ingestStatesPresetIds();
		if (!existingIds.has(base)) {
			return base;
		}

		let n = 2;
		while (existingIds.has(`${base}-${n}`)) {
			n += 1;
		}
		return `${base}-${n}`;
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
		return validatePreset(preset, { expectedPresetId });
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
	 *   OR when `preset.ownedBy` is empty (global presets).
	 *
	 * @param {any} payload List payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Options array wrapper.
	 */
	async _ingestStatesPresetsList(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const includeUsage = payload?.includeUsage === true;

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
					const { preset: parsed, error: err } = parsePresetState(raw, { presetId: c.presetId });
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
					if (filterRule && this._hasUnavailableMetrics(parsed, filterRuleRaw, filterSubsetRaw)) {
						return null;
					}
					const label = this._presetLabel({ presetId: c.presetId, obj: c.obj, preset: parsed });
					const ownedByRaw = typeof parsed?.ownedBy === 'string' ? parsed.ownedBy.trim() : '';
					const hasOwner = !!ownedByRaw;
					const source = typeof parsed?.source === 'string' ? parsed.source.trim() : '';
					const subsetRaw = typeof parsed?.subset === 'string' ? parsed.subset.trim() : null;
					const summary = toPresetSummary({ presetId: c.presetId, obj: c.obj, preset: parsed });
					return {
						...summary,
						label,
						hasOwner,
						source,
						ownedBy: ownedByRaw || null,
						subset: subsetRaw || null,
					};
				} catch {
					return null;
				}
			}),
		);

		const out = reads.filter(Boolean);
		let usageByPresetId = null;
		if (includeUsage) {
			const snapshot =
				this.ioPlugins && typeof this.ioPlugins.callPluginRuntime === 'function'
					? this.ioPlugins.callPluginRuntime({
							type: 'IngestStates',
							instanceId: 0,
							method: 'getPresetUsageSnapshot',
						})
					: [];
			usageByPresetId = new Map();
			for (const item of Array.isArray(snapshot) ? snapshot : []) {
				const presetId = typeof item?.presetId === 'string' ? item.presetId.trim() : '';
				const usageCount =
					typeof item?.usageCount === 'number' && Number.isFinite(item.usageCount)
						? Math.max(0, Math.trunc(item.usageCount))
						: 0;
				if (!presetId) {
					continue;
				}
				usageByPresetId.set(presetId, usageCount);
			}
		}

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
			list.push({
				value: item.value,
				label: item.label,
				source: item.source,
				ownedBy: item.ownedBy,
				subset: item.subset,
				kind: item.kind,
				level: item.level,
				name: item.name,
				...(includeUsage ? { usageCount: usageByPresetId?.get(item.value) || 0 } : {}),
			});
		}
		return this._ok(list);
	}

	/**
	 * Normalize raw options into jsonCustom-compatible select options.
	 *
	 * jsonCustom `selectSendTo` treats empty arrays as "offline"; keep non-empty options as-is.
	 *
	 * @param {Array<{value?: unknown, label?: unknown}>|unknown} items Candidate options.
	 * @returns {Array<{value: string, label: string}>} Sanitized option list.
	 */
	_ensureOptionsArray(items) {
		const list = Array.isArray(items) ? items : [];
		const next = [];
		for (const it of list) {
			const value = typeof it?.value === 'string' ? it.value : '';
			const label = typeof it?.label === 'string' ? it.label : '';
			if (!value) {
				continue;
			}
			next.push({ value, label });
		}
		return next;
	}

	/**
	 * Extract all `{{m.<key>}}` metric variable keys referenced in a template string.
	 *
	 * Handles all variable forms:
	 *   {{m.state-name}}          → 'state-name'
	 *   {{m.cycle-period|num:0}}  → 'cycle-period'  (filter stripped)
	 *   {{m.trendMax.val}}        → 'trendMax'       (property accessor stripped)
	 *
	 * @param {string} text Template string.
	 * @returns {Set<string>} Set of referenced metric keys.
	 */
	static _extractMetricKeys(text) {
		const keys = new Set();
		const s = typeof text === 'string' ? text : '';
		for (const match of s.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
			const expr = match[1].trim();
			if (!expr.startsWith('m.')) {
				continue;
			}
			const withoutFilter = expr.split('|')[0].trim();
			const parts = withoutFilter.split('.');
			if (parts.length >= 2) {
				keys.add(parts[1]);
			}
		}
		return keys;
	}

	/**
	 * Check whether a preset references metric variables not available for the given rule/subset.
	 *
	 * Uses `ruleTemplateCatalog` as the source of truth.
	 * Returns `false` (lenient) when the rule is unknown or the preset has no `m.*` references.
	 *
	 * @param {object|null} preset Parsed preset object.
	 * @param {string} rule Rule name (case-insensitive, e.g. 'Threshold', 'nonSettling').
	 * @param {string} subset Active subset (e.g. 'lt', 'trend', or '' for any).
	 * @returns {boolean} True when at least one referenced metric key is unavailable.
	 */
	_hasUnavailableMetrics(preset, rule, subset) {
		const ruleStr = typeof rule === 'string' ? rule.trim() : '';
		if (!ruleStr) {
			return false;
		}

		const catalogKey = Object.keys(ruleTemplateCatalog).find(k => k.toLowerCase() === ruleStr.toLowerCase());
		if (!catalogKey) {
			return false;
		}

		const subsetStr = typeof subset === 'string' ? subset.trim() : '';
		const msg = preset?.message;
		const usedKeys = new Set([
			...IoAdminTab._extractMetricKeys(typeof msg?.title === 'string' ? msg.title : ''),
			...IoAdminTab._extractMetricKeys(typeof msg?.text === 'string' ? msg.text : ''),
			...IoAdminTab._extractMetricKeys(typeof msg?.textRecovered === 'string' ? msg.textRecovered : ''),
		]);

		if (usedKeys.size === 0) {
			return false;
		}

		const { metrics } = ruleTemplateCatalog[catalogKey];
		// When subset is empty we cannot determine the active subset, so treat all catalog
		// metrics as available (lenient). Only apply subset filtering when subset is known.
		const available = new Set(
			subsetStr
				? Object.keys(metrics).filter(key => {
						const e = metrics[key];
						return e.subset === null || e.subset.includes(subsetStr);
					})
				: Object.keys(metrics),
		);

		for (const key of usedKeys) {
			if (!available.has(key)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Check whether a preset mismatches active select filters.
	 *
	 * @param {object|null} preset Parsed preset payload.
	 * @param {string} rule Rule filter (`ownedBy`) from command/payload.
	 * @param {string} subset Subset filter from command/payload.
	 * @returns {boolean} True when preset is incompatible with active filters.
	 */
	_isPresetIncompatibleWithFilter(preset, rule, subset) {
		const filterRule = typeof rule === 'string' ? rule.trim().toLowerCase() : '';
		const filterSubset = typeof subset === 'string' ? subset.trim().toLowerCase() : '';

		const ownedBy = typeof preset?.ownedBy === 'string' ? preset.ownedBy.trim().toLowerCase() : '';
		const presetSubset = typeof preset?.subset === 'string' ? preset.subset.trim().toLowerCase() : '';

		const ruleMismatch = !!filterRule && !!ownedBy && ownedBy !== filterRule;
		const subsetMismatch = !!filterSubset && !!presetSubset && presetSubset !== filterSubset;
		const metricMismatch = !!filterRule && this._hasUnavailableMetrics(preset, rule, subset);
		return ruleMismatch || subsetMismatch || metricMismatch;
	}

	/**
	 * Add current preset selection to options when it was filtered out.
	 *
	 * This keeps jsonCustom select fields readable after subset/rule changes:
	 * the previously saved value remains visible as a labeled incompatible option.
	 *
	 * @param {Array<{value: string, label: string}>} options Select options with leading empty item.
	 * @param {string} currentValue Current saved preset id from jsonCustom field.
	 * @param {string} rule Active rule filter.
	 * @param {string} subset Active subset filter.
	 * @returns {Promise<Array<{value: string, label: string}>>} Options with optional injected current value.
	 */
	async _injectCurrentPresetOption(options, currentValue, rule, subset) {
		const value = typeof currentValue === 'string' ? currentValue.trim() : '';
		if (!value || !this._isValidPresetId(value)) {
			return options;
		}
		if (!Array.isArray(options) || options.some(opt => (opt?.value || '') === value)) {
			return options;
		}

		const got = await this._ingestStatesPresetsGet({ presetId: value });
		if (!got?.ok || !got?.data?.preset) {
			return options;
		}

		const preset = got.data.preset;
		const obj = got?.data?.object || null;
		let label = this._presetLabel({ presetId: value, obj, preset });
		if (this._isPresetIncompatibleWithFilter(preset, rule, subset)) {
			label = this._t('msghub.i18n.IngestStates.admin.jsonCustom.preset.incompatible.label', label);
		}

		const next = Array.isArray(options) ? [...options] : [];
		next.splice(0, 0, { value, label });
		return next;
	}

	/**
	 * Handle `admin.ingestStates.presets.selectOptions*` as read-only options endpoint for jsonCustom.
	 *
	 * @param {string} cmd Full command id.
	 * @param {any} payload Optional payload.
	 * @returns {Promise<Array<{value: string, label: string}>>} Select options array.
	 */
	async _ingestStatesPresetSelectOptions(cmd, payload) {
		const baseCmd = 'admin.ingestStates.presets.selectOptions';
		const rawCmd = typeof cmd === 'string' ? cmd.trim() : '';
		if (!rawCmd.startsWith(baseCmd)) {
			return this._ensureOptionsArray([]);
		}

		let suffix = rawCmd.slice(baseCmd.length);
		if (suffix.startsWith('.')) {
			suffix = suffix.slice(1);
		}
		const parts = suffix ? suffix.split('.').filter(Boolean) : [];

		const rule = parts[0] || null;
		const subset = parts[1] || null;

		const nextPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
		// Command suffix values win only when caller did not provide explicit payload fields.
		if (!Object.prototype.hasOwnProperty.call(nextPayload, 'rule')) {
			nextPayload.rule = rule;
		}
		if (!Object.prototype.hasOwnProperty.call(nextPayload, 'subset')) {
			nextPayload.subset = subset;
		}
		const currentValue = typeof nextPayload?.currentValue === 'string' ? nextPayload.currentValue.trim() : '';

		const listRes = await this._ingestStatesPresetsList(nextPayload);
		const items = listRes?.ok && Array.isArray(listRes?.data) ? listRes.data : [];
		const options = this._ensureOptionsArray(items);
		return await this._injectCurrentPresetOption(
			options,
			currentValue,
			typeof nextPayload.rule === 'string' ? nextPayload.rule : '',
			typeof nextPayload.subset === 'string' ? nextPayload.subset : '',
		);
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
		const { preset: parsed, error: err } = parsePresetState(raw, { presetId });
		if (err) {
			return this._err('INVALID_PRESET', `Preset '${presetId}' is invalid: ${err}`);
		}

		return this._ok({ presetId, preset: parsed, object: this._cloneJson(obj), state: this._cloneJson(state) });
	}

	/**
	 * Handle `admin.ingestStates.presets.create`.
	 *
	 * @param {any} payload Create payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Create wrapper.
	 */
	async _ingestStatesPresetsCreate(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const preset = payload?.preset;
		if (!isObject(preset)) {
			return this._err('BAD_REQUEST', 'Missing preset object');
		}
		if (Object.prototype.hasOwnProperty.call(preset, 'presetId')) {
			return this._err('BAD_REQUEST', 'presetId must not be provided when creating a preset');
		}

		const source = typeof preset?.source === 'string' ? preset.source.trim() : '';
		if (source !== 'user') {
			return this._err('FORBIDDEN', `Preset cannot be created with source '${source || 'missing'}' via admin`);
		}

		const nextPreset = normalizePreset(this._cloneJson(preset), { source: 'user' });
		nextPreset.presetId = await this._generatePresetId(nextPreset.description);

		const err = this._validateIngestStatesPreset(nextPreset, nextPreset.presetId);
		if (err) {
			return this._err('BAD_REQUEST', `Invalid preset: ${err}`);
		}

		const presetId = nextPreset.presetId;
		const fullId = this._ingestStatesPresetFullId(presetId);
		if (await this._getForeignObject(fullId)) {
			return this._err('CONFLICT', `Preset '${presetId}' already exists`);
		}

		await this._ingestStatesEnsurePresetsRoot();

		const desc = typeof nextPreset.description === 'string' ? nextPreset.description.trim() : '';
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

		await this._setForeignStateAck(fullId, JSON.stringify(nextPreset));
		return this._ok({ presetId });
	}

	/**
	 * Handle `admin.ingestStates.presets.update`.
	 *
	 * @param {any} payload Update payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Update wrapper.
	 */
	async _ingestStatesPresetsUpdate(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const preset = payload?.preset;
		if (!isObject(preset)) {
			return this._err('BAD_REQUEST', 'Missing preset object');
		}
		const presetId = typeof payload?.presetId === 'string' ? payload.presetId.trim() : '';
		if (!this._isValidPresetId(presetId)) {
			return this._err('BAD_REQUEST', 'Invalid presetId');
		}

		const fullId = this._ingestStatesPresetFullId(presetId);
		const existing = await this._getForeignObject(fullId);
		if (!existing) {
			return this._err('NOT_FOUND', `Preset '${presetId}' not found`);
		}

		let existingPreset = null;
		try {
			const st = await this._getForeignState(fullId);
			const raw = typeof st?.val === 'string' ? st.val.trim() : '';
			existingPreset = raw ? JSON.parse(raw) : null;
		} catch {
			existingPreset = null;
		}
		const existingSource = typeof existingPreset?.source === 'string' ? existingPreset.source.trim() : '';
		if (existingSource && existingSource !== 'user') {
			return this._err('FORBIDDEN', `Preset source is '${existingSource}'`);
		}

		const source = typeof preset?.source === 'string' ? preset.source.trim() : '';
		if (source !== 'user') {
			return this._err('FORBIDDEN', `Preset cannot be updated with source '${source || 'missing'}' via admin`);
		}

		const nextPreset = normalizePreset(this._cloneJson(preset), { presetId, source: 'user' });

		const err = this._validateIngestStatesPreset(nextPreset, presetId);
		if (err) {
			return this._err('BAD_REQUEST', `Invalid preset: ${err}`);
		}

		await this._ingestStatesEnsurePresetsRoot();

		const desc = typeof nextPreset.description === 'string' ? nextPreset.description.trim() : '';
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

		await this._setForeignStateAck(fullId, JSON.stringify(nextPreset));
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

		const st = await this._getForeignState(fullId);
		const { preset: existingPreset } = parsePresetState(typeof st?.val === 'string' ? st.val : '', { presetId });
		const existingSource = typeof existingPreset?.source === 'string' ? existingPreset.source.trim() : '';
		if (existingSource && existingSource !== 'user') {
			return this._err('FORBIDDEN', `Preset source is '${existingSource}'`);
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
	 * Handle `admin.messages.action`.
	 *
	 * Executes one action by id on the given message ref via `MsgAction.execute()`.
	 * Only the action id is provided by the caller; the action type is resolved from
	 * the stored message's `actions[]` whitelist (as per MsgAction contract).
	 *
	 * @param {any} payload Action payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Action response wrapper.
	 */
	async _messagesExecuteAction(payload) {
		const ref = typeof payload?.ref === 'string' ? payload.ref.trim() : '';
		const actionId = typeof payload?.actionId === 'string' ? payload.actionId.trim() : '';
		if (!ref || !actionId) {
			return this._err('BAD_REQUEST', 'ref and actionId are required');
		}
		const msgActions = this.msgStore?.msgActions;
		if (!msgActions || typeof msgActions.execute !== 'function') {
			return this._err('NOT_READY', 'Action executor not available');
		}
		const ok = msgActions.execute({ ref, actionId, actor: 'AdminTab' });
		return ok ? this._ok({ executed: true }) : this._err('REJECTED', 'Action rejected or not found');
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
				presetBindingCatalog,
				ruleTemplateCatalog,
			}),
		);
	}

	/**
	 * Main entry point for `main.js` to handle adminTab sendTo commands.
	 *
	 * @param {string} cmd Command name (e.g. `admin.plugins.getCatalog`).
	 * @param {any} payload Command payload.
	 * @returns {Promise<{ ok?: boolean, data?: any, error?: any, native?: any } | Array<{value: string, label: string}>>}
	 *   Response wrapper for the Admin tab, or select options array for `admin.ingestStates.presets.selectOptions*`.
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
		if (c === 'admin.pluginUi.discover') {
			return this._pluginUiDiscover();
		}
		if (c === 'admin.pluginUi.bundle.get') {
			return await this._pluginUiBundleGet(payload);
		}
		if (c === 'admin.pluginUi.rpc') {
			return await this._pluginUiRpc(payload);
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
		if (c === 'admin.messages.action') {
			return await this._messagesExecuteAction(payload);
		}
		if (c === 'admin.constants.get') {
			return await this._constantsGet();
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
		if (c.startsWith('admin.ingestStates.presets.selectOptions')) {
			return await this._ingestStatesPresetSelectOptions(c, payload);
		}
		if (c === 'admin.ingestStates.presets.get') {
			return await this._ingestStatesPresetsGet(payload);
		}
		if (c === 'admin.ingestStates.presets.create') {
			return await this._ingestStatesPresetsCreate(payload);
		}
		if (c === 'admin.ingestStates.presets.update') {
			return await this._ingestStatesPresetsUpdate(payload);
		}
		if (c === 'admin.ingestStates.presets.delete') {
			return await this._ingestStatesPresetsDelete(payload);
		}

		if (c === 'admin.ping') {
			return { ok: true, data: 'pong' };
		}

		return this._err('UNKNOWN_COMMAND', `Unknown admin command '${c}'`);
	}
}

module.exports = { IoAdminTab };
