/**
 * Notification dispatcher for MsgHub.
 * Accepts due messages from external schedulers and dispatches them to plugins.
 * Does not mutate messages; producers/plugins must update timing.notifyAt.
 */
class MsgNotify {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance for logging.
	 */
	constructor(adapter) {
		if (!adapter) {
			throw new Error('MsgNotify: adapter is required');
		}
		this.adapter = adapter;

		this._plugins = new Map();
		if (this.adapter?.log?.info) {
			this.adapter.log.info(`MsgNotify initialized: (no additional context available))`);
		}
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
	 * Dispatches a single due message.
	 *
	 * @param {object} message Due message.
	 * @param {object} [ctx] Dispatch context.
	 * @returns {number} Number of dispatched messages (0 or 1).
	 */
	dueMessage(message, ctx = {}) {
		if (!message || typeof message !== 'object') {
			return 0;
		}
		this._dispatch(message, ctx);
		return 1;
	}

	/**
	 * Dispatches due messages to all registered plugins.
	 *
	 * @param {Array<object>} messages Due messages.
	 * @param {object} [ctx] Dispatch context.
	 * @returns {number} Number of dispatched messages.
	 */
	dueMessages(messages, ctx = {}) {
		const notifications = Array.isArray(messages) ? messages : [];
		let dispatched = 0;
		for (const message of notifications) {
			dispatched += this.dueMessage(message, ctx);
		}
		return dispatched;
	}

	/**
	 * Dispatches a single notification to all registered plugins.
	 *
	 * @param {object} notification Due notification.
	 * @param {object} [ctx] Dispatch context.
	 */
	_dispatch(notification, ctx = {}) {
		if (!this._plugins.size) {
			this.adapter?.log?.debug?.('MsgNotify._dispatch: no plugins registered');
			return;
		}

		for (const [id, plugin] of this._plugins.entries()) {
			try {
				plugin.fn([notification], ctx);
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgNotify._dispatch: plugin '${id}' failed: ${e?.message || e}`);
			}
		}
	}
}

module.exports = { MsgNotify };
