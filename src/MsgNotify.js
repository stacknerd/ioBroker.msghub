/**
 * MsgNotify
 * ========
 * Notification dispatcher for MsgHub.
 *
 * Core responsibilities
 * - Validate notification events against `MsgConstants.notfication.events`.
 * - Fan out notifications to registered plugins in a consistent call shape.
 * - Provide a small plugin registry with register/unregister semantics.
 *
 * Design guidelines / invariants
 * - Event names: `dispatch()` expects the *event value* as defined in `MsgConstants.notfication.events`
 *   (e.g. `"due"`, `"updated"`, `"deleted"`, `"expired"`). It does not accept the object keys.
 * - No state mutation: this class does not mutate messages (e.g. it does not advance `timing.notifyAt`).
 *   Producers (like `MsgStore`) and/or plugins are responsible for updating messages or acknowledging delivery.
 * - One-message dispatch: internally, messages are dispatched one-by-one. Each plugin receives an array containing
 *   a single notification to keep the plugin interface consistent with potential batch dispatchers.
 * - Fault isolation: plugin failures are caught and logged so one bad plugin cannot break other plugins.
 */
class MsgNotify {
	/**
	 * Create a new dispatcher instance.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance (used for logging only).
	 * @param {import('./MsgConstants').MsgConstants} msgConstants Centralized enum-like constants (source of truth for events).
	 */
	constructor(adapter, msgConstants) {
		if (!adapter) {
			throw new Error('MsgNotify: adapter is required');
		}
		this.adapter = adapter;

		if (!msgConstants) {
			throw new Error('MsgNotify: msgConstants is required');
		}
		this.msgConstants = msgConstants;

		this._plugins = new Map();
		this.adapter?.log?.info?.('MsgNotify initialized');

		// Precompute allowed event values once to avoid repeated Object.values allocations on every dispatch.
		this.notificationEventsSet = new Set(Object.values(this.msgConstants.notfication.events));
	}

	/**
	 * Registers a notification plugin.
	 *
	 * Handler shapes:
	 * - Function: `(event, notificationsArray, ctx) => void`
	 * - Object: `{ onNotifications(event, notificationsArray, ctx) { ... } }`
	 *
	 * Notes:
	 * - Registering the same `id` again overwrites the previous plugin.
	 * - Object handlers are bound to preserve `this`.
	 *
	 * @param {string} id Plugin identifier.
	 * @param {Function|{onNotifications: Function}} handler Plugin handler.
	 */
	registerPlugin(id, handler) {
		if (!id || typeof id !== 'string') {
			throw new Error('MsgNotify.registerPlugin: id is required');
		}
		if (typeof handler !== 'function' && typeof handler?.onNotifications !== 'function') {
			throw new Error('MsgNotify.registerPlugin: handler must be a function or { onNotifications }');
		}

		const fn = typeof handler === 'function' ? handler : handler.onNotifications.bind(handler);
		this._plugins.set(id, { handler, fn });
	}

	/**
	 * Removes a registered plugin.
	 *
	 * This is a no-op if the id is unknown.
	 *
	 * @param {string} id Plugin identifier.
	 */
	unregisterPlugin(id) {
		this._plugins.delete(id);
	}

	/**
	 * Dispatches a single message or an array of messages for a given event.
	 *
	 * Input normalization:
	 * - `messages` can be an object or an array; internally it's treated as an array.
	 * - Invalid entries (null/non-objects) are ignored.
	 *
	 * Validation:
	 * - Throws when `event` is not one of `MsgConstants.notfication.events` values.
	 *
	 * @param {string} event Event value (e.g. "due", "updated", "deleted", "expired").
	 * @param {Array<object>|object} messages Message(s) to dispatch.
	 * @param {object} [ctx] Dispatch context.
	 * @returns {number} Number of dispatched messages.
	 */
	dispatch(event, messages, ctx = {}) {
		const eventName = typeof event === 'string' && event.trim() ? event.trim() : '';
		if (!this.notificationEventsSet.has(eventName)) {
			throw new Error(`MsgNotify.dispatch: unsupported event '${eventName || String(event)}'`);
		}
		const notifications = Array.isArray(messages) ? messages : [messages];
		let dispatched = 0;
		for (const message of notifications) {
			if (!message || typeof message !== 'object') {
				continue;
			}
			dispatched += 1;
			// Dispatch each message separately to isolate plugin failures and keep processing simple.
			this._dispatch(eventName, message, ctx);
		}
		return dispatched;
	}

	/**
	 * Dispatches a single notification to all registered plugins.
	 *
	 * @param {string} event Event name.
	 * @param {object} notification Notification message object.
	 * @param {object} [ctx] Dispatch context.
	 */
	_dispatch(event, notification, ctx = {}) {
		if (!this._plugins.size) {
			this.adapter?.log?.debug?.(
				`MsgNotify: no plugins registered to notify about '${notification.ref}' (event='${event}')`,
			);
			return;
		}

		for (const [id, plugin] of this._plugins.entries()) {
			try {
				// Plugins always receive an array to keep a stable interface for potential future batching.
				plugin.fn(event, [notification], ctx);
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgNotify: plugin '${id}' failed (event='${event}'): ${e?.message || e}`);
			}
		}
	}
}

module.exports = { MsgNotify };
