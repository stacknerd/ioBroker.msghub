# MsgAction (Core Action-Layer)

`MsgAction` is the **core Action-Layer** that executes actions defined in `message.actions[]`.

It is intentionally **core-only**:

- It patches messages via `MsgStore` (lifecycle + timing).
- It does **not** talk to ioBroker directly (`sendTo`, states, objects, …).
- Wiring of control-plane commands belongs to the adapter (`main.js`) or dedicated IO plugins.

In addition to inbound execution, `MsgAction` also provides a small **view helper** that filters actions on output
based on the current lifecycle state. This keeps the inbound and outbound policy consistent.

---

## Why this exists

Actions are part of the Message model (`actions[]`) and define what a consumer (UI/plugin/control-plane) is allowed to do.
`MsgAction` is the single place where those actions are translated into **mutations** of the canonical message state.

Key idea: **capability / whitelist**

- Only actions that exist in `message.actions[]` can be executed.
- Execution is always **by `actionId`** (not by action type).

---

## Public API

### `new MsgAction(adapter, msgConstants, msgStore)`

Dependencies:

- `adapter` is used only for logging.
- `msgConstants` provides the canonical action/state identifiers.
- `msgStore` is used to patch messages (`updateMessage`).

Important wiring note:

- `MsgStore` owns the instance (`store.msgActions`) and uses it for both:
  - action execution via `ctx.api.action.execute(...)` (Engage integrations)
  - action filtering on output (read APIs + notify dispatch)

### `execute({ ref, actionId, actor?, payload?, snoozeForMs? }): boolean`

Execute exactly **one** action by `actionId` for the given message `ref`.

- Returns a single `boolean` success flag.
- Never throws (best-effort); on failure it logs a warning.

Parameters:

- `ref` (string, required): message reference
- `actionId` (string, required): action identifier (must exist in `message.actions[]`)
- `actor` (string|null, optional): stored as `lifecycle.stateChangedBy` (best-effort attribution)
- `payload` (object|null, optional): payload override (only used for `snooze`)
- `snoozeForMs` (number, optional): overrides the snooze duration (ms, `> 0`)

### `buildActions(msg): object`

Build a view-only action list for output consumers (UIs and notify plugins).

Behavior:

- Returns a copy of the message where:
  - `actions[]` contains only actions that are currently allowed by policy.
  - `actionsInactive[]` is optionally added and contains the remaining, currently disallowed actions.
- Invalid/broken actions are dropped (they do not appear in `actions` nor `actionsInactive`).

This is designed so that:

- `actions[] + actionsInactive[]` equals the original action set (minus invalid ones).
- Consumers do not need to re-implement lifecycle rules.

### `isActionAllowed(msg, action): boolean`

The central policy check (pure decision):

- Used by `execute()` as the inbound gate.
- Used by `buildActions()` as the outbound filter.

---

## Supported core actions

`MsgAction` currently implements only the **core workflow actions**:

- `ack`:
  - `lifecycle.state = "acked"`
  - `timing.notifyAt` is cleared (set to `null` in the patch)
- `close`:
  - `lifecycle.state = "closed"`
  - `timing.notifyAt` is cleared
- `delete` (soft delete):
  - soft delete via `MsgStore.removeMessage(ref, { actor })`
  - results in `lifecycle.state = "deleted"` and `timing.notifyAt` cleared
- `snooze`:
  - `lifecycle.state = "snoozed"`
  - `timing.notifyAt = now + forMs`
  - duration resolution (highest priority wins):
    - `snoozeForMs` (number, `> 0`)
    - `payload.forMs` (number, `> 0`)
    - `action.payload.forMs` (number, `> 0`)

Notes:

- Hard delete is **not** done here (see `MsgStore.removeMessage()`).
- Non-core action types (`open/link/custom`) are currently **not executed** by `MsgAction`.

---

## Policy: lifecycle-sensitive action availability

Some actions are only meaningful in certain lifecycle states.

Examples:

- When a message is already `acked`, `ack` is not offered (and will be rejected).
- When a message is already `snoozed`, another `snooze` is not offered (and will be rejected).
- When a message is `acked`, `snooze` is not offered (and will be rejected) because `ack` means “don’t remind me”.
- When a message is quasi-deleted (`deleted/closed/expired`), all actions are rejected.

These rules are enforced consistently:

- inbound (execution) via `isActionAllowed(...)`
- outbound (rendering) via `buildActions(...)`

---

## Interaction with notifications

`MsgAction` patches messages through the store, therefore:

- successful execution normally triggers a store `"updated"` event (because `timing.updatedAt` bumps on non-silent patches)
- `"due"` dispatch on update is gated by `lifecycle.state === "open"` in `MsgStore`

This prevents “re-notify spam” when a user acknowledges/closes/deletes a message.

---

## Action audit (MsgArchive)

When `msgStore.msgArchive.appendAction(...)` is available, `execute()` records an archive entry with `event: "action"`.

This stores the **intent** (`actionId`, `type`, `actor`, optional payload) and the **result** (`ok`, optional `reason/noop`)
independently of whether the action caused a state change (patch).

---

## Related files

- Implementation: `src/MsgAction.js`
- Message model + patch semantics: `src/MsgFactory.js` / `docs/modules/MsgFactory.md`
- Canonical store + dispatch: `src/MsgStore.js` / `docs/modules/MsgStore.md`
- Constants: `src/MsgConstants.js` / `docs/modules/MsgConstants.md`
