/**
 * IoPlugins
 * =========
 * Adapter-side plugin orchestration for MsgHub.
 *
 * Docs: ../docs/plugins/IoPlugins.md
 *
 * Where it sits in the system
 * ---------------------------
 * - The adapter (`main.js`) owns the `MsgStore` instance (core in `src/`).
 * - `MsgStore` owns two plugin hosts:
 *   - `msgIngest` (producer plugins; inbound ioBroker events -> message mutations)
 *   - `msgNotify` (notifier plugins; message events -> delivery actions)
 * - This class is the adapter's "plugin runtime":
 *   - creates/maintains enable switches (ioBroker states),
 *   - loads per-plugin options from ioBroker objects (`native`),
 *   - registers/unregisters plugin instances in the two hosts.
 *
 * What this intentionally does NOT do
 * ----------------------------------
 * - No plugin discovery: available plugins are defined by the catalog in `lib/index.js`.
 * - No option validation/normalization: `obj.native` is passed through as-is (raw), and plugin code owns its config schema.
 * - No bridge host layer: bridge *wiring* is handled by `src/MsgBridge.js` so events still flow through the existing
 *   hosts (`MsgIngest` / `MsgNotify`).
 *
 * Enable/disable + config storage model
 * ------------------------------------
 * For each plugin instance we create a small object subtree:
 * - base object (`type=channel`): `<PluginType>.0`
 *   - stores options in `object.native` (raw JSON)
 * - enable switch (`type=state`): `<PluginType>.0.enable` (boolean, rw)
 * - runtime status (`type=state`): `<PluginType>.0.status` (string, ro: starting|running|stopping|stopped|error)
 *
 * ID scheme (today)
 * - base id (own id): `<PluginType>.0` (instance id is always numeric `0` today)
 * - enable id: `<PluginType>.0.enable`
 * - status id: `<PluginType>.0.status`
 *
 * Important semantics / invariants
 * - The state value is the source of truth (persistent).
 * - Enable toggles come from ioBroker state changes (`ack: false` writes).
 * - We persist the final desired value as `ack: true` to "commit" the state.
 * - Toggle operations are serialized via `createOpQueue()` to avoid overlap/races.
 *
 * Interaction with the adapter (`main.js`)
 * ---------------------------------------
 * The adapter should call `handleStateChange(id, state)` early in its `onStateChange` handler.
 * If it returns `true`, the event was consumed as a plugin enable/disable change and must not be forwarded to ingest plugins.
 */

'use strict';

const { createOpQueue, isObject } = require(`${__dirname}/../src/MsgUtils`);
const { buildActionApi } = require(`${__dirname}/../src/MsgHostApi`);
const { MsgBridge } = require(`${__dirname}/../src/MsgBridge`);
const { MsgEngage } = require(`${__dirname}/../src/MsgEngage`);
const { IoPluginsCategories, IoPluginsCatalog } = require('./index');
const { tapActionExecute } = require('./IoActionEffects');
const { IoManagedMeta } = require('./IoManagedMeta');

/**
 * IoPlugins
 */
class IoPlugins {
	/**
	 * Create a new runtime plugin orchestrator.
	 *
	 * Construction notes (similar philosophy as `MsgStore`)
	 * - The constructor performs only minimal, synchronous setup (no I/O).
	 * - Call `await init()` to ensure enable states exist and to subscribe to them.
	 * - Call `await registerEnabled()` to register all enabled plugins.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string, i18n?: ({ t?: Function, getTranslatedObject?: Function } | null) }} adapter Adapter instance (ioBroker).
	 * @param {import('../src/MsgStore').MsgStore} msgStore MsgStore instance (owns `msgIngest` and `msgNotify`).
	 * @param {object} [options] Optional configuration (advanced/testing).
	 * @param {number} [options.instanceId] Plugin instance id (numeric; currently always `0`).
	 * @param {object} [options.catalog] Catalog override (defaults to `IoPluginsCatalog` from `lib/index.js`).
	 */
	constructor(adapter, msgStore, { instanceId = 0, catalog = IoPluginsCatalog } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoPlugins: adapter is required');
		}
		if (!msgStore?.msgIngest || !msgStore?.msgNotify) {
			throw new Error('IoPlugins: msgStore.msgIngest/msgNotify are required');
		}

		this.adapter = adapter;
		this.msgStore = msgStore;
		if (!Number.isFinite(instanceId) || Number.isNaN(instanceId)) {
			throw new Error('IoPlugins: options.instanceId must be a number');
		}
		this.instanceId = instanceId;
		this.catalog = catalog || IoPluginsCatalog;

		// Fast type lookups for wiring (avoids scanning the catalog repeatedly).
		this._ingestByType = new Map((this.catalog[IoPluginsCategories.ingest] || []).map(p => [p.type, p]));
		this._notifyByType = new Map((this.catalog[IoPluginsCategories.notify] || []).map(p => [p.type, p]));
		this._bridgeByType = new Map((this.catalog[IoPluginsCategories.bridge] || []).map(p => [p.type, p]));
		this._engageByType = new Map((this.catalog[IoPluginsCategories.engage] || []).map(p => [p.type, p]));

		this._instances = [];
		this._controlOwnIds = new Set();
		this._registered = {
			[IoPluginsCategories.ingest]: new Set(),
			[IoPluginsCategories.notify]: new Set(),
			[IoPluginsCategories.bridge]: new Set(),
			[IoPluginsCategories.engage]: new Set(),
		};
		this._bridgeHandles = new Map();
		this._engageHandles = new Map();

		// Messagebox / sendTo direct handler (optional; intentionally not part of ctx.api).
		// At most one Engage plugin can own this handler at a time.
		this._messagebox = null; // { ownerId: string, handler: Function }

		this._managedMeta = new IoManagedMeta(this.adapter);

