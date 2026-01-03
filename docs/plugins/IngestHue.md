# IngestHue

`IngestHue` is a Message Hub **ingest (producer)** plugin that watches the Hue adapter and turns common “device health” signals into MsgHub messages:

- low battery → a **task** message (“replace batteries”)
- device unreachable → a **status** message (“not reachable”)

This document has two parts:

1) A user-facing guide (setup, configuration, best practices).
2) A technical description (how it works internally).

---

## 1) User Guide

### What it does

- Watches Hue states under `hue.*`, primarily:
  - `*.battery` (numeric percent)
  - `*.reachable` (boolean-ish)
- Creates/updates messages with stable `ref`s so you don’t get duplicates across restarts.
- Completes messages automatically when the underlying condition is OK again (battery recovered / reachable again).

What it intentionally does not do (today):

- It does not control Hue devices or write to Hue states.
- It does not continuously rescan Hue objects; discovery is snapshot-based at startup.

### Prerequisites

- The ioBroker Hue adapter must be installed and running (states below `hue.*` exist).
- The Message Hub adapter must be able to read foreign states/objects from the Hue adapter.
- Optional (for nicer `details.location`): `enum.rooms.*` should be maintained.

### Quick start (recommended setup)

1. Verify you have Hue states like `hue.0....battery` and/or `hue.0....reachable` in ioBroker Admin → Objects.
2. Create an `IngestHue` instance in the Message Hub Plugins tab.
3. Adjust battery thresholds if desired:
   - `batteryCreateBelow` / `batteryRemoveAbove`
4. (Optional) tune reachable noise filtering via `reachableAllowRoles`.
5. Enable the plugin instance (`...enable` switch).
6. Confirm messages appear when you simulate a low battery / unreachable device.

### How to configure

Configuration is done in the Message Hub Admin Tab (Plugins) and uses the schema from `lib/IngestHue/manifest.js`.

Options (all optional):

- `monitorBattery` (boolean, default `true`)
  - Enables monitoring of `*.battery`.
- `batteryCreateBelow` (number, %, default `7`)
  - Creates/updates the battery task when `battery < batteryCreateBelow`.
- `batteryRemoveAbove` (number, %, default `30`)
  - Completes the battery task when `battery >= batteryRemoveAbove`.
- `monitorReachable` (boolean, default `true`)
  - Enables monitoring of `*.reachable`.
- `reachableAllowRoles` (string CSV, default `ZLLSwitch,ZLLPresence`)
  - Filters `*.reachable` states by the parent channel role to reduce noise.
  - Use an empty value to allow all roles.

### Best practices

- Keep `batteryCreateBelow` and `batteryRemoveAbove` separated (hysteresis) to avoid flapping.
- Start with the default reachable-role filter and expand only if you need broader coverage.
- Use meaningful Hue object names and room enums so messages contain useful `location` and titles.

### Troubleshooting

Common symptoms and what to check:

- “No messages appear”
  - Verify the plugin instance is enabled and running.
  - Verify Hue states exist under `hue.*` and end in `.battery` / `.reachable`.

- “Reachable messages are missing for some devices”
  - Check the Hue parent role; adjust `reachableAllowRoles` (empty = no filtering).

- “Locations are empty”
  - Add/maintain `enum.rooms.*` membership for relevant Hue objects/channels.

---

## 2) Software Documentation

### Overview

`IngestHue` is registered as an **ingest** plugin:

- Registration id: `IngestHue:<instanceId>` (example: `IngestHue:0`)
- Implementation: `lib/IngestHue/index.js`

At startup it performs snapshot discovery of Hue objects, subscribes to matching foreign states, and evaluates their current values once.

### Runtime wiring (IoPlugins)

`IoPlugins` creates the instance subtree under `msghub.<instance>.IngestHue.<instanceId>`:

- Base object: `msghub.0.IngestHue.<instanceId>` (options in `object.native`)
- Enable state: `msghub.0.IngestHue.<instanceId>.enable`
- Status state: `msghub.0.IngestHue.<instanceId>.status`

### Message identity (dedupe strategy)

Every condition uses a stable `ref` derived from the watched Hue state id:

- Battery: `hue:battery:<stateId>`
- Reachable: `hue:reachable:<stateId>`

This allows `ctx.api.store.addOrUpdateMessage(...)` to update the same message across restarts.

When a condition becomes OK again, the message is completed via `ctx.api.store.completeAfterCauseEliminated(ref, { actor, finishedAt })`.

### Startup discovery and evaluation

Discovery (`start(ctx)`):

1. Loads foreign objects matching `hue.*`.
2. Selects watched states:
   - battery: ids ending in `.battery`
   - reachable: ids ending in `.reachable`
3. Enriches each watched state with metadata:
   - display name (`common.name`)
   - room name from `enum.rooms.*` (longest prefix match)
   - parent channel role (`common.role`)
   - Hue `modelid` (for battery/tool hints)
4. Subscribes to watched ids via `ctx.api.iobroker.subscribe.subscribeForeignStates(id)` (auto-cleaned up by the plugin runtime).

Evaluation:

- Reads each watched state once via `getForeignState(id)` and emits messages immediately.

`onObjectChange` is intentionally a no-op to avoid frequent rescans.

### Battery monitoring (hysteresis)

- Values are interpreted as numeric percent.
- Rule:
  - `battery < batteryCreateBelow` → create/update `kind: task`, `level: warning`
  - `battery >= batteryRemoveAbove` → complete the message

Battery messages may include `details.location`, `details.task`, `details.reason` and optional `details.consumables` / `details.tools` (from `lib/IngestHue/models.js` by Hue `modelid`).

### Reachability monitoring

- Values are interpreted as boolean-ish (`true|false`, `1|0`, `"on"|"off"`, ...).
- Rule:
  - reachable `false` → create/update `kind: status`, `level: error`
  - reachable `true` → complete the message

`reachableAllowRoles` can filter by parent role to reduce noise (default: `ZLLSwitch,ZLLPresence`).

### “Managed” metadata on Hue states

The plugin reports watched ids via `ctx.meta.managedObjects.report(...)` so the adapter can stamp “managed by plugin” metadata onto those Hue state objects.

### Related files

- Implementation: `lib/IngestHue/index.js`
- Model catalog: `lib/IngestHue/models.js`
- Plugin runtime: `lib/IoPlugins.js`
- Core ingest host: `src/MsgIngest.js`
