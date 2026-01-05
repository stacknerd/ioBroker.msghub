# MsgStore (Message Hub): canonical list + side effects

`MsgStore` is Message Hub’s central “memory”: it holds the **canonical list of all messages in RAM**.
Anything that **adds, changes, or removes** a message should go through this store.

At the same time, `MsgStore` coordinates the most important side effects: **persisting**, **archiving**, and
**triggering notifications** – without blocking the core mutation.

---

## Where it sits in the system

A simplified flow:

1. A producer plugin (usually in `lib/`) observes events (ioBroker state/object change, import, automation, …).
2. The plugin builds a raw payload.
3. `MsgFactory.createMessage()` turns that into a **valid, normalized** `Message` (or rejects it).
4. `MsgStore.addMessage()` stores it in the canonical list and triggers side effects (persist/archive/notify).
5. Later changes go through `MsgStore.updateMessage()`, which validates updates **via `MsgFactory.applyPatch()`**.

Important: `MsgStore` does not define “how patching works” – `MsgFactory.applyPatch()` is the single source of truth.

---

## What exactly does the store “store”?

Internally, the store keeps a list: `this.fullList`.

- This is the **raw message**, exactly as it is stored/persisted.
- For output (e.g. UI), reads return a **rendered view** so placeholders like `{{m.temperature}}` can be resolved.
  That rendering happens via `MsgRender` and is **not written back** into `fullList`.

Practical result: the canonical list stays stable and “clean”, and rendering is a pure output step.

---

## Core responsibilities

`MsgStore` is responsible for:

1. **Owning and mutating the canonical list**
   - `fullList` is only changed here (single-writer).

2. **Providing a small, clear write API**
   - `addMessage`, `updateMessage`, `removeMessage`, `addOrUpdateMessage`

3. **Reading as a view (not as mutation)**
   - `getMessageByRef`, `getMessages`, `queryMessages`

4. **Lifecycle maintenance**
   - removing expired messages (`expiresAt`)
   - cleaning up completed messages (`closed` → `deleted` → hard-delete)
   - dispatching due notifications (`notifyAt`, optionally via a timer)

---

## Design guidelines / invariants (the important rules)

### 1) Canonical vs. view
- `fullList` contains raw data only.
- Rendering (`MsgRender.renderMessage`) happens only at the boundary (read methods).

### 2) Side effects are best-effort
Persistence/archiving/notifications must not block the core mutation.
That’s why these steps are called “fire-and-forget” (not `await`-required). Errors are handled inside the components
or via adapter logging.

### 2.1) Initialization is explicit (`await store.init()`)
Construction is intentionally synchronous (no I/O). To avoid duplicate `"create"` events after restarts, the adapter
should `await msgStore.init()` during `onReady` before producer plugins start. This hydrates `fullList` from
`MsgStorage` (default: `data/messages.json`).

### 3) Updates are defined by `MsgFactory.applyPatch()`
The store only does minimal guards (adapter/constants/factory presence, reasonable `ref`, integer-level guard on `addMessage`).
All schema validation, normalization, and patch semantics live in `MsgFactory`.

### 4) Notification scheduling is intentionally simple
`MsgStore` does not “schedule” notifications like a job runner. It only checks: **is `notifyAt` reached?**
If a message is due (`notifyAt <= now`), `_initiateNotifications()` dispatches `"due"` and then **reschedules**:

- if `timing.remindEvery` is set: `notifyAt = now + remindEvery`
- otherwise: `notifyAt` is cleared (one-shot)

Note: rescheduling uses a silent store patch (`stealthMode`), so it does not produce `"updated"` events (but the change is still persisted and archived).

### 5) Ordering is predictable
When a mutation succeeds, the store updates `fullList` first and then triggers persist/notify/archive,
so downstream consumers observe the post-mutation state.

---

## Persistence: `MsgStorage` (messages.json)

`MsgStore` persists the **entire list** as one JSON document (default: `data/messages.json`).

- Writes are not awaited (best-effort).
- `MsgStorage` serializes I/O internally and may throttle/coalesce writes.
- On shutdown, `MsgStore.onUnload()` calls `flushPending()` to best-effort persist the latest state.

---

## Archive: `MsgArchive` (JSONL per message)

