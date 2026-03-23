# admin/tab/panels/plugins/render.catalog.js: catalog rendering, add toolbar, and viewer overlay

`admin/tab/panels/plugins/render.catalog.js` is the structural renderer for the Plugins panel.
It builds the catalog-level view model, renders the category sections and add toolbar, preserves accordion state across
rerenders, and provides the light markdown viewer used for plugin readmes.

In short: this file owns the catalog-level structure around all plugin instances.

---

## Where it sits in the system

`index.js` creates the catalog renderer after the menu facade is available and before the instance renderer is used.
During each refresh, `index.js` asks the catalog API to:

1. capture the current accordion state
2. build a view model from catalog data, instances, and readmes
3. render the full catalog fragment

The catalog renderer depends on:

- category metadata and CSS helpers from [`./tab-panels-plugins-state.md`](./tab-panels-plugins-state.md)
- the menu facade for category context menus
- the data facade for plugin creation through the add toolbar
- the instance renderer callback for rendering each instance row

---

## Responsibilities

1. Render and display plugin documentation snippets.
   - `renderMarkdownLite(md)` supports headings, paragraphs, bullet lists, horizontal rules, fenced code blocks, and inline code spans.
   - `openViewer({ title, bodyEl })` opens the large overlay viewer for plugin help content.

2. Preserve and rebuild catalog structure.
   - `captureAccordionState()` snapshots current accordion checkbox state from `.msghub-acc-input` elements.
   - `toAccKey(...)` creates stable accordion keys scoped by `adapterNamespace`, plugin type, and optional instance id.
   - `buildInstancesByType(...)` groups and sorts instances by type.
   - `buildPluginsViewModel(...)` combines plugin descriptors, instances, and readme availability into a frozen view model.

3. Render the add toolbar and category sections.
   - `buildAddMenuItems(vm)` creates category-grouped add actions for discoverable plugins.
   - `renderAddToolbar(vm)` renders the add button when at least one addable/discoverable plugin exists.
   - `renderCatalog(...)` renders category sections and delegates instance rows to `renderInstanceRow(...)`.

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabPluginsCatalog = {
  createPluginsCatalogApi
}
```

`createPluginsCatalogApi(options)` returns a frozen facade with:

- `renderMarkdownLite(md)`
- `openViewer(opts)`
- `captureAccordionState()`
- `toAccKey({ kind, type, instanceId })`
- `buildInstancesByType(instances)`
- `buildPluginsViewModel({ plugins, instances, readmesByType })`
- `buildAddMenuItems(vm)`
- `renderAddToolbar(vm)`
- `renderCatalog({ vm, expandedById, readmesByType, renderInstanceRow })`

The view model built by `buildPluginsViewModel(...)` currently contains:

- `plugins`
- `byType`
- `metaByType`

`metaByType` stores per-plugin metadata such as `category`, `hasSchema`, `discoverable`, `supportsMultiple`, `iconRef`, and `hasReadme`.

---

## Design notes / invariants

- `toAccKey(...)` is the stable identity function for accordion state persistence during full rerenders.
- `captureAccordionState()` prefers `data-acc-key` and falls back to the element `id` when no explicit key exists.
- `buildAddMenuItems(...)` ignores non-discoverable plugins.
- A plugin type can be added when either `supportsMultiple === true` or there is currently no existing instance of that type.
- The add flow is optimistic but not partial: after `createInstance(...)` succeeds, the full panel is refreshed and the new instance is scrolled into view when its `instanceId` is known.
- `renderCatalog(...)` only turns plugins into instance entries when two conditions are true:
  - the plugin exposes an `options` object
  - at least one instance of that plugin type exists
- Category sections are still rendered for the canonical category order even when they currently contain no entries. In that case the section shows the translated empty text.

---

## Related files

- Implementation: `admin/tab/panels/plugins/render.catalog.js`
- Test: `admin/tab/panels/plugins/render.catalog.test.js`
- Panel entry: [`./tab-panels-plugins-index.md`](./tab-panels-plugins-index.md)
- Menus: [`./tab-panels-plugins-menus.md`](./tab-panels-plugins-menus.md)
- Instance renderer: [`./tab-panels-plugins-render.instance.md`](./tab-panels-plugins-render.instance.md)
- Admin frontend overview: `docs/ui/README.md`
