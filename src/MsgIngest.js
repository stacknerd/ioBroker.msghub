/**
 * MsgIngest
 * ========
 * Producer plugin host for MsgHub.
 *
 * Docs: ../docs/modules/MsgIngest.md
 *
 * Core responsibilities
 * - Fan out ioBroker input events (stateChange/objectChange) to registered producer plugins.
 * - Provide a narrow ingestion API that writes through MsgStore only.
 * - Provide a small plugin registry with register/unregister semantics.
 *
 * Design guidelines / invariants
 * - Event routing only: this class does not interpret ioBroker states/objects; plugins do.
 * - No direct list mutation: plugins never touch MsgStore internals; ingestion goes through MsgStore methods.
 * - Stable call shapes: plugins receive `(id, value, ctx)` for input events, where `ctx = { api, meta }`.
 * - Fault isolation: plugin failures are caught and logged so one bad plugin cannot break other plugins.
 *
 * Conventions
 * - Producer plugins live in `lib/` and are loaded via `lib/index.js`.
 * - Plugin entry files typically live at `lib/Ingest<System>/index.js` (e.g. `lib/IngestIoBrokerStates/index.js`).
 */

const {
	buildIoBrokerApi,
	buildI18nApi,
	buildLogApi,
	buildStoreApi,
	buildFactoryApi,
	buildStatsApi,
	buildAiApi,
} = require('./MsgHostApi');

/**
 * MsgIngest
 */
class MsgIngest {
	/**
	 * Create a new ingest host instance.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { i18n?: ({ t?: Function, getTranslatedObject?: Function } | null) }} adapter Adapter instance.
	 * @param {import('./MsgConstants').MsgConstants} msgConstants Centralized enum-like constants (optional for plugins).
	 * @param {import('./MsgFactory').MsgFactory} msgFactory Factory (used to create normalized messages on "create" paths).
	 * @param {import('./MsgStore').MsgStore} msgStore Store API (single write path).
	 * @param {{ ai?: import('./MsgAi').MsgAi|null }} [options] Optional host extensions.
	 */
	constructor(adapter, msgConstants, msgFactory, msgStore, options = {}) {
		if (!adapter) {
			throw new Error('MsgIngest: adapter is required');
		}
		this.adapter = adapter;

		if (!msgConstants) {
			throw new Error('MsgIngest: msgConstants is required');
		}
		this.msgConstants = msgConstants;

		if (!msgFactory) {
			throw new Error('MsgIngest: msgFactory is required');
		}
		this.msgFactory = msgFactory;

		if (!msgStore) {
			throw new Error('MsgIngest: msgStore is required');
		}
		this.msgStore = msgStore;

		this._plugins = new Map();
		this._running = false;
		this._baseMeta = {};

		const hostName = this?.constructor?.name || 'MsgIngest';
		const store = buildStoreApi(this.msgStore, { hostName });
		const factory = buildFactoryApi(this.msgFactory, { hostName });
		const stats = buildStatsApi(this.msgStore);
		const ai = buildAiApi(options?.ai || null);

		const i18n = buildI18nApi(this.adapter);

		const iobroker = buildIoBrokerApi(this.adapter, { hostName });
		const log = buildLogApi(this.adapter, { hostName });

		// Stable plugin surface: separate API (capabilities) from meta (dispatch metadata).
		this.api = Object.freeze({
			constants: this.msgConstants,
			factory,
			store,
			stats,
			ai,
			i18n,
			iobroker,
			log,
		});

		this.adapter?.log?.info?.('MsgIngest initialized');
	}

