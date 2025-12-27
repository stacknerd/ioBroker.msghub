/**
 * MsgPlugins
 * =========
 * Adapter-side plugin orchestration for MsgHub.
 *
 * Docs: ../docs/plugins/MsgPlugins.md
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
 * - No bridge logic inside plugins: bridge *wiring* is handled by `src/MsgBridge.js`, but bridge implementations still
 *   live as two handlers (ingest + notify).
 *
 * Enable/disable + config storage model
 * ------------------------------------
 * For each plugin instance we create a single ioBroker object id which serves two purposes:
 * - enable switch: state value (`boolean`)
 * - options: object `native` payload (raw JSON)
 *
 * ID scheme (today)
 * - base id (own id): `<PluginType>.0` (instance id is always numeric `0` today)
 * - full id: `<adapter.namespace>.<PluginType>.0` (e.g. `msghub.0.NotifyIoBrokerStates.0`)
 *
 * Important semantics / invariants
 * - The state value is the source of truth (persistent).
 * - Enable toggles come from ioBroker state changes (`ack: false` writes).
 * - We persist the final desired value as `ack: true` to "commit" the state.
 * - Toggle operations are serialized via `createOpQueue()` to avoid overlap/races.
 * - If the id already exists as a non-state object (legacy/accidental), we migrate by deleting and recreating as `type=state`
 *   while preserving `native` as best-effort.
 *
 * Interaction with the adapter (`main.js`)
 * ---------------------------------------
 * The adapter should call `handleStateChange(id, state)` early in its `onStateChange` handler.
 * If it returns `true`, the event was consumed as a plugin enable/disable change and must not be forwarded to ingest plugins.
 */

'use strict';

const { createOpQueue, isObject } = require(`${__dirname}/../src/MsgUtils`);
const { MsgBridge } = require(`${__dirname}/../src/MsgBridge`);
const { MsgPluginsCategories, MsgPluginsCatalog } = require('./index');

/**
 * MsgPlugins
 */
class MsgPlugins {
	/**
	 * Create a new runtime plugin orchestrator.
	 *
	 * Construction notes (similar philosophy as `MsgStore`)
	 * - The constructor performs only minimal, synchronous setup (no I/O).
	 * - Call `await init()` to ensure enable states exist and to subscribe to them.
	 * - Call `await registerEnabled()` to register all enabled plugins.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} adapter Adapter instance (ioBroker).
	 * @param {{ msgIngest: { registerPlugin: Function, unregisterPlugin: Function }, msgNotify: { registerPlugin: Function, unregisterPlugin: Function } }} msgStore
	 *   MsgStore instance (owns `msgIngest` and `msgNotify`).
	 * @param {object} [options] Optional configuration (advanced/testing).
	 * @param {number} [options.instanceId] Plugin instance id (numeric; currently always `0`).
	 * @param {typeof MsgPluginsCatalog} [options.catalog] Catalog override (defaults to `MsgPluginsCatalog` from `lib/index.js`).
	 */
	constructor(adapter, msgStore, { instanceId = 0, catalog = MsgPluginsCatalog } = {}) {
		if (!adapter?.namespace) {
			throw new Error('MsgPlugins: adapter is required');
		}
		if (!msgStore?.msgIngest || !msgStore?.msgNotify) {
			throw new Error('MsgPlugins: msgStore.msgIngest/msgNotify are required');
		}

		this.adapter = adapter;
		this.msgStore = msgStore;
		if (!Number.isFinite(instanceId) || Number.isNaN(instanceId)) {
			throw new Error('MsgPlugins: options.instanceId must be a number');
		}
		this.instanceId = instanceId;
		this.catalog = catalog || MsgPluginsCatalog;

		// Fast type lookups for wiring (avoids scanning the catalog repeatedly).
		this._ingestByType = new Map((this.catalog[MsgPluginsCategories.ingest] || []).map(p => [p.type, p]));
		this._notifyByType = new Map((this.catalog[MsgPluginsCategories.notify] || []).map(p => [p.type, p]));
		this._bridgeByType = new Map((this.catalog[MsgPluginsCategories.bridge] || []).map(p => [p.type, p]));

		this._instances = [];
		this._controlOwnIds = new Set();
		this._registered = {
			[MsgPluginsCategories.ingest]: new Set(),
			[MsgPluginsCategories.notify]: new Set(),
			[MsgPluginsCategories.bridge]: new Set(),
		};
		this._bridgeHandles = new Map();

		// Serialize enable/disable operations to prevent overlapping register/unregister sequences.
		this._queue = createOpQueue();
	}

