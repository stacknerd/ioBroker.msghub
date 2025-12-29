# MsgFactory (Message Hub): normalize, validate, and patch Messages

`MsgFactory` is the central component that turns “producer input” into a **valid, consistent Message Hub `Message`**.
It is the place where the message schema is enforced so everything downstream (storage, rendering, notifications, UI)
can rely on a predictable shape.

In short: **If a message is created or updated, it should go through `MsgFactory`.**

---

## Where it sits in the system

A typical (simplified) flow looks like this:

1. A producer (usually a plugin in `lib/`) detects an event (ioBroker state/object change, import, automation, …).
2. The producer builds a raw payload.
3. `MsgFactory.createMessage()` converts that payload into the **canonical** message schema (or rejects it).
4. `MsgStore` stores the message and triggers side effects (persist, archive, notify).
5. Later updates go through `MsgStore.updateMessage()` which delegates validation/semantics to `MsgFactory.applyPatch()`.

Important: `MsgStore` treats `MsgFactory.applyPatch()` as the **single source of truth** for update rules.

---

## What is a “Message”?

A `Message` is the normalized payload Message Hub uses to represent something the system wants to show to a human:
tasks, status updates, appointments, shopping lists, etc.

There is a stable **core** (required fields) and optional sections (details, metrics, attachments, actions, …).
The factory keeps stored messages compact by omitting empty optional sections.

Very roughly, the required core looks like:

```js
{
  ref, title, text, level, kind,
  origin: { type, system?, id? },
  lifecycle: { state, stateChangedAt?, stateChangedBy? },
  timing: { createdAt, updatedAt?, notifyAt?, remindEvery?, ... },
  progress: { percentage, startedAt?, finishedAt? }
}
```

Allowed enum values (like `kind`, `level`, `origin.type`, `lifecycle.state`, attachment/action types) are defined in `src/MsgConstants.js`.

Notes:
- `lifecycle.state` is the canonical current state for UI/sorting.
- `timing.remindEvery` is a reminder interval (ms) used by the store/scheduler (logic implemented later).

---

## Core responsibilities

`MsgFactory` mainly does four things:

1. **Create + normalize** (`createMessage`)
   - Validates required fields and normalizes optional fields.
   - Produces a canonical message object or rejects invalid input.
   - Removes `undefined` fields so the stored payload is compact and predictable.

2. **Update + validate via patching** (`applyPatch`)
   - Applies partial updates with consistent semantics (including “clear this field”).
   - Enforces immutability of certain fields after creation.
   - Refreshes `timing.updatedAt` for user-visible changes (with one intentional exception: metrics).

3. **Enforce enums and ranges**
   - Validates enum-like fields against `MsgConstants`.
   - Performs basic range checks (e.g. `progress.percentage` must be `0..100`).

4. **Keep persisted payloads clean**
   - Removes keys that are `undefined` (they are ambiguous in JSON and waste space).
   - Omits optional sub-objects when they are effectively empty.

---

## Design guidelines / invariants (the important rules)

### 1) Strict core schema
`MsgFactory` is intentionally strict: missing/wrong required fields cause message creation/patching to fail.
That makes downstream code simpler and safer.

### 2) Stable identity: `ref`
`ref` is the internal, stable identifier of a message. It is used for:

- deduplication (same message vs. new message)
- updates and deletes (addressing)
- cross references (dependencies)

Normalization:

- `ref` is normalized to an ASCII/URL-safe form (internally via `encodeURIComponent`).

Auto-generation (when no `ref` is provided):

- If `origin.id` exists, it is preferred because it can stay stable across updates.
- If `origin.id` is missing, the auto-ref includes a readable title segment plus a time/sequence token
  to reduce collisions.

Practical rule for producers: **If something can repeat, provide `origin.id`.**

### 3) Kind-driven rules
Some fields only make sense for certain message kinds:

