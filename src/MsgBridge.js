/**
 * MsgBridge
 * ========
 * Small "bridge wiring" helper for bidirectional integrations.
 *
 * Docs: ../docs/modules/MsgBridge.md
 *
 * `MsgBridge` is a tiny helper that registers a *bidirectional integration* as **two independent plugins**:
 *
 * - one producer plugin on `MsgIngest` (input side)
 * - one notifier plugin on `MsgNotify` (output side)
 *
 * The point of this helper is not to invent a new host layer, but to make one specific thing easier and safer:
 * register/unregister both sides together, with best-effort rollback when the second registration fails.
 *
 * Where it sits in the system
 * ---------------------------
 * - The adapter owns the `MsgStore` instance.
 * - The store owns `msgIngest` and `msgNotify`.
 * - A "bridge" integration needs *both*:
 *   - Ingest: read external changes (e.g., Alexa list state) → patch MsgHub messages
 *   - Notify: observe MsgHub events (`updated`, `deleted`, ...) → push changes outward
 *
 * Core responsibilities
 * ---------------------
 * 1) Provide a small API surface for "bridge" wiring
 * 2) Register both sides with clear IDs
 * 3) Do best-effort rollback (avoid half-registered bridges)
 * 4) Provide best-effort `unregister()` and keep idempotent behavior (via the returned handle)
 *
 * What this intentionally does NOT do
 * ----------------------------------
 * - No dispatching: events still flow through `MsgIngest` and `MsgNotify`.
 * - No lifecycle host: it does not define `start/stop` semantics for both directions.
 * - No health checks: it does not detect runtime failures of the handlers.
 * - No "true atomicity": it can roll back registrations, but it cannot undo side effects that may already have
 *   happened while registering (see notes below).
 *
 * Important semantics / caveats for developers
 * --------------------------------------------
 * - "Registration success" means: `registerPlugin(...)` did not throw.
 *   The underlying hosts currently return `void` (no boolean status).
 * - `MsgIngest.registerPlugin(...)` may start the plugin immediately when the ingest host is already running.
 *   In that case, your ingest plugin might subscribe/poll *before* notify registration completes.
 * - Rollback is best-effort:
 *   - We call `unregisterPlugin` on the hosts.
 *   - The hosts may best-effort stop the plugin (ingest does; notify does not have a stop concept).
 *   - Side effects already executed by the plugin cannot be undone by this helper.
 *
 * Practical usage pattern (adapter wiring)
 * ---------------------------------------
 * `MsgBridge` is meant as a small wiring convenience for `main.js`.
 *
 * ```js
 * const { MsgBridge } = require('./src/MsgBridge');
 * const bridge = MsgBridge.registerBridge({
 *   id: 'bridge:alexa',
 *   msgIngest: this.msgStore.msgIngest,
 *   msgNotify: this.msgStore.msgNotify,
 *   ingest: IngestAlexa(...),
 *   notify: NotifyAlexa(...),
 * });
 * ```
 *
 * If you need stronger guarantees (health, resync, telemetry), put them into the bridge implementation itself
 * (shared context/state), not into this wiring helper.
 */

/**
 * Optional class-style namespace wrapper for callers who prefer `MsgBridge.registerBridge(...)`.
 *
 * This class is intentionally static-only and must not grow instance state. If you need stateful behavior
 * (health, resync state, rate limits, caches), implement it inside the actual bridge plugin (shared context),
 * not in this wiring helper.
 */
class MsgBridge {
	/**
	 * Public entry point to register a bridge.
	 *
	 * This is intentionally a `static` method:
	 * - there is no instance state and no additional lifecycle semantics beyond the returned handle
	 *
	 * @param {Parameters<typeof MsgBridge._registerBridge>[0]} options Registration options.
	 * @returns {ReturnType<typeof MsgBridge._registerBridge>} Registration handle.
	 */
	static registerBridge(options) {
		return MsgBridge._registerBridge(options);
	}

