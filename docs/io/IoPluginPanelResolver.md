# IoPluginPanelResolver (Message Hub IO): canonical runtime resolver for plugin-owned panels

`IoPluginPanelResolver` is the backend-internal runtime resolver for plugin-owned panels.
It does not own a command namespace itself.

In short:

- `IoPluginPanelResolver` is the single canonical lookup path for running plugin-owned panels.
- `IoPluginPanelResolver` translates raw `IoPlugins` Admin-UI contributions into a host-safe runtime DTO.
- `IoPluginPanelResolver` is shared by `web.view.get`, `web.pluginUi.bundle.get`, and `web.pluginUi.rpc`.

---

## Why this file exists

Without `IoPluginPanelResolver`, plugin-owned panel lookup would remain scattered across multiple backend paths.
That causes:

- duplicated lookup logic,
- duplicated runtime validation,
- drift risk between view assembly, bundle validation, and RPC validation.

`IoPluginPanelResolver` centralizes that runtime lookup in one file with a stable internal contract and explicit scope boundaries.

---

## System role

Simple flow:

1. A backend consumer needs to resolve a running plugin-owned panel.
2. That consumer calls one of the resolver entry points on `IoPluginPanelResolver`.
3. `IoPluginPanelResolver` reads raw runtime/package information from `IoPlugins`.
4. `IoPluginPanelResolver` returns a host-safe runtime DTO keyed by canonical runtime panel ids such as `plugin-IngestStates-0-presets`.

Current backend consumers:

- `IoUiCatalog` for `web.view.get`
- `IoWebUi` for `web.pluginUi.bundle.get` validation
- `IoPluginUiRpc` for `web.pluginUi.rpc` validation

References:

- runtime/package source: `lib/IoPlugins.js`
- view assembler: `lib/IoUiCatalog.js`
- web facade: `lib/IoWebUi.js`
- RPC dispatcher: `lib/IoPluginUiRpc.js`

---

## Responsibilities

`IoPluginPanelResolver` is responsible for:

1. Resolving currently running plugin-owned panels from `IoPlugins`.
2. Resolving plugin-owned panels by:
   - canonical runtime panel id
   - structured runtime ref `{ pluginType, instanceId, panelId }`
3. Computing the advisory bundle hash through `IoPlugins.computeAdminUiBundleHash(...)`.
4. Returning one canonical host-safe runtime DTO for plugin-owned panels.
5. Soft-degrading hash enrichment failures to an empty hash with warning logs.

---

## Non-responsibilities

`IoPluginPanelResolver` is explicitly **not** responsible for:

1. Public command ownership (`web.*`, `admin.*`).
2. Browser/frontend view assembly.
3. Bundle file transport or JS/CSS reads.
4. Plugin UI RPC dispatch.
5. Exposing plugin package paths or bundle entry paths in its DTO.

Those responsibilities belong to `IoWebUi`, `IoUiCatalog`, `IoPluginUiRpc`, and `IoPlugins`.

---

## Authoritative internal contract

### Construction

### `new IoPluginPanelResolver({ ioPlugins?, log? })`

Creates the resolver.

Relevant dependency:

- `ioPlugins` — runtime/package source used for raw Admin-UI contributions and bundle hashes
- `log` — small optional warn-capable log port used only for soft-degradation logging

### Readiness

### `isReady()`

Returns whether the required runtime functions are wired:

- `getAdminUiContributions()`
- `computeAdminUiBundleHash(...)`

### Lookup methods

### `getPanelsByRuntimeId()`

Returns resolved panel DTOs keyed by canonical runtime panel id.

### `getPanelByRuntimeId({ runtimePanelId })`

Resolves one panel by runtime id such as:

- `plugin-IngestStates-0-presets`

Returns `null` for syntactically invalid or currently unavailable runtime ids.

### `getPanelByRef({ pluginType, instanceId, panelId })`

Resolves one panel by structured runtime ref.

Returns `null` when the panel is not currently running.

---

## Resolved DTO shape

Each resolved plugin-owned panel follows this internal runtime DTO:

```js
{
  id,
  pluginType,
  instanceId,
  panelId,
  label,
  description,
  category?,
  ui: {
    kind: 'plugin',
    loader: 'esm',
    apiVersion,
    bundle: {
      hash,
    }
  },
  app?,
}
```

Important details:

- `id` is the canonical runtime panel id without the `tab-` prefix.
- `label` and `description` remain plugin-owned shell metadata.
- `ui.bundle.hash` is advisory and may be `''` on soft failure.
- no bundle entry path is exposed here.

---

## Response and error semantics

Successful resolution returns runtime DTOs directly to the caller.

Typical resolver behavior:

- missing runtime wiring -> throws `NOT_READY`
- invalid runtime panel id syntax -> returns `null`
- unavailable runtime panel -> returns `null`
- bundle hash read failure -> logs warning, returns `hash: ''`

---

## Guardrails

1. One canonical plugin-panel lookup path only.
2. Resolver DTO is host-safe: no packageRoot or bundle.entry leakage.
3. Resolver is read-only: it never mutates runtime state.
4. `web.view.get`, `web.pluginUi.bundle.get`, and `web.pluginUi.rpc` must all validate against this resolver instead of building parallel lookup paths.
5. Plugin-owned Admin-UI i18n is intentionally out of scope here and stays on the `web.pluginUi.bundle.get` path.

---

## Test coverage (relevant files)

- `lib/IoPluginPanelResolver.test.js`
- `lib/IoUiCatalog.test.js`
- `lib/IoWebUi.test.js`
- `lib/IoPluginUiRpc.test.js`

Covered areas include:

- keyed lookup behavior
- runtime-id lookup behavior
- `NOT_READY` handling
- integration of the resolver into view, bundle, and RPC paths

---

## Related files

- implementation: `lib/IoPluginPanelResolver.js`
- tests: `lib/IoPluginPanelResolver.test.js`
- runtime source: `lib/IoPlugins.js`
- view assembler: `lib/IoUiCatalog.js`
- web facade: `lib/IoWebUi.js`
- RPC dispatcher: `lib/IoPluginUiRpc.js`
- IO overview: `docs/io/README.md`
