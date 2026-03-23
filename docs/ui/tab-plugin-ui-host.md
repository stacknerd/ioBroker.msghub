# admin/tab/plugin-ui-host.js: host for plugin-owned Admin UI bundles

`plugin-ui-host.js` mounts plugin-provided ESM bundles into shell-owned tab containers.
It is the bridge between the generic Admin Tab shell and plugin-specific browser UI code.

The host does not know plugin business rules.
Its job is to fetch, cache, mount, unmount, and retry plugin bundles in a controlled way.

---

## Where it sits in the system

The module is loaded before [`./tab-boot.md`](./tab-boot.md), but it becomes active only when `boot.js`
creates a host instance for plugin panel refs in the current composition.

That means the plugin UI path is:

1. [`./tab-registry.md`](./tab-registry.md) declares plugin panel slots
2. [`./tab-layout.md`](./tab-layout.md) renders disabled placeholder tabs and containers
3. [`./tab-boot.md`](./tab-boot.md) hydrates matching slots from discover data
4. `plugin-ui-host.js` mounts the actual bundle only when `boot.js` observes a later `msghub:tabSwitch` into that plugin tab

Important: with the current boot order, the first plugin tab activated automatically during boot can miss this path.
The host itself is correct, but `boot.js` currently registers the lazy-mount listener only after those early
`tabSetActive(...)` calls.

---

## Responsibilities

### 1) Fetch and cache plugin bundles

`loadBundle(...)` fetches bundle data through:

```js
admin.pluginUi.bundle.get
```

The cache key includes:

- `pluginType`
- `instanceId`
- `panelId`
- bundle `hash`
- active `lang`

If a matching cached entry already exists, the backend call is skipped.

### 2) Build the plugin mount context

Before calling `module.mount(ctx)`, the host constructs a frozen bundle context containing:

- `root`
- `plugin`
- `panel`
- `host`
- `dom.h`
- `api.request(...)`
- `api.i18n.t(...)`
- selected `api.ui` helpers

This gives the bundle a stable host contract without exposing the full shell internals.

### 3) Mount into Light DOM containers

Plugin panels are mounted into a normal `div` wrapper:

```html
<div class="msghub-plugin-ui-mount" ...>
```

There is no Shadow DOM.
Companion CSS is injected as a sibling `<style>` element inside the container.

That sibling placement is intentional: bundles are free to call `root.replaceChildren(...)`, so putting the
style tag into `ctx.root` would make plugin CSS disappear on the first render.

### 4) Merge plugin-owned UI translations before mount

If the bundle response contains `i18n.translations`, the host calls:

```js
mergePluginI18n(pluginType, translations)
```

The runtime layer then enforces namespace filtering and no-overwrite rules.

### 5) Unmount and retry safely

`unmount(handle)` calls `module.unmount(ctx)` when available, then clears the container.
`retry(handle)` removes all cached entries for that plugin panel, unmounts it, and re-mounts without a hash hint
so the backend is queried again.

---

## Public surface / integration points

The module exports one factory on `window`:

```js
window.createMsghubPluginUiHost
```

## `createMsghubPluginUiHost({ request, api, _importFn })`

Returns:

- `mount({ container, pluginType, instanceId, panelId, hash })`
- `unmount(handle)`
- `retry(handle)`

### `mount(...)`

Fetches/imports the bundle, injects the mount wrapper, merges i18n if present, and calls `module.mount(ctx)`.

The returned handle tracks:

- target container
- plugin identity
- mounted state
- mounted module/context

### `ctx.api.request(command, payload)`

Inside a plugin bundle, RPC calls are routed through:

```js
admin.pluginUi.rpc
```

The host wraps the result into a normalized plugin-facing envelope:

- `{ ok: true, data }`
- `{ ok: false, error: { message } }`

This is intentionally different from the raw `msghubRequest(...)` behavior used by the shell.

---

## Design notes / invariants

- Plugin UI uses Light DOM only. `ctx.root` is the render target; there is no `shadowRoot` contract.
- The bundle cache key includes the active language, because bundle responses may contain language-specific UI text.
- `mergePluginI18n(...)` is called only when `i18n.translations` is present in the bundle response.
- Error rendering is isolated:
  - bundle fetch/import failure renders an error directly in the panel container
  - `module.mount(...)` failure renders an error inside the created mount wrapper
- `retry(handle)` clears cache entries for that one panel identity only, not the entire bundle cache.
- The host narrows the shell API for bundles on purpose. Plugin UI gets what it needs, not unrestricted access to all shell internals.

---

## Related files

- Implementation: [`admin/tab/plugin-ui-host.js`](../../admin/tab/plugin-ui-host.js)
- Test: [`admin/tab/plugin-ui-host.test.js`](../../admin/tab/plugin-ui-host.test.js)
- Runtime i18n merge target: [`./tab-runtime.md`](./tab-runtime.md)
- Boot hydration and lazy-mount orchestration: [`./tab-boot.md`](./tab-boot.md)
- Layout-generated plugin containers: [`./tab-layout.md`](./tab-layout.md)
