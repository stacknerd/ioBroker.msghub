# BridgeAlexaTasks

`BridgeAlexaTasks` is a Message Hub **bridge plugin** that integrates an Alexa TODO list (from `iobroker.alexa2`) with Message Hub task messages.

This plugin is designed for two main flows:

- **Inbound (Alexa → Message Hub)**: treat Alexa as a quick “inbox” for tasks.
- **Outbound (Message Hub → Alexa)**: mirror a filtered subset of Message Hub messages back into Alexa, so Alexa can read them.

---

## User guide

### Prerequisites

- `iobroker.alexa2` must be installed and running.
- You need an Alexa list JSON state, typically:
  - `alexa2.0.Lists.<LISTNAME>.json` (default: `alexa2.0.Lists.TODO.json`)

### How inbound import works

- When new items appear in the Alexa list JSON, they are imported as Message Hub tasks.
- If the import succeeds, the Alexa list item is deleted.
- If the import fails, the Alexa list item is marked as completed (so it won’t be re-imported).

### How outbound mirroring works

- The plugin continuously enforces that all Message Hub messages matching the outbound filter are present in the Alexa TODO list.
- Alexa is a display target only: changes made in Alexa to mirrored items are not synced back.
- Only the string value is mirrored; all other message fields are used only for filtering.

### Configuration

The option schema is defined in `lib/BridgeAlexaTasks/manifest.js` and rendered in the Admin Tab.

Common options:

- `jsonStateId`: Alexa list JSON state id (`alexa2.0.Lists.TODO.json`)
- `fullSyncIntervalMs`: periodic reconciliation interval (`0` disables)
- `audienceTagsCsv`: tags assigned to imported tasks
- `aiEnhancedTitle`: optional AI title generation for imported tasks

Outbound filter options:

- `outEnabled`: enable mirroring
- `outKindsCsv`: allowed message kinds (default `task`)
- `outLevelMin` / `outLevelMax`: allowed level range
- `outLifecycleStatesCsv`: allowed lifecycle states (default `open`)
- `outAudienceTagsAnyCsv`: optional tag filter (any match)

### Best practices

- Use one plugin instance per Alexa list.
- Keep `jsonStateId` stable for a plugin instance.
- Treat Alexa as an “inbox”: add tasks there, then work them in Message Hub.

---

## Software documentation

### Overview

`BridgeAlexaTasks` is registered as a **bridge** via `MsgBridge`:

- Ingest side: subscribes to `jsonStateId` and imports items.
- Notify side: reacts to Message Hub notifications and enforces the outbound projection.

Implementation:

- `lib/BridgeAlexaTasks/index.js`

### Internal persistence

The plugin stores its internal mapping in a read-only JSON state:

- `msghub.0.BridgeAlexaTasks.<instanceId>.mapping`

It contains:

- `out.messageRefToExternal`: MsgHub message ref → Alexa item id
- `out.externalToMessageRef`: Alexa item id → MsgHub message ref
- `out.pendingCreates`: tracks `#create` calls until the new Alexa item id appears in the JSON list

### Write-back command ids

Write-back uses `setForeignState(..., ack:false)` and derives ids from `jsonStateId`:

Let `base = jsonStateId` without the `.json` suffix.

- Create: `base.#create`
- Rename/update: `base.items.<itemId>.value`
- Mark completed: `base.items.<itemId>.completed`
- Delete: `base.items.<itemId>.#delete`

### Outbound value selection

For each mirrored message, the plugin derives the Alexa value as:

1. `message.details.task`
2. `message.text`
3. `message.title`

It only writes updates to Alexa when the derived value differs from the current Alexa item value.