	/**
	 * Registers a producer plugin.
	 *
	 * Handler shapes:
	 * - Function: `(id, value, ctx) => void` (treated as `onStateChange`)
	 * - Object: `{ start(ctx)?, stop(ctx)?, onStateChange(id, state, ctx)?, onObjectChange(id, obj, ctx)? }`
	 *
	 * Notes:
	 * - Registering the same `id` again overwrites the previous plugin.
	 * - Object handlers are bound to preserve `this`.
	 *
	 * @param {string} id Plugin identifier.
	 * @param {Function|object} handler Plugin handler or handler object.
	 */
	registerPlugin(id, handler) {
		if (!id || typeof id !== 'string') {
			throw new Error('MsgIngest.registerPlugin: id is required');
		}
		if (!handler) {
			throw new Error('MsgIngest.registerPlugin: handler is required');
		}

		const isFn = typeof handler === 'function';
		const hasAny =
			isFn ||
			typeof handler?.start === 'function' ||
			typeof handler?.stop === 'function' ||
			typeof handler?.onStateChange === 'function' ||
			typeof handler?.onObjectChange === 'function';

		if (!hasAny) {
			throw new Error(
				'MsgIngest.registerPlugin: handler must be a function or an object with start/stop/onStateChange/onObjectChange',
			);
		}

		const previous = this._plugins.get(id);
		// Best-effort stop on overwrite to avoid leaked intervals/subscriptions.
		if (this._running && previous?.stopFn) {
			try {
				previous.stopFn(this._buildCtx({ reason: 'registerPlugin:overwrite', pluginId: id }));
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgIngest: plugin '${id}' failed to stop on overwrite: ${e?.message || e}`);
			}
		}

		const plugin = {
			handler,
			startFn: typeof handler?.start === 'function' ? handler.start.bind(handler) : null,
			stopFn: typeof handler?.stop === 'function' ? handler.stop.bind(handler) : null,
			onStateChangeFn: isFn
				? handler
				: typeof handler?.onStateChange === 'function'
					? handler.onStateChange.bind(handler)
					: null,
			onObjectChangeFn:
				typeof handler?.onObjectChange === 'function' ? handler.onObjectChange.bind(handler) : null,
		};

		this._plugins.set(id, plugin);

		// If the host is already running, start the newly registered plugin immediately.
		if (this._running && plugin.startFn) {
			try {
				plugin.startFn(this._buildCtx({ reason: 'registerPlugin', pluginId: id }));
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgIngest: plugin '${id}' failed to start: ${e?.message || e}`);
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

		// Best-effort stop to release intervals/subscriptions.
		if (this._running && plugin?.stopFn) {
			try {
				plugin.stopFn(this._buildCtx({ reason: 'unregisterPlugin', pluginId: id }));
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgIngest: plugin '${id}' failed to stop: ${e?.message || e}`);
			}
		}
	}

	/**
	 * Starts all registered plugins (best-effort).
	 *
	 * @param {object} [meta] Startup metadata (exposed to plugins via `ctx.meta`).
	 */
	start(meta = {}) {
		// Persist only stable, host-provided meta keys across subsequent ctx builds.
		// Call-specific meta (like { boot: true }) should not leak into later calls (stop/register/unregister).
		this._baseMeta = meta && meta.managedObjects ? { managedObjects: meta.managedObjects } : {};
		this._running = true;

		const pluginCtx = this._buildCtx(meta);
		for (const [id, plugin] of this._plugins.entries()) {
			if (!plugin.startFn) {
				continue;
			}
			try {
				plugin.startFn(pluginCtx);
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgIngest: plugin '${id}' failed to start: ${e?.message || e}`);
			}
		}
	}

	/**
	 * Stops all registered plugins (best-effort).
	 *
	 * @param {object} [meta] Stop metadata (exposed to plugins via `ctx.meta`).
	 */
	stop(meta = {}) {
		const pluginCtx = this._buildCtx(meta);

		for (const [id, plugin] of this._plugins.entries()) {
			if (!plugin.stopFn) {
				continue;
			}
			try {
				plugin.stopFn(pluginCtx);
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgIngest: plugin '${id}' failed to stop: ${e?.message || e}`);
			}
		}

		this._running = false;
	}

	/**
	 * Dispatch an ioBroker stateChange event to all registered plugins.
	 *
	 * @param {string} id State id.
	 * @param {ioBroker.State | null | undefined} state State value.
	 * @param {object} [meta] Dispatch metadata (exposed to plugins via `ctx.meta`).
	 * @returns {number} Number of plugins that were called.
	 */
	dispatchStateChange(id, state, meta = {}) {
		if (typeof id !== 'string' || !id.trim()) {
			return 0;
		}
		const pluginCtx = this._buildCtx(meta);

		let called = 0;
		for (const [pid, plugin] of this._plugins.entries()) {
			if (!plugin.onStateChangeFn) {
				continue;
			}
			try {
				called += 1;
				plugin.onStateChangeFn(id, state, pluginCtx);
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgIngest: plugin '${pid}' failed on stateChange: ${e?.message || e}`);
			}
		}
		return called;
	}

	/**
	 * Dispatch an ioBroker objectChange event to all registered plugins.
	 *
	 * @param {string} id Object id.
	 * @param {ioBroker.Object | null | undefined} obj Object value.
	 * @param {object} [meta] Dispatch metadata (exposed to plugins via `ctx.meta`).
	 * @returns {number} Number of plugins that were called.
	 */
	dispatchObjectChange(id, obj, meta = {}) {
		if (typeof id !== 'string' || !id.trim()) {
			return 0;
		}
		const pluginCtx = this._buildCtx(meta);

		let called = 0;
		for (const [pid, plugin] of this._plugins.entries()) {
			if (!plugin.onObjectChangeFn) {
				continue;
			}
			try {
				called += 1;
				plugin.onObjectChangeFn(id, obj, pluginCtx);
			} catch (e) {
				this.adapter?.log?.warn?.(`MsgIngest: plugin '${pid}' failed on objectChange: ${e?.message || e}`);
			}
		}
		return called;
	}

	/**
	 * Build the context object passed to producer plugins.
	 *
	 * @param {object} [meta] Dispatch metadata merged into `ctx.meta`.
	 * @returns {{ api: object, meta: object }} Context object.
	 */
	_buildCtx(meta = {}) {
		return {
			api: this.api,
			meta: {
				...(this._baseMeta || {}),
				...(meta || {}),
				running: this._running,
			},
		};
	}
}

module.exports = { MsgIngest };
