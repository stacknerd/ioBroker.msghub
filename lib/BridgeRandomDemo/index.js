'use strict';

const { createOpQueue } = require(`${__dirname}/../../src/MsgUtils`);

/**
 * Create a MsgBridge demo plugin that keeps a Message Hub list (one message with listItems)
 * in sync with ioBroker states below its own subtree.
 *
 * Docs: ../../docs/plugins/BridgeRandomDemo.md
 *
 * Model
 * - The plugin owns exactly one "list message" in the MsgHub store:
 *   - `ref` = `options.pluginBaseObjectId` (full id, normalized by MsgFactory)
 *   - `kind` = `shoppinglist` (default) or `inventorylist`
 * - Each list item is mirrored as an ioBroker state below:
 *   - `<pluginBaseObjectId>.<itemsChannel>.<itemKey>`
 *   - listItem.id uses the *full* ioBroker object id of that state.
 *
 * Sync rules (bidirectional)
 * - ioBroker state value → listItem.name
 * - listItem.name → ioBroker state value
 * - Removing on either side removes on the other side
 *
 * Demo behavior
 * - The plugin periodically adds/removes a `_cycle` list item (via store updates),
 *   which triggers the notify-side sync back to ioBroker.
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
 * @returns {{ ingest: object, notify: { onNotifications: Function } }} Bridge plugin.
 */
function BridgeRandomDemo(adapter, options = {}) {
	if (!adapter) {
		throw new Error('BridgeRandomDemo: adapter is required');
	}

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

	const queue = createOpQueue();
	const cache = {
		// fullId -> { name: string }
		itemsByFullId: new Map(),
		// keep a minimal snapshot of the list message for diffing (id -> item)
		lastListItemsById: new Map(),
	};
	// Loop protection: track recent ack:true writes performed by this plugin.
	const ownWrites = new Map();

	let ingestCtxRef = null;
	let resyncTimer = null;
	let cycleTimer = null;

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

	const isItemFullId = id =>
		typeof id === 'string' && (id.startsWith(`${itemsPrefixFull}.`) || id === cycleItemFullId);

	const normalizeItemName = value => {
		if (value === null || value === undefined) {
			return '';
		}
		if (typeof value === 'string') {
			return value.trim();
		}
		return String(value);
	};

	const getStateAsync = ownId => {
		if (typeof adapter.getStateAsync === 'function') {
			return adapter.getStateAsync(ownId);
		}
		return new Promise(resolve => adapter.getState(ownId, (err, state) => resolve(err ? null : state)));
	};

	const setObjectNotExistsAsync = (ownId, obj) => {
		if (typeof adapter.setObjectNotExistsAsync === 'function') {
			return adapter.setObjectNotExistsAsync(ownId, obj);
		}
		return new Promise(resolve => adapter.setObjectNotExists(ownId, obj, () => resolve(undefined)));
	};

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

	const delObjectAsync = ownId => {
		if (typeof adapter.delObjectAsync === 'function') {
			return adapter.delObjectAsync(ownId);
		}
		return new Promise(resolve => adapter.delObject(ownId, () => resolve(undefined)));
	};

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

	const getListMessage = ctx => ctx?.api?.store?.getMessageByRef?.(listRef);

	const indexListItems = msg =>
		new Map(
			Array.isArray(msg?.listItems)
				? msg.listItems
						.filter(it => it && typeof it === 'object' && typeof it.id === 'string')
						.map(it => [it.id, it])
				: [],
		);

	const updateLastListSnapshot = msg => {
		cache.lastListItemsById = indexListItems(msg);
	};

	const resolveListKind = constants => {
		const allowed = new Set(Object.values(constants?.kind || {}));
		if (typeof listKind === 'string' && allowed.has(listKind)) {
			return listKind;
		}
		return constants?.kind?.shoppinglist;
	};

	const resolveListLevel = constants => {
		const numeric = Number.isFinite(Number(listLevel)) ? Number(listLevel) : undefined;
		const allowed = new Set(Object.values(constants?.level || {}));
		if (numeric !== undefined && allowed.has(numeric)) {
			return numeric;
		}
		return constants?.level?.notice;
	};

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