		// Serialize enable/disable operations to prevent overlapping register/unregister sequences.
		this._queue = createOpQueue();
	}

	/**
	 * Meta bundle passed to `MsgIngest.start(...)`.
	 *
	 * @returns {object} Meta object.
	 */
	getIngestMeta() {
		return {};
	}

	/**
	 * Dispatch an ioBroker messagebox call to the currently registered handler (if any).
	 *
	 * This is a deliberate "escape hatch" that bypasses ctx.api plumbing: messagebox is a single-adapter feature
	 * and is owned by exactly one Engage plugin (e.g. `EngageSendTo`).
	 *
	 * @param {ioBroker.Message} obj ioBroker messagebox object.
	 * @returns {Promise<any|null>} Handler result or null when no handler is registered.
	 */
	async dispatchMessagebox(obj) {
		const handler = this._messagebox?.handler;
		if (typeof handler !== 'function') {
			return null;
		}
		return await handler(obj);
	}

	/**
	 * Clear any registered messagebox handler.
	 *
	 * Intended to be called by the adapter unload hook as best-effort cleanup (compact mode).
	 *
	 * @returns {void}
	 */
	clearMessageboxHandler() {
		this._messagebox = null;
	}

	/**
	 * Register a messagebox handler owned by exactly one Engage plugin instance.
	 *
	 * @param {string} ownerId Registration id of the plugin instance (e.g. `EngageSendTo:0`).
	 * @param {Function} handler Messagebox handler.
	 * @returns {void}
	 */
	_adoptMessageboxHandler(ownerId, handler) {
		if (typeof handler !== 'function') {
			return;
		}
		const owner = typeof ownerId === 'string' ? ownerId.trim() : '';
		if (!owner) {
			throw new Error('IoPlugins: messagebox handler ownerId is required');
		}

		const existingOwner = this._messagebox?.ownerId;
		if (existingOwner && existingOwner !== owner) {
			throw new Error(
				`IoPlugins: messagebox handler already registered by '${existingOwner}' (cannot register '${owner}')`,
			);
		}

		this._messagebox = { ownerId: owner, handler };
	}

	/**
	 * Release the messagebox handler when owned by the given plugin instance.
	 *
	 * @param {string} ownerId Registration id of the plugin instance.
	 * @returns {boolean} True when released, otherwise false.
	 */
	_releaseMessageboxHandler(ownerId) {
		const owner = typeof ownerId === 'string' ? ownerId.trim() : '';
		if (!owner) {
			return false;
		}
		if (this._messagebox?.ownerId !== owner) {
			return false;
		}
		this._messagebox = null;
		return true;
	}

	/**
	 * Create, initialize enable states, and register currently enabled plugins.
	 *
	 * This is the common convenience entry point for adapter startup.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string, i18n?: ({ t?: Function, getTranslatedObject?: Function } | null) }} adapter Adapter instance.
	 * @param {import('../src/MsgStore').MsgStore} msgStore MsgStore instance.
	 * @param {object} [options] Options forwarded to the constructor (advanced/testing).
	 * @returns {Promise<IoPlugins>} Initialized instance.
	 */
	static async create(adapter, msgStore, options) {
		const mgr = new IoPlugins(adapter, msgStore, options);
		await mgr.init();
		await mgr.registerEnabled();
		return mgr;
	}

	/**
	 * Initialize (and subscribe to) all plugin enable states.
	 *
	 * Behavior
	 * - Ensures every catalog plugin has an enable state and subscribes to it.
	 * - Seeds the enable state only once (when the state does not exist yet), using `defaultEnabled` from the catalog.
	 *
	 * Notes
	 * - Subscriptions are required so `main.js` receives state changes when users toggle the switches.
	 * - `IoPlugins` itself does not register generic wildcard subscriptions.
	 *
	 * @returns {Promise<void>} Resolves when enable states are ensured and subscribed.
	 */
	async init() {
		this._instances = await this._initPluginEnableStates();
		this._controlOwnIds = new Set(this._instances.map(i => i.enabledStateId));
	}

	/**
	 * Register all currently enabled plugin instances.
	 *
	 * Notes
	 * - Registration is idempotent (per category + registration id).
	 * - The registration id is always `"<type>:<instanceId>"` to keep it stable when multi-instance is introduced later.
	 *
	 * @returns {Promise<void>} Resolves when all enabled plugins are registered.
	 */
	async registerEnabled() {
		for (const inst of this._instances) {
			if (!inst.enabled) {
				continue;
			}
			try {
				await this._registerOne(inst);
			} catch (e) {
				const regId = this._makeRegistrationId({ type: inst.type, instanceId: inst.instanceId });
				this.adapter?.log?.error?.(`Plugin wiring failed for '${inst.category}/${regId}': ${e?.message || e}`);
			}
		}
	}

	/**
	 * Check whether a state id belongs to plugin enable/disable control.
	 *
	 * @param {string} id Full or own state id.
	 * @returns {boolean} True when the id is a plugin enable/disable state.
	 */
	isPluginControlStateId(id) {
		const ownId = this._toOwnId(id);
		return !!ownId && this._controlOwnIds.has(ownId);
	}

	/**
	 * Handle a state change event.
	 *
	 * Contract
	 * - The adapter calls this for every `stateChange` event it receives.
	 * - When this returns `true`, the event was handled as a plugin enable/disable toggle and should not be forwarded
	 *   to ingest plugins.
	 *
	 * Ack semantics
	 * - `ack: true` writes are ignored (includes our own initialization and our "commit" writes).
	 * - `ack: false` writes are treated as user intent and will trigger register/unregister.
	 *
	 * @param {string} id Full state id.
	 * @param {ioBroker.State | null | undefined} state State object.
	 * @returns {boolean} Whether the id was handled as a plugin control state.
	 */
	handleStateChange(id, state) {
		const ownId = this._toOwnId(id);
		if (!ownId || !this._controlOwnIds.has(ownId)) {
			return false;
		}
		// Ignore acked writes (including our own initialization).
		if (!state || state.ack === true) {
			return true;
		}

		const desired = state.val === true;
		const info = this._instances.find(i => i.enabledStateId === ownId);
		if (!info) {
			return true;
		}

		this._queue(async () => {
			try {
				await this._applyEnableToggle(info, desired, id);
			} catch (e) {
				this.adapter?.log?.error?.(`Plugin enable toggle failed for '${id}': ${e?.message || e}`);
			}
		});

		return true;
	}

	/**
	 * Build and ensure enable states for all catalog entries (ingest + notify + bridge + engage).
	 *
	 * @returns {Promise<Array<object>>} List of managed plugin instances (one per catalog entry).
	 */
	async _initPluginEnableStates() {
		const instances = [];
		const instanceId = this.instanceId;

		const initOne = async (category, plugin) => {
			const expectedPrefix = IoPlugins._expectedPrefixForCategory(category);
			if (expectedPrefix && !String(plugin.type || '').startsWith(expectedPrefix)) {
				throw new Error(
					`IoPlugins: type '${plugin.type}' must start with '${expectedPrefix}' for category '${category}'`,
				);
			}

			const st = await this._ensurePluginEnabledState({
				category,
				type: plugin.type,
				instanceId,
				initialEnabled: plugin.defaultEnabled === true,
				defaultOptions: plugin.defaultOptions,
			});
			instances.push({
				category,
				type: plugin.type,
				instanceId,
				...st,
			});
		};

		for (const plugin of this.catalog[IoPluginsCategories.ingest] || []) {
			await initOne(IoPluginsCategories.ingest, plugin);
		}
		for (const plugin of this.catalog[IoPluginsCategories.notify] || []) {
			await initOne(IoPluginsCategories.notify, plugin);
		}
		for (const plugin of this.catalog[IoPluginsCategories.bridge] || []) {
			await initOne(IoPluginsCategories.bridge, plugin);
		}
		for (const plugin of this.catalog[IoPluginsCategories.engage] || []) {
			await initOne(IoPluginsCategories.engage, plugin);
		}

		return instances;
	}

	/**
	 * Translate a string template via adapter i18n (when available).
	 *
	 * @param {string} template Template string with `%s` placeholders.
	 * @param {...any} args Template arguments.
	 * @returns {ioBroker.StringOrTranslated} ioBroker translated name or a stable `{en,de}` fallback.
	 */
	_getTranslatedName(template, ...args) {
		const i18n = this.adapter?.i18n;
		if (i18n && typeof i18n.getTranslatedObject === 'function') {
			const out = i18n.getTranslatedObject(template, ...args);
			if (out) {
				return out;
			}
		}
		// Fallback: keep a stable object form for common.name.
		const format = (tmpl, params) => {
			if (typeof tmpl !== 'string') {
				return '';
			}
			let i = 0;
			return tmpl.replace(/%s/g, () => String(params?.[i++] ?? ''));
		};
		const s = format(template, args);
		return { en: s, de: s };
	}

	/**
	 * Build the plugin base "own id" (without namespace).
	 *
	 * @param {{ type: string, instanceId: number }} options Options.
	 * @returns {string} Own object id.
	 */
	_getPluginBaseOwnId({ type, instanceId }) {
		return `${type}.${instanceId}`;
	}

	/**
	 * Build the plugin enable-switch "own id" (without namespace).
	 *
	 * @param {{ type: string, instanceId: number }} options Options.
	 * @returns {string} Own state id.
	 */
	_getPluginEnableOwnId({ type, instanceId }) {
		return `${type}.${instanceId}.enable`;
	}

	/**
	 * Build the plugin status state "own id" (without namespace).
	 *
	 * @param {{ type: string, instanceId: number }} options Options.
	 * @returns {string} Own state id.
	 */
	_getPluginStatusOwnId({ type, instanceId }) {
		return `${type}.${instanceId}.status`;
	}

	/**
	 * Persist a status string for a plugin instance (best-effort).
	 *
	 * @param {{ type: string, instanceId: number }} options Plugin identity.
	 * @param {'starting'|'running'|'stopping'|'stopped'|'error'|string} status Status value.
	 * @returns {Promise<void>} Resolves after the best-effort write.
	 */
	async _setPluginStatus({ type, instanceId }, status) {
		const ownId = this._getPluginStatusOwnId({ type, instanceId });
		try {
			await this._setStateAckAsync(ownId, String(status));
		} catch {
			// swallow (best-effort)
		}
	}

	/**
	 * Ensure the plugin base object exists (for `native` options) and ensure the control states exist:
	 * - `<type>.<instanceId>.enable` (rw switch)
	 * - `<type>.<instanceId>.status` (ro string: starting|running|stopping|stopped|error)
	 *
	 * @param {object} options Plugin identity + initial defaults.
	 * @param {string} options.category One of `IoPluginsCategories.*`.
	 * @param {string} options.type Plugin type.
	 * @param {number} options.instanceId Numeric instance id (today always `0`).
	 * @param {boolean} options.initialEnabled Initial enable state (only used if the enable state does not exist yet).
	 * @param {object} [options.defaultOptions] Default options (seeded into `native` only when the base object does not exist yet).
	 * @returns {Promise<{ baseObjectId: string, baseObjectIdFull: string, enabledStateId: string, enabledStateIdFull: string, statusStateId: string, statusStateIdFull: string, enabled: boolean }>}
	 *   Enable/status info.
	 */
	async _ensurePluginEnabledState({ category, type, instanceId, initialEnabled, defaultOptions }) {
		const baseObjectId = this._getPluginBaseOwnId({ type, instanceId });
		const baseObjectIdFull = this._toFullId(baseObjectId);
		const enabledStateId = this._getPluginEnableOwnId({ type, instanceId });
		const enabledStateIdFull = this._toFullId(enabledStateId);
		const statusStateId = this._getPluginStatusOwnId({ type, instanceId });
		const statusStateIdFull = this._toFullId(statusStateId);

		const baseName = this._getTranslatedName('MsgHub plugin (%s/%s/%s)', category, type, instanceId);
		const enableName = this._getTranslatedName('enable MsgHub plugin (%s/%s/%s)', category, type, instanceId);
		const statusName = this._getTranslatedName('status of MsgHub plugin (%s/%s/%s)', category, type, instanceId);

		const existingBase = await this._getObjectAsync(baseObjectId);
		if (existingBase && existingBase.type !== 'channel') {
			throw new Error(
				`IoPlugins: plugin base object '${baseObjectIdFull}' must be type='channel' (found type='${existingBase.type}')`,
			);
		}
		const existingNative = existingBase && isObject(existingBase.native) ? existingBase.native : null;

		// Ensure base object exists for options storage (`native`).
		await this._setObjectNotExistsAsync(baseObjectId, {
			type: 'channel',
			common: {
				name: baseName,
				role: 'folder',
			},
			native: isObject(defaultOptions) ? defaultOptions : {},
		});

		// Best-effort upgrade: keep name and merge native defaults with existing native.
		if (existingBase && (typeof existingBase?.common?.name === 'string' || existingNative)) {
			try {
				await this._extendObjectAsync(baseObjectId, {
					common: { ...(existingBase.common || {}), name: baseName },
					native: existingNative
						? { ...(isObject(defaultOptions) ? defaultOptions : {}), ...existingNative }
						: undefined,
				});
			} catch {
				// swallow (best-effort)
			}
		}

		// Ensure enable state exists.
		await this._setObjectNotExistsAsync(enabledStateId, {
			type: 'state',
			common: {
				name: enableName,
				type: 'boolean',
				role: 'switch',
				read: true,
				write: true,
			},
			native: {},
		});
		this._subscribeStates(enabledStateId);

		// Ensure status state exists (read-only).
		await this._setObjectNotExistsAsync(statusStateId, {
			type: 'state',
			common: {
				name: statusName,
				type: 'string',
				role: 'text',
				read: true,
				write: false,
				states: {
					starting: 'starting',
					running: 'running',
					stopping: 'stopping',
					stopped: 'stopped',
					error: 'error',
				},
			},
			native: {},
		});

		// Seed status once (when missing).
		const existingStatus = await this._getStateAsync(statusStateId);
		if (!existingStatus || typeof existingStatus.val !== 'string') {
			await this._setStateAckAsync(statusStateId, 'stopped');
		}

		// Determine desired enabled state:
		// - prefer existing enable state value
		// - otherwise seed from catalog default
		const existingEnable = await this._getStateAsync(enabledStateId);
		if (existingEnable && typeof existingEnable.val === 'boolean') {
			return {
				baseObjectId,
				baseObjectIdFull,
				enabledStateId,
				enabledStateIdFull,
				statusStateId,
				statusStateIdFull,
				enabled: existingEnable.val,
			};
		}

		const seeded = initialEnabled === true ? true : false;
		await this._setStateAckAsync(enabledStateId, seeded);
		return {
			baseObjectId,
			baseObjectIdFull,
			enabledStateId,
			enabledStateIdFull,
			statusStateId,
			statusStateIdFull,
			enabled: seeded,
		};
	}

	/**
	 * Load plugin options (raw) from the plugin's base object `native`.
	 *
	 * @param {object} options Plugin identity + defaults.
	 * @param {string} options.type Plugin type.
	 * @param {number} options.instanceId Plugin instance id.
	 * @param {object} [options.defaultOptions] Fallback options when the object/native is missing.
	 * @returns {Promise<object>} Raw options object.
	 */
	async _loadPluginOptions({ type, instanceId, defaultOptions }) {
		const ownId = this._getPluginBaseOwnId({ type, instanceId });
		const obj = await this._getObjectAsync(ownId);
		const native = obj?.native;
		return isObject(native) ? native : isObject(defaultOptions) ? defaultOptions : {};
	}

	/**
	 * Build the stable per-plugin meta object injected into `ctx.meta.plugin` for every plugin call.
	 *
	 * @param {{ category: string, type: string, instanceId: number, regId: string, pluginBaseObjectId: string }} info
	 *   Plugin identity.
	 * @returns {{ category: string, type: string, instanceId: number, regId: string, baseFullId: string, baseOwnId: string }}
	 *   Stable meta injected into `ctx.meta.plugin`.
	 */
	_buildPluginMeta({ category, type, instanceId, regId, pluginBaseObjectId }) {
		const cat = typeof category === 'string' ? category.trim() : '';
		const t = typeof type === 'string' ? type.trim() : '';
		const rid = typeof regId === 'string' ? regId.trim() : '';
		const baseFullId = typeof pluginBaseObjectId === 'string' ? pluginBaseObjectId.trim() : '';
		if (!cat || !t || !rid || !baseFullId) {
			throw new Error('IoPlugins: failed to build ctx.meta.plugin (missing identity fields)');
		}
		const inst = instanceId === undefined ? 0 : instanceId;
		const baseOwnId = this._toOwnId(baseFullId);
		if (typeof baseOwnId !== 'string' || !baseOwnId) {
			throw new Error(`IoPlugins: failed to build ctx.meta.plugin (baseOwnId invalid for '${baseFullId}')`);
		}
		return Object.freeze({
			category: cat,
			type: t,
			instanceId: inst,
			regId: rid,
			baseFullId,
			baseOwnId,
		});
	}

	/**
	 * Wrap an ingest plugin handler to inject the per-plugin managed meta reporter into `ctx.meta.managedObjects`.
	 *
	 * @param {any} handler Plugin handler instance (function or object with lifecycle methods).
	 * @param {{ report: Function, applyReported: Function }} reporter Managed meta reporter.
	 * @param {object} pluginMeta Stable per-plugin meta injected into `ctx.meta.plugin`.
	 * @returns {any} Wrapped handler in the same "shape" (function remains a function).
	 */
	_wrapIngestHandlerWithManagedMeta(handler, reporter, pluginMeta) {
		const injectCtx = ctx => {
			const base = ctx && typeof ctx === 'object' ? ctx : {};
			const meta = base.meta && typeof base.meta === 'object' ? base.meta : {};
			return { ...base, meta: { ...meta, managedObjects: reporter, plugin: pluginMeta } };
		};

		if (typeof handler === 'function') {
			return (id, state, ctx) => handler(id, state, injectCtx(ctx));
		}
		if (!handler || typeof handler !== 'object') {
			return handler;
		}

		const wrapped = {};
		if (typeof handler.start === 'function') {
			wrapped.start = ctx => handler.start.call(handler, injectCtx(ctx));
		}
		if (typeof handler.stop === 'function') {
			wrapped.stop = ctx => handler.stop.call(handler, injectCtx(ctx));
		}
		if (typeof handler.onStateChange === 'function') {
			wrapped.onStateChange = (id, state, ctx) => handler.onStateChange.call(handler, id, state, injectCtx(ctx));
		}
		if (typeof handler.onObjectChange === 'function') {
			wrapped.onObjectChange = (id, obj, ctx) => handler.onObjectChange.call(handler, id, obj, injectCtx(ctx));
		}
		return wrapped;
	}

	/**
	 * Wrap a notify plugin handler to inject stable per-plugin info into `ctx.meta.plugin`.
	 *
	 * @param {any} handler Plugin handler instance (function or object with lifecycle methods).
	 * @param {object} pluginMeta Stable per-plugin meta injected into `ctx.meta.plugin`.
	 * @returns {any} Wrapped handler in the same "shape" (function remains a function).
	 */
	_wrapNotifyHandlerWithPluginMeta(handler, pluginMeta) {
		const injectCtx = ctx => {
			const base = ctx && typeof ctx === 'object' ? ctx : {};
			const meta = base.meta && typeof base.meta === 'object' ? base.meta : {};
			return { ...base, meta: { ...meta, plugin: pluginMeta } };
		};

		if (typeof handler === 'function') {
			return (event, notifications, ctx) => handler(event, notifications, injectCtx(ctx));
		}
		if (!handler || typeof handler !== 'object') {
			return handler;
		}

		const wrapped = {};
		if (typeof handler.start === 'function') {
			wrapped.start = ctx => handler.start.call(handler, injectCtx(ctx));
		}
		if (typeof handler.stop === 'function') {
			wrapped.stop = ctx => handler.stop.call(handler, injectCtx(ctx));
		}
		if (typeof handler.onNotifications === 'function') {
			wrapped.onNotifications = (event, notifications, ctx) =>
				handler.onNotifications.call(handler, event, notifications, injectCtx(ctx));
		}
		return wrapped;
	}

	/**
	 * Wrap a bridge/engage handler object to inject stable per-plugin info into `ctx.meta.plugin`.
	 *
	 * @param {any} handler Plugin handler instance (expected object; functions are passed through).
	 * @param {object} pluginMeta Stable per-plugin meta injected into `ctx.meta.plugin`.
	 * @returns {any} Wrapped handler.
	 */
	_wrapBridgeOrEngageHandlerWithPluginMeta(handler, pluginMeta) {
		const injectCtx = ctx => {
			const base = ctx && typeof ctx === 'object' ? ctx : {};
			const meta = base.meta && typeof base.meta === 'object' ? base.meta : {};
			return { ...base, meta: { ...meta, plugin: pluginMeta } };
		};

		if (!handler || typeof handler !== 'object') {
			return handler;
		}

		const wrapped = {};
		if (typeof handler.start === 'function') {
			wrapped.start = ctx => handler.start.call(handler, injectCtx(ctx));
		}
		if (typeof handler.stop === 'function') {
			wrapped.stop = ctx => handler.stop.call(handler, injectCtx(ctx));
		}
		if (typeof handler.onStateChange === 'function') {
			wrapped.onStateChange = (id, state, ctx) => handler.onStateChange.call(handler, id, state, injectCtx(ctx));
		}
		if (typeof handler.onObjectChange === 'function') {
			wrapped.onObjectChange = (id, obj, ctx) => handler.onObjectChange.call(handler, id, obj, injectCtx(ctx));
		}
		if (typeof handler.onNotifications === 'function') {
			wrapped.onNotifications = (event, notifications, ctx) =>
				handler.onNotifications.call(handler, event, notifications, injectCtx(ctx));
		}
		return wrapped;
	}

	/**
	 * Register exactly one plugin instance if not registered yet.
	 *
	 * The plugin factory receives options merged with:
	 * - `pluginBaseObjectId` (full id), so plugins can write states relative to their own base id.
	 *
	 * Breaking change:
	 * - Plugin factories are called as `create(options)` (no adapter argument). Plugins must use `ctx.api.*`.
	 *
	 * @param {{ category: string, type: string, instanceId: number }} instance Plugin instance info.
	 * @returns {Promise<void>} Resolves when the plugin is registered (or already registered).
	 */
	async _registerOne({ category, type, instanceId }) {
		if (category === IoPluginsCategories.ingest) {
			const plugin = this._ingestByType.get(type);
			if (!plugin) {
				await this._setPluginStatus({ type, instanceId }, 'error');
				return;
			}

			const regId = this._makeRegistrationId({ type, instanceId });
			if (this._registered[category].has(regId)) {
				return;
			}
			this._registered[category].add(regId);
			await this._setPluginStatus({ type, instanceId }, 'starting');

			const pluginBaseObjectId = this._toFullId(`${type}.${instanceId}`);
			const options = await this._loadPluginOptions({ type, instanceId, defaultOptions: plugin.defaultOptions });
			const optionsWithBase = { ...options, pluginBaseObjectId };

			try {
				this.adapter?.log?.debug?.(
					`IoPlugins: registering '${category}/${regId}' with options=${JSON.stringify(optionsWithBase)}`,
				);
				const pluginMeta = this._buildPluginMeta({
					category,
					type,
					instanceId,
					regId,
					pluginBaseObjectId,
				});
				const reporter = this._managedMeta.createReporter({
					category,
					type,
					instanceId,
					pluginBaseObjectId,
				});
				const handler = plugin.create(optionsWithBase);
				this.msgStore.msgIngest.registerPlugin(
					regId,
					this._wrapIngestHandlerWithManagedMeta(handler, reporter, pluginMeta),
				);
				this.adapter?.log?.info?.(`IoPlugins: registered '${category}/${regId}'`);
				await this._setPluginStatus({ type, instanceId }, 'running');
			} catch (e) {
				this._registered[category].delete(regId);
				await this._setPluginStatus({ type, instanceId }, 'error');
				throw e;
			}
			return;
		}

		if (category === IoPluginsCategories.notify) {
			const plugin = this._notifyByType.get(type);
			if (!plugin) {
				await this._setPluginStatus({ type, instanceId }, 'error');
				return;
			}

			const regId = this._makeRegistrationId({ type, instanceId });
			if (this._registered[category].has(regId)) {
				return;
			}
			this._registered[category].add(regId);
			await this._setPluginStatus({ type, instanceId }, 'starting');

			const pluginBaseObjectId = this._toFullId(`${type}.${instanceId}`);
			const options = await this._loadPluginOptions({ type, instanceId, defaultOptions: plugin.defaultOptions });
			const optionsWithBase = { ...options, pluginBaseObjectId };

			try {
				this.adapter?.log?.debug?.(
					`IoPlugins: registering '${category}/${regId}' with options=${JSON.stringify(optionsWithBase)}`,
				);
				const pluginMeta = this._buildPluginMeta({
					category,
					type,
					instanceId,
					regId,
					pluginBaseObjectId,
				});
				const handler = plugin.create(optionsWithBase);
				this.msgStore.msgNotify.registerPlugin(
					regId,
					this._wrapNotifyHandlerWithPluginMeta(handler, pluginMeta),
				);
				this.adapter?.log?.info?.(`IoPlugins: registered '${category}/${regId}'`);
				await this._setPluginStatus({ type, instanceId }, 'running');
			} catch (e) {
				this._registered[category].delete(regId);
				await this._setPluginStatus({ type, instanceId }, 'error');
				throw e;
			}
			return;
		}

		if (category === IoPluginsCategories.bridge) {
			const plugin = this._bridgeByType.get(type);
			if (!plugin) {
				await this._setPluginStatus({ type, instanceId }, 'error');
				return;
			}

			const regId = this._makeRegistrationId({ type, instanceId });
			if (this._registered[category].has(regId)) {
				return;
			}
			this._registered[category].add(regId);
			await this._setPluginStatus({ type, instanceId }, 'starting');

			const pluginBaseObjectId = this._toFullId(`${type}.${instanceId}`);
			const options = await this._loadPluginOptions({ type, instanceId, defaultOptions: plugin.defaultOptions });
			const optionsWithBase = { ...options, pluginBaseObjectId };

			try {
				this.adapter?.log?.debug?.(
					`IoPlugins: registering '${category}/${regId}' with options=${JSON.stringify(optionsWithBase)}`,
				);

				const pluginMeta = this._buildPluginMeta({
					category,
					type,
					instanceId,
					regId,
					pluginBaseObjectId,
				});

				const handler = plugin.create(optionsWithBase);
				const decoratedHandler = this._wrapBridgeOrEngageHandlerWithPluginMeta(handler, pluginMeta);
				const handle = MsgBridge.registerBridge(regId, decoratedHandler, {
					msgIngest: this.msgStore.msgIngest,
					msgNotify: this.msgStore.msgNotify,
					log: this.adapter?.log,
				});
				this._bridgeHandles.set(regId, handle);

				this.adapter?.log?.info?.(`IoPlugins: registered '${category}/${regId}'`);
				await this._setPluginStatus({ type, instanceId }, 'running');
			} catch (e) {
				this._registered[category].delete(regId);
				await this._setPluginStatus({ type, instanceId }, 'error');
				try {
					this._bridgeHandles.get(regId)?.unregister?.();
				} catch {
					// swallow (best-effort)
				} finally {
					this._bridgeHandles.delete(regId);
				}
				throw e;
			}
		}

		if (category === IoPluginsCategories.engage) {
			const plugin = this._engageByType.get(type);
			if (!plugin) {
				await this._setPluginStatus({ type, instanceId }, 'error');
				return;
			}

			const regId = this._makeRegistrationId({ type, instanceId });
			if (this._registered[category].has(regId)) {
				return;
			}
			this._registered[category].add(regId);
			await this._setPluginStatus({ type, instanceId }, 'starting');

			const pluginBaseObjectId = this._toFullId(`${type}.${instanceId}`);
			const options = await this._loadPluginOptions({ type, instanceId, defaultOptions: plugin.defaultOptions });
			const optionsWithBase = {
				...options,
				pluginBaseObjectId,
				__messagebox: Object.freeze({
					register: handler => this._adoptMessageboxHandler(regId, handler),
					unregister: () => this._releaseMessageboxHandler(regId),
				}),
			};

			try {
				this.adapter?.log?.debug?.(
					`IoPlugins: registering '${category}/${regId}' with options=${JSON.stringify(optionsWithBase)}`,
				);

				const pluginMeta = this._buildPluginMeta({
					category,
					type,
					instanceId,
					regId,
					pluginBaseObjectId,
				});

				const handler = plugin.create(optionsWithBase);
				const decoratedHandler = this._wrapBridgeOrEngageHandlerWithPluginMeta(handler, pluginMeta);
				const baseAction = buildActionApi(this.adapter, this.msgStore?.msgConstants, this.msgStore, {
					hostName: 'MsgEngage',
				});
				const wrappedAction =
					baseAction && typeof baseAction.execute === 'function'
						? Object.freeze({
								execute: execOptions => {
									const ok = baseAction.execute(execOptions);
									if (ok) {
										tapActionExecute(this.adapter, execOptions);
									}
									return ok;
								},
							})
						: null;
				const handle = MsgEngage.registerEngage(regId, decoratedHandler, {
					msgIngest: this.msgStore.msgIngest,
					msgNotify: this.msgStore.msgNotify,
					adapter: this.adapter,
					msgConstants: this.msgStore?.msgConstants,
					store: this.msgStore,
					action: wrappedAction,
					log: this.adapter?.log,
				});
				this._engageHandles.set(regId, handle);

				this.adapter?.log?.info?.(`IoPlugins: registered '${category}/${regId}'`);
				await this._setPluginStatus({ type, instanceId }, 'running');
			} catch (e) {
				this._registered[category].delete(regId);
				await this._setPluginStatus({ type, instanceId }, 'error');
				this._releaseMessageboxHandler(regId);
				try {
					this._engageHandles.get(regId)?.unregister?.();
				} catch {
					// swallow (best-effort)
				} finally {
					this._engageHandles.delete(regId);
				}
				throw e;
			}
		}
	}

	/**
	 * Unregister exactly one plugin instance if registered.
	 *
	 * Notes
	 * - Unregister is best-effort; plugin hosts are expected to be robust (see `src/MsgIngest.js` / `src/MsgNotify.js`).
	 *
	 * @param {{ category: string, type: string, instanceId: number }} instance Plugin instance info.
	 * @returns {Promise<void>} Resolves after unregistering (or when it was not registered).
	 */
	async _unregisterOne({ category, type, instanceId }) {
		const regId = this._makeRegistrationId({ type, instanceId });
		if (!this._registered[category]?.has(regId)) {
			return;
		}

		await this._setPluginStatus({ type, instanceId }, 'stopping');
		this.adapter?.log?.debug?.(`IoPlugins: unregistering '${category}/${regId}'`);
		if (category === IoPluginsCategories.ingest) {
			this.msgStore.msgIngest.unregisterPlugin(regId);
		} else if (category === IoPluginsCategories.notify) {
			this.msgStore.msgNotify.unregisterPlugin(regId);
		} else if (category === IoPluginsCategories.bridge) {
			try {
				this._bridgeHandles.get(regId)?.unregister?.();
			} finally {
				this._bridgeHandles.delete(regId);
			}
		} else if (category === IoPluginsCategories.engage) {
			try {
				this._releaseMessageboxHandler(regId);
				this._engageHandles.get(regId)?.unregister?.();
			} finally {
				this._engageHandles.delete(regId);
			}
		}
		await this._managedMeta.clearWatchlist({ type, instanceId });
		this._registered[category].delete(regId);
		this.adapter?.log?.info?.(`IoPlugins: unregistered '${category}/${regId}'`);
		await this._setPluginStatus({ type, instanceId }, 'stopped');
	}

	/**
	 * Apply a desired enable-state to a managed plugin instance.
	 *
	 * Implementation detail
	 * - This method is called from the serialized operation queue only.
	 * - It updates the stored state (`ack: true`) after register/unregister so the persisted value matches runtime.
	 *
	 * @param {{ category: string, type: string, instanceId: number, enabledStateId: string, enabled: boolean }} info
	 *   Plugin instance info (mutated in-place: `enabled`).
	 * @param {boolean} desired Desired enable status.
	 * @param {string} fullId Full id of the toggled state.
	 * @returns {Promise<void>} Resolves when the runtime and persisted enable state are updated.
	 */
	async _applyEnableToggle(info, desired, fullId) {
		const regId = this._makeRegistrationId({ type: info.type, instanceId: info.instanceId });
		if (desired) {
			this.adapter?.log?.debug?.(`IoPlugins: enabling '${info.category}/${regId}' via state '${fullId}'`);
			await this._registerOne(info);
		} else {
			this.adapter?.log?.debug?.(`IoPlugins: disabling '${info.category}/${regId}' via state '${fullId}'`);
			await this._unregisterOne(info);
		}

		await this._setStateAckAsync(info.enabledStateId, desired);
		info.enabled = desired;
	}

	/**
	 * Convert a full id (`msghub.0.X`) into an own id (`X`) when it belongs to this adapter namespace.
	 * Leaves already-own ids unchanged.
	 *
	 * @param {string} fullOrOwnId Full id (with namespace) or already-own id.
	 * @returns {string|null} Own id when the namespace matches, otherwise `null`.
	 */
	_toOwnId(fullOrOwnId) {
		const ns = typeof this.adapter?.namespace === 'string' ? this.adapter.namespace.trim() : '';
		const id = typeof fullOrOwnId === 'string' ? fullOrOwnId.trim() : '';
		if (!ns || !id) {
			return null;
		}
		const prefix = `${ns}.`;
		return id.startsWith(prefix) ? id.slice(prefix.length) : id;
	}

	/**
	 * Convert an own id (`X`) into a full id (`msghub.0.X`) for this adapter namespace.
	 * Leaves full ids unchanged.
	 *
	 * @param {string} ownOrFullId Own id (without namespace) or already-full id.
	 * @returns {string} Full id (always includes the adapter namespace).
	 */
	_toFullId(ownOrFullId) {
		const ns = typeof this.adapter?.namespace === 'string' ? this.adapter.namespace.trim() : '';
		const id = typeof ownOrFullId === 'string' ? ownOrFullId.trim() : '';
		if (!ns || !id) {
			throw new Error('IoPlugins._toFullId: adapter namespace and id are required');
		}
		const prefix = `${ns}.`;
		return id.startsWith(prefix) ? id : `${ns}.${id}`;
	}

	/**
	 * Determine the expected type prefix for a category (consistency guard).
	 *
	 * @param {string} category Category key.
	 * @returns {string|null} Expected prefix or `null` when unknown.
	 */
	static _expectedPrefixForCategory(category) {
		if (category === IoPluginsCategories.ingest) {
			return 'Ingest';
		}
		if (category === IoPluginsCategories.notify) {
			return 'Notify';
		}
		if (category === IoPluginsCategories.bridge) {
			return 'Bridge';
		}
		if (category === IoPluginsCategories.engage) {
			return 'Engage';
		}
		return null;
	}

	/**
	 * Adapter object getter wrapper (async API preferred; callback API fallback).
	 *
	 * @param {string} ownId Own object id (without namespace).
	 * @returns {Promise<ioBroker.Object | null | undefined>} Resolves with the object (or null/undefined when missing).
	 */
	async _getObjectAsync(ownId) {
		if (typeof this.adapter.getObjectAsync === 'function') {
			return this.adapter.getObjectAsync(ownId);
		}
		return new Promise(resolve => this.adapter.getObject(ownId, (err, obj) => resolve(err ? null : obj)));
	}

	/**
	 * Ensure an object exists without overwriting existing objects.
	 *
	 * @param {string} ownId Own object id (without namespace).
	 * @param {ioBroker.SettableObject} obj Object to create.
	 * @returns {Promise<void>} Resolves after ensuring the object exists.
	 */
	async _setObjectNotExistsAsync(ownId, obj) {
		if (typeof this.adapter.setObjectNotExistsAsync === 'function') {
			await this.adapter.setObjectNotExistsAsync(ownId, obj);
			return;
		}
		const existing = await this._getObjectAsync(ownId);
		if (existing) {
			return;
		}
		if (typeof this.adapter.setObjectAsync === 'function') {
			await this.adapter.setObjectAsync(ownId, obj);
			return;
		}
		return new Promise((resolve, reject) =>
			this.adapter.setObject(ownId, obj, err => (err ? reject(err) : resolve(undefined))),
		);
	}

	/**
	 * Extend an existing object (async API preferred; callback API fallback).
	 *
	 * @param {string} ownId Own object id (without namespace).
	 * @param {object} patch Extend patch.
	 * @returns {Promise<void>} Resolves after extending the object.
	 */
	async _extendObjectAsync(ownId, patch) {
		if (typeof this.adapter.extendObjectAsync === 'function') {
			await this.adapter.extendObjectAsync(ownId, patch);
			return;
		}
		return new Promise((resolve, reject) =>
			this.adapter.extendObject(ownId, patch, err => (err ? reject(err) : resolve(undefined))),
		);
	}

	/**
	 * Delete an object (async API preferred; callback API fallback).
	 *
	 * @param {string} ownId Own object id (without namespace).
	 * @returns {Promise<void>} Resolves after deleting the object.
	 */
	async _delObjectAsync(ownId) {
		if (typeof this.adapter.delObjectAsync === 'function') {
			await this.adapter.delObjectAsync(ownId);
			return;
		}
		return new Promise((resolve, reject) =>
			this.adapter.delObject(ownId, err => (err ? reject(err) : resolve(undefined))),
		);
	}

	/**
	 * Adapter state getter wrapper (async API preferred; callback API fallback).
	 *
	 * @param {string} ownId Own state id (without namespace).
	 * @returns {Promise<ioBroker.State | null | undefined>} Resolves with the state (or null/undefined when missing).
	 */
	async _getStateAsync(ownId) {
		if (typeof this.adapter.getStateAsync === 'function') {
			return this.adapter.getStateAsync(ownId);
		}
		return new Promise(resolve => this.adapter.getState(ownId, (err, state) => resolve(err ? null : state)));
	}

	/**
	 * Persist a state value as acked (`ack: true`).
	 *
	 * This is used to commit enable/disable operations and to seed initial values without triggering loops.
	 *
	 * @param {string} ownId Own state id (without namespace).
	 * @param {ioBroker.StateValue} val Value to persist.
	 * @returns {Promise<void>} Resolves after writing the acked value.
	 */
	async _setStateAckAsync(ownId, val) {
		if (typeof this.adapter.setStateAsync === 'function') {
			await this.adapter.setStateAsync(ownId, { val, ack: true });
			return;
		}
		return new Promise((resolve, reject) =>
			this.adapter.setState(ownId, { val, ack: true }, err => (err ? reject(err) : resolve(undefined))),
		);
	}

	/**
	 * Subscribe to a state id to receive state change events.
	 *
	 * @param {string} ownId Own state id (without namespace).
	 * @returns {void} No return value.
	 */
	_subscribeStates(ownId) {
		if (typeof this.adapter.subscribeStates === 'function') {
			this.adapter.subscribeStates(ownId);
		}
	}

	/**
	 * Build the stable registration id used by `MsgIngest`/`MsgNotify`.
	 *
	 * @param {{ type: string, instanceId?: number }} options Plugin registration id parts.
	 * @returns {string} Registration id (e.g. `IngestRandomChaos:0`).
	 */
	_makeRegistrationId(options) {
		const type = options?.type;
		const instanceId = options?.instanceId;
		const t = typeof type === 'string' ? type.trim() : '';
		if (!t) {
			throw new Error('IoPlugins: type is required');
		}
		const inst = instanceId === undefined ? 0 : instanceId;
		if (!Number.isFinite(inst) || Number.isNaN(inst)) {
			throw new Error('IoPlugins: instanceId must be a number');
		}
		return `${t}:${inst}`;
	}
}

module.exports = {
	IoPlugins,
	IoPluginsCategories,
	IoPluginsCatalog,
};
