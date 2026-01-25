# Message Hub Core Modules (`src/`) – Overview

This document explains the **core engine** of Message Hub: the classes in `src/` and how they work together.
The core is responsible for the message model and lifecycle (store, validation, persistence, rendering, dispatch).

This is “the inside” of Message Hub. It is designed to be stable and integration-agnostic.
If you are looking for the ioBroker-facing parts, jump to [`docs/plugins/README.md`](../plugins/README.md).

Detailed docs for each module are linked at the bottom of this page.

## What the core can do (and what it cannot)

Core modules can:

- Define what a valid Message Hub `Message` looks like and how updates (“patches”) work
- Keep a canonical in-memory list of messages (single source of truth)
- Persist/restore that list and write append-only history
- Render messages into display-friendly output (template placeholders → rendered `title`/`text`/`details`)
- Trigger notification events (dispatch), without caring about delivery channels

Core modules intentionally do not:

- Listen to ioBroker events directly
- Deliver notifications to “real” channels

Those IO responsibilities live in plugins (`lib/`). The adapter wires everything together in `main.js`.
For runtime enable/disable + configuration of plugins (including bidirectional `Bridge...` plugins wired via `MsgBridge`), the adapter uses `IoPlugins` (see [`docs/plugins/IoPlugins.md`](../plugins/IoPlugins.md)).

## Data Flow (Simplified)

1. **Input**: The adapter (e.g. `main.js`) receives ioBroker events (state/object changes) or import/automation events.
2. **Producers**: Producer plugins (typically in `lib/`) interpret these events and build message payloads.
   - For bidirectional integrations, the adapter often registers an ingest+notify pair together via `MsgBridge` (wiring helper).
3. **Ingest Host**: `MsgIngest` hosts producer plugins and provides a narrow API via `ctx.api.*`, separated from dispatch metadata in `ctx.meta`.
4. **Normalization**: `MsgFactory` validates/normalizes new messages (`createMessage`) and defines patch semantics (`applyPatch`).
5. **Single Source of Truth**: `MsgStore` owns the canonical in-memory list (`fullList`) and is the only place where this list is mutated.
6. **Side Effects (best-effort)**: After mutations, `MsgStore` triggers side effects:
   - Persistence of the full list via `MsgStorage`
   - Append-only history via `MsgArchive`
   - Notification dispatch via `MsgNotify` (fan-out to notifier plugins in `lib/`, typically with rendered message views via `MsgRender`)
7. **Notifier Plugins (delivery)**: Notifier plugins (e.g. `lib/Notify*.js`) receive events from `MsgNotify` and perform the actual delivery (ioBroker states, push, TTS, ...). See [`docs/plugins/README.md`](../plugins/README.md).
   - In interactive channels (`Engage...`), user intents may execute actions (`MsgAction.execute(...)`).
   - Successful actions are dispatched as events to producer plugins via `MsgIngest` (`onAction(actionInfo, ctx)`).
8. **Output (read view)**: On reads, `MsgStore` returns a view; `MsgRender` returns rendered `title`/`text`/`details` (resolving template placeholders from `metrics`/`timing`).

ASCII sketch - WRITE / MUTATE (create/update/delete + side effects):
```
ioBroker Events / Imports
        |
        v
Producer Plugins (lib/)  (+ optional bridge wiring via MsgBridge)
        |
        v
MsgIngest  --->  MsgFactory  --->  MsgStore (canonical list)
                               |-> MsgStorage (messages.json)
                               |-> MsgArchive (JSONL per ref)
                               |-> MsgNotify (events) ---> Notify Plugins (lib/Notify*.js + optional bridge wiring via MsgBridge)
```

ASCII sketch - READ / VIEW (rendering only; no mutation)
```
Consumer/UI  --->  MsgStore.getMessages()/getMessageByRef()  --->  MsgRender  --->  rendered output (title/text/details)
```

## Design ideas (why it is built like this)

- **Single source of truth**: only `MsgStore` mutates the message list; everyone else works through it.
- **Best-effort side effects**: persistence, archive, and notifications should not crash the adapter if something goes wrong.
- **Narrow plugin API**: plugins get capabilities via `ctx.api.*`, not by poking at internals.
- **Separation of concerns**: ingest decides what to write, the store decides how to persist/dispatch, notify decides how to deliver.

## Core Class Roles

- `MsgConstants` defines the shared vocabulary (levels, kinds, origin types, notification event names).
- `MsgFactory` validates/normalizes the `Message` schema and defines patch semantics.
- `MsgBridge` is an adapter-wiring helper for bidirectional integrations (register/unregister ingest + notify plugin pairs).
- `MsgEngage` is an adapter-wiring helper for interactive channels (like MsgBridge, but adds action capability).
- `MsgStore` is the hub: owns `fullList`, coordinates persistence/archive/notifications, and returns rendered views.
- `MsgStorage` persists and restores the full message list (including revival of `Map` fields such as `metrics`).
- `MsgArchive` writes an append-only history (JSONL) per message `ref` for audit/debug/replay.
- `MsgNotify` dispatches notification events to registered notifier plugins (delivery happens in plugins).
- `MsgRender` resolves template placeholders (`{{m.*}}`, `{{t.*}}`) into rendered `title`/`text`/`details`.
- `MsgIngest` hosts producer plugins and fans out inbound events to them.
- `MsgAction` executes whitelisted message actions and patches `lifecycle`/`timing` via the store.
- `MsgStats` provides on-demand stats snapshots and keeps a persistent “done” rollup for longer windows.
- `MsgUtils` contains small shared helpers used by storage/archive.

## Modules

<!-- AUTO-GENERATED:MODULE-INDEX:START -->
- `MsgAction`: [`./MsgAction.md`](./MsgAction.md)
- `MsgAi`: [`./MsgAi.md`](./MsgAi.md)
- `MsgArchive`: [`./MsgArchive.md`](./MsgArchive.md)
- `MsgBridge`: [`./MsgBridge.md`](./MsgBridge.md)
- `MsgConfig`: [`./MsgConfig.md`](./MsgConfig.md)
- `MsgConstants`: [`./MsgConstants.md`](./MsgConstants.md)
- `MsgEngage`: [`./MsgEngage.md`](./MsgEngage.md)
- `MsgFactory`: [`./MsgFactory.md`](./MsgFactory.md)
- `MsgHostApi`: [`./MsgHostApi.md`](./MsgHostApi.md)
- `MsgIngest`: [`./MsgIngest.md`](./MsgIngest.md)
- `MsgNotificationPolicy`: [`./MsgNotificationPolicy.md`](./MsgNotificationPolicy.md)
- `MsgNotify`: [`./MsgNotify.md`](./MsgNotify.md)
- `MsgRender`: [`./MsgRender.md`](./MsgRender.md)
- `MsgStats`: [`./MsgStats.md`](./MsgStats.md)
- `MsgStorage`: [`./MsgStorage.md`](./MsgStorage.md)
- `MsgStore`: [`./MsgStore.md`](./MsgStore.md)
- `MsgUtils`: [`./MsgUtils.md`](./MsgUtils.md)
<!-- AUTO-GENERATED:MODULE-INDEX:END -->
