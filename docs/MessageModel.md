# Message Model

Message Hub stores everything as a list of **messages**. A message is a small, normalized object that represents something a human (or an automation) should see and handle: a task, a status, an appointment, a list, …

This document explains the concepts without requiring you to read the internal core code.

---

## Identity: `ref` (the stable key)

Every message is identified by `ref` (string). Think of it as the primary key.

Why it matters:

- Updates and deletes address messages by `ref`.
- Stable `ref`s prevent duplicates and survive restarts (persistence).

Best practice:

- Always provide a stable `ref` when you can (for example a foreign id or a stable state id).
- When you create a message without a `ref`, Message Hub may generate one; always use the returned `ref` for follow-up calls.

---

## Classification: `kind` and `level`

### `kind` (what type of message it is)

`kind` is a string that describes the domain of the message. Today the built-in constants include:

- `task`
- `status`
- `appointment`
- `shoppinglist`
- `inventorylist`

### `level` (severity / urgency)

`level` is numeric to allow sorting and comparisons:

- `0` none
- `10` notice
- `20` warning
- `30` error

---

## Origin: where it came from (`origin`)

`origin` records *who created the message*:

```js
origin: { type: 'manual' | 'import' | 'automation', system?: string, id?: string }
```

Practical tips:

- Use `origin.system` to record the source (e.g. `javascript.0`, `ical.0`, `rule-engine`, …).
- Use `origin.id` for a stable upstream id when available. This helps deduplication.

---

## Lifecycle: current state (`lifecycle.state`)

Messages have a lifecycle state so UIs and automations can reason about “open vs. done vs. hidden”:

- `open`: active/new
- `acked`: acknowledged/seen
- `closed`: finished/done
- `snoozed`: postponed by user interaction
- `deleted`: soft-deleted (hidden; retention/purge may hard-delete later)
- `expired`: expired by time-based pruning

Lifecycle transitions can be applied either by patches (`patch` command) or by executing whitelisted actions (`action` command).

---

## Timing: created, updated, due, notify, expire (`timing`)

Message Hub keeps several time-related fields in `timing` (Unix ms timestamps + durations in ms):

- `createdAt`: when the message was created
- `updatedAt`: when a user-visible update happened (not all internal updates bump this)
- `notifyAt`: when the message should trigger a `due` notification
- `remindEvery`: reminder interval in ms (used to reschedule `notifyAt` after a `due`)
- `timeBudget`: planned time budget in ms (estimate for planning/scheduling; does not affect due handling)
- `expiresAt`: when the message becomes expired
- `dueAt` / `startAt` / `endAt`: kind-specific timestamps (tasks vs. appointments)

Important behavior:

- If a message has no `timing.notifyAt`, Message Hub treats it as “due now” and may dispatch a `due` notification immediately.
- “Due” is checked by a simple polling mechanism in the store; it is not a full job scheduler.

---

## Actions: what a user/automation is allowed to do (`actions[]`)

Messages may include a list of allowed actions (`actions[]`). Only actions present in this list are executable.

In practice:

- UIs can render actions as buttons.
- `EngageSendTo` can execute actions via the `action` command.

The core supports these action types today:

- `ack`, `close`, `delete`, `snooze`

Full reference for `sendTo` actions: [`docs/plugins/EngageSendTo.md`](./plugins/EngageSendTo.md)

---

## Metrics: runtime values (`metrics`)

Messages can contain metrics (for example temperature, battery, last-seen timestamps). Internally they are stored as a JavaScript `Map`.

Two important consequences:

- JSON serialization uses a special Map encoding (so maps survive persistence and state output).
- Rendering templates (see `MsgRender`) can reference metrics via `{{m.someKey}}`.

If you use `NotifyStates`, metric maps are serialized into JSON-safe form automatically.

---

## Where to read more

- Control plane API: [`docs/plugins/EngageSendTo.md`](./plugins/EngageSendTo.md)
- Core schema and rules (developer-level detail): [`docs/modules/MsgFactory.md`](./modules/MsgFactory.md)
- Constants (allowed kinds/levels/actions/events): [`docs/modules/MsgConstants.md`](./modules/MsgConstants.md)
