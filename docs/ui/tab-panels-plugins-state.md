# admin/tab/panels/plugins/state.js: canonical plugin-panel state and shared helpers

`admin/tab/panels/plugins/state.js` is the shared utility and state-definition module for the Plugins panel.
It defines the panel-wide category and time-unit constants, exposes reusable stateless helpers, and creates the
small shared state object that the other Plugins modules mutate.

In short: this file defines the common vocabulary and cache shape for one Plugins panel instance.

---

## Where it sits in the system

`state.js` is loaded first in the Plugins panel asset list. `index.js` uses it as the root dependency for panel setup
and passes its helpers into the data, form, menu, catalog, and instance modules.

It is therefore the shared base of the whole Plugins cluster:

- [`./tab-panels-plugins-entry.md`](./tab-panels-plugins-entry.md) creates the panel state and injects the helpers into all submodules.
- [`./tab-panels-plugins-render.form.md`](./tab-panels-plugins-render.form.md) depends on the path, unit, and time helpers.
- [`./tab-panels-plugins-menus.md`](./tab-panels-plugins-menus.md) uses category metadata and text-editable detection.
- [`./tab-panels-plugins-render.catalog.md`](./tab-panels-plugins-render.catalog.md) uses category ordering and CSS-safe identifiers.

---

## Responsibilities

1. Define panel-wide constants.
   - `CATEGORY_ORDER` establishes the canonical display order: `ingest`, `notify`, `bridge`, `engage`.
   - `CATEGORY_I18N` stores the title and description i18n keys plus fallback titles for those categories.
   - `TIME_UNITS` defines the available unit options for millisecond-backed duration fields.

2. Provide shared stateless helpers.
   - `pick(obj, path)` for dotted-path reads
   - `cssSafe(s)` for CSS-safe identifiers
   - `formatPluginLabel(plugin)` for primary/secondary plugin labels
   - `normalizeUnit()`, `isUnitless()`, `pickDefaultTimeUnit()`, `getTimeFactor()`
   - `isTextEditableElement()` and `isTextEditableTarget()`

3. Create the canonical Plugins panel state.
   - `createPluginsState()` returns the shared caches used by the data layer.

---

## Public surface / integration points

The module exports one frozen global:

```js
window.MsghubAdminTabPluginsState = {
  CATEGORY_ORDER,
  CATEGORY_I18N,
  TIME_UNITS,
  pick,
  cssSafe,
  formatPluginLabel,
  normalizeUnit,
  isUnitless,
  pickDefaultTimeUnit,
  getTimeFactor,
  isTextEditableElement,
  isTextEditableTarget,
  createPluginsState
}
```

`createPluginsState()` currently returns:

- `cachedConstants`
- `pluginReadmesByType`
- `pluginReadmesLoadPromise`

These caches are shared across all Plugins submodules created for the same panel instance.

---

## Design notes / invariants

- `createPluginsState()` is intentionally small. The Plugins panel does not keep a large view-state tree here; most rendering state is rebuilt from fresh backend data.
- `pluginReadmesByType` is a `Map`, not a plain object. `pluginReadmesLoadPromise` is the single-flight marker for readme loading.
- `cssSafe()` lowercases, trims, replaces unsupported characters with dashes, collapses repeated dashes, and falls back to `'unknown'`.
- `pickDefaultTimeUnit(ms)` prefers exact `h`, then `min`, then `s`, and only falls back to `ms` when no larger exact unit fits.
- `getTimeFactor(unitKey)` falls back to `1` for unknown units.
- `isTextEditableTarget(target)` returns `true` when the event target is or is inside a text-editable element. The actual native-menu preservation, returning early without calling `preventDefault()`, is the responsibility of the caller in `menus.js`.

---

## Related files

- Implementation: `admin/tab/panels/plugins/state.js`
- Test: `admin/tab/panels/plugins/state.test.js`
- Panel entry: [`./tab-panels-plugins-entry.md`](./tab-panels-plugins-entry.md)
- Form builder: [`./tab-panels-plugins-render.form.md`](./tab-panels-plugins-render.form.md)
- Menus: [`./tab-panels-plugins-menus.md`](./tab-panels-plugins-menus.md)
- Admin frontend overview: `docs/ui/README.md`
