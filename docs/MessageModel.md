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

- Use `origin.system` to record the source (e.g. `javascript.0`, `ical.0`, `alexa2.0`, …).
- Use `origin.id` for a stable upstream id when available. This helps deduplication.

---

## Audience: tags and channels (`audience`)

`audience` helps route messages to the right outputs and recipients.

It contains two independent concepts:

- `audience.tags: string[]` are free-form labels. Their meaning is integration-specific (plugins may use them to target users/groups).
- `audience.channels` is MsgHub-internal routing for plugin instances:

  ```js
  audience: {
    channels: {
      include: string[], // only these output channels (optional)
      exclude: string[], // never these output channels (optional; wins)
    }
  }
  ```

Output plugins (`Notify...`, `Bridge...`, `Engage...`) can be configured with an optional channel name (`native.channel`).
`audience.channels` then filters which plugin instances receive a message notification.

Semantics (implemented by `IoPlugins`):

- If the plugin channel is empty, only unscoped messages (`include` empty) are delivered (“to all”).
- If the plugin channel is set, `exclude` blocks and `include` restricts.

Note: channel routing is applied only for plugins with `manifest.supportsChannelRouting === true`.

---

## Lifecycle: current state (`lifecycle.state`)

Messages have a lifecycle state so UIs and automations can reason about “open vs. done vs. hidden”:

- `open`: active/new
- `acked`: acknowledged/seen
- `closed`: finished/done
- `snoozed`: postponed by user interaction
- `deleted`: soft-deleted (hidden; retention/purge may hard-delete later)
- `expired`: expired by time-based pruning

Lifecycle transitions can be applied either by patches (for normal states like `open`/`acked`/`closed`/`snoozed`) or by executing whitelisted actions (`action` command). `deleted`/`expired` are store-managed states.

Notes:

- `lifecycle.stateChangedAt` is a core-managed timestamp and is updated automatically when `lifecycle.state` changes.
- `lifecycle.stateChangedBy` is optional attribution (string or null).

---

## Timing: created, updated, due, notify, expire (`timing`)

Message Hub keeps several time-related fields in `timing` (Unix ms timestamps + durations in ms):

- `createdAt`: when the message was created
- `updatedAt`: when a user-visible update happened (not all internal updates bump this)
- `notifyAt`: when the message should trigger a `due` **notification**
- `remindEvery`: reminder interval in ms (used to reschedule `notifyAt` after a `due`)
- `cooldown`: optional cooldown duration in ms used when recreating a message from quasi-deleted states (see below)
- `timeBudget`: planned time budget in ms (estimate for planning/scheduling; does not affect due handling)
- `expiresAt`: when the message becomes expired
- `dueAt` / `startAt` / `endAt`: optional **domain timestamps** (scheduling window / deadline)

Important terminology (common source of confusion):

- `timing.dueAt` / `timing.startAt` / `timing.endAt` describe **domain time** (what humans typically call "due"" / “scheduled”).
- `notfication.events.due` is a **notification event name** (reminder delivery), driven by `timing.notifyAt`.
- These are intentionally independent: a message can be “fällig” without any notification being due, and vice versa.

Important behavior:

- If a message has no `timing.notifyAt`, Message Hub treats it as “notification due now” and may dispatch a `due` notification immediately.
- On create events, the store distinguishes:
  - `added`: the message is truly new (ref not present before)
  - `recreated`: the ref existed only in quasi-deleted states (`deleted`/`closed`/`expired`) and is now replaced
  - `recovered`: like `recreated`, but within `timing.cooldown` (no immediate `due` is dispatched)
- “Due” is checked by a simple polling mechanism in the store; it is not a full job scheduler.

### Domain timestamps: `dueAt`, `startAt`, `endAt`

These fields are intentionally **not restricted by `kind`**. They model the domain time window and can be used by UIs/filters/sort logic:

- `startAt`: planned/expected start (or actual start, if you only learn it later)
- `endAt`: planned/expected end (optional)
- `dueAt`: deadline (“should be done/fixed/bought by then”)

Typical usage patterns:

- `task`
  - `startAt`: planned start date (before that a UI may choose to hide it from the “active” list)
  - `dueAt`: hard deadline
  - `endAt`: optional planned end (not required)
  - `expiresAt`: store retention/expiry (may be after `dueAt`/`endAt`)

- `status`
  - `startAt`: when the status is expected to start (forecast) or when it actually started (late report)
  - `endAt`: expected end (optional)
  - `dueAt`: “by then the cause should be fixed” (optional)
  - `expiresAt`: store retention/expiry (may be after `endAt`)

- `appointment`
  - `startAt` / `endAt`: the scheduled window
  - `dueAt`: usually not needed, but allowed

- `shoppinglist` / `inventorylist`
  - `dueAt`: “needs to be bought/checked by then” (optional)
  - `startAt`: “can be started/checked from then on” (optional)

---

## Progress: completion (`progress`)

Messages can track coarse completion state in `progress`:

- `progress.percentage` (`0..100`)
- `progress.startedAt` is set by core when `percentage > 0` for the first time and then never changes.
- `progress.finishedAt` is set by core when `percentage == 100` and removed again when `percentage < 100`.

---

## Lists: shopping/inventory (`listItems[]`)

For `kind: "shoppinglist"` and `kind: "inventorylist"`, a message can include a list of items:

```js
listItems: [
  {
    id: string,
    name: string,
    category?: string,

    // “requested amount” (count, volume, mass, …)
    quantity?: { val: number, unit: string },

    // measurement/size per single unit (optional)
    perUnit?: { val: number, unit: string },

    checked: boolean
  }
]
```

Semantics:

- `id` is the stable key (used for id-based patching).
- `quantity` is “how much do we need in total?” (example: `6 pcs`, `2 kg`, `1.5 l`).
- `perUnit` is “how much is one unit/pack?” (example: `0.33 l` per bottle, `500 g` per pack).
- Both fields are optional and may be absent when the source provides only free text (like Alexa lists).

Examples:

- “Water 6×0.33l” → `quantity: { val: 6, unit: "pcs" }`, `perUnit: { val: 0.33, unit: "l" }`
- “Potatoes 2kg” → `quantity: { val: 2, unit: "kg" }`

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
