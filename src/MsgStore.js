const { serializeWithMaps } = require(`${__dirname}/MsgUtils`);
const { MsgStorage } = require(`${__dirname}/MsgStorage`);
const { MsgArchive } = require(`${__dirname}/MsgArchive`);
const { MsgRender } = require(`${__dirname}/MsgRender`);
const { MsgNotify } = require(`${__dirname}/MsgNotify`);
const { MsgIngest } = require(`${__dirname}/MsgIngest`);

/**
 * MsgStore
 * ========
 * Central in-memory repository for MsgHub messages.
 *
 * Core responsibilities
 * - Own the canonical in-memory list (`this.fullList`) and be the single place where the list is mutated.
 * - Provide a small set of mutation APIs (`addMessage`, `updateMessage`, `removeMessage`, `addOrUpdateMessage`)
 *   that coordinate side-effects consistently.
 * - Provide read APIs (`getMessageByRef`, `getMessagesByLevel`, `getMessages`) that return a rendered view of the
 *   canonical data without mutating stored messages.
 * - Run lifecycle maintenance (`_pruneOldMessages`) and optionally dispatch due notifications on a timer
 *   (`_initiateNotifications`).
 *
 * Design guidelines / invariants
 * - Canonical vs. view: `this.fullList` stores raw message objects only. Rendering happens at the boundary (read methods).
 * - Best-effort side-effects: persistence/archiving/notifications must not block the core mutation. They are called without
 *   awaiting and failures are handled inside their respective components (or via adapter logging).
 * - Single source of truth for validation: `MsgFactory.applyPatch()` is responsible for schema/normalization rules during updates.
 *   The store only performs minimal guards (presence of adapter/constants/factory, ref checks, and the integer level guard on add).
 * - External scheduling: this class does not “schedule” notifications beyond polling `notifyAt`. If a message remains due, it will be
 *   re-dispatched on every tick until something else updates/removes it (or moves `notifyAt` into the future).
 * - Predictable ordering: when a mutation succeeds, the store updates `fullList` first, then triggers persistence/notifications/archive
 *   so downstream consumers observe the post-mutation state.
 *
 * Persistence (MsgStorage)
 * - Persists the entire message list as one JSON file (default: `data/messages.json`).
 * - Persistence is intentionally fire-and-forget: `writeJson()` is not awaited.
 *   `MsgStorage` serializes I/O internally and may throttle writes.
 * - `onUnload()` calls `flushPending()` to best-effort persist the latest state.
 *
 * Archiving (MsgArchive)
 * - Appends lifecycle events to a per-ref JSONL archive (default: `data/archive/<ref>.jsonl`).
 * - Archiving is best-effort and must never block core operations.
 * - Note on naming: archive events default to `"create"|"patch"|"delete"`, while notifications use
 *   `MsgConstants.notfication.events.*` (e.g. `"deleted"` / `"expired"`).
 *
 * Notifications (MsgNotify)
 * - The store does not deliver notifications itself; it only dispatches events to `MsgNotify`, which
 *   forwards them to registered plugins.
 * - The store does not mark messages as "already notified". If a message is due (`notifyAt <= now`),
 *   `_initiateNotifications()` will dispatch it again on every tick until some external actor updates/
 *   removes the message (or moves `notifyAt` into the future).
 *
 * Ingest (MsgIngest)
 * - The store does not interpret incoming ioBroker events; it provides a host (`MsgIngest`) that
 *   forwards input events to registered producer plugins.
 * - Input events are forwarded from the adapter (e.g. `main.js`) into `MsgStore.ingestStateChange()`
 *   / `MsgStore.ingestObjectChange()`.
 *
 * Lifecycle / pruning
 * - Messages with `timing.expiresAt < now` are considered expired and are removed by `_pruneOldMessages()`.
 * - Pruning is throttled by `pruneIntervalMs` to avoid scanning on every call.
 *
 * Rendering (MsgRender)
 * - Read methods return a view of messages (`msgRender.renderMessage`) without mutating stored data.
 * - The canonical data is always `this.fullList`; rendered output is view-only.
 */
