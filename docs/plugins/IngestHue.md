# IngestHue

`IngestHue` is a Message Hub **ingest plugin** that watches a configured ioBroker Hue adapter instance and turns device-health signals into MsgHub messages:

- low battery -> a **task** message
- device unreachable -> a **status** message

This document has two parts:

1. A user-facing guide (setup, configuration, best practices).
2. A technical description (runtime behavior and message mapping).

---

## 1) User Guide

### What it does

- Watches Hue states below one configured Hue adapter instance, for example `hue.0`.
- Monitors:
  - `*.battery` as numeric battery percentage
  - `*.reachable` as boolean reachability state
- Creates stable messages without duplicates across restarts.
- Closes messages automatically via “cause eliminated” when the source state recovers.
- Periodically rescans Hue objects so newly added or removed devices are picked up without a broad wildcard subscription.

What it intentionally does not do:

- It does not control Hue devices.
- It does not write to Hue adapter states.
- It does not provide a plugin-owned Admin UI panel; configuration is handled through the plugin manifest options.

### Prerequisites

- The ioBroker Hue adapter must be installed and running.
- Hue objects should follow the common adapter shape:
  - device/channel objects with `common.role`
  - `*.battery` states
  - `*.reachable` states
  - optional Hue `native.modelid` on the parent device/channel object
- Optional: maintain `enum.rooms.*` assignments for useful message locations.

### Quick start

1. Verify that Hue states exist in ioBroker Admin -> Objects, for example `hue.0...battery` or `hue.0...reachable`.
2. Create an `IngestHue` plugin instance in the Message Hub Plugins tab.
3. Set `hueInstance` to your Hue adapter instance, for example `hue.0`.
4. Keep `Report battery levels` and `Report reachability problems` enabled unless you want only one signal type.
5. Adjust the battery thresholds if needed.
6. Enable the plugin instance.

### Configuration

Configuration is done in the Message Hub Admin Tab (Plugins) and uses the schema from `lib/IngestHue/manifest.js`.

Options:

- `hueInstance` (string, default `hue.0`)
  - Source Hue adapter instance.
- `monitorBattery` (boolean, default `true`)
  - Enables battery reporting.
- `batteryCreateBelow` (number, default `7`)
  - Creates or updates the battery task when the battery level is below this value.
- `batteryRemoveAbove` (number, default `30`)
  - Closes the battery task as cause-eliminated when the battery level reaches this value.
- `monitorReachable` (boolean, default `true`)
  - Enables reachability reporting.
- `reachableAllowRolesCsv` (string, default `ZLLSwitch, ZLLPresence`)
  - Comma-separated parent roles for `*.reachable` states.
  - Empty means all parent roles are monitored.
- `rescanIntervalMs` (number, default `3600000`)
  - Periodic rediscovery interval in milliseconds.
  - `0` disables periodic rescans.
- `audienceTagsCsv` (string, CSV)
  - Comma-separated tags copied to `audience.tags` when a message is created.
- `audienceChannelsIncludeCsv` / `audienceChannelsExcludeCsv` (string, CSV)
  - Copied to `audience.channels.include` / `audience.channels.exclude` when a message is created.

### Battery model hints

`IngestHue` contains a Hue model catalog in `lib/IngestHue/models.js`.

For known Hue models, battery tasks include:

- device label
- required consumables, for example `AAA`, `CR2032`
- required tools, where known
- estimated task time

Generic consumables and standard tools use the shared root i18n vocabulary (`msghub.i18n.core.common.*`) so the same battery
and tool labels can be reused across ingest plugins.

Reachability messages also use the model catalog for the device label when a Hue `modelid` is available. The configured
role filter only decides which `*.reachable` states are monitored; it does not decide the display label.

The estimate is stored explicitly on each catalog entry so individual models can be refined independently.

To avoid duplicate battery tasks for Hue motion sensors, battery states whose parent role is `ZLLLightLevel` or `ZLLTemperature` are ignored. Hue often duplicates the same physical battery state below the integrated light-level and temperature sensor channels.

### Best practices

- Keep `batteryCreateBelow` and `batteryRemoveAbove` separated to avoid flapping.
- Start with the default reachability role filter and expand only when needed.
- Keep Hue object names and room enums meaningful; they are used for message titles and locations.
- Use a sparse rescan interval. One hour is usually enough because state subscriptions handle live value changes once a device has been discovered.

### Troubleshooting

Common symptoms and checks:

- “No messages appear”
  - Verify that the plugin instance is enabled and running.
  - Verify `hueInstance` is correct.
  - Verify states exist below the configured instance.

- “Reachability messages are missing”
  - Check the parent object role.
  - Adjust `reachableAllowRolesCsv`, or clear it to monitor all roles.

- “A new Hue device is missing”
  - Wait for the next rescan or temporarily disable and re-enable the plugin instance.

- “Locations are empty”
  - Add or maintain `enum.rooms.*` memberships for the Hue device objects.

---

## 2) Software Documentation

### Overview

`IngestHue` is registered as an **ingest** plugin:

