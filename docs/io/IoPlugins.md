# IoPlugins: adapter-side plugin runtime and orchestration layer

`lib/IoPlugins.js` is part of the Message Hub IO/runtime layer.

`IoPlugins` is the central adapter-side plugin runtime.
It owns plugin instance objects and enable states, wires plugin factories into the Message Hub hosts, injects runtime metadata/helpers, and exposes a few adapter-internal runtime bridges used by Admin and plugin-owned UI.

---

## Where it sits in the system

`IoPlugins` is the layer between:

- the adapter runtime in `main.js`,
- the core plugin hosts in `src/` (`MsgIngest`, `MsgNotify`, `MsgBridge`, `MsgEngage`),
- plugin implementations in `lib/<PluginType>/`.

Conceptually:

1. the catalog in `lib/index.js` defines available plugins,
2. `IoPlugins` creates/loads plugin instances from that catalog,
3. plugin instances are registered into the correct host,
4. `IoPlugins` decorates plugin ctx with runtime-owned helpers and metadata,
5. admin/runtime facades such as `IoAdminTab` call back into `IoPlugins` for catalog, instances, Admin UI bundles, and plugin runtime hooks.

---

## Responsibilities

`IoPlugins` is responsible for:

1. Managing plugin instance lifecycle for ingest, notify, bridge, and engage plugins.
2. Creating and maintaining plugin instance object trees:
   - `<Type>.<instanceId>`
   - `<Type>.<instanceId>.enable`
   - `<Type>.<instanceId>.status`
3. Loading raw `native` options from ioBroker objects and merging defaults.
4. Registering enabled plugin instances into the correct host.
5. Unregistering plugin instances and disposing per-plugin resources.
6. Decorating plugin ctx with:
   - `ctx.meta.plugin`
   - `ctx.meta.options`
   - `ctx.meta.resources`
   - `ctx.meta.gates`
   - optional `ctx.meta.managedObjects`
7. Handling plugin enable/disable state changes.
8. Exposing plugin runtime read bridges such as `callPluginRuntime(...)`.
9. Owning plugin-owned Admin UI discovery and bundle file access.
10. Owning the single messagebox/sendTo handler adopted by Engage plugins.

---

## Non-responsibilities

`IoPlugins` is explicitly **not** responsible for:

1. Discovering plugins dynamically from the filesystem.
   The available plugin catalog comes from `lib/index.js`.
2. Owning plugin business logic.
   Factories and handlers remain in the plugin modules.
3. Validating or normalizing plugin config semantically.
   `native` is loaded raw; plugin code owns the final schema semantics.
4. Acting as the browser-side Admin UI host.
   That belongs to the Admin Tab frontend and `IoAdminTab`.
5. Replacing the core hosts in `src/`.
   `IoPlugins` wires plugins into those hosts; it does not supersede them.

---

## Public API / contract surface

### Construction and startup

### `new IoPlugins(adapter, msgStore, options?)`

Creates the runtime manager.
The constructor is synchronous and does not perform runtime I/O setup beyond internal initialization.

Relevant options include:

- `options.instanceId`
- `options.catalog`
- `options.pluginDirs` (`Map<string, string>`)

### `IoPlugins.create(adapter, msgStore, options?)`

Convenience startup path:

1. constructs the manager,
2. runs `init()`,
3. runs `registerEnabled()`.

### `init()`

Initializes plugin control state objects and subscriptions.

### `registerEnabled()`

Registers all currently enabled plugin instances.

---

### Catalog and instance inspection

### `getCatalog()` / `getAdminCatalog()`

Returns a JSON-safe catalog DTO without plugin factory functions.

### `listInstances()` / `adminListInstances()`

Scans the object tree and returns discovered plugin instances with:

- category
- type
- instanceId
- enabled
- status
- raw `native`

Runtime status values are:

- `starting`
- `running`
- `stopping`
- `stopped`
- `error`

---

### Instance management

### `createInstance({ category, type })`

Creates the next instance id and its object/control states.
If the new instance should start enabled, it is registered immediately.

### `deleteInstance({ type, instanceId })`

Best-effort unregisters the runtime instance and deletes the plugin object subtree recursively.

### `updateInstanceNative({ type, instanceId, nativePatch })`

Updates the plugin base object's `native`.
If the target instance is currently enabled, the runtime instance is restarted so the change takes effect without adapter restart.

### `setInstanceEnabled({ type, instanceId, enabled })`

Ensures the target instance exists and applies the desired enable/disable state through the serialized operation queue.

Legacy aliases:

- `adminCreateInstance(...)`
- `adminUpdateInstance(...)`
- `adminSetEnabled(...)`

---

### Runtime bridges

### `getIngestMeta()`

Returns the meta bundle currently passed into `MsgIngest.start(...)`.

At the current code state this is simply `{}`, but the method remains part of the runtime surface owned by `IoPlugins`.

### `isPluginControlStateId(id)`

Returns whether a state id belongs to a plugin enable-switch state managed by `IoPlugins`.

### `handleStateChange(id, state)`

Consumes plugin enable/disable state changes.

Contract:

- returns `true` when the event was handled as a plugin control state
- `ack: true` writes are still consumed, but they do not trigger register/unregister
- treats `ack: false` writes as user intent
- serializes runtime register/unregister through the internal op queue

### `handleGateStateChange(id, state)`

Dispatches a state change to registered gate watchers and returns whether any watcher handled it.

### `callPluginRuntime({ type, instanceId?, method, args? })`

Adapter-internal bridge to an already-registered plugin handler.

Used for runtime-owned optional methods such as:

- plugin snapshots,
- plugin-owned Admin UI backend hooks,
- IngestStates select-options pass-through.

