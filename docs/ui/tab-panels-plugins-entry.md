# admin/tab/panels/plugins/entry.js: host-owned entry for the Plugins core panel

`admin/tab/panels/plugins/entry.js` is the active host-owned bootstrap document for the Plugins core panel.
It publishes the panel-owned asset lists and the required `panelInit(ctx)` function, then wires the already-loaded
Plugins submodules into one working panel instance.

In short: this file is both the technical boot contract for the Plugins core panel and the panel-local coordinator
that turns the Plugins submodules into the visible plugin-management panel.

---

## Where it sits in the system

The Plugins core panel now boots through the same host-owned convention as Messages:

1. The backend view contract exposes the core panel only as `'plugins'`.
2. [`./tab-core-panel-bootstrap.md`](./tab-core-panel-bootstrap.md) resolves `admin/tab/panels/plugins/entry.js`.
3. The helper returns this entry definition with `{ css, js, panelInit(ctx) }`.
4. [`./tab-boot.md`](./tab-boot.md) loads the declared Plugins assets and then calls `panelInit(ctx)`.
5. `panelInit(ctx)` validates the Plugins submodule globals, builds the panel instance, and returns the lifecycle handle.

That means the host now boots the Plugins panel only through the host-owned entry convention.

---

## Responsibilities

### 1) Publish the Plugins bootstrap contract

The exported entry definition owns:

- `css`: the Plugins panel stylesheet list
- `js`: the ordered Plugins submodule script list
- `panelInit(ctx)`: the only remaining init contract for the Plugins core panel

As with Messages, the `js` list is still important because the Plugins submodules are classic scripts that expose
their factories through globals consumed by `panelInit(ctx)`.

### 2) Build one Plugins panel instance

`panelInit(ctx)`:

- validates `ctx.elements.pluginsRoot`
- validates the required Plugins submodule globals
- creates shared panel state
- builds the data, form, menu, catalog, and instance facades
- registers the root-level contextmenu listener immediately

### 3) Own the full refresh workflow

The panel-local `refreshAll(...)` function:

- loads constants
- loads the plugin catalog
- loads current instances
- loads or reuses readmes
- captures accordion state
- rerenders the full catalog fragment
- keeps the spinner lifecycle balanced even on failure

### 4) Expose the lifecycle handle back to the shell

The current Plugins lifecycle handle contains:

```js
{
  onConnect,
  refreshPlugin
}
```

`onConnect()` delegates to a connect-scoped `refreshAll(...)`.
`refreshPlugin(type)` still refreshes the whole panel in the current code path.

---

## Public surface / integration points

### Entry definition

The entry assigns one frozen definition to `document.currentScript.__msghubCorePanelEntry`:

```js
{
  css: ['tab/panels/plugins/styles.css'],
  js: [
    'tab/panels/plugins/state.js',
    'tab/panels/plugins/data.plugins.js',
    'tab/panels/plugins/render.form.js',
    'tab/panels/plugins/menus.js',
    'tab/panels/plugins/render.catalog.js',
    'tab/panels/plugins/render.instance.js',
  ],
  panelInit(ctx)
}
```

### `panelInit(ctx)`

`panelInit(ctx)` expects the normal AdminTab core panel context, especially:

- `ctx.api.constants`
- `ctx.api.plugins`
- `ctx.api.i18n`
- `ctx.api.ui`
- `ctx.h`
- `ctx.elements.pluginsRoot`

### Important internal helpers

The entry also owns local helpers that are not exported separately:

- `toast(...)`
- `confirmDialog(...)`
- `refreshAll(options)`
- `refreshPlugin(type)`

Those helpers are panel-local orchestration only and are not part of the shell API.

---

## Design notes / invariants

- This file is the **active core panel entry**. No legacy global core-panel init contract remains.
- `panelInit(ctx)` is strict: missing root/container or missing submodule globals fail immediately.
- The root contextmenu listener is attached during initialization, not lazily later.
- `refreshAll(...)` is single-flight and connect-triggered refreshes are cooldown-deduplicated.
- Panel failures replace the panel body with one inline error block rather than leaving partially updated DOM behind.

---

## Related files

- Implementation: [`admin/tab/panels/plugins/entry.js`](../../admin/tab/panels/plugins/entry.js)
- Bootstrap resolver: [`./tab-core-panel-bootstrap.md`](./tab-core-panel-bootstrap.md)
- Boot consumer: [`./tab-boot.md`](./tab-boot.md)
- State module: [`./tab-panels-plugins-state.md`](./tab-panels-plugins-state.md)
- Data facade: [`./tab-panels-plugins-data.plugins.md`](./tab-panels-plugins-data.plugins.md)
- Catalog renderer: [`./tab-panels-plugins-render.catalog.md`](./tab-panels-plugins-render.catalog.md)
- Instance renderer: [`./tab-panels-plugins-render.instance.md`](./tab-panels-plugins-render.instance.md)
