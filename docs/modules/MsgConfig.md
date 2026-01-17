# MsgConfig (Message Hub)

`MsgConfig` is the central place to **normalize ioBroker adapter configuration** into a stable, explicit “effective”
configuration model for MsgHub.

It is designed as a thin “translation layer” between:

- `main.js` (ioBroker wiring; reads raw `adapter.config`)
- core modules in `src/` (which should consume *normalized* configuration, not parse raw strings)
- plugins (which may want a safe, user-facing snapshot for diagnostics, e.g. via chat commands)

---

## Stand today (before full adoption)

Historically, some configuration normalization lived directly in `main.js`. A good example is **quiet hours**:
`main.js` validates and normalizes the user’s quiet-hours settings and then passes the resulting object to `MsgStore`.

This works, but it has downsides:

- Normalization logic gets scattered across wiring and core.
- Plugins cannot easily show the *effective* settings without duplicating logic.
- There is no single documented schema for “what config the core actually uses”.

---

## What `MsgConfig` provides

`MsgConfig` exposes a single entry point:

- `MsgConfig.normalize({ adapterConfig, msgConstants, notifierIntervalMs, log })`

It returns a frozen bundle:

- `corePrivate`: normalized configuration intended for core constructors
- `pluginPublic`: a **separate**, read-only copy intended for plugin-facing diagnostics
- `errors`: a list of stable error codes that explain why some feature was disabled

### `schemaVersion`

`MsgConfig.schemaVersion` documents the shape of the normalized model. It is intentionally separate from the adapter
version: it helps evolve the model deliberately and keeps plugin-facing usage explicit.

---

## Field list (minimal scope, stage 1)

### `corePrivate`

- `corePrivate.quietHours`:
  - `null` when quiet hours are disabled (feature off or invalid config)
  - or `{ enabled, startMin, endMin, maxLevel, spreadMs }` (all numeric minutes/ms)

### `pluginPublic`

- `pluginPublic.quietHours`:
  - same *field set* as `corePrivate.quietHours`
  - but as a **separate, frozen copy** (no shared references with `corePrivate`)

### `errors`

- `errors: ReadonlyArray<string>`
- Contains stable codes like:
  - `quietHours.disabled.notifierIntervalMs`
  - `quietHours.disabled.startEqualsEnd`
  - `quietHours.disabled.invalidMaxLevelOrSpreadMin`
  - `quietHours.disabled.tooLittleFreeTime`
  - `quietHours.disabled.spreadDoesNotFit`

These are designed for:
- targeted tests
- consistent logging/diagnostics
- future UI/UX messaging without parsing free-form strings

---

## Quiet hours (normalized model)

Quiet hours are normalized to:

- `startMin` / `endMin`: minutes since midnight (local time), derived from strict `HH:MM`
- `maxLevel`: numeric severity threshold
- `spreadMs`: jitter window in ms (derived from minutes)

Rules follow the adapter’s current behavior:

- Disabled when notification polling is disabled (`notifierIntervalMs <= 0`)
- Disabled when `start/end` are invalid or `start == end`
- Disabled when `maxLevel` / `spreadMin` are not numeric
- Disabled when the quiet window leaves less than 4 hours outside the quiet window
- Disabled when the spread window does not fit into the non-quiet time

Note: “How quiet hours affect notifications” is defined by `src/MsgNotificationPolicy.js`. `MsgConfig` only provides the
effective config values.

---

## Roadmap (“big goal”)

Long-term, `MsgConfig` is intended to become the **single source of truth** for core configuration:

- `main.js` reads raw `adapter.config`
- `MsgConfig.normalize(...)` produces `corePrivate` and `pluginPublic`
- core constructors (e.g. `MsgStore`) receive only normalized inputs
- plugins receive only whitelisted, read-only config via `ctx.api.config` (planned)

This strengthens the separation between ioBroker wiring (I/O layer) and core logic (domain layer), and makes future
config evolution and diagnostics more predictable.

