# Plugin Index (built-ins)

This file is the central “what this repo ships with today” index for Message Hub plugins.

Notes:

- Plugin types are auto-discovered at adapter startup from `lib/*/manifest.js` (see `lib/index.js`).
- `defaultEnabled: true` means `IoPlugins` auto-creates instance `0` (if no instances exist yet) and starts it.
- `supportsMultiple: true` means you can create multiple instances (`0`, `1`, `2`, …) in the Admin Tab.

## Built-in plugin types

| Type | Family | Purpose (short) | defaultEnabled | supportsMultiple | Docs |
| --- | --- | --- | --- | --- | --- |
| `IngestRandomChaos` | Ingest | Demo/load generator that injects messages | `false` | `true` | [`./IngestRandomChaos.md`](./IngestRandomChaos.md) |
| `IngestHue` | Ingest | Monitors Hue battery/reachability and creates tasks | `true` | `true` | [`./IngestHue.md`](./IngestHue.md) |
| `EngageSendTo` | Engage | Control plane via ioBroker `sendTo` | `true` | `false` | [`./EngageSendTo.md`](./EngageSendTo.md) |
| `NotifyStates` | Notify | Writes notification events to ioBroker states | `true` | `false` | [`./NotifyStates.md`](./NotifyStates.md) |
| `NotifyDebug` | Notify | Logs notification dispatches (debug/dev only) | `false` | `false` | [`./NotifyDebug.md`](./NotifyDebug.md) |
| `NotifyPushover` | Notify | Sends MsgHub due notifications to Pushover (sendTo) | `false` | `true` | [`./NotifyPushover.md`](./NotifyPushover.md) |
| `BridgeAlexaShopping` | Bridge | Sync Alexa (alexa2) list items with MsgHub | `false` | `true` | [`./BridgeAlexaShopping.md`](./BridgeAlexaShopping.md) |
| `BridgeAlexaTasks` | Bridge | Import Alexa TODO items and mirror MsgHub tasks | `false` | `true` | [`./BridgeAlexaTasks.md`](./BridgeAlexaTasks.md) |

This repo also ships a first `Bridge...` implementation as a bidirectional example.