- `timing.dueAt` is only meaningful for `kind: "task"`
- `timing.startAt` / `timing.endAt` are only meaningful for `kind: "appointment"`
- `listItems` is only allowed for `kind: "shoppinglist"` and `kind: "inventorylist"`

If a producer sends kind-specific fields on the wrong kind, the factory logs a warning and ignores them.

### 4) `undefined` vs. `null` (especially for patches)

- `undefined` means “not present” and is removed before persistence.
- `null` is used by patch operations as an explicit signal to **clear/remove** a field.

Example ideas:

- Patch: `timing: { notifyAt: null }` removes `timing.notifyAt`
- Patch: `audience: null` removes the entire `audience` block

### 5) No guessing for enums
Enum fields are checked strictly against allowed values from `MsgConstants`.
There is no “best effort” correction of typos.

---

## Public API (what you call)

### `createMessage(data)`
This is the “normalization gate” for new messages.

Behavior:

- Validates required fields (e.g. `title`, `text`, `level`, `kind`, `origin.type`, …).
- Normalizes optional sections (details, audience, metrics, attachments, listItems, actions, dependencies).
- Sets `timing.createdAt` to “now” on creation.
- Returns `null` on validation failure (and logs the error).

### `applyPatch(existing, patch)`
This is the “update gate” for existing messages.

Behavior:

- Only fields present in the patch are touched; everything else is preserved.
- `null` means “clear this field”.
- Immutable after creation:
  - `ref`
  - `kind`
  - `origin`
  - `timing.createdAt`
  (A patch may include them, but only with the exact same value.)

Timing behavior:

- `timing.updatedAt` is refreshed when the patch is considered user-visible.
- Metrics changes are intentionally treated as high-frequency telemetry and do **not** bump `updatedAt`.
- When `applyPatch(..., ..., stealthMode=true)` is used, the `updatedAt` bump is suppressed (silent housekeeping patch).

### `isValidMessage(message)`
A lightweight structural check used before applying patches.
It validates the stable core shape and key constraints (including enum membership and `percentage` range).

---

## Patch language (how updates are meant to work)

The goal is that common updates can be applied without sending the entire message again.

### Scalars (replace)
Fields like `title`, `text`, `level` are replaced when present in the patch.

### Objects (partial update)
Fields like `timing`, `details`, `progress`, `audience` support partial updates:
only provided keys are applied; `null` clears keys (or the whole object, depending on the field).

`lifecycle` is also patchable (state + attribution):

- partial update: `lifecycle: { state: "acked", stateChangedAt: 123, stateChangedBy: "UI" }`
- reset: `lifecycle: null` (resets to `state: "open"` and clears attribution)

### `metrics` (Map)
Metrics are stored as a `Map` in memory and support:

- full replacement (`Map`)
- partial patching (`{ set, delete }`)
- clearing (`null`)

### `attachments` (array, index-based)
Attachments can be replaced entirely, or indices can be deleted (`{ delete: [0, 2] }`).

### `listItems` and `actions` (arrays, id-based)
These arrays support id-based patching for UI-friendly updates:

- full replacement: `[]` or `{ set: [] }`
- upsert by id: `{ set: { "<id>": { ...partial } } }`
- delete by id: `{ delete: ["id1", "id2"] }`

### `dependencies` (string list)
Dependencies can be:

- replaced (`string[]` or a comma-separated string)
- patched (`{ set, delete }`)
- cleared (`null`)

---

## Practical guidance for producer plugins

- Use `src/MsgConstants.js` values for `kind`, `level`, `origin.type`, attachment/action types.
- Provide `origin.id` for stable upstream IDs (especially for recurring items).
- Use `null` in patches when you really want to remove a field.
- Avoid sending empty optional objects; the factory will drop them anyway.

---

## Related files

- Implementation: `src/MsgFactory.js`
- Allowed enum values: `src/MsgConstants.js`
- Create-path integration: `src/MsgIngest.js` (exposes `factory.createMessage`)
- Update-path integration: `src/MsgStore.js` (delegates updates to `msgFactory.applyPatch`)
