# IoAdminConfig (Message Hub IO): config command facade (`config.*`)

`IoAdminConfig` is the adapter-side config facade for the `config.*` namespace.
It handles commands that are allowed to have configuration impact (including strictly filtered `useNative` patch responses).

In short:

- `IoAdminConfig` is the single command layer for config-facing IO control.
- `IoAdminConfig` is not an admin runtime API and does not handle `admin.*`.

---

## Why this file exists

The `admin.*` vs `config.*` split is a core 0.0.2 goal.
Without a dedicated config facade, risks include:

- indirect broad native patches through UI commands,
- mixed ownership between runtime reads and config writes,
- poor testability of security boundaries.

`IoAdminConfig` encapsulates this path with explicit allowlist filtering and reproducible error semantics.

---

## System role

Simple flow:

1. ioBroker sends `sendTo(..., command='config.*', payload)`.
2. `main.js` routes to `_handleConfigCommand(...)`.
3. `_handleConfigCommand(...)` delegates to `IoAdminConfig.handleCommand(...)`.
4. `IoAdminConfig` executes the config operation and returns a response (including optional allowlist-filtered `native` patch fields).

References:

- routing: `main.js` (`_handleConfigCommand`)
- implementation: `lib/IoAdminConfig.js`

---

## Responsibilities

`IoAdminConfig` is responsible for:

1. Routing and executing all supported `config.*` commands.
2. Archive strategy commands:
   - runtime transparency (`config.archive.status`)
   - native retry/lock intent (`config.archive.retryNative`)
   - iobroker lock intent (`config.archive.forceIobroker`)
3. AI connectivity test (`config.ai.test`).
4. Hard filtering of all `native` patch payloads through an explicit allowlist.

---

## Non-responsibilities

`IoAdminConfig` is explicitly **not** responsible for:

1. Admin runtime commands (`admin.*`).
2. IngestStates preset read APIs for jsonCustom (`admin.ingestStates.presets.selectOptions*` belongs to admin path).
3. Startup-time effective archive strategy resolution (`IoArchiveResolver.resolveFor(...)` remains startup behavior).
4. Plugin lifecycle orchestration.

---

## Authoritative command contract (`config.*`)

The following commands are compatible and active:

- `config.archive.status`
- `config.archive.retryNative`
- `config.archive.forceIobroker`
- `config.ai.test`

Intentionally incompatible:

- `config.ingestStates.presets.selectOptions*`
- all `admin.*` commands

---

## Command semantics in detail

### `config.archive.status`

Purpose:

- returns runtime transparency about the currently active archive strategy.

Response:

- `data.archive` with runtime fields,
- mirrored runtime fields in `native.*` (`archiveRuntime*`), then allowlist-filtered.

### `config.archive.retryNative`

Purpose:

- probes native viability and, on success, returns a lock intent for the next startup.

Important semantics:

- strategy switch is not live; it becomes effective on next startup.
- on probe failure, returns structured error (`NATIVE_PROBE_FAILED`) without `native` patch.

### `config.archive.forceIobroker`

Purpose:

- returns an explicit lock intent toward `iobroker` for the next startup.

### `config.ai.test`

Purpose:

- diagnostics-only connectivity test (no message mutation).

Result:

- compact summary in `native.aiTestLastResult`.

---

## Native patch guardrail (critical)

`IoAdminConfig` strictly filters every `native` response by an explicit allowlist.
Anything outside this list is dropped and logged.

Allowed keys:

- `archiveEffectiveStrategyLock`
- `archiveLockReason`
- `archiveLockedAt`
- `archiveRuntimeStrategy`
- `archiveRuntimeReason`
- `archiveRuntimeRoot`
- `aiTestLastResult`

Security goal:

- prevent indirect broad config access via web UI command payloads.

---

## Response and error semantics

Default responses:

- success: `{ ok: true, data?: ..., native?: ... }`
- error: `{ ok: false, error: { code, message } }`

Typical error codes:

- `BAD_REQUEST`
- `NOT_READY`
- `NATIVE_PROBE_FAILED`
- `UNKNOWN_COMMAND`

---

## Restart and persistence semantics

Important for archive commands:

- `config.archive.retryNative` and `config.archive.forceIobroker` return **lock intent** through `native`.
- effective strategy is applied at startup by resolver + runtime wiring.
- command response and runtime switch are intentionally separated.

---

## Test coverage (relevant files)

- `lib/IoAdminConfig.test.js`

Covered areas include:

- native probe success/failure for `config.archive.retryNative`
- lock patch for `config.archive.forceIobroker`
- runtime transparency for `config.archive.status`
- allowlist filtering for disallowed native keys

---

## Related files

- implementation: `lib/IoAdminConfig.js`
- tests: `lib/IoAdminConfig.test.js`
- routing: `main.js`
- admin counterpart: `lib/IoAdminTab.js` / `docs/io/IoAdminTab.md`
- resolver context: `lib/IoArchiveResolver.js` / `docs/io/IoArchiveResolver.md`
- IO overview: `docs/io/README.md`
