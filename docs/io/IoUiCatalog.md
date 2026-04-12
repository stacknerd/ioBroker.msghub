# IoUiCatalog (Message Hub IO): backend view and app resolver

`IoUiCatalog` is the backend resolver that turns a normalized shell-view request into the canonical view payload consumed by browser hosts.
It sits between the static `IoUiRegistry` data and the web-safe command facade in `IoWebUi`.

In short:

- `IoUiCatalog` validates `web.view.get` requests.
- `IoUiCatalog` resolves composition views from the backend-owned registry.
- `IoUiCatalog` builds synthetic single-panel compositions for `panel=` requests.
- `IoUiCatalog` resolves panel-app entries for panel-only consumers through `getApp(...)`.
- `IoUiCatalog` owns the effective app-icon normalization for both `getView(...)` and `getApp(...)`.

---

## Why this file exists

The shell needs one neutral backend endpoint that can answer both:

- composition-based requests
- single-panel requests

That resolution logic should not live:

- in the browser shell
- in the static registry module
- or inline inside the command facade

`IoUiCatalog` exists to keep that logic in one backend-owned place with a small, explicit contract.

---

## System role

Simple flow:

1. A host requests `web.view.get`.
2. `IoWebUi` delegates the business resolution to `IoUiCatalog.getView(...)`.
3. `IoUiCatalog` validates the request against `IoUiRegistry`.
4. `IoUiCatalog` returns `{ composition, corePanels, pluginPanels, request }`.
5. Internal host helpers may call `IoUiCatalog.getApp(...)` for strict panel-app resolution.

References:

- registry input: `lib/IoUiRegistry.js`
- command facade: `lib/IoWebUi.js`
- UI-facing contract: `docs/ui/API.md`

---

## Responsibilities

`IoUiCatalog` is responsible for:

1. Validating the normalized `web.view.get` request shape.
2. Resolving composition requests against the backend-owned registry.
3. Materializing wildcard compositions backend-side.
4. Resolving plugin-owned panels through the canonical backend resolver.
5. Returning the split view payload `{ composition, corePanels, pluginPanels, request }`.
6. Returning strict panel-app entries through `getApp(...)` without introducing a parallel DTO family.
7. Resolving the effective app-icon slots in one backend-owned place for both `getView(...)` and `getApp(...)`.
8. Keeping plugin-owned Admin-UI i18n out of the `web.view.get` payload.
9. Rejecting invalid requests with stable `BAD_REQUEST` semantics.

---

## Non-responsibilities

`IoUiCatalog` is explicitly **not** responsible for:

1. Transport/envelope handling for backend commands.
2. Token validation.
3. Bundle-file reads or plugin RPC dispatch.
4. Maintaining a second plugin lookup or validation path outside the canonical resolver.
5. Browser-specific shell behavior, DOM state, or asset loading.

Those concerns belong to `IoWebUi`, plugin runtime paths, and the browser shell.

---

## Authoritative contract

### Input

`IoUiCatalog.getView(request)` accepts the normalized `web.view.get` payload:

```js
{ mode, targetId? }
```

Supported modes:

- `composition`
- `panel`

`IoUiCatalog.getApp(request)` accepts only:

```js
{ mode: 'panel', targetId: 'tab-...' }
```

`composition` mode is rejected for `getApp(...)`.

### Output

`getView(...)` returns:

```js
{ composition, corePanels, pluginPanels, request }
```

Where:

- `composition` is either a registry composition or a synthetic single composition
- `corePanels` contains only resolved native/core panel definitions
- `pluginPanels` contains only resolved plugin-owned panel definitions keyed by canonical runtime panel id
- `corePanels[*].resolvedAppIcons` and `pluginPanels[*].resolvedAppIcons` expose the effective host-relative icon slots resolved by `IoUiCatalog`
- plugin-owned Admin-UI i18n is intentionally absent from `pluginPanels[*]`
- `request` is the normalized request object that was actually resolved

`getApp(...)` returns:

```js
(CorePanelEntry | ResolvedPluginPanelEntry) & {
  resolvedAppIcons: {
    any192?: string,
    any512?: string,
    maskable192?: string,
    maskable512?: string,
    apple180?: string,
  }
} | null
```

The returned object stays panel-centric:

- core case: existing core panel entry plus `resolvedAppIcons`
- plugin case: existing resolved plugin panel entry plus `resolvedAppIcons`
- no wrapper DTO and no parallel app-target contract

### Validation rules

- `mode` must be `'composition'` or `'panel'`
- `composition` mode defaults to `adminTab` when `targetId` is omitted
- unknown composition ids are rejected with `BAD_REQUEST`
- `panel` mode requires `targetId`
- `panel` mode validates only the formal `tab-...` shape, not runtime availability
- `getApp(...)` accepts only `mode: 'panel'`
- `getApp(...)` rejects empty requests, missing `targetId`, non-canonical targets, and `composition` mode with `BAD_REQUEST`

---

## Resolution behavior

### Composition mode

For:

```js
{ mode: 'composition', targetId? }
```

`IoUiCatalog`:

1. picks `targetId` or the default composition `adminTab`
2. loads the matching composition from `IoUiRegistry.compositions`
3. materializes wildcard compositions so the frontend never receives `['*']`
4. extracts referenced core/native panels into `corePanels`
5. resolves referenced plugin panels into `pluginPanels` through the canonical runtime resolver

Wildcard behavior:

