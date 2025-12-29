/**
 * MsgStore
 * ========
 * Central in-memory repository for MsgHub messages. *
 *
 * Docs: ../docs/modules/MsgStore.md
 *
 * Core responsibilities
 * - Own the canonical in-memory list (`this.fullList`) and be the single place where the list is mutated.
 * - Provide a small set of mutation APIs (`addMessage`, `updateMessage`, `removeMessage`, `addOrUpdateMessage`)
 *   that coordinate side-effects consistently.
 * - Provide read APIs (`getMessageByRef`, `getMessages`, `queryMessages`) that return a rendered view of the
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
 * - Appends lifecycle events to a per-ref JSONL archive (default: `data/archive/<refPath>.jsonl`, dots → folders).
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
 * - Input events are typically forwarded from the adapter (e.g. `main.js`) into
 *   `msgStore.msgIngest.dispatchStateChange(...)` / `dispatchObjectChange(...)`.
 *
 * Lifecycle / pruning
 * - Messages with `timing.expiresAt < now` are considered expired and are soft-marked via `_pruneOldMessages()` (lifecycle.state="expired").
 *   A later hard-delete step removes them from memory/storage after a retention window.
 * - Pruning is throttled by `pruneIntervalMs` to avoid scanning on every call.
 *
 * Rendering (MsgRender)
 * - Read methods return a view of messages (`msgRender.renderMessage`) without mutating stored data.
 * - The canonical data is always `this.fullList`; rendered output is view-only.
 */

const { serializeWithMaps } = require(`${__dirname}/MsgUtils`);
const { MsgStorage } = require(`${__dirname}/MsgStorage`);
const { MsgArchive } = require(`${__dirname}/MsgArchive`);
const { MsgRender } = require(`${__dirname}/MsgRender`);
const { MsgNotify } = require(`${__dirname}/MsgNotify`);
const { MsgIngest } = require(`${__dirname}/MsgIngest`);

/**
 * MsgStore
 */
class MsgStore {
	/**
	 * Create a new store instance.
	 *
	 * Initialization notes:
	 * - Construction is intentionally synchronous and side-effect-light (no I/O).
	 * - Call `await store.init()` during adapter startup (`onReady`) to initialize storage and optionally
	 *   load persisted messages before plugins start producing events.
	 * - This avoids duplicate "create" events after restarts: producers can safely check existence via
	 *   `getMessageByRef()` because the store has been hydrated from `MsgStorage`.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { locale?: string }} adapter Adapter instance for logging and utilities.
	 * @param {import('./MsgConstants').MsgConstants} msgConstants Centralized enum-like constants.
	 * @param {import('./MsgFactory').MsgFactory} msgFactory Factory used for patching/validation.
	 * @param {object} [options] Optional configuration.
	 * @param {Array<object>} [options.initialMessages] Initial in-memory message list (primarily for tests/imports).
	 * @param {number} [options.pruneIntervalMs] Expiration scan throttle in ms (default: 30000).
	 * @param {number} [options.notifierIntervalMs] Due-notification polling interval in ms (default: 10000, 0 disables).
	 * @param {number} [options.hardDeleteAfterMs] After this time in "deleted"/"expired", messages are hard-deleted (default: 259200000).
	 * @param {number} [options.hardDeleteIntervalMs] Interval for checking hard-deletes (default: 14400000).
	 * @param {number} [options.deleteClosedIntervalMs] Interval for checking for closed messages (default: 10000).
	 * @param {object} [options.storage] Options forwarded to `MsgStorage` (e.g. `baseDir`, `fileName`, `writeIntervalMs`).
	 * @param {object} [options.archive] Options forwarded to `MsgArchive` (e.g. `baseDir`, `fileExtension`, `flushIntervalMs`).
	 */
	constructor(adapter, msgConstants, msgFactory, options = {}) {
		const {
			initialMessages = [],
			pruneIntervalMs = 30000,
			notifierIntervalMs = 10000,
			hardDeleteAfterMs = 1000 * 60 * 60 * 24 * 3,
			hardDeleteIntervalMs = 1000 * 60 * 60 * 4,
			deleteClosedIntervalMs = 1000 * 10,
			storage = {},
			archive = {},
		} = options || {};

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

		// File persistence (initialized in `init()`).
		this.msgStorage = new MsgStorage(this.adapter, {
			baseDir: 'data',
			fileName: 'messages.json',
			...(storage || {}),
		});

		// Append-only archive (initialized in `init()`).
		this.msgArchive = new MsgArchive(this.adapter, { baseDir: 'data/archive', ...(archive || {}) });

		// View rendering (pure transformation; no I/O).
		this.msgRender = new MsgRender(this.adapter, { locale: this.adapter?.locale });

		// Notification dispatcher (plugins register elsewhere).
		this.msgNotify = new MsgNotify(this.adapter, this.msgConstants, { store: this });

		// Producer host for inbound events (plugins register elsewhere).
		this.msgIngest = new MsgIngest(this.adapter, this.msgConstants, this.msgFactory, this);

		// Canonical in-memory list (do not store rendered output here).
		this.fullList = Array.isArray(initialMessages) ? initialMessages : [];

		// Pruning and notification timers (timer starts in `init()`).
		this.lastPruneAt = 0;
		this.pruneIntervalMs = pruneIntervalMs;
		this.notifierIntervalMs = notifierIntervalMs;
		this._notifyTimer = null;
		this._initialized = false;
		this._keepDeletedAndExpiredFilesMs = hardDeleteAfterMs;
		this._hardDeleteIntervalMs = hardDeleteIntervalMs;
		this._lastHardDeleteAt = 0;
		this._deleteClosedIntervalMs = deleteClosedIntervalMs;
		this._lastDeleteClosedAt = 0;

		this.adapter?.log?.info?.(
			`MsgStore initialized: pruneIntervalMs=${this.pruneIntervalMs}ms, notifierIntervalMs=${this.notifierIntervalMs}ms`,
		);
	}

