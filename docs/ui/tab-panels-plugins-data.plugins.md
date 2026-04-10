# admin/tab/panels/plugins/data.plugins.js: constants, readmes, and plugin CRUD facade

`admin/tab/panels/plugins/data.plugins.js` is the data facade for the Plugins panel.
It loads the panel's shared constants and plugin readmes once, caching them for the lifetime of the panel instance, and exposes thin wrappers around the backend plugin
CRUD methods without adding its own rendering or UI logic.

In short: this file is the panel-side adapter between Plugins state and the backend APIs.

---

## Where it sits in the system

`index.js` creates one plugins data facade per panel instance and passes it to the menu, catalog, and instance modules.
Those modules call back into the facade whenever they need constants, readmes, or plugin instance mutations.

The facade depends on:

- shared state from [`./tab-panels-plugins-state.md`](./tab-panels-plugins-state.md)
- `ctx.api.constants`
- `ctx.api.plugins`

---

## Responsibilities

1. Load and cache MsgConstants.
   - `ensureConstantsLoaded()` calls `constantsApi.get()` once and stores the result in `state.cachedConstants`.
   - On failure, it stores `null` and keeps the panel usable without constants.

2. Load and cache plugin readmes.
   - `ensurePluginReadmesLoaded()` fetches `plugin-readmes.json` with `cache: 'no-store'`.
   - Valid entries are stored in `state.pluginReadmesByType` as a `Map` keyed by plugin type.
   - Concurrent callers share `state.pluginReadmesLoadPromise`.
   - The cache is permanent for the panel instance lifetime: once the promise is set, it is never reset, so later calls always return the same already-resolved result.

3. Expose plugin catalog and instance CRUD calls.
   - `getCatalog()`
   - `listInstances()`
   - `createInstance(params)`
   - `updateInstance(params)`
   - `setEnabled(params)`
   - `deleteInstance(params)`

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabPluginsData = {
  createPluginsDataApi
}
```

`createPluginsDataApi(options)` returns a frozen facade with:

- `ensureConstantsLoaded()`
- `ensurePluginReadmesLoaded()`
- `getCatalog()`
- `listInstances()`
- `createInstance(params)`
- `updateInstance(params)`
- `setEnabled(params)`
- `deleteInstance(params)`

The readme cache values currently have this shape:

```js
{
  md,
  source
}
```

---

## Design notes / invariants

- The facade uses the shared panel state as its only cache store. It does not duplicate constants or readmes elsewhere.
- `ensureConstantsLoaded()` is cache-on-success only in practice. If loading fails, `state.cachedConstants` remains `null`.
- `ensurePluginReadmesLoaded()` keeps one shared promise in `state.pluginReadmesLoadPromise`, so overlapping callers do not trigger parallel fetches.
- The promise is set once and never cleared. This means readmes are loaded at most once per panel instance, regardless of how many `refreshAll()` calls follow. A failed fetch is also not retried within the same panel instance.
- Readme entries with blank keys, invalid objects, or empty `md` content are ignored.
- The CRUD wrappers are intentionally thin. Missing backend methods are treated as hard errors and throw `"Plugins API is not available"`.

---

## Related files

- Implementation: `admin/tab/panels/plugins/data.plugins.js`
- Test: `admin/tab/panels/plugins/data.plugins.test.js`
- Panel entry: [`./tab-panels-plugins-entry.md`](./tab-panels-plugins-entry.md)
- State: [`./tab-panels-plugins-state.md`](./tab-panels-plugins-state.md)
- Catalog renderer: [`./tab-panels-plugins-render.catalog.md`](./tab-panels-plugins-render.catalog.md)
- Admin frontend overview: `docs/ui/README.md`
