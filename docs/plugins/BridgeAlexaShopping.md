# Bridge: BridgeAlexaShopping

`BridgeAlexaShopping` is a Message Hub **bridge** plugin that syncs a single Alexa list (from `alexa2`) to one MsgHub message of kind `shoppinglist`.

---

## Basics

- Type: `Bridge` (bidirectional; wired via `MsgBridge`)
- Registration ID (runtime): `BridgeAlexaShopping:<instanceId>` (example: `BridgeAlexaShopping:0`)
- Implementation: `lib/BridgeAlexaShopping/index.js`

---

## Enable / runtime wiring (IoPlugins)

This plugin is managed by `IoPlugins`:

- Base object id: `msghub.0.BridgeAlexaShopping.<instanceId>`
- Enable switch: `msghub.0.BridgeAlexaShopping.<instanceId>.enable`
- Status: `msghub.0.BridgeAlexaShopping.<instanceId>.status`
- Internal mapping state: `msghub.0.BridgeAlexaShopping.<instanceId>.mapping`

---

## Config

The option schema is defined in `lib/BridgeAlexaShopping/manifest.js` and rendered automatically in the Admin Tab.

Key options:

- `jsonStateId` (string): Alexa list JSON state id (example: `alexa2.0.Lists.SHOP.json`)
- `listTitle` (string): MsgHub message title
- `location` (string): copied to `details.location`
- `audienceTagsCsv` (string): comma-separated tags copied to `audience.tags`
- `fullSyncIntervalMs` (number): periodic full sync interval
- `conflictWindowMs` (number): debounce window for conflict enforcement
- `keepCompleted` (boolean): when disabled, completed items are deleted (also in Alexa)
- `aiEnhancement` (boolean): enables optional AI enrichment
- `categoriesCsv` (string): allowed categories (CSV); last entry is the fallback category
- `aiMinConfidencePct` (number): AI confidence threshold (0..100) for accepting a category

---

## Message identity

The plugin creates/maintains exactly one message per plugin instance:

- `kind`: `shoppinglist`
- `ref`: `BridgeAlexaShopping.<instanceId>.<jsonStateId>`

---

## Sync model (high level)

- Alexa list changes (`*.json`) are ingested into the message `listItems`.
- MsgHub changes to `listItems` are written back to Alexa via `setForeignState(...)` command states:
  - `...#create` (create)
  - `...items.<itemId>.value` (rename)
  - `...items.<itemId>.completed` (check/uncheck)
  - `...items.<itemId>.#delete` (delete)

Source of truth:

- Message Hub wins on value/checked conflicts (debounced by `conflictWindowMs`).
- Alexa deletion removes the corresponding MsgHub list item.

---

## AI categories

When `aiEnhancement` is enabled, the plugin can assign `listItems[].category` via `ctx.api.ai`.

Rules:

- Allowed categories come from `categoriesCsv` (comma-separated).
- The last category entry is used as a fallback when AI is unsure or returns an invalid category.
- AI results are accepted only when `confidence >= aiMinConfidencePct/100`; otherwise the fallback category is used.
- Learned assignments are persisted in the plugin mapping state to avoid repeated AI calls.
