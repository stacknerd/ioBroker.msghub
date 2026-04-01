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

- runtime query/theme helpers from [`./tab-runtime.md`](./tab-runtime.md)
- the shell registry from [`./tab-registry.md`](./tab-registry.md)
- the small DOM helper `h(...)` defined in this file itself

The main consumer is `boot.js`, which calls `resolveViewId()`, `getActiveComposition()`,
`buildLayoutFromRegistry()`, `initTabs()`, `activatePanel()`, `updateDocumentTitle()`,
`computeAssetsForComposition()`, `loadCssFiles()`, and `loadJsFilesSequential()`.

`api.js` also depends on the same composition resolution helpers so that `api.host.*` metadata and the
visible shell use the same final view/composition decision.

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

The active composition is resolved centrally through:

1. registered `args.composition`
2. registered `data-msghub-view`
3. hard fallback `adminTab`

Unknown composition ids do not fall through to wildcard mode. Wildcard handling happens only when the
selected composition itself declares `panels: ['*']`.

### 2) Manage panel activation, tab navigation, and visibility

`layout.js` owns one shared activation path for visible panels:

- `activatePanel(panelId)` updates active state and visibility for the currently rendered shell
- `initTabs()` binds `.msghub-tab` links to that shared activation path
- `updateDocumentTitle()` derives the page title from the active panel

For tabbed layouts, `activatePanel(...)` keeps:

- `is-active` classes
- `aria-selected`
- `tabindex`
- `hidden` panel state

in sync.

For single-panel layouts, the same activation path still owns panel visibility and document title,
even though no tab strip exists.

`initTabs()` hash handling is intentionally narrow:

- it reads `location.hash` once during initialization to choose the initial panel
- it writes a new hash via `history.replaceState(...)` on tab clicks

It does not listen for `hashchange` or `popstate`, so external hash changes do not switch tabs back.
It also does not use the hash to select a composition.

When the active panel changes from one panel to another, `activatePanel(...)` dispatches:

```js
new CustomEvent('msghub:tabSwitch', { detail: { from, to } })
```

That event is used by other shell code, especially plugin-panel lazy mounting and overlay cleanup.

`updateDocumentTitle()` follows the active panel descriptor:

- `pickText(descriptor.label)` resolves the label from the `PanelDescriptor` stored at boot/hydration time
- format: `'<label> - MessageHub'`; when no descriptor is available: `'MessageHub'`
- calling with no arguments re-derives title from `panelDescriptors.get(currentActivePanelId)`, enabling i18n resync after a language change without passing an explicit descriptor

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
When `urlThemeLocked === true`, all of those sync paths become no-ops so an explicit URL theme override remains authoritative.

---

## Public surface / integration points

`layout.js` exposes the shell helpers as classic global functions.

### `resolveViewId()`

Returns the resolved composition id using the shared fallback order:

1. registered `args.composition`
2. registered `data-msghub-view`
3. `adminTab`

### `getActiveComposition()`

Returns the registered composition object for `resolveViewId()`, or `null`.

### `initTabs({ defaultPanelId })`

Initializes the tab strip and returns:

```js
{ setActive, initial }
```

`initial` may be `null` when every tab is disabled, which is relevant for plugin-only compositions before hydration.

`setActive` is the shared `activatePanel(...)` path used by the shell, not a tab-private implementation.

### `activatePanel(panelId)`

Activates one rendered panel container by DOM id (for example `tab-messages`), updates tab state when present,
updates panel visibility, dispatches `msghub:tabSwitch` on real panel changes, and keeps `document.title` in sync.

Passes the `PanelDescriptor` for `panelId` explicitly to `updateDocumentTitle`.

### `updateDocumentTitle(descriptor?)`

Derives `document.title` from a `PanelDescriptor` and manages PWA/install head meta tags.
Format: `'<label> - MessageHub'` when a label is resolved, or `'MessageHub'` when no descriptor is available.
Label resolution goes through `pickText(descriptor.label)`, which handles i18n keys and legacy `{en, de}` language maps.

When called with no argument, falls back to `panelDescriptors.get(currentActivePanelId)`. This allows
`applyStaticI18n()` to call `updateDocumentTitle()` with no args after a language change and still
re-derive the correct title for the currently active panel.

When `descriptor.app` is present, `applyAppHeadMeta(descriptor.app)` sets or updates:
- `<meta name="theme-color">` (when `app.themeColor` is a string)
- `<meta name="application-name">` (when `app.name` is present, resolved via `pickText`)
- `<meta name="apple-mobile-web-app-title">` (`app.shortName ?? app.name`, resolved via `pickText`)

When `descriptor.app` is absent (including on every panel switch away from an app-panel),
`resetAppHeadMeta()` fully removes all three managed meta tags from `document.head`. Tags are
removed rather than emptied, because an empty `theme-color` would still override browser defaults.

