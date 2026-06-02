# admin/tab/layout.js: layout, tab navigation, and asset loading for the shell

`layout.js` is the shell-side DOM and asset orchestration layer.
It translates the loaded backend view into visible tab/panel markup, reads an initial tab from
`location.hash`, writes the hash on tab clicks, loads panel assets, and mirrors theme changes from
the ioBroker admin host.

`boot.js` decides *when* the shell should initialize.
`layout.js` provides the lower-level tools that define *what the visible shell looks like*.

---

## Where it sits in the system

This module is loaded before [`./tab-boot.md`](./tab-boot.md) and after the runtime/UI helpers.
It depends on:

- runtime query/theme helpers from [`./tab-runtime.md`](./tab-runtime.md)
- the loaded `web.view.get` payload documented in [`./API.md`](./API.md)
- the small DOM helper `h(...)` defined in this file itself

The main consumer is `boot.js`, which calls `resolveViewId()`, `getActiveComposition()`,
`buildLayoutFromRegistry()`, `initTabs()`, `activatePanel()`, `updateDocumentTitle()`,
`loadCssFiles()`, `loadJsFilesSequential()`, and `resolveIconUrl()`.

`api.js` also depends on the same composition resolution helpers so that `api.host.*` metadata and the
visible shell use the same final view/composition decision.

---

## Responsibilities

### 1) Build the visible composition from the active backend view

`buildLayoutFromRegistry()` reads the active view composition and renders:

- the tab navigation
- native panel containers
- plugin panel placeholder containers

When a rendered tab has a panel `description` i18n key, the tab anchor receives `data-i18n-title`
and a translated `title` tooltip. Plugin panel tabs keep the loading label and no tooltip until
`boot.js` hydrates the resolved plugin panel metadata and its plugin-owned i18n is available.

It separates the result into two groups:

- `panelIds`: native/core panel ids only
- `pluginPanelRefs`: structured plugin panel references only

That separation is important because native panels are initialized from `corePanels`, while plugin panels
are hydrated later from `view.pluginPanels`.
The active request is resolved centrally through:

1. `args.panel`
2. `args.composition`
3. `data-msghub-view`
4. backend default `adminTab`

`boot.js` then loads the actual view via `web.view.get(...)` and stores it through `setActiveView(...)`.

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

- `t(descriptor.label)` resolves the label from the `PanelDescriptor` stored at boot/hydration time
- format: `'<label> - MessageHub'`; when no descriptor is available: `'MessageHub'`
- calling with no arguments re-derives title from `panelDescriptors.get(currentActivePanelId)`, enabling i18n resync after a language change without passing an explicit descriptor
- the function returns a `Promise<void>` because app-head output may need async icon resolution

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

### `resolveViewRequest()`

Returns the normalized backend request the shell will send to `web.view.get(...)`.

### `setActiveView(view)` / `getActiveView()`

Store and read the active backend view payload.

### `resolveViewId()`

Returns the loaded composition id, or `null` in panel mode.

### `getActiveComposition()`

Returns the loaded composition object from the active backend view, or `null`.

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

Derives `document.title` from a `PanelDescriptor` and manages PWA/install head metadata.
Format: `'<label> - MessageHub'` when a label is resolved, or `'MessageHub'` when no descriptor is available.
Label resolution is key-strict and goes through `t(descriptor.label)`. Hard-migrated panel metadata must already be i18n-key strings; legacy language maps are not bridged here.

When called with no argument, falls back to `panelDescriptors.get(currentActivePanelId)`. This allows
`applyStaticI18n()` to call `updateDocumentTitle()` with no args after a language change and still
re-derive the correct title for the currently active panel.

For plugin panels, the shell consumes whatever runtime dictionary is currently loaded.
In this rescue cut, `web.view.get` no longer transports plugin-owned Admin-UI translations; those arrive only
through the later bundle path. `document.title`, app head meta, and manifest text therefore stay on the same
key-strict consumer contract and may expose raw plugin-owned i18n keys until bundle i18n has been merged.

