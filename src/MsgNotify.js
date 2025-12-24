/**
 * Notification dispatcher for MsgHub.
 * Accepts events from external schedulers or store operations and dispatches them to plugins.
 * Does not mutate messages; producers/plugins must update timing.notifyAt.
 */
class MsgNotify {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance for logging.
	 * @param {import('./MsgConstants').MsgConstants} msgConstants Centralized enum-like constants.
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
		if (this.adapter?.log?.info) {
			this.adapter.log.info(`MsgNotify initialized: (no additional context available))`);
		}

		// create ValueSets only once
		this.notificationEventsSet = new Set(Object.values(this.msgConstants.notfication.events));
	}

	/**
	 * Registers a notification plugin.
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
	 * @param {string} id Plugin identifier.
	 */
	unregisterPlugin(id) {
		this._plugins.delete(id);
	}

	/**
	 * Dispatches a single message or an array of messages for a given event.
	 *
	 * @param {string} event Event name (e.g. "due", "update", "delete", "expired").
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
			this._dispatch(eventName, message, ctx);
		}
		return dispatched;
	}

	/**
	 * Dispatches a single notification to all registered plugins.
	 *
	 * @param {string} event Event name.
	 * @param {object} notification Due notification.
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
				plugin.fn(event, [notification], ctx);
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgNotify: plugin '${id}' failed (event='${event}'): ${e?.message || e}`);
			}
		}
	}
}

module.exports = { MsgNotify };
