# BridgeAlexaShopping

`BridgeAlexaShopping` is a Message Hub **bridge plugin** that synchronizes a single Alexa shopping list (from the `iobroker.alexa2` adapter) with one Message Hub message of kind `shoppinglist`.

This document has two parts:

1) A user-facing guide (setup, configuration, best practices).
2) A technical description (how it works internally).

---

## 1) User Guide

### What it does

- Creates and maintains one Message Hub message (`kind: shoppinglist`) representing your Alexa list.
- Keeps changes in sync:
  - Alexa → Message Hub (ingest)
  - Message Hub → Alexa (write-back)
- Optional: assigns a `category` to list items using Message Hub AI (when enabled).

What it intentionally does not do (today):

- It does not aggregate duplicates like “Butter” + “Butter” into a single item with a quantity.
- It does not parse quantities/units from item text (e.g. “2x”, “500g”).

### Prerequisites

- `iobroker.alexa2` must be installed and running.
- You need an Alexa list state that contains the list as a JSON array, typically:
  - `alexa2.0.Lists.<LISTNAME>.json`
- For write-back, your `alexa2` installation must expose the command states derived from that list id (see below).

If you want AI categories:

- The Message Hub adapter must have AI enabled in its instance config (provider + API key).
- The plugin option `aiEnhancement` must be enabled.

### Quick start (recommended setup)

1. Make sure the Alexa list JSON state exists and contains an array (in ioBroker Admin → Objects).
2. Create one `BridgeAlexaShopping` instance in the Message Hub Plugins tab.
3. Set:
   - `jsonStateId` to your Alexa list JSON state
   - `listTitle` to a human-friendly name
   - `fullSyncIntervalMs` to something reasonable (example: `3600000` = 1 hour)
4. Enable the plugin instance (`...enable` switch).
5. Watch the resulting Message Hub message:
   - Items from Alexa should appear as `listItems`.
6. Test write-back:
   - Add an item in the Message Hub list → it should appear in Alexa after the next sync.

### How to configure

Configuration is done in the Message Hub Admin Tab (Plugins) and uses the schema from `lib/BridgeAlexaShopping/manifest.js`.

Required / common options:

- `jsonStateId` (string)
  - The Alexa list JSON state (example: `alexa2.0.Lists.SHOP.json`).
  - This single option also determines the write-back command ids (derived from `jsonStateId` without the `.json` suffix).
- `listTitle` (string)
  - The Message Hub message title.
- `location` (string)
  - Written to `details.location` of the message.
- `audienceTagsCsv` (string, CSV)
  - Inbound (Alexa → MsgHub): comma-separated tags copied to `audience.tags`.
- `audienceChannelsIncludeCsv` / `audienceChannelsExcludeCsv` (string, CSV)
  - Inbound (Alexa → MsgHub): copied to `audience.channels.include` / `audience.channels.exclude`.
- `fullSyncIntervalMs` (number)
  - Periodic full reconciliation interval; `0` disables the periodic run.
- `conflictWindowMs` (number)
  - Conflict debounce window after write-back (see best practices below).
- `keepCompleted` (number, ms)
  - Retention time for completed items.
  - After this duration, completed items are deleted (in Message Hub and therefore also in Alexa).
  - Use `0` to never delete completed items.

AI options:

- `aiEnhancement` (boolean)
  - Enables optional AI enrichment (category assignment).
- `categoriesCsv` (string, CSV)
  - The list of allowed categories.
  - The last entry is treated as the fallback category.
- `aiMinConfidencePct` (number)
  - Minimum confidence (0..100) for accepting an AI category.
  - When below this threshold, the fallback category is used.

### How to find the correct `jsonStateId`

In ioBroker Admin:

- Open the Objects tab.
- Search for `alexa2.0.Lists.` and look for states ending in `.json`.
- Pick the list you want to sync (example: `alexa2.0.Lists.SHOP.json`).

The value must be a JSON array of items with (at least) `id`, `value`, and `completed` fields. If it is not an array,
the plugin treats it as empty.

### Write-back (how Alexa commands are addressed)

Write-back uses `setForeignState(...)` to these ids (derived from `jsonStateId`):

Let `base = jsonStateId` without the trailing `.json`.