When `descriptor.app` is present, `applyAppHeadMeta(descriptor)` runs asynchronously and sets or updates:
- `<meta name="theme-color">` (when `app.themeColor` is a string)
- `<meta name="application-name">` (when `app.name` is present, resolved via `t`)
- `<meta name="apple-mobile-web-app-title">` (`app.shortName ?? app.name`, resolved via `t`)
- `<meta name="apple-mobile-web-app-capable" content="yes">`
- `<link rel="apple-touch-icon">` from the resolved `apple180` slot
- `<link rel="manifest">` with a runtime-generated `blob:` manifest URL whose icon entries point at static host URLs

`layout.js` resolves app icons generically for both descriptor kinds:

- both descriptor kinds: host-visible URLs derived from `descriptor.resolvedAppIcons[slot]`
- `resolvedAppIcons` already contains the effective host-relative asset paths (`icons/...`)

For the generated manifest, icon entries are emitted as browser-loadable runtime URLs:

- both descriptor kinds: absolute runtime URLs derived from the current shell entry plus the translated host-visible icon path

This avoids inline data URIs and keeps manifest icon loading
separate from the blob manifest document itself.

When `descriptor.app` is absent (including on every panel switch away from an app-panel),
`resetAppHeadMeta()` fully removes the two managed links plus all four managed meta tags from `document.head`.
The runtime-generated manifest object URL is revoked before removal so panel switches do not leak browser resources.

Both `applyAppHeadMeta` and `resetAppHeadMeta` are idempotent: calling them multiple times without
intermediate DOM changes produces the same state as a single call.

### `normalizeCorePanel(registryKey, def)`

Converts a raw native panel definition from `corePanels` into a canonical `PanelDescriptor`.
The producer now stores owner-local ids (`'messages'`, `'plugins'`). `normalizeCorePanel(...)`
derives the canonical external/runtime id as `tab-<ownerLocalId>`, and passes through `category`,
the optional `description` i18n key, the optional `app` block, and the backend-owned
`resolvedAppIcons` map.

### `normalizePluginPanel(panelDef, pluginRef)`

Converts a resolved backend plugin panel object and its structured registry ref into a canonical `PanelDescriptor`.
The resulting id follows the pattern `tab-plugin-<pluginType>-<instanceId>-<panelId>`.
`ui.kind` is `'plugin'`, `ui.loader` is `'esm'`. `label` is a plugin-owned admin-ui i18n key string,
`description` is an optional plugin-owned admin-ui i18n key string used as the tab tooltip after
plugin i18n hydration. `ui.entry` is intentionally absent from the frontend
descriptor contract; bundle loading is host-owned via `web.pluginUi.bundle.get` plus `bundle.hash`.

Optional fields are passed through from `contrib` when present:

- `category` (`'web' | 'admin' | 'config'`) — manually declared primary access/capability marker
  for the panel; basis for tab-level visual coding. Not a styling field and carries no color values.
- `app` — optional PWA / install metadata block (same `AppBlock` schema as core panels).
  Required within `app`: `name` (i18n key string), `url` (host-neutral single-panel target string,
  currently stable query params such as `?panel=tab-plugin-IngestStates-0-presets`). Manifest
  `start_url` / `id` are resolved later from the current shell entry URL (`origin + pathname`)
  plus that target, so the generated blob manifest carries installable absolute `http(s)` URLs.
  Optional: `shortName`, `display`, `themeColor`, and `backgroundColor`. In the current
  AdminTab installability/head path, icon policy is not derived from `app.icons`; the effective
  icon slots arrive through the backend-owned `resolvedAppIcons` map. When present, `updateDocumentTitle`
  will call `applyAppHeadMeta` with `app`. When absent, the field is `undefined` on the descriptor —
  no error, no head-meta update.
- `resolvedAppIcons` — backend-owned effective icon-slot map. The shell consumes it as-is; each slot value
  is already the current host-relative asset path (`icons/...`).

### `registerPanelDescriptor(descriptor)`

Stores a `PanelDescriptor` in the module-private `panelDescriptors` map keyed by `descriptor.id`.
Called from `buildLayoutFromRegistry` for native panels and from `hydratePluginPanels` (boot.js) for plugin panels.
Provides the lookup needed by the no-arg form of `updateDocumentTitle`.

### `resolveIconUrl(descriptor, slot)`

Resolves one app-icon URL from a canonical `PanelDescriptor`.

- returns the current host-visible URL derived from `descriptor.resolvedAppIcons[slot]`
- consumes the backend-provided host-relative asset path directly
- missing icon slots, unsupported slots, or malformed descriptors return `null`

