# Getting Started

This guide walks you through the minimum setup to use Message Hub in a real ioBroker installation.

If you want to understand the data model first, read [`docs/MessageModel.md`](./MessageModel.md).

---

## 1) Install and start the adapter

- Install the adapter and create an instance (example instance: `msghub.0`).
- Start the instance and open the adapter log once, so Message Hub can create its runtime objects.

---

## 2) Verify the built-in plugins are running

Message Hub manages plugins via `IoPlugins`. Each plugin instance has:

- a base object with options in `native`: `msghub.0.<PluginType>.<instanceId>`
- an enable switch: `msghub.0.<PluginType>.<instanceId>.enable`
- a status state: `msghub.0.<PluginType>.<instanceId>.status`

Instance ids are numeric (`0`, `1`, `2`, …). Most built-ins run as instance `0` by default.

Recommended: use the adapter’s **Admin Tab** (“Plugin Config”) to enable/disable plugins, create instances (when supported),
and edit options. Option changes apply immediately because `IoPlugins` restarts the affected instance (no adapter restart).
See: [`docs/AdminTab.md`](./AdminTab.md)

For the initial release, the important built-ins are:

- `msghub.0.EngageSendTo.0.enable` / `msghub.0.EngageSendTo.0.status`
- `msghub.0.NotifyStates.0.enable` / `msghub.0.NotifyStates.0.status`

If `sendTo(...)` returns `{ ok:false, error:{ code:'NOT_READY', ... } }`, first check that `EngageSendTo` is enabled and its status is `running`.

---

## 3) Create your first message (JavaScript)

Example (e.g. in `javascript.0`):

```js
sendTo('msghub.0', 'create', {
  ref: 'demo:task:1',
  kind: 'task',
  level: 10, // notice
  title: 'Laundry',
  text: 'Empty the washing machine',
  origin: { type: 'manual', system: 'javascript.0', id: 'demo' },
}, res => console.log(JSON.stringify(res, null, 2)));
```

Notes:

- `ref` is optional, but recommended. It is the stable id used for updates and deduplication.
- If you create a message without `timing.notifyAt`, Message Hub treats it as “due now” and dispatches a `due` notification.

Full API reference: [`docs/plugins/EngageSendTo.md`](./plugins/EngageSendTo.md)

---

## 4) List messages

```js
sendTo('msghub.0', 'list', {}, res => console.log(JSON.stringify(res, null, 2)));
```

The `list` command supports filtering and pagination. See [`docs/plugins/EngageSendTo.md`](./plugins/EngageSendTo.md).

---

## 5) See notification output in ioBroker states

`NotifyStates` writes “latest” notifications into ioBroker states (JSON strings).

Typical states (instance `msghub.0`):

- `msghub.0.NotifyStates.0.Latest.added`
- `msghub.0.NotifyStates.0.Latest.due`
- `msghub.0.NotifyStates.0.Latest.updated`
- `msghub.0.NotifyStates.0.byKind.task.due`
- `msghub.0.NotifyStates.0.byLevel.notice.due`

Details: [`docs/plugins/NotifyStates.md`](./plugins/NotifyStates.md)

---

## Troubleshooting

- `NOT_READY` on `sendTo`: `EngageSendTo` is disabled/not running, or plugin wiring failed at adapter startup.
- No state output: `NotifyStates` is disabled/not running, or no `added/due/updated/deleted/expired` events are dispatched.
- Nothing ever becomes “due”: create a message without `timing.notifyAt` (immediate `due`), or set `timing.notifyAt` to a timestamp in the past.