- Create: `base.#New` or `base.#create` (value = item text; the plugin auto-detects which command state exists)
- Rename: `base.items.<itemId>.value` (value = new text)
- Toggle completion: `base.items.<itemId>.completed` (value = `true|false`)
- Delete: `base.items.<itemId>.#delete` (value = `true`)

Example for `jsonStateId = alexa2.0.Lists.SHOP.json`:

- `alexa2.0.Lists.SHOP.#New` (or `alexa2.0.Lists.SHOP.#create`)
- `alexa2.0.Lists.SHOP.items.<itemId>.value`
- `alexa2.0.Lists.SHOP.items.<itemId>.completed`
- `alexa2.0.Lists.SHOP.items.<itemId>.#delete`

### How to verify write-back is working

Use ioBroker Admin → Objects:

- Check that the derived command states exist under the same list base (without `.json`).
- When you add or change an item in Message Hub, you should see writes to:
  - `...#New` (or `...#create`) for new items
  - `...items.<id>.value` for renames
  - `...items.<id>.completed` for check/uncheck
  - `...items.<id>.#delete` for deletions

If these command states do not exist in your `alexa2` installation, Message Hub can still read the list, but cannot
write back to Alexa.

### Best practices

- Prefer one plugin instance per Alexa list.
- Keep `jsonStateId` stable. Changing it changes the message `ref` and resets the mapping for that instance.
- Use `fullSyncIntervalMs` even when state-change events are working:
  - It acts as a periodic reconciliation and helps recover from missed events or temporary connectivity issues.
- Keep completed-item cleanup explicit:
  - Use `keepCompleted=0` to keep completed items forever.
  - Use a finite value (example: `12 * 60 * 60 * 1000`) to automatically delete completed items after that time.
  - Deletion is enforced during reconciliation (`fullSyncIntervalMs`) and on inbound list updates.
- Avoid manual edits to internal states:
  - `msghub.0.BridgeAlexaShopping.<instanceId>.mapping`
  - `msghub.0.BridgeAlexaShopping.<instanceId>.categories`
  These states are intentionally marked read-only (for users); the adapter still writes to them internally.
- Conflicts and loops:
  - If you have other automations writing to the same Alexa list, keep `conflictWindowMs` at a non-zero value (default `5000`).
  - This reduces “ping-pong” updates by enforcing Message Hub as the source of truth after write-back.
- AI categories:
  - If `aiEnhancement` is enabled in the plugin but AI is disabled in the adapter instance config, category assignment is skipped (no errors; it just does nothing).
  - Keep `categoriesCsv` small and stable. Changing the list resets the learned cache for that plugin instance.
  - Pick categories that match how you actually shop. Example set:
    - `Produce,Bakery,Dairy,Meat,Frozen,Pantry,Drinks,Household,Hygiene,Other`

### Operational notes

- Disable behavior:
  - When you disable the plugin instance, the Message Hub message is kept.
  - The title is updated with a “connection lost” suffix (to make the inactive state visible).
- Managed state reporting:
  - The plugin reports the monitored `jsonStateId` as a managed state (metadata stamping + watchlist) so you can see
    which external state is used by this plugin instance.

### Troubleshooting

Common symptoms and what to check:

- “Nothing appears in Message Hub”
  - Verify `jsonStateId` exists and contains a JSON array.
  - Check whether the plugin instance is enabled and running.
  - Trigger a manual change in the Alexa list and confirm the `.json` state updates.

- “Items appear in Message Hub but do not write back to Alexa”
  - Verify the derived command states exist (see “Write-back” section).
  - Check adapter logs for warnings about `setForeignState` failures.

- “Items oscillate / ping-pong between values”
  - Increase `conflictWindowMs` (start with the default `5000`).
  - Reduce other automations that write to the same list, or ensure they do not fight Message Hub.

- “AI categories do not show up”
  - Confirm AI is enabled in the Message Hub adapter instance config and a valid API key is set.
  - Confirm `aiEnhancement=true` and `categoriesCsv` is not empty in the plugin instance config.
  - Note: AI categorization is best-effort; if AI is unavailable, syncing still works (without categories).

---

## 2) Software Documentation

### Overview

`BridgeAlexaShopping` is a bidirectional integration that is registered as a **bridge**:

- Ingest side: subscribes to the Alexa list JSON state and patches Message Hub.
- Notify side: observes Message Hub notifications and writes changes back to Alexa.

In the runtime, this bridge is registered via `MsgBridge` as two plugins under one identity:

