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
 *   dispatched when `notifyAt <= now` and then rescheduled (via `remindEvery`) or cleared (one-shot).
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
 * - Appends lifecycle events to a per-ref, per-week JSONL archive (default: `data/archive/<refPath>.<YYYYMMDD>.jsonl`).
 *   Dots in the ref create folder levels, except the first `.<digits>` (plugin instance) which stays together (e.g. `IngestHue.0/...`).
 * - Archiving is best-effort and must never block core operations.
 * - Note on naming: archive events default to `"create"|"patch"|"delete"`, while notifications use
 *   `MsgConstants.notfication.events.*` (e.g. `"deleted"` / `"expired"`).
 *
 * Notifications (MsgNotify)
 * - The store does not deliver notifications itself; it only dispatches events to `MsgNotify`, which
 *   forwards them to registered plugins.
 * - Due notifications are one-shot by default: after dispatching `due`, `_initiateNotifications()` clears `timing.notifyAt`
 *   (or moves it to `now + timing.remindEvery` when configured) using a stealth patch.
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

const { serializeWithMaps, shouldDispatchByAudienceChannels } = require(`${__dirname}/MsgUtils`);
const { MsgStorage } = require(`${__dirname}/MsgStorage`);
const { MsgArchive } = require(`${__dirname}/MsgArchive`);
const { MsgRender } = require(`${__dirname}/MsgRender`);
const { MsgNotify } = require(`${__dirname}/MsgNotify`);
const { MsgIngest } = require(`${__dirname}/MsgIngest`);
const { MsgStats } = require(`${__dirname}/MsgStats`);
const { MsgNotificationPolicy } = require(`${__dirname}/MsgNotificationPolicy`);
const { MsgAction } = require(`${__dirname}/MsgAction`);

