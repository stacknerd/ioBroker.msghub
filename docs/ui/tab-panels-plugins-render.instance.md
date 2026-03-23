# admin/tab/panels/plugins/render.instance.js: instance row renderer and option editor

`admin/tab/panels/plugins/render.instance.js` renders one plugin instance row, including its status header,
help and enable/disable actions, optional channel routing input, and the expandable option form body.

In short: this file defines what one plugin instance looks like and how inline instance editing behaves.

---

## Where it sits in the system

`index.js` creates the instance renderer after the form and catalog APIs exist. During each full rerender,
[`./tab-panels-plugins-render.catalog.md`](./tab-panels-plugins-render.catalog.md) calls
`renderInstanceRow(...)` for every instance that should appear in the current catalog.

The instance renderer depends on:

- the form builder for schema-driven fields
- the catalog renderer for accordion keys and readme viewer rendering
- the menu facade for context menus
- the data facade for enable/disable, update, and delete operations
- `confirmDialog`, `toast`, and `onRefreshAll()` from `index.js`

---

## Responsibilities

1. Render the instance header.
   - Status marker, icon slot, instance name, start/stop toggle, help button, title value, optional channel field, and accordion chevron
   - `data-*` attributes describing instance id, run status, enabled state, plugin type, and category

2. Provide readme, toggle, channel, and remove actions.
   - The help button opens the plugin readme in the large overlay when one is available.
   - The toggle button calls `pluginsDataApi.setEnabled(...)` and then refreshes the full panel.
   - The optional channel input writes `nativePatch: { channel: next || null }` on blur/change.
   - Instance removal goes through a confirm dialog and then deletes the instance before a full refresh.

3. Render and manage the expandable option form.
   - The body is present only when the plugin exposes editable fields.
   - Dirty tracking compares current field values to the captured initial snapshot.
   - Saving sends one `nativePatch` containing all editable field values.

4. Provide instance-level context-menu and accordion behavior.
   - The instance header and body both forward right-clicks to the menu module with an instance-scoped context descriptor.
   - The header becomes a keyboard-accessible accordion toggle when options exist.

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabPluginsInstance = {
  createPluginsInstanceApi
}
```

`createPluginsInstanceApi(options)` returns:

```js
{
  renderInstanceRow(args)
}
```

`renderInstanceRow(...)` currently expects:

- `plugin`
- `inst`
- `expandedById`
- `readmesByType`

The catalog renderer also passes `instList`, but the current implementation does not use it.

---

## Design notes / invariants

- The instance wrapper always gets the `.msghub-plugin-instance` class and the `data-plugin-type`, `data-instance-id`, `data-enabled`, and `data-plugin-category` attributes. The menu module depends on all four attributes: `data-plugin-type` and `data-instance-id` for instance identification, `data-enabled` for enable-state tracking, and `data-plugin-category` for category-scoped bulk operations.
- Accordion state is keyed through `catalogApi.toAccKey(...)` and restored from `expandedById`.
- The help button is not removed when no readme exists. It stays in the layout with `is-invisible` and `disabled`.
- Channel routing is shown only when `plugin.supportsChannelRouting === true`.
- The channel placeholder is intentionally hard-coded to `all`. It is not translated.
- Channel updates are inline writes. On failure, the input value is reverted to its previous value and a danger toast is shown.
- The form body uses current instance-native values when present and falls back to schema defaults otherwise.
- Dirty tracking normalizes `undefined` to `null` before comparing values with `Object.is(...)`.
- Saving updates the local “initial” snapshot after a successful backend write, but it does not trigger a full rerender by itself.
- The save button also guards against double-submission by checking and setting a `data-saving="1"` marker.

---

## Related files

- Implementation: `admin/tab/panels/plugins/render.instance.js`
- Test: `admin/tab/panels/plugins/render.instance.test.js`
- Panel entry: [`./tab-panels-plugins-index.md`](./tab-panels-plugins-index.md)
- Form builder: [`./tab-panels-plugins-render.form.md`](./tab-panels-plugins-render.form.md)
- Catalog renderer: [`./tab-panels-plugins-render.catalog.md`](./tab-panels-plugins-render.catalog.md)
- Admin frontend overview: `docs/ui/README.md`
