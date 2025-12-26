# Bridge: BridgeRandomDemo

`BridgeRandomDemo` is a **Bridge plugin demo/template** that implements a bidirectional (“full sync”) integration between:

- a single Message Hub **list message** (one `Message` with `listItems`), and
- a folder of **ioBroker states** below the plugin’s own object subtree.

It is designed as a readable reference implementation for third-party developers who want to build real bridge plugins.

---

## Basics

- Type: `Bridge`
- Registration ID (as used by `lib/MsgPlugins.js`): `BridgeRandomDemo:0`
- Implementation: `lib/BridgeRandomDemo/index.js` (`BridgeRandomDemo(adapter, options)`)
- “List message” ref (source of truth inside MsgHub): `options.pluginBaseObjectId` (full id)
  - Example: `msghub.0.BridgeRandomDemo.0`
- Item states folder (source of truth inside ioBroker):
  - Example: `msghub.0.BridgeRandomDemo.0.Items.*`

---

## Concept / data model

### 1) The MsgHub side: one list message

The bridge owns exactly one message in the MsgHub store:

- `ref`: the plugin’s full base id (`options.pluginBaseObjectId`)
- `kind`: `shoppinglist` (default) or `inventorylist`
- `listItems`: the synchronized item list

Each list item uses:

- `listItems[].id`: the *full ioBroker object id* of the corresponding item state
- `listItems[].name`: the human text (mirrored into the state value)

### 2) The ioBroker side: one state per list item

Users create and edit item states below the plugin base object:

- folder/channel: `<base>.<itemsChannel>` (default: `<base>.Items`)
- item state: `<base>.<itemsChannel>.<itemKey>`
- state value (`string`) is the item text

Example:

- state id: `msghub.0.BridgeRandomDemo.0.Items.milk`
- state value: `"Milk"`
- resulting list item: `{ id: "msghub.0.BridgeRandomDemo.0.Items.milk", name: "Milk", checked: false }`

---

## Config

This plugin is configured by the adapter via `lib/MsgPlugins.js`:

- Enable switch: `msghub.0.BridgeRandomDemo.0` (`boolean`, write with `ack:false` to toggle)
- Default in the catalog: disabled (`defaultEnabled: false`) so it does not create demo objects unless you opt in
- Options: stored on the same object under `native` (raw JSON)
- The runtime additionally passes:
  - `options.pluginBaseObjectId` (required): full id of the plugin base object

Options (all optional):

- `itemsChannel` (string, default `"Items"`): channel name below the base id where item states live.
- `listKind` (`"shoppinglist"` or `"inventorylist"`, default `"shoppinglist"`): message kind for the list message.
- `listLevel` (number, default `MsgConstants.level.notice`): message level for the list message.
- `listTitle` (string): title for the list message.
- `listText` (string): description text for the list message.
- `resyncIntervalMs` (number, default `60000`): periodic “full resync” interval (0 disables).
- `cycleIntervalMs` (number, default `15000`): demo add/remove item interval (0 disables).

---

## Behavior (full sync)

### Startup (`ingest.start(ctx)`)

- Creates the `Items` channel (or your configured `itemsChannel`) if missing.
- Scans existing item states in that folder (best-effort).
- Ensures the list message exists in the MsgHub store.
- Reconciles the list message’s `listItems` with the discovered ioBroker states.

### ioBroker → MsgHub (state edits)

When a user creates/edits/deletes a state below `<base>.Items.*`:

- new state → corresponding list item is added to the list message
- state value change → list item `name` is updated
- state deleted (object removed) → list item is removed

Loop protection:

- The ingest side ignores only its own recent `ack:true` writes (same value within a short window) so the plugin does not loop on its own writes.
  It still accepts `ack:true` updates from other sources.

### MsgHub → ioBroker (list edits)

When the list message is updated and a notification is dispatched:

- new list item → the plugin creates the corresponding ioBroker state and writes the text (`ack:true`)
- renamed list item → the plugin updates the state value
- removed list item → the plugin deletes the corresponding state object

The plugin only touches items whose `id` is below its own subtree (`<base>.Items.*`).

---

## Demo activity: cyclic add/remove

To ensure “something happens” even in an empty system, the plugin periodically toggles a demo item:

- list item id: `...Items._cycle`
- action: add (with timestamp text) → remove → add → remove → ...

This demo change happens on the MsgHub side (listItems patch), so the notify handler demonstrates MsgHub → ioBroker sync.

---

## Examples

### 1) Add an item via ioBroker (user-driven)

Create a new state below the folder and write a text value. The bridge will add/update the corresponding list item (note: only available in "Expert Mode" on Admin)

Example ids (adapter instance `msghub.0`):

- `msghub.0.BridgeRandomDemo.0.Items.todo1` = `"Buy milk"`
- `msghub.0.BridgeRandomDemo.0.Items.todo2` = `"Check batteries"`

### 2) Edit the list message (developer-driven)

If you update the list message’s `listItems` (message `ref` = `msghub.0.BridgeRandomDemo.0`), the bridge will create/update/delete the corresponding states in ioBroker.

This is the typical “bridge” direction for real integrations (external list system → ioBroker).

---

## Related files

- Implementation: `lib/BridgeRandomDemo/index.js`
- Plugin runtime/wiring: `lib/MsgPlugins.js`, `src/MsgBridge.js`
- Message model: `src/MsgFactory.js`
- Plugin overview: `docs/plugins/README.md`
