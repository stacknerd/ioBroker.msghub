# MsgBridge (Message Hub): wire bidirectional bridges (ingest + notify)

`MsgBridge` is a small helper that makes it easier to connect Message Hub to an external system in **both directions**.
It does not implement the integration itself. Instead, it registers a “bridge integration” as **two independent plugins**:

- **Ingest** (input side) on `MsgIngest`: read external changes and update Message Hub messages
- **Notify** (output side) on `MsgNotify`: listen to Message Hub events and push changes outward

The main value: you register (and later unregister) both sides together, with a best-effort rollback so you do not end up
with a “half bridge” when the second registration fails.

---

## The problem it solves

Bidirectional integrations need two sides:

1. **Inbound**: something changes outside (e.g. a list item is added in an external app) → Message Hub must be patched
2. **Outbound**: something changes inside Message Hub (updated/deleted/due/expired) → the external system must be updated

Without a helper, adapter wiring often ends up like:

- register ingest plugin
- register notify plugin
- hope the second call never fails

If the second registration throws, you may accidentally keep the ingest side registered (and running) while the notify side
is missing. `MsgBridge` exists to make this wiring safer and more consistent.

---

## Where it sits in the system

Typical wiring in the adapter looks like this:

1. The adapter creates `MsgStore` (the central store).
2. `MsgStore` owns two plugin hosts:
   - `msgIngest` (input) via `MsgIngest`
   - `msgNotify` (output) via `MsgNotify`
3. A bridge integration provides one handler object that covers both directions.
4. The adapter calls `MsgBridge.registerBridge(...)` once to register both sides (ingest + notify).

In other words: `MsgBridge` sits “next to” `main.js` wiring. It is not a runtime component that processes messages.

---

## Core responsibilities

`MsgBridge` does four things:

1. Provide a small API surface for bridge wiring (`registerBridge`)
2. Register both sides with clear IDs (one for ingest, one for notify)
3. Do best-effort rollback when the second registration fails (avoid half-registered bridges)
4. Return a best-effort, idempotent `unregister()` handle that removes both sides later

---

## What it intentionally does NOT do

`MsgBridge` is deliberately small. It does **not**:

- Dispatch events (events still flow through `MsgIngest` and `MsgNotify`)
- Define a combined lifecycle (`start/stop`) for both directions
- Add health checks, monitoring, or automatic re-sync
- Provide “true atomicity” (it can unregister plugins, but it cannot undo side effects a plugin already performed)

If you need health checks, resync logic, rate limiting, or shared state, implement that in the bridge integration itself
(see design notes below).

---

## Public API (what you call)

### `MsgBridge.registerBridge(id, handler, { msgIngest, msgNotify, log } = {})`

Registers a bridge as two plugins and returns a handle.

Import:

- `const { MsgBridge } = require('./src/MsgBridge')`

Inputs (high level):

- `id` (string): bridge base id (stable identifier; example: `BridgeFoo:0`)
- `handler` (object): single bridge handler
  - required: `handler.onNotifications(event, notifications, ctx)`
  - inbound (at least one required): `handler.start(ctx)` and/or `handler.onStateChange(id, state, ctx)` and/or `handler.onObjectChange(id, obj, ctx)`
  - optional: `handler.stop(ctx)`
- `msgIngest`: a host that supports `registerPlugin(id, handler)` and `unregisterPlugin(id)`
- `msgNotify`: a host that supports `registerPlugin(id, handler)` and `unregisterPlugin(id)`
- optional `log`: a logger (usually `adapter.log`) used for rollback/unregister warnings

Output:

- `{ ingestId, notifyId, unregister }`

Deterministic ids:

- `ingestId = id + '.ingest'`
- `notifyId = id + '.notify'`

Lifecycle wiring:

- `handler.start/stop` are wired on the ingest side only (to avoid double-start/double-stop via `MsgNotify`).

Example:

```js
const { MsgBridge } = require('./src/MsgBridge');

const bridge = MsgBridge.registerBridge(
  'bridge:demo',
  {
    start(ctx) { /* optional */ },
    onStateChange(id, state, ctx) { /* inbound */ },
    onNotifications(event, notifications, ctx) { /* outbound */ },
  },
  { msgIngest: this.msgStore.msgIngest, msgNotify: this.msgStore.msgNotify, log: this.log },
);

// Later (e.g. onUnload):
bridge.unregister();
```

---

## Important behavior and caveats

These details matter when you build or operate real integrations:

### Registration order: ingest first, then notify

`MsgBridge` registers the ingest side first and the notify side second.
The idea is that inbound changes should be observed as early as possible.

### Registration success means “no exception”

`MsgBridge.registerBridge(...)` considers a side “registered” if `registerPlugin(...)` did not throw.
The underlying hosts currently do not return a boolean success value.

### Ingest may start immediately

`MsgIngest.registerPlugin(...)` may start the ingest plugin immediately when the ingest host is already running.
That means the ingest handler can begin work **before** notify registration completes.

If your bridge needs stricter ordering, handle that in the integration itself (for example with a shared “ready” flag),
or control host startup order outside this helper.

### Rollback is best-effort (not a transaction)

If the notify registration throws, `MsgBridge` tries to unregister what it already registered.
This prevents the common “half bridge” state, but it cannot revert side effects that already happened inside your handler.

### `unregister()` is best-effort and idempotent

The returned `unregister()`:

- can be called multiple times
- tries to unregister notify first and then ingest
- never throws (it logs warnings if a host unregister fails, when a logger is provided)

Also note: `MsgNotify` has no “stop” contract; unregistering removes the handler, but it does not “shut down” a running
system on the other side.

---

## Design guidelines for bridge implementations

`MsgBridge` must stay stateless. If you need state, put it into your bridge integration.

Practical patterns:

- Create a shared context object and close over it from all handler functions
  - examples: last sync timestamps, caches, rate limiters, “ready” flags, telemetry
- Implement resync/health behavior inside the integration (not inside `MsgBridge`)
- Use clear, stable ids (e.g. `bridge:<system>`) so logs and debug output are easy to read
- Use stable base ids; `MsgBridge` derives `.ingest` / `.notify` ids automatically

---

## Related files

- Implementation: `src/MsgBridge.js`
- Module overview: `docs/modules/MsgBridge.md`
- Ingest host: `src/MsgIngest.js`
- Notify host: `src/MsgNotify.js`
