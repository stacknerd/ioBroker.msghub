# Plugin Index (built-ins)

This file is the central “what this repo ships with today” index for Message Hub plugins.

Notes:

- Plugin types are auto-discovered at adapter startup from `lib/*/manifest.js` (see `lib/index.js`).
- `defaultEnabled: true` means `IoPlugins` auto-creates instance `0` (if no instances exist yet) and starts it.
- `supportsMultiple: true` means you can create multiple instances (`0`, `1`, `2`, …) in the Admin Tab.

## Built-in plugin types

<!-- AUTO-GENERATED:PLUGIN-INDEX:START -->
| Type | Family | Purpose (short) | defaultEnabled | supportsMultiple | Docs |
| --- | --- | --- | --- | --- | --- |
| `BridgeAlexaShopping` | Bridge | Bidirectional sync between an Alexa list (alexa2) and a Message Hub shopping list. |  | ✓ | [`./BridgeAlexaShopping.md`](./BridgeAlexaShopping.md) |
| `BridgeAlexaTasks` | Bridge | Imports Alexa TODO items into Message Hub tasks and mirrors selected MsgHub tasks back to Alexa. |  | ✓ | [`./BridgeAlexaTasks.md`](./BridgeAlexaTasks.md) |
| `EngageSendTo` | Engage | Interact with MessageHub using “sendTo” in JavaScript and Blockly | ✓ |  | [`./EngageSendTo.md`](./EngageSendTo.md) |
| `IngestRandomChaos` | Ingest | Demo/load generator that periodically injects messages. |  | ✓ | [`./IngestRandomChaos.md`](./IngestRandomChaos.md) |
| `IngestStates` | Ingest | Generates MsgHub messages from ioBroker objects configured via “Custom” (Objects → Custom). | ✓ |  | [`./IngestStates.md`](./IngestStates.md) |
| `NotifyDebug` | Notify | Logs notification dispatches (debugging / development only). |  |  | [`./NotifyDebug.md`](./NotifyDebug.md) |
| `NotifyPushover` | Notify | Sends MsgHub due notifications to a Pushover adapter instance via sendTo(). |  | ✓ | [`./NotifyPushover.md`](./NotifyPushover.md) |
| `NotifyShoppingPdf` | Notify | Renders all allowed shopping lists into a single PDF and stores it in ioBroker file storage. |  | ✓ | [`./NotifyShoppingPdf.md`](./NotifyShoppingPdf.md) |
| `NotifyStates` | Notify | Writes notification events into ioBroker states (Latest / byKind / byLevel / Stats). | ✓ |  | [`./NotifyStates.md`](./NotifyStates.md) |
<!-- AUTO-GENERATED:PLUGIN-INDEX:END -->
