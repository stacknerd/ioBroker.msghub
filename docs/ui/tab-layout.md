# admin/tab/layout.js: layout, tab navigation, and asset loading for the shell

`layout.js` is the shell-side DOM and asset orchestration layer.
It translates the static registry into visible tab/panel markup, reads an initial tab from
`location.hash`, writes the hash on tab clicks, loads panel assets, and mirrors theme changes from
the ioBroker admin host.

`boot.js` decides *when* the shell should initialize.
`layout.js` provides the lower-level tools that define *what the visible shell looks like*.

---

## Where it sits in the system

This module is loaded before [`./tab-boot.md`](./tab-boot.md) and after the runtime/UI helpers.
It depends on:

- runtime theme helpers from [`./tab-runtime.md`](./tab-runtime.md)
- the shell registry from [`./tab-registry.md`](./tab-registry.md)
- the small DOM helper `h(...)` defined in this file itself

The main consumer is `boot.js`, which calls `buildLayoutFromRegistry()`, `initTabs()`,
`computeAssetsForComposition()`, `loadCssFiles()`, and `loadJsFilesSequential()`.

---

## Responsibilities

### 1) Build the visible composition from the registry

`buildLayoutFromRegistry()` reads the active composition and renders:

- the tab navigation
- native panel containers
- plugin panel placeholder containers

It separates the result into two groups:

- `panelIds`: native panel string IDs only
- `pluginPanelRefs`: structured plugin panel references only

That separation is important because native panels are initialized from registry assets, while plugin panels
are hydrated later from runtime discover data.

### 2) Manage tab navigation and panel visibility

`initTabs()` binds `.msghub-tab` links to their panel containers and keeps:

- `is-active` classes
- `aria-selected`
- `tabindex`
- `hidden` panel state

in sync.

Its hash handling is intentionally narrow:

- it reads `location.hash` once during initialization to choose the initial panel
- it writes a new hash via `history.replaceState(...)` on tab clicks

It does not listen for `hashchange` or `popstate`, so external hash changes do not switch tabs back.

When the active tab changes, it dispatches:

```js
new CustomEvent('msghub:tabSwitch', { detail: { from, to } })
```

That event is used by other shell code, especially plugin-panel lazy mounting and overlay cleanup.

### 3) Load panel assets in a predictable way

`layout.js` contains the shell asset loaders:

- `loadCssFiles(files)` for stylesheets
- `loadJsFilesSequential(files)` for scripts

CSS loading is tolerant and reports failed paths back to the caller.
JavaScript loading is sequential and fails hard if one script cannot be loaded.

### 4) Keep shell theme in sync with the admin host

The module listens for several theme signals:

- `window.message`
- `storage`
- periodic polling
- `MutationObserver` on the top window document

All of them route through `applyTheme(...)` from [`./tab-runtime.md`](./tab-runtime.md).

This is a practical anti-drift layer: if one host-side theme signal is missing, the shell still has backups.

---

## Public surface / integration points

`layout.js` exposes the shell helpers as classic global functions.

### `initTabs({ defaultPanelId })`

Initializes the tab strip and returns:

```js
{ setActive, initial }
```

`initial` may be `null` when every tab is disabled, which is relevant for plugin-only compositions before hydration.

### `buildLayoutFromRegistry({ contributions })`

Builds the current composition and returns:

```js
{
  layout,
  panelIds,
  pluginPanelRefs,
  defaultPanelId
}
```

Wildcard compositions (`panels: ['*']`) use `contributions` to materialize plugin panel slots.

### `computeAssetsForComposition(panelIds)`

Returns deduplicated CSS and JS lists for the given native panel IDs.

### `getPanelDefinition(panelId)`

Returns one native panel definition from the registry, or `null`.

### `renderPanelBootError(panelId, err)`

Writes a visible error state directly into the affected panel container.

---

## Design notes / invariants

- Plugin panel refs are never mixed into `panelIds`. Native and plugin panels follow different initialization paths.
- Plugin tabs render in a disabled placeholder state until discover hydration confirms availability.
- `initTabs()` skips disabled tabs when resolving the initial active panel from hash, markup, and fallback defaults.
- `loadCssFiles()` deduplicates URLs and reports failures instead of throwing.
- `loadJsFilesSequential()` preserves script order and throws on the first failed script, because many panel files depend on earlier globals.
- Theme syncing is intentionally redundant: message, storage, polling, and mutation observation all feed the same final theme setter.

---

## Related files

- Implementation: [`admin/tab/layout.js`](../../admin/tab/layout.js)
- Test: [`admin/tab/layout.test.js`](../../admin/tab/layout.test.js)
- Registry input: [`./tab-registry.md`](./tab-registry.md)
- Runtime theme helpers: [`./tab-runtime.md`](./tab-runtime.md)
- Boot orchestration: [`./tab-boot.md`](./tab-boot.md)
- Shell HTML host: [`admin/tab.html`](../../admin/tab.html)
