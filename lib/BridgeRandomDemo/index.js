/**
 * BridgeRandomDemo
 * ===============
 * Demo / template bridge plugin for MsgHub.
 *
 * Docs: ../../docs/plugins/BridgeRandomDemo.md
 *
 * Purpose
 * -------
 * This plugin demonstrates a *bidirectional* integration pattern:
 *
 * - Inbound (ioBroker → MsgHub):
 *   - Users create/update/delete ioBroker states under the plugin subtree
 *   - The plugin mirrors those changes into one MsgHub "list message" (`listItems`)
 *
 * - Outbound (MsgHub → ioBroker):
 *   - The list message is updated (e.g. by a UI, automation, or by this demo)
 *   - The plugin mirrors listItems into ioBroker states under the plugin subtree
 *
 * This is intentionally implemented as a "bridge" (ingest + notify pair), not as two separate plugins,
 * to keep shared state (caches, loop guards, queues, timers) in one place.
 *
 * Core responsibilities
 * --------------------
 * - Own exactly one MsgHub list message identified by `listRef` (derived from `options.pluginBaseObjectId`).
 * - Keep that message’s `listItems` in sync with a set of ioBroker states below:
 *   - `<pluginBaseObjectId>.<itemsChannel>.*`
 * - Prevent update loops between:
 *   - our own ioBroker writes (`ack:true`) and ingest-side `onStateChange`
 *   - our own MsgHub patches and notify-side `onNotifications`
 *
 * Design guidelines / invariants (similar in spirit to `MsgStore`)
 * ---------------------------------------------------------------
 * - Single serialization lane: all state+store mutations are funneled through `queue()` to avoid overlap/races.
 * - Minimal diffing: we keep snapshots (`cache.lastListItemsById`) to avoid no-op patches.
 * - Subtree safety: the plugin only creates/updates/deletes objects within its own subtree.
 * - Best-effort I/O: ioBroker calls (setObject/setState/delObject) are best-effort; errors are logged and swallowed.
 *
 * Data model (canonical keys)
 * --------------------------
 * - MsgHub list message:
 *   - `ref`: normalized `pluginBaseObjectId` (MsgFactory normalizes via encodeURIComponent)
 *   - `listItems[].id`: the *full ioBroker state id* (`<pluginBaseObjectId>.<itemsChannel>.<itemKey>`)
 *   - `listItems[].name`: mirrored from state value (string)
 *
 * Note: listItems are treated as the canonical "inventory" on the MsgHub side, but this plugin performs periodic
 * reconciliation to tolerate concurrent edits from other actors.
 */

'use strict';

const { createOpQueue } = require(`${__dirname}/../../src/MsgUtils`);

/**
 * Create a BridgeRandomDemo plugin instance.
 *
 * This factory is called by `MsgPlugins` and returns a bridge shape:
 * `{ ingest, notify }`.
 *
 * Runtime wiring:
 * - `ingest.*` methods are called by `MsgIngest` when the adapter forwards ioBroker events.
 * - `notify.onNotifications` is called by `MsgNotify` when MsgHub messages are due/updated/etc.
 *
 * Important: the adapter only receives events for ids it subscribes to. This plugin subscribes itself
 * to its subtree in `ingest.start()` so users can create and update states freely.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} adapter Adapter instance (ioBroker).
 * @param {object} [options] Plugin options (stored in ioBroker object `native`).
 * @param {string} [options.pluginBaseObjectId] Full object id of the plugin base object (required).
 * @param {string} [options.itemsChannel] Channel name below the base id where item states live (default: "Items").
 * @param {string} [options.listKind] Either "shoppinglist" or "inventorylist" (default: "shoppinglist").
 * @param {number} [options.listLevel] Message level (default: MsgConstants.level.notice).
 * @param {string} [options.listTitle] List message title (default: "BridgeRandomDemo (synced list)").
 * @param {string} [options.listText] List message text/description (default: "List items are synced with ioBroker states.").
 * @param {number} [options.resyncIntervalMs] Periodic full resync interval (default: 60000; 0 disables).
 * @param {number} [options.cycleIntervalMs] Interval for adding/removing the demo item (default: 15000; 0 disables).
 * @returns {{
 *   ingest: {
 *     start: (ctx: object) => void,
 *     stop: () => void,
 *     onObjectChange: (id: string, obj: ioBroker.Object|null|undefined, ctx?: object) => void,
 *     onStateChange: (id: string, state: ioBroker.State|null|undefined, ctx?: object) => void
 *   },
 *   notify: {
 *     onNotifications: (event: string, notifications: object[], ctx?: object) => void
 *   }
 * }} Bridge plugin handlers.
 */