Both `applyAppHeadMeta` and `resetAppHeadMeta` are idempotent: calling them multiple times without
intermediate DOM changes produces the same state as a single call.

### `normalizeCorePanel(registryKey, def)`

Converts a raw native panel definition from `registry.panels` into a canonical `PanelDescriptor`.
The resulting object has: `id`, `label`, `ui` (kind, loader, initGlobal, css, js), optional `surface`,
optional `category`, and an optional `app` block. Also sets the private `_registryKey` field used by
`computeAssetsForComposition`.

### `normalizePluginPanel(contrib, pluginRef)`

Converts a plugin contribution object and its structured registry ref into a canonical `PanelDescriptor`.
The resulting id follows the pattern `tab-plugin-<pluginType>-<instanceId>-<panelId>`.
`ui.kind` is `'plugin'`, `ui.loader` is `'esm'`. `label` and `description` carry legacy `{en, de}`
objects from the manifest (current IngestStates format) and are bridged via `pickText()`. `ui.entry` is not populated — the current
discover RPC returns only `bundle.hash`, not `bundle.entry`.

Optional fields are passed through from `contrib` when present:

- `surface` (`'admin' | 'web' | 'both'`) — eligibility gate: where may this panel appear. Not a
  security concept.
- `category` (`'dashboard' | 'user' | 'admin' | ...`) — semantic group of the panel; basis for future
  accent-bar / color coding. Not a styling field and carries no color values.
- `app` — optional PWA / install metadata block (same `AppBlock` schema as core panels).
  Required within `app`: `name` (i18n key string), `url` (canonical URL string). Optional: `shortName`,
  `themeColor`, `icons` (paths package-root-relative per RFC-0012). When present,
  `updateDocumentTitle` will call `applyAppHeadMeta` with it. When absent, the field is `undefined`
  on the descriptor — no error, no head-meta update.

### `registerPanelDescriptor(descriptor)`

Stores a `PanelDescriptor` in the module-private `panelDescriptors` map keyed by `descriptor.id`.
Called from `buildLayoutFromRegistry` for native panels and from `hydratePluginPanels` (boot.js) for plugin panels.
Provides the lookup needed by the no-arg form of `updateDocumentTitle`.

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

- `resolveViewId()` is the shared composition resolver for both `layout.js` and `api.js`; visible layout and `api.host.viewId` must not drift.
- Plugin panel refs are never mixed into `panelIds`. Native and plugin panels follow different initialization paths.
- Plugin tabs render in a disabled placeholder state until discover hydration confirms availability.
- `activatePanel(...)` is the shared activation path for both `tabs` and `single` layouts.
- `initTabs()` skips disabled tabs when resolving the initial active panel from hash, markup, and fallback defaults.
- `document.title` is derived from the active panel via its `PanelDescriptor.label` resolved through `pickText()`. Format: `'<label> - MessageHub'`.
- `applyAppHeadMeta` / `resetAppHeadMeta` manage exactly three head meta tags (`theme-color`, `application-name`, `apple-mobile-web-app-title`). Tags are fully removed (not emptied) on panel switch so no stale values override browser defaults. `<link rel="manifest">` is out of scope for this layer.
- `panelDescriptors` is a module-private `Map<tabId, PanelDescriptor>`. It is not a global; `const` at script top-level does not become `window.*`.
- `normalizeCorePanel` is layout-internal and not a global. Only `normalizePluginPanel`, `registerPanelDescriptor` are exposed as globals (implicit via top-level function declarations).
- `pickText` is provided by `runtime.js` (loaded before `layout.js`). `layout.js` consumes it as a global without redeclaring it.
- `loadCssFiles()` deduplicates URLs and reports failures instead of throwing.
- `loadJsFilesSequential()` preserves script order and throws on the first failed script, because many panel files depend on earlier globals.
- Theme syncing is intentionally redundant: message, storage, polling, and mutation observation all feed the same final theme setter.
- `urlThemeLocked` is runtime-owned internal coordination state. `layout.js` consumes it, but it is not a public native-panel or plugin-facing API.

---

## Related files

- Implementation: [`admin/tab/layout.js`](../../admin/tab/layout.js)
- Test: [`admin/tab/layout.test.js`](../../admin/tab/layout.test.js)
- Registry input: [`./tab-registry.md`](./tab-registry.md)
- Runtime query/theme helpers: [`./tab-runtime.md`](./tab-runtime.md)
- API host metadata consumer: [`./tab-api.md`](./tab-api.md)
- Boot orchestration: [`./tab-boot.md`](./tab-boot.md)
- URL guide: [`./url-parameters.md`](./url-parameters.md)
- Shell HTML host: [`admin/tab.html`](../../admin/tab.html)