	/**
	 * Create, initialize enable states, and register currently enabled plugins.
	 *
	 * This is the common convenience entry point for adapter startup.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} adapter Adapter instance.
	 * @param {{ msgIngest: { registerPlugin: Function, unregisterPlugin: Function }, msgNotify: { registerPlugin: Function, unregisterPlugin: Function } }} msgStore
	 *   MsgStore instance.
	 * @param {object} [options] Options forwarded to the constructor (advanced/testing).
	 * @returns {Promise<MsgPlugins>} Initialized instance.
	 */
	static async create(adapter, msgStore, options) {
		const mgr = new MsgPlugins(adapter, msgStore, options);
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
	 * - `MsgPlugins` itself does not register generic wildcard subscriptions.
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
	 * Build and ensure enable states for all catalog entries (ingest + notify + bridge).
	 *
	 * @returns {Promise<Array<object>>} List of managed plugin instances (one per catalog entry).
	 */
	async _initPluginEnableStates() {
		const instances = [];
		const instanceId = this.instanceId;

		const initOne = async (category, plugin) => {
			const expectedPrefix = MsgPlugins._expectedPrefixForCategory(category);
			if (expectedPrefix && !String(plugin.type || '').startsWith(expectedPrefix)) {
				throw new Error(
					`MsgPlugins: type '${plugin.type}' must start with '${expectedPrefix}' for category '${category}'`,
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

		for (const plugin of this.catalog[MsgPluginsCategories.ingest] || []) {
			await initOne(MsgPluginsCategories.ingest, plugin);
		}
		for (const plugin of this.catalog[MsgPluginsCategories.notify] || []) {
			await initOne(MsgPluginsCategories.notify, plugin);
		}
		for (const plugin of this.catalog[MsgPluginsCategories.bridge] || []) {
			await initOne(MsgPluginsCategories.bridge, plugin);
		}

		return instances;
	}

	/**
	 * Ensure the plugin base object exists and is a boolean state.
	 *
	 * This object is both:
	 * - the enable switch (`state.val` boolean)
	 * - the options container (`object.native` raw JSON)
	 *
	 * @param {object} options Plugin identity + initial defaults.
	 * @param {string} options.category One of `MsgPluginsCategories.*`.
	 * @param {string} options.type Plugin type.
	 * @param {number} options.instanceId Numeric instance id (today always `0`).
	 * @param {boolean} options.initialEnabled Initial enable state (only used if the state does not exist yet).
	 * @param {object} [options.defaultOptions] Default options (seeded into `native` only when the object does not exist yet).
	 * @returns {Promise<{ enabledStateId: string, enabledStateIdFull: string, enabled: boolean }>} Enable-state info.
	 */
	async _ensurePluginEnabledState({ category, type, instanceId, initialEnabled, defaultOptions }) {
		const enabledStateId = `${type}.${instanceId}`;
		const enabledStateIdFull = this._toFullId(enabledStateId);

		const displayName = `MsgHub plugin (${category}/${type}/${instanceId})`;
		const commonName = {
			en: displayName,
			de: `MsgHub Plugin (${category}/${type}/${instanceId})`,
		};

		const existingObject = await this._getObjectAsync(enabledStateId);
		const existingNative = existingObject && isObject(existingObject.native) ? existingObject.native : null;
		if (existingObject && existingObject.type !== 'state') {
			try {
				this.adapter?.log?.warn?.(
					`Plugin state migration: recreating '${enabledStateIdFull}' as type=state (was type='${existingObject.type}')`,
				);
				await this._delObjectAsync(enabledStateId);
			} catch (e) {
				throw new Error(
					`Cannot migrate plugin enable state '${enabledStateIdFull}' from type='${existingObject.type}' to state: ${e?.message || e}`,
				);
			}
		}

		await this._setObjectNotExistsAsync(enabledStateId, {
			type: 'state',
			common: {
				name: commonName,
				type: 'boolean',
				role: 'switch',
				read: true,
				write: true,
			},
			// Store plugin options in native on the same object (source of truth for options storage).
			native: isObject(defaultOptions) ? defaultOptions : {},
		});

		this._subscribeStates(enabledStateId);

		// Best-effort upgrade: keep `common.name` in multilingual object form and keep the native defaults if we migrated.
		if (existingObject && (typeof existingObject?.common?.name === 'string' || existingNative)) {
			try {
				await this._extendObjectAsync(enabledStateId, {
					common: { ...(existingObject.common || {}), name: commonName },
					native: existingNative
						? { ...(isObject(defaultOptions) ? defaultOptions : {}), ...existingNative }
						: undefined,
				});
			} catch {
				// swallow (best-effort)
			}
		}

		const existing = await this._getStateAsync(enabledStateId);
		if (existing && typeof existing.val === 'boolean') {
			return { enabledStateId, enabledStateIdFull, enabled: existing.val };
		}

		const seeded = initialEnabled === true;
		await this._setStateAckAsync(enabledStateId, seeded);
		return { enabledStateId, enabledStateIdFull, enabled: seeded };
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
		const ownId = `${type}.${instanceId}`;
		const obj = await this._getObjectAsync(ownId);
		const native = obj?.native;
		return isObject(native) ? native : isObject(defaultOptions) ? defaultOptions : {};
	}

	/**
	 * Register exactly one plugin instance if not registered yet.
	 *
	 * The plugin factory receives options merged with:
	 * - `pluginBaseObjectId` (full id), so plugins can write states relative to their own base id.
	 *
	 * @param {{ category: string, type: string, instanceId: number }} instance Plugin instance info.
	 * @returns {Promise<void>} Resolves when the plugin is registered (or already registered).
	 */
	async _registerOne({ category, type, instanceId }) {
		if (category === MsgPluginsCategories.ingest) {
			const plugin = this._ingestByType.get(type);
			if (!plugin) {
				return;
			}

			const regId = this._makeRegistrationId({ type, instanceId });
			if (this._registered[category].has(regId)) {
				return;
			}
			this._registered[category].add(regId);

			const pluginBaseObjectId = this._toFullId(`${type}.${instanceId}`);
			const options = await this._loadPluginOptions({ type, instanceId, defaultOptions: plugin.defaultOptions });
			const optionsWithBase = { ...options, pluginBaseObjectId };

			try {
				this.adapter?.log?.debug?.(`Plugin start: registering '${category}/${regId}'`);
				this.msgStore.msgIngest.registerPlugin(regId, plugin.create(this.adapter, optionsWithBase));
				this.adapter?.log?.debug?.(`Plugin start: registered '${category}/${regId}'`);
			} catch (e) {
				this._registered[category].delete(regId);
				throw e;
			}
			return;
		}

		if (category === MsgPluginsCategories.notify) {
			const plugin = this._notifyByType.get(type);
			if (!plugin) {
				return;
			}

			const regId = this._makeRegistrationId({ type, instanceId });
			if (this._registered[category].has(regId)) {
				return;
			}
			this._registered[category].add(regId);

			const pluginBaseObjectId = this._toFullId(`${type}.${instanceId}`);
			const options = await this._loadPluginOptions({ type, instanceId, defaultOptions: plugin.defaultOptions });
			const optionsWithBase = { ...options, pluginBaseObjectId };

			try {
				this.adapter?.log?.debug?.(`Plugin start: registering '${category}/${regId}'`);
				this.msgStore.msgNotify.registerPlugin(regId, plugin.create(this.adapter, optionsWithBase));
				this.adapter?.log?.debug?.(`Plugin start: registered '${category}/${regId}'`);
			} catch (e) {
				this._registered[category].delete(regId);
				throw e;
			}
			return;
		}

		if (category === MsgPluginsCategories.bridge) {
			const plugin = this._bridgeByType.get(type);
			if (!plugin) {
				return;
			}

			const regId = this._makeRegistrationId({ type, instanceId });
			if (this._registered[category].has(regId)) {
				return;
			}
			this._registered[category].add(regId);

			const pluginBaseObjectId = this._toFullId(`${type}.${instanceId}`);
			const options = await this._loadPluginOptions({ type, instanceId, defaultOptions: plugin.defaultOptions });
			const optionsWithBase = { ...options, pluginBaseObjectId };

			try {
				this.adapter?.log?.debug?.(`Plugin start: registering '${category}/${regId}'`);

				const bridge = plugin.create(this.adapter, optionsWithBase);
				const ingest = bridge?.ingest;
				const notify = bridge?.notify;
				if (!ingest || !notify) {
					throw new Error(
						`MsgPlugins: bridge '${regId}' must return { ingest, notify } from its create(adapter, options)`,
					);
				}

				const handle = MsgBridge.registerBridge({
					id: regId,
					ingestId: bridge?.ingestId,
					notifyId: bridge?.notifyId,
					msgIngest: this.msgStore.msgIngest,
					msgNotify: this.msgStore.msgNotify,
					ingest,
					notify,
					log: this.adapter?.log,
				});
				this._bridgeHandles.set(regId, handle);

				this.adapter?.log?.debug?.(`Plugin start: registered '${category}/${regId}'`);
			} catch (e) {
				this._registered[category].delete(regId);
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
	}

	/**
	 * Unregister exactly one plugin instance if registered.
	 *
	 * Notes
	 * - Unregister is best-effort; plugin hosts are expected to be robust (see `src/MsgIngest.js` / `src/MsgNotify.js`).
	 *
	 * @param {{ category: string, type: string, instanceId: number }} instance Plugin instance info.
	 * @returns {void} No return value.
	 */
	_unregisterOne({ category, type, instanceId }) {
		const regId = this._makeRegistrationId({ type, instanceId });
		if (!this._registered[category]?.has(regId)) {
			return;
		}

		this.adapter?.log?.debug?.(`Plugin stop: unregistering '${category}/${regId}'`);
		if (category === MsgPluginsCategories.ingest) {
			this.msgStore.msgIngest.unregisterPlugin(regId);
		} else if (category === MsgPluginsCategories.notify) {
			this.msgStore.msgNotify.unregisterPlugin(regId);
		} else if (category === MsgPluginsCategories.bridge) {
			try {
				this._bridgeHandles.get(regId)?.unregister?.();
			} finally {
				this._bridgeHandles.delete(regId);
			}
		}
		this._registered[category].delete(regId);
		this.adapter?.log?.debug?.(`Plugin stop: unregistered '${category}/${regId}'`);
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
			this.adapter?.log?.debug?.(`Plugin start: enabling '${info.category}/${regId}' via state '${fullId}'`);
			await this._registerOne(info);
		} else {
			this.adapter?.log?.debug?.(`Plugin stop: disabling '${info.category}/${regId}' via state '${fullId}'`);
			this._unregisterOne(info);
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
			throw new Error('MsgPlugins._toFullId: adapter namespace and id are required');
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
		if (category === MsgPluginsCategories.ingest) {
			return 'Ingest';
		}
		if (category === MsgPluginsCategories.notify) {
			return 'Notify';
		}
		if (category === MsgPluginsCategories.bridge) {
			return 'Bridge';
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
	 * @param {boolean} val Value to persist.
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
	 * @returns {string} Registration id (e.g. `IngestRandomDemo:0`).
	 */
	_makeRegistrationId(options) {
		const type = options?.type;
		const instanceId = options?.instanceId;
		const t = typeof type === 'string' ? type.trim() : '';
		if (!t) {
			throw new Error('MsgPlugins: type is required');
		}
		const inst = instanceId === undefined ? 0 : instanceId;
		if (!Number.isFinite(inst) || Number.isNaN(inst)) {
			throw new Error('MsgPlugins: instanceId must be a number');
		}
		return `${t}:${inst}`;
	}
}

module.exports = {
	MsgPlugins,
	MsgPluginsCategories,
	MsgPluginsCatalog,
};
