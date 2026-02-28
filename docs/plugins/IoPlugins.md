# IoPlugins (runtime plugin manager)

`IoPlugins` is the adapter-side “plugin runtime” for Message Hub.

It is responsible for:

- creating enable/disable switches as ioBroker states,
- loading plugin options from ioBroker objects (`native`),
- registering/unregistering plugin handler instances into the two plugin hosts (`MsgIngest` and `MsgNotify`),
- injecting `ctx.meta.resources` (per-plugin resource tracker) and cleaning up timers/subscriptions on stop/unregister,
- wiring special cases like `Bridge...` (via `MsgBridge`) and `Engage...` (via `MsgEngage`).

Plugin types are auto-discovered by the catalog builder in `lib/index.js` (it scans `lib/<plugin>/manifest.js`).
`IoPlugins` consumes that catalog; it does not do filesystem discovery itself.

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
  - optional: `native.channel` can be used as a routing channel for `audience.channels` filtering (only when `manifest.supportsChannelRouting === true`, see below)
- Enable switch (type `state`, boolean, rw): `msghub.0.<Type>.<instanceId>.enable`
  - user intent is written with `ack:false`
  - `IoPlugins` commits the persisted value with `ack:true` after start/stop
- Status (type `state`, string, ro): `msghub.0.<Type>.<instanceId>.status`
  - `starting | running | stopping | stopped | error`
- Watchlist (type `state`, string/JSON, ro): `msghub.0.<Type>.<instanceId>.watchlist`
  - contains a JSON string array of “managed” object ids reported by the plugin
  - created lazily (only for plugins that report managed objects)

Instance ids are numeric.

Multiple instances:

- Plugins may allow multiple instances (`manifest.supportsMultiple === true`).
- Instance ids are assigned automatically (`0`, `1`, `2`, …).
- New ids are allocated by incrementing the current max id (deleted ids are not reused today).
- If `supportsMultiple === false`, only instance `0` is allowed.

Applying option changes:

- Plugin options are stored in the base object’s `native`.
- When `native` is updated via `IoPlugins` (Admin Tab / `admin.plugins.updateInstance`) for an **enabled** instance,
  `IoPlugins` restarts that **single instance** so changes apply immediately (no adapter restart).
- If you edit `native` manually in the Objects view, do a disable+enable toggle to apply the new config.

---

## Audience routing via `native.channel`

For plugin instances with `manifest.supportsChannelRouting === true`, you can optionally set a `native.channel` string.

When a message has `message.audience.channels`, `IoPlugins` filters notification dispatches per instance (only for routing-enabled plugins):

- If the plugin channel is `*` or `all`: dispatch everything (match-all, like `supportsChannelRouting === false`).
- If the plugin channel is **empty**: dispatch only when `audience.channels.include` is empty (unscoped / “to all”).
  - `audience.channels.exclude` is ignored for empty plugin channels.
- If the plugin channel is **set**:
  - `exclude` wins (no dispatch when the channel is excluded).
  - `include` restricts when non-empty (dispatch only when included).

Matching is case-insensitive (trim + lower-case).

This is routing only: `audience.tags` is still plugin-defined and may be used by plugins to implement user/group fanout.

### Routing best practices (plugin developers)

- Notification path: when `manifest.supportsChannelRouting === true`, your `onNotifications(...)` handler already receives a channel-filtered list; do not re-filter by `audience.channels` inside the plugin.
- Pull/query path: when you compute projections/snapshots from the store, prefer `ctx.api.store.queryMessages({ where: { audience: { channels: { routeTo: ctx.meta.plugin.channel } } } })` so selection matches the notify-side routing semantics.
- `getMessages()` returns a raw, unrendered “everything” snapshot; use it only when you intentionally want an unfiltered view (not for UI lists).

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

## Per-call plugin meta injection

For every plugin call, `IoPlugins` injects a stable identity bundle into `ctx.meta.plugin`:

- `category`: `ingest | notify | bridge | engage`
- `type`: plugin type (example: `IngestHue`)
- `instanceId`: numeric instance id (starting at `0`)
- `regId`: registration id in the hosts (example: `IngestHue:0`)
- `baseFullId`: full ioBroker base object id (example: `msghub.0.IngestHue.0`)
- `baseOwnId`: own id (example: `IngestHue.0`)
- `manifest`: the plugin manifest (includes the options schema in `manifest.options`)

This avoids repeating boilerplate in every plugin (deriving ids from `ctx.api.iobroker.ids` or parsing `pluginId` strings).

Additionally, `IoPlugins` injects manifest-backed option helpers into `ctx.meta.options`:

- `ctx.meta.options.resolveInt/resolveString/resolveBool`

If the core exposes `ctx.api.ai` (MsgAi), `IoPlugins` also binds the plugin registration id into that facade so the core
can apply per-plugin policies (rate limiting / cache partitioning) without plugins needing to pass identity manually.

---

## Gate helper

`IoPlugins` exposes a small gate helper for runtime state-based toggles:

```
const handle = ctx.meta.gates.register({
  id: 'some.0.state',
  op: 'true' | 'false' | '>' | '<' | '=',
  value: '...', // comparison value for '>', '<', '='
  onOpen: ({ id, open, prevOpen, state }) => {},
  onClose: ({ id, open, prevOpen, state }) => {},
  onChange: ({ id, open, prevOpen, state }) => {}, // optional
  fireOnInit: false, // optional; default false
});

// later:
handle.dispose();
```

Behavior:

- The helper subscribes to the given state id (own or foreign) directly via the adapter.
- The adapter forwards `onStateChange` events to `IoPlugins.handleGateStateChange(...)` (wired in `main.js`).
- `onOpen`/`onClose` fire only on transitions (no polling).
- The first observed value does **not** fire by default (`fireOnInit: true` to override).
- Disposers are auto-cleaned up when the plugin stops/unregisters.

---

## Fail-fast contract (built-in plugins)

Built-in plugins in this repo are designed to run **only** under `IoPlugins` (Message Hub context).
They validate required `ctx.api`/`ctx.meta` capabilities in `start(ctx)` and throw on missing wiring (no compatibility fallbacks).

To keep `start(ctx)` checks consistent and compact, plugins may use:

- `lib/IoPluginGuards.js` (`ensureCtxAvailability(prefix, ctx, { plainObject, fn, stringNonEmpty })`)

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

- The metadata is stored as flat keys under `common.custom.<msghubInstance>` (example: `common.custom.msghub.0`):
  - `managedMeta-managedBy`
  - `managedMeta-managedText`
  - `managedMeta-managedSince`
  - `managedMeta-managedMessage` (set to `true` while the plugin actively manages the object; used by the Admin UI)
- The watchlist is written as a JSON string array into `<Type>.<instanceId>.watchlist` (example: `IngestHue.0.watchlist`).
  The watchlist state is created lazily on the first `applyReported()` call (plugins that never report managed objects do not create a watchlist).

Cleanup / stale entries:

- When a plugin instance is disabled/unregistered, MsgHub clears its watchlist state immediately and then (in the background) marks all previously listed objects as “no longer managed” (`managedMeta-managedMessage=false`). When `common.custom.<ns>.mode` is empty and `common.custom.<ns>.enabled===true`, MsgHub also flips `enabled` to `false`.
- Additionally, a slow background janitor periodically scans `common.custom.<ns>` for `managedMeta-managedBy` entries and applies the same “no longer managed” policy when objects are not listed in the corresponding watchlist (or the watchlist does not exist).

---


## Related files

- Implementation: `lib/IoPlugins.js`
- Managed-meta runtime + janitor: `lib/IoManagedMeta.js`
- Catalog: `lib/index.js`
- Bridge wiring helper: `src/MsgBridge.js`
- Engage wiring helper: `src/MsgEngage.js`
- Plugin developer guide: `docs/plugins/README.md`
