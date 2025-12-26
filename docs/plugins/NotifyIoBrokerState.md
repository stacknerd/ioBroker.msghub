# Notifier: NotifyIoBrokerState

`NotifyIoBrokerState` is a Message Hub **notifier plugin** (MsgNotify plugin) that writes notification events into ioBroker states.
This makes Message Hub notifications visible and usable for scripts, visualizations, and automations that can read states.

The plugin stores “latest” notifications as JSON strings and also provides optional routing states by **kind** and **level**.
This is intentionally simple: it is not a history or log, it is only the most recent value per state.

---

## Basics

- Type: `Notify`
- Registration ID (used in this repo): `ioBrokerState`
- Implementation: `lib/NotifyIoBrokerState/index.js` (`NotifyIoBrokerState(adapter, options)`)
- Supported events: values from `MsgConstants.notfication.events` (`due`, `updated`, `deleted`, `expired`)
  - The plugin also accepts the event *keys* (e.g. `update`) and maps them to the event *values* (e.g. `updated`) for the state id.

---

## Config

The plugin is configured when it is registered (currently hardcoded in `main.js`).

Options:

- `stateId` (default: `notifications.latest`)
  - Prefix for the “latest per event” states.
- `kindPrefix` (default: `notifications.byKind`)
  - Prefix for the “latest per kind + event” states.
- `levelPrefix` (default: `notifications.byLevel`)
  - Prefix for the “latest per level + event” states.
- `includeContext` (default: `false`)
  - When enabled, the stored value becomes an object with `{ ts, event, notification(s), ctx }`.
- `mapTypeMarker` (optional)
  - Overrides the marker used by `serializeWithMaps` to encode JavaScript `Map` values (default marker: `__msghubType`).

State structure (full ids include the adapter namespace, e.g. `msghub.0.`):

- `notifications.latest.<event>`
  - Latest notification for that event.
- `notifications.byKind.<kindKey>.<event>`
  - Latest notification for that kind and event.
- `notifications.byLevel.<levelKey>.<event>`
  - Latest notification for that level and event.

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
  - States are created with `setObjectNotExistsAsync` and written with `ack: true`.

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

Register the plugin (example from adapter startup):

```js
const { NotifyIoBrokerState } = require(`${__dirname}/lib`);

this.msgStore.msgNotify.registerPlugin(
	'ioBrokerState',
	NotifyIoBrokerState(this, { includeContext: true }),
);
```

Example states you will get (instance `msghub.0`):

- `msghub.0.notifications.latest.due`
- `msghub.0.notifications.byKind.task.due`
- `msghub.0.notifications.byLevel.notice.due`

Example stored JSON when `includeContext: true` (simplified):

```json
{
	"ts": 1730000000000,
	"event": "due",
	"notifications": { "ref": "my-ref", "kind": "task", "level": 10 },
	"ctx": { "source": "MsgNotify" }
}
```

---

## Related files

- Implementation: `lib/NotifyIoBrokerState/index.js`
- Dispatcher: `src/MsgNotify.js`
- Constants (events, kinds, levels): `src/MsgConstants.js`
- JSON/Map serialization: `src/MsgUtils.js`
- Plugin overview: `docs/plugins/README.md`
