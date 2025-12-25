# MsgHub Plugins – Overview

Plugins are the extension points of MsgHub: they are registered by the adapter and invoked on specific events. The core (in `src/`) remains responsible for data/storage and rules; plugins provide “input” (ingest) and/or “output” (notify).

## Plugin families

### Ingest (producer)

Producer plugins attach to the ingest host `MsgIngest` and receive ioBroker events (state/object changes). A producer decides whether to create a new message from an event or patch an existing one.

- Registration: `msgStore.msgIngest.registerPlugin(id, handler)`
- Typical job: ioBroker event → `ctx.api.store.addMessage(...)` / `ctx.api.store.updateMessage(...)`
- Context: plugins receive `ctx = { api, meta }` where `ctx.api` provides `{ store, factory, constants }` and `ctx.meta` carries dispatch metadata
- Example in this repo: `lib/IngestRandomDemo.js`

### Notify (notifier)

Notifier plugins attach to the dispatcher `MsgNotify` and perform the actual delivery to the outside (e.g. ioBroker states, push, TTS, ...). The core triggers events (e.g. when `notifyAt` is reached); `MsgNotify` then fans those out to all registered plugins.

- Registration: `msgStore.msgNotify.registerPlugin(id, handler)`
- Typical job: `(event, notifications) => delivery`
- Context: plugins receive `ctx = { api, meta }` where `ctx.api.constants` exposes `MsgConstants` and `ctx.meta` carries dispatch metadata
- Example in this repo: `lib/NotifyIoBrokerState.js`

## Module

<!-- AUTO-GENERATED:MODULE-INDEX:START -->
- `IngestIoBrokerStates`: [`./IngestIoBrokerStates.md`](./IngestIoBrokerStates.md)
- `IngestRandomDemo`: [`./IngestRandomDemo.md`](./IngestRandomDemo.md)
- `NotifyIoBrokerState`: [`./NotifyIoBrokerState.md`](./NotifyIoBrokerState.md)
<!-- AUTO-GENERATED:MODULE-INDEX:END -->