- `panels: ['*']` expands to every core/native panel from `IoUiRegistry.panels`
- expanded core panels become `{ type: 'corePanel', panelId }`
- currently running plugin panels are appended as structured plugin refs

### Panel mode

For:

```js
{ mode: 'panel', targetId: 'tab-...' }
```

`IoUiCatalog`:

1. parses the canonical `tab-...` target
2. builds a synthetic single composition with `layout: 'single'`
3. returns the matching core panel in `corePanels`, or an empty `corePanels` map for plugin-panel targets
4. resolves `pluginPanels` only when the targeted plugin panel is currently available

Core-panel targets become:

- `panels: [{ type: 'corePanel', panelId: 'messages' }]`
- `defaultPanel: 'messages'`

Plugin-panel targets become:

- `panels: [{ type: 'pluginPanel', ... }]`
- `defaultPanel: 'plugin-<PluginType>-<instanceId>-<panelId>'`

That keeps plugin-owned metadata outside the backend registry and outside the `corePanels` map while still letting `web.view.get` carry resolved plugin panel shell metadata without becoming an i18n transport path.

### App resolution

For:

```js
{ mode: 'panel', targetId: 'tab-...' }
```

`IoUiCatalog.getApp(...)`:

1. validates the panel-only request strictly
2. parses the canonical `tab-...` target
3. resolves core panels directly from `IoUiRegistry.panels`
4. resolves plugin panels only through the canonical runtime resolver
5. returns `null` for unknown panels, unavailable plugin panels, or panels without a valid `app` block
6. returns the canonical panel entry enriched with `resolvedAppIcons`

Strict null/error behavior:

- invalid request shape -> `BAD_REQUEST`
- formally valid but unknown core panel -> `null`
- formally valid but currently unavailable plugin panel -> `null`
- panel without a valid `app` block -> `null`

### Effective app-icon policy

`IoUiCatalog` owns one effective icon truth for panel-app consumers.

Core panels:

- producer source remains `panel.app.icons`
- `IoUiCatalog` resolves those filenames to host-relative asset paths under `icons/<panelId>/...`

Plugin panels:

- plugin-owned `app.icons` are not part of the panel-app consumer contract here
- plugin-owned `app.icons` are stripped from the returned `app` payload
- `IoUiCatalog` always resolves plugin panel app icons to the fixed host set:
  - `icons/pluginUI/pluginUI-192.png`
  - `icons/pluginUI/pluginUI-512.png`
  - `icons/pluginUI/pluginUI-maskable-192.png`
  - `icons/pluginUI/pluginUI-maskable-512.png`
  - `icons/pluginUI/pluginUI-apple-180.png`

This normalization is shared by:

- `getView(...)` via `corePanels[*].resolvedAppIcons` / `pluginPanels[*].resolvedAppIcons`
- `getApp(...)` via the returned panel entry

---

## Design invariants

### 1) Registry-owned truth, catalog-owned resolution

`IoUiRegistry` owns the static metadata.
`IoUiCatalog` owns the request-dependent resolution logic.
Neither file should absorb the other's responsibility.

### 2) `corePanels` is native-only and `pluginPanels` is plugin-only

`corePanels` intentionally contains only native/core panel definitions.
`pluginPanels` intentionally contains only resolved plugin-owned panel definitions keyed by runtime panel id.

### 3) Synthetic panel compositions are shell-compatible

Single-panel requests are answered with a normal composition-shaped object so browser hosts can stay on one shared view contract instead of maintaining a separate frontend-only panel mode model.

### 4) One canonical plugin-panel resolver

Plugin-owned panels are resolved only through the shared backend resolver used by:

- `web.view.get`
- `web.pluginUi.bundle.get`
- `web.pluginUi.rpc`

### 5) App-icon normalization is catalog-owned

Effective app-icon slots are resolved in `IoUiCatalog`, not in a separate host-specific app helper.
Core and plugin panels therefore expose one backend-owned `resolvedAppIcons` policy.

### 6) Formal validation only for `panel=`

Panel mode validates syntax, not runtime existence.
That keeps `IoUiCatalog` focused on view resolution rather than plugin/runtime liveness.

---

## Response and error semantics

Successful resolution returns the normalized view payload directly to the caller.
Successful `getApp(...)` resolution returns the enriched panel entry directly to the caller.

Validation failures use `BAD_REQUEST`, for example:

- invalid `mode`
- unknown composition id
- missing `targetId` in panel mode
- invalid `panel` target syntax

For `getApp(...)`, formal validity and runtime/app availability stay separate:

- invalid request -> `BAD_REQUEST`
- valid panel target without a resolvable app entry -> `null`

The catalog raises those as structured errors and `IoWebUi` maps them into the standard web-safe backend envelope.

---

## Test coverage (relevant files)

- `lib/IoUiCatalog.test.js`
- `lib/IoWebUi.test.js`

Covered areas include:

- default composition resolution
- wildcard expansion
- panel-target parsing for core and plugin panels
- synthetic single-composition generation
- strict `getApp(...)` resolution for core and plugin panels
- effective icon normalization for core and plugin panels
- `null` semantics for unavailable or app-less panels
- `BAD_REQUEST` mapping for invalid requests

---

## Related files

- implementation: `lib/IoUiCatalog.js`
- registry input: `lib/IoUiRegistry.js` / `docs/io/IoUiRegistry.md`
- web-safe command facade: `lib/IoWebUi.js` / `docs/io/IoWebUi.md`
- UI-facing view contract: `docs/ui/API.md`
- IO overview: `docs/io/README.md`