In addition to the current list, there is an append-only archive log (default: `data/archive/<refPath>.<YYYYMMDD>.jsonl`).

- One file per `ref` **and week segment**, so files stay small and are easy to inspect.
- `ref` is URL-encoded (`encodeURIComponent`) to avoid problematic characters.
- Dots in the (encoded) ref create folder levels, except the first `.<digits>` segment (plugin instance) which stays together (e.g. `IngestHue.0/...`).
- `YYYYMMDD` is the **local-week segment start** (Monday 00:00, local time).
- Retention is controlled via `keepPreviousWeeks` (keep current + N previous week segments).
- Typical archive events: `"create"`, `"patch"`, `"delete"`
- Expiration is recorded as a `"patch"` (setting `lifecycle.state="expired"`), and later hard-delete is recorded as a `"delete"` event with `{ event: "purge" }`.
- When recreating a message with an already-used `ref` (see `addMessage` below), the replaced message is hard-removed and archived with `{ event: "purgeOnRecreate" }`.

Naming note: notification events (e.g. `"deleted"`, `"expired"`) come from `MsgConstants.notfication.events.*`
and are not identical to the archive event names.

---

## Notifications: `MsgNotify` (event dispatch to plugins)

`MsgStore` does not deliver notifications “by itself”. Instead, it dispatches events to `MsgNotify`,
and `MsgNotify` fans those out to registered notifier plugins.

Important semantics:

- There is **no** “already notified” flag in the store.
- Naming note: the notification event `"due"` refers to `timing.notifyAt` only and is intentionally independent from domain timing (`timing.dueAt` / `timing.startAt`).
- “Due” (notification) means: `timing.notifyAt <= now` (and not expired).
- Due messages are re-sent as `"due"` on every polling tick as long as they remain due.

When does the store dispatch?

- `addMessage(msg)`
  - Dispatch `"added"` for the newly created message.
  - If `timing.notifyAt` is missing/not finite **and** `lifecycle.state === "open"`: dispatch `"due"` immediately (message is “due now”).
- `updateMessage(...)`
  - Dispatch `"updated"` only when the update is non-silent (detected by a change in `timing.updatedAt`).
  - Additionally dispatch `"due"` when:
    - the update is non-silent,
    - `notifyAt` is missing/not finite,
    - `lifecycle.state === "open"`,
    - and the message is not expired.
- `_initiateNotifications()` (optional timer)
  - Dispatches `"due"` as a batch for all messages whose `notifyAt` has been reached.
  - Then reschedules/clears `notifyAt` based on `timing.remindEvery` (one-shot vs repeat).

---

## Ingest: `MsgIngest` (host for producer plugins)

`MsgStore` does not interpret ioBroker events itself. Instead, it holds an instance of `MsgIngest`,
which forwards events to producer plugins.

Typical:

- The adapter receives a `stateChange`/`objectChange`.
- The adapter calls `msgStore.msgIngest.dispatchStateChange(...)` / `dispatchObjectChange(...)`.
- The producer decides whether to create a new message or patch an existing one.
- Writes happen only through the store API (plugins get a “facade”, not the internal fields).

---

## Lifecycle: expiration / pruning

Messages can have an expiry timestamp: `timing.expiresAt` (Unix ms).

- If `expiresAt < now`, the message is considered expired.
- `_pruneOldMessages()` soft-expires messages by patching `lifecycle.state = "expired"` (throttled via `pruneIntervalMs`).
- Side effects when expiring messages:
  - clear `timing.notifyAt` (no further due handling)
  - dispatch `"expired"` via `MsgNotify` (as an array of expired messages)
  - keep the message in the list for a retention window, then hard-delete later (`purge`)

### Closed messages (completed)

Messages in `lifecycle.state === "closed"` are treated as completed.
To keep the store bounded over time:

- `_deleteClosedMessages()` periodically soft-deletes them via `removeMessage(ref)` (so they become `lifecycle.state="deleted"`).
- After `hardDeleteAfterMs` the regular hard-delete pass removes them from the list and archives a `{ event: "purge" }` delete.
  - To reduce restart spikes, hard-deletes can be delayed during startup and processed in batches (see options below).

---

## Public API (what you typically use)

### `addMessage(msg): boolean`
Adds a new message if its `ref` does not exist yet.

