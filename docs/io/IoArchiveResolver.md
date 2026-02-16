# IoArchiveResolver (Message Hub IO): runtime strategy resolver for archive writes

`IoArchiveResolver` decides which archive backend is active at runtime:

- native filesystem (`IoArchiveNative`)
- ioBroker file API (`IoArchiveIobroker`)

It also returns diagnostics metadata consumed by `MsgArchive`, Admin commands, and jsonConfig runtime fields.

---

## Where it sits in the system

`main.js` calls `IoArchiveResolver.resolveFor(...)` during startup and injects the returned backend factory into `MsgStore`:

1. Resolve effective strategy from config lock + probe result.
2. Build `createStorageBackend(...)` for the chosen strategy.
3. Pass `archiveRuntime` diagnostics into `MsgArchive`.

This keeps `src/MsgArchive.js` independent from platform-specific probing logic.

---

## Core responsibilities

1. Resolve archive strategy (`native` vs `iobroker`) using deterministic rules.
2. Run native probe checks before selecting native mode.
3. Enforce strict lock semantics for `archiveEffectiveStrategyLock='native'`.
4. Return status metadata (`effectiveStrategy`, `reason`, `nativeProbeError`, `writeDisabled`).
5. Provide a single backend factory abstraction for core usage.

---

## Resolution rules

### No lock configured (`archiveEffectiveStrategyLock=""`)

- Probe native backend.
- Probe success: use `native` (`effectiveStrategyReason='auto-native-first'`).
- Probe failure: use `iobroker` (reason reflects probe failure).

### Lock set to `iobroker`

- Always use `iobroker`.
- Reason defaults to `manual-downgrade` (or configured lock reason).

### Lock set to `native`

- Probe native backend.
- Probe success: use `native` (`manual-upgrade` or configured lock reason).
- Probe failure: keep effective strategy as `native` but enable **writeDisabled** mode.

Important: in locked-native probe-failure mode there is no silent fallback to ioBroker writer.

---

## Strict native lock behavior

When lock=`native` and native probe fails, the resolver returns a disabled-native backend:

- `appendEntries()` throws on write attempts.
- `readDir()` returns empty list.
- `estimateSizeBytes()` returns unknown/incomplete.

Purpose: avoid writing archives into another storage world while user expects native mode.

---

## Public API

### `IoArchiveResolver.resolveFor(options)`

Returns:

- `createStorageBackend(onMutated?)`
- `archiveRuntime` object:
  - `configuredStrategyLock`
  - `effectiveStrategy`
  - `effectiveStrategyReason`
  - `nativeRootDir`
  - `nativeProbeError`
  - `writeDisabled`

### `IoArchiveResolver.probeNativeFor(options)`

Runs a native probe only and returns `{ ok, reason }`.

Used by admin command flows (`admin.archive.retryNative`).

---

## Operational notes

- Resolver is startup-time logic; strategy switches are applied on restart.
- Admin commands write lock fields into `native.*`, resolver applies them next startup.
- `MsgArchive.getStatus()` exposes resolver-derived runtime fields for diagnostics.

---

## Related files

- Implementation: `lib/IoArchiveResolver.js`
- Native backend: `lib/IoArchiveNative.js`
- ioBroker backend: `lib/IoArchiveIobroker.js`
- Archive consumer: `src/MsgArchive.js`
- Startup wiring: `main.js`
