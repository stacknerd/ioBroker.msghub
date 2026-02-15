# Message Hub Documentation

Message Hub is an ioBroker adapter that keeps a simple, persistent list of “messages” (tasks, status items, appointments, …) and can dispatch notification events to integrations.

This `docs/` folder is written as **software documentation**: readable for non-developers, but still technical and accurate.

Naming note: the adapter is called **Message Hub**. In code and ioBroker object IDs you will still see `msghub` / `ioBroker.msghub` and `Msg*` classes as shorter technical identifiers.

## Start Here (recommended reading order)

- Getting started (first steps, what you can do today): [`docs/GettingStarted.md`](./GettingStarted.md)
- Admin Tab (configure plugins and instances): [`docs/AdminTab.md`](./AdminTab.md)
- Statistics snapshot (Admin Tab “Stats”, rollups, I/O diagnostics): [`docs/modules/MsgStats.md`](./modules/MsgStats.md)
- Message model (what a “message” is, lifecycle, timing, actions): [`docs/MessageModel.md`](./MessageModel.md)
- Control plane API (create/patch/list via `sendTo`): [`docs/plugins/EngageSendTo.md`](./plugins/EngageSendTo.md)
- Notification output states (what `NotifyStates` writes): [`docs/plugins/NotifyStates.md`](./plugins/NotifyStates.md)

## Developer Docs

- Plugin developer guide (interfaces and `ctx.api`): [`docs/plugins/README.md`](./plugins/README.md)
- Plugin API reference (details for `ctx.api` / `ctx.meta`): [`docs/plugins/API.md`](./plugins/API.md)
- Plugin runtime wiring (enable switches, options in `native`): [`docs/plugins/IoPlugins.md`](./plugins/IoPlugins.md)
- Core modules (store/factory/storage/notify/render): [`docs/modules/README.md`](./modules/README.md)

## What This Repo Ships Today

- Built-in plugins (types, defaults, and docs links): [`docs/plugins/PLUGIN-INDEX.md`](./plugins/PLUGIN-INDEX.md)

## Big Picture: Core vs. Plugins

Message Hub is built in two layers:

- **Core modules** (`src/`): the internal engine (data model, store, persistence, rendering, dispatch).
- **Plugins** (`lib/`): the IO layer (how messages come in, and how notification events go out).

In other words: the core knows _what a message is_ and _how to manage it_, while plugins connect Message Hub to ioBroker events and to real delivery channels.

### Architecture at a Glance

Simplified write / notify flow:

```
ioBroker events  ->  Ingest plugins (lib/)  ->  Core (src/)  ->  Notify plugins (lib/)
                       (create/patch msgs)     (store+rules)     (deliver outside)
```

Runtime note: plugin types are auto-discovered at adapter startup from `lib/<plugin>/manifest.js` (via `lib/index.js`).
On a running adapter instance, `IoPlugins` (in `lib/`) loads plugin options from ioBroker objects, maintains enable/status
states, and registers/unregisters plugin instances at runtime (including bidirectional `Bridge...` plugins via `MsgBridge`).

## Modules (Core)

Core modules are the stable internal building blocks in `src/`. They implement logic that should not depend on any specific integration.

Read more: [`docs/modules/README.md`](./modules/README.md)

## Plugins (IO / Integrations)

Plugins are the integration layer. They should treat the core as a black box: use `ctx.api.*` and do not poke at internal state.

Read more: [`docs/plugins/README.md`](./plugins/README.md)

## Where Things Live (Code Map)

- `src/`: core engine (modules)
- `lib/`: plugin implementations + plugin runtime (`IoPlugins`)
- `main.js`: adapter wiring (registering plugin runtime and dispatching ioBroker events)