This function no longer derives icon policy locally. Callers receive the same
`Promise<string|null>` contract for both descriptor kinds.

### `buildLayoutFromRegistry()`

Builds the current composition and returns:

```js
{
  layout,
  panelIds,
  pluginPanelRefs,
  defaultPanelId,
  missingNativePanelIds
}
```

Wildcard compositions are already materialized backend-side by `web.view.get(...)`.
When a composition references a native panel that is missing from the active view `corePanels`,
`buildLayoutFromRegistry()` reports that through `missingNativePanelIds` and skips DOM rendering so
boot can surface a visible hard error instead of rendering a partial empty shell.

When a panel descriptor or resolved plugin panel carries `category`, the rendered tab anchor gets semantic
metadata:

```html
<a class="msghub-tab" data-msghub-panel-category="<category>">...</a>
```

The metadata is host-rendered only; CSS may use it for category-specific active-tab styling.

### `renderPanelBootError(panelId, err)`

Writes a visible error state directly into the affected panel container.

---

## Design notes / invariants

- `resolveViewRequest()` and the stored active view are shared between `layout.js`, `boot.js`, and `api.js`; visible layout and `api.host.*` must not drift.
- Plugin panel refs are never mixed into `panelIds`. Native and plugin panels follow different initialization paths.
- Plugin tabs render in a disabled placeholder state until backend-resolved plugin panel hydration confirms availability.
- `activatePanel(...)` is the shared activation path for both `tabs` and `single` layouts.
- `initTabs()` skips disabled tabs when resolving the initial active panel from hash, markup, and fallback defaults.
- `document.title` is derived from the active panel via its `PanelDescriptor.label` resolved through `t(...)`. Format: `'<label> - MessageHub'`.
- `applyAppHeadMeta` / `resetAppHeadMeta` manage four head meta tags (`theme-color`, `application-name`, `apple-mobile-web-app-title`, `apple-mobile-web-app-capable`) plus the managed links `rel="manifest"` and `rel="apple-touch-icon"`. Managed object URLs are revoked on cleanup.
- `generateManifest(descriptor, resolvedIcons)` is data-driven and panel-generic. It reads only `descriptor.app` plus the pre-resolved icon payloads, resolves manifest `start_url` / `id` from the current shell entry URL (`origin + pathname`) plus the host-neutral `app.url` target, and contains no pilot-specific branch for `messages` or `presets`.
- Runtime panel ids (`tab-...`) are never used as icon directory names. Core icon paths are always built from the owner-local panel key, and manifest icons are emitted as runtime-loadable URLs rather than runtime-id-derived paths or inline data URIs.
- `panelDescriptors` is a module-private `Map<tabId, PanelDescriptor>`. It is not a global; `const` at script top-level does not become `window.*`.
- `normalizeCorePanel` is layout-internal and not a global. Only `normalizePluginPanel`, `registerPanelDescriptor` are exposed as globals (implicit via top-level function declarations).
- `t` is provided by `runtime.js` (loaded before `layout.js`). Hard-migrated panel/app metadata in the shell path are resolved key-strict through `t(...)`; `layout.js` intentionally does not bridge legacy language maps there.
- `loadCssFiles()` deduplicates URLs and reports failures instead of throwing.
- `loadJsFilesSequential()` preserves script order and throws on the first failed script, because many panel files depend on earlier globals.
- Theme syncing is intentionally redundant: message, storage, polling, and mutation observation all feed the same final theme setter.
- `urlThemeLocked` is runtime-owned internal coordination state. `layout.js` consumes it, but it is not a public native-panel or plugin-facing API.

---

## Related files

- Implementation: [`admin/tab/layout.js`](../../admin/tab/layout.js)
- Test: [`admin/tab/layout.test.js`](../../admin/tab/layout.test.js)
- Backend view input: [`./API.md`](./API.md)
- Runtime query/theme helpers: [`./tab-runtime.md`](./tab-runtime.md)
- API host metadata consumer: [`./tab-api.md`](./tab-api.md)
- Boot orchestration: [`./tab-boot.md`](./tab-boot.md)
- URL guide: [`./url-parameters.md`](./url-parameters.md)
- Shell HTML host: [`admin/tab.html`](../../admin/tab.html)
