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
 * ID scheme
 * - base id (own id): `<PluginType>.<instanceId>` (instance id is numeric, starting at `0`)
 * - enable id: `<PluginType>.<instanceId>.enable`
 * - status id: `<PluginType>.<instanceId>.status`
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
const { IoActionEffects } = require('./IoActionEffects');
const { IoManagedMeta } = require('./IoManagedMeta');
const { IoPluginResources } = require('./IoPluginResources');

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
		this._actionEffects = new IoActionEffects(this.adapter);
		if (!Number.isFinite(instanceId) || Number.isNaN(instanceId)) {
			throw new Error('IoPlugins: options.instanceId must be a number');
		}
		// Legacy default plugin instance id (when a single instance is auto-created).
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
		this._resourcesByRegId = new Map();

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
	 * Escape a string so it can be embedded into a RegExp literal safely.
	 *
	 * @param {string} s Raw string.
	 * @returns {string} Escaped string safe for regex construction.
	 */
	_escapeRegex(s) {
		return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/**
	 * List existing plugin instance ids by scanning the adapter's own object namespace.
	 *
	 * @param {string} type Plugin type.
	 * @returns {Promise<number[]>} Sorted list of numeric instance ids.
	 */
	async _listExistingInstanceIds(type) {
		const ns = typeof this.adapter?.namespace === 'string' ? this.adapter.namespace.trim() : '';
		const t = typeof type === 'string' ? type.trim() : '';
		if (!ns || !t) {
			return [];
		}

		// Test/sandbox fallback: some adapter mocks do not implement getObjectListAsync.
		// In that case, we can at least detect instance 0.
		if (typeof this.adapter?.getObjectListAsync !== 'function') {
			const obj0 = await this._getObjectAsync(this._getPluginBaseOwnId({ type: t, instanceId: 0 }));
			return obj0 ? [0] : [];
		}

		const prefix = `${ns}.${t}.`;
		const end = `${prefix}\u9999`;
		const re = new RegExp(`^${this._escapeRegex(ns)}\\.${this._escapeRegex(t)}\\.(\\d+)$`);

		let list;
		try {
			list = await this.adapter.getObjectListAsync({ startkey: prefix, endkey: end });
		} catch {
			return [];
		}

		const out = new Set();
		for (const row of list?.rows || []) {
			const obj = row?.value;
			if (!obj || typeof obj !== 'object') {
				continue;
			}
			const id = typeof row.id === 'string' ? row.id : obj._id;
			const m = typeof id === 'string' ? id.match(re) : null;
			if (!m) {
				continue;
			}
			const n = Number(m[1]);
			if (Number.isFinite(n)) {
				out.add(Math.trunc(n));
			}
		}

		return Array.from(out).sort((a, b) => a - b);
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
	 * Return a JSON-safe catalog (no factory functions).
	 *
	 * @returns {Array<{ category: string, type: string, label?: string, defaultEnabled?: boolean, supportsMultiple?: boolean, defaultOptions?: object, title?: any, description?: any, options?: object }>}
	 *   Catalog entries (DTO) without factory functions.
	 */
	getCatalog() {
		const out = [];
		for (const category of Object.values(IoPluginsCategories)) {
			for (const plugin of this.catalog?.[category] || []) {
				if (!plugin || typeof plugin !== 'object') {
					continue;
				}
				const defaultOptions = this._getPluginDefaultOptions(plugin);
				out.push({
					category,
					type: plugin.type,
					label: plugin.label,
					defaultEnabled: plugin.defaultEnabled === true,
					supportsMultiple: plugin.supportsMultiple === true,
					defaultOptions,
					title: plugin.title,
					description: plugin.description,
					options: isObject(plugin.options) ? plugin.options : undefined,
				});
			}
		}
		return out;
	}

	/**
	 * Legacy alias.
	 *
	 * @returns {Array<any>} Catalog.
	 */
	getAdminCatalog() {
		return this.getCatalog();
	}

	/**
	 * List existing plugin instances (from the object tree).
	 *
	 * @returns {Promise<Array<{ category: string, type: string, instanceId: number, enabled: boolean, status: string|null, native: object }>>}
	 *   Instances discovered from the object tree, including raw `native` and derived enabled/status.
	 */
	async listInstances() {
		const out = [];
		for (const category of Object.values(IoPluginsCategories)) {
			for (const plugin of this.catalog?.[category] || []) {
				if (!plugin || typeof plugin !== 'object' || !plugin.type) {
					continue;
				}
				const ids = await this._listExistingInstanceIds(plugin.type);
				const finalIds = plugin.supportsMultiple === true ? ids : ids.filter(i => i === 0);
				for (const instanceId of finalIds) {
					const baseOwnId = this._getPluginBaseOwnId({ type: plugin.type, instanceId });
					const obj = await this._getObjectAsync(baseOwnId);
					const native = obj && isObject(obj.native) ? obj.native : {};
					const enabledState = await this._getStateAsync(
						this._getPluginEnableOwnId({ type: plugin.type, instanceId }),
					);
					const statusState = await this._getStateAsync(
						this._getPluginStatusOwnId({ type: plugin.type, instanceId }),
					);
					const enabled =
						enabledState && typeof enabledState.val === 'boolean'
							? enabledState.val
							: typeof native.enabled === 'boolean'
								? native.enabled
								: plugin.defaultEnabled === true;

					out.push({
						category,
						type: plugin.type,
						instanceId,
						enabled: enabled === true,
						status: statusState && typeof statusState.val === 'string' ? statusState.val : null,
						native,
					});
				}
			}
		}
		return out;
	}

	/**
	 * Legacy alias.
	 *
	 * @returns {Promise<Array<any>>} Instances.
	 */
	async adminListInstances() {
		return await this.listInstances();
	}

	/**
	 * Find a catalog entry by plugin type.
	 *
	 * @param {string} type Plugin type.
	 * @returns {{ category: string, plugin: any } | null} Catalog entry (with its category) or null.
	 */
	_findCatalogEntryByType(type) {
		const t = typeof type === 'string' ? type.trim() : '';
		if (!t) {
			return null;
		}
		for (const category of Object.values(IoPluginsCategories)) {
			for (const plugin of this.catalog?.[category] || []) {
				if (plugin?.type === t) {
					return { category, plugin };
				}
			}
		}
		return null;
	}

	/**
	 * Create a new plugin instance with the next instance id.
	 *
	 * @param {{ category: string, type: string }} info Plugin type.
	 * @returns {Promise<{ instanceId: number }>} Created instance identity.
	 */
	async createInstance(info) {
		return await this._queue(async () => {
			const category = typeof info?.category === 'string' ? info.category.trim() : '';
			const type = typeof info?.type === 'string' ? info.type.trim() : '';
			if (!category || !type) {
				throw new Error('category/type are required');
			}
			const entry = this._findCatalogEntryByType(type);
			if (!entry || entry.category !== category) {
				throw new Error(`Unknown plugin '${category}/${type}'`);
			}
			const plugin = entry.plugin;
			const defaultOptions = this._getPluginDefaultOptions(plugin);

			const existing = await this._listExistingInstanceIds(type);
			if (plugin.supportsMultiple !== true && existing.length > 0) {
				throw new Error(`${type} does not support multiple instances`);
			}
			const nextId = existing.length > 0 ? Math.max(...existing) + 1 : 0;

			const st = await this._ensurePluginEnabledState({
				category,
				type,
				instanceId: nextId,
				initialEnabled: plugin.defaultEnabled === true,
				defaultOptions,
			});

			this._instances.push({ category, type, instanceId: nextId, ...st });
			this._controlOwnIds.add(st.enabledStateId);

			if (st.enabled) {
				await this._registerOne({ category, type, instanceId: nextId });
			}

			return { instanceId: nextId };
		});
	}

	/**
	 * Legacy alias.
	 *
	 * @param {{ category: string, type: string }} info Plugin type.
	 * @returns {Promise<{ instanceId: number }>} Created instance identity.
	 */
	async adminCreateInstance(info) {
		return await this.createInstance(info);
	}

	/**
	 * Delete a plugin instance (removes the instance object subtree and unregisters if needed).
	 *
	 * @param {{ type: string, instanceId: number }} info Instance identity.
	 * @returns {Promise<void>}
	 */
	async deleteInstance(info) {
		return await this._queue(async () => {
			const type = typeof info?.type === 'string' ? info.type.trim() : '';
			const instanceId = Number.isFinite(info?.instanceId) ? Math.trunc(info.instanceId) : NaN;
			if (!type || !Number.isFinite(instanceId)) {
				throw new Error('type/instanceId are required');
			}

			const entry = this._findCatalogEntryByType(type);
			if (!entry) {
				throw new Error(`Unknown plugin type '${type}'`);
			}
			const category = entry.category;

			const inst =
				this._instances.find(i => i.type === type && i.instanceId === instanceId) ||
				(() => {
					const enabledStateId = this._getPluginEnableOwnId({ type, instanceId });
					const statusStateId = this._getPluginStatusOwnId({ type, instanceId });
					return {
						category,
						type,
						instanceId,
						baseObjectId: this._getPluginBaseOwnId({ type, instanceId }),
						baseObjectIdFull: this._toFullId(this._getPluginBaseOwnId({ type, instanceId })),
						enabledStateId,
						enabledStateIdFull: this._toFullId(enabledStateId),
						statusStateId,
						statusStateIdFull: this._toFullId(statusStateId),
						enabled: false,
					};
				})();

			try {
				await this._unregisterOne(inst);
			} catch {
				// swallow (best-effort)
			}

			await this.adapter.delObjectAsync(this._getPluginBaseOwnId({ type, instanceId }), { recursive: true });

			this._instances = this._instances.filter(i => !(i.type === type && i.instanceId === instanceId));
			this._controlOwnIds.delete(this._getPluginEnableOwnId({ type, instanceId }));
		});
	}

	/**
	 * Update a plugin instance's `native` options.
	 *
	 * @param {{ type: string, instanceId: number, nativePatch: object }} info Update request.
	 * @returns {Promise<void>}
	 */
	async updateInstanceNative(info) {
		return await this._queue(async () => {
			const type = typeof info?.type === 'string' ? info.type.trim() : '';
			const instanceId = Number.isFinite(info?.instanceId) ? Math.trunc(info.instanceId) : NaN;
			const nativePatch = isObject(info?.nativePatch) ? info.nativePatch : null;
			if (!type || !Number.isFinite(instanceId) || !nativePatch) {
				throw new Error('type/instanceId/nativePatch are required');
			}

			const baseOwnId = this._getPluginBaseOwnId({ type, instanceId });
			const obj = await this._getObjectAsync(baseOwnId);
			const currentNative = obj && isObject(obj.native) ? obj.native : {};
			const nextNative = { ...currentNative };
			for (const [k, v] of Object.entries(nativePatch)) {
				if (v === undefined || v === null) {
					delete nextNative[k];
				} else {
					nextNative[k] = v;
				}
			}

			await this._extendObjectAsync(baseOwnId, { native: nextNative });

			// Apply changes to running instance (restart single plugin instance, no adapter restart).
			const inst = this._instances.find(i => i.type === type && i.instanceId === instanceId);
			if (inst && inst.enabled) {
				await this._unregisterOne(inst);
				await this._registerOne(inst);
			}
		});
	}

	/**
	 * Legacy alias.
	 *
	 * @param {{ type: string, instanceId: number, nativePatch: object }} info Update request.
	 * @returns {Promise<void>}
	 */
	async adminUpdateInstance(info) {
		return await this.updateInstanceNative(info);
	}

	/**
	 * Set enabled/disabled state for a plugin instance.
	 *
	 * @param {{ type: string, instanceId: number, enabled: boolean }} info Enable request.
	 * @returns {Promise<void>}
	 */
	async setInstanceEnabled(info) {
		return await this._queue(async () => {
			const type = typeof info?.type === 'string' ? info.type.trim() : '';
			const instanceId = Number.isFinite(info?.instanceId) ? Math.trunc(info.instanceId) : NaN;
			const desired = info?.enabled === true;
			if (!type || !Number.isFinite(instanceId)) {
				throw new Error('type/instanceId are required');
			}

			const entry = this._findCatalogEntryByType(type);
			if (!entry) {
				throw new Error(`Unknown plugin type '${type}'`);
			}
			const category = entry.category;
			const plugin = entry.plugin;
			const defaultOptions = this._getPluginDefaultOptions(plugin);

			let inst = this._instances.find(i => i.type === type && i.instanceId === instanceId);
			if (!inst) {
				const st = await this._ensurePluginEnabledState({
					category,
					type,
					instanceId,
					initialEnabled: desired,
					defaultOptions,
				});
				inst = { category, type, instanceId, ...st };
				this._instances.push(inst);
				this._controlOwnIds.add(st.enabledStateId);
			}

			await this._applyEnableToggle(inst, desired, this._toFullId(inst.enabledStateId));
		});
	}

	/**
	 * Legacy alias.
	 *
	 * @param {{ type: string, instanceId: number, enabled: boolean }} info Enable request.
	 * @returns {Promise<void>}
	 */
	async adminSetEnabled(info) {
		return await this.setInstanceEnabled(info);
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

		const initOne = async (category, plugin) => {
			const defaultOptions = this._getPluginDefaultOptions(plugin);
			const ids = await this._listExistingInstanceIds(plugin.type);
			const existingIds = plugin.supportsMultiple === true ? ids : ids.filter(i => i === 0);

			// Backwards-compatible behavior:
			// - If no instances exist yet, create instance 0 for plugins that are enabled by default.
			const desiredIds =
				existingIds.length > 0 ? existingIds : plugin.defaultEnabled === true ? [this.instanceId] : [];

			const expectedPrefix = IoPlugins._expectedPrefixForCategory(category);
			if (expectedPrefix && !String(plugin.type || '').startsWith(expectedPrefix)) {
				throw new Error(
					`IoPlugins: type '${plugin.type}' must start with '${expectedPrefix}' for category '${category}'`,
				);
			}

			for (const instanceId of desiredIds) {
				const st = await this._ensurePluginEnabledState({
					category,
					type: plugin.type,
					instanceId,
					initialEnabled: plugin.defaultEnabled === true,
					defaultOptions,
				});
				instances.push({
					category,
					type: plugin.type,
					instanceId,
					...st,
				});
			}
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
	 * @param {number} options.instanceId Numeric instance id (starts at `0`).
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
		const desiredEnabledFromNative =
			existingNative && typeof existingNative.enabled === 'boolean' ? existingNative.enabled : undefined;
		const desiredEnabled =
			desiredEnabledFromNative !== undefined ? desiredEnabledFromNative : initialEnabled === true;

		// Ensure base object exists for options storage (`native`).
		await this._setObjectNotExistsAsync(baseObjectId, {
			type: 'channel',
			common: {
				name: baseName,
				role: 'folder',
			},
			native: { ...(isObject(defaultOptions) ? defaultOptions : {}), enabled: desiredEnabled },
		});

		// Best-effort upgrade: keep name and merge native defaults with existing native.
		if (existingBase && (typeof existingBase?.common?.name === 'string' || existingNative)) {
			try {
				await this._extendObjectAsync(baseObjectId, {
					common: { ...(existingBase.common || {}), name: baseName },
					native: existingNative
						? {
								...(isObject(defaultOptions) ? defaultOptions : {}),
								enabled: desiredEnabled,
								...existingNative,
							}
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
		// - otherwise seed from base-object `native.enabled`
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

		const seeded = desiredEnabled === true ? true : false;
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
		const merged = {
			...(isObject(defaultOptions) ? defaultOptions : {}),
			...(isObject(native) ? native : {}),
		};
		// Reserved meta keys (not forwarded to plugin factories).
		delete merged.enabled;
		delete merged.instances;
		return merged;
	}

	/**
	 * Build the stable per-plugin meta object injected into `ctx.meta.plugin` for every plugin call.
	 *
	 * @param {{ category: string, type: string, instanceId: number, regId: string, pluginBaseObjectId: string, manifest: object }} info
	 *   Plugin identity.
	 * @returns {{ category: string, type: string, instanceId: number, regId: string, baseFullId: string, baseOwnId: string, manifest: object }}
	 *   Stable meta injected into `ctx.meta.plugin`.
	 */
	_buildPluginMeta({ category, type, instanceId, regId, pluginBaseObjectId, manifest }) {
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
		const mf = isObject(manifest) ? manifest : Object.freeze({ schemaVersion: 1, type: t, options: {} });
		return Object.freeze({
			category: cat,
			type: t,
			instanceId: inst,
			regId: rid,
			baseFullId,
			baseOwnId,
			manifest: mf,
		});
	}

	/**
	 * Create a fresh per-plugin resource tracker.
	 *
	 * If a previous tracker exists for the same registration id, it is disposed best-effort first.
	 *
	 * @param {string} regId Plugin registration id (e.g. `NotifyStates:0`).
	 * @returns {import('./IoPluginResources').IoPluginResources|null} Resource tracker (or null for invalid regIds).
	 */
	_createResources(regId) {
		const rid = typeof regId === 'string' ? regId.trim() : '';
		if (!rid) {
			return null;
		}
		const existing = this._resourcesByRegId.get(rid);
		if (existing) {
			try {
				existing.disposeAll?.();
			} catch {
				// swallow (best-effort)
			} finally {
				this._resourcesByRegId.delete(rid);
			}
		}
		const resources = new IoPluginResources({ regId: rid, log: this.adapter?.log });
		this._resourcesByRegId.set(rid, resources);
		return resources;
	}

	/**
	 * Dispose and forget a per-plugin resource tracker (best-effort).
	 *
	 * @param {string} regId Plugin registration id.
	 * @returns {void}
	 */
	_disposeResources(regId) {
		const rid = typeof regId === 'string' ? regId.trim() : '';
		if (!rid) {
			return;
		}
		const resources = this._resourcesByRegId.get(rid);
		if (!resources) {
			return;
		}
		try {
			resources.disposeAll?.();
		} catch {
			// swallow (best-effort)
		} finally {
			this._resourcesByRegId.delete(rid);
		}
	}

	/**
	 * Decorate a plugin ctx object with stable IoPlugins metadata and helpers.
	 *
	 * - injects `ctx.meta.plugin` (identity), `ctx.meta.options` (manifest-backed resolvers), `ctx.meta.resources`
	 * - wraps `ctx.api.iobroker.subscribe.*` to auto-track subscriptions (when available)
	 *
	 * @param {any} baseCtx Raw ctx passed by the host.
	 * @param {object} [options] Decoration options.
	 * @param {object} options.pluginMeta Stable plugin identity injected into `ctx.meta.plugin`.
	 * @param {object} options.optionsApi Stable options API injected into `ctx.meta.options`.
	 * @param {import('./IoPluginResources').IoPluginResources|null} options.resources Per-plugin resource tracker.
	 * @param {{ report: Function, applyReported: Function }|null} [options.managedObjects] Optional managed meta reporter.
	 * @returns {object} Decorated ctx.
	 */
	_decorateCtxForPlugin(
		baseCtx,
		{ pluginMeta, optionsApi, resources, managedObjects } = {
			pluginMeta: undefined,
			optionsApi: undefined,
			resources: null,
			managedObjects: null,
		},
	) {
		const base = baseCtx && typeof baseCtx === 'object' ? baseCtx : {};
		const meta = base.meta && typeof base.meta === 'object' ? base.meta : {};
		const api = base.api && typeof base.api === 'object' ? base.api : null;

		let nextApi = api;
		if (resources && api?.iobroker && typeof api.iobroker === 'object') {
			const broker = api.iobroker;
			const subscribe = broker.subscribe;
			const wrappedSubscribe = resources.wrapSubscribeApi(subscribe);
			if (wrappedSubscribe && wrappedSubscribe !== subscribe) {
				const nextBroker = Object.freeze({ ...broker, subscribe: wrappedSubscribe });
				nextApi = Object.freeze({ ...api, iobroker: nextBroker });
			}
		}

		// Optional: bind per-plugin identity into ctx.api.ai (rate limiting / caching partition).
		if (nextApi?.ai && typeof nextApi.ai === 'object' && typeof nextApi.ai.__bindCaller === 'function') {
			try {
				const boundAi = nextApi.ai.__bindCaller(pluginMeta);
				if (boundAi && boundAi !== nextApi.ai) {
					nextApi = Object.freeze({ ...nextApi, ai: boundAi });
				}
			} catch (e) {
				this.adapter?.log?.warn?.(`IoPlugins: failed to bind ctx.api.ai (${e?.message || e})`);
			}
		}

		const nextMeta = Object.freeze({
			...meta,
			...(managedObjects ? { managedObjects } : {}),
			plugin: pluginMeta,
			options: optionsApi,
			resources,
		});

		return Object.freeze({ ...base, ...(nextApi && nextApi !== api ? { api: nextApi } : {}), meta: nextMeta });
	}

	/**
	 * Wrap an ingest plugin handler to inject the per-plugin managed meta reporter into `ctx.meta.managedObjects`.
	 *
	 * @param {any} handler Plugin handler instance (function or object with lifecycle methods).
	 * @param {{ report: Function, applyReported: Function }} reporter Managed meta reporter.
	 * @param {object} pluginMeta Stable per-plugin meta injected into `ctx.meta.plugin`.
	 * @param {object} optionsApi Stable options API injected into `ctx.meta.options`.
	 * @param {import('./IoPluginResources').IoPluginResources|null} resources Per-plugin resource tracker.
	 * @returns {any} Wrapped handler (object with start/stop/onStateChange/onObjectChange), or the original handler when empty.
	 */
	_wrapIngestHandlerWithManagedMeta(handler, reporter, pluginMeta, optionsApi, resources) {
		const start = typeof handler?.start === 'function' ? handler.start.bind(handler) : null;
		const stop = typeof handler?.stop === 'function' ? handler.stop.bind(handler) : null;
		const onStateChange =
			typeof handler === 'function'
				? handler
				: typeof handler?.onStateChange === 'function'
					? handler.onStateChange.bind(handler)
					: null;
		const onObjectChange =
			typeof handler?.onObjectChange === 'function' ? handler.onObjectChange.bind(handler) : null;

		const hasAny = !!(start || stop || onStateChange || onObjectChange);
		if (!hasAny) {
			return handler;
		}

		const inject = ctx =>
			this._decorateCtxForPlugin(ctx, {
				pluginMeta,
				optionsApi,
				resources,
				managedObjects: reporter,
			});

		return Object.freeze({
			...(start
				? {
						start: ctx => start(inject(ctx)),
					}
				: {}),
			stop: ctx => {
				try {
					stop?.(inject(ctx));
				} finally {
					resources?.disposeAll?.();
				}
			},
			...(onStateChange
				? {
						onStateChange: (id, state, ctx) => onStateChange(id, state, inject(ctx)),
					}
				: {}),
			...(onObjectChange
				? {
						onObjectChange: (id, obj, ctx) => onObjectChange(id, obj, inject(ctx)),
					}
				: {}),
		});
	}

	/**
	 * Wrap a notify plugin handler to inject stable per-plugin info into `ctx.meta.plugin`.
	 *
	 * @param {any} handler Plugin handler instance (function or object with lifecycle methods).
	 * @param {object} pluginMeta Stable per-plugin meta injected into `ctx.meta.plugin`.
	 * @param {object} optionsApi Stable options API injected into `ctx.meta.options`.
	 * @param {import('./IoPluginResources').IoPluginResources|null} resources Per-plugin resource tracker.
	 * @returns {any} Wrapped handler (object with start/stop/onNotifications), or the original handler when invalid.
	 */
	_wrapNotifyHandlerWithPluginMeta(handler, pluginMeta, optionsApi, resources) {
		const start = typeof handler?.start === 'function' ? handler.start.bind(handler) : null;
		const stop = typeof handler?.stop === 'function' ? handler.stop.bind(handler) : null;
		const onNotifications =
			typeof handler === 'function'
				? handler
				: typeof handler?.onNotifications === 'function'
					? handler.onNotifications.bind(handler)
					: null;

		if (!onNotifications) {
			return handler;
		}

		const inject = ctx =>
			this._decorateCtxForPlugin(ctx, {
				pluginMeta,
				optionsApi,
				resources,
			});

		return Object.freeze({
			...(start
				? {
						start: ctx => start(inject(ctx)),
					}
				: {}),
			stop: ctx => {
				try {
					stop?.(inject(ctx));
				} finally {
					resources?.disposeAll?.();
				}
			},
			onNotifications: (event, notifications, ctx) => onNotifications?.(event, notifications, inject(ctx)),
		});
	}

	/**
	 * Wrap a bridge/engage handler object to inject stable per-plugin info into `ctx.meta.plugin`.
	 *
	 * @param {any} handler Plugin handler instance (expected object; functions are passed through).
	 * @param {object} pluginMeta Stable per-plugin meta injected into `ctx.meta.plugin`.
	 * @param {object} optionsApi Stable options API injected into `ctx.meta.options`.
	 * @param {import('./IoPluginResources').IoPluginResources|null} resources Per-plugin resource tracker.
	 * @param {{ report: Function, applyReported: Function }|null} managedObjects Optional managed meta reporter (exposed as `ctx.meta.managedObjects`).
	 * @returns {any} Wrapped handler.
	 */
	_wrapBridgeOrEngageHandlerWithPluginMeta(handler, pluginMeta, optionsApi, resources, managedObjects = null) {
		if (!handler || typeof handler !== 'object') {
			return handler;
		}

		const start = typeof handler?.start === 'function' ? handler.start.bind(handler) : null;
		const stop = typeof handler?.stop === 'function' ? handler.stop.bind(handler) : null;
		const onStateChange = typeof handler?.onStateChange === 'function' ? handler.onStateChange.bind(handler) : null;
		const onObjectChange =
			typeof handler?.onObjectChange === 'function' ? handler.onObjectChange.bind(handler) : null;
		const onNotifications =
			typeof handler?.onNotifications === 'function' ? handler.onNotifications.bind(handler) : null;

		const inject = ctx =>
			this._decorateCtxForPlugin(ctx, {
				pluginMeta,
				optionsApi,
				resources,
				managedObjects,
			});

		return Object.freeze({
			...(start
				? {
						start: ctx => start(inject(ctx)),
					}
				: {}),
			stop: ctx => {
				try {
					stop?.(inject(ctx));
				} finally {
					resources?.disposeAll?.();
				}
			},
			...(onStateChange
				? {
						onStateChange: (id, state, ctx) => onStateChange(id, state, inject(ctx)),
					}
				: {}),
			...(onObjectChange
				? {
						onObjectChange: (id, obj, ctx) => onObjectChange(id, obj, inject(ctx)),
					}
				: {}),
			...(onNotifications
				? {
						onNotifications: (event, notifications, ctx) =>
							onNotifications(event, notifications, inject(ctx)),
					}
				: {}),
		});
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
			const defaultOptions = this._getPluginDefaultOptions(plugin);

			const regId = this._makeRegistrationId({ type, instanceId });
			if (this._registered[category].has(regId)) {
				return;
			}
			this._registered[category].add(regId);
			await this._setPluginStatus({ type, instanceId }, 'starting');

			const pluginBaseObjectId = this._toFullId(`${type}.${instanceId}`);
			const options = await this._loadPluginOptions({ type, instanceId, defaultOptions });
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
					manifest: this.buildManifestFromCatalogEntry(plugin),
				});
				const optionsApi = this.createOptionsApi(pluginMeta.manifest);
				const resources = this._createResources(regId);
				const reporter = this._managedMeta.createReporter({
					category,
					type,
					instanceId,
					pluginBaseObjectId,
				});
				const handler = plugin.create(optionsWithBase);
				this.msgStore.msgIngest.registerPlugin(
					regId,
					this._wrapIngestHandlerWithManagedMeta(handler, reporter, pluginMeta, optionsApi, resources),
				);
				this.adapter?.log?.info?.(`IoPlugins: registered '${category}/${regId}'`);
				await this._setPluginStatus({ type, instanceId }, 'running');
			} catch (e) {
				this._registered[category].delete(regId);
				this._disposeResources(regId);
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
			const defaultOptions = this._getPluginDefaultOptions(plugin);

			const regId = this._makeRegistrationId({ type, instanceId });
			if (this._registered[category].has(regId)) {
				return;
			}
			this._registered[category].add(regId);
			await this._setPluginStatus({ type, instanceId }, 'starting');

			const pluginBaseObjectId = this._toFullId(`${type}.${instanceId}`);
			const options = await this._loadPluginOptions({ type, instanceId, defaultOptions });
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
					manifest: this.buildManifestFromCatalogEntry(plugin),
				});
				const optionsApi = this.createOptionsApi(pluginMeta.manifest);
				const resources = this._createResources(regId);
				const handler = plugin.create(optionsWithBase);
				this.msgStore.msgNotify.registerPlugin(
					regId,
					this._wrapNotifyHandlerWithPluginMeta(handler, pluginMeta, optionsApi, resources),
				);
				this.adapter?.log?.info?.(`IoPlugins: registered '${category}/${regId}'`);
				await this._setPluginStatus({ type, instanceId }, 'running');
			} catch (e) {
				this._registered[category].delete(regId);
				this._disposeResources(regId);
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
			const defaultOptions = this._getPluginDefaultOptions(plugin);

			const regId = this._makeRegistrationId({ type, instanceId });
			if (this._registered[category].has(regId)) {
				return;
			}
			this._registered[category].add(regId);
			await this._setPluginStatus({ type, instanceId }, 'starting');

			const pluginBaseObjectId = this._toFullId(`${type}.${instanceId}`);
			const options = await this._loadPluginOptions({ type, instanceId, defaultOptions });
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
					manifest: this.buildManifestFromCatalogEntry(plugin),
				});
				const optionsApi = this.createOptionsApi(pluginMeta.manifest);
				const resources = this._createResources(regId);
				const reporter = this._managedMeta.createReporter({
					category,
					type,
					instanceId,
					pluginBaseObjectId,
				});

				const handler = plugin.create(optionsWithBase);
				const decoratedHandler = this._wrapBridgeOrEngageHandlerWithPluginMeta(
					handler,
					pluginMeta,
					optionsApi,
					resources,
					reporter,
				);
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
				this._disposeResources(regId);
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
			const defaultOptions = this._getPluginDefaultOptions(plugin);

			const regId = this._makeRegistrationId({ type, instanceId });
			if (this._registered[category].has(regId)) {
				return;
			}
			this._registered[category].add(regId);
			await this._setPluginStatus({ type, instanceId }, 'starting');

			const pluginBaseObjectId = this._toFullId(`${type}.${instanceId}`);
			const options = await this._loadPluginOptions({ type, instanceId, defaultOptions });
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
					manifest: this.buildManifestFromCatalogEntry(plugin),
				});
				const optionsApi = this.createOptionsApi(pluginMeta.manifest);
				const resources = this._createResources(regId);
				const reporter = this._managedMeta.createReporter({
					category,
					type,
					instanceId,
					pluginBaseObjectId,
				});

				const handler = plugin.create(optionsWithBase);
				const decoratedHandler = this._wrapBridgeOrEngageHandlerWithPluginMeta(
					handler,
					pluginMeta,
					optionsApi,
					resources,
					reporter,
				);
				const baseAction = buildActionApi(this.adapter, this.msgStore?.msgConstants, this.msgStore, {
					hostName: 'MsgEngage',
				});
				const wrappedAction =
					baseAction && typeof baseAction.execute === 'function'
						? Object.freeze({
								execute: execOptions => {
									const ok = baseAction.execute(execOptions);
									if (ok) {
										this._actionEffects?.tapActionExecute(execOptions);
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
				this._disposeResources(regId);
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
	 * Build a shallow default-options object for a catalog entry.
	 *
	 * Compatibility
	 * - Legacy plugins define `defaultOptions` directly.
	 * - New-style manifests define `options.<key>.default` and have no `defaultOptions`.
	 *
	 * @param {any} plugin Catalog entry.
	 * @returns {object} Default options.
	 */
	_getPluginDefaultOptions(plugin) {
		if (isObject(plugin?.defaultOptions)) {
			return { ...plugin.defaultOptions };
		}
		if (!isObject(plugin?.options)) {
			return {};
		}
		const out = {};
		for (const [key, spec] of Object.entries(plugin.options)) {
			if (!key) {
				continue;
			}
			if (spec && typeof spec === 'object' && spec.type === 'header') {
				continue;
			}
			if (spec && typeof spec === 'object' && Object.prototype.hasOwnProperty.call(spec, 'default')) {
				const v = spec.default;
				if (v !== undefined) {
					out[key] = v;
				}
			}
		}
		return out;
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
		this._disposeResources(regId);
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
		// Keep `native.enabled` in sync so Admin Tab can show the desired enable state as config, too.
		try {
			await this._extendObjectAsync(this._getPluginBaseOwnId({ type: info.type, instanceId: info.instanceId }), {
				native: { enabled: desired },
			});
		} catch {
			// swallow (best-effort)
		}
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

	/**
	 * Normalize a string key used for manifest lookups.
	 *
	 * @param {unknown} key Raw key value.
	 * @returns {string} Trimmed key or empty string.
	 */
	_toKey(key) {
		return typeof key === 'string' ? key.trim() : '';
	}

	/**
	 * Convert a value to a finite integer if possible.
	 *
	 * @param {unknown} val Input value.
	 * @returns {number|undefined} Finite integer or `undefined` if not convertible.
	 */
	_toFiniteIntOrUndefined(val) {
		const n = typeof val === 'number' ? val : typeof val === 'string' && val.trim() !== '' ? Number(val) : NaN;
		return Number.isFinite(n) ? Math.trunc(n) : undefined;
	}

	/**
	 * Convert a value to a finite integer, with fallback.
	 *
	 * @param {unknown} val Input value.
	 * @param {number} fallback Fallback value when conversion fails.
	 * @returns {number} Converted integer or fallback.
	 */
	_toFiniteInt(val, fallback) {
		const n = this._toFiniteIntOrUndefined(val);
		return n === undefined ? fallback : n;
	}

	/**
	 * Create a manifest-bound options API for a plugin instance.
	 *
	 * @param {any} manifest Plugin manifest (expects `manifest.options`).
	 * @returns {{ resolveInt: Function, resolveString: Function, resolveBool: Function }} Options API.
	 */
	createOptionsApi(manifest) {
		const getSpec = key => {
			const k = this._toKey(key);
			if (!k) {
				return null;
			}
			const spec = manifest?.options?.[k];
			return spec && typeof spec === 'object' ? spec : null;
		};

		const resolveInt = (key, val) => {
			const spec = getSpec(key) || {};
			const def = this._toFiniteInt(spec.default, 0);
			let out = this._toFiniteInt(val, def);
			const min = this._toFiniteIntOrUndefined(spec.min);
			const max = this._toFiniteIntOrUndefined(spec.max);
			if (min !== undefined) {
				out = Math.max(min, out);
			}
			if (max !== undefined) {
				out = Math.min(max, out);
			}
			return out;
		};

		const resolveBool = (key, val) => {
			const spec = getSpec(key) || {};
			const def = spec.default === true;
			if (val === true) {
				return true;
			}
			if (val === false) {
				return false;
			}
			return def;
		};

		const resolveString = (key, val) => {
			const spec = getSpec(key) || {};
			const def = typeof spec.default === 'string' ? spec.default : '';
			if (val === undefined || val === null) {
				return String(def).trim();
			}
			if (typeof val !== 'string') {
				return String(def).trim();
			}
			// Always trim (prevents trivial whitespace tricks; no further normalization by design).
			return val.trim();
		};

		return Object.freeze({ resolveInt, resolveString, resolveBool });
	}

	/**
	 * Build a manifest-like object from a catalog entry.
	 *
	 * @param {any} plugin Catalog entry.
	 * @returns {object} Manifest.
	 */
	buildManifestFromCatalogEntry(plugin) {
		const schemaVersion = Number.isFinite(plugin?.schemaVersion) ? Math.trunc(plugin.schemaVersion) : 1;
		const type = typeof plugin?.type === 'string' ? plugin.type : '';
		return Object.freeze({
			schemaVersion,
			type,
			defaultEnabled: plugin?.defaultEnabled === true,
			supportsMultiple: plugin?.supportsMultiple === true,
			title: plugin?.title,
			description: plugin?.description,
			options: isObject(plugin?.options) ? plugin.options : {},
		});
	}
}

module.exports = {
	IoPlugins,
	IoPluginsCategories,
	IoPluginsCatalog,
};
