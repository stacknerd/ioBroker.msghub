# admin/tab/panels/plugins/index.js: plugins panel entry and orchestrator

`admin/tab/panels/plugins/index.js` is the orchestration layer for the native Plugins panel in the Admin tab.
It validates the required submodules, creates one shared panel instance, wires data, menus, catalog rendering,
instance rendering, and form building together, and exposes the lifecycle handle that `boot.js` uses.

In short: this file turns the Plugins submodules into one working plugin-management panel.

---

## Where it sits in the system

The Plugins panel is registered as a native panel in the backend UI registry (`lib/IoUiRegistry.js`). Its asset list loads the six
Plugins submodules first and then ends with `admin/tab/panels/plugins/index.js`. After the panel is initialized,
`boot.js` calls the exported lifecycle hooks through `window.MsghubAdminTabPlugins`.

Inside the panel, `index.js` sits above the specialized modules:

- [`./tab-panels-plugins-state.md`](./tab-panels-plugins-state.md) provides the shared caches and stateless helpers.
- [`./tab-panels-plugins-data.plugins.md`](./tab-panels-plugins-data.plugins.md) wraps constants, readmes, and plugin CRUD APIs.
- [`./tab-panels-plugins-render.form.md`](./tab-panels-plugins-render.form.md) builds typed form controls for plugin option schemas.
- [`./tab-panels-plugins-menus.md`](./tab-panels-plugins-menus.md) owns context menus and bulk operations.
- [`./tab-panels-plugins-render.catalog.md`](./tab-panels-plugins-render.catalog.md) builds the category catalog, viewer overlay, and add toolbar.
- [`./tab-panels-plugins-render.instance.md`](./tab-panels-plugins-render.instance.md) renders one instance row and its editable body.

---

## Responsibilities

1. Build one Plugins panel instance from the loaded globals.
   - `init(ctx)` validates `pluginsRoot` and all six required Plugins globals.
   - It derives `adapterInstance` and `adapterNamespace`, creates the shared panel state, and constructs the data, form, menu, catalog, and instance facades.

2. Own the full refresh workflow.
   - `refreshAll()` loads constants, the plugin catalog, the current instances, and plugin readmes fetched once on first load. Later calls return the cached readme result.
   - It captures accordion state before rerendering, rebuilds the catalog fragment, replaces the root DOM, and always hides the spinner in `finally`.

3. Provide panel-level interaction glue.
   - It creates the non-throwing toast helper and the confirm-dialog fallback.
   - It passes `refreshAll()` into submodules as a lazy callback for add, remove, enable, disable, and toggle flows.
   - It registers the root `contextmenu` listener immediately during initialization.

4. Bridge the panel to the shell lifecycle.
   - `onConnect()` triggers `refreshAll({ source: 'connect' })`.
   - `refreshPlugin(type)` currently delegates to a full manual refresh and does not scope the refresh by type.

---

## Public surface / integration points

The module exports one frozen global:

```js
window.MsghubAdminTabPlugins = {
  init(ctx)
}
```

`init(ctx)` expects the native panel init context, especially:

- `ctx.api.constants`
- `ctx.api.plugins`
- `ctx.api.i18n`
- `ctx.api.ui`
- `ctx.h`
- `ctx.elements.pluginsRoot`

The returned panel handle is:

```js
{
  onConnect,
  refreshPlugin
}
```

Important internal integration points:

- `menusApi`, `catalogApi`, and `instanceApi` all receive `onRefreshAll: () => refreshAll()` so they can trigger full rerenders after state-changing actions.
- `catalogApi.renderCatalog(...)` receives `instanceApi.renderInstanceRow` as its row renderer.
- The panel root `contextmenu` handler delegates the actual bypass and editable-target checks to [`./tab-panels-plugins-menus.md`](./tab-panels-plugins-menus.md).

---

## Design notes / invariants

- Initialization is strict. Missing `pluginsRoot` or a missing submodule global causes an immediate error.
- The full panel render is single-flight. While one `refreshAll()` is in progress, later callers reuse the same promise instead of starting a second overlapping refresh.
- Connect-triggered refreshes are deduplicated for `1500` ms through `lastConnectRefreshAt`. This applies only to `source: 'connect'`.
- The root `contextmenu` listener is attached at init time, not lazily later during readme loading.
- Errors during `refreshAll()` replace the panel body with one inline `.msghub-error` element instead of leaving partially updated content behind.
- `refreshPlugin(type)` is intentionally broad in the current code path: the `_type` parameter is ignored and the whole panel is refreshed.

---

## Related files

- Implementation: `admin/tab/panels/plugins/index.js`
- Test: `admin/tab/panels/plugins/index.test.js`
- State: [`./tab-panels-plugins-state.md`](./tab-panels-plugins-state.md)
- Data facade: [`./tab-panels-plugins-data.plugins.md`](./tab-panels-plugins-data.plugins.md)
- Catalog renderer: [`./tab-panels-plugins-render.catalog.md`](./tab-panels-plugins-render.catalog.md)
- Instance renderer: [`./tab-panels-plugins-render.instance.md`](./tab-panels-plugins-render.instance.md)
- Admin frontend overview: `docs/ui/README.md`
