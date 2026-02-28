# MsgEngage (Message Hub): wire interactive Engage integrations (ingest + notify + actions)

`MsgEngage` is a small adapter-wiring helper for **interactive channels** (Telegram, Web UI, dashboards, wall displays, ...).

It is conceptually similar to [`MsgBridge`](./MsgBridge.md): it registers one integration as **two plugins**:

- **Ingest side** on `MsgIngest` (inbound): run `start/stop` and optionally handle ioBroker events.
- **Notify side** on `MsgNotify` (outbound): receive MsgHub notification events via `onNotifications`.

The key difference:

- `MsgEngage` decorates the `ctx` passed to the handler functions with `ctx.api.action`, so the integration can execute
  **whitelisted message actions** (`ack/close/delete/snooze`) via the core action layer (`MsgAction`).
- `MsgNotify` itself does **not** expose actions to normal Notify plugins. Actions are reserved for Engage.

---

## Public API

### `MsgEngage.registerEngage(id, handler, deps)`

Registers an Engage integration as ingest+notify pair and returns the same handle shape as `MsgBridge`.

Inputs (high level):

- `id` (string): base registration id (example: `EngageTelegram:0`)
- `handler` (object): single Engage handler
  - required: `handler.onNotifications(event, notifications, ctx)`
  - inbound (at least one required): `handler.start(ctx)` and/or `handler.onStateChange(id, state, ctx)` and/or `handler.onObjectChange(id, obj, ctx)`
  - optional: `handler.stop(ctx)`
- `deps.msgIngest` / `deps.msgNotify`: plugin hosts (same contract as `MsgBridge`)
- `deps.adapter` / `deps.msgConstants` / `deps.store`: required to build `ctx.api.action` (forwarding into `store.msgActions`)
- optional: `deps.log` logger for rollback/unregister warnings

Derived host ids:

- `ingestId = id + '.ingest'`
- `notifyId = id + '.notify'`

Output:

- `{ ingestId, notifyId, unregister }`

---

## Why actions are only for Engage

Design rule:

- `Notify` plugins are **delivery-only** (MsgHub → channel).
- `Engage` integrations are **interactive** (MsgHub ↔ user via channel) and are the only family that may execute actions.

This keeps side-effects and security/ACL decisions clear and makes “Notify must stay dumb” enforceable.

---

## Related files

- Wiring helper: `src/MsgEngage.js`
- Bridge wiring helper: `src/MsgBridge.js` / [`docs/modules/MsgBridge.md`](./MsgBridge.md)
- Action layer: `src/MsgAction.js` / [`docs/modules/MsgAction.md`](./MsgAction.md)
- Notify host: `src/MsgNotify.js`
- Ingest host: `src/MsgIngest.js`
