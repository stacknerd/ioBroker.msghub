# IoArchiveIobroker (Message Hub IO): ioBroker file-API archive backend

`IoArchiveIobroker` is the ioBroker file storage implementation of the archive backend contract used by `MsgArchive`.

It is the compatibility backend and fallback strategy when native archive mode is unavailable or explicitly downgraded.

---

## Where it sits in the system

`IoArchiveIobroker` is selected by `IoArchiveResolver` when:

- effective strategy is `iobroker`, or
- native probing fails and no strict native lock is enforced.

It runs below `MsgArchive` and hides ioBroker file API details.

---

## Core responsibilities

1. Ensure ioBroker meta root and base directory exist.
2. Append archive events via read-modify-write semantics.
3. Provide directory listing and best-effort delete for retention cleanup.
4. Estimate archive size from ioBroker directory metadata.
5. Expose runtime root descriptor (`iobroker-file-api://...`) for diagnostics.

---

## Important backend constraint

ioBroker file API has no append primitive.

So `appendEntries(...)` is implemented as:

1. read full file text
2. trim trailing whitespace
3. append new JSONL lines in memory
4. overwrite full file

This is functionally correct but can be slower for large files versus native append.

---

## Directory preparation and meta root

`init()` performs:

- `ensureMetaObject(...)`: creates/validates meta object type=`meta`
- `ensureBaseDir(...)`: best-effort mkdir chain below configured base dir

If an object with the same id exists but is not `meta`, initialization throws with a clear remediation message.

---

## Probe semantics

`probe()` always returns negative (`{ ok:false, reason:'not-native-backend' }`).

This method exists to satisfy a consistent backend surface; native capability checks are handled by `IoArchiveNative`.

---

## Public API

### `new IoArchiveIobroker({ adapter, metaId, baseDir, fileExtension, onMutated? })`

Creates the backend instance.

### `init()`

Ensures storage root.

### `runtimeRoot()`

Returns `iobroker-file-api://<metaId>/<baseDir>`.

### `appendEntries(filePath, entries, serializeEntry)`

Reads file, appends lines, writes file back.

### `readDir(dirPath)`

Returns normalized directory entry list.

### `deleteFile(filePath)`

Best-effort delete via `delFileAsync`/`unlinkAsync`.

### `estimateSizeBytes()`

Best-effort recursive size estimate from `readDirAsync(...).stats.size`.

---

## Related files

- Implementation: `lib/IoArchiveIobroker.js`
- Strategy resolver: `lib/IoArchiveResolver.js`
- Archive consumer: `src/MsgArchive.js`
