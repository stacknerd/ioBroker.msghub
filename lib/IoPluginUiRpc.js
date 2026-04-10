/**
 * IoPluginUiRpc
 * =============
 * Shared plugin UI RPC validation and dispatch for admin/web hosts.
 *
 * Docs: ../docs/io/IoPluginUiRpc.md
 *
 * Responsibilities
 * - Validate host-bound plugin UI RPC payloads.
 * - Resolve the target plugin panel contribution from the running runtime.
 * - Dispatch to the host-specific plugin hook (`handleAdminUiRpc` / `handleWebUiRpc`).
 *
 * Non-responsibilities
 * - Discover or bundle delivery.
 * - Host routing in `main.js`.
 * - WebExtension mount, asset serving, or token/capability gates.
 */

'use strict';

/**
 * Shared plugin UI RPC validation and dispatch for admin/web hosts.
 */
class IoPluginUiRpc {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} adapter
	 *   ioBroker adapter instance (used for logging and namespace).
	 * @param {import('./IoPlugins').IoPlugins|null} ioPlugins
	 *   Plugin runtime manager used for contribution lookup and runtime dispatch.
	 * @param {{ pluginPanelResolver?: import('./IoPluginPanelResolver').IoPluginPanelResolver|null }} [options]
	 *   Optional canonical resolver for running plugin-owned panels.
	 */
	constructor(adapter, ioPlugins, { pluginPanelResolver = null } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoPluginUiRpc: adapter is required');
		}
		this.adapter = adapter;
		this.ioPlugins = ioPlugins && typeof ioPlugins === 'object' ? ioPlugins : null;
		this.pluginPanelResolver =
			pluginPanelResolver && typeof pluginPanelResolver === 'object' ? pluginPanelResolver : null;
	}

	/**
	 * Wrap an error response for plugin UI RPC callers.
	 *
	 * @param {string} code Error code.
	 * @param {string} message Error message.
	 * @returns {{ ok: false, error: { code: string, message: string } }} Error response wrapper.
	 */
	_err(code, message) {
		return { ok: false, error: { code: String(code || 'ERROR'), message: String(message || 'Error') } };
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
	 * Dispatch a plugin UI RPC call for the admin host.
	 *
	 * @param {any} payload RPC payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} RPC response wrapper.
	 */
	async handleAdminRpc(payload) {
		return await this._handleRpc('admin', payload);
	}

	/**
	 * Dispatch a plugin UI RPC call for the web host.
	 *
	 * @param {any} payload RPC payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} RPC response wrapper.
	 */
	async handleWebRpc(payload) {
		return await this._handleRpc('web', payload);
	}

	/**
	 * Validate and dispatch a host-bound plugin UI RPC call.
	 *
	 * @param {'admin'|'web'} host Host class for the RPC surface.
	 * @param {any} payload RPC payload: `{ pluginType, instanceId?, panelId, command, payload? }`.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} RPC response wrapper.
	 */
	async _handleRpc(host, payload) {
		if (!this.ioPlugins || typeof this.ioPlugins.callPluginRuntime !== 'function') {
			return this._pluginsNotReady();
		}
		if (!this.pluginPanelResolver || typeof this.pluginPanelResolver.getPanelByRef !== 'function') {
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

		const rpcPayload = payload?.payload ?? null;
		try {
			const serialized = JSON.stringify(rpcPayload);
			if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
				return this._err('BAD_REQUEST', 'RPC payload exceeds 64 KB limit');
			}
		} catch {
			return this._err('BAD_REQUEST', 'RPC payload is not serializable');
		}

		let panel;
		try {
			panel = await this.pluginPanelResolver.getPanelByRef({ pluginType, instanceId, panelId });
		} catch (e) {
			if (e?.code === 'NOT_READY') {
				return this._pluginsNotReady();
			}
			return this._err(typeof e?.code === 'string' ? e.code : 'INTERNAL', String(e?.message || e));
		}

		if (!panel) {
			return this._err(
				'NOT_FOUND',
				`Plugin '${pluginType}:${instanceId}' not started or panel '${panelId}' not found`,
			);
		}

		const method = host === 'web' ? 'handleWebUiRpc' : 'handleAdminUiRpc';
		const rpcResult = this.ioPlugins.callPluginRuntime({
			type: pluginType,
			instanceId,
			method,
			args: [{ panelId, command, payload: rpcPayload }],
		});

		if (rpcResult == null) {
			return this._err(
				'NOT_READY',
				`Plugin '${pluginType}:${instanceId}' runtime or hook '${method}' is not available`,
			);
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
				`PluginUiRpc(${host}): RPC error for '${pluginType}:${instanceId}/${panelId}/${command}': ${e?.message || e}`,
			);
			return this._err('INTERNAL', 'RPC call failed');
		}

		if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
			return result;
		}

		return this._err('INTERNAL', 'Plugin RPC returned unexpected response format');
	}
}

module.exports = { IoPluginUiRpc };