- Registration id: `IngestHue:<instanceId>` (example: `IngestHue:0`)
- Implementation: `lib/IngestHue/index.js`
- Manifest: `lib/IngestHue/manifest.js`
- Model catalog: `lib/IngestHue/models.js`
- Backend i18n: `lib/IngestHue/i18n/<lang>.json`

### Runtime wiring

`IoPlugins` creates the instance subtree under the Message Hub adapter namespace:

- Base object: `msghub.0.IngestHue.<instanceId>` with options in `object.native`
- Enable state: `msghub.0.IngestHue.<instanceId>.enable`
- Status state: `msghub.0.IngestHue.<instanceId>.status`
- Optional watchlist state created by managed metadata reporting

The plugin uses only the plugin runtime context:

- `ctx.api.iobroker.objects`
- `ctx.api.iobroker.states`
- `ctx.api.iobroker.subscribe`
- `ctx.api.store`
- `ctx.api.factory`
- `ctx.api.i18n`
- `ctx.meta.options`
- `ctx.meta.resources`
- `ctx.meta.managedObjects`

### Discovery and rescan

On start and on each configured rescan:

1. Load `enum.rooms.*` to build a room lookup.
2. Load foreign objects matching `<hueInstance>.*`.
3. Select matching state objects:
   - `*.battery` when `monitorBattery=true`
   - `*.reachable` when `monitorReachable=true`
4. Enrich each watched state with:
   - parent role
   - display name
   - room
   - Hue `modelid` where available
5. Subscribe only to the concrete selected state ids.
6. Unsubscribe states that disappeared from discovery.
7. Report selected ids through `ctx.meta.managedObjects`.
8. Read and evaluate the current state values once.

The plugin intentionally does not use a broad `*.state` subscription.

### Message identity

Message refs are plugin-instance scoped:

```text
IngestHue.<instanceId>.<ioBroker state id>
```

Example:

```text
IngestHue.0.hue.0.device1.battery
```

This avoids collisions between multiple `IngestHue` instances.

### Battery monitoring

Battery values are interpreted as numeric percentages.

Rule:

- `battery < batteryCreateBelow` -> create or update a task message
- `battery >= batteryRemoveAbove` -> close the message via `completeAfterCauseEliminated`

Battery message shape:

- `icon`: low battery symbol
- `kind`: `task`
- `level`: `warning`
- `origin.type`: `automation`
- `origin.system`: configured Hue instance
- `origin.id`: watched battery state id
- `timing.notifyAt`: creation time, so the reminder cycle starts immediately
- `timing.remindEvery`: 48 hours
- `timing.dueAt`: creation time plus 7 days
- `timing.timeBudget`: explicit catalog estimate when the Hue model is known
- `audience`: static audience from configuration, when configured
- `details.location`: room name, when available
- `details.task`: battery replacement task text
- `details.reason`: current battery level
- `details.tools`: model tools, when known
- `details.consumables`: model batteries, when known
- `metrics.state-value`: current state value, using `common.unit` from the ioBroker state object
- `metrics.state-lc`: source state `lc` timestamp in milliseconds
- `metrics.state-ts`: source state `ts` timestamp in milliseconds

Existing messages are patched only for changed metrics. Metric entry timestamps generated by Message Hub do not trigger an
update by themselves, which keeps archive noise low during rescans. Static create-time fields such as `audience`,
`timing.dueAt`, and `timing.remindEvery` are not patched for existing messages.

### Reachability monitoring

Reachability values are interpreted as boolean-ish values:

- `true`, `1`, `on` -> reachable
- `false`, `0`, `off` -> unreachable

Rule:

- reachable `false` -> create or update a status message
- reachable `true` -> close the message via `completeAfterCauseEliminated`

Reachability message shape:

- `icon`: signal/reachability symbol
- `kind`: `status`
- `level`: `error`
- `title`: model catalog label when `modelid` is known, otherwise generic Hue device label
- `origin.type`: `automation`
- `origin.system`: configured Hue instance
- `origin.id`: watched reachable state id
- `timing.notifyAt`: creation time, so the reminder cycle starts immediately
- `timing.remindEvery`: 24 hours
- `audience`: static audience from configuration, when configured
- `details.location`: room name, when available
- `details.reason`: reachability failure text
- `metrics.state-value`: current state value, usually `false`, using `common.unit` from the ioBroker state object when present
- `metrics.state-lc`: source state `lc` timestamp in milliseconds
- `metrics.state-ts`: source state `ts` timestamp in milliseconds

### Managed metadata

Watched Hue states are reported via:

```js
ctx.meta.managedObjects.report(ids, { managedText })
ctx.meta.managedObjects.applyReported()
```

This lets Message Hub stamp object metadata and maintain the plugin instance watchlist.

### Related files

- Plugin developer guide: `docs/plugins/README.md`
- Plugin API: `docs/plugins/API.md`
- Runtime manager: `docs/plugins/IoPlugins.md`
- Runtime i18n: `docs/io/IoRuntimeI18n.md`
