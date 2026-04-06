/**
 * rpc.js
 * ======
 *
 * Pure RPC dispatch for IngestStates UI panels.
 *
 * Integration:
 *   Called from index.js host-bound UI hooks.
 *   Admin RPC currently owns all implemented commands.
 *   Web RPC exists only as an explicit skeleton and does not expose any command yet.
 *   All side-effectful I/O is injected via deps — no direct adapter or
 *   file system access lives here.
 *
 * Deps interface:
 *   presets   — { bootstrap, list, get, create, update, delete }
 *   bulkApply — { bootstrap, configRead, preview, apply } (optional)
 *
 * Dispatch table:
 *   panelId='presets':   presets.bootstrap, presets.list, presets.get, presets.create,
 *                        presets.update, presets.delete
 *   panelId='bulkapply': bulkapply.bootstrap, bulkapply.configRead, bulkapply.preview,
 *                        bulkapply.apply
 *
 * Response contract (mirroring RFC-0010):
 *   { ok: true, data: any }
 *   { ok: false, error: { code: string, message: string } }
 *
 * Error codes used here: BAD_REQUEST, UNSUPPORTED_COMMAND, INTERNAL
 * (further codes are returned by deps as-is).
 */

'use strict';

/**
 * Create the RPC dispatch handler for IngestStates admin UI panels.
 *
 * @param {{ presets: object, bulkApply?: object }} deps
 *   Injected service objects. Each method returns a Promise that resolves to
 *   `{ ok, data }` or `{ ok, error: { code, message } }`.
 *   bulkApply is optional — absent service returns UNSUPPORTED_COMMAND.
 * @returns {{ handleRpc: Function }} Dispatch handler.
 */
function createAdminRpcHandler({ presets, bulkApply }) {
	/**
	 * Dispatch a single RPC request to the appropriate service method.
	 *
	 * @param {{ panelId?: string, command?: string, payload?: any }} request Incoming request.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: { code: string, message: string } }>} Response.
	 */
	async function handleRpc({ panelId, command, payload = null } = {}) {
		const p = typeof panelId === 'string' ? panelId.trim() : '';
		const c = typeof command === 'string' ? command.trim() : '';

		if (!p || !c) {
			return { ok: false, error: { code: 'BAD_REQUEST', message: 'panelId and command are required' } };
		}

		try {
			if (p === 'presets') {
				if (c === 'presets.bootstrap') {
					return await presets.bootstrap(payload);
				}
				if (c === 'presets.list') {
					return await presets.list(payload);
				}
				if (c === 'presets.get') {
					return await presets.get(payload);
				}
				if (c === 'presets.create') {
					return await presets.create(payload);
				}
				if (c === 'presets.update') {
					return await presets.update(payload);
				}
				if (c === 'presets.delete') {
					return await presets.delete(payload);
				}
			}

			if (p === 'bulkapply') {
				if (!bulkApply) {
					return {
						ok: false,
						error: { code: 'UNSUPPORTED_COMMAND', message: 'bulkapply service not available' },
					};
				}
				if (c === 'bulkapply.bootstrap') {
					return await bulkApply.bootstrap(payload);
				}
				if (c === 'bulkapply.configRead') {
					return await bulkApply.configRead(payload);
				}
				if (c === 'bulkapply.preview') {
					return await bulkApply.preview(payload);
				}
				if (c === 'bulkapply.apply') {
					return await bulkApply.apply(payload);
				}
			}

			return { ok: false, error: { code: 'UNSUPPORTED_COMMAND', message: `Unsupported command '${p}/${c}'` } };
		} catch (e) {
			return {
				ok: false,
				error: { code: 'INTERNAL', message: String(e?.message || e || 'Unknown error') },
			};
		}
	}

	return { handleRpc };
}

/**
 * Create the RPC dispatch handler skeleton for IngestStates web UI panels.
 *
 * No IngestStates commands are web-safe yet. The explicit factory exists so the
 * public plugin contract can already expose a separate web hook without silently
 * reusing the admin command surface.
 *
 * @param {{ presets: object, bulkApply?: object }} _deps
 *   Reserved dependency shape for future web-safe commands.
 * @returns {{ handleRpc: Function }} Dispatch handler.
 */
function createWebRpcHandler({ presets: _presets, bulkApply: _bulkApply }) {
	/**
	 * Reject every current web RPC request until a later AP cuts a web-safe command set.
	 *
	 * @param {{ panelId?: string, command?: string, payload?: any }} request Incoming request.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: { code: string, message: string } }>} Response.
	 */
	async function handleRpc({ panelId, command } = {}) {
		const p = typeof panelId === 'string' ? panelId.trim() : '';
		const c = typeof command === 'string' ? command.trim() : '';

		if (!p || !c) {
			return { ok: false, error: { code: 'BAD_REQUEST', message: 'panelId and command are required' } };
		}

		return {
			ok: false,
			error: { code: 'UNSUPPORTED_COMMAND', message: `No web-safe IngestStates RPC command for '${p}/${c}'` },
		};
	}

	return { handleRpc };
}

module.exports = { createAdminRpcHandler, createWebRpcHandler };
