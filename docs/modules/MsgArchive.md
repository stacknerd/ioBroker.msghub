# MsgArchive (Message Hub): append-only history for message events

`MsgArchive` is the component that records **what happened to a message over time**.
It is an append-only log (“write once, never change”) that stores lifecycle events such as:

- a message was created
- a message was updated (patched)
- a message was deleted / expired

This archive is meant for **audit/debugging/replay**. It is **not** the primary storage for the current message list
(that job belongs to `MsgStorage`).

In short: if you want a reliable “paper trail” of message changes, it should go through `MsgArchive`.

---

## Where it sits in the system

In normal operation, `MsgStore` triggers archive writes as a **best-effort side effect**:

1. A producer creates a message (usually via `MsgFactory.createMessage()`).
2. `MsgStore.addMessage()` stores it in memory and persists the message list via `MsgStorage`.
3. `MsgStore.addMessage()` calls `msgArchive.appendSnapshot(msg)` to record the initial state (`event: "create"`).
4. Later, `MsgStore.updateMessage()` applies patches and then calls `msgArchive.appendPatch(ref, patch, existing, updated)`.
5. When messages are removed:
   - `MsgStore.removeMessage()` calls `msgArchive.appendDelete(msg)` (`event: "delete"`).
   - `_pruneOldMessages()` calls `msgArchive.appendDelete(msg, { event: "expired" })` for each expired message.

Important: archive writes are usually **not awaited**. The system continues even if archiving fails.

---

## What gets stored (event model)

Each archive entry is one JSON object, written as **one line** (JSONL = JSON Lines).

Every line has the same minimal header:

- `schema_v`: archive schema version (currently `1`)
- `ts`: timestamp (epoch milliseconds)
- `ref`: message ref (the stable message id)
- `event`: event name (e.g. `"create"`, `"patch"`, `"delete"`, `"expired"`)

Depending on the event type, additional fields exist:

### Snapshot events (`appendSnapshot`)

Used to store a full message as it looked at that point in time.

- `snapshot`: the complete message object

Default event name is `"create"`, but it can be overridden (e.g. imports can use `"snapshot"`).

### Patch events (`appendPatch`)

Used to record updates without storing the full message again.

Stored payload:

- `ok: true` (a simple marker that the archive write was attempted with a normalized payload)
- `requested`: the patch the caller wanted to apply
  - if the patch contained `ref` and it matches the message ref, `ref` is removed (to reduce redundancy)
- `added` / `removed` (optional): shallow-ish diffs when `existing` and `updated` were provided
  - arrays are stored as “before”/“after”
  - plain objects are diffed by keys
  - `Map` values (like `metrics`) are diffed by keys and values

### Delete events (`appendDelete`)

Used for deletions and removal-like lifecycle events.

- If you pass a full message object, the archive stores `snapshot` for better traceability.
- If you only pass a ref string, no snapshot is stored.

### Example (JSONL)

Each line is one JSON object:

```json
{"schema_v":1,"ts":123456,"ref":"a/1","event":"create","snapshot":{"ref":"a/1","title":"Hello","text":"..."}}
{"schema_v":1,"ts":123999,"ref":"a/1","event":"patch","ok":true,"requested":{"text":"Updated text"}}
{"schema_v":1,"ts":124500,"ref":"a/1","event":"delete","snapshot":{"ref":"a/1","title":"Hello","text":"Updated text"}}
```

---

## File layout on disk

`MsgArchive` stores **one file per message ref** to keep files small and make manual inspection easy.

- Default directory: `data/archive`
- Default extension: `.jsonl`
- Filename: `<encodeURIComponent(ref)>.jsonl`
  - Example: ref `a/1` becomes `a%2F1.jsonl`

The files live in ioBroker’s file storage under a “meta id” (by default the adapter namespace).

---

## How writing works (batching and ordering)

Archiving is designed to be low impact:

- **Buffered per message**: events are queued per ref file.
- **Flush interval**: queued events are written every `flushIntervalMs` (default `10000ms`).
- **Max batch size**: if more than `maxBatchSize` events are queued for one ref, it flushes immediately.
- **Per-ref ordering**: events for the same ref are written in the exact order they were enqueued.
- **Serialized I/O**: actual storage reads/writes are globally serialized so they don’t overlap.
- **Shutdown support**: `flushPending()` forces a best-effort flush of all buffered events.

### Backend constraint (important)

ioBroker file storage has no “append” API. So an “append” is implemented as:

1. read the full existing file
2. add the new JSONL lines
3. write the full file back

That means appending gets slower as a file grows (roughly **O(file size)** per flush).

---

## Map-safe JSON (why metrics still work)

Some message fields may contain `Map` instances (e.g. `metrics`).
Plain `JSON.stringify()` would lose that type.

`MsgArchive` writes entries through `serializeWithMaps()`, which encodes Maps like this:

- `{ "__msghubType": "Map", "value": [ [key, val], ... ] }`

This keeps the archive readable and makes it possible to restore Maps later.

---

## Action audit (`event: "action"`)

In addition to `"patch"` events (state changes), the archive can also store **action intents** as separate events:

- `"action"`: a consumer attempted to execute an action for a message (and whether it succeeded)

This is meant for **audit/debug/replay**: the resulting state change (if any) will still be visible as a `"patch"` entry,
but `"action"` captures the *intent* and the outcome even when the action is a no-op (idempotent).

Typical stored fields (payload is not strictly enforced):

- `ok: boolean` — whether the action execution succeeded
- `noop?: boolean` — true when the action was accepted but resulted in no patch (idempotent)
- `reason?: string` — failure reason (`"not_allowed"`, `"invalid_payload"`, `"unsupported_type"`, `"patch_failed"`, ...)
- `actionId: string` — executed action id
- `type?: string` — action type (when known)
- `actor?: string|null` — best-effort attribution (matches `lifecycle.stateChangedBy` behavior)
- optional extra fields (example: `forMs`, `notifyAt`, `payload`)

---

## Design guidelines / invariants (the important rules)

- **Append-only log**: archive entries are never edited or removed by `MsgArchive`.
- **One file per ref**: easy to inspect, avoids huge monolithic logs.
- **Best-effort durability**: failures are logged; callers usually do not wait for archive writes.
- **Optional strict mode**: set `{ throwOnError: true }` to make failures reject (useful in tests/debugging).
- **Streaming-friendly format**: JSONL is easy to grep, tail, parse line-by-line, and replay.

---

## Public API (what you call)

### `init()`
Prepares ioBroker file storage (meta object + base directory). Called once during startup.

### `appendSnapshot(message, options)`
Stores a snapshot entry.

- `options.event` (default `"create"`)
- `options.flushNow` (write immediately)
- `options.throwOnError` (reject on error)

### `appendPatch(ref, patch, existing?, updated?, options?)`
Stores a patch entry (requested patch and optional diffs).

- `options.flushNow`
- `options.throwOnError`

### `appendDelete(refOrMessage, options)`
Stores a delete-like entry.

- `options.event` (default `"delete"`, common alternative: `"expired"`)
- `options.flushNow`
- `options.throwOnError`

### `appendAction(ref, action, options)`
Stores an action audit entry (`event: "action"`).

- `options.flushNow`
- `options.throwOnError`

### `flushPending()`
Forces all buffered events to be written as soon as possible (mainly for unload/shutdown flows).
