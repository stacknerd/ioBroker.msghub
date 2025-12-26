# Message Hub Documentation

This `docs/` folder is written as **software documentation** for Message Hub. It tries to be easy to read (for interested non-experts), but still explains the technical ideas behind the adapter.

Naming note: the adapter is called **Message Hub**. You will still see `msghub` / `ioBroker.msghub` (repository/package/namespace) and `Msg*` classes (internal code names) for compatibility and shorter identifiers.

Message Hub is an ioBroker adapter that acts like a small “message server” inside ioBroker:
it collects messages and tasks from many sources, stores them, and can trigger notifications when needed.

## Big Picture: Core vs. Plugins

Message Hub is built in two layers:

- **Core modules** (`src/`): the internal engine (data model, storage, scheduling, rendering, dispatch).
- **Plugins** (`lib/`): the IO layer (how messages come in, and how notifications go out).

In other words:
the core knows *what a message is* and *how to manage it*, while plugins connect Message Hub to ioBroker events and to real notification channels.

### Architecture at a Glance

Simplified write / notify flow:

```
ioBroker events  ->  Ingest plugins (lib/)  ->  Core (src/)  ->  Notify plugins (lib/)
                       (create/patch msgs)     (store+rules)     (deliver outside)
```

Runtime note: plugins are not auto-discovered. On a running adapter instance, `MsgPlugins` (in `lib/`) is responsible for loading plugin options from ioBroker objects, maintaining enable/disable switches, and registering/unregistering plugins at runtime (including bidirectional `Bridge...` plugins via `MsgBridge`).

Bidirectional integrations (“sync with system X”) can be implemented either as **two plugins** (one ingest + one notify) or as a single **bridge plugin** (`Bridge...`) that provides both handlers.
To register/unregister the two sides safely, the adapter uses `MsgBridge` (a small wiring helper in `src/`).

## Modules (Core)

Modules are the **stable internal building blocks** in `src/`. They implement the logic that should not depend on any specific integration.

What core modules do:

- Define the shared vocabulary and message schema (for example `MsgConstants`, `MsgFactory`)
- Keep the canonical in-memory state (`MsgStore`)
- Help wire bidirectional integrations safely (`MsgBridge`)
- Persist and restore messages (`MsgStorage`)
- Write an append-only history for audit/debug (`MsgArchive`)
- Render messages into display-friendly output (`MsgRender`)
- Trigger dispatch events to “notification backends” (`MsgNotify`)

What core modules intentionally do *not* do:

- They do not listen to ioBroker states by themselves.
- They do not send notifications to a real channel by themselves.

So the core can manage messages perfectly fine, but without plugins there is usually no **input** and no **output**.

Read more: [docs/modules/README.md](./modules/README.md)

## Plugins (IO / Integrations)

Plugins are the **integration layer** of Message Hub. In practice they are not “nice to have”: they are the element that turns the core into a usable ioBroker component.

The core intentionally exposes only a *small* host API to plugins. Plugins should not mutate internal state directly; instead they work through `ctx.api.*`. This keeps the core consistent and makes plugin failures easier to isolate and log.

### Plugin families

- **Ingest (producer) plugins**: turn ioBroker events into messages.
  - Example: “when state X becomes true, create/update message Y”
- **Notify (notifier) plugins**: turn core notification events into delivery actions.
  - Example: “when a message becomes due (`notifyAt`), write it to ioBroker states / push / TTS / …”
- **Bridge (bidirectional) plugins**: package an ingest+notify pair as one runtime-managed integration (one enable switch, one config object).
  - Example: “sync Message Hub with system X in both directions”

If you want to understand “how Message Hub talks to the outside world”, plugins are the right place to start.

Read more: [docs/plugins/README.md](./plugins/README.md)

## Where Things Live (Code Map)

- `src/`: core engine (modules)
- `lib/`: plugin implementations + plugin runtime (`MsgPlugins`)
- `main.js`: adapter wiring (registering plugins, connecting to ioBroker; often via `MsgPlugins`, optionally via `MsgBridge`)

## Development

Handy commands and reminders: [docs/DEVELOPMENT_NOTES.md](./DEVELOPMENT_NOTES.md)
