# MsgStorage (Message Hub): persist and load the message list

`MsgStorage` is a small helper that saves and loads Message Hub data using ioBroker’s file storage.
In practice it usually persists **the full message list** (for example `Array<Message>`) into a single JSON file so
messages survive adapter restarts.

The main idea is simple:

- `MsgStore` keeps messages in memory while the adapter is running.
- `MsgStorage` writes that in-memory state to disk (best-effort, often throttled).
- On startup, `MsgStore` can restore its initial state by reading the file.

---

## Where it sits in the system

A typical (simplified) flow looks like this:

1. A producer (usually a plugin in `lib/`) creates or updates a message.
2. `MsgStore` mutates its canonical in-memory list (`fullList`).
3. `MsgStore` calls `msgStorage.writeJson(fullList)` (fire-and-forget).
4. On restart, the adapter reads the file via `msgStorage.readJson(fallback)` to get the last known list.

Important: `MsgStorage` is not a database. It does not merge partial updates. It stores one complete JSON document.

---

## What exactly is stored?

By default `MsgStorage` writes a file called `messages.json`. In Message Hub it is typically configured as:

- `baseDir: "data"` → file path becomes `data/messages.json`
- `metaId: adapter.namespace` → ioBroker storage namespace

The file content is JSON, but with one special feature:

- If your data contains `Map` instances (for example message `metrics`), they are encoded in a safe JSON form and
  revived back into real `Map` objects when reading.

This is important because plain JSON would otherwise turn a `Map` into something else (or lose information).

---

## Core responsibilities

`MsgStorage` mainly does three things:

1. **Persist one JSON document**
   - Usually “the whole current state” (like the full message list).
   - Writes are queued so concurrent calls do not corrupt each other.

2. **Read with safe fallback behavior**
   - Missing file, empty file, or invalid JSON are treated as “no data”.
   - The caller provides a `fallback` value (often `[]`).

3. **Reduce write noise**
   - Writes can be throttled (default: one write at most every 10 seconds).
   - During the throttle window only the **latest** value is persisted (“last write wins”).

---

## Design guidelines / invariants (the important rules)

### 1) Single file, whole-document persistence
Callers are expected to persist the complete document (for Message Hub: the full message list).
There is no partial update format and no automatic merging.

### 2) Best-effort durability (non-blocking by default)
`MsgStore` does not await persistence because message handling should remain responsive.
If you need a best-effort “final write” (for example on shutdown), call `flushPending()`.

### 3) Ordered I/O (serialized operations)
All reads and writes go through an internal operation queue.
This makes the outcome predictable: the last scheduled write wins.

### 4) Map-safe JSON
Data is serialized via `serializeWithMaps()` and revived via `deserializeWithMaps()`.
That preserves `Map` fields like message metrics.

### 5) Atomic writes when possible
If the adapter provides `renameFileAsync`, `MsgStorage` writes via a temp file and then renames:

1. write `<file>.tmp`
2. delete old target (best-effort)
3. rename tmp → target

If rename is not available (or fails), it falls back to writing the target file directly.

---

## Public API (what you call)

### `init()`
Prepares ioBroker file storage:

- Ensures the “meta” object exists for `metaId`.
- Ensures the `baseDir` folder exists (if configured).

### `readJson(fallback = null)`
Reads and parses the JSON document.

Behavior:

- Returns `fallback` when the file is missing, empty/whitespace, or invalid.
- Revives `Map` instances that were written by `writeJson()`.

### `writeJson(value)`
Schedules a write of the JSON document.

Behavior:

- If `writeIntervalMs === 0`, the write is queued and executed immediately.
- Otherwise, writes are throttled and coalesced: multiple calls within the interval become one write of the latest value.
- Returns a promise that resolves when the scheduled write actually finished.
  (During a throttle window, multiple calls share the same promise.)

### `flushPending()`
Forces a pending throttled write to happen immediately.

This is mainly used during adapter unload/shutdown to persist the latest state.

---

## Configuration (constructor options)

`new MsgStorage(adapter, options)` supports:

- `metaId` (default: `adapter.namespace`) — ioBroker file namespace root
- `baseDir` (default: `""`) — folder under `metaId` (slashes are trimmed)
- `fileName` (default: `"messages.json"`)
- `writeIntervalMs` (default: `10000`) — throttle window (`0` disables throttling)

---

## Practical guidance

- Call `init()` once during startup (it’s async).
- Use `readJson([])` to get a clean empty state when no file exists yet.
- Treat `writeJson()` as best-effort; do not rely on it for immediate durability.
- Call `flushPending()` in unload/shutdown paths if you want the latest state persisted.

---

## Related files

- Implementation: `src/MsgStorage.js`
- Tests (behavior examples): `src/MsgStorage.test.js`
- Integration point: `src/MsgStore.js` (calls `writeJson(fullList)` and `flushPending()` on unload)
- Map serialization helpers: `src/MsgUtils.js` (`serializeWithMaps`, `deserializeWithMaps`, `createOpQueue`)
