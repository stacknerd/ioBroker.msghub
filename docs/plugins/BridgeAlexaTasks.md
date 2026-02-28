# BridgeAlexaTasks

`BridgeAlexaTasks` is a Message Hub **bridge plugin** that synchronizes a single Alexa TODO list (from the `iobroker.alexa2` adapter) with Message Hub task messages (`kind: task`).

This document has two parts:

1) A user-facing guide (setup, configuration, best practices).
2) A technical description (how it works internally).

---

## 1) User Guide

### What it does

- Imports new Alexa TODO items into Message Hub as tasks (Alexa → Message Hub).
- Mirrors a filtered subset of Message Hub messages back into the Alexa TODO list (Message Hub → Alexa).
- Optional: generates a concise title for imported tasks using Message Hub AI (when enabled).

What it intentionally does not do:

- It does not sync edits from Alexa back into Message Hub for mirrored tasks (Alexa is display-only for outbound items).
- It does not attempt to preserve lifecycle semantics on the Alexa side (Alexa does not have Message Hub lifecycle states).

### Prerequisites

- `iobroker.alexa2` must be installed and running.
- You need an Alexa list state that contains the list as a JSON array, typically:
  - `alexa2.0.Lists.<LISTNAME>.json` (default: `alexa2.0.Lists.TODO.json`)
- For write-back (mirroring), your `alexa2` installation must expose the command states derived from that list id (see below).

If you want AI titles:

- The Message Hub adapter must have AI enabled in its instance config (provider + API key).
- The plugin option `aiEnhancedTitle` must be enabled.

### Quick start (recommended setup)

1. Make sure the Alexa TODO list JSON state exists and contains an array (in ioBroker Admin → Objects).
2. Create one `BridgeAlexaTasks` instance in the Message Hub Plugins tab.
3. Set:
   - `jsonStateId` to your Alexa list JSON state
   - `fullSyncIntervalMs` to something reasonable (example: `3600000` = 1 hour)
   - `outEnabled` depending on whether you want mirroring back to Alexa
4. Enable the plugin instance (`...enable` switch).
5. Add an item in Alexa:
   - It should appear in Message Hub as a new `task` message.
   - It should then be deleted from the Alexa TODO list (inbox semantics).

### How to configure

Configuration is done in the Message Hub Admin Tab (Plugins) and uses the schema from `lib/BridgeAlexaTasks/manifest.js`.

Common options:

- `jsonStateId` (string)
  - The Alexa list JSON state (example: `alexa2.0.Lists.TODO.json`).
  - This single option also determines the write-back command ids (derived from `jsonStateId` without the `.json` suffix).
- `fullSyncIntervalMs` (number)
  - Periodic full reconciliation interval; `0` disables the periodic run.
- `pendingMaxJsonMisses` (number)
  - How many Alexa JSON updates are allowed before a pending "create" is retried.
- `audienceTagsCsv` (string, CSV)
  - Inbound (Alexa → MsgHub): comma-separated tags copied to `audience.tags` for imported tasks.
- `audienceChannelsIncludeCsv` / `audienceChannelsExcludeCsv` (string, CSV)
  - Inbound (Alexa → MsgHub): copied to `audience.channels.include` / `audience.channels.exclude` for imported tasks.
- `aiEnhancedTitle` (boolean)
  - When enabled and AI is available, the plugin generates a concise title for imported tasks.

Outbound mirroring (projection) options:

- `outEnabled` (boolean)
  - Enables mirroring tasks back to Alexa.
  - If you disable it, the plugin removes all previously mirrored items from Alexa on the next reconciliation run.
- `outKindsCsv` (string, CSV)
  - Which message kinds may be mirrored (default `task`).
- `outLevelMin` / `outLevelMax` (number)
  - Inclusive message level range for mirroring.
- `outLifecycleStatesCsv` (string, CSV)
  - Allowed lifecycle states (default `open`).
- `outAudienceTagsAnyCsv` (string, CSV)
  - Optional tag filter: message must have at least one matching `audience.tags` entry.
  - Messages with no tags (missing/empty `audience.tags`) are treated as “public” and are included as well.

Note:

