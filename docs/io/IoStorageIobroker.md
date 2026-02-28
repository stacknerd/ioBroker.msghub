# IoStorageIobroker (Message Hub IO): ioBroker storage backend for `MsgStorage`

`IoStorageIobroker` implements the storage backend contract consumed by `MsgStorage`.

It persists whole-document JSON files (for example `data/messages.json` and `data/stats-rollup.json`) in ioBroker file storage.

---

## Where it sits in the system

`MsgStorage` depends on an abstract backend contract.

At adapter startup, `main.js` injects `IoStorageIobroker` as backend factory for:

- message list persistence (`messages.json`)
- stats rollup persistence (`stats-rollup.json`)

This keeps `src/MsgStorage.js` platform-agnostic.

---

## Core responsibilities

1. Ensure ioBroker meta root and base directory exist.
2. Provide path mapping (`filePathFor`) below configured base dir.
3. Read file content as UTF-8 text.
4. Write content directly or atomically (tmp + rename when supported).
5. Expose runtime root descriptor for diagnostics.

---

## Atomic write behavior

`writeTextAtomic(filePath, text)` prefers tmp+rename when `renameFileAsync` is available:

1. write `<file>.tmp`
2. best-effort delete existing target
3. rename tmp -> target
4. cleanup tmp best-effort

Fallback:

- if rename API is unavailable or fails, it writes target directly and reports mode `override`/`fallback`.

This mode is surfaced in `MsgStorage.getStatus().lastPersistedMode`.

---

## Meta object safeguards

`ensureMetaObject(...)` enforces that storage root object type is `meta`.

If an object id collision exists with a non-meta type, it throws with guidance to pick another id or rename/delete the existing object.

---

## Public API

### `new IoStorageIobroker({ adapter, metaId?, baseDir? })`

Creates backend instance.

### `init()`

Ensures meta root and base directory.

### `filePathFor(fileName)`

Returns relative storage path below `metaId`.

### `readText(filePath)`

Reads file and returns UTF-8 string.

### `writeText(filePath, text)`

Direct overwrite write; returns `{ mode:'override', bytes }`.

### `writeTextAtomic(filePath, text)`

Atomic-or-fallback write; returns `{ mode, bytes }`.

### `deleteFile(filePath)`

Best-effort delete via `delFileAsync`/`unlinkAsync`.

### `runtimeRoot()`

Returns `iobroker-file-api://<metaId>/<baseDir>`.

---

## Related files

- Implementation: `lib/IoStorageIobroker.js`
- Core storage consumer: `src/MsgStorage.js`
- Store wiring: `src/MsgStore.js`
- Startup injection: `main.js`