Returns `null` when the plugin or method is unavailable.

### `dispatchMessagebox(obj)` / `clearMessageboxHandler()`

Best-effort bridge for the single messagebox handler adopted by an Engage plugin.

The only runtime interface for adopting that handler is injected into Engage plugin factory options as:

- `__messagebox.register(handler)`
- `__messagebox.unregister()`

---

### Plugin Admin UI support

### `computeAdminUiBundleHash({ type, panelId })`

Computes and caches a lang-independent SHA-256 hash over:

- JS bundle content,
- optional companion CSS content,
- all `admin-ui/i18n/*.json` files.

### `getAdminUiContributions()`

Returns flat Admin UI panel contributions from currently running plugin instances only.

Important detail:

- returned contributions always contain `bundle.hash: ''`
- callers must obtain the authoritative bundle hash separately via `computeAdminUiBundleHash({ type, panelId })`

### `readAdminUiBundle({ type, panelId, lang })`

Reads:

- JS bundle
- optional companion CSS
- requested plugin-owned i18n file (with `en` fallback)

Path traversal is explicitly guarded.

These Admin UI methods expect the manifest-side declaration shape:

```js
plugin.adminUi = {
  apiVersion: '1',
  panels: [
    {
      id: 'presets',
      bundle: { entry: 'admin-ui/dist/presets.esm.js' },
      title: { en: 'Presets' },
      description: { en: 'Manage message presets' },
    },
  ],
};
```

---

### Context decoration helpers

The following methods are runtime-owned helpers used internally by `IoPlugins` during registration:

- `createOptionsApi(manifest)`
- `buildManifestFromCatalogEntry(plugin)`

They are relevant because they define part of the plugin runtime contract:

- `ctx.meta.options` is manifest-bound
- `ctx.meta.plugin` is stable, runtime-owned identity
- plugin ctx decoration is not delegated to plugins themselves

`createOptionsApi(manifest)` returns:

- `resolveInt(key, val)`
- `resolveString(key, val)`
- `resolveBool(key, val)`

Semantics:

- `resolveInt(...)` uses manifest defaults and applies `min`/`max` clamping when present
- `resolveString(...)` uses manifest defaults and preserves whitespace only when `spec.trim === false`
- `resolveBool(...)` falls back to the manifest default when the input is not explicitly `true` or `false`

`buildManifestFromCatalogEntry(plugin)` returns a manifest-like object with:

- `schemaVersion`
- `type`
- `defaultEnabled`
- `supportsMultiple`
- `supportsChannelRouting`
- `title`
- `description`
- `options`

---

## Runtime model and design notes

### 1. Enable state is the persisted source of truth

`<Type>.<instanceId>.enable` is the user-facing control state.
`IoPlugins` writes the final committed value back as `ack: true` after register/unregister.

`native.enabled` is kept in sync as an auxiliary config mirror for Admin usage.

### 2. Registration ids are stable

Runtime registration ids are always:

- `<Type>:<instanceId>`

This remains true even where today only instance `0` exists for many plugins.

### 3. Per-plugin resources are runtime-owned

Each registered plugin gets its own `IoPluginResources` instance.
That resource tracker is disposed on unregister.

### 4. Plugin ctx is decorated centrally

`IoPlugins` injects:

- stable plugin identity
- manifest-aware option resolvers
- resource tracking
- gate watchers
- optional managed object reporting
- wrapped subscribe APIs
- optional `ctx.api.templates.renderStates(...)`
- optional caller-bound `ctx.api.ai` and `ctx.api.log`

This keeps plugin runtime ergonomics in one place instead of scattering helpers across plugins.

### 5. Best-effort cleanup is deliberate

Unregister paths swallow cleanup failures where appropriate.
The goal is to keep the adapter stable even if plugin cleanup is imperfect.

### 6. Plugin-owned Admin UI is runtime-owned on the backend

`IoPlugins` owns:

- the discovery of running panel contributions,
- file-backed bundle loading,
- content hashing,
- plugin-owned i18n loading,
- the runtime bridge to plugin backend methods.

It does **not** own the browser host implementation.

### 7. `ctx.meta.managedObjects` is category-limited

Managed-object reporting is not injected for every plugin category.

Current runtime behavior:

- ingest plugins receive `ctx.meta.managedObjects`
- bridge plugins receive `ctx.meta.managedObjects`
- engage plugins receive `ctx.meta.managedObjects`
- notify plugins do **not** receive it

### 8. `ctx.meta.gates.register(...)` is a real runtime contract

The gate helper injected by `IoPlugins` accepts:

```js
ctx.meta.gates.register({
  id,
  op,
  value,
  onOpen,
  onClose,
  onChange,
  fireOnInit,
})
```

Supported operators are:

- `'true'`
- `'false'`
- `'='`
- `'>'`
- `'<'`

Return value:

- `{ dispose: () => void }` on success
- `null` for invalid input

### 9. Bridge and Engage registration use their dedicated core hosts

Ingest and Notify plugins are registered directly into `msgStore.msgIngest` and `msgStore.msgNotify`.

Bridge and Engage plugins are different:

- bridge plugins are wired through `MsgBridge.registerBridge(...)`
- engage plugins are wired through `MsgEngage.registerEngage(...)`

---

## Related files

- Implementation: `lib/IoPlugins.js`
- Main admin/runtime caller: `lib/IoAdminTab.js`
- Managed metadata helper: `lib/IoManagedMeta.js`
- Resource tracker: `lib/IoPluginResources.js`
- Core hosts: `src/MsgIngest.js`, `src/MsgNotify.js`, `src/MsgBridge.js`, `src/MsgEngage.js`
- Plugin catalog: `lib/index.js`
- IO overview: `docs/io/README.md`