- For `kind=task`, outbound mirroring only includes messages where `timing.startAt` is either missing (unscheduled) **or** set to a timestamp in the past (`startAt <= now`).
- Outbound items in Alexa are always written with a leading `~` (tilde). These `~`-prefixed items are treated as plugin-owned projections.

### How to find the correct `jsonStateId`

In ioBroker Admin:

- Open the Objects tab.
- Search for `alexa2.0.Lists.` and look for states ending in `.json`.
- Pick the list you want to use (example: `alexa2.0.Lists.TODO.json`).

The value must be a JSON array of items with (at least) `id`, `value`, and `completed` fields. If it is not an array,
the plugin treats it as empty.

### Write-back (how Alexa commands are addressed)

Write-back uses `setForeignState(...)` to these ids (derived from `jsonStateId`):

Let `base = jsonStateId` without the trailing `.json`.

- Create: `base.#New` or `base.#create` (value = item text; the plugin auto-detects which command state exists)
- Rename/update: `base.items.<itemId>.value` (value = new text)
- Mark completed: `base.items.<itemId>.completed` (value = `true|false`)
- Delete: `base.items.<itemId>.#delete` (value = `true`)

### How to verify write-back is working

Use ioBroker Admin → Objects:

- Check that the derived command states exist under the same list base (without `.json`).
- When mirroring is enabled (`outEnabled=true`), you should see writes to:
  - `...#New` (or `...#create`) for new mirrored items
  - `...items.<id>.value` when a mirrored item changes
  - `...items.<id>.#delete` when an item is removed from the projection

If these command states do not exist in your `alexa2` installation, Message Hub can still import tasks from Alexa,
but cannot mirror tasks back to Alexa.

### Best practices

- Use one plugin instance per Alexa list.
- Keep `jsonStateId` stable for a plugin instance.
- Use a periodic `fullSyncIntervalMs` even when state-change events are working:
  - It acts as a reconciliation loop and helps recover from missed events.
- Treat Alexa as a quick task inbox:
  - Add tasks in Alexa, then manage them in Message Hub.
- Keep the outbound filter narrow:
  - Default idea: only `kind=task`, `level>=10`, `lifecycle=open`.

### Operational notes

- Inbound import semantics:
  - If import succeeds, the plugin deletes the Alexa item.
  - If import fails, the plugin marks the Alexa item as completed to avoid repeated imports.
- Disabling outbound mirroring:
  - When `outEnabled=false`, all previously mirrored items are removed from Alexa on the next reconciliation run.
- Managed state reporting:
  - The plugin reports the monitored `jsonStateId` as a managed state (metadata stamping + watchlist).

### Troubleshooting

Common symptoms and what to check:

- “Items in Alexa are not imported”
  - Verify `jsonStateId` exists and contains a JSON array.
  - Check whether the plugin instance is enabled and running.
  - Trigger a manual change in the Alexa list and confirm the `.json` state updates.

- “Mirroring to Alexa does not work”
  - Verify the derived command states exist (see “Write-back” section).
  - Confirm `outEnabled=true`.

- “AI titles do not show up”
  - Confirm AI is enabled in the Message Hub adapter instance config and a valid API key is set.
  - Confirm `aiEnhancedTitle=true` in the plugin instance config.
  - Note: AI enrichment is best-effort; importing still works without AI.

---

## 2) Software Documentation

### Overview

`BridgeAlexaTasks` is a bidirectional integration that is registered as a **bridge**:

- Ingest side: subscribes to the Alexa list JSON state and imports items into Message Hub.
- Notify side: observes Message Hub notifications and enforces the outbound projection in Alexa.

In the runtime, this bridge is registered via `MsgBridge` as two plugins under one identity:

- Ingest id: `BridgeAlexaTasks:<instanceId>.ingest`
- Notify id: `BridgeAlexaTasks:<instanceId>.notify`

Implementation:

- `lib/BridgeAlexaTasks/index.js`

### Message identity and content (imported tasks)

For inbound items (Alexa → Message Hub), the plugin creates one Message Hub message per Alexa item id:

