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
 * const bridge = MsgBridge.registerBridge(
 *   'bridge:alexa',
 *   {
 *     start(ctx) { ... },
 *     onStateChange(id, state, ctx) { ... },
 *     onNotifications(event, notifications, ctx) { ... },
 *   },
 *   { msgIngest: this.msgStore.msgIngest, msgNotify: this.msgStore.msgNotify, log: this.log },
 * );
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
	 * Contract (vNext)
	 * - A bridge is registered as two plugins (ingest + notify) derived from one handler object.
	 * - Registration order is always `ingest-first` (to prioritize keeping the store up-to-date).
	 * - IDs are deterministic and derived from `id`:
	 *   - ingest: `${id}.ingest`
	 *   - notify: `${id}.notify`
	 * - `handler.start/stop` are wired on the ingest side only (to avoid double-start via MsgNotify).
	 *
	 * @param {string} id Bridge base id (stable identifier; e.g. `BridgeFoo:0`).
	 * @param {object} handler Bridge handler (single object).
	 * @param {Function} [handler.start] Optional start hook (recommended for polling/webhooks/resync).
	 * @param {Function} [handler.stop] Optional stop hook.
	 * @param {Function} [handler.onStateChange] Optional ingest handler for ioBroker stateChange events.
	 * @param {Function} [handler.onObjectChange] Optional ingest handler for ioBroker objectChange events.
	 * @param {Function} handler.onNotifications Required notify handler for MsgHub notification events.
	 * @param {object} [hosts] Hosts and optional logger.
	 * @param {{ registerPlugin: Function, unregisterPlugin: Function }} [hosts.msgIngest] MsgIngest-like host.
	 * @param {{ registerPlugin: Function, unregisterPlugin: Function }} [hosts.msgNotify] MsgNotify-like host.
	 * @param {{ warn?: (msg: string) => void }} [hosts.log] Optional logger (typically `adapter.log`) for rollback warnings.
	 * @returns {{ ingestId: string, notifyId: string, unregister: () => void }} Registration handle.
	 */
	static registerBridge(id, handler, hosts) {
		const safeHosts = hosts && typeof hosts === 'object' && !Array.isArray(hosts) ? hosts : {};
		const msgIngest = safeHosts.msgIngest;
		const msgNotify = safeHosts.msgNotify;
		const log = safeHosts.log;
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
		const baseId = typeof id === 'string' && id.trim() ? id.trim() : '';
		if (!baseId) {
			throw new Error('MsgBridge: id is required');
		}
		if (!handler || typeof handler !== 'object') {
			throw new Error('MsgBridge: handler object is required');
		}

		if (typeof handler?.onNotifications !== 'function') {
			throw new Error('MsgBridge: handler.onNotifications(event, notifications, ctx) is required');
		}

		const hasInbound =
			typeof handler?.start === 'function' ||
			typeof handler?.onStateChange === 'function' ||
			typeof handler?.onObjectChange === 'function';
		if (!hasInbound) {
			throw new Error(
				'MsgBridge: handler must implement at least one of start/onStateChange/onObjectChange (bidirectional contract)',
			);
		}

		const logger = log || null;

		const ingestId = `${baseId}.ingest`;
		const notifyId = `${baseId}.notify`;

		// Split the single handler into two wrappers (ingest + notify).
		// Important: we only expose start/stop on the ingest side to avoid double-start/double-stop via MsgNotify.
		const start = typeof handler?.start === 'function' ? handler.start.bind(handler) : null;
		const stop = typeof handler?.stop === 'function' ? handler.stop.bind(handler) : null;
		const onStateChange = typeof handler?.onStateChange === 'function' ? handler.onStateChange.bind(handler) : null;
		const onObjectChange =
			typeof handler?.onObjectChange === 'function' ? handler.onObjectChange.bind(handler) : null;

		const ingestWrapper = Object.freeze({
			...(start ? { start: ctx => start(ctx) } : {}),
			...(stop ? { stop: ctx => stop(ctx) } : {}),
			...(onStateChange ? { onStateChange: (id, state, ctx) => onStateChange(id, state, ctx) } : {}),
			...(onObjectChange ? { onObjectChange: (id, obj, ctx) => onObjectChange(id, obj, ctx) } : {}),
		});
		const notifyWrapper = Object.freeze({
			onNotifications: (event, notifications, ctx) => handler.onNotifications(event, notifications, ctx),
		});

		let registeredIngest = false;
		let registeredNotify = false;

		const unregister = () => {
			// Best-effort and idempotent. Never throw.
			if (registeredNotify) {
				try {
					msgNotify.unregisterPlugin(notifyId);
				} catch (e) {
					logger?.warn?.(`MsgBridge: notify unregister failed (id='${notifyId}'): ${e?.message || e}`);
				} finally {
					registeredNotify = false;
				}
			}

			if (registeredIngest) {
				try {
					msgIngest.unregisterPlugin(ingestId);
				} catch (e) {
					logger?.warn?.(`MsgBridge: ingest unregister failed (id='${ingestId}'): ${e?.message || e}`);
				} finally {
					registeredIngest = false;
				}
			}
		};

		try {
			// Always ingest-first: prioritize keeping the store up-to-date, even if notifications are missed at startup.
			msgIngest.registerPlugin(ingestId, ingestWrapper);
			registeredIngest = true;

			msgNotify.registerPlugin(notifyId, notifyWrapper);
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

		return Object.freeze({ ingestId, notifyId, unregister });
	}
}

module.exports = { MsgBridge };
