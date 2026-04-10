# admin/tab/api.js: stable browser-side facade for backend and shell services

`api.js` builds the `ctx.api` object that native panels and plugin bundles use to talk to the rest
of the system.

Its job is not to own business logic.
Its job is to present a small, consistent, browser-friendly contract on top of:

- `msghubRequest(...)`
- shell UI primitives
- view-derived host metadata
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

`api.js` depends on the shared active-view helpers from [`./tab-layout.md`](./tab-layout.md) so that
`api.host.viewId`, `api.host.layout`, `api.host.panels`, and the visible shell all reflect the same
loaded `web.view.get` result.

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

- `constants.get()` -> `web.constants.get`
- `stats.get(...)` -> `web.stats.get`
- `messages.query(...)` -> `web.messages.query`
- `messages.delete(...)` -> `admin.messages.delete`
- `messages.executeAction(...)` -> `web.messages.action`
- `plugins.getCatalog()` -> `admin.plugins.getCatalog`
- `plugins.listInstances()` -> `admin.plugins.listInstances`
- `plugins.createInstance(...)` -> `admin.plugins.createInstance`
- `plugins.updateInstance(...)` -> `admin.plugins.updateInstance`
- `plugins.setEnabled(...)` -> `admin.plugins.setEnabled`
- `plugins.deleteInstance(...)` -> `admin.plugins.deleteInstance`
- `runtime.about()` -> `ui.bootstrap` (returns only `.about`)

### 3) Provide UI-safe helper behavior

`api.js` also owns several browser-facing helpers:

- `createAsyncCache(...)` for cached async reads
- `computeContextMenuPosition(...)` for viewport-aware menu positioning
- `toContextMenuIconVar(...)` for safe icon CSS variable lookup
- recursive context-menu item wrapping that closes the menu before running an action
- timezone policy normalization and timestamp formatting

These helpers are not business features by themselves, but they keep panel code simpler and more consistent.

The time helpers now support one more browser-side input source:

- `options.locale` remains the strongest locale override for `formatTs(...)` / `formatDate(...)`
- otherwise a valid `args.locale` becomes the default frontend format locale
- missing or invalid `args.locale` keeps the previous ambient/browser default behavior

All privileged browser commands continue to go through the same `msghubRequest(...)` transport.
Token attachment is not implemented in `api.js` per method. It is owned centrally by
[`./tab-runtime.md`](./tab-runtime.md) for every `admin.*`, `config.*`, and `web.*` command.

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

Shell and connection metadata:

- `viewId`
- `layout`
- `deviceMode`
- `panels`
- `defaultPanel`
- `adapterInstance`
- `isConnected()`
- `isExpertMode()`

**`panel=` mode** (`?panel=<tab-id>` in the URL):

When `args.panel` is a non-empty string, `api.js` enters panel mode and bypasses composition
resolution entirely. The resulting `api.host` values differ from the normal composition-based values:

| Field | Panel mode | Normal composition mode |
|---|---|---|
| `host.viewId` | `null` | resolved view id (e.g. `'adminTab'`) |
| `host.layout` | `'single'` | composition `layout` field |
| `host.deviceMode` | `'pc'` | composition `deviceMode` field |
| `host.panels` | `[panelKey]` — single-element frozen array, where `panelKey = args.panel.slice('tab-'.length)` | panels from composition, strings only |
| `host.defaultPanel` | same `panelKey` | composition `defaultPanel` |

`panel=` takes precedence over `composition=`; both may appear in the URL, but `panel=` wins.

The `panelKey` derived here (e.g. `'messages'` from `?panel=tab-messages`) matches the owner-local
core-panel key used by the active composition and by the host-owned bootstrap convention
`loadCorePanelEntry(panelKey)`.

In normal (composition) mode:

- `host.panels` contains only string entries from `composition.panels`
- structured plugin panel refs are filtered out
- string sentinels such as `'*'` may still appear in wildcard compositions
- wildcard expansion remains a responsibility of [`./tab-layout.md`](./tab-layout.md), not `api.js`

`api.host.isExpertMode()` is a native-panel helper with additive semantics:

1. `args.expert === true` forces expert mode on
2. otherwise `sessionStorage['App.expertMode'] === 'true'`
3. otherwise `window._system.expertMode` or `window.top._system.expertMode`

`false` from the URL does not disable host expert mode.

### `api.constants`

Cached access to `web.constants.get`.
The cache is explicit and manually invalidatable.

### `api.time`

Shell-side formatting based on the current timezone policy:

- `getPolicy()`
- `setPolicy(policy)`
- `formatTs(ts, options)`
- `formatDate(date, options)`

`formatTs(...)` and `formatDate(...)` use locale precedence in this order:

1. explicit `options.locale`
2. valid `args.locale`
3. ambient/browser default locale

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
- In normal mode, `host.panels` is derived from the loaded active composition but keeps only string entries, because structured plugin refs are hosted differently. In `panel=` mode, `host.panels` is a single-element array derived from the active `web.view.get` request/response pair.
- `args.locale` affects only the browser-side default format locale for `api.time.*`; it does not change text language, i18n loading, plugin bundle language selection, or backend payloads.
- `runtime.about()` stays on the API surface, but its data comes from the central `ui.bootstrap` cache in `runtime.js`.

---

## Related files

- Implementation: [`admin/tab/api.js`](../../admin/tab/api.js)
- Test: [`admin/tab/api.test.js`](../../admin/tab/api.test.js)
- Runtime transport and i18n/theme state: [`./tab-runtime.md`](./tab-runtime.md)
- Shared resolver/layout metadata: [`./tab-layout.md`](./tab-layout.md)
- Boot integration: [`./tab-boot.md`](./tab-boot.md)
- Shared UI primitives: [`./tab-ui.md`](./tab-ui.md)
- Plugin wrapper that narrows this API for bundles: [`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md)
- UI API reference: [`./API.md`](./API.md)