class MsgStore {
	/**
	 * Create a new store instance.
	 *
	 * Initialization notes:
	 * - `MsgStorage.init()` / `MsgArchive.init()` are async and called without awaiting. They prepare
	 *   ioBroker file storage roots/folders. Until they complete, writes may still succeed depending
	 *   on backend behavior, or be queued internally by the components.
	 * - The notifier timer is optional; set `notifierIntervalMs` to `0` to disable.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { locale?: string }} adapter Adapter instance for logging and utilities.
	 * @param {Array<object>} messages Initial in-memory message list (use `[]` if no data).
	 * @param {import('./MsgConstants').MsgConstants} msgConstants Centralized enum-like constants.
	 * @param {import('./MsgFactory').MsgFactory} msgFactory Factory used for patching/validation.
	 * @param {object} [options] Optional configuration.
	 * @param {number} [options.pruneIntervalMs] Expiration scan throttle in ms (default: 30000).
	 * @param {number} [options.notifierIntervalMs] Due-notification polling interval in ms (default: 10000, 0 disables).
	 */
	constructor(
		adapter,
		messages = [],
		msgConstants,
		msgFactory,
		{ pruneIntervalMs = 30000, notifierIntervalMs = 10000 } = {},
	) {
		if (!adapter) {
			throw new Error('MsgStore: adapter is required');
		}
		this.adapter = adapter;

		if (!msgConstants) {
			throw new Error('MsgStore: msgConstants is required');
		}
		this.msgConstants = msgConstants;

		if (!msgFactory) {
			throw new Error('MsgStore: msgFactory is required');
		}
		this.msgFactory = msgFactory;

		// File persistence (async init, intentionally not awaited).
		this.msgStorage = new MsgStorage(this.adapter, { baseDir: 'data', fileName: 'messages.json' });
		this.msgStorage.init();

		// Append-only archive (async init, intentionally not awaited).
		this.msgArchive = new MsgArchive(this.adapter, { baseDir: 'data/archive' });
		this.msgArchive?.init();

		// View rendering (pure transformation; no I/O).
		this.msgRender = new MsgRender(this.adapter, { locale: this.adapter?.locale });

		// Notification dispatcher (plugins register elsewhere).
		this.msgNotify = new MsgNotify(this.adapter, this.msgConstants);

		// Producer host for inbound events (plugins register elsewhere).
		this.msgIngest = new MsgIngest(this.adapter, this.msgConstants, this.msgFactory, this);

		// Canonical in-memory list (do not store rendered output here).
		this.fullList = messages;

		// Pruning and notification timers.
		this.lastPruneAt = 0;
		this.pruneIntervalMs = pruneIntervalMs;
		this.notifierIntervalMs = notifierIntervalMs;
		this._notifyTimer = null;

		if (this.notifierIntervalMs > 0) {
			// Periodically dispatch due notifications for messages that have reached notifyAt.
			this._notifyTimer = setInterval(() => this._initiateNotifications(), this.notifierIntervalMs);
		}

		this.adapter?.log?.info?.(
			`MsgStore initialized: pruneIntervalMs=${this.pruneIntervalMs}ms, notifierIntervalMs=${this.notifierIntervalMs}ms`,
		);
	}

	/**
	 * Add a new message if its `ref` does not exist yet.
	 *
	 * Contract / expectations:
	 * - The store expects `msg` to already be normalized (typically created by `MsgFactory.createMessage()`).
	 * - `level` must be a number integer; numeric strings like `"10"` are rejected.
	 * - `ref` must be unique.
	 *
	 * Side-effects on success:
	 * - Persists the updated full list via `MsgStorage` (not awaited).
	 * - If `timing.notifyAt` is missing or not finite, dispatches an immediate `"due"` notification.
	 * - Appends an archive snapshot (best-effort, not awaited).
	 *
	 * @param {object} msg Normalized message object.
	 * @returns {boolean} True when added, false when rejected by guards.
	 */
	addMessage(msg) {
		// Keep the list clean before inserting anything new.
		this._pruneOldMessages();

		// Guard: enforce numeric integer levels (no coercion, no numeric strings).
		if (msg.level !== parseInt(msg.level, 10)) {
			return false;
		}
		// Guard: reject duplicates by ref.
		if (this.getMessageByRef(msg.ref) != null) {
			return false;
		}

		// Mutate canonical list.
		this.fullList.push(msg);
		// Persist the entire list (best-effort; MsgStorage may throttle).
		this.msgStorage.writeJson(this.fullList);

		// If no future notifyAt exists, treat the message as immediately due.
		if (!Number.isFinite(msg?.timing?.notifyAt)) {
			this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.due, msg);
		}

