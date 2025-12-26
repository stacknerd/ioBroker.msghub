# Message Hub Plugins (IO Layer) – Overview

Plugins are the **integration layer** of Message Hub. They connect the core engine (in `src/`) to the outside world:

- **Input**: observe ioBroker events and decide when to create/update messages
- **Output**: deliver notification events to real channels (ioBroker states, push, TTS, ...)

The core stays intentionally “pure”: it owns the message model and lifecycle, but it does not talk to ioBroker by itself.
So in practice, plugins are not just optional add-ons; they are what turns Message Hub into a usable ioBroker adapter.

If you want the big picture first, see [`docs/README.md`](../README.md). If you want the core internals, see [`docs/modules/README.md`](../modules/README.md).

## What exactly is a “plugin” here?

A plugin is JavaScript code that is **registered by the adapter at runtime** (typically in `main.js` via `lib/index.js`).
Message Hub itself does not auto-discover plugins. The adapter decides which plugins exist and how they are configured.

Plugins are called by one of the two plugin hosts:

- `MsgIngest` for inbound events (producer/ingest plugins)
- `MsgNotify` for outbound notification events (notifier/notify plugins)

Both hosts provide a small `ctx` object:

- `ctx.api`: stable capabilities (store/factory/constants, depending on host)
- `ctx.meta`: metadata about “where this call came from” (plus a `running` flag)

This separation is deliberate: plugins get explicit capabilities, and the core keeps control over internal invariants.

## Two plugin families

### Ingest (producer) plugins

Ingest plugins turn **ioBroker events** into **message mutations**.
They usually implement the “rules” of your system (“when X happens, create/update message Y”).

- Host module: `MsgIngest` (see [`docs/modules/MsgIngest.md`](../modules/MsgIngest.md))
- Registration: `msgStore.msgIngest.registerPlugin(id, handler)`
- Typical job: ioBroker event → `ctx.api.store.addMessage(...)` / `ctx.api.store.updateMessage(...)`
- Common handler shapes:
  - Function: `(id, state, ctx) => void` (treated as `onStateChange`)
  - Object: `{ start(ctx)?, stop(ctx)?, onStateChange(id, state, ctx)?, onObjectChange(id, obj, ctx)? }`
- Examples in this repo:
  - `lib/IngestIoBrokerStates/index.js` (real ioBroker-driven ingest)
  - `lib/IngestRandomDemo/index.js` (timer-based demo ingest)

Minimal sketch:

```js
msgStore.msgIngest.registerPlugin('my-ingest', {
  onStateChange(id, state, ctx) {
    if (!state?.val) return;
    ctx.api.store.addOrUpdateMessage(/* ... */);
  },
});
```

### Notify (notifier) plugins

Notify plugins turn **core notification events** into **real delivery actions**.
The core decides *when* an event should be announced (due/updated/deleted/expired); the plugin decides *how* to deliver it.

- Host module: `MsgNotify` (see [`docs/modules/MsgNotify.md`](../modules/MsgNotify.md))
- Registration: `msgStore.msgNotify.registerPlugin(id, handler)`
- Typical job: `(event, notifications, ctx) => delivery`
- Common handler shapes:
  - Function: `(event, notifications, ctx) => void`
  - Object: `{ onNotifications(event, notifications, ctx) { ... } }`
- Important: `notifications` is always an array (today often length 1, but do not rely on that)
- Example in this repo: `lib/NotifyIoBrokerState/index.js`

Minimal sketch:

```js
msgStore.msgNotify.registerPlugin('my-notify', {
  onNotifications(event, notifications, ctx) {
    for (const msg of notifications) {
      // deliver msg somewhere (best-effort)
    }
  },
});
```

## What plugins should (and should not) do

Good plugin behavior:

- Use `ctx.api.*` (do not reach into core internals)
- Be best-effort and robust (a plugin runs in the adapter process)
- Keep handlers reasonably fast (avoid blocking work; rate-limit if needed)

What plugins should avoid:

- Mutating `MsgStore` internals directly (bypasses validation and side effects)
- Assuming “exactly one” notification per call (notify plugins get arrays)

## Built-in plugins in this repo

The docs in this folder describe the built-in plugins that ship with this repository.
They can serve as templates for your own plugins.

## Modules

<!-- AUTO-GENERATED:MODULE-INDEX:START -->
- `IngestIoBrokerStates`: [`./IngestIoBrokerStates.md`](./IngestIoBrokerStates.md)
- `IngestRandomDemo`: [`./IngestRandomDemo.md`](./IngestRandomDemo.md)
- `NotifyIoBrokerState`: [`./NotifyIoBrokerState.md`](./NotifyIoBrokerState.md)
<!-- AUTO-GENERATED:MODULE-INDEX:END -->