- Expectation: `msg` is already normalized (typically via `MsgFactory.createMessage()`).
- Guard: `level` must be a real integer number (numeric strings like `"10"` are rejected).
- `ref` handling:
  - If `ref` is unused: message is added.
  - If a message with the same `ref` exists and is `deleted` / `expired` / `closed`: the existing entry is replaced (hard-removed) and the new message is added (recreate).
  - Otherwise: the call is rejected (`false`).
- Triggers: persist + archive + `"added"` + maybe an immediate `"due"`.

### `updateMessage(ref, patch)` / `updateMessage({ ref, ...patch }): boolean`
Updates an existing message by delegating to `MsgFactory.applyPatch()`.

- Guard: `ref` must be present and must exist.
- Non-silent updates trigger `"updated"` (detected via `timing.updatedAt`).
- May also trigger `"due"` (see notification semantics above).
- `updateMessage(ref, patch, stealthMode=true)` applies a silent patch (no `updatedAt` bump ⇒ no `"updated"` event).

### `addOrUpdateMessage(msg): boolean`
Convenience upsert: updates when `ref` exists, otherwise `addMessage`.

### `removeMessage(ref, { actor? }): boolean`
Removes a message when it exists.

- Semantics: soft-delete (`lifecycle.state = "deleted"`, clears `timing.notifyAt`), stores `actor` as `lifecycle.stateChangedBy`, and dispatches `"deleted"`.
- Hard-delete (purge) happens later after a retention window and appends an archive delete snapshot.

### Read APIs
- `getMessageByRef(ref)`
- `getMessages()`
- `queryMessages({ where, page?, sort? })`

All read methods:
- run throttled pruning
- return rendered views when `MsgRender` is available

#### `queryMessages` filters (selected)

`where` is a partial message-like object that supports a small set of filter operators.

Frequently used filters:

- `where.audience.tags`: includes filter (`string | string[] | { any } | { all }`)
- `where.audience.channels`: routing filter (same semantics as channel dispatch in `IoPlugins`)
  - `{ routeTo: string }` (or shorthand `string`): “would this message be dispatched to this plugin channel?”
  - `string[]`: matches when it would dispatch to **any** of the given channels
  - `routeTo: ""`: matches only “unscoped” messages (where `audience.channels.include` is empty)
  - `routeTo: "all"` (or `routeTo: "*"`): matches all messages (match-all)

---

## Configuration (constructor options)

When creating `MsgStore`, you can pass options:

- `initialMessages` (default `[]`): initial in-memory list (primarily for tests/imports)
- `pruneIntervalMs` (default `30000`): maximum frequency for expiration scans
- `notifierIntervalMs` (default `10000`, `0` disables): polling interval for due notifications (`notifyAt`)
- `hardDeleteAfterMs` (default `259200000` / 3 days): retention window before hard-delete for `deleted`/`expired` messages
- `hardDeleteIntervalMs` (default `14400000` / 4 hours): how often the store checks for hard-deletes
- `hardDeleteBatchSize` (default `50`): max number of messages hard-deleted per run (backlogs are processed over multiple runs)
- `hardDeleteBacklogIntervalMs` (default `5000`): delay between hard-delete runs while a backlog exists
- `hardDeleteStartupDelayMs` (default `60000`): delay after startup before the first hard-delete run (reduces I/O spikes)
- `deleteClosedIntervalMs` (default `10000`): how often the store soft-deletes `closed` messages
- `storage`: options forwarded to `MsgStorage` (e.g. `baseDir`, `fileName`, `writeIntervalMs`)
- `archive`: options forwarded to `MsgArchive` (e.g. `baseDir`, `fileExtension`, `flushIntervalMs`)

---

## Shutdown / `onUnload()`

On adapter unload, call `MsgStore.onUnload()` (best-effort). It:

- stops producer plugins (`msgIngest.stop(...)`)
- stops the notification timer
- flushes pending writes in `MsgStorage` and `MsgArchive`

---

## Related files

- Implementation: `src/MsgStore.js`
- Validation/patch semantics: `src/MsgFactory.js` and `src/MsgFactory.md`
- Persistence: `src/MsgStorage.js`
- Archive: `src/MsgArchive.js`
- Notifications: `src/MsgNotify.js`
- Rendering (view): `src/MsgRender.js`
- Producer host: `src/MsgIngest.js`