		// Archive the creation for audit/replay. This must not block the store.
		this.msgArchive?.appendSnapshot?.(msg);
		this.adapter?.log?.debug?.(`MsgStore: added Message '${msg.ref}'`);
		this.adapter?.log?.silly?.(`MsgStore: added Message '${serializeWithMaps(msg)}'`);

		return true;
	}

	/**
	 * Update an existing message by applying a patch via `MsgFactory.applyPatch()`.
	 *
	 * Overloads:
	 * - `updateMessage({ ref, ...patch })`
	 * - `updateMessage(ref, { ...patch })`
	 *
	 * How "silent" updates are detected:
	 * - The store does not decide silence directly. It compares `timing.updatedAt` before/after patching.
	 * - If `updatedAt` changed and is a finite number, the store considers the update non-silent and dispatches `"updated"`.
	 *
	 * Side-effects on success:
	 * - Persists the updated full list via `MsgStorage` (not awaited).
	 * - Dispatches `"updated"` when the update is non-silent (as described above).
	 * - Additionally dispatches `"due"` when:
	 *   - the update is non-silent,
	 *   - `timing.notifyAt` is missing / not finite,
	 *   - and the message is not expired (`expiresAt` missing or in the future).
	 * - Appends an archive patch event, including `existing` and `updated` snapshots for diffing (best-effort).
	 *
	 * @param {object|string} msgOrRef Patch object that includes a ref, or a ref string.
	 * @param {object} [patch] Patch object when ref is provided separately.
	 * @returns {boolean} True when updated, false when rejected by guards or validation.
	 */
	updateMessage(msgOrRef, patch = undefined) {
		// Ensure consumers don't update already-expired entries.
		this._pruneOldMessages();

		// Normalize overloads into a single patch object containing `ref`.
		const msg = typeof msgOrRef === 'string' ? { ...(patch || {}), ref: msgOrRef } : msgOrRef;

		// Guard: patch must be an object and include a non-empty ref.
		if (!msg || typeof msg !== 'object') {
			return false;
		}
		if (typeof msg.ref !== 'string' || !msg.ref.trim()) {
			return false;
		}

		// Find the target message in the canonical list.
		const index = this.fullList.findIndex(item => item.ref === msg.ref);
		if (index === -1) {
			this.adapter?.log?.warn?.(`MsgStore: '${msg.ref}' could not be updated (not found)`);
			return false;
		}

		const existing = this.fullList[index];
		const factory = this.msgFactory;
		if (!factory || typeof factory.applyPatch !== 'function') {
			this.adapter?.log?.warn?.('MsgStore: msgFactory not available to update Message');
			return false;
		}

		// Delegate validation + normalization to the factory (single source of truth).
		const updated = factory.applyPatch(existing, msg);
		if (!updated) {
			this.adapter?.log?.warn?.(`MsgStore: '${msg.ref}' could not be updated (validation failed)`);
			return false;
		}

		// Replace the entry and persist.
		this.fullList[index] = updated;
		this.msgStorage.writeJson(this.fullList);

		// Detect whether this was a non-silent update by comparing updatedAt.
		const t = updated?.timing;
		const hadUpdate = Number.isFinite(t?.updatedAt) && t.updatedAt !== existing?.timing?.updatedAt;

		if (hadUpdate) {
			this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.update, updated);
		}

		// Immediate due semantics (only for non-silent updates and only when not expired).
		const now = Date.now();
		const notExpired = typeof t?.expiresAt !== 'number' || t.expiresAt > now;

		if (!Number.isFinite(t?.notifyAt) && hadUpdate && notExpired) {
			this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.due, updated);
		}

		// Archive patch information for audit and debugging (best-effort).
		this.msgArchive?.appendPatch?.(msg.ref, msg, existing, updated);
		this.adapter?.log?.debug?.(`MsgStore: updated Message '${updated.ref}'`);
		this.adapter?.log?.silly?.(`MsgStore: updated Message '${serializeWithMaps(updated)}'`);

		return true;
	}

	/**
	 * Add a message or update it when the ref already exists.
	 *
	 * This is a convenience "upsert" method. All side-effects (persistence, archive, notifications)
	 * are handled by `addMessage()` / `updateMessage()`.
	 *
	 * @param {object} msg Message or patch payload.
	 * @returns {boolean} True when added or updated.
	 */
	addOrUpdateMessage(msg) {
		this._pruneOldMessages();
		// Existence check uses getMessageByRef(), which returns rendered output for existing entries.
		if (this.getMessageByRef(msg.ref) != null) {
			return this.updateMessage(msg);
		}
		return this.addMessage(msg);
	}

	/**
	 * Return the first message that matches a ref.
	 *
	 * Behavior:
	 * - Returns `undefined` when no message exists for the given ref.
	 * - Returns a rendered view (via `MsgRender`) when available; otherwise returns the raw message.
	 * - Does not mutate stored data.
	 *
	 * @param {string} reference Message ref.
	 * @returns {object|undefined} Matching message, if found.
	 */
	getMessageByRef(reference) {
		this._pruneOldMessages();
		const msg = this.fullList.filter(obj => {
			return obj.ref === reference;
		})[0];
		// Render only on output; keep `fullList` unmodified.
		return this.msgRender?.renderMessage(msg) || msg;
	}

	/**
	 * Return all messages with a given level.
	 *
	 * Notes:
	 * - Uses loose equality (`==`) to match numeric equivalents. Messages added via `addMessage()` must
	 *   have numeric integer `level`, but imported data may include numeric strings.
	 * - Returned messages are rendered views when `MsgRender` is available.
	 *
	 * @param {number} level Message level to filter on.
	 * @returns {Array<object>} Matching messages.
	 */
	getMessagesByLevel(level) {
		this._pruneOldMessages();
		const levelList = this.fullList.filter(obj => {
			return obj.level == level;
		});

		return levelList.map(msg => this.msgRender?.renderMessage(msg) || msg);
	}

	/**
	 * Return the current message list.
	 *
	 * Behavior:
	 * - Triggers a throttled prune before returning.
	 * - Returns rendered views when `MsgRender` is available.
	 *
	 * @returns {Array<object>} All messages.
	 */
	getMessages() {
		this._pruneOldMessages();
		return this.fullList.map(msg => this.msgRender?.renderMessage(msg) || msg);
	}

	/**
	 * Remove a message by ref.
	 *
	 * Side-effects:
	 * - Removes the entry from the canonical list.
	 * - Appends an archive delete event (archive event defaults to `"delete"`).
	 * - Dispatches a `"deleted"` notification event via `MsgNotify`.
	 * - Persists the updated list via `MsgStorage` (not awaited).
	 *
	 * @param {string} reference Message ref.
	 * @returns {void}
	 */
	removeMessage(reference) {
		this._pruneOldMessages();

		// Find the message to remove; if missing, do nothing.
		const remove = this.fullList.filter(obj => {
			return obj.ref === reference;
		})[0];
		if (remove == null) {
			return;
		}

		// Mutate canonical list.
		this.fullList = this.fullList.filter(item => item.ref !== reference);
		// Archive first (best-effort), then notify plugins.
		this.msgArchive?.appendDelete?.(remove);
		this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.deleted, remove);

		// Persist after mutation so storage reflects the current list.
		this.msgStorage.writeJson(this.fullList);
		this.adapter?.log?.debug?.(`MsgStore: removed Message '${reference}'`);
		this.adapter?.log?.silly?.(`MsgStore: removed Message '${serializeWithMaps(remove)}'`);
	}

	/**
	 * Lifecycle hook to be called during adapter unload/shutdown.
	 *
	 * Responsibilities:
	 * - Stop periodic due-notification polling.
	 * - Flush pending (throttled/batched) writes for storage and archive.
	 *
	 * Notes:
	 * - This method intentionally does not `await` flushes; ioBroker unload hooks are often time-limited.
	 *   Both `MsgStorage` and `MsgArchive` implement best-effort flushing and internal queuing.
	 *
	 * @returns {void}
	 */
	onUnload() {
		// Stop producer plugins first so they can stop timers/subscriptions before storage flushes.
		this.msgIngest?.stop?.({ reason: 'unload' });

		// Stop dispatching due messages to msgNotify
		if (this._notifyTimer) {
			clearInterval(this._notifyTimer);
			this._notifyTimer = null;
		}

		// Best-effort flush of buffered writes.
		this.msgStorage.flushPending();
		this.msgArchive?.flushPending?.();
	}

	/**
	 * Prune expired messages from the canonical list.
	 *
	 * A message is considered expired when `timing.expiresAt` is a number and strictly lower than `now`.
	 * Pruning is throttled by `pruneIntervalMs` via `lastPruneAt`.
	 *
	 * Side-effects when expirations are found:
	 * - Removes expired entries from the canonical list.
	 * - Persists the updated list via `MsgStorage` (not awaited).
	 * - Dispatches a single `"expired"` notification containing the array of removed messages.
	 * - Appends an archive delete event per removed message, using `{ event: "expired" }`.
	 *
	 * @returns {void}
	 */
	_pruneOldMessages() {
		const now = Date.now();
		// Throttle scans to reduce CPU overhead on frequent reads/writes.
		if (now - this.lastPruneAt < this.pruneIntervalMs) {
			return;
		}
		this.lastPruneAt = now;

		// Determine which entries are expired based on expiresAt.
		const isExpired = item => typeof item?.timing?.expiresAt === 'number' && item.timing.expiresAt < now;
		const removals = this.fullList.filter(isExpired);

		if (removals.length === 0) {
			return;
		}

		// Remove expired entries and persist.
		this.fullList = this.fullList.filter(item => !isExpired(item));
		this.msgStorage.writeJson(this.fullList);

		// Notify plugins once per prune cycle with the list of removed messages.
		this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.expired, removals);

		// Archive each removal individually to keep per-ref files consistent.
		for (const msg of removals) {
			this.msgArchive?.appendDelete?.(msg, { event: 'expired' });
		}

		this.adapter?.log?.debug?.(`MsgStore: removed expired Message(s) '${removals.map(msg => msg.ref).join(', ')}'`);
		this.adapter?.log?.silly?.(`MsgStore: removed expired Message(s) '${serializeWithMaps(removals)}'`);
	}

	/**
	 * Dispatch due notifications for messages whose `notifyAt` timestamp has been reached.
	 *
	 * Selection logic:
	 * - `timing.notifyAt` must be a number and `<= now`.
	 * - Expired messages are excluded (`expiresAt` missing or `> now`).
	 *
	 * Side-effects:
	 * - Dispatches a single `"due"` event containing an array of due messages.
	 *
	 * Important:
	 * - This method does not update `notifyAt` or otherwise "ack" delivery. Messages will remain due and
	 *   will be dispatched again on the next tick unless some other part of the system updates/removes them.
	 *
	 * @returns {void}
	 */
	_initiateNotifications() {
		const now = Date.now();

		// Determine which entries are currently due.
		const isDue = item =>
			typeof item?.timing?.notifyAt === 'number' &&
			item.timing.notifyAt <= now &&
			(typeof item?.timing?.expiresAt !== 'number' || item.timing.expiresAt > now);
		const notifications = this.fullList.filter(isDue);

		if (notifications.length === 0) {
			return;
		}

		// Dispatch as a batch; MsgNotify will fan out per message internally.
		this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.due, notifications);

		this.adapter?.log?.debug?.(
			`MsgStore: initiated Notification for Message(s) '${notifications.map(msg => msg.ref).join(', ')}'`,
		);
		this.adapter?.log?.silly?.(
			`MsgStore: initiated Notification for Message(s) '${serializeWithMaps(notifications)}'`,
		);
	}
}

module.exports = { MsgStore };
