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
- Registration ID (as used by `lib/IoPlugins.js`): `IngestHue:<instanceId>` (example: `IngestHue:0`)
- Implementation: `lib/IngestHue/index.js` (`IngestHue(options)`)
- Hue model catalog (labels/batteries/tools): `lib/IngestHue/models.js`
- Input source: foreign ioBroker states below `hue.*` (from the Hue adapter)
- Host contract (MsgIngest): `start(ctx)`, `onStateChange(id, state)`, `stop()` (`onObjectChange` exists but is unused)

---

## Enable / runtime wiring (IoPlugins)

This plugin is configured and enabled by the adapter via `lib/IoPlugins.js`:

- Base object id: `msghub.0.IngestHue.<instanceId>`
- Enable switch: `msghub.0.IngestHue.<instanceId>.enable`
- Status: `msghub.0.IngestHue.<instanceId>.status`

---

## Config

Options (stored in the plugin object’s `native` JSON; all optional):

Note: unlike the other built-ins, `IngestHue` does not expose its option schema via `manifest.options` yet.
This means the dynamic Admin Tab config UI currently has no fields for it, but the keys below are still supported.
After changing `native`, restart the instance (disable+enable) to apply.

- `monitorBattery` (boolean, default `true`): watch `.battery` states
- `monitorReachable` (boolean, default `true`): watch `.reachable` states
- `batteryCreateBelow` (number, default `7`): create/update the battery message when battery is below this value
- `batteryRemoveAbove` (number, default `30`): remove the battery message when battery is at/above this value
- `reachableAllowRoles` (string array, default `["ZLLSwitch","ZLLPresence"]`):
  - filters reachable states by the **parent channel role** (to avoid noise)
  - `[]` means “allow all roles” (no filtering)

---

## Behavior

### Startup flow

On `start(ctx)` the plugin runs two steps (best-effort, async in the background):

1. **Discover Hue states (snapshot-based)**
   - loads all objects matching `hue.*`
   - selects:
     - battery states: ids ending with `.battery`
     - reachable states: ids ending with `.reachable`
   - avoids some duplicates:
     - battery is skipped for parent roles `ZLLLightLevel` and `ZLLTemperature` (common on presence sensors)
   - builds an in-memory “watched snapshot” (`id -> metadata`) with:
     - localized name (from ioBroker object `common.name`)
     - room name (from `enum.rooms.*`, using “longest prefix match”)
     - parent channel role (for filtering + labels)
     - Hue `modelid` (battery only; used for battery/tool hints)
   - subscribes/unsubscribes using `subscribeForeignStates(id)` / `unsubscribeForeignStates(id)`

2. **Evaluate current values once**
   - reads each watched state with `getForeignState(id)`
   - emits messages immediately so you don’t have to wait for the next state change event

Discovery currently happens only on startup. `onObjectChange` is intentionally a no-op to avoid expensive rescans on frequent object changes.

### Runtime flow (state changes)

When the Hue adapter updates a watched state:

- `onStateChange(id, state)` checks if `id` is in the `watched` map
- it applies the matching rule (battery or reachable)
- it creates/updates/completes a MsgHub message via `ctx.api.factory` + `ctx.api.store`

Unknown ids are ignored (important for safety, because all ingest plugins share the same host).

---

## Message identity (dedupe strategy)

Every message uses a stable `ref` so updates don’t create duplicates and messages survive restarts:

- Battery: `hue:battery:<stateId>`
- Reachable: `hue:reachable:<stateId>`

The plugin writes through `ctx.api.store.addOrUpdateMessage(...)`.

When the underlying condition becomes OK again (battery recovered / device reachable), the plugin marks the message as completed by patching it to `lifecycle.state="closed"` (clears `timing.notifyAt` and sets `progress.percentage=100`).
In code, this is done via `ctx.api.store.completeAfterCauseEliminated(ref, { actor, finishedAt })`.

---

## Battery monitoring (hysteresis)

Battery values are expected as percent numbers.

Rule:

- create/update when `battery < batteryCreateBelow`
- complete when `battery >= batteryRemoveAbove` (`lifecycle.state="closed"`)

This “two threshold” setup avoids flapping around one value.

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

Battery type and suggested tools come from `lib/IngestHue/models.js` (based on Hue `modelid`).

---

## Reachability monitoring

Reachability values are interpreted as booleans.

Rule:

- reachable `false` → create/update the message
- reachable `true` → complete the message (`lifecycle.state="closed"`)

Reachability messages:

- `kind`: `status`
- `level`: `error`
- `origin.system`: `IngestHue`
- `details` may include `location` (room) and a short `reason`

To reduce noise, reachable states can be filtered by the **parent role** (option `reachableAllowRoles`).

---

## “Managed” metadata on Hue states

Besides creating messages, `IngestHue` also reports watched state ids via:

- `await ctx.meta.managedObjects.report(...)`
- `await ctx.meta.managedObjects.applyReported()`

MsgHub then uses that information to stamp a small “managed by plugin” meta block onto those Hue state objects.

This makes it easier to understand in Admin *why* a `.battery` or `.reachable` state is monitored.

---

## Related files

- Implementation: `lib/IngestHue/index.js`
- Model catalog: `lib/IngestHue/models.js`
- Plugin runtime: `lib/IoPlugins.js`
- Core ingest host: `src/MsgIngest.js`
