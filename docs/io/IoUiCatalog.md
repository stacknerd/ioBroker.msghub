# IoUiCatalog (Message Hub IO): backend view resolver for `web.view.get`

`IoUiCatalog` is the backend resolver that turns a normalized shell-view request into the canonical view payload consumed by browser hosts.
It sits between the static `IoUiRegistry` data and the web-safe command facade in `IoWebUi`.

In short:

- `IoUiCatalog` validates `web.view.get` requests.
- `IoUiCatalog` resolves composition views from the backend-owned registry.
- `IoUiCatalog` builds synthetic single-panel compositions for `panel=` requests.

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
6. Keeping plugin-owned Admin-UI i18n out of the `web.view.get` payload.
7. Rejecting invalid requests with stable `BAD_REQUEST` semantics.

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

### Output

`getView(...)` returns:

```js
{ composition, corePanels, pluginPanels, request }
```

Where:

- `composition` is either a registry composition or a synthetic single composition
- `corePanels` contains only resolved native/core panel definitions
- `pluginPanels` contains only resolved plugin-owned panel definitions keyed by canonical runtime panel id
- plugin-owned Admin-UI i18n is intentionally absent from `pluginPanels[*]`
- `request` is the normalized request object that was actually resolved

### Validation rules

- `mode` must be `'composition'` or `'panel'`
- `composition` mode defaults to `adminTab` when `targetId` is omitted
- unknown composition ids are rejected with `BAD_REQUEST`
- `panel` mode requires `targetId`
- `panel` mode validates only the formal `tab-...` shape, not runtime availability

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

### 5) Formal validation only for `panel=`

Panel mode validates syntax, not runtime existence.
That keeps `IoUiCatalog` focused on view resolution rather than plugin/runtime liveness.

---

## Response and error semantics

Successful resolution returns the normalized view payload directly to the caller.

Validation failures use `BAD_REQUEST`, for example:

- invalid `mode`
- unknown composition id
- missing `targetId` in panel mode
- invalid `panel` target syntax

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
- `BAD_REQUEST` mapping for invalid requests

---

## Related files

- implementation: `lib/IoUiCatalog.js`
- registry input: `lib/IoUiRegistry.js` / `docs/io/IoUiRegistry.md`
- web-safe command facade: `lib/IoWebUi.js` / `docs/io/IoWebUi.md`
- UI-facing view contract: `docs/ui/API.md`
- IO overview: `docs/io/README.md`
