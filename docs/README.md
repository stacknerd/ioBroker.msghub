# Message Hub Documentation

Message Hub is an ioBroker adapter that keeps a simple, persistent list of “messages” (tasks, status items, appointments, …) and can dispatch notification events to integrations.

This `docs/` folder is written as **software documentation**: readable for non-developers, but still technical and accurate.

Naming note: the adapter is called **Message Hub**. In code and ioBroker object IDs you will still see `msghub` / `ioBroker.msghub` and `Msg*` classes as shorter technical identifiers.

## Start Here (recommended reading order)

- Getting started (first steps, what you can do today): [`docs/GettingStarted.md`](./GettingStarted.md)
- Message model (what a “message” is, lifecycle, timing, actions): [`docs/MessageModel.md`](./MessageModel.md)
- Control plane API (create/patch/list via `sendTo`): [`docs/plugins/EngageSendTo.md`](./plugins/EngageSendTo.md)
- Notification output states (what `NotifyStates` writes): [`docs/plugins/NotifyStates.md`](./plugins/NotifyStates.md)

## Developer Docs

- Plugin developer guide (interfaces and `ctx.api`): [`docs/plugins/README.md`](./plugins/README.md)
- Plugin runtime wiring (enable switches, options in `native`): [`docs/plugins/IoPlugins.md`](./plugins/IoPlugins.md)
- Core modules (store/factory/storage/notify/render): [`docs/modules/README.md`](./modules/README.md)
- Development notes (repo conventions): [`docs/DevelopmentGuidelines.md`](./DevelopmentGuidelines.md)

## What This Repo Ships Today

- Built-in plugins:
  - `IngestRandomChaos` (demo/load generator ingest plugin, disabled by default)
  - `IngestHue` (Hue device health ingest plugin, disabled by default)
  - `EngageSendTo` (control plane via ioBroker `sendTo`)
  - `NotifyStates` (writes notification events to ioBroker states)
  - `NotifyDebug` (debug notifier, disabled by default)
- No built-in bridge integrations yet (the core supports them, but this repo currently does not ship any).

## Big Picture: Core vs. Plugins

Message Hub is built in two layers:

- **Core modules** (`src/`): the internal engine (data model, store, persistence, rendering, dispatch).
- **Plugins** (`lib/`): the IO layer (how messages come in, and how notification events go out).

In other words: the core knows *what a message is* and *how to manage it*, while plugins connect Message Hub to ioBroker events and to real delivery channels.

### Architecture at a Glance

Simplified write / notify flow:

```
ioBroker events  ->  Ingest plugins (lib/)  ->  Core (src/)  ->  Notify plugins (lib/)
                       (create/patch msgs)     (store+rules)     (deliver outside)
```

Runtime note: plugins are not auto-discovered. On a running adapter instance, `IoPlugins` (in `lib/`) loads plugin options from ioBroker objects, maintains enable/disable switches, and registers/unregisters plugins at runtime (including bidirectional `Bridge...` plugins via `MsgBridge`).

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