	/**
	 * Initialize storage components and optionally hydrate `fullList` from persisted data.
	 *
	 * This must be awaited during adapter startup to avoid duplicate creates after restarts.
	 * It is safe to call this method multiple times; subsequent calls are no-ops.
	 *
	 * @param {object} [options] Init options.
	 * @param {boolean} [options.loadFromStorage] When true (default), replaces `fullList` with persisted messages.
	 * @returns {Promise<void>} Resolves when initialization is complete.
	 */
	async init({ loadFromStorage = true } = {}) {
		if (this._initialized) {
			return;
		}

		await this.msgStorage.init();
		await this.msgArchive.init();

		if (loadFromStorage) {
			const loaded = await this.msgStorage.readJson([]);
			this.fullList = Array.isArray(loaded) ? loaded : [];
			this._pruneOldMessages({ force: true });
		}

		if (this.notifierIntervalMs > 0 && !this._notifyTimer) {
			this._notifyTimer = setInterval(() => this._initiateNotifications(), this.notifierIntervalMs);
		}

		this._initialized = true;
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
	 *   (only when `lifecycle.state === "open"`; non-open messages are not considered due-on-create).
	 * - Appends an archive snapshot (best-effort, not awaited).
	 *
	 * @param {object} msg Normalized message object.
	 * @returns {boolean} True when added, false when rejected by guards.
	 */
	addMessage(msg) {
		// Keep the list clean before inserting anything new.
		this._deleteClosedMessages();
		this._pruneOldMessages();

		// Guards: msg must be a normalized object, with integer level (no numeric strings).
		if (!msg || typeof msg !== 'object') {
			return false;
		}
		if (typeof msg.ref !== 'string' || !msg.ref.trim()) {
			return false;
		}
		if (typeof msg.level !== 'number' || !Number.isInteger(msg.level)) {
			return false;
		}

		// Guard: reject duplicates by ref.
		const candidates = this.fullList.filter(item => item?.ref === msg.ref);
		if (candidates.length > 0) {
			const replaceableStates = new Set([
				this.msgConstants.lifecycle.state.expired,
				this.msgConstants.lifecycle.state.deleted,
				this.msgConstants.lifecycle.state.closed,
			]);
			const nonReplaceable = candidates.find(item => !replaceableStates.has(item?.lifecycle?.state));
			if (nonReplaceable) {
				return false;
			}

			// Hard-delete existing messages with the same ref so the new message can be recreated.
			for (const existing of candidates) {
				this.msgArchive?.appendDelete?.(existing, { event: 'purgeOnRecreate' });
			}
			this.fullList = this.fullList.filter(item => item?.ref !== msg.ref);
		}

		// Mutate canonical list.
		this.fullList.push(msg);
		// Persist the entire list (best-effort; MsgStorage may throttle).
		this.msgStorage.writeJson(this.fullList);

		// notify about added message
		this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.added, msg);

		// If no future notifyAt exists, treat the message as immediately due.
		const isOpen =
			(msg?.lifecycle?.state || this.msgConstants.lifecycle?.state?.open) ===
			this.msgConstants.lifecycle?.state?.open;
		if (isOpen && !Number.isFinite(msg?.timing?.notifyAt)) {
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
	 * - Dispatches `"updated"` when the update is non-silent (as described above),
	 *   except for transitions to `lifecycle.state="deleted"`/`"expired"` which are signaled via dedicated events.
	 * - Additionally dispatches `"due"` when:
	 *   - the update is non-silent,
	 *   - `timing.notifyAt` is missing / not finite,
	 *   - `lifecycle.state === "open"`,
	 *   - and the message is not expired (`expiresAt` missing or in the future).
	 * - Appends an archive patch event, including `existing` and `updated` snapshots for diffing (best-effort).
	 *
	 * @param {object|string} msgOrRef Patch object that includes a ref, or a ref string.
	 * @param {object} [patch] Patch object when ref is provided separately.
	 * @param {boolean} [stealthMode] When true, applies a "silent" patch (no `timing.updatedAt` bump). As a result, the store will not dispatch `"updated"` (and also not trigger the immediate-due-on-update rule); the change is still persisted and archived.
	 * @returns {boolean} True when updated, false when rejected by guards or validation.
	 */
	updateMessage(msgOrRef, patch = undefined, stealthMode = false) {
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
		const updated = factory.applyPatch(existing, msg, stealthMode);
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

		// For soft-delete/expire we dispatch dedicated events (`deleted`/`expired`) elsewhere.
		// Suppress `"updated"` for these transitions to avoid double-signaling.
		const state = updated?.lifecycle?.state;
		const existingState = existing?.lifecycle?.state;
		const isSoftDeletedTransition =
			(state === this.msgConstants.lifecycle?.state?.deleted ||
				state === this.msgConstants.lifecycle?.state?.expired) &&
			state !== existingState;

		if (hadUpdate && !isSoftDeletedTransition) {
			this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.update, updated);
		}

		// Immediate due semantics (only for non-silent updates and only when not expired).
		const now = Date.now();
		const notExpired = typeof t?.expiresAt !== 'number' || t.expiresAt > now;

		const isOpen =
			(updated?.lifecycle?.state || this.msgConstants.lifecycle?.state?.open) ===
			this.msgConstants.lifecycle?.state?.open;
		if (!Number.isFinite(t?.notifyAt) && hadUpdate && notExpired && isOpen) {
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
	 * Query messages with a JSON-friendly filter language, plus optional sort and pagination.
	 *
	 * Intent
	 * - This is a P1-style read API to support "Query/Views" without pushing filtering logic into UIs/scripts.
	 * - The API is deliberately JSON-serializable so it can be used via messagebox (`sendTo`) later.
	 *
	 * Defaults / important semantics
	 * - Canonical data source: reads from `this.fullList` (raw, unrendered).
	 * - Rendering: happens at the very end (`MsgRender`) to keep `fullList` canonical.
	 * - Pruning: triggers `_pruneOldMessages()` before querying (best-effort/throttled).
	 * - Hidden-by-default: messages with `lifecycle.state === "deleted"|"expired"` are NOT returned unless explicitly requested
	 *   via `where.lifecycle.state` (see below).
	 * - Best-effort: unknown keys are ignored; some invalid combinations throw a `TypeError` (see "Validation").
	 *
	 * Supported filter keys (`where`)
	 *
	 * 1) Enum-like filters (`string` or `{ in }` / `{ notIn }`)
	 * - `where.kind`
	 * - `where.origin.type`
	 * - `where.lifecycle.state`
	 *
	 * Shapes:
	 * - Scalar convenience: `where.kind = "task"`
	 * - Allowlist: `where.kind = { in: ["task", "status"] }`
	 * - Denylist: `where.kind = { notIn: ["status"] }`
	 *
	 * Notes:
	 * - `{ in }` and `{ notIn }` are mutually exclusive (see "Validation").
	 *
	 * Hidden-by-default behavior (deleted/expired)
	 * - If `where.lifecycle.state` is omitted, query results exclude `deleted` and `expired`.
	 * - To include them, you must explicitly request them via:
	 *   - `where.lifecycle.state = "deleted"` (scalar), or
	 *   - `where.lifecycle.state = { in: ["deleted", "expired"] }`
	 * - A `{ notIn: [...] }` lifecycle filter does NOT automatically include deleted/expired; if you want them, use `{ in: [...] }`.
	 *
	 * 2) Level filter (`number` or object with `{ in }`/`{ notIn }` and/or `{ min/max }`)
	 * - `where.level`
	 *
	 * Shapes:
	 * - Exact: `where.level = 10`
	 * - Allowlist: `where.level = { in: [10, 20] }`
	 * - Denylist: `where.level = { notIn: [0] }`
	 * - Range: `where.level = { min: 10, max: 30 }` (inclusive)
	 *
	 * Notes:
	 * - Ranges are inclusive.
	 * - You may combine allow/deny with ranges (e.g. `{ min: 10, notIn: [20] }`), but not `{ in }` and `{ notIn }` together.
	 *
	 * 3) Timing range filters (`where.timing`)
	 * - `where.timing` is an object; each supported timing field may be filtered by a range.
	 * - Supported keys:
	 *   - `createdAt`, `updatedAt`, `expiresAt`, `notifyAt`, `remindEvery`, `dueAt`, `startAt`, `endAt`
	 *
	 * Shapes per field:
	 * - Exact number: `where.timing.notifyAt = 1730000000000`
	 * - Range: `where.timing.notifyAt = { min: 1730000000000, max: 1730086400000 }` (inclusive)
	 *
	 * Notes:
	 * - Range implies existence: if a field is missing/null/not a finite number, the message does NOT match.
	 *   (Example: filtering on `notifyAt` will naturally exclude messages where `notifyAt` is unset.)
	 *
	 * 4) Details location allowlist (`where.details.location`)
	 * - Intended as a small "dimension" filter for location-based views.
	 *
	 * Shapes:
	 * - Exact: `where.details.location = "Kitchen"`
	 * - Allowlist: `where.details.location = ["Kitchen", "Hallway"]`
	 * - Allowlist object: `where.details.location = { in: ["Kitchen", "Hallway"] }`
	 *
	 * Notes:
	 * - Also implies existence: if `details.location` is missing/empty, the message does NOT match.
	 *
	 * 5) String list includes filters (`where.audience.tags`, `where.dependencies`)
	 * - `where.audience.tags`: matches against `message.audience.tags: string[]`
	 * - `where.dependencies`: matches against `message.dependencies: string[]`
	 *
	 * Shapes:
	 * - Single: `where.audience.tags = "Maria"`
	 * - Includes-any: `where.audience.tags = ["Maria", "Eva"]`
	 * - Explicit any/all:
	 *   - `where.audience.tags = { any: ["Maria", "Eva"] }`
	 *   - `where.audience.tags = { all: ["Maria", "Eva"] }`
	 *
	 * Notes:
	 * - Includes filters imply existence: if the target array is missing/empty, the message does NOT match.
	 *
	 * Sort (`sort`)
	 * - `sort` is optional and must be an array of `{ field, dir? }`.
	 * - `dir` defaults to `"asc"`; `"desc"` reverses the order.
	 * - Only the following fields are allowed (others are ignored):
	 *   - `ref`, `level`, `kind`, `origin.type`, `lifecycle.state`, `details.location`
	 *   - `timing.createdAt`, `timing.updatedAt`, `timing.expiresAt`, `timing.notifyAt`, `timing.remindEvery`, `timing.dueAt`,
	 *     `timing.startAt`, `timing.endAt`
	 *
	 * Notes:
	 * - Missing values (`null`/`undefined`) are always sorted last (regardless of direction).
	 * - When values are numeric-ish, numeric comparison is used; otherwise string comparison.
	 * - Determinism: ties are broken by `ref` to keep paging stable.
	 *
	 * Pagination (`page`)
	 * - `page` is optional: `{ size?: number, index?: number }`
	 * - `index` is 1-based.
	 * - When `size` is missing or <= 0, paging is disabled and all matching items are returned.
	 *
	 * Return value
	 * - `total`: number of items matching the filter (before paging).
	 * - `pages`: total number of pages (when paging is enabled: `ceil(total/size)`; otherwise `1`).
	 * - `items`: rendered messages in the selected page.
	 *
	 * Validation / exceptions (intentional)
	 * - Enum filters throw when `in` and `notIn` are both provided.
	 * - Includes filters throw when `any` and `all` are both provided.
	 *
	 * @param {object} [options] Query options.
	 * @param {object} [options.where] Filter object.
	 * @param {{ size?: number, index?: number }} [options.page] Optional pagination (1-based index).
	 * @param {Array<{ field: string, dir?: 'asc'|'desc' }>} [options.sort] Optional sort descriptors.
	 * @returns {{ total: number, pages: number, items: Array<object> }} Result page.
	 */
	queryMessages({ where = {}, page = undefined, sort = undefined } = {}) {
		this._pruneOldMessages();

		const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

		const toStringList = v => {
			if (typeof v === 'string' && v.trim()) {
				return [v.trim()];
			}
			if (Array.isArray(v)) {
				return v
					.filter(item => typeof item === 'string')
					.map(item => item.trim())
					.filter(Boolean);
			}
			return [];
		};

		const toNumberList = v => {
			if (typeof v === 'number' && Number.isFinite(v)) {
				return [v];
			}
			if (Array.isArray(v)) {
				return v
					.filter(item => typeof item === 'number' && Number.isFinite(item))
					.map(item => Math.trunc(item));
			}
			return [];
		};

		const get = (obj, path) => {
			const parts = typeof path === 'string' ? path.split('.') : [];
			let cur = obj;
			for (const key of parts) {
				if (!cur || typeof cur !== 'object') {
					return undefined;
				}
				cur = cur[key];
			}
			return cur;
		};

		const getRange = spec => {
			if (typeof spec === 'number' && Number.isFinite(spec)) {
				return { min: spec, max: spec };
			}
			if (!isPlainObject(spec)) {
				return null;
			}
			const min = typeof spec.min === 'number' && Number.isFinite(spec.min) ? spec.min : undefined;
			const max = typeof spec.max === 'number' && Number.isFinite(spec.max) ? spec.max : undefined;
			if (min === undefined && max === undefined) {
				return null;
			}
			return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
		};

		const matchEnum = (value, spec) => {
			if (spec === undefined) {
				return true;
			}
			if (typeof spec === 'string') {
				return value === spec;
			}
			if (!isPlainObject(spec)) {
				return true;
			}
			const allow = toStringList(spec.in);
			const deny = toStringList(spec.notIn);
			if (allow.length > 0 && deny.length > 0) {
				throw new TypeError('queryMessages: enum filter must use either {in} or {notIn}, not both');
			}
			if (allow.length > 0) {
				return allow.includes(value);
			}
			if (deny.length > 0) {
				return !deny.includes(value);
			}
			return true;
		};

		const matchLevel = (value, spec) => {
			if (spec === undefined) {
				return true;
			}
			if (value === undefined || value === null) {
				return false;
			}
			const n = Number(value);
			if (!Number.isFinite(n)) {
				return false;
			}
			if (typeof spec === 'number' && Number.isFinite(spec)) {
				return n == spec;
			}
			if (!isPlainObject(spec)) {
				return true;
			}
			const allow = toNumberList(spec.in);
			const deny = toNumberList(spec.notIn);
			if (allow.length > 0 && deny.length > 0) {
				throw new TypeError('queryMessages: level filter must use either {in} or {notIn}, not both');
			}
			if (allow.length > 0 && !allow.some(x => n == x)) {
				return false;
			}
			if (deny.length > 0 && deny.some(x => n == x)) {
				return false;
			}
			const range = getRange(spec);
			if (range?.min !== undefined && n < range.min) {
				return false;
			}
			if (range?.max !== undefined && n > range.max) {
				return false;
			}
			return true;
		};

		const matchStringIn = (value, spec) => {
			if (spec === undefined) {
				return true;
			}
			const v = typeof value === 'string' ? value : '';
			if (!v) {
				return false;
			}
			if (typeof spec === 'string') {
				return v === spec;
			}
			if (Array.isArray(spec)) {
				const allow = toStringList(spec);
				return allow.length === 0 ? true : allow.includes(v);
			}
			if (!isPlainObject(spec)) {
				return true;
			}
			const allow = toStringList(spec.in);
			return allow.length === 0 ? true : allow.includes(v);
		};

		const matchIncludes = (listValue, spec) => {
			if (spec === undefined) {
				return true;
			}
			const list = Array.isArray(listValue)
				? listValue
						.filter(x => typeof x === 'string')
						.map(x => x.trim())
						.filter(Boolean)
				: [];
			if (list.length === 0) {
				return false;
			}
			if (typeof spec === 'string') {
				return list.includes(spec);
			}
			if (Array.isArray(spec)) {
				const any = toStringList(spec);
				return any.length === 0 ? true : any.some(x => list.includes(x));
			}
			if (!isPlainObject(spec)) {
				return true;
			}
			const any = toStringList(spec.any);
			const all = toStringList(spec.all);
			if (any.length > 0 && all.length > 0) {
				throw new TypeError('queryMessages: includes filter must use either {any} or {all}, not both');
			}
			if (any.length > 0) {
				return any.some(x => list.includes(x));
			}
			if (all.length > 0) {
				return all.every(x => list.includes(x));
			}
			return true;
		};

		const timingKeys = new Set([
			'createdAt',
			'updatedAt',
			'expiresAt',
			'notifyAt',
			'remindEvery',
			'dueAt',
			'startAt',
			'endAt',
		]);
		const matchTiming = (timing, spec = {}) => {
			if (!isPlainObject(spec)) {
				return true;
			}
			for (const [key, rangeSpec] of Object.entries(spec)) {
				if (!timingKeys.has(key)) {
					continue;
				}
				const range = getRange(rangeSpec);
				if (!range) {
					continue;
				}
				const raw = timing?.[key];
				if (raw === undefined || raw === null) {
					return false;
				}
				const v = Number(raw);
				if (!Number.isFinite(v)) {
					return false;
				}
				if (range.min !== undefined && v < range.min) {
					return false;
				}
				if (range.max !== undefined && v > range.max) {
					return false;
				}
			}
			return true;
		};

		const deletedState = this.msgConstants?.lifecycle?.state?.deleted || 'deleted';
		const expiredState = this.msgConstants?.lifecycle?.state?.expired || 'expired';
		const openState = this.msgConstants?.lifecycle?.state?.open || 'open';

		const filter = isPlainObject(where) ? where : {};
		const lifecycleStateSpec = filter?.lifecycle?.state;
		const includeDeletedOrExpired = (() => {
			if (typeof lifecycleStateSpec === 'string') {
				return lifecycleStateSpec === deletedState || lifecycleStateSpec === expiredState;
			}
			if (isPlainObject(lifecycleStateSpec)) {
				const allow = toStringList(lifecycleStateSpec.in);
				return allow.includes(deletedState) || allow.includes(expiredState);
			}
			return false;
		})();

		const selection = this.fullList.filter(msg => {
			if (!msg || typeof msg !== 'object') {
				return false;
			}

			const lifecycleState = msg?.lifecycle?.state || openState;
			if (!includeDeletedOrExpired && (lifecycleState === deletedState || lifecycleState === expiredState)) {
				return false;
			}

			if (!matchLevel(msg.level, filter.level)) {
				return false;
			}
			if (!matchEnum(msg.kind, filter.kind)) {
				return false;
			}
			if (!matchEnum(msg?.origin?.type, filter?.origin?.type)) {
				return false;
			}
			if (!matchEnum(lifecycleState, filter?.lifecycle?.state)) {
				return false;
			}
			if (!matchTiming(msg?.timing, filter?.timing)) {
				return false;
			}
			if (!matchStringIn(msg?.details?.location, filter?.details?.location)) {
				return false;
			}
			if (!matchIncludes(msg?.audience?.tags, filter?.audience?.tags)) {
				return false;
			}
			if (!matchIncludes(msg?.dependencies, filter?.dependencies)) {
				return false;
			}
			return true;
		});

		const total = selection.length;

		const allowedSortFields = new Set([
			'ref',
			'level',
			'kind',
			'origin.type',
			'lifecycle.state',
			'details.location',
			'timing.createdAt',
			'timing.updatedAt',
			'timing.expiresAt',
			'timing.notifyAt',
			'timing.remindEvery',
			'timing.dueAt',
			'timing.startAt',
			'timing.endAt',
		]);

		const sortSpec = Array.isArray(sort) ? sort : [];
		const sorters = sortSpec
			.map(s => {
				const field = typeof s?.field === 'string' ? s.field.trim() : '';
				if (!field || !allowedSortFields.has(field)) {
					return null;
				}
				const dir = typeof s?.dir === 'string' && s.dir.toLowerCase() === 'desc' ? 'desc' : 'asc';
				return { field, dir };
			})
			.filter(Boolean);

		const compare = (a, b) => {
			for (const s of sorters) {
				if (!s) {
					continue;
				}

				const av = get(a, s.field);
				const bv = get(b, s.field);

				// Keep null/undefined last (regardless of direction).
				const aMissing = av === undefined || av === null;
				const bMissing = bv === undefined || bv === null;
				if (aMissing && !bMissing) {
					return 1;
				}
				if (!aMissing && bMissing) {
					return -1;
				}
				if (aMissing && bMissing) {
					continue;
				}

				let delta = 0;
				const an = typeof av === 'number' ? av : Number.isFinite(Number(av)) ? Number(av) : NaN;
				const bn = typeof bv === 'number' ? bv : Number.isFinite(Number(bv)) ? Number(bv) : NaN;

				if (Number.isFinite(an) && Number.isFinite(bn)) {
					delta = an - bn;
				} else {
					const as = String(av);
					const bs = String(bv);
					if (as < bs) {
						delta = -1;
					} else if (as > bs) {
						delta = 1;
					}
				}

				if (delta !== 0) {
					return s.dir === 'desc' ? -delta : delta;
				}
			}

			// Tie-breaker for deterministic output (important for paging).
			const ar = typeof a?.ref === 'string' ? a.ref : '';
			const br = typeof b?.ref === 'string' ? b.ref : '';
			if (ar < br) {
				return -1;
			}
			if (ar > br) {
				return 1;
			}
			return 0;
		};

		const sorted = sorters.length > 0 ? selection.slice().sort(compare) : selection;

		const rawSize = page?.size;
		const rawIndex = page?.index;
		const size = typeof rawSize === 'number' && Number.isFinite(rawSize) ? Math.max(0, Math.trunc(rawSize)) : 0;
		const index = typeof rawIndex === 'number' && Number.isFinite(rawIndex) ? Math.max(1, Math.trunc(rawIndex)) : 1;

		const pages = size > 0 ? Math.ceil(total / size) : 1;
		const sliceStart = size > 0 ? (index - 1) * size : 0;
		const sliceEnd = size > 0 ? sliceStart + size : undefined;
		const items = (size > 0 ? sorted.slice(sliceStart, sliceEnd) : sorted).map(
			msg => this.msgRender?.renderMessage(msg) || msg,
		);

		return { total, pages, items };
	}

	/**
	 * Remove a message by ref.
	 *
	 * Side-effects:
	 * - Performs a soft delete by setting `lifecycle.state="deleted"` (message stays in `fullList` for a retention window).
	 * - Dispatches a `"deleted"` notification event via `MsgNotify`.
	 * - A later hard-delete pass physically removes the message and appends an archive delete snapshot.
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

		// Soft delete Message (do not remove from list yet).
		const ok = this.updateMessage(remove.ref, {
			lifecycle: {
				state: this.msgConstants.lifecycle.state.deleted,
				stateChangedAt: Date.now(),
				stateChangedBy: 'MsgStore',
			},
			timing: { notifyAt: null },
		});
		const deleted = ok ? this.fullList.find(item => item.ref === remove.ref) || remove : remove;

		// Notify plugins (semantic delete).
		this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.deleted, deleted);

		this.adapter?.log?.debug?.(`MsgStore: removed Message '${reference}'`);
		this.adapter?.log?.silly?.(`MsgStore: removed Message '${serializeWithMaps(deleted)}'`);
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
	 * - Soft-expires entries by patching `lifecycle.state="expired"` and clearing `timing.notifyAt`.
	 * - Dispatches a single `"expired"` notification containing the array of affected messages.
	 * - Hard-deletes entries later (after a retention window) and archives a delete snapshot (`event: "purge"`).
	 *
	 * @param {object} [options] Prune options.
	 * @param {boolean} [options.force] When true, bypass the prune interval throttle.
	 * @returns {void}
	 */
	_pruneOldMessages({ force = false } = {}) {
		const now = Date.now();
		// Throttle scans to reduce CPU overhead on frequent reads/writes.
		if (!force && now - this.lastPruneAt < this.pruneIntervalMs) {
			return;
		}
		this.lastPruneAt = now;

		// Determine which entries are expired based on expiresAt.
		const isExpired = item => typeof item?.timing?.expiresAt === 'number' && item.timing.expiresAt < now;
		const expiredState = this.msgConstants.lifecycle.state.expired;
		const deletedState = this.msgConstants.lifecycle.state.deleted;
		const isStateNotExpired = item => item?.lifecycle?.state !== expiredState;
		const removals = this.fullList.filter(
			item => isExpired(item) && isStateNotExpired(item) && item?.lifecycle?.state !== deletedState,
		);

		if (removals.length === 0) {
			this._deleteClosedMessages();
			this._hardDeleteMessages();
			return;
		}

		const expiredNow = [];
		for (const msg of removals) {
			const ok = this.updateMessage(msg.ref, {
				lifecycle: {
					state: expiredState,
					stateChangedAt: now,
					stateChangedBy: 'MsgStore',
				},
				timing: { notifyAt: null },
			});
			expiredNow.push(ok ? this.fullList.find(item => item.ref === msg.ref) || msg : msg);
		}

		// Notify plugins once per prune cycle with the list of removed messages.
		this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.expired, expiredNow);

		this.adapter?.log?.debug?.(`MsgStore: soft-expired Message(s) '${expiredNow.map(msg => msg.ref).join(', ')}'`);
		this.adapter?.log?.silly?.(`MsgStore: soft-expired Message(s) '${serializeWithMaps(expiredNow)}'`);

		this._deleteClosedMessages();
		this._hardDeleteMessages();
	}

	/**
	 * Soft-delete messages that are in `lifecycle.state === "closed"`.
	 *
	 * Closed messages are transitioned to `deleted` via `removeMessage` so they can be removed
	 * later by the regular hard-delete retention logic (`_hardDeleteMessages`).
	 *
	 * @returns {void} No return value.
	 */
	_deleteClosedMessages() {
		const now = Date.now();
		// Throttle scans to reduce CPU overhead on frequent reads/writes.
		if (now - this._lastDeleteClosedAt < this._deleteClosedIntervalMs) {
			return;
		}
		this._lastDeleteClosedAt = now;

		// Determine which entries are due to be deleted.
		const needsDeletion = item => item?.lifecycle?.state === this.msgConstants.lifecycle.state.closed;

		const removals = this.fullList.filter(needsDeletion);

		if (removals.length === 0) {
			return;
		}

		for (const msg of removals) {
			this.removeMessage(msg?.ref);
		}
	}

	/**
	 * Hard-delete messages after the retention window.
	 *
	 * This runs on a throttled interval and permanently removes messages that are already in
	 * `lifecycle.state === deleted|expired` and have been in that state long enough.
	 *
	 * Side effects (best-effort):
	 * - persists the updated `fullList`
	 * - appends an archive entry with `{ event: "purge" }`
	 *
	 * @returns {void}
	 */
	_hardDeleteMessages() {
		const now = Date.now();
		if (now - this._lastHardDeleteAt < this._hardDeleteIntervalMs) {
			return;
		}
		this._lastHardDeleteAt = now;

		// Determine which entries are due to be deleted.
		const needsDeletion = item =>
			(item?.lifecycle?.state === this.msgConstants.lifecycle.state.expired ||
				item?.lifecycle?.state === this.msgConstants.lifecycle.state.deleted) &&
			typeof item?.lifecycle?.stateChangedAt === 'number' &&
			item.lifecycle.stateChangedAt + this._keepDeletedAndExpiredFilesMs <= now;

		const removals = this.fullList.filter(needsDeletion);

		if (removals.length === 0) {
			return;
		}

		this.fullList = this.fullList.filter(item => !needsDeletion(item));
		this.msgStorage.writeJson(this.fullList);

		for (const msg of removals) {
			this.msgArchive?.appendDelete?.(msg, { event: 'purge' });
		}

		this.adapter?.log?.debug?.(`MsgStore: hard-deleted Message(s) '${removals.map(msg => msg.ref).join(', ')}'`);
		this.adapter?.log?.silly?.(`MsgStore: hard-deleted Message(s) '${serializeWithMaps(removals)}'`);
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
	 * - After dispatching `due`, this method also reschedules `timing.notifyAt`:
	 *   - when `timing.remindEvery` is set: move `notifyAt` into the future (now + remindEvery)
	 *   - otherwise: clear `notifyAt` (one-shot behavior)
	 * - Rescheduling uses `updateMessage(..., stealthMode=true)` so it does not bump `updatedAt`
	 *   and does not dispatch `"updated"`.
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

		// Update notifyAt to reschedule notification as needed.
		for (const msg of notifications) {
			const newNotifyAt = Number.isFinite(msg.timing.remindEvery) ? now + msg.timing.remindEvery : null;
			this.updateMessage(msg.ref, { timing: { notifyAt: newNotifyAt } }, true);
		}

		this.adapter?.log?.debug?.(
			`MsgStore: initiated Notification for Message(s) '${notifications.map(msg => msg.ref).join(', ')}'`,
		);
		this.adapter?.log?.silly?.(
			`MsgStore: initiated Notification for Message(s) '${serializeWithMaps(notifications)}'`,
		);
	}
}

module.exports = { MsgStore };