- Ingest id: `BridgeAlexaShopping:<instanceId>.ingest`
- Notify id: `BridgeAlexaShopping:<instanceId>.notify`

Implementation:

- `lib/BridgeAlexaShopping/index.js`

### Message identity and content

The plugin creates and maintains exactly one message per plugin instance:

- `kind`: `shoppinglist`
- `ref`: `BridgeAlexaShopping.<instanceId>.<jsonStateId>`

The message is kept “non-due” by setting a far-future `timing.notifyAt` (Message Hub treats missing `notifyAt` as “due now”).

### Internal persistence (plugin states)

The plugin keeps two internal JSON states under the plugin base object id:

- Mapping state: `msghub.0.BridgeAlexaShopping.<instanceId>.mapping`
  - Stores the stable relationship between Message Hub list item ids and Alexa item ids.
  - Also tracks pending creates (MsgHub → Alexa) until the newly created Alexa item id appears in the JSON list.
  - Tracks when an item was first observed as `checked=true` (`checkedAt`) so `keepCompleted` retention can work reliably across restarts.
- Categories state: `msghub.0.BridgeAlexaShopping.<instanceId>.categories`
  - Stores the AI-learned category assignments for normalized item keys.
  - Contains:
    - `signature`: a normalized signature derived from the current `categoriesCsv`
    - `learned`: `{ "<normalizedKey>": { category, confidence, updatedAt } }`

Both states are created with `common.write=false` (read-only for users). The adapter can still update them.

Migration note:

- Older versions stored `categories` inside the mapping state.
- On startup, the plugin migrates that block into the dedicated `...categories` state once.

### Inbound sync (Alexa → Message Hub)

Input signal:

- ioBroker state changes for `jsonStateId` (string containing a JSON array).

Processing flow:

1. Parse the JSON array into items (best-effort; invalid JSON results in `[]`).
2. Maintain an id mapping:
   - Alexa item id (`extId`) ↔ Message Hub list item id (`internalId`)
   - For external-only items, the internal id is derived as `a:<extId>`.
3. Apply deletions:
   - If an Alexa item disappears from the list, the corresponding Message Hub item is deleted (hard rule).
4. Apply updates:
   - `value` maps to list item `name`
   - `completed` maps to list item `checked`
5. Completed-item retention:
   - If `keepCompleted > 0`, completed items are deleted after that duration.
   - The plugin tracks the first time an item becomes `checked=true` in its mapping state (`checkedAt`) and uses that timestamp.
   - Deletion is applied during reconciliation (startup full sync + periodic `fullSyncIntervalMs`).

Conflict handling:

- If the plugin recently wrote a value/checked change to Alexa (within `conflictWindowMs`), and Alexa reports a different value within that window, it is treated as a conflict.
- The plugin does not immediately “accept” the Alexa change; instead it schedules a debounced enforcement after `conflictWindowMs`.

### Outbound sync (Message Hub → Alexa)

Output signal:

- Message Hub notifications for the message `ref`.

Processing flow:

1. Detect removed list items (MsgHub item ids that disappeared):
   - If mapped to an Alexa `extId`, write `base.items.<extId>.#delete = true`.
2. For each current item:
   - If it has no mapping yet:
     - write `base.#New = <name>` (or `base.#create = <name>`) and record it in `pendingCreates`.
     - later “adopt” the created Alexa item id when it shows up in the JSON list.
   - If it has an `extId`:
     - write `base.items.<extId>.value` when the name differs
     - write `base.items.<extId>.completed` when checked differs
3. Completed-item retention:
   - Completed items are deleted via the same reconciliation mechanism when they exceed `keepCompleted`.

### AI categories (optional)

Category assignment is strictly optional and guarded by both:

- plugin option: `aiEnhancement=true`
- adapter AI availability: `ctx.api.ai.getStatus().enabled === true`

When enabled:

- Allowed labels come from `categoriesCsv`.
- A stable `signature` is derived from the allowed list; changing it resets the learned mapping.
- AI is called via `ctx.api.ai.json(...)` with `purpose: "categorize.shoppinglist"`.
- Results are applied as a silent patch (`stealthMode=true`) by setting `listItems.<id>.category`.

Caching behavior:

- The plugin persists the chosen category (including the fallback category) for a normalized key.
- This avoids repeated AI calls for ambiguous items.
