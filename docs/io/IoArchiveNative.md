# IoArchiveNative (Message Hub IO): native filesystem archive backend

`IoArchiveNative` is the native filesystem implementation of the archive backend contract used by `MsgArchive`.

It writes archive JSONL files directly via Node.js `fs/promises`.

---

## Where it sits in the system

`IoArchiveNative` is instantiated by `IoArchiveResolver` when native mode is selected.

`MsgArchive` calls backend methods through the common contract:

- `init()`
- `appendEntries(...)`
- `readDir(...)`
- `deleteFile(...)`
- `estimateSizeBytes()`
- `runtimeRoot()`

---

## Core responsibilities

1. Ensure native archive root directory exists.
2. Validate native write/read/append capability via probe.
3. Append JSONL event batches efficiently (`fs.appendFile`).
4. Provide retention helpers (`readDir` + `deleteFile`).
5. Provide full recursive size estimation for diagnostics.

---

## Probe behavior

`probe()` performs a real filesystem roundtrip:

1. Create `.probe/` directory under native root.
2. Write one line, read it back.
3. Append second line, read again.
4. Validate both lines are present.
5. Cleanup probe file best-effort.

Failure reasons include:

- missing instance data dir
- read mismatch
- append mismatch
- filesystem exceptions (`native-probe-failed:*`)

---

## Write behavior

`appendEntries(filePath, entries, serializeEntry)`:

- creates target directory lazily (memoized by absolute dir path)
- serializes each entry to one line
- appends a trailing newline
- triggers `onMutated()` callback for archive-size cache invalidation

Because this is native append, it avoids read-modify-rewrite overhead required by ioBroker file API.

---

## Runtime root

`runtimeRoot()` returns the absolute archive root path used for writes.

This value is exposed in archive diagnostics (`MsgArchive.getStatus().runtimeRoot`) and mirrored to admin runtime fields.

---

## Public API

### `new IoArchiveNative({ adapter, baseDir, nativeRootDir, onMutated? })`

Creates the backend instance.

### `init()`

Ensures root directory exists.

### `probe()`

Returns `{ ok, reason }`.

### `appendEntries(filePath, entries, serializeEntry)`

Appends JSONL lines to target file.

### `readDir(dirPath)`

Returns lightweight `{ name, isDir }` entries.

### `deleteFile(filePath)`

Best-effort delete.

### `estimateSizeBytes()`

Recursive byte sum over native root; returns `{ bytes, isComplete }`.

---

## Related files

- Implementation: `lib/IoArchiveNative.js`
- Strategy resolver: `lib/IoArchiveResolver.js`
- Archive consumer: `src/MsgArchive.js`
