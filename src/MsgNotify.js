/**
 * MsgNotify
 * ========
 * Notification dispatcher for MsgHub.
 *
 * Docs: ../docs/modules/MsgNotify.md
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
 *
 * Conventions
 * - Notifier plugins live in `/lib` and are loaded via `/lib/index.js`.
 * - Plugin modules follow `Notify*` (e.g. `lib/NotifyStates/index.js`).
 */

const {
	buildIoBrokerApi,
	buildI18nApi,
	buildLogApi,
	buildStoreApi,
	buildStatsApi,
	buildAiApi,
} = require('./MsgHostApi');

/**
 * MsgNotify
 */
class MsgNotify {
	/**
	 * Create a new dispatcher instance.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { i18n?: ({ t?: Function, getTranslatedObject?: Function } | null) }} adapter Adapter instance (used for logging only).
	 * @param {import('./MsgConstants').MsgConstants} msgConstants Centralized enum-like constants (source of truth for events).
	 * @param {object} [options] Optional extensions (advanced).
	 * @param {object} [options.store] Optional MsgStore instance (plugins get a facade via `ctx.api.store`).
	 * @param {import('./MsgAi').MsgAi|null} [options.ai] Optional MsgAi instance (plugins get a facade via `ctx.api.ai`).
	 */
	constructor(adapter, msgConstants, { store: msgStore, ai: msgAi } = {}) {
		if (!adapter) {
			throw new Error('MsgNotify: adapter is required');
		}
		this.adapter = adapter;

		if (!msgConstants) {
			throw new Error('MsgNotify: msgConstants is required');
		}
		this.msgConstants = msgConstants;

		this._plugins = new Map();
		this._running = true;
		this.adapter?.log?.info?.('MsgNotify initialized');

		// Precompute allowed event values once to avoid repeated Object.values allocations on every dispatch.
		this.notificationEventsSet = new Set(Object.values(this.msgConstants.notfication.events));

		const hostName = this?.constructor?.name || 'MsgNotify';
		const store = buildStoreApi(msgStore, { hostName });
		const stats = buildStatsApi(msgStore);
		const ai = buildAiApi(msgAi || null);

		const i18n = buildI18nApi(this.adapter);
		const iobroker = buildIoBrokerApi(this.adapter, { hostName });
		const log = buildLogApi(this.adapter, { hostName });

		// Stable plugin surface: separate API (capabilities) from meta (dispatch metadata).
		this.api = Object.freeze({
			constants: this.msgConstants,
			i18n,
			iobroker,
			log,
			store,
			stats,
			ai,
		});
	}

	/**
	 * Stops all registered plugins (best-effort) and prevents further dispatches.
	 *
	 * @param {object} [meta] Stop metadata (exposed to plugins via `ctx.meta`).
	 * @returns {void}
	 */
	stop(meta = {}) {
		const ctx = this._buildCtx(meta);
		for (const [id, plugin] of this._plugins.entries()) {
			if (!plugin?.stopFn) {
				continue;
			}
			try {
				plugin.stopFn(ctx);
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgNotify: plugin '${id}' failed to stop: ${e?.message || e}`);
			}
		}
		this._running = false;
	}

	/**
	 * Registers a notification plugin.
	 *
	 * Handler shapes:
	 * - Function: `(event, notificationsArray, ctx) => void`
	 * - Object: `{ onNotifications(event, notificationsArray, ctx) { ... }, start?(ctx), stop?(ctx) }`
	 *
	 * Notes:
	 * - Registering the same `id` again overwrites the previous plugin.
	 * - Object handlers are bound to preserve `this`.
	 * - `start(ctx)` is called best-effort right after registration.
	 *
	 * @param {string} id Plugin identifier.
	 * @param {Function|{onNotifications: Function, start?: Function, stop?: Function}} handler Plugin handler.
	 */
	registerPlugin(id, handler) {
		if (!id || typeof id !== 'string') {
			throw new Error('MsgNotify.registerPlugin: id is required');
		}
		if (typeof handler !== 'function' && typeof handler?.onNotifications !== 'function') {
			throw new Error('MsgNotify.registerPlugin: handler must be a function or { onNotifications }');
		}

		const previous = this._plugins.get(id);
		// Best-effort stop on overwrite to avoid leaked intervals/connections.
		if (previous?.stopFn) {
			try {
				previous.stopFn(this._buildCtx({ reason: 'registerPlugin:overwrite', pluginId: id }));
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgNotify: plugin '${id}' failed to stop on overwrite: ${e?.message || e}`);
			}
		}

		const isFn = typeof handler === 'function';
		const fn = isFn ? handler : handler.onNotifications.bind(handler);
		const startFn = !isFn && typeof handler?.start === 'function' ? handler.start.bind(handler) : null;
		const stopFn = !isFn && typeof handler?.stop === 'function' ? handler.stop.bind(handler) : null;

		this._plugins.set(id, { handler, fn, startFn, stopFn });

		if (this._running && startFn) {
			try {
				startFn(this._buildCtx({ reason: 'registerPlugin', pluginId: id }));
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgNotify: plugin '${id}' failed to start: ${e?.message || e}`);
			}
		}
	}

	/**
	 * Removes a registered plugin.
	 *
	 * This is a no-op if the id is unknown.
	 *
	 * @param {string} id Plugin identifier.
	 */
	unregisterPlugin(id) {
		const plugin = this._plugins.get(id);
		this._plugins.delete(id);

		// Best-effort stop to release intervals/connections.
		if (this._running && plugin?.stopFn) {
			try {
				plugin.stopFn(this._buildCtx({ reason: 'unregisterPlugin', pluginId: id }));
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgNotify: plugin '${id}' failed to stop: ${e?.message || e}`);
			}
		}
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
	 * @param {object} [meta] Dispatch metadata (exposed to plugins via `ctx.meta`).
	 * @returns {number} Number of dispatched messages.
	 */
	dispatch(event, messages, meta = {}) {
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
			this._dispatch(eventName, message, meta);
		}
		return dispatched;
	}

	/**
	 * Dispatches a single notification to all registered plugins.
	 *
	 * @param {string} event Event name.
	 * @param {object} notification Notification message object.
	 * @param {object} [meta] Dispatch metadata (exposed to plugins via `ctx.meta`).
	 */
	_dispatch(event, notification, meta = {}) {
		if (!this._plugins.size) {
			this.adapter?.log?.debug?.(
				`MsgNotify: no plugins registered to notify about '${notification.ref}' (event='${event}')`,
			);
			return;
		}

		const ctx = this._buildCtx(meta);
		for (const [id, plugin] of this._plugins.entries()) {
			try {
				// Plugins always receive an array to keep a stable interface for potential future batching.
				plugin.fn(event, [notification], ctx);
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgNotify: plugin '${id}' failed (event='${event}'): ${e?.message || e}`);
			}
		}
	}

	/**
	 * Build the plugin call context.
	 *
	 * @param {object} [meta] Dispatch metadata provided by the caller (e.g. MsgStore).
	 * @returns {{ api: object, meta: object }} Context passed to plugins.
	 */
	_buildCtx(meta = {}) {
		return {
			api: this.api,
			meta: {
				...(meta || {}),
				running: this._running,
			},
		};
	}
}

module.exports = { MsgNotify };
