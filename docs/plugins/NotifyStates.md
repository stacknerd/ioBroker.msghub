# Notifier: NotifyStates

`NotifyStates` is a Message Hub **notifier plugin** (MsgNotify plugin) that writes notification events into ioBroker states.
This makes Message Hub notifications visible and usable for scripts, visualizations, and automations that can read states.

The plugin stores “latest” notifications as JSON strings and also provides optional routing states by **kind** and **level**.
This is intentionally simple: it is not a history or log, it is only the most recent value per state.

---

## Basics

- Type: `Notify`
- Registration ID (as used by `lib/IoPlugins.js`): `NotifyStates:0`
- Implementation: `lib/NotifyStates/index.js` (`NotifyStates(options)`)
- Supported events: values from `MsgConstants.notfication.events` (`added`, `due`, `updated`, `deleted`, `expired`)
  - The plugin also accepts the event *keys* (e.g. `update`) and maps them to the event *values* (e.g. `updated`) for the state id.

---

## Config

This plugin is configured by the adapter via `lib/IoPlugins.js`.

- Base object id: `msghub.0.NotifyStates.0`
- Enable switch: `msghub.0.NotifyStates.0.enable`
- Status: `msghub.0.NotifyStates.0.status`
- The plugin writes into fixed subtrees below that base:
  - `msghub.0.NotifyStates.0.fullJson` (periodic full store dump)
  - `msghub.0.NotifyStates.0.Latest.<event>`
  - `msghub.0.NotifyStates.0.byKind.<kindKey>.<event>`
  - `msghub.0.NotifyStates.0.byLevel.<levelKey>.<event>`

Options (stored in the plugin object `native`):

- `mapTypeMarker` (optional): overrides the marker used by `serializeWithMaps` (default: `__msghubType`).
- `blobIntervalMs` (optional): interval for writing a full JSON snapshot to `*.fullJson` (default: 5 minutes, `0` disables).

`kindKey` and `levelKey` are the **keys** from `MsgConstants.kind` / `MsgConstants.level`.

---

## Behavior

- Input → output
  - Input: `MsgNotify` calls `onNotifications(event, [notification], ctx)`.
  - Output: JSON is written to one or more ioBroker states, depending on event/kind/level.

- Event normalization
  - The plugin normalizes `event` to an allowed event value from `MsgConstants.notfication.events`.
  - If the event is unknown, the plugin does nothing.

- Write strategy
  - “Last write wins”: each state always contains only the most recent notification for that bucket.
  - There is no deduplication and no history.
  - States are created with `ctx.api.iobroker.objects.setObjectNotExists(...)` and written via `ctx.api.iobroker.states.setState(..., { ack:true })`.

- Routing by kind and level
  - Kind routing is based on `notification.kind`.
    - It accepts either the stored kind value (e.g. `"task"`) or the kind key.
  - Level routing is based on `notification.level`.
    - It accepts numeric levels (e.g. `10`) and also level keys (e.g. `"warning"`).

- Map-safe JSON
  - Notifications may contain JavaScript `Map` values (for example `metrics`).
  - The plugin uses `serializeWithMaps()` so these Maps survive JSON serialization.

Note: `MsgStore` can dispatch a `due` event repeatedly while a message stays due. This means the same state may get updated multiple times even when the message did not change.

---

## Examples

This plugin is normally wired by `IoPlugins` (no manual registration needed).

Example states you will get (instance `msghub.0`):

- `msghub.0.NotifyStates.0.fullJson`
- `msghub.0.NotifyStates.0.Latest.due`
- `msghub.0.NotifyStates.0.byKind.task.due`
- `msghub.0.NotifyStates.0.byLevel.notice.due`

---

## Related files

- Implementation: `lib/NotifyStates/index.js`
- Dispatcher: `src/MsgNotify.js`
- Constants (events, kinds, levels): `src/MsgConstants.js`
- JSON/Map serialization: `src/MsgUtils.js`
- Plugin overview: `docs/plugins/README.md`
