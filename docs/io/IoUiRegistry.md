# IoUiRegistry (Message Hub IO): backend-owned shell metadata registry

`IoUiRegistry` is the backend-owned registry for the native AdminTab/Web-UI shell metadata.
It does not resolve requests by itself.
Its job is to hold the canonical static truth for:

- core/native panels
- shell compositions
- the special prepared web-root composition metadata

In short:

- `IoUiRegistry` is the backend single source of truth for shell metadata.
- `IoUiRegistry` contains only core panel metadata plus structured plugin refs.
- `IoUiRegistry` does not mirror plugin-owned panel metadata into the backend registry.

---

## Why this file exists

Before the refactor, the browser shell owned its own registry view of the available panels and compositions.
That caused two problems:

- the shell metadata source was frontend-local instead of backend-owned
- future non-admin consumers would need to reconstruct the same truth again

`IoUiRegistry` centralizes that static metadata in one backend-owned module so `web.view.get` can resolve a stable view contract from one place.

---

## System role

Simple flow:

1. `IoUiRegistry` defines the canonical `panels` and `compositions` objects.
2. `IoUiCatalog` consumes that registry to resolve `web.view.get`.
3. `IoWebUi` exposes that resolved payload as the web-safe backend command.
4. Browser hosts consume only the resolved view payload, not the registry module directly.

References:

- registry data: `lib/IoUiRegistry.js`
- resolver: `lib/IoUiCatalog.js`
- web-safe command facade: `lib/IoWebUi.js`

---

## Responsibilities

`IoUiRegistry` is responsible for:

1. Defining the canonical native/core panel metadata.
2. Defining the canonical shell composition metadata.
3. Keeping plugin-owned panels represented only as structured composition refs.
4. Holding the current core-owned app/install metadata for native panels and the prepared web-root composition.

---

## Non-responsibilities

`IoUiRegistry` is explicitly **not** responsible for:

1. Request validation for `web.view.get`.
2. Building synthetic single-panel compositions.
3. Runtime/plugin availability checks.
4. Frontend `PanelDescriptor` shaping.
5. Plugin discovery, bundle loading, or plugin-owned UI metadata transport.

Those responsibilities belong to `IoUiCatalog`, `IoWebUi`, and the browser shell.

---

## Authoritative registry contract

### Root shape

`IoUiRegistry` exports:

```js
{ panels, compositions }
```

### `panels`

`panels` contains only native/core panel definitions.

Current entries:

- `messages`
- `plugins`

Each entry may carry:

- `id` — owner-local panel id
- `label` — i18n key string
- `category`
- optional `app`

Core panel entries intentionally do **not** carry frontend execution metadata anymore.
The Admin Tab host resolves core-panel startup exclusively through the conventional host-owned
entry path `admin/tab/panels/<panelId>/entry.js`.

### `compositions`

`compositions` contains shell layout definitions.

Current entries:

- `adminTab`
- `full`
- `web`
- `messagesSingle`

Each composition carries:

- `id`
- `layout`
- `panels`
- `defaultPanel`
- `deviceMode`
- optional `app` only where explicitly intended (`web`)

Panel membership rules:

- structured `{ type: 'corePanel', panelId }` refs reference core/native panels from `panels`
- structured `{ type: 'pluginPanel', ... }` refs reference plugin-owned panels without mirroring their metadata
- `'*'` is the wildcard sentinel for all core/native panels

---

## Design invariants

### 1) Backend-owned metadata only

The registry is backend-owned and static.
Browser hosts must not treat it as a direct runtime API.
They consume the resolved `web.view.get` payload instead.

### 2) Core panels only in `panels`

`panels` is intentionally limited to native/core panels.
Plugin-owned labels, descriptions, bundle data, and plugin-owned `app` metadata are not copied here.

### 3) Plugin panels stay plugin-owned

Compositions may reference plugin panels, but only by structured ref:

```js
{ type: 'pluginPanel', pluginType, instanceId, panelId }
```

That preserves ownership boundaries and avoids a second backend mirror of plugin-owned UI metadata.

### 4) No request semantics in the registry

The registry is pure metadata.
Rules such as default-composition selection, `panel=` normalization, and synthetic single compositions belong to `IoUiCatalog`, not to this file.

### 5) Core bootstrap is host-owned, not registry-owned

The registry now carries only panel metadata that belongs to the backend view contract:

- owner-local panel identity
- translated label keys
- semantic category
- optional app/install metadata

Executable frontend bootstrap details are intentionally absent. Core panel asset lists and
`panelInit(ctx)` live in the host-owned `entry.js` files under `admin/tab/panels/<panelId>/`.

---

## Test coverage (relevant files)

- `lib/IoUiRegistry.test.js`
- `lib/IoUiCatalog.test.js`
- `lib/IoWebUi.test.js`

Covered areas include:

- static registry shape for core panels and compositions
- wildcard/core-panel extraction through the catalog
- synthetic single-panel resolution through `web.view.get`

---

## Related files

- implementation: `lib/IoUiRegistry.js`
- resolver: `lib/IoUiCatalog.js` / `docs/io/IoUiCatalog.md`
- web-safe command facade: `lib/IoWebUi.js` / `docs/io/IoWebUi.md`
- UI-facing view contract: `docs/ui/API.md`
- IO overview: `docs/io/README.md`
