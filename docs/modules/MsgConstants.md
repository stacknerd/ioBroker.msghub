# MsgConstants (MsgHub): shared “vocabulary” for Messages

`MsgConstants` is a small, centralized set of **enum-like constants** for the MsgHub `Message` schema.
It defines the allowed values for things like:

- **Severity** (`level`)
- **Message domain/type** (`kind`)
- **Where a message comes from** (`origin.type`)
- **Supported attachments and actions** (`attachments.type`, `actions.type`)
- **Notification event names** (`notfication.events.*`)

In short: **If code needs a fixed identifier that becomes part of a message, it should come from `MsgConstants`.**

---

## Why this exists (in simple terms)

Messages are stored, sent, rendered, and used by plugins. If different parts of the system use slightly different
strings (like `"warn"` vs `"warning"`), things break in confusing ways.

`MsgConstants` prevents that by being the **single source of truth** for these fixed values:

- Producers (plugins) can build messages without guessing string literals.
- Validators (like `MsgFactory`) can reject invalid values reliably.
- Consumers (renderer, notification plugins, UI) can make decisions based on known values.

---

## Where it sits in the system

- Producers create raw payloads.
- `MsgFactory` validates and normalizes them and uses `MsgConstants` to enforce allowed values.
- `MsgStore` stores messages and triggers notifications.
- `MsgNotify` dispatches notification events which are also defined in `MsgConstants`.

That means: **changing `MsgConstants` can affect everything** (create, update, storage, routing, UI).

---

## What is inside `MsgConstants`?

### `level` (numeric severity)

`level` is numeric so code can easily compare/sort it:

- `MsgConstants.level.none` → `0` (no severity / informational)
- `MsgConstants.level.notice` → `10` (normal information)
- `MsgConstants.level.warning` → `20` (important / might need attention)
- `MsgConstants.level.error` → `30` (problem / action required)

Typical rule of thumb: higher number = more urgent.

### `kind` (what the message is about)

`kind` tells the system which “domain” a message belongs to (and which fields make sense):

- `task` → something to do (often uses `timing.dueAt`)
- `status` → a status update / state description
- `appointment` → a scheduled event (often uses `timing.startAt` / `timing.endAt`)
- `shoppinglist` → list of items to buy (uses `listItems`)
- `inventorylist` → list of owned items (uses `listItems`)

### `origin.type` (where it comes from)

This records *who created the message*:

- `manual` → created by a human / UI
- `import` → imported from another system (e.g. calendar, Alexa, …)
- `automation` → created by a rule/script/automation

### `attachments.type` (extra content)

Attachments add “rich content” to a message:

- `ssml` → spoken output markup (TTS)
- `image` → image URL/path
- `video` → video URL/path
- `file` → generic file URL/path

### `actions.type` (what a user can do)

Actions describe possible operations a UI or plugin may offer:

- `ack` → acknowledge/mark as seen
- `delete` → remove the message
- `close` → finish/dismiss something
- `open` → open/activate something (navigation or action)
- `link` → navigation only
- `custom` → plugin-specific action

### `notfication.events` (notification event names)

These event names are used when dispatching notifications via `MsgNotify`:

- `due` → the message is “due now” (e.g. `notifyAt` reached or missing)
- `updated` → the message changed in a user-visible way
- `deleted` → the message was removed explicitly
- `expired` → the message was removed because it expired (`expiresAt`)

Naming note: the property is spelled `notfication` (missing the second “i”) because it is part of the current
public API inside this repo and is referenced from multiple files.

---

## Core responsibilities

`MsgConstants` mainly exists to:

1. **Define allowed values** for enum-like fields in messages and notifications.
2. **Prevent typos and drift** between producers (plugins) and consumers (store/render/notify/UI).
3. **Keep stored data stable** by using consistent, explicit identifiers.

---

## Design guidelines / invariants (the important rules)

### 1) Treat values as stable “wire/storage format”

Most values in `MsgConstants` are stored directly in messages (and may end up persisted to JSON).
Changing them later can break:

- reading old stored messages
- routing (e.g. kind/level based filters)
- UI rendering rules
- notification plugins and their state IDs

Practical rule: **prefer adding new values** over renaming existing ones.

### 2) Do not hardcode literals elsewhere

If you see code like `kind: "task"` or `event: "due"` in producers/plugins, prefer:

- `MsgConstants.kind.task`
- `MsgConstants.notfication.events.due`

It makes refactors safer and keeps the system consistent.

### 3) Keys vs. values (small but important)

Many groups are defined as `{ key: "value" }` mappings.

- For `kind`, keys and values are the same (`task: "task"`), so it rarely matters.
- For `level`, keys are names (`"warning"`) but values are numbers (`20`).

Some integrations (like `lib/NotifyIoBrokerState.js`) accept **either** the key or the value, but the message model
itself stores the value (e.g. `level: 20`).

### 4) Runtime immutability

`MsgConstants` is deeply frozen with `Object.freeze()`.
This is intentional: constants should not change while the adapter is running.

---

## Practical guidance (for producer / notifier plugins)

- Use `MsgConstants` when building messages (`level`, `kind`, `origin.type`, attachment/action types).
- Use `MsgConstants.notfication.events.*` when dispatching notifications with `MsgNotify.dispatch(...)`.
- When introducing a new `kind`, also check:
  - `MsgFactory` kind-specific rules (`timing.*`, `listItems`)
  - render/notify plugins that may depend on kinds or levels

---

## Related files

- Constants definition: `src/MsgConstants.js`
- Message validation/normalization: `src/MsgFactory.js`
- Notification dispatch: `src/MsgNotify.js`
- Store + notification scheduling: `src/MsgStore.js`
- ioBroker state notifier plugin: `lib/NotifyIoBrokerState.js`