- `kind`: `task`
- `ref`: `BridgeAlexaTasks.<instanceId>.<jsonStateId>.<extId>`
- `title`: either the raw Alexa value or the AI-enhanced title (when enabled)
- `text`: the raw Alexa value
- `details.task`: the raw Alexa value
- `origin`: `{ type: "automation", system: "Amazon Alexa", id: <jsonStateId> }`
- `audience.tags`: copied from `audienceTagsCsv` (optional)
- `audience.channels`: copied from `audienceChannelsIncludeCsv` / `audienceChannelsExcludeCsv` (optional)
- `actions`: auto-provided (`ack`, `snooze (4h)`, `close`)

The task is created as “active now” by setting `timing.startAt=Date.now()` and leaving `timing.notifyAt` unset (so it may notify immediately).

### Internal persistence (plugin state)

The plugin stores its internal mapping in a read-only JSON state:

- `msghub.0.BridgeAlexaTasks.<instanceId>.mapping`

It contains the outbound projection bookkeeping:

- `out.messageRefToExternal`: MsgHub message ref → Alexa item id
- `out.externalToMessageRef`: Alexa item id → MsgHub message ref
- `out.pendingCreates`: tracks create requests until the new Alexa item id appears in the JSON list
  - `expectedValue`: exact Alexa value written via `#New/#create`
  - `misses`: number of JSON updates without seeing `expectedValue`
  - `tries`: number of create attempts

This state is created with `common.write=false` (read-only for users). The adapter can still update it.

### Inbound sync (Alexa → Message Hub)

Input signals:

- ioBroker state changes for `jsonStateId` (string containing a JSON array)
- periodic full sync (`fullSyncIntervalMs`)

Processing flow:

1. Parse the JSON array into items (best-effort; invalid JSON results in `[]`).
2. Ignore items that are already completed in Alexa.
3. Ignore items that are “owned” by the outbound projection (mirrored items) using `externalToMessageRef`.
4. For each remaining Alexa item:
   - create or update a `task` message in Message Hub
   - if Message Hub add/update succeeds: delete the Alexa item (`...items.<id>.#delete = true`)
   - otherwise: mark the Alexa item as completed (`...items.<id>.completed = true`)

Note:

- Inbound ignores Alexa items whose `value` starts with `~` to avoid feedback loops with outbound mirroring.

### Outbound sync (Message Hub → Alexa)

Output signals:

- Message Hub notifications (triggering a debounced outbound sync)
- periodic full sync (`fullSyncIntervalMs`)

Processing flow:

1. Compute the desired projection: all messages that match the outbound filter.
   - Note: the plugin channel (`native.channel`) participates in MsgHub channel routing. Outbound projection uses the same routing semantics by querying with `audience.channels.routeTo = <plugin channel>` (so the “pull” selection matches the notify-side filtering).
2. Drop stale mapping entries:
   - If a mapped Alexa item id no longer exists in the Alexa JSON list (for example because a user deleted it in Alexa), the plugin removes that mapping entry so the item can be recreated.
   - To avoid churn from temporarily inconsistent Alexa JSON snapshots, the plugin only drops the mapping after the item was missing across multiple Alexa JSON updates.
3. For messages that are no longer desired:
   - delete the corresponding Alexa item (`...items.<id>.#delete = true`)
   - remove it from the mapping.
4. For desired messages:
   - if not mapped yet:
     - create an Alexa item via `base.#New` or `base.#create` and track it as pending
     - later “adopt” the created Alexa item id when it appears in the JSON list
     - if the expected value does not show up for `pendingMaxJsonMisses` JSON updates, the create is retried
   - if mapped:
     - update `...items.<id>.value` only when the desired text changed

Orphan / recovery behavior:

- If a `~`-prefixed Alexa item exists but does not match any currently desired outbound item, it is treated as an orphan and deleted in Alexa.
- If the mapping was reset/lost but a `~`-prefixed Alexa item matches a desired outbound value, the plugin adopts it into the mapping instead of creating a duplicate.

Outbound value selection:

1. `message.details.task`
2. `message.text`
3. `message.title`

### Disabling outbound mirroring

When `outEnabled=false`, the plugin removes all previously mirrored items from Alexa during the next reconciliation run
(outbound sync) and clears the mapping afterwards. Import from Alexa (inbound) is unaffected.
