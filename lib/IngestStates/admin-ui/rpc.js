/**
 * rpc.js
 * ======
 *
 * Pure RPC dispatch for IngestStates admin UI panels.
 *
 * Integration:
 *   Called from index.js handleAdminUiRpc, which receives the host-bound
 *   { panelId, command, payload } from admin.pluginUi.rpc.
 *   All side-effectful I/O is injected via deps — no direct adapter or
 *   file system access lives here.
 *
 * Deps interface:
 *   presets — { list, get, create, update, delete }
 *
 * Dispatch table:
 *   panelId='presets': presets.list, presets.get, presets.create,
 *                      presets.update, presets.delete
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
 * @param {{ presets: object }} deps
 *   Injected service objects. Each method returns a Promise that resolves to
 *   `{ ok, data }` or `{ ok, error: { code, message } }`.
 * @returns {{ handleRpc: Function }} Dispatch handler.
 */
function createRpcHandler({ presets }) {
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

module.exports = { createRpcHandler };