const _CORE_LIFECYCLE_TOKEN = Symbol('MsgStore.coreLifecycle');

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
	 * @param {number} [options.hardDeleteBatchSize] Max messages hard-deleted per run (default: 50).
	 * @param {number} [options.hardDeleteBacklogIntervalMs] Interval for processing a hard-delete backlog (default: 5000).
	 * @param {number} [options.hardDeleteStartupDelayMs] Delay hard-deletes after startup to reduce I/O spikes (default: 60000).
	 * @param {number} [options.deleteClosedIntervalMs] Interval for checking for closed messages (default: 10000).
	 * @param {object} [options.storage] Options forwarded to `MsgStorage` (e.g. `baseDir`, `fileName`, `writeIntervalMs`).
	 * @param {object} [options.archive] Options forwarded to `MsgArchive` (e.g. `baseDir`, `fileExtension`, `flushIntervalMs`).
	 * @param {object} [options.stats] Options forwarded to `MsgStats` (e.g. `rollupKeepDays`).
	 * @param {any} [options.render] Render-related options forwarded to `MsgRender` (e.g. prefix configuration).
	 * @param {{ enabled: boolean, startMin: number, endMin: number, maxLevel: number, spreadMs: number }} [options.quietHours] Optional quiet-hours configuration (fully normalized by `main.js`).
	 * @param {() => number} [options.quietHoursRandomFn] Optional random function injection (tests).
	 * @param {any} [options.ai] Optional AI helper instance.
	 */
	constructor(adapter, msgConstants, msgFactory, options = {}) {
		const {
			initialMessages = [],
			pruneIntervalMs = 30000,
			notifierIntervalMs = 10000,
			hardDeleteAfterMs = 1000 * 60 * 60 * 24 * 3,
			hardDeleteIntervalMs = 1000 * 60 * 60 * 4,
			hardDeleteBatchSize = 50,
			hardDeleteBacklogIntervalMs = 1000 * 5,
			hardDeleteStartupDelayMs = 1000 * 60,
			deleteClosedIntervalMs = 1000 * 10,
			storage = {},
			archive = {},
			stats = {},
			ai = null,
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
		this.msgRender = new MsgRender(this.adapter, { locale: this.adapter?.locale, render: options?.render || null });

		// Notification dispatcher (plugins register elsewhere).
		this.msgNotify = new MsgNotify(this.adapter, this.msgConstants, { store: this, ai });

		// Producer host for inbound events (plugins register elsewhere).
		this.msgIngest = new MsgIngest(this.adapter, this.msgConstants, this.msgFactory, this, { ai });

		// Canonical in-memory list (do not store rendered output here).
		this.fullList = Array.isArray(initialMessages) ? initialMessages : [];

		// Action executor + view policy (core).
		this.msgActions = new MsgAction(this.adapter, this.msgConstants, this);

		// Stats (read-only insights + rollups).
		this.msgStats = new MsgStats(this.adapter, this.msgConstants, this, stats || {});

		// Pruning and notification timers (timer starts in `init()`).
		this.lastPruneAt = 0;
		this.pruneIntervalMs = pruneIntervalMs;
		this.notifierIntervalMs = notifierIntervalMs;
		this._quietHours = options?.quietHours || null;
		this._quietHoursRandomFn =
			typeof options?.quietHoursRandomFn === 'function' ? options.quietHoursRandomFn : Math.random;
		this._notifyTimer = null;
		this._initialized = false;
		this._keepDeletedAndExpiredFilesMs = hardDeleteAfterMs;
		this._hardDeleteIntervalMs = hardDeleteIntervalMs;
		this._lastHardDeleteAt = 0;
		this._hardDeleteBatchSize =
			typeof hardDeleteBatchSize === 'number' && Number.isFinite(hardDeleteBatchSize)
				? Math.max(1, Math.trunc(hardDeleteBatchSize))
				: 50;
		this._hardDeleteBacklogIntervalMs =
			typeof hardDeleteBacklogIntervalMs === 'number' && Number.isFinite(hardDeleteBacklogIntervalMs)
				? Math.max(0, Math.trunc(hardDeleteBacklogIntervalMs))
				: 1000 * 5;
		this._hardDeleteStartupDelayMs =
			typeof hardDeleteStartupDelayMs === 'number' && Number.isFinite(hardDeleteStartupDelayMs)
				? Math.max(0, Math.trunc(hardDeleteStartupDelayMs))
				: 0;
		this._hardDeleteDisabledUntil = 0;
		this._hardDeleteTimer = null;
		this._hardDeleteTimerDueAt = 0;
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
		await this.msgStats.init();

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
	 * - Dispatches a creation notification:
	 *   - `"added"` when the `ref` was not present in the store
	 *   - `"recreated"` when the `ref` existed only in quasi-deleted states (closed/deleted/expired) and is now replaced
	 *   - `"recovered"` when the `ref` existed only in quasi-deleted states and is recreated within `timing.cooldown`
	 * - If `timing.notifyAt` is missing or not finite, dispatches an immediate `"due"` notification
	 *   (only when `lifecycle.state === "open"` and the recreate cooldown is not active).
	 * - Appends an archive snapshot (best-effort, not awaited).
	 *
	 * @param {object} msg Normalized message object.
	 * @returns {boolean} True when added, false when rejected by guards.
	 */
	addMessage(msg) {
		const isQuasiDeletedState = this.msgConstants.lifecycle.isQuasiDeletedState;
		const ref = typeof msg?.ref === 'string' ? msg.ref.trim() : '';
		const cooldownMs = msg?.timing?.cooldown;
		const wantsCooldownGate = Number.isFinite(cooldownMs) && cooldownMs > 0;

		// For recreate/cooldown semantics we need a snapshot from *before* store maintenance.
		// `_deleteClosedMessages` / `_pruneOldMessages` may update lifecycle.stateChangedAt and would distort the cooldown base.
		let previousQuasiDeletedChangedAt = null;
		if (wantsCooldownGate && ref) {
			for (const candidate of this.fullList) {
				if (candidate?.ref !== ref) {
					continue;
				}
				const state = candidate?.lifecycle?.state;
				const stateChangedAt = candidate?.lifecycle?.stateChangedAt;
				if (!isQuasiDeletedState(state) || !Number.isFinite(stateChangedAt)) {
					continue;
				}
				previousQuasiDeletedChangedAt =
					previousQuasiDeletedChangedAt == null
						? stateChangedAt
						: Math.max(previousQuasiDeletedChangedAt, stateChangedAt);
			}
		}

		// Keep the list clean before inserting anything new.
		this._deleteClosedMessages();
		this._pruneOldMessages();

		// Guards: msg must be a normalized object, with integer level (no numeric strings).
		if (!msg || typeof msg !== 'object') {
			return false;
		}
		if (!ref) {
			return false;
		}
		if (typeof msg.level !== 'number' || !Number.isInteger(msg.level)) {
			return false;
		}

		// Guard: reject duplicates by ref.
		const candidates = this.fullList.filter(item => item?.ref === ref);
		const isRecreate = candidates.length > 0;
		if (isRecreate) {
			const nonReplaceable = candidates.find(item => !isQuasiDeletedState(item?.lifecycle?.state));
			if (nonReplaceable) {
				return false;
			}

			// Hard-delete existing messages with the same ref so the new message can be recreated.
			for (const existing of candidates) {
				this.msgArchive?.appendDelete?.(existing, { event: 'purgeOnRecreate' });
			}
			this.fullList = this.fullList.filter(item => item?.ref !== ref);
		}

		// Mutate canonical list.
		this.fullList.push(msg);

		// Persist the entire list (best-effort; MsgStorage may throttle).
		this.msgStorage.writeJson(this.fullList);

		// Archive the creation for audit/replay. This must not block the store.
		// Note: notification markers (`timing.notifiedAt`) are appended as separate patches after dispatch.
		this.msgArchive?.appendSnapshot?.(msg);

		// Notify about the new entry: truly new vs. recreated vs. recovered (cooldown).
		const now = Date.now();
		const isWithinCooldown =
			isRecreate &&
			wantsCooldownGate &&
			Number.isFinite(previousQuasiDeletedChangedAt) &&
			now < previousQuasiDeletedChangedAt + cooldownMs;
		const createEvent = isRecreate
			? isWithinCooldown
				? this.msgConstants.notfication.events.recovered
				: this.msgConstants.notfication.events.recreated
			: this.msgConstants.notfication.events.added;
		this._dispatchNotify(createEvent, msg);

		// If no future notifyAt exists, treat the message as immediately due.
		const isOpen =
			(msg?.lifecycle?.state || this.msgConstants.lifecycle?.state?.open) ===
			this.msgConstants.lifecycle?.state?.open;
		if (isOpen && !isWithinCooldown && !Number.isFinite(msg?.timing?.notifyAt)) {
			this._dispatchNotify(this.msgConstants.notfication.events.due, msg);
		}
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
	 * @param {any} [_coreToken] Internal token (core only).
	 * @returns {boolean} True when updated, false when rejected by guards or validation.
	 */
	updateMessage(msgOrRef, patch = undefined, stealthMode = false, _coreToken = undefined) {
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
		const updated = factory.applyPatch(existing, msg, stealthMode, {
			allowCoreLifecycleStates: _coreToken === _CORE_LIFECYCLE_TOKEN,
		});
		if (!updated) {
			this.adapter?.log?.warn?.(`MsgStore: '${msg.ref}' could not be updated (validation failed)`);
			return false;
		}

		// Replace the entry and persist.
		this.fullList[index] = updated;
		// Persist the updated list (best-effort; MsgStorage may throttle).
		this.msgStorage.writeJson(this.fullList);

		// Archive patch information for audit and debugging (best-effort).
		// Note: notification markers (`timing.notifiedAt`) are appended as separate patches after dispatch.
		this.msgArchive?.appendPatch?.(msg.ref, msg, existing, updated);

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

		const isClosedTransition = state === this.msgConstants.lifecycle?.state?.closed && state !== existingState;
		if (isClosedTransition) {
			this.msgStats?.recordClosed?.(updated);
		}

		if (hadUpdate && !isSoftDeletedTransition) {
			this._dispatchNotify(this.msgConstants.notfication.events.update, updated);
		}

		// Immediate due semantics (only for non-silent updates and only when not expired).
		const now = Date.now();
		const notExpired = typeof t?.expiresAt !== 'number' || t.expiresAt > now;

		const isOpen =
			(updated?.lifecycle?.state || this.msgConstants.lifecycle?.state?.open) ===
			this.msgConstants.lifecycle?.state?.open;
		if (!Number.isFinite(t?.notifyAt) && hadUpdate && notExpired && isOpen) {
			this._dispatchNotify(this.msgConstants.notfication.events.due, updated);
		}
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
		// Important: treat quasi-deleted entries (deleted/closed/expired) as non-existent so recreate semantics
		// run through `addMessage()` (and dispatch `recreated`/`recovered`).
		if (this.getMessageByRef(msg.ref, 'quasiOpen') != null) {
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
	 * @param {'all'|'quasiDeleted'|'quasiOpen'|string[]|undefined} [filter] Optional lifecycle filter.
	 *  - `'all'`: no lifecycle filtering (current behavior / default)
	 *  - `'quasiDeleted'`: only `deleted|closed|expired`
	 *  - `'quasiOpen'`: only `open|snoozed|acked`
	 *  - `string[]`: explicit allowlist of lifecycle state values (1:1 match)
	 * @returns {object|undefined} Matching message, if found.
	 */
	getMessageByRef(reference, filter = 'all') {
		this._pruneOldMessages();
		const ref = typeof reference === 'string' ? reference.trim() : '';
		if (!ref) {
			return undefined;
		}

		const lifecycle = this.msgConstants.lifecycle || {};
		const isQuasiDeletedState = lifecycle.isQuasiDeletedState;
		const isQuasiOpenState = lifecycle.isQuasiOpenState;

		let matches = null;
		if (Array.isArray(filter)) {
			const set = new Set(
				filter
					.filter(v => typeof v === 'string')
					.map(v => v.trim())
					.filter(Boolean),
			);
			matches = msg => set.has(msg?.lifecycle?.state);
		} else {
			const f = typeof filter === 'string' ? filter.trim().toLowerCase() : '';
			if (!f || f === 'all') {
				matches = () => true;
			} else if (f === 'quasideleted') {
				matches = msg => {
					const state = msg?.lifecycle?.state || lifecycle?.state?.open;
					return typeof isQuasiDeletedState === 'function' ? isQuasiDeletedState(state) : false;
				};
			} else if (f === 'quasiopen') {
				matches = msg => {
					const state = msg?.lifecycle?.state || lifecycle?.state?.open;
					return typeof isQuasiOpenState === 'function' ? isQuasiOpenState(state) : false;
				};
			} else {
				matches = () => true;
			}
		}

		const msg = this.fullList.find(obj => obj?.ref === ref && matches(obj));
		return this._renderForOutput(msg);
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
		return this.fullList.map(msg => this._renderForOutput(msg));
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
	 * - `where.origin.system`
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
	 *   - `createdAt`, `updatedAt`, `expiresAt`, `notifyAt`, `remindEvery`, `timeBudget`, `dueAt`, `startAt`, `endAt`
	 *
	 * Shapes per field:
	 * - Exact number: `where.timing.notifyAt = 1730000000000`
	 * - Range: `where.timing.notifyAt = { min: 1730000000000, max: 1730086400000 }` (inclusive)
	 *
	 * Notes:
	 * - Range implies existence: if a field is missing/null/not a finite number, the message does NOT match.
	 *   (Example: filtering on `notifyAt` will naturally exclude messages where `notifyAt` is unset.)
	 * - `orMissing`: when set on a range object (e.g. `{ max: now, orMissing: true }`), `undefined`/`null` values are treated as a match.
	 *   (Note: non-finite values do NOT count as missing.)
	 * - If a range object only specifies `{ orMissing: true }` (no `min/max`), it matches missing values only.
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
	 * - `orMissing`: when set on an includes object (e.g. `{ any: [...], orMissing: true }`), missing/empty arrays are treated as a match.
	 *   - For `audience.tags`, an empty array (`[]`) is treated as missing.
	 * - If an includes object only specifies `{ orMissing: true }` (no `any/all`), it matches missing/empty arrays only.
	 *
	 * Sort (`sort`)
	 * - `sort` is optional and must be an array of `{ field, dir? }`.
	 * - `dir` defaults to `"asc"`; `"desc"` reverses the order.
	 * - Only the following fields are allowed (others are ignored):
	 *   - `ref`, `title`, `level`, `kind`, `origin.type`, `origin.system`, `lifecycle.state`, `details.location`
	 *   - `timing.createdAt`, `timing.updatedAt`, `timing.expiresAt`, `timing.notifyAt`, `timing.remindEvery`, `timing.timeBudget`,
	 *     `timing.dueAt`, `timing.startAt`, `timing.endAt`
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
				return { min: spec, max: spec, orMissing: false };
			}
			if (!isPlainObject(spec)) {
				return null;
			}
			const min = typeof spec.min === 'number' && Number.isFinite(spec.min) ? spec.min : undefined;
			const max = typeof spec.max === 'number' && Number.isFinite(spec.max) ? spec.max : undefined;
			const orMissing = spec.orMissing === true;
			if (min === undefined && max === undefined && !orMissing) {
				return null;
			}
			return {
				...(min !== undefined ? { min } : {}),
				...(max !== undefined ? { max } : {}),
				orMissing,
			};
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
			const isMissing = list.length === 0;
			if (typeof spec === 'string') {
				return !isMissing && list.includes(spec);
			}
			if (Array.isArray(spec)) {
				const any = toStringList(spec);
				if (any.length === 0) {
					return true;
				}
				return !isMissing && any.some(x => list.includes(x));
			}
			if (!isPlainObject(spec)) {
				return true;
			}
			if (isMissing && spec.orMissing === true) {
				return true;
			}
			if (isMissing) {
				return false;
			}
			const any = toStringList(spec.any);
			const all = toStringList(spec.all);
			if (spec.orMissing === true && any.length === 0 && all.length === 0) {
				return false;
			}
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

		const matchAudienceChannels = (message, spec) => {
			if (spec === undefined) {
				return true;
			}
			if (spec === null) {
				return shouldDispatchByAudienceChannels(message, '');
			}
			if (typeof spec === 'string') {
				return shouldDispatchByAudienceChannels(message, spec);
			}
			if (Array.isArray(spec)) {
				const channels = toStringList(spec);
				return channels.length === 0
					? true
					: channels.some(ch => shouldDispatchByAudienceChannels(message, ch));
			}
			if (!isPlainObject(spec)) {
				return true;
			}
			if (!Object.prototype.hasOwnProperty.call(spec, 'routeTo')) {
				return true;
			}
			return matchAudienceChannels(message, spec.routeTo);
		};

		const timingKeys = new Set([
			'createdAt',
			'updatedAt',
			'expiresAt',
			'notifyAt',
			'remindEvery',
			'timeBudget',
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
					if (range.orMissing === true) {
						continue;
					}
					return false;
				}
				if (range.orMissing === true && range.min === undefined && range.max === undefined) {
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
			if (!matchEnum(msg?.origin?.system, filter?.origin?.system)) {
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
			if (!matchAudienceChannels(msg, filter?.audience?.channels)) {
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
			'title',
			'level',
			'kind',
			'origin.type',
			'origin.system',
			'lifecycle.state',
			'details.location',
			'timing.createdAt',
			'timing.updatedAt',
			'timing.expiresAt',
			'timing.notifyAt',
			'timing.remindEvery',
			'timing.timeBudget',
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
		const items = (size > 0 ? sorted.slice(sliceStart, sliceEnd) : sorted).map(msg => this._renderForOutput(msg));

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
	 * @param {{ actor?: string|null }} [options] Optional attribution.
	 * @returns {boolean} True when a message existed and was removed.
	 */
	removeMessage(reference, options = {}) {
		this._pruneOldMessages();

		// Find the message to remove; if missing, do nothing.
		const remove = this.fullList.filter(obj => {
			return obj.ref === reference;
		})[0];
		if (remove == null) {
			return false;
		}

		const actorProvided =
			options && typeof options === 'object' && !Array.isArray(options)
				? Object.prototype.hasOwnProperty.call(options, 'actor')
				: false;
		const actor = actorProvided
			? typeof options.actor === 'string' && options.actor.trim()
				? options.actor.trim()
				: null
			: 'MsgStore';

		// Soft delete Message (do not remove from list yet).
		const ok = this.updateMessage(
			remove.ref,
			{
				lifecycle: {
					state: this.msgConstants.lifecycle.state.deleted,
					stateChangedBy: actor,
				},
				timing: { notifyAt: null },
			},
			false,
			_CORE_LIFECYCLE_TOKEN,
		);
		const deleted = ok ? this.fullList.find(item => item.ref === remove.ref) || remove : remove;

		// Notify plugins (semantic delete).
		this._dispatchNotify(this.msgConstants.notfication.events.deleted, deleted);

		this.adapter?.log?.debug?.(`MsgStore: removed Message '${reference}'`);
		this.adapter?.log?.silly?.(`MsgStore: removed Message '${serializeWithMaps(deleted)}'`);
		return true;
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
		this.msgNotify?.stop?.({ reason: 'unload' });

		// Stop dispatching due messages to msgNotify
		if (this._notifyTimer) {
			clearInterval(this._notifyTimer);
			this._notifyTimer = null;
		}

		if (this._hardDeleteTimer) {
			clearTimeout(this._hardDeleteTimer);
			this._hardDeleteTimer = null;
			this._hardDeleteTimerDueAt = 0;
		}

		// Best-effort flush of buffered writes.
		this.msgStorage.flushPending();
		this.msgArchive?.flushPending?.();
		this.msgStats?.onUnload?.();
	}

	/**
	 * Schedule a background hard-delete run (best-effort).
	 *
	 * @param {number} delayMs Delay in ms.
	 * @returns {void}
	 */
	_scheduleHardDelete(delayMs) {
		const delay = typeof delayMs === 'number' && Number.isFinite(delayMs) ? Math.max(0, Math.trunc(delayMs)) : 0;
		const dueAt = Date.now() + delay;

		if (this._hardDeleteTimer && this._hardDeleteTimerDueAt && this._hardDeleteTimerDueAt <= dueAt) {
			return;
		}

		if (this._hardDeleteTimer) {
			clearTimeout(this._hardDeleteTimer);
			this._hardDeleteTimer = null;
			this._hardDeleteTimerDueAt = 0;
		}

		this._hardDeleteTimerDueAt = dueAt;
		this._hardDeleteTimer = setTimeout(() => {
			this._hardDeleteTimer = null;
			this._hardDeleteTimerDueAt = 0;
			this._hardDeleteMessages({ force: true });
		}, delay);

		// Do not keep the Node event loop alive (tests / shutdown flows).
		this._hardDeleteTimer?.unref?.();
	}

	/**
	 * Return a JSON-serializable stats snapshot for UI/diagnostics.
	 *
	 * @param {object} [options] Options forwarded to MsgStats.
	 * @returns {Promise<any>} Stats object.
	 */
	async getStats(options = {}) {
		this._pruneOldMessages();
		if (!this.msgStats || typeof this.msgStats.getStats !== 'function') {
			return null;
		}
		return await this.msgStats.getStats(options);
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
			const ok = this.updateMessage(
				msg.ref,
				{
					lifecycle: {
						state: expiredState,
						stateChangedBy: 'MsgStore',
					},
					timing: { notifyAt: null },
				},
				false,
				_CORE_LIFECYCLE_TOKEN,
			);
			expiredNow.push(ok ? this.fullList.find(item => item.ref === msg.ref) || msg : msg);
		}

		// Notify plugins once per prune cycle with the list of removed messages.
		this._dispatchNotify(this.msgConstants.notfication.events.expired, expiredNow);

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

		// Determine which entries are due to be deleted. make sure tey remain at least 30s as "closed" before deleting them
		const needsDeletion = item =>
			item?.lifecycle?.state === this.msgConstants.lifecycle.state.closed &&
			typeof item?.lifecycle?.stateChangedAt === 'number' &&
			item?.lifecycle?.stateChangedAt < now - 1000 * 30;

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
	 * @param {object} [options] Options.
	 * @param {boolean} [options.force] When true, bypass throttling.
	 * @returns {void}
	 */
	_hardDeleteMessages({ force = false } = {}) {
		const now = Date.now();
		if (!force && now - this._lastHardDeleteAt < this._hardDeleteIntervalMs) {
			return;
		}

		// Determine which entries are due to be deleted.
		const needsDeletion = item =>
			(item?.lifecycle?.state === this.msgConstants.lifecycle.state.expired ||
				item?.lifecycle?.state === this.msgConstants.lifecycle.state.deleted) &&
			typeof item?.lifecycle?.stateChangedAt === 'number' &&
			item.lifecycle.stateChangedAt + this._keepDeletedAndExpiredFilesMs <= now;

		if (!this._hardDeleteDisabledUntil && this._hardDeleteStartupDelayMs > 0) {
			this._hardDeleteDisabledUntil = now + this._hardDeleteStartupDelayMs;
		}

		const disabledUntil = this._hardDeleteDisabledUntil || 0;
		if (now < disabledUntil) {
			const hasCandidates = this.fullList.some(needsDeletion);
			if (hasCandidates) {
				this._scheduleHardDelete(disabledUntil - now);
			}
			return;
		}

		this._lastHardDeleteAt = now;

		const removals = [];
		const keep = [];
		let hasBacklog = false;

		for (const item of this.fullList) {
			if (!needsDeletion(item)) {
				keep.push(item);
				continue;
			}

			if (removals.length < this._hardDeleteBatchSize) {
				removals.push(item);
				continue;
			}

			hasBacklog = true;
			keep.push(item);
		}

		if (removals.length === 0) {
			return;
		}

		this.fullList = keep;
		this.msgStorage.writeJson(this.fullList);

		for (const msg of removals) {
			this.msgArchive?.appendDelete?.(msg, { event: 'purge' });
		}

		if (hasBacklog) {
			this._scheduleHardDelete(this._hardDeleteBacklogIntervalMs);
		}

		this.adapter?.log?.debug?.(`MsgStore: hard-deleted Message(s) '${removals.map(msg => msg.ref).join(', ')}'`);
		this.adapter?.log?.silly?.(`MsgStore: hard-deleted Message(s) '${serializeWithMaps(removals)}'`);
	}

	/**
	 * Dispatch due notifications for messages whose `notifyAt` timestamp has been reached.
	 *
	 * Selection logic:
	 * - `timing.notifyAt` must be a number and `<= now`.
	 * - Only messages in `lifecycle.state === "open"|"snoozed"` are eligible.
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

		// Determine which entries are currently due (only open/snoozed messages).
		const openState = this.msgConstants.lifecycle?.state?.open;
		const snoozedState = this.msgConstants.lifecycle?.state?.snoozed;
		const isEligibleState = item => {
			const state = item?.lifecycle?.state || openState;
			return state === openState || state === snoozedState;
		};

		const isDue = item =>
			typeof item?.timing?.notifyAt === 'number' &&
			item.timing.notifyAt <= now &&
			isEligibleState(item) &&
			(typeof item?.timing?.expiresAt !== 'number' || item.timing.expiresAt > now);
		const notifications = this.fullList.filter(isDue);

		if (notifications.length === 0) {
			return;
		}

		this._dispatchNotify(this.msgConstants.notfication.events.due, notifications);

		this.adapter?.log?.debug?.(
			`MsgStore: initiated Notification for Message(s) '${notifications.map(msg => msg.ref).join(', ')}'`,
		);
		this.adapter?.log?.silly?.(
			`MsgStore: initiated Notification for Message(s) '${serializeWithMaps(notifications)}'`,
		);
	}

	/**
	 * Apply store-owned dispatch policies to a message payload.
	 *
	 * Notes:
	 * - This method may apply stealth patches via `updateMessage(..., true)` before dispatch.
	 * - It supports both single-message and list payloads and preserves the input shape.
	 * - For now, only `event === "due"` is handled; other events return the payload unchanged.
	 *
	 * Current policies for `event === "due"`:
	 * - If lifecycle is `snoozed`, patch it back to `open` (stealth).
	 * - If quiet-hours suppression applies (repeat due only), reschedule `timing.notifyAt` into the quiet-hours end (stealth) and suppress dispatch.
	 * - Otherwise, reschedule `timing.notifyAt` based on `timing.remindEvery` (stealth).
	 *
	 * @param {string} event Notification event value (see MsgConstants.notfication.events).
	 * @param {object|Array<object>} payload Message or list of messages.
	 * @returns {object|Array<object>|undefined} Policy-adjusted message payload.
	 */
	_applyMsgPolicy(event, payload) {
		// Normalize event name and decide early whether this policy layer applies.
		const eventName = typeof event === 'string' ? event.trim() : '';
		if (!eventName) {
			return payload;
		}
		const dueEvent = this.msgConstants.notfication?.events?.due;
		if (eventName !== dueEvent) {
			return payload;
		}

		// Normalize payload shape (accept single message or list) and preserve it on return.
		const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
		if (list.length === 0) {
			return payload;
		}

		// Policy context: these are store-owned semantics and are applied immediately before dispatch.
		const now = Date.now();
		const openState = this.msgConstants.lifecycle?.state?.open;
		const snoozedState = this.msgConstants.lifecycle?.state?.snoozed;
		const quietHours = this._quietHours;
		const dispatchables = [];
		for (const msg of list) {
			// Dispatch policy only applies to persisted messages (must have a stable ref).
			const ref = typeof msg?.ref === 'string' ? msg.ref.trim() : '';
			if (!ref) {
				continue;
			}

			let suppressDispatch = false;
			const patch = {};

			// Snooze elapsed: due messages should become "open" again, regardless of quiet hours.
			if (msg?.lifecycle?.state === snoozedState) {
				patch.lifecycle = { state: openState, stateChangedBy: 'MsgStore' };
			}

			// Quiet hours: suppress repeats only (first due is still delivered).
			const hasNotifyAt = Number.isFinite(msg?.timing?.notifyAt);
			const lastDue = msg?.timing?.notifiedAt?.due;
			const isRepeatDue = Number.isFinite(lastDue) && lastDue > 0;
			if (hasNotifyAt && isRepeatDue && MsgNotificationPolicy.shouldSuppressDue({ msg, now, quietHours })) {
				// Suppressed: keep the message due, but move notifyAt out of the quiet window.
				const nextNotifyAt = MsgNotificationPolicy.computeQuietRescheduleTs({
					now,
					quietHours,
					randomFn: this._quietHoursRandomFn,
				});
				if (Number.isFinite(nextNotifyAt)) {
					patch.timing = { ...(patch.timing || {}), notifyAt: nextNotifyAt };
				}
				suppressDispatch = true;
			} else {
				// Not suppressed: after dispatch, reschedule the next repeat (or clear for one-shot).
				const remindEvery = msg?.timing?.remindEvery;
				const hasRemindEvery = Number.isFinite(remindEvery) && remindEvery > 0;
				const hasNotifyAt = Number.isFinite(msg?.timing?.notifyAt);
				if (hasNotifyAt || hasRemindEvery) {
					const newNotifyAt = hasRemindEvery ? now + remindEvery : null;
					patch.timing = { ...(patch.timing || {}), notifyAt: newNotifyAt };
				}
			}

			// Apply the collected patch as a single stealth update (no updatedAt bump / no "updated" event).
			const hasPatch = Object.keys(patch).length > 0;
			if (hasPatch) {
				this.updateMessage(ref, patch, true);
			}

			// Quiet hours suppression means "reschedule only" (nothing to dispatch right now).
			if (suppressDispatch) {
				continue;
			}

			// Dispatch should reflect the canonical, patched store view (snoozed->open, rescheduled notifyAt, ...).
			// Only re-read from the store when we actually applied a patch.
			if (hasPatch) {
				dispatchables.push(this.fullList.find(item => item?.ref === ref) || msg);
			} else {
				dispatchables.push(msg);
			}
		}

		// Preserve the caller's input shape (single in -> single out; list in -> list out).
		return Array.isArray(payload) ? dispatchables : dispatchables[0];
	}

	/**
	 * Dispatch notifications via MsgNotify using a rendered (view-only) message payload.
	 *
	 * Invariants:
	 * - Notify always receives rendered message views.
	 * - Archive/persistence always receive raw canonical messages.
	 *
	 * @param {string} event Notification event value (see MsgConstants.notfication.events).
	 * @param {object|Array<object>} payload Message or list of messages.
	 */
	_dispatchNotify(event, payload) {
		if (!this.msgNotify?.dispatch) {
			return;
		}

		const toBeDispatched = this._applyMsgPolicy(event, payload);
		const list = Array.isArray(toBeDispatched) ? toBeDispatched : toBeDispatched ? [toBeDispatched] : [];
		if (list.length === 0) {
			return;
		}

		const rendered = Array.isArray(toBeDispatched)
			? toBeDispatched.map(msg => this._renderForOutput(msg))
			: this._renderForOutput(toBeDispatched);

		this.msgNotify.dispatch(event, rendered);

		// Append a core-managed notification marker after dispatch.
		// This is best-effort and uses a stealth patch (no updatedAt bump, no updated-event).
		const eventKey = typeof event === 'string' ? event.trim() : '';
		if (!eventKey) {
			return;
		}
		const now = Date.now();
		for (const msg of list) {
			const ref = typeof msg?.ref === 'string' ? msg.ref.trim() : '';
			if (!ref) {
				continue;
			}
			this.updateMessage(ref, { timing: { notifiedAt: { [eventKey]: now } } }, true);
		}
	}

	/**
	 * Render a view-only output message and apply the MsgAction view policy.
	 *
	 * This is intentionally a small boundary helper:
	 * - Store remains canonical (`this.fullList` is never mutated here).
	 * - All "rendered outputs" apply the same action filtering contract:
	 *   - `actions` only contains executable actions
	 *   - `actionsInactive` (optional) contains the rest
	 *
	 * @param {object|undefined} msg Raw canonical message.
	 * @returns {object|undefined} Rendered output view.
	 */
	_renderForOutput(msg) {
		const rendered = this.msgRender?.renderMessage(msg) || msg;
		const buildActions = this.msgActions?.buildActions;
		return typeof buildActions === 'function' ? buildActions.call(this.msgActions, rendered) : rendered;
	}
}

module.exports = { MsgStore };