function BridgeRandomDemo(adapter, options = {}) {
	if (!adapter) {
		throw new Error('BridgeRandomDemo: adapter is required');
	}

	// ---------------------------------------------------------------------------
	// Configuration and derived identifiers
	// ---------------------------------------------------------------------------
	const {
		pluginBaseObjectId,
		itemsChannel = 'Items',
		listKind = 'shoppinglist',
		listLevel,
		listTitle = 'BridgeRandomDemo (synced list)',
		listText = 'List items are synced with ioBroker states.',
		resyncIntervalMs = 60000,
		cycleIntervalMs = 15000,
	} = options;

	const baseFullId = typeof pluginBaseObjectId === 'string' ? pluginBaseObjectId.trim() : '';
	if (!baseFullId) {
		throw new Error('BridgeRandomDemo: options.pluginBaseObjectId is required');
	}
	const ns = typeof adapter?.namespace === 'string' ? adapter.namespace.trim() : '';
	const baseId = ns && baseFullId.startsWith(`${ns}.`) ? baseFullId.slice(ns.length + 1) : baseFullId;
	if (!baseId) {
		throw new Error('BridgeRandomDemo: invalid options.pluginBaseObjectId');
	}

	const channel = typeof itemsChannel === 'string' && itemsChannel.trim() ? itemsChannel.trim() : 'Items';
	const itemsPrefixOwn = `${baseId}.${channel}`;
	const itemsPrefixFull = `${baseFullId}.${channel}`;

	// Ref normalization in MsgFactory is encodeURIComponent(ref). For ioBroker ids this is usually a no-op,
	// but we keep the normalized form to match MsgStore keys reliably.
	const listRef = encodeURIComponent(baseFullId);
	const cycleItemKey = '_cycle';
	const cycleItemOwnId = `${itemsPrefixOwn}.${cycleItemKey}`;
	const cycleItemFullId = `${itemsPrefixFull}.${cycleItemKey}`;

	// ---------------------------------------------------------------------------
	// Shared runtime state (bridge-local)
	// ---------------------------------------------------------------------------

	/**
	 * Serialize all side-effectful operations.
	 *
	 * Why we need this:
	 * - ioBroker events can arrive back-to-back while async I/O is in flight.
	 * - notify events can overlap with ingest events (bidirectional loop potential).
	 * - The demo periodically "cycles" list items which triggers notify updates.
	 *
	 * Similar to `MsgStore`, we keep operations deterministic by funneling writes through one queue.
	 */
	const queue = createOpQueue();

	/**
	 * Local caches used for diffing and reconciliation.
	 *
	 * - `itemsByFullId`: current known inventory of item states (keyed by full id).
	 * - `lastListItemsById`: snapshot of the list message (keyed by listItem.id).
	 */
	const cache = {
		// fullId -> { name: string }
		itemsByFullId: new Map(),
		// keep a minimal snapshot of the list message for diffing (id -> item)
		lastListItemsById: new Map(),
	};

	/**
	 * Loop protection: track our own recent ack:true writes.
	 *
	 * The adapter will feed `stateChange` events back into MsgIngest even for ack:true updates.
	 * We only suppress the echo of our own writes for a short time window, keyed by own id + value.
	 */
	const ownWrites = new Map();

	let ingestCtxRef = null;
	let resyncTimer = null;
	let cycleTimer = null;

	/**
	 * Convert a full ioBroker id to an "own id" (without adapter namespace).
	 *
	 * Many ioBroker adapter APIs expect own ids for objects in the adapter namespace.
	 * For foreign ids, we keep them as-is.
	 *
	 * @param {string} fullOrOwnId Full id (e.g. "msghub.0.X") or already-own id.
	 * @returns {string|null} Own id or null when invalid.
	 */
	const toOwnId = fullOrOwnId => {
		const id = typeof fullOrOwnId === 'string' ? fullOrOwnId.trim() : '';
		if (!id) {
			return null;
		}
		const prefix = ns ? `${ns}.` : '';
		if (prefix && id.startsWith(prefix)) {
			return id.slice(prefix.length);
		}
		// Accept already-own ids.
		return id;
	};

	/**
	 * Check whether an id belongs to a list item state managed by this plugin.
	 *
	 * @param {string} id Full id.
	 * @returns {boolean} True when the id belongs to this plugin's item subtree.
	 */
	const isItemFullId = id =>
		typeof id === 'string' && (id.startsWith(`${itemsPrefixFull}.`) || id === cycleItemFullId);

	/**
	 * Normalize a state value to a list item name.
	 *
	 * @param {any} value ioBroker state value.
	 * @returns {string} Trimmed string.
	 */
	const normalizeItemName = value => {
		if (value === null || value === undefined) {
			return '';
		}
		if (typeof value === 'string') {
			return value.trim();
		}
		return String(value);
	};

	/**
	 * Read a state by own id (best-effort).
	 *
	 * @param {string} ownId Own state id (without adapter namespace).
	 * @returns {Promise<ioBroker.State|null>} Resolves with the state, or null when missing/error.
	 */
	const getStateAsync = ownId => {
		if (typeof adapter.getStateAsync === 'function') {
			return adapter.getStateAsync(ownId).then(state => state || null);
		}
		return new Promise(resolve => adapter.getState(ownId, (err, state) => resolve(err ? null : state || null)));
	};

	/**
	 * Create an object if it does not exist (best-effort).
	 *
	 * @param {string} ownId Own object id (without adapter namespace).
	 * @param {ioBroker.SettableObject} obj ioBroker object definition.
	 * @returns {Promise<void>} Resolves when the ensure operation completes.
	 */
	const setObjectNotExistsAsync = (ownId, obj) => {
		if (typeof adapter.setObjectNotExistsAsync === 'function') {
			// Some ioBroker typings return `{ id: string }` here; normalize to void for callers.
			return adapter.setObjectNotExistsAsync(ownId, obj).then(() => undefined);
		}
		return new Promise(resolve => adapter.setObjectNotExists(ownId, obj, () => resolve(undefined)));
	};

	/**
	 * Write a state value as `ack:true` and remember it for loop protection.
	 *
	 * @param {string} ownId Own state id (without adapter namespace).
	 * @param {any} val State value to write.
	 * @returns {Promise<void>} Resolves when the write completes.
	 */
	const setStateAckAsync = (ownId, val) => {
		if (typeof adapter.setStateAsync === 'function') {
			return adapter.setStateAsync(ownId, { val, ack: true }).then(() => {
				ownWrites.set(ownId, { val: normalizeItemName(val), ts: Date.now() });
			});
		}
		return new Promise(resolve =>
			adapter.setState(ownId, { val, ack: true }, () => {
				ownWrites.set(ownId, { val: normalizeItemName(val), ts: Date.now() });
				resolve(undefined);
			}),
		);
	};

	/**
	 * Delete an object by own id (best-effort).
	 *
	 * @param {string} ownId Own object id (without adapter namespace).
	 * @returns {Promise<void>} Resolves when the delete completes (best-effort).
	 */
	const delObjectAsync = ownId => {
		if (typeof adapter.delObjectAsync === 'function') {
			return adapter.delObjectAsync(ownId).then(() => undefined);
		}
		return new Promise(resolve => adapter.delObject(ownId, () => resolve(undefined)));
	};

	/**
	 * Ensure the items channel exists below the plugin subtree.
	 *
	 * This provides a stable place for users to create item states, and it makes the UI discoverable.
	 *
	 * @returns {Promise<void>} Resolves once the channel exists (best-effort).
	 */
	const ensureItemsChannel = async () => {
		await setObjectNotExistsAsync(itemsPrefixOwn, {
			type: 'channel',
			common: {
				name: {
					en: 'Synced items (user can add states here)',
					de: 'Synchronisierte Einträge (hier können States angelegt werden)',
				},
			},
			native: {},
		});
	};

	/**
	 * Ensure a concrete item state exists (string, writable) and optionally set its value.
	 *
	 * @param {string} ownId Own id of the item state.
	 * @param {string|null} name When provided, the state will be set to this value.
	 * @returns {Promise<void>}
	 */
	const ensureItemState = async (ownId, name) => {
		await ensureItemsChannel();
		await setObjectNotExistsAsync(ownId, {
			type: 'state',
			common: {
				name: ownId,
				type: 'string',
				role: 'text',
				read: true,
				write: true,
			},
			native: {},
		});
		if (typeof name === 'string') {
			await setStateAckAsync(ownId, name);
		}
	};

	/**
	 * Read the plugin's list message from the store (by ref).
	 *
	 * @param {object} ctx MsgIngest/MsgNotify context.
	 * @returns {object|null} The message object, or null when it does not exist.
	 */
	const getListMessage = ctx => ctx?.api?.store?.getMessageByRef?.(listRef);

	/**
	 * Build an id-index of `listItems` from a message.
	 *
	 * @param {object} msg MsgHub message object.
	 * @returns {Map<string, any>} Map of `listItem.id` → `listItem`.
	 */
	const indexListItems = msg =>
		new Map(
			Array.isArray(msg?.listItems)
				? msg.listItems
						.filter(it => it && typeof it === 'object' && typeof it.id === 'string')
						.map(it => [it.id, it])
				: [],
		);

	/**
	 * Refresh the cached list snapshot for diffing.
	 *
	 * @param {object} msg MsgHub list message (or patch view) to snapshot.
	 * @returns {void}
	 */
	const updateLastListSnapshot = msg => {
		cache.lastListItemsById = indexListItems(msg);
	};

	/**
	 * Resolve list kind from MsgConstants and plugin options.
	 *
	 * @param {object} constants `ctx.api.constants`
	 * @returns {string} Resolved kind value.
	 */
	const resolveListKind = constants => {
		const allowed = new Set(Object.values(constants?.kind || {}));
		if (typeof listKind === 'string' && allowed.has(listKind)) {
			return listKind;
		}
		return constants?.kind?.shoppinglist;
	};

	/**
	 * Resolve list level from MsgConstants and plugin options.
	 *
	 * @param {object} constants `ctx.api.constants`
	 * @returns {number} Resolved level value.
	 */
	const resolveListLevel = constants => {
		const numeric = Number.isFinite(Number(listLevel)) ? Number(listLevel) : undefined;
		const allowed = new Set(Object.values(constants?.level || {}));
		if (numeric !== undefined && allowed.has(numeric)) {
			return numeric;
		}
		return constants?.level?.notice;
	};

	/**
	 * Ensure the list message exists.
	 *
	 * This method is safe to call repeatedly:
	 * - If the message exists, it updates the snapshot cache and returns it.
	 * - If it does not exist, it creates it from the current state inventory cache.
	 *
	 * @param {object} ctx MsgIngest/MsgNotify context.
	 * @returns {object|null} The existing or newly created list message (or null on validation failure).
	 */
	const ensureListMessageExists = ctx => {
		const existing = getListMessage(ctx);
		if (existing) {
			updateLastListSnapshot(existing);
			return existing;
		}

		const items = Array.from(cache.itemsByFullId.entries())
			.filter(([fullId]) => isItemFullId(fullId))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([fullId, it]) => ({ id: fullId, name: it.name, checked: false }));

		const msg = ctx.api.factory.createMessage({
			ref: baseFullId,
			title: listTitle,
			text: listText,
			level: resolveListLevel(ctx.api.constants),
			kind: resolveListKind(ctx.api.constants),
			origin: { type: ctx.api.constants.origin.type.automation, system: 'BridgeRandomDemo', id: baseFullId },
			listItems: items,
		});
		if (msg) {
			ctx.api.store.addMessage(msg);
			updateLastListSnapshot(msg);
		}
		return msg;
	};

	/**
	 * Patch `listItems` on the list message.
	 *
	 * @param {object} ctx MsgIngest/MsgNotify context.
	 * @param {{ setById?: Map<string, any> | Record<string, any> | null, deleteIds?: string[] | null }} [options]
	 *   Patch options: `setById` (upsert by id) and/or `deleteIds` (delete by id).
	 * @returns {void}
	 */
	const patchListItems = (ctx, options = {}) => {
		if (!ctx?.api?.store?.updateMessage) {
			return;
		}

		const { setById = null, deleteIds = null } = options || {};

		let setPayload;
		if (setById instanceof Map) {
			setPayload = Object.fromEntries(setById);
		} else if (setById && typeof setById === 'object' && !Array.isArray(setById)) {
			setPayload = setById;
		} else {
			setPayload = undefined;
		}
		const deletePayload = Array.isArray(deleteIds) ? deleteIds : undefined;

		// Avoid no-op updates to reduce notify churn.
		const cur = cache.lastListItemsById;
		let hasChanges = false;

		if (setPayload) {
			for (const [id, patch] of Object.entries(setPayload)) {
				const existing = cur.get(id);
				const nextName = typeof patch?.name === 'string' ? patch.name : undefined;
				if (!existing || (nextName !== undefined && existing?.name !== nextName)) {
					hasChanges = true;
					break;
				}
			}
		}
		if (!hasChanges && deletePayload) {
			for (const id of deletePayload) {
				if (cur.has(id)) {
					hasChanges = true;
					break;
				}
			}
		}
		if (!hasChanges) {
			return;
		}

		ctx.api.store.updateMessage(listRef, {
			listItems: {
				set: setPayload,
				delete: deletePayload,
			},
		});

		// Refresh snapshot from store view (best-effort). This keeps our diff logic stable even when other
		// actors update the list message between our operations.
		const updated = getListMessage(ctx);
		if (updated) {
			updateLastListSnapshot(updated);
		}
	};

	/**
	 * Reconcile the MsgHub list message with the current ioBroker state inventory cache.
	 *
	 * Strategy:
	 * - Ensure the list message exists.
	 * - For every cached state, ensure a corresponding listItem exists (upsert by full id).
	 * - Remove listItems that belong to our subtree but no longer exist as states.
	 *
	 * Notes:
	 * - This is intentionally "inventory driven": the set of states is the source of truth for which items exist.
	 * - Names are still mirrored in both directions, but this function is the authority that cleans up drift.
	 *
	 * @param {object} ctx MsgIngest/MsgNotify context.
	 * @returns {Promise<void>}
	 */
	const reconcileMessageWithStateInventory = async ctx => {
		if (!ctx?.api?.store || !ctx?.api?.factory || !ctx?.api?.constants) {
			return;
		}

		ensureListMessageExists(ctx);
		const msg = getListMessage(ctx);
		const byId = indexListItems(msg);

		const desiredIds = new Set();
		for (const [fullId, it] of cache.itemsByFullId.entries()) {
			if (!isItemFullId(fullId)) {
				continue;
			}
			desiredIds.add(fullId);
			const existing = byId.get(fullId);
			const desiredName = it.name;
			const existingName = typeof existing?.name === 'string' ? existing.name : '';
			if (!existing || existingName !== desiredName) {
				const checked = typeof existing?.checked === 'boolean' ? existing.checked : false;
				const category = typeof existing?.category === 'string' ? existing.category : undefined;
				const quantity =
					existing?.quantity && typeof existing.quantity === 'object' ? existing.quantity : undefined;
				patchListItems(ctx, {
					setById: new Map([[fullId, { name: desiredName, checked, category, quantity }]]),
				});
			}
		}

		const deleteIds = [];
		for (const id of byId.keys()) {
			// Only touch items that belong to our plugin subtree. Foreign items are ignored.
			if (!isItemFullId(id)) {
				continue;
			}
			if (!desiredIds.has(id)) {
				deleteIds.push(id);
			}
		}
		if (deleteIds.length) {
			patchListItems(ctx, { deleteIds });
		}
	};

	/**
	 * Rescan the plugin subtree for item states and rebuild `cache.itemsByFullId`.
	 *
	 * Why this exists:
	 * - Users can create states manually at any time.
	 * - Object changes may be missed depending on adapter subscription details.
	 *
	 * This performs a full view query and should therefore be throttled (called on startup and periodically).
	 *
	 * @returns {Promise<void>}
	 */
	const rescanStateInventory = async () => {
		if (typeof adapter.getObjectViewAsync !== 'function') {
			return;
		}

		const startkey = `${itemsPrefixFull}.`;
		const endkey = `${itemsPrefixFull}.\u9999`;
		let res;
		try {
			res = await adapter.getObjectViewAsync('system', 'state', { startkey, endkey });
		} catch (e) {
			adapter?.log?.warn?.(`BridgeRandomDemo: rescan failed: ${e?.message || e}`);
			return;
		}

		const next = new Map();
		for (const row of res?.rows || []) {
			const fullId = row?.id;
			if (!isItemFullId(fullId)) {
				continue;
			}
			const ownId = toOwnId(fullId);
			if (!ownId) {
				continue;
			}
			const st = await getStateAsync(ownId);
			const name = normalizeItemName(st?.val) || ownId.split('.').slice(-1)[0];
			next.set(fullId, { name });
		}

		cache.itemsByFullId = next;
	};

	/**
	 * Apply the list message to ioBroker states (MsgHub → ioBroker).
	 *
	 * Strategy:
	 * - For each listItem that belongs to our subtree, create/update its corresponding state.
	 * - Remove states that belong to our subtree but no longer exist as listItems.
	 *
	 * Important:
	 * - This only touches objects within our subtree.
	 * - Writes are done as `ack:true` and guarded via `ownWrites` to avoid ingest echo loops.
	 *
	 * @param {object} msg List message object (usually from notifications).
	 * @returns {Promise<void>}
	 */
	const applyMessageToStates = async msg => {
		const listItems = Array.isArray(msg?.listItems) ? msg.listItems : [];
		const desired = new Map();
		for (const item of listItems) {
			if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
				continue;
			}
			if (!isItemFullId(item.id)) {
				continue;
			}
			const name = normalizeItemName(item.name);
			if (!name) {
				continue;
			}
			desired.set(item.id, name);
		}

		await ensureItemsChannel();

		// Create/update desired states.
		for (const [fullId, name] of desired.entries()) {
			const ownId = toOwnId(fullId);
			if (!ownId || !ownId.startsWith(`${itemsPrefixOwn}.`)) {
				continue;
			}

			await ensureItemState(ownId, null);
			const cur = await getStateAsync(ownId);
			const curName = normalizeItemName(cur?.val);
			if (curName !== name) {
				await setStateAckAsync(ownId, name);
			}
			cache.itemsByFullId.set(fullId, { name });
		}

		// Remove states that no longer exist in listItems (only within our subtree).
		for (const fullId of Array.from(cache.itemsByFullId.keys())) {
			if (!isItemFullId(fullId)) {
				continue;
			}
			if (desired.has(fullId)) {
				continue;
			}
			const ownId = toOwnId(fullId);
			if (!ownId || !ownId.startsWith(`${itemsPrefixOwn}.`)) {
				continue;
			}
			try {
				await delObjectAsync(ownId);
			} catch {
				// best-effort
			}
			cache.itemsByFullId.delete(fullId);
		}
	};

	const ingest = {
		/**
		 * Start the ingest side of the bridge.
		 *
		 * Responsibilities:
		 * - subscribe to the plugin subtree (states + objects) so user changes are observed
		 * - build initial cache by scanning existing states in the subtree
		 * - reconcile the MsgHub list message against the current subtree inventory
		 * - optionally start periodic resync and demo cycle timers
		 *
		 * @param {object} ctx MsgIngest context.
		 * @returns {void} No return value.
		 */
		start(ctx) {
			if (ingestCtxRef) {
				return;
			}
			if (!ctx?.api?.store || !ctx?.api?.factory || !ctx?.api?.constants) {
				throw new Error('BridgeRandomDemo.ingest.start: ctx.api.store/factory/constants are required');
			}

			ingestCtxRef = ctx;

			// Subscribe to states/objects below our subtree to observe user-created states and value changes.
			try {
				adapter.subscribeStates?.(`${itemsPrefixOwn}.*`);
			} catch (e) {
				adapter?.log?.warn?.(`BridgeRandomDemo: subscribeStates failed: ${e?.message || e}`);
			}
			try {
				if (typeof adapter.subscribeObjects === 'function') {
					adapter.subscribeObjects(`${itemsPrefixOwn}.*`);
				} else if (typeof adapter.subscribeForeignObjects === 'function') {
					adapter.subscribeForeignObjects(`${itemsPrefixFull}.*`);
				}
			} catch (e) {
				adapter?.log?.warn?.(`BridgeRandomDemo: subscribeObjects failed: ${e?.message || e}`);
			}

			queue(async () => {
				await ensureItemsChannel();
				await rescanStateInventory();
				await reconcileMessageWithStateInventory(ctx);
			});

			if (Number.isFinite(Number(resyncIntervalMs)) && Number(resyncIntervalMs) > 0) {
				resyncTimer = setInterval(() => {
					queue(async () => {
						await rescanStateInventory();
						await reconcileMessageWithStateInventory(ingestCtxRef);
					});
				}, Number(resyncIntervalMs));
			}

			if (Number.isFinite(Number(cycleIntervalMs)) && Number(cycleIntervalMs) > 0) {
				cycleTimer = setInterval(() => {
					queue(async () => {
						// Ensure list exists, then add/remove one deterministic demo item.
						ensureListMessageExists(ingestCtxRef);
						const cur = cache.lastListItemsById;
						const present = cur.has(cycleItemFullId);

						if (!present) {
							const text = `Demo item (${new Date().toISOString()})`;
							patchListItems(ingestCtxRef, {
								setById: new Map([[cycleItemFullId, { name: text, checked: false }]]),
							});
							return;
						}

						patchListItems(ingestCtxRef, { deleteIds: [cycleItemFullId] });

						// Best-effort cleanup if someone edited listItems but the corresponding state still exists.
						try {
							await delObjectAsync(cycleItemOwnId);
						} catch {
							// ignore
						}
					});
				}, Number(cycleIntervalMs));
			}
		},

		/**
		 * Stop the ingest side and release resources (timers + subscriptions).
		 *
		 * @returns {void} No return value.
		 */
		stop() {
			if (!ingestCtxRef) {
				return;
			}

			if (resyncTimer) {
				clearInterval(resyncTimer);
				resyncTimer = null;
			}
			if (cycleTimer) {
				clearInterval(cycleTimer);
				cycleTimer = null;
			}

			try {
				adapter.unsubscribeStates?.(`${itemsPrefixOwn}.*`);
			} catch {
				// ignore
			}
			try {
				if (typeof adapter.unsubscribeObjects === 'function') {
					adapter.unsubscribeObjects(`${itemsPrefixOwn}.*`);
				} else if (typeof adapter.unsubscribeForeignObjects === 'function') {
					adapter.unsubscribeForeignObjects(`${itemsPrefixFull}.*`);
				}
			} catch {
				// ignore
			}

			ingestCtxRef = null;
		},

		/**
		 * Handle object changes for the plugin subtree.
		 *
		 * This reacts to:
		 * - object deletion: remove item from cache and reconcile list message
		 * - object creation/update: cache item and reconcile list message
		 *
		 * @param {string} id Full object id.
		 * @param {ioBroker.Object|null|undefined} obj Object value.
		 * @param {object} [_ctx] MsgIngest context (unused).
		 * @returns {void} No return value.
		 */
		onObjectChange(id, obj, _ctx) {
			if (!ingestCtxRef) {
				return;
			}
			if (!isItemFullId(id)) {
				return;
			}

			queue(async () => {
				const ownId = toOwnId(id);
				if (!ownId || !ownId.startsWith(`${itemsPrefixOwn}.`)) {
					return;
				}

				// Deletion: remove from cache + list.
				if (!obj) {
					cache.itemsByFullId.delete(id);
					reconcileMessageWithStateInventory(ingestCtxRef);
					return;
				}

				// Only treat real ioBroker states as list items.
				if (obj.type !== 'state') {
					return;
				}

				// New/updated object: cache it (name may be updated by a later stateChange).
				const st = await getStateAsync(ownId);
				const name = normalizeItemName(st?.val) || ownId.split('.').slice(-1)[0];
				cache.itemsByFullId.set(id, { name });
				await reconcileMessageWithStateInventory(ingestCtxRef);
			});
		},

		/**
		 * Handle state value changes for item states.
		 *
		 * Notes:
		 * - ack:false writes are user intent, but we also accept ack:true changes from other adapters.
		 * - own ack:true writes are ignored for a short time window to avoid loops.
		 *
		 * @param {string} id Full state id.
		 * @param {ioBroker.State|null|undefined} state State value.
		 * @param {object} [_ctx] MsgIngest context (unused).
		 * @returns {void} No return value.
		 */
		onStateChange(id, state, _ctx) {
			if (!ingestCtxRef) {
				return;
			}
			if (!isItemFullId(id)) {
				return;
			}

			// Loop protection: ignore only our own recent ack:true writes (but still accept ack:true updates
			// from other sources, since many systems write states with ack:true).
			const ownId = toOwnId(id);
			if (state?.ack === true && ownId) {
				const last = ownWrites.get(ownId);
				const ageMs = last?.ts ? Date.now() - last.ts : Number.POSITIVE_INFINITY;
				const valNow = normalizeItemName(state?.val);
				if (last && ageMs >= 0 && ageMs < 5000 && last.val === valNow) {
					return;
				}
			}

			queue(async () => {
				if (!ownId || !ownId.startsWith(`${itemsPrefixOwn}.`)) {
					return;
				}

				const name = normalizeItemName(state?.val) || ownId.split('.').slice(-1)[0];
				cache.itemsByFullId.set(id, { name });
				await reconcileMessageWithStateInventory(ingestCtxRef);
			});
		},
	};

	const notify = {
		/**
		 * Handle MsgHub notifications (message lifecycle events).
		 *
		 * This plugin only cares about notifications for its own list message (`listRef`).
		 * For "updated" and "due" events we treat the message as the desired state and apply it to ioBroker.
		 *
		 * @param {string} event Notification event name (e.g. "updated", "due").
		 * @param {object[]} notifications Message(s) that triggered the event.
		 * @param {object} [_ctx] MsgNotify context (unused).
		 * @returns {void} No return value.
		 */
		onNotifications(event, notifications, _ctx) {
			if (!Array.isArray(notifications) || notifications.length === 0) {
				return;
			}

			for (const msg of notifications) {
				if (!msg || typeof msg !== 'object') {
					continue;
				}
				if (msg.ref !== listRef) {
					continue;
				}

				// Best-effort snapshot: keep our diff cache up to date even when the list is updated externally.
				updateLastListSnapshot(msg);

				// Only react to list lifecycle events.
				if (event !== 'updated' && event !== 'due') {
					continue;
				}

				queue(async () => {
					try {
						await applyMessageToStates(msg);
					} catch (e) {
						adapter?.log?.warn?.(`BridgeRandomDemo: notify sync failed: ${e?.message || e}`);
					}
				});
			}
		},
	};

	return { ingest, notify };
}

module.exports = { BridgeRandomDemo };
