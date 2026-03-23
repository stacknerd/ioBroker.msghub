# admin/tab/api.js: stable browser-side facade for backend and shell services

`api.js` builds the `ctx.api` object that native panels and plugin bundles use to talk to the rest
of the system.

Its job is not to own business logic.
Its job is to present a small, consistent, browser-friendly contract on top of:

- `msghubRequest(...)`
- shell UI primitives
- registry-derived host metadata
- i18n and time-format helpers

In practice, this is the intended panel-facing contract of the shell, but for native panels it is not a
hard technical barrier: `boot.js` still passes `msghubRequest` and `msghubSocket` directly inside `ctx`.
The stricter technical boundary exists only for plugin bundles, which receive a narrowed host API through
[`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md).

---

## Where it sits in the system

`createAdminApi(...)` is called by [`./tab-boot.md`](./tab-boot.md) during shell startup.
The returned object becomes part of the frozen panel context:

```js
ctx.api
```

Native panels use it directly.
Plugin-owned bundles receive a narrowed wrapper of it through [`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md).

---

## Responsibilities

### 1) Build the stable `ctx.api` contract

The returned API currently exposes these groups:

- `i18n`
- `ui`
- `log`
- `host`
- `constants`
- `runtime`
- `time`
- `stats`
- `messages`
- `plugins`
- `notSupported`

This is the main panel-facing contract of the shell.

### 2) Hide transport details behind named operations

Instead of letting panels call arbitrary `sendTo` commands, `api.js` maps explicit methods to backend commands:

- `stats.get(...)` -> `admin.stats.get`
- `messages.query(...)` -> `admin.messages.query`
- `messages.delete(...)` -> `admin.messages.delete`
- `messages.executeAction(...)` -> `admin.messages.action`
- `plugins.getCatalog()` -> `admin.plugins.getCatalog`
- `plugins.listInstances()` -> `admin.plugins.listInstances`
- `plugins.createInstance(...)` -> `admin.plugins.createInstance`
- `plugins.updateInstance(...)` -> `admin.plugins.updateInstance`
- `plugins.setEnabled(...)` -> `admin.plugins.setEnabled`
- `plugins.deleteInstance(...)` -> `admin.plugins.deleteInstance`
- `runtime.about()` -> `runtime.about`

### 3) Provide UI-safe helper behavior

`api.js` also owns several browser-facing helpers:

- `createAsyncCache(...)` for cached async reads
- `computeContextMenuPosition(...)` for viewport-aware menu positioning
- `toContextMenuIconVar(...)` for safe icon CSS variable lookup
- recursive context-menu item wrapping that closes the menu before running an action
- timezone policy normalization and timestamp formatting

These helpers are not business features by themselves, but they keep panel code simpler and more consistent.

---

## Public surface / integration points

## `createAdminApi({ ...deps })`

This is the main entrypoint.
It receives runtime dependencies from `boot.js` and returns a frozen API object.

### `api.i18n`

Browser-side translation helpers:

- `lang()`
- `has(key)`
- `t(key, ...args)`
- `tOr(key, fallback, ...args)`
- `pickText(value)`

### `api.ui`

A panel-safe wrapper around the shared UI primitives from [`./tab-ui.md`](./tab-ui.md):

- `toast(...)`
- `toastClose(id)`
- `contextMenu.open(...)`
- `contextMenu.close()`
- `contextMenu.isOpen()`
- `overlayLarge`
- `dialog`
- `spinner`
- `closeAll()`

The spinner wrapper adds a default translated message when the caller does not provide one.

### `api.host`

Composition and connection metadata:

- `viewId`
- `layout`
- `deviceMode`
- `panels`
- `defaultPanel`
- `adapterInstance`
- `isConnected()`

Important: `host.panels` contains only native panel string IDs.
Structured plugin panel refs are filtered out.

### `api.constants`

Cached access to `admin.constants.get`.
The cache is explicit and manually invalidatable.

### `api.time`

Shell-side formatting based on the current timezone policy:

- `getPolicy()`
- `setPolicy(policy)`
- `formatTs(ts, options)`
- `formatDate(date, options)`

### `api.notSupported(method)`

Throws a typed `NotSupportedError` with code `NOT_SUPPORTED`.
This is used for API branches that are intentionally unavailable in the current shell.

---

## Design notes / invariants

- Native panels are expected by convention and governance to use `ctx.api`, but the current code still exposes raw `msghubRequest(...)` and `msghubSocket` in `ctx`.
- Plugin bundles have the stronger technical boundary: they receive only the narrowed host API built by [`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md).
- `createAsyncCache(...)` does not poison the cache on failure. Failed fetches can be retried later.
- Timezone policy is normalized centrally. Missing or invalid timezones become a UTC fallback policy.
- Context-menu item handlers are wrapped recursively so the menu closes first, including nested submenu items.
- The context-menu wrapper intentionally does not emit generic fallback toasts when an action rejects. Error handling stays with the caller.
- `host.panels` is derived from the active composition but keeps only string entries, because structured plugin refs are hosted differently.

---

## Related files

- Implementation: [`admin/tab/api.js`](../../admin/tab/api.js)
- Test: [`admin/tab/api.test.js`](../../admin/tab/api.test.js)
- Runtime transport and i18n/theme state: [`./tab-runtime.md`](./tab-runtime.md)
- Boot integration: [`./tab-boot.md`](./tab-boot.md)
- Shared UI primitives: [`./tab-ui.md`](./tab-ui.md)
- Plugin wrapper that narrows this API for bundles: [`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md)