	/**
	 * Internal implementation for bridge registration.
	 *
	 * This method is intentionally "private by convention" and should not be called directly by external code.
	 * Use `MsgBridge.registerBridge(...)` instead.
	 *
	 * Notes:
	 * - Even though some options are required at runtime (`msgIngest`, `msgNotify`, `ingest`, `notify`), the options
	 *   object itself is optional to allow clear error messages for missing dependencies.
	 *
	 * @param {object} [options] Registration options.
	 * @param {string} [options.id] Default plugin id used for both sides unless overridden.
	 * @param {string} [options.ingestId] Plugin id used for MsgIngest (defaults to `options.id`).
	 * @param {string} [options.notifyId] Plugin id used for MsgNotify (defaults to `options.id`).
	 * @param {{ registerPlugin: (id: string, handler: Function|object) => void, unregisterPlugin: (id: string) => void }} [options.msgIngest]
	 * MsgIngest-like host instance (must provide `registerPlugin` and `unregisterPlugin`).
	 * @param {{ registerPlugin: (id: string, handler: Function|object) => void, unregisterPlugin: (id: string) => void }} [options.msgNotify]
	 * MsgNotify-like host instance (must provide `registerPlugin` and `unregisterPlugin`).
	 * @param {Function|object} [options.ingest] Producer plugin handler (required at runtime).
	 * @param {Function|{onNotifications: Function}} [options.notify] Notifier plugin handler (required at runtime).
	 * @param {{ warn?: (msg: string) => void }} [options.log]
	 * Optional logger (typically `adapter.log`) used for best-effort rollback/unregister warnings.
	 * @returns {{ ingestId: string, notifyId: string, unregister: () => void }} Registration handle.
	 */
	static _registerBridge({ id, ingestId, notifyId, msgIngest, msgNotify, ingest, notify, log } = {}) {
		if (
			!msgIngest ||
			typeof msgIngest.registerPlugin !== 'function' ||
			typeof msgIngest.unregisterPlugin !== 'function'
		) {
			throw new Error('MsgBridge: msgIngest with registerPlugin/unregisterPlugin is required');
		}
		if (
			!msgNotify ||
			typeof msgNotify.registerPlugin !== 'function' ||
			typeof msgNotify.unregisterPlugin !== 'function'
		) {
			throw new Error('MsgBridge: msgNotify with registerPlugin/unregisterPlugin is required');
		}
		if (!ingest) {
			throw new Error('MsgBridge: ingest handler is required');
		}
		if (!notify) {
			throw new Error('MsgBridge: notify handler is required');
		}

		const logger = log || null;

		// Normalize ids once. Empty ids are rejected below.
		const baseId = typeof id === 'string' && id.trim() ? id.trim() : '';
		const normIngestId = typeof ingestId === 'string' && ingestId.trim() ? ingestId.trim() : baseId;
		const normNotifyId = typeof notifyId === 'string' && notifyId.trim() ? notifyId.trim() : baseId;

		if (!normIngestId || !normNotifyId) {
			throw new Error('MsgBridge: id (or ingestId/notifyId) is required');
		}

		let registeredIngest = false;
		let registeredNotify = false;

		const unregister = () => {
			// Best-effort and idempotent. Never throw.
			if (registeredNotify) {
				try {
					msgNotify.unregisterPlugin(normNotifyId);
				} catch (e) {
					logger?.warn?.(`MsgBridge: notify unregister failed (id='${normNotifyId}'): ${e?.message || e}`);
				} finally {
					registeredNotify = false;
				}
			}

			if (registeredIngest) {
				try {
					msgIngest.unregisterPlugin(normIngestId);
				} catch (e) {
					logger?.warn?.(`MsgBridge: ingest unregister failed (id='${normIngestId}'): ${e?.message || e}`);
				} finally {
					registeredIngest = false;
				}
			}
		};

		try {
			// Register ingest first so inbound changes are observed as early as possible.
			// (Callers who need the opposite should pass different IDs and/or control start ordering externally.)
			msgIngest.registerPlugin(normIngestId, ingest);
			registeredIngest = true;

			msgNotify.registerPlugin(normNotifyId, notify);
			registeredNotify = true;
		} catch (e) {
			// Best-effort rollback (do not throw on rollback).
			try {
				unregister();
			} catch {
				// swallow
			}
			throw e;
		}

		return Object.freeze({ ingestId: normIngestId, notifyId: normNotifyId, unregister });
	}
}

module.exports = { MsgBridge };
