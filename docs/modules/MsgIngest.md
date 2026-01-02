# MsgIngest (Message Hub): producer plugin host for inbound events

`MsgIngest` is the “input side” of Message Hub.
It receives raw ioBroker events (`stateChange` / `objectChange`) from the adapter and **fans them out** to registered
producer plugins.

`MsgIngest` itself stays intentionally simple:
it does **not** interpret states/objects and it does **not** decide what a message means.
That logic lives in the producer plugins.

In short: **MsgIngest routes events to plugins and gives them a safe, stable way to write messages via `MsgStore`.**

---

## Where it sits in the system

Typical flow:

1. ioBroker triggers an event (`stateChange` / `objectChange`).
2. The adapter forwards it to `msgStore.msgIngest.dispatchStateChange(...)` / `dispatchObjectChange(...)`.
3. Every registered producer plugin receives the event.
4. A plugin may create/update/remove a message using `ctx.api.store.*` (which writes through `MsgStore`).
5. `MsgStore` persists and triggers downstream effects (archive, notify, render, …).

---

## Core responsibilities

`MsgIngest` does four main things:

1. **Fan out input events**
   - Dispatch raw `stateChange` / `objectChange` events to all registered producer plugins.

2. **Provide a narrow ingestion API**
   - Plugins get a small “capability surface” (`ctx.api`) instead of direct access to internals.
   - All writes go through `MsgStore` methods (no direct mutation).

3. **Manage a small plugin registry**
   - Register / overwrite / unregister plugins by id.
   - Optional lifecycle hooks (`start` / `stop`).

4. **Isolate plugin failures**
   - Errors in one plugin are caught and logged so other plugins still run.

---

## What it intentionally does NOT do

To keep Message Hub maintainable, `MsgIngest` deliberately does **not**:

- interpret ioBroker states/objects (plugins do that)
- implement message validation rules (that is `MsgFactory`)
- implement persistence, archive, or notification logic (that is `MsgStore` + `MsgNotify`)
- manage ioBroker subscriptions (the adapter owns the subscription and calls `dispatch*`)

---

## Plugin handler shapes

You can register a plugin in two ways:

- **Function plugin**: `(id, state, ctx) => void`
  - This is treated as `onStateChange`.
- **Object plugin**:
  - `{ start(ctx)?, stop(ctx)?, onStateChange(id, state, ctx)?, onObjectChange(id, obj, ctx)? }`

Notes:

- Registering the same id again overwrites the previous plugin.
- When overwriting while the host is running, `MsgIngest` tries to call `stop()` on the previous plugin (best-effort).
- If you register a plugin while the host is already running, `start()` is called immediately (best-effort).

---

## Plugin context: `ctx = { api, meta }`

Every dispatch call passes the same context shape:

- `ctx.api`: stable capabilities provided by Message Hub
  - `ctx.api.store` (the single write path)
    - `addMessage(msg)`
    - `updateMessage(msgOrRef, patch)`
    - `addOrUpdateMessage(msg)`
    - `removeMessage(ref)`
    - `getMessageByRef(ref)`
    - `getMessages()`
    - `queryMessages({ where, page?, sort? })`
  - `ctx.api.factory`
    - `createMessage(data)` (normalization gate for “create” paths)
  - `ctx.api.constants`
    - `MsgConstants` values (levels, kinds, origin types, …)
- `ctx.meta`: dispatch metadata provided by the caller
  - plus `running` (boolean): whether the ingest host is currently started

This split is intentional:

- `api` stays stable and explicit (“what you are allowed to do”)
- `meta` stays flexible (“what the current dispatch is about”)

---

## Lifecycle (`start` / `stop`)

`MsgIngest` is typically started and stopped by `MsgStore` (or adapter wiring).

- `start(meta?)`
  - Marks the host as running (`ctx.meta.running = true`)
  - Calls `start(ctx)` on each plugin that provides it (best-effort)
- `stop(meta?)`
  - Calls `stop(ctx)` on each plugin that provides it (best-effort)
  - Marks the host as not running

Practical meaning for integrations:

- Use `start()` for timers, polling, external subscriptions, initial syncs, etc.
- Use `stop()` to clean up intervals/subscriptions so you do not leak work after shutdown.

---

## Public API (what you call)

### `registerPlugin(id, handler)`

Registers (or overwrites) a producer plugin.

### `unregisterPlugin(id)`

Removes a plugin. If the plugin is running, `stop()` is called best-effort.

### `dispatchStateChange(id, state, meta?)`

Dispatches an ioBroker `stateChange` event to all plugins that implement `onStateChange`.

Returns the number of plugins that were called.

### `dispatchObjectChange(id, obj, meta?)`

Dispatches an ioBroker `objectChange` event to all plugins that implement `onObjectChange`.

Returns the number of plugins that were called.

---

## Design guidelines / invariants

These rules are what keep `MsgIngest` predictable:

1. **Event routing only**
   - `MsgIngest` forwards events; plugins interpret them.

2. **No direct store mutation**
   - Plugins never access `MsgStore` internals.
   - Writes happen through `ctx.api.store.*` only.

3. **Stable call shapes**
   - `onStateChange(id, state, ctx)` and `onObjectChange(id, obj, ctx)` stay stable.
   - The context is always `ctx = { api, meta }`.

4. **Fault isolation**
   - Plugin errors are caught and logged so one bad plugin cannot break other plugins.

---

## Important behavior and caveats

These details matter in real installations:

- **Dispatch is synchronous**
  - Plugins are called one after another.
  - If one plugin is slow, everything after it is delayed.
- **Invalid ids are ignored**
  - `dispatchStateChange` / `dispatchObjectChange` return `0` when `id` is missing/blank.
- **Start/stop are best-effort**
  - Exceptions are caught and only logged.
  - A failing plugin should not prevent Message Hub from working.
- **Registering while running**
  - If the host is already running and your plugin has `start()`, it may start immediately.
  - If you overwrite an existing plugin id, the old one may receive `stop()` first.

---

## Practical guidance for producer plugins

- Keep handlers fast; long-running work blocks dispatching for other plugins.
- Use `ctx.api.factory.createMessage(...)` when creating a new message (so it is normalized and valid).
- Use `ctx.api.store.updateMessage(...)` for partial updates (patches), and use `null` to clear fields.
- Prefer stable upstream ids via `origin.id` when you can (it helps deduplication and updates).

Conventions in this repo:

- Producer plugins live in `lib/` and are loaded via `lib/index.js`.
- Plugin entry files typically live at `lib/Ingest<System>/index.js` (for example `lib/IngestMySystem/index.js`).

---

## Minimal example (producer plugin)

This is a minimal example showing the handler shape and the `ctx.api.*` usage:

```js
function IngestExample(_options) {
  return {
    onStateChange(id, state, ctx) {
      if (!state) return;
      const c = ctx.api.constants;
      const msg = ctx.api.factory?.createMessage?.({
        ref: `demo.0.status.${id}`,
        title: 'Demo',
        text: `${id} = ${state.val}`,
        level: c.level.notice,
        kind: c.kind.status,
        origin: { type: c.origin.type.automation, system: 'iobroker', id },
      });
      if (msg) ctx.api.store.addOrUpdateMessage(msg);
    },
  };
};

module.exports = { IngestExample };
```

---

## Related files

- Implementation: `src/MsgIngest.js`
- Module overview: `docs/modules/MsgIngest.md`
- Store (writes + side effects): `src/MsgStore.js`
- Factory (validation + patch rules): `src/MsgFactory.js`
- Plugin developer guide: `docs/plugins/README.md`
