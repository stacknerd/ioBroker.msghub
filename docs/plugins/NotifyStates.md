# NotifyStates

`NotifyStates` is a Message Hub **notify (notifier)** plugin that writes notification events into ioBroker states. This makes Message Hub notifications visible and usable for scripts, visualizations, and automations that can read states.

The plugin stores “latest” notifications as JSON strings and also provides optional routing states by **kind** and **level**. This is intentionally simple: it is not a history or log, it is only the most recent value per state.

This document has two parts:

1) A user-facing guide (setup, configuration, best practices).
2) A technical description (how it works internally).

---

## 1) User Guide

### What it does

- Writes the most recent notification payload into ioBroker states, grouped by:
  - event (`Latest.<event>`)
  - kind (`byKind.<kindKey>.<event>`)
  - level (`byLevel.<levelKey>.<event>`)
- Optionally writes periodic snapshots of the full Message Hub store (`fullJson`).
- Maintains simple counters (`Stats.*`) so you can build dashboards without parsing large JSON blobs.

What it intentionally does not do:

- It does not keep a history/log (each state is “last write wins”).
- It does not deduplicate or aggregate notifications.

### Prerequisites

- None beyond a working Message Hub instance. The produced states can be consumed by scripts/visualizations/automations.

### Quick start (recommended setup)

1. Create a `NotifyStates` instance in the Message Hub Plugins tab.
2. Enable the plugin instance (`...enable` switch).
3. Inspect the generated states in ioBroker Admin → Objects under:
   - `msghub.0.NotifyStates.<instanceId>.Latest.*`
4. Trigger a notification (for example create/update a message) and observe state updates.

### How to configure

Configuration is done in the Message Hub Admin Tab (Plugins) and uses the schema from `lib/NotifyStates/manifest.js`.

Common options:

- `blobIntervalMs` (number, ms, default `300000`)
  - Interval for writing `*.fullJson` snapshots. Use `0` to disable.
- `statsMinIntervalMs` (number, ms, default `1000`)
  - Throttle statistics updates triggered by notifications. Use `0` to disable throttling.
- `statsMaxIntervalMs` (number, ms, default `300000`)
  - Force a periodic stats refresh even without notifications. Use `0` to disable.
- `mapTypeMarker` (string, default `__msghubType`)
  - Overrides the marker used by `serializeWithMaps` (advanced).

`kindKey` and `levelKey` in the state ids come from the **keys** of `MsgConstants.kind` / `MsgConstants.level`.

### Best practices

- Keep `blobIntervalMs=0` unless you really need full snapshots (it can create large states).
- Use `Latest.*` / `byKind.*` / `byLevel.*` for automations (small payloads) and dashboards.
- Use `Stats.*` for fast dashboards and health indicators.

### Troubleshooting

- “No states show up”
  - Verify the plugin instance is enabled and running.
  - Check adapter logs for warnings about object creation (`setObjectNotExists`) or state writes.

- “States update but JSON looks strange”
  - Notifications can contain `Map` values (for example `metrics`); `NotifyStates` serializes those with `serializeWithMaps`.

---

## 2) Software Documentation

### Overview

`NotifyStates` is registered as a **notify** plugin:

- Registration id: `NotifyStates:<instanceId>` (example: `NotifyStates:0`)
- Implementation: `lib/NotifyStates/index.js`
- Supported events: values from `MsgConstants.notfication.events` (`added`, `due`, `updated`, `deleted`, `expired`)
  - The plugin also accepts the event *keys* (for example `update`) and maps them to the event *values* (for example `updated`) for the state id.

### Runtime wiring (IoPlugins)

`IoPlugins` creates the instance subtree under `msghub.<instance>.NotifyStates.<instanceId>`:

- Base object: `msghub.0.NotifyStates.<instanceId>` (options in `object.native`)
- Enable state: `msghub.0.NotifyStates.<instanceId>.enable`
- Status state: `msghub.0.NotifyStates.<instanceId>.status`

The plugin writes into fixed subtrees below that base:

- `msghub.0.NotifyStates.<instanceId>.fullJson` (periodic full store dump)
- `msghub.0.NotifyStates.<instanceId>.Stats.total`
- `msghub.0.NotifyStates.<instanceId>.Stats.open`
- `msghub.0.NotifyStates.<instanceId>.Stats.dueNow`
- `msghub.0.NotifyStates.<instanceId>.Stats.deleted`
- `msghub.0.NotifyStates.<instanceId>.Stats.expired`
- `msghub.0.NotifyStates.<instanceId>.Latest.<event>`
- `msghub.0.NotifyStates.<instanceId>.byKind.<kindKey>.<event>`
- `msghub.0.NotifyStates.<instanceId>.byLevel.<levelKey>.<event>`

### Write strategy

- “Last write wins”: each state always contains only the most recent notification for that bucket.
- States are created with `ctx.api.iobroker.objects.setObjectNotExists(...)` and written via `ctx.api.iobroker.states.setState(..., { ack:true })`.
- Payload shape:
  - If the host provides a single notification, the state value is that notification.
  - If a batch is provided, the state value is an array.

### Event normalization

- The plugin normalizes `event` to an allowed event value from `MsgConstants.notfication.events`.
- If the event is unknown, the plugin does nothing.

### Routing by kind and level

- Kind routing is based on `notification.kind`.
  - Accepts the stored kind value (for example `"task"`) and also the kind key.
- Level routing is based on `notification.level`.
  - Accepts numeric levels (for example `10`) and also level keys (for example `"warning"`).

### Stats (`Stats.*`)

- `total`: number of messages in the store (includes deleted/expired).
- `open`: messages with `lifecycle.state === "open"`.
- `deleted`: messages with `lifecycle.state === "deleted"`.
- `expired`: messages with `lifecycle.state === "expired"`.
- `dueNow`: subset of `open` only: messages with `lifecycle.state === "open"` and `timing.notifyAt <= now` (and not expired by `timing.expiresAt`).
  - Note: this is “notification due now” (driven by `notifyAt`), not “fällig” in the domain sense (`dueAt`/`startAt`).
- Update behavior:
  - on notifications: stats updates are requested and throttled via `statsMinIntervalMs`
  - idle refresh: forced via `statsMaxIntervalMs` even without new notifications

Note: `MsgStore` uses one-shot `due` semantics: after dispatching `due`, it clears `timing.notifyAt` (or reschedules it to `now + timing.remindEvery`). This means a due message should not spam by default. States can still update multiple times if the message changes (e.g. `updated`) or if `remindEvery` triggers future `due` events.

### Map-safe JSON

- Notifications may contain JavaScript `Map` values (for example `metrics`).
- The plugin uses `serializeWithMaps()` so these Maps survive JSON serialization.
- `mapTypeMarker` can override the marker used by `serializeWithMaps`.

### Examples

Example states you will get (adapter instance `msghub.0`):

- `msghub.0.NotifyStates.0.fullJson`
- `msghub.0.NotifyStates.0.Latest.due`
- `msghub.0.NotifyStates.0.byKind.task.due`
- `msghub.0.NotifyStates.0.byLevel.notice.due`

### Related files

- Implementation: `lib/NotifyStates/index.js`
- Dispatcher: `src/MsgNotify.js`
- Constants (events, kinds, levels): `src/MsgConstants.js`
- JSON/Map serialization: `src/MsgUtils.js`
- Plugin overview: `docs/plugins/README.md`
