# admin/tab/panels/plugins/render.form.js: typed option-form builder for plugin instances

`admin/tab/panels/plugins/render.form.js` builds editable form controls from a plugin’s option schema.
It knows how to resolve dynamic options from `MsgConstants`, how to represent millisecond-backed durations with a
separate unit selector, and how to derive the field that should act as an instance title in the instance header.

In short: this file turns plugin option metadata into concrete DOM controls and value getters.

---

## Where it sits in the system

`index.js` creates one form facade per panel instance and passes it into the instance renderer.
The instance renderer uses this module whenever it has to build the editable body of a plugin instance row.

The form builder depends on:

- constants and path helpers from [`./tab-panels-plugins-state.md`](./tab-panels-plugins-state.md)
- `pickText(...)` for localized label/help text
- a lazy `getConstants()` callback so option resolution always sees the current cached `MsgConstants`

---

## Responsibilities

1. Resolve option metadata into normalized option lists.
   - `resolveDynamicOptions(options)` accepts either a plain option array or a `MsgConstants.some.path` reference.
   - String-valued enums are sorted by key.
   - Numeric-valued enums are sorted by value.

2. Build typed field controls.
   - `buildFieldInput(cfg)` supports:
     - section headers
     - plain text inputs
     - single-select inputs
     - multi-select inputs backed by comma-separated string values
     - booleans
     - numbers
     - millisecond-backed numbers with a separate unit selector

3. Extract schema information for instance rendering.
   - `getPluginFields(plugin)` flattens and sorts the `plugin.options` object.
   - `getInstanceTitleFieldKey(fields)` picks the first `holdsInstanceTitle` field.
   - `formatInstanceTitleValue(...)` builds the compact display value shown in the instance row header.

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabPluginsForm = {
  createPluginsFormApi
}
```

`createPluginsFormApi(options)` returns a frozen facade with:

- `buildFieldInput(cfg)`
- `parseCsvValues(csv)`
- `getPluginFields(plugin)`
- `getInstanceTitleFieldKey(fields)`
- `formatInstanceTitleValue({ inst, fieldKey, plugin })`
- `resolveDynamicOptions(options)`

`buildFieldInput(cfg)` returns a bundle containing at least:

- `wrapper`
- optional `input`
- optional `select`
- optional `getValue()`
- optional `skipSave`

---

## Design notes / invariants

- Dynamic options are resolved lazily through `getConstants()` at call time, not at factory creation time.
- Only strings starting with `MsgConstants.` are treated as dynamic option references. Other strings resolve to an empty option list.
- Multi-select fields are stored as comma-separated strings. `parseCsvValues(...)` is the canonical split-and-trim helper for that contract.
- Millisecond-backed number fields are inferred not only from `field.unit`, but also from legacy hints:
  - a field key ending in `Ms`
  - a label containing `(ms)`
- For millisecond-backed fields, the visible input value is converted when the user changes the unit selector, while `getValue()` always returns milliseconds.
- `formatInstanceTitleValue(...)` falls back to the field default when the instance-native value is missing or `null`, and truncates long values to `60` characters including the ellipsis.

---

## Related files

- Implementation: `admin/tab/panels/plugins/render.form.js`
- Test: `admin/tab/panels/plugins/render.form.test.js`
- Panel entry: [`./tab-panels-plugins-index.md`](./tab-panels-plugins-index.md)
- State: [`./tab-panels-plugins-state.md`](./tab-panels-plugins-state.md)
- Instance renderer: [`./tab-panels-plugins-render.instance.md`](./tab-panels-plugins-render.instance.md)
- Admin frontend overview: `docs/ui/README.md`
