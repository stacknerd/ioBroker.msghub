# Producer: IngestHue

`IngestHue` is a Message Hub **ingest (producer)** plugin that watches the Hue adapter and turns common “device health”
signals into MsgHub messages:

- low battery → a **task** message (“replace batteries”)
- device unreachable → a **status** message (“not reachable”)

It is meant as an early-warning system: instead of checking Hue states manually, you get normalized messages that can be
archived, rendered, and forwarded by notifier plugins.

---

## Basics

- Type: `Ingest` (producer)
- Registration ID (as used by `lib/MsgPlugins.js`): `IngestHue:0`
- Implementation: `lib/IngestHue/index.js` (`IngestHue(adapter, options)`)
- Hue model catalog (labels/batteries/tools): `lib/IngestHue/models.js`
- Input source: foreign ioBroker states below `hue.*` (from the Hue adapter)

---

## Config

This plugin is configured by the adapter via `lib/MsgPlugins.js` (stored in the plugin object’s `native` JSON).

Example base object id (adapter instance `msghub.0`):

- `msghub.0.IngestHue.0`

Options (all optional):

- `monitorBattery` (boolean, default `true`): watch `.battery` states
- `monitorReachable` (boolean, default `true`): watch `.reachable` states
- `batteryCreateBelow` (number, default `7`): create/update the battery message when battery is below this value
- `batteryRemoveAbove` (number, default `30`): remove the battery message when battery is at/above this value
- `reachableAllowRoles` (string array, default `["ZLLSwitch","ZLLPresence"]`):
  - filters reachable states by the **parent channel role** (to avoid noise)
  - `[]` means “allow all roles” (no filtering)

Note: `options.pluginBaseObjectId` may be passed by `MsgPlugins`, but `IngestHue` does not currently use it (informational only).

---

## Behavior

### Startup flow

On `start(ctx)` the plugin runs two steps (best-effort, async in the background):

1. **Discover Hue states (snapshot-based)**
   - loads all objects matching `hue.*`
   - selects:
     - battery states: ids ending with `.battery`
     - reachable states: ids ending with `.reachable`
   - reads extra metadata and stores it in an in-memory `watched` map:
     - localized name (from ioBroker object `common.name`)
     - parent channel role (for filtering + labels)
     - Hue `modelid` (battery only; used for battery/tool hints)
     - room name (from `enum.rooms.*`, using “longest prefix match”)
   - subscribes/unsubscribes using `adapter.subscribeForeignStates(id)` / `adapter.unsubscribeForeignStates(id)`

2. **Evaluate current values once**
   - reads each watched state with `getForeignStateAsync(id)`
   - emits messages immediately so you don’t have to wait for the next state change event

Discovery currently happens only on startup. `onObjectChange` is intentionally a no-op to avoid expensive rescans on frequent object changes.

### Runtime flow (state changes)

When the Hue adapter updates a watched state:

- `onStateChange(id, state)` checks if `id` is in the `watched` map
- it then applies the matching rule (battery or reachable)
- it creates/updates/removes a MsgHub message via `ctx.api.store`

Unknown ids are ignored (important for safety, because all ingest plugins share the same host).

---

## Message identity (dedupe strategy)

Every message uses a stable `ref` so updates don’t create duplicates and messages survive restarts:

- Battery: `hue:battery:<stateId>`
- Reachable: `hue:reachable:<stateId>`

The plugin writes through `ctx.api.store.addOrUpdateMessage(...)` and removes via `ctx.api.store.removeMessage(ref)`.

---

## Battery monitoring (hysteresis)

Battery values are expected as percent numbers.

Rule:

- create/update when `battery < batteryCreateBelow`
- remove when `battery >= batteryRemoveAbove`

This “two threshold” setup avoids flapping around one value.

Example with defaults (`createBelow=7`, `removeAbove=30`):

- battery `5` → create/update the message
- battery `10` → keep the message (no removal yet)
- battery `30` → remove the message

Battery messages:

- `kind`: `task`
- `level`: `warning`
- `origin.system`: `IngestHue`
- `details` may include:
  - `location` (room)
  - `task` (“Replace batteries in …”)
  - `reason` (current battery level)
  - `consumables` (battery type, if known)
  - `tools` (tool list, if known)

The battery type and suggested tools come from `lib/IngestHue/models.js` (based on Hue `modelid`).

---

## Reachability monitoring

Reachability values are interpreted as booleans.

Rule:

- reachable `false` → create/update the message
- reachable `true` → remove the message

Reachability messages:

- `kind`: `status`
- `level`: `error`
- `origin.system`: `IngestHue`
- `details` may include `location` (room) and a short `reason`

To reduce noise, reachable states can be filtered by the **parent role** (option `reachableAllowRoles`).

---

## “Managed” metadata on Hue states

Besides creating messages, `IngestHue` also tags watched states with a small “managed” marker.
This helps users understand *why* a `.battery` or `.reachable` state is monitored.

Best-effort write targets:

- `obj.native.meta` (common place to store adapter-specific meta)
- `obj.common.custom[adapter.namespace].meta` (visible in many Custom UIs)

Fields written:

- `managedBy`: `IngestHue Plugin`
- `managedText`: a short description of what the plugin does for this state
- `managedSince`: first-seen timestamp (ISO)

---

## What `lib/IngestHue/models.js` does

Hue devices report a `modelid` (for example `RDM001`).
`models.js` contains a small, curated lookup table (`HUE_MODELS`) that maps `modelid` to:

- a human-friendly device label (i18n map)
- battery type information (string or list like `["AAA","AAA"]`)
- suggested tools (i18n map or list; used to build a simple tools array)

`IngestHue` uses this table only for **battery** messages to make the “replace batteries” task more actionable.
If a model is unknown, the plugin falls back to a generic “Hue device” label and omits extra hints.

---

## Examples

### Enable via `MsgPlugins` (recommended)

- Enable the plugin state `msghub.0.IngestHue.0` (`true` with `ack:false` in ioBroker).
- The plugin will discover Hue states under `hue.*` and start producing messages.

### Manual registration (code)

```js
const { IngestHue } = require(`${__dirname}/lib`);

this.msgStore.msgIngest.registerPlugin(
	'IngestHue:0',
	IngestHue(this, {
		monitorBattery: true,
		monitorReachable: true,
		reachableAllowRoles: ['ZLLSwitch', 'ZLLPresence'],
		batteryCreateBelow: 7,
		batteryRemoveAbove: 30,
	}),
);
```

Example refs you may see:

- `hue:battery:hue.0.bridge1.switch1.battery`
- `hue:reachable:hue.0.bridge1.switch1.reachable`

---

## Related files

- Implementation: `lib/IngestHue/index.js`
- Hue model catalog: `lib/IngestHue/models.js`
- Plugin runtime (enable/disable + options): `lib/MsgPlugins.js`
- Plugin catalog defaults: `lib/index.js`
- Plugin overview: `docs/plugins/README.md`
