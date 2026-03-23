# IoManagedMeta: managed metadata stamping and watchlist persistence

`lib/IoManagedMeta.js` is part of the Message Hub IO/runtime layer.

It is a small adapter-side helper that lets plugins mark ioBroker objects as "managed by this plugin" and keep a best-effort watchlist of those managed ids.

---

## Where it sits in the system

`IoManagedMeta` is not a host by itself.
It sits below `IoPlugins` and is used when plugin instances are registered through the Message Hub runtime.

Its role is narrow:

- stamp `common.custom.<adapterNamespace>.managedMeta-*` fields on ioBroker objects,
- persist the current managed-id set for one plugin instance in a watchlist state,
- clean up stale metadata later via a background janitor.

`IoPlugins` exposes this indirectly to plugins through `ctx.meta.managedObjects`.

---

## Responsibilities

`IoManagedMeta` is responsible for:

1. Creating per-plugin reporters via `createReporter(...)`.
2. Buffering reported ids until `applyReported()` is called.
3. Ensuring a watchlist state exists at `<Type>.<instanceId>.watchlist`.
4. Writing the current reported id set into that watchlist.
5. Stamping managed metadata onto the referenced ioBroker objects.
6. Clearing watchlists and cleaning up stale metadata best-effort.
7. Running a background janitor pass on a timer.

---

## Public API / contract surface

### Constructor

```js
new IoManagedMeta(adapter, { hostName? })
```

- requires an adapter with `namespace`
- creates an internal ioBroker API wrapper via `buildIoBrokerApi(...)`
- starts a background janitor timer automatically

### `dispose()`

Stops the janitor timer.
This is optional cleanup only; the timer is already managed so it should not block normal process exit.

### `runJanitorOnce()`

Runs one janitor pass manually.
This exists mainly for tests and explicit debugging.

### `createReporter({ category, type, instanceId, pluginBaseObjectId })`

Returns a frozen reporter with two methods:

- `report(ids, meta?)`
- `applyReported()`

`report(...)`
- accepts one id or an array of ids
- buffers them in memory
- can optionally carry `meta.managedText`
- is async and returns `Promise<void>`

`applyReported()`
- returns immediately without writing anything when the pending buffer is empty
- sorts the reported ids
- ensures the watchlist state exists
- writes the full watchlist JSON array
- stamps managed metadata onto each referenced object
- always clears the pending buffer afterwards

### `clearWatchlist({ type, instanceId })`

Best-effort reset for one plugin instance:

- clears buffered in-memory ids
- resets the persisted watchlist state to `[]` if the watchlist object already exists
- starts asynchronous orphan cleanup in the background

It intentionally does **not** create a watchlist object when none exists yet.

---

## Managed metadata model

When metadata is applied to an ioBroker object, `IoManagedMeta` writes into:

- `common.custom.<adapterNamespace>.enabled`
- `common.custom.<adapterNamespace>.managedMeta-managedBy`
- `common.custom.<adapterNamespace>.managedMeta-managedText`
- `common.custom.<adapterNamespace>.managedMeta-managedSince`
- `common.custom.<adapterNamespace>.managedMeta-managedMessage`

Key semantics:

- `enabled: true` is the normal ioBroker custom-instance enable flag for this namespace
- `managedBy` points to the plugin base object id
- `managedText` is optional descriptive text supplied by the plugin
- `managedSince` is created once and then preserved
- `managedMeta-managedMessage: true` means the object is currently considered managed by that plugin instance
- `managedMeta-managedMessage: false` means the object was orphaned/cleaned up by janitor or watchlist cleanup
- writes are skipped when nothing actually changed

The watchlist state for one plugin instance lives at:

- `<Type>.<instanceId>.watchlist`

and stores a JSON array of ids.

---

## Design notes / invariants

- Best-effort by design: failures must never crash the adapter.
- `IoManagedMeta` is plugin-instance scoped through the reporter identity, not global plugin-type state.
- Metadata stamping and watchlist persistence are deliberately decoupled from plugin business logic.
- `report(...)` is cheap and buffered; the actual ioBroker writes happen on `applyReported()`.
- `clearWatchlist(...)` first reads the current watchlist ids, then writes `[]`, then starts background orphan cleanup for the previously listed ids.
- Janitor cleanup is asynchronous and tolerant; it is a hygiene path, not a correctness-critical runtime path.
- Janitor timing is fixed in code: first run after 5 minutes, then every 30 minutes.
- This helper owns the ioBroker custom metadata layout so plugins do not each invent their own stamping format.

### Orphan policy

When an object is no longer listed in the owning plugin watchlist, cleanup does not delete the custom block outright.

Instead, the orphan policy is:

- set `managedMeta-managedMessage` to `false`
- if `mode === ''` and `enabled === true`, also set `enabled = false`

That second step matters because `enabled` is the standard ioBroker custom flag for this namespace. Without it, an empty-mode custom block could remain active even after the object was orphaned.

---

## Related files

- Implementation: `lib/IoManagedMeta.js`
- Main caller: `lib/IoPlugins.js`
- Core host API wrapper: `src/MsgHostApi.js`
- IO overview: `docs/io/README.md`
