# IoPlugins (runtime plugin manager)

`IoPlugins` is the adapter-side “plugin runtime” for Message Hub.

It is responsible for:

- creating enable/disable switches as ioBroker states,
- loading plugin options from ioBroker objects (`native`),
- registering/unregistering plugin handler instances into the two plugin hosts (`MsgIngest` and `MsgNotify`),
- wiring special cases like `Bridge...` (via `MsgBridge`) and `Engage...` (via `MsgEngage`).

It does **not** auto-discover plugins. Available plugin types are defined by the catalog in `lib/index.js`.

---

## Where it sits in the system

Simplified view:

```
main.js -> MsgStore (src/)
          - msgIngest (src/MsgIngest.js)
          - msgNotify (src/MsgNotify.js)
          ^
          |
        IoPlugins (lib/IoPlugins.js)
        - enable/config objects in ioBroker
        - register/unregister handlers
```

---

## Configuration storage model (ioBroker objects)

For each plugin instance, `IoPlugins` creates a small subtree below the adapter namespace:

- Base object (type `channel`): `msghub.0.<Type>.<instanceId>`
  - stores raw plugin options in `object.native`
- Enable switch (type `state`, boolean, rw): `msghub.0.<Type>.<instanceId>.enable`
  - user intent is written with `ack:false`
  - `IoPlugins` commits the persisted value with `ack:true` after start/stop
- Status (type `state`, string, ro): `msghub.0.<Type>.<instanceId>.status`
  - `starting | running | stopping | stopped | error`
- Watchlist (type `state`, string/JSON, ro): `msghub.0.<Type>.<instanceId>.watchlist`
  - contains a JSON string array of “managed” object ids reported by the plugin
  - created lazily (only for plugins that report managed objects)

Instance ids are numeric. Today this repo always uses `0`.

---

## Registration ids

Inside the plugin hosts (`MsgIngest` / `MsgNotify`) every plugin instance is registered as:

- `<Type>:<instanceId>` (example: `NotifyStates:0`)

`Bridge...` and `Engage...` use helpers:

- `Bridge...` is registered through `MsgBridge` as `...:0.ingest` and `...:0.notify` internally.
- `Engage...` is registered through `MsgEngage` (ingest + notify + action capability).

---

## Plugin factory contract

`IoPlugins` instantiates plugins through the catalog (`lib/index.js`).
Every catalog entry has a `create(options)` factory.

`IoPlugins` passes your `native` options plus:

- `pluginBaseObjectId` (full id, with namespace) so plugins can create states below their own subtree.

Engage plugins additionally receive a private messagebox helper in `options.__messagebox`:

- `register(handler)` / `unregister()`

Only one Engage plugin can own the adapter messagebox handler at a time.

---

## Managed-meta helper for ingest plugins

When the adapter is wired via `IoPlugins`, ingest plugins also receive a helper in `ctx.meta`:

- `await ctx.meta.managedObjects.report(ids, { managedText })`
- `await ctx.meta.managedObjects.applyReported()`

This is a best-effort convenience to stamp ioBroker objects that the plugin “owns”/monitors (for example foreign states) with small metadata (`managedBy`, `managedText`, `managedSince`) and to persist a watchlist of managed ids.

Behavior:
- `report(...)` buffers ids (deduped) and optional text; it does not write immediately.
- `applyReported()` performs the writes (managedMeta stamping + watchlist update) and clears the buffer.

Stored `managedBy` is always the plugin base object id (`options.pluginBaseObjectId`, e.g. `"msghub.0.IngestHue.0"`).

Storage:

- The metadata is stored on the target object under `common.custom.<msghubInstance>.managedMeta` (example: `common.custom.msghub.0.managedMeta`).
- `managedMeta.managedMessage` is set to `true` while the plugin actively manages the object (used by the Admin UI to show/hide the “managed automatically” notice).
- The watchlist is written as a JSON string array into `<Type>.<instanceId>.watchlist` (example: `IngestHue.0.watchlist`).
  The watchlist state is created lazily on the first `applyReported()` call (plugins that never report managed objects do not create a watchlist).

Cleanup / stale entries:

- When a plugin instance is disabled/unregistered, MsgHub clears its watchlist state immediately and then (in the background) marks all previously listed objects as “no longer managed” (`managedMeta.managedMessage=false`). When `common.custom.<ns>.mode` is empty and `common.custom.<ns>.enabled===true`, MsgHub also flips `enabled` to `false`.
- Additionally, a slow background janitor periodically scans `common.custom.<ns>.managedMeta` entries and applies the same “no longer managed” policy when objects are not listed in the corresponding watchlist (or the watchlist does not exist).

---

## Built-in catalog (this repo)

The default catalog lives in `lib/index.js`.

Today it contains:

- Notify: `NotifyStates`, `NotifyDebug`
- Engage: `EngageSendTo`
- Ingest/Bridge: none (yet)

---

## Related files

- Implementation: `lib/IoPlugins.js`
- Managed-meta runtime + janitor: `lib/IoManagedMeta.js`
- Catalog: `lib/index.js`
- Bridge wiring helper: `src/MsgBridge.js`
- Engage wiring helper: `src/MsgEngage.js`
- Plugin developer guide: `docs/plugins/README.md`
