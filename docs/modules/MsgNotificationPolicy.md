# MsgNotificationPolicy (Message Hub): notification quiet hours policy

`MsgNotificationPolicy` is a small, stateless policy module that helps the core decide *when to dispatch* (or suppress)
scheduled notifications during “quiet hours”.

It is intentionally separated from `MsgStore` (mutation + persistence) and `MsgNotify` (plugin dispatch), so the
“decision logic” stays testable, deterministic, and easy to evolve without turning the store into a rule jungle.

---

## Where it sits in the system

A simplified notification flow:

1. `MsgStore` determines that a message is due (e.g. `timing.notifyAt <= now`).
2. Before dispatching, `MsgStore` applies policy decisions (quiet hours) using `MsgNotificationPolicy`.
3. When dispatching, `MsgStore` calls `MsgNotify.dispatch(event, message|messages)` to fan out to notifier plugins.
4. After dispatch, core writes `timing.notifiedAt[event] = now` as a stealth patch for auditability and future policy decisions.

Important: `MsgNotificationPolicy` itself never dispatches and never mutates the store. It only answers questions
like “Are we in quiet hours?” and “When do quiet hours end?”

---

## Core responsibilities

`MsgNotificationPolicy` currently focuses on *quiet hours* and provides:

1. **Quiet-hours window evaluation**
   - Supports normal windows (e.g. `08:00..10:00`) and cross-midnight windows (e.g. `22:00..06:00`).
   - Uses local time (`Date.getHours()/getMinutes()`).

2. **Deterministic “quiet hours end” calculation**
   - Computes the timestamp (ms) when the current quiet period ends.

3. **Scheduled repeat suppression decision**
   - Suppresses scheduled `due` *repeats* during quiet hours (first `due` still dispatches).
   - Respects a `maxLevel` threshold: messages above that level always dispatch.

4. **Reschedule timestamp generation**
   - When a repeat is suppressed, computes a new `notifyAt` (quiet end + optional random “spread window”).

---

## Design guidelines / invariants (the important rules)

### 1) Pure logic only
This module must remain “pure policy”:
- No calls into `MsgStore`, no `updateMessage`, no persistence, no archive writes.
- No `MsgNotify` dispatch.
- No message mutation.

### 2) Inputs are normalized by the caller
`MsgNotificationPolicy` assumes:
- Quiet-hours configuration is validated and normalized upstream (in `main.js`).
- Message structure (including timing fields) is already canonical/normalized (via `MsgFactory` + `MsgStore`).

### 3) Local time and half-open intervals
Quiet hours are evaluated in local time and use a half-open interval:
- start is inclusive
- end is exclusive

### 4) Cross-midnight semantics are explicit
For windows like `22:00..06:00`:
- late evening (after start) ends next morning
- early morning (before end) ends the same morning

### 5) Suppress repeats only (current semantics)
Quiet hours intentionally suppress only scheduled repeats:
- “Repeat” is detected by `timing.notifiedAt.due` being set (> 0).
- “First due” still dispatches even during quiet hours.

This rule avoids “silent” first-time creations, but still provides a spam guard for remind loops.

---

## Configuration (how quiet hours are configured)

Quiet hours are configured in the adapter instance config and normalized in `main.js` before being passed to the store.

Relevant config fields in `admin/jsonConfig.json`:
- `quietHoursEnabled` (default `true`)
- `quietHoursStart` as strict `HH:MM` (default `22:00`)
- `quietHoursEnd` as strict `HH:MM` (default `06:00`)
- `quietHoursMaxLevel` (default `20`; above this level always dispatch)
- `quietHoursSpreadMin` (default `60`; random spread window after quiet-hours end)

Normalization output (passed into `MsgStore` as `options.quietHours`):
```js
{
  enabled: true,
  startMin: 1320, // minutes since midnight
  endMin: 360,
  maxLevel: 20,
  spreadMs: 3600000
}
```

Invalid configuration disables the feature (with `log.error`), instead of “best-effort guessing”.

---

## Public API (what you typically use)

All methods are static and do not maintain any internal state.

### `MsgNotificationPolicy.isInQuietHours(now, quietHours)`
Returns `true` when `now` (ms) is within the quiet-hours window.

### `MsgNotificationPolicy.getQuietHoursEndTs(now, quietHours)`
Returns the timestamp (ms) when the quiet-hours window ends *from the perspective of `now`*.
Returns `null` if `now` is not in quiet hours.

### `MsgNotificationPolicy.shouldSuppressDue({ msg, now, quietHours })`
Returns `true` when a **scheduled** `due` should be suppressed due to quiet hours.

Current rules:
- `quietHours.enabled === true`
- `now` is within quiet hours
- message `level <= quietHours.maxLevel`
- `timing.notifiedAt.due` exists and is > 0 (repeat)

### `MsgNotificationPolicy.computeQuietRescheduleTs({ now, quietHours, randomFn? })`
Returns a new `notifyAt` timestamp (ms) when a repeat was suppressed:
- `quietEnd` when `spreadMs` is missing/<=0
- otherwise `quietEnd + jitter`, with jitter in `[0..spreadMs]`

`randomFn` is optional and exists mainly for deterministic tests.

---

## How it relates to MsgNotify

`MsgNotify` is the “dispatcher”:
- validates the event name against `MsgConstants.notfication.events`
- fans out to registered Notify plugins
- isolates failures (one plugin cannot break others)

`MsgNotificationPolicy` is the “decision helper”:
- decides if a scheduled `due` should be suppressed
- computes reschedule timestamps

The store (`MsgStore`) is the orchestrator that applies policy and triggers dispatch.

---

## Related files

- Implementation: `src/MsgNotificationPolicy.js`
- Store integration: `src/MsgStore.js`
- Dispatcher: `src/MsgNotify.js`
- Config normalization: `main.js` and `admin/jsonConfig.json`
- Allowed constants: `src/MsgConstants.js`
- Module overview: `docs/modules/README.md`
