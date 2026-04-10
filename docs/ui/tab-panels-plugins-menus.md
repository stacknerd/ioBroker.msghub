# admin/tab/panels/plugins/menus.js: plugins context menus and bulk operations

`admin/tab/panels/plugins/menus.js` owns the custom context-menu layer of the Plugins panel.
It turns the current DOM and the current scope (`all`, `category`, or `instance`) into menu trees for expanding,
collapsing, enabling, disabling, opening help, and removing instances.

In short: this file is the command surface behind right-click interactions in the Plugins panel.

---

## Where it sits in the system

`index.js` creates one menu facade and passes its `openPluginsContextMenu(...)` callback into:

- the root panel `contextmenu` listener for the global `all` scope
- [`./tab-panels-plugins-render.catalog.md`](./tab-panels-plugins-render.catalog.md) for category rows
- [`./tab-panels-plugins-render.instance.md`](./tab-panels-plugins-render.instance.md) for instance heads and instance bodies

The menu module depends on:

- `elRoot`
- `CATEGORY_I18N`
- translation helpers
- `isTextEditableTarget(...)`
- the plugins data facade for enable/disable operations
- `onRefreshAll()` to rerender after state-changing bulk actions

---

## Responsibilities

1. Derive scope-aware instance collections from the current DOM.
   - `getAllInstanceWraps()`
   - `getEnabledStats(wraps)`
   - scope-specific subsets for one instance, one type, one category, or the whole panel

2. Apply bulk operations to current instance wraps.
   - `setAccordionChecked(wraps, checked)` expands or collapses instance accordions and dispatches `change` on the checkbox inputs.
   - `setEnabledForWraps(wraps, enabled)` toggles backend enabled state for each changed instance and then triggers a full refresh.

3. Build and open the context menu for the current scope.
   - Instance scope adds help and remove actions.
   - All scopes provide expand, collapse, disable, and enable submenus.

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabPluginsMenus = {
  createPluginsMenusApi
}
```

`createPluginsMenusApi(options)` returns a frozen facade with:

- `getAllInstanceWraps()`
- `getCategoryTitle(categoryRaw)`
- `setAccordionChecked(wraps, checked)`
- `getEnabledStats(wraps)`
- `setEnabledForWraps(wraps, enabled)`
- `openPluginsContextMenu(event, ctx)`

The context descriptor currently supports:

- `kind`: `all`, `category`, or `instance`
- `instWrap`
- `pluginType`
- `categorySafe`
- `categoryRaw`
- `instanceName`
- `hasReadme`
- `openReadme`
- `removeInstance`

---

## Design notes / invariants

- Ctrl-right-click is the explicit bypass for the custom menu. In that case the menu module returns early and leaves the browser menu path untouched.
- Text-editable targets also bypass the custom menu through `isTextEditableTarget(...)`.
- `setEnabledForWraps(...)` skips instances whose current `data-enabled` state already matches the requested target state.
- Enable/disable operations are applied sequentially, not as one batched backend request.
- Category titles come from `CATEGORY_I18N` when known and otherwise fall back to a generated i18n key with the raw category as the final fallback.
- Instance menus add `help` only as a menu item. Enable and disable operations are handled directly by `setEnabledForWraps(...)` within this module. The readme and remove actions are executed through callbacks provided by the instance renderer.

---

## Related files

- Implementation: `admin/tab/panels/plugins/menus.js`
- Test: `admin/tab/panels/plugins/menus.test.js`
- Panel entry: [`./tab-panels-plugins-entry.md`](./tab-panels-plugins-entry.md)
- Catalog renderer: [`./tab-panels-plugins-render.catalog.md`](./tab-panels-plugins-render.catalog.md)
- Instance renderer: [`./tab-panels-plugins-render.instance.md`](./tab-panels-plugins-render.instance.md)
- Admin frontend overview: `docs/ui/README.md`
