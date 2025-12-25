# MsgHub Modules (src/) – Overview

This document describes how the core classes in `src/` work together. Detailed documentation for each module lives in `docs/modules/` and is linked below.

## Data Flow (Simplified)

1. **Input**: The adapter (e.g. `main.js`) receives ioBroker events (state/object changes) or import/automation events.
2. **Producers**: Producer plugins (typically in `lib/`) interpret these events and build message payloads.
3. **Ingest Host**: `MsgIngest` hosts producer plugins and provides a narrow API via `ctx.api.*`, separated from dispatch metadata in `ctx.meta`.
4. **Normalization**: `MsgFactory` validates/normalizes new messages (`createMessage`) and defines patch semantics (`applyPatch`).
5. **Single Source of Truth**: `MsgStore` owns the canonical in-memory list (`fullList`) and is the only place where this list is mutated.
6. **Side Effects (best-effort)**: After mutations, `MsgStore` triggers side effects:
   - Persistence of the full list via `MsgStorage`
   - Append-only history via `MsgArchive`
   - Notification dispatch via `MsgNotify` (fan-out to notifier plugins in `lib/`)
7. **Notifier Plugins (delivery)**: Notifier plugins (e.g. `lib/Notify*.js`) receive events from `MsgNotify` and perform the actual delivery (ioBroker states, push, TTS, ...). See [`../plugins/README.md`](../plugins/README.md).
8. **Output (read view)**: On reads, `MsgStore` returns a view; `MsgRender` creates `display.*` fields (resolving template placeholders from `metrics`/`timing`).

ASCII sketch - WRITE / MUTATE (create/update/delete + side effects):
```
ioBroker Events / Imports
        |
        v
Producer Plugins (lib/)
        |
        v
MsgIngest  --->  MsgFactory  --->  MsgStore (canonical list)
                               |-> MsgStorage (messages.json)
                               |-> MsgArchive (JSONL per ref)
                               |-> MsgNotify (events) ---> Notify Plugins (lib/Notify*.js)
```

ASCII sketch - READ / VIEW (rendering only; no mutation)
```
Consumer/UI  --->  MsgStore.getMessages()/getMessageByRef()  --->  MsgRender  --->  rendered output (display.*)
```

## Core Class Roles

- `MsgConstants` defines the shared vocabulary (enums for `level`, `kind`, `origin.type`, `attachments/actions`, notification events).
- `MsgFactory` is the validation/normalization gatekeeper for the `Message` schema and patch semantics.
- `MsgStore` is the central hub: owns `fullList`, coordinates persistence/archive/notifications, and returns rendered views.
- `MsgStorage` persists a complete JSON snapshot (typically the full message list) and revives `Map` fields (e.g. `metrics`).
- `MsgArchive` writes an append-only history (JSONL) per message `ref` for audit/debug/replay.
- `MsgNotify` dispatches notification events to registered notifier plugins (it does not deliver by itself).
- `MsgRender` resolves template placeholders (`{{m.*}}`, `{{t.*}}`) in `title/text/details` into a separate `display` block.
- `MsgIngest` is the plugin host for inbound events (producer plugins).
- `MsgUtils` contains shared helpers used by storage/archive.

## Modules

<!-- AUTO-GENERATED:MODULE-INDEX:START -->
- `MsgArchive`: [`./MsgArchive.md`](./MsgArchive.md)
- `MsgConstants`: [`./MsgConstants.md`](./MsgConstants.md)
- `MsgFactory`: [`./MsgFactory.md`](./MsgFactory.md)
- `MsgIngest`: [`./MsgIngest.md`](./MsgIngest.md)
- `MsgNotify`: [`./MsgNotify.md`](./MsgNotify.md)
- `MsgRender`: [`./MsgRender.md`](./MsgRender.md)
- `MsgStorage`: [`./MsgStorage.md`](./MsgStorage.md)
- `MsgStore`: [`./MsgStore.md`](./MsgStore.md)
- `MsgUtils`: [`./MsgUtils.md`](./MsgUtils.md)
<!-- AUTO-GENERATED:MODULE-INDEX:END -->
