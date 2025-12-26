# MsgIngest (MsgHub): producer host + event fan-out

`MsgIngest` is the inbound “producer host” of MsgHub. It does not interpret ioBroker events itself; it only forwards
`stateChange` / `objectChange` events to registered producer plugins and gives them a narrow, stable API to create/update
messages via the store.

---

## Where it sits in the system

Typical flow:

1. The adapter receives an ioBroker event (`stateChange` / `objectChange`).
2. The adapter forwards it to `msgStore.msgIngest.dispatchStateChange(...)` / `dispatchObjectChange(...)`.
3. Producer plugins decide what to do (create a new message, patch an existing one, or ignore the event).
4. Writes happen only through `ctx.api.store.*` (which forwards to `MsgStore`).

---

## Plugin context: `ctx = { api, meta }`

Every plugin receives a `ctx` object with two namespaces:

- `ctx.api`: stable capabilities provided by MsgHub
  - `ctx.api.store`: `addMessage`, `updateMessage`, `addOrUpdateMessage`, `removeMessage`, `getMessageByRef`, `getMessages`
  - `ctx.api.factory`: `createMessage` (normalization gate for “create” paths)
  - `ctx.api.constants`: `MsgConstants` (levels/kinds/origin types, etc.)
- `ctx.meta`: dispatch metadata provided by the caller (plus `running`)

This separation keeps the plugin API explicit and avoids mixing “capabilities” with “event metadata”.

---

## Public API (what you typically use)

### `registerPlugin(id, handler)`

Registers (or overwrites) a producer plugin.

Supported handler shapes:

- Function handler: `(id, state, ctx) => void` (treated as `onStateChange`)
- Object handler: `{ start(ctx)?, stop(ctx)?, onStateChange(id, state, ctx)?, onObjectChange(id, obj, ctx)? }`

### `start(meta?)` / `stop(meta?)`

Best-effort lifecycle hooks for plugins that need timers/subscriptions.

### `dispatchStateChange(id, state, meta?)` / `dispatchObjectChange(id, obj, meta?)`

Fans out the raw ioBroker event to all registered plugins (fault-isolated).

---

## Related files

- Implementation: `src/MsgIngest.js`
- Example producer plugin: `lib/IngestRandomDemo/index.js`
