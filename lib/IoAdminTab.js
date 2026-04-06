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

const { isObject } = require(`${__dirname}/../src/MsgUtils`);
const { IoPluginUiRpc } = require('./IoPluginUiRpc');

/**
 * Adapter-side Admin Tab command facade for MsgHub.
 *
 * Routes `sendTo` commands from the Admin tab (e.g. `admin.plugins.*`) to the
 * runtime services (currently `IoPlugins`) and returns frontend-friendly DTOs.
 */
class IoAdminTab {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} adapter
	 *   ioBroker adapter instance (used for logging and namespace).
	 * @param {import('./IoPlugins').IoPlugins|null} ioPlugins
	 *   Plugin runtime manager to delegate admin actions to (can be null if plugin wiring failed).
	 * @param {object} [options] Optional runtime services.
	 * @param {any} [options.msgStore] Optional MsgStore instance for diagnostics.
	 * @param {IoPluginUiRpc|null} [options.pluginUiRpc] Optional shared plugin UI RPC dispatcher.
	 * @param {import('./IoAdminCapabilities').IoAdminCapabilities|null} [options.adminCapabilities]
	 *   Optional shared capability authority for canonical payload-token validation.
	 */
	constructor(adapter, ioPlugins, { msgStore = null, pluginUiRpc = null, adminCapabilities = null } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoAdminTab: adapter is required');
		}
		this.adapter = adapter;
		this.ioPlugins = ioPlugins && typeof ioPlugins === 'object' ? ioPlugins : null;
		this.msgStore = msgStore && typeof msgStore === 'object' ? msgStore : null;
		this.adminCapabilities = adminCapabilities && typeof adminCapabilities === 'object' ? adminCapabilities : null;
		this.pluginUiRpc =
			pluginUiRpc && typeof pluginUiRpc === 'object' ? pluginUiRpc : new IoPluginUiRpc(adapter, this.ioPlugins);

		// Cache to prevent log spam: instanceKey -> "k1,k2,k3"
		this._unknownNativeKeysCache = new Map();
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
	 * Return the token-clean business payload for one admin command.
	 *
	 * `admin.ingestStates.presets.selectOptions*` is the only backend exception:
	 * it may run without a token for external jsonCustom callers.
	 *
	 * @param {string} cmd Full command id.
	 * @param {any} payload Raw command payload.
	 * @returns {{ ok: true, payload: any } | { ok: false, error: { code: string, message: string } }}
	 *   Either the cleaned payload or a structured backend error.
	 */
	_getAuthorizedPayload(cmd, payload) {
		const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
		if (cmd.startsWith('admin.ingestStates.presets.selectOptions')) {
			if (this.adminCapabilities && typeof safePayload.token === 'string' && safePayload.token.trim()) {
				try {
					return {
						ok: true,
						payload: this.adminCapabilities.consumePayloadToken({
							host: 'admin',
							capability: 'admin',
							payload: safePayload,
						}),
					};
				} catch (e) {
					return this._err('FORBIDDEN', String(e?.message || e));
				}
			}
			const { token: _ignoredToken, ...restPayload } = safePayload;
			return { ok: true, payload: restPayload };
		}
		if (!this.adminCapabilities || typeof this.adminCapabilities.consumePayloadToken !== 'function') {
			return this._err('NOT_READY', 'Admin capability authority not ready');
		}
		try {
			return {
				ok: true,
				payload: this.adminCapabilities.consumePayloadToken({
					host: 'admin',
					capability: 'admin',
					payload: safePayload,
				}),
			};
		} catch (e) {
			return this._err('FORBIDDEN', String(e?.message || e));
		}
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
	 * Handle `admin.pluginUi.rpc`.
	 *
	 * @param {any} payload RPC payload: `{ pluginType, instanceId?, panelId, command, payload? }`.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} RPC response wrapper.
	 */
	async _pluginUiRpc(payload) {
		return await this.pluginUiRpc.handleAdminRpc(payload);
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
	 * Generic IngestStates command pass-through for `admin.ingestStates.presets.selectOptions*`.
	 *
	 * Passes the command suffix and raw payload to IngestStates without interpretation.
	 * IngestStates owns all IngestStates-specific command and payload interpretation.
	 *
	 * @param {string} cmd Full command id.
	 * @param {any} payload Optional payload.
	 * @returns {Promise<Array<{value: string, label: string}>>} Select options array.
	 */
	async _ingestStatesPassThrough(cmd, payload) {
		const baseCmd = 'admin.ingestStates.presets.selectOptions';
		const rawCmd = typeof cmd === 'string' ? cmd.trim() : '';
		if (!rawCmd.startsWith(baseCmd)) {
			return this._ensureOptionsArray([]);
		}

		// Pass suffix and raw payload verbatim — IngestStates interprets both.
		const suffix = rawCmd.slice(baseCmd.length);
		const raw =
			this.ioPlugins?.callPluginRuntime?.({
				type: 'IngestStates',
				instanceId: 0,
				method: 'getPresetSelectOptions',
				args: [{ suffix, payload }],
			}) ?? null;

		if (raw === null) {
			return this._ensureOptionsArray([]);
		}

		return this._ensureOptionsArray(await Promise.resolve(raw));
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
		const authorized = this._getAuthorizedPayload(c, payload);
		if (authorized.ok !== true) {
			return authorized;
		}
		const cleanPayload = authorized.payload;

		// New (preferred) namespace
		if (c === 'admin.plugins.getCatalog') {
			return await this._pluginsGetCatalog();
		}
		if (c === 'admin.plugins.listInstances') {
			return await this._pluginsListInstances();
		}
		if (c === 'admin.plugins.createInstance') {
			return await this._pluginsCreateInstance(cleanPayload);
		}
		if (c === 'admin.plugins.deleteInstance') {
			return await this._pluginsDeleteInstance(cleanPayload);
		}
		if (c === 'admin.plugins.updateInstance') {
			return await this._pluginsUpdateInstance(cleanPayload);
		}
		if (c === 'admin.plugins.setEnabled') {
			return await this._pluginsSetEnabled(cleanPayload);
		}
		if (c === 'admin.pluginUi.rpc') {
			return await this._pluginUiRpc(cleanPayload);
		}
		if (c === 'admin.messages.delete') {
			return await this._messagesDelete(cleanPayload);
		}
		if (c.startsWith('admin.ingestStates.presets.selectOptions')) {
			return await this._ingestStatesPassThrough(c, cleanPayload);
		}

		return this._err('UNKNOWN_COMMAND', `Unknown admin command '${c}'`);
	}
}

module.exports = { IoAdminTab };
