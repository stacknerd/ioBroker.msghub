# MsgAction (Core Action-Layer)

`MsgAction` is the **core Action-Layer** that executes actions defined in `message.actions[]`.

It is intentionally **core-only**:

- It patches messages via `MsgStore` (lifecycle + timing).
- It does **not** talk to ioBroker directly (`sendTo`, states, objects, …).
- Wiring of control-plane commands belongs to the adapter (`main.js`) or dedicated IO plugins.

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

### `execute({ ref, actionId, actor?, payload? }): boolean`

Execute exactly **one** action by `actionId` for the given message `ref`.

- Returns a single `boolean` success flag.
- Never throws (best-effort); on failure it logs a warning.

Parameters:

- `ref` (string, required): message reference
- `actionId` (string, required): action identifier (must exist in `message.actions[]`)
- `actor` (string|null, optional): stored as `lifecycle.stateChangedBy` (best-effort attribution)
- `payload` (object|null, optional): payload override (only used for `snooze`)

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
  - `lifecycle.state = "deleted"`
  - `timing.notifyAt` is cleared
- `snooze`:
  - `lifecycle.state = "snoozed"`
  - `timing.notifyAt = now + forMs`
  - payload schema: `{ forMs: number }` (duration in ms, `> 0`)

Notes:

- Hard delete is **not** done here (see `MsgStore.removeMessage()`).
- Non-core action types (`open/link/custom`) are currently **not executed** by `MsgAction`.

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
