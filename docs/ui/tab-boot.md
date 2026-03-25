# admin/tab/boot.js: bootstrap and runtime orchestration for the Admin Tab

`boot.js` is the operational center of the browser-side Admin Tab.
It creates the shared runtime objects, builds the visible composition, initializes native panels,
hydrates plugin panel slots, and keeps the shell in sync with connection and runtime metadata.

If [`./tab.md`](./tab.md) is the page entry marker, `boot.js` is the file that turns the loaded
assets into a working UI.

---

## Where it sits in the system

`boot.js` is loaded near the end of [`admin/tab.html`](../../admin/tab.html), after:

- [`./tab-globals.md`](./tab-globals.md)
- [`./tab-registry.md`](./tab-registry.md)
- [`./tab-api.md`](./tab-api.md)
- [`./tab-runtime.md`](./tab-runtime.md)
- [`./tab-ui.md`](./tab-ui.md)
- [`./tab-layout.md`](./tab-layout.md)
- [`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md)

That load order matters because `boot.js` consumes the globals and factory functions created by those
modules and then starts the actual runtime on `DOMContentLoaded`.

---

## What the boot flow does

The shell startup is roughly:

1. Create `ui` via `createUi()`.
2. Create `api` via `createAdminApi(...)`.
3. Build the frozen panel context `ctx`.
4. Fetch `runtime.about` to update branding, timezone policy, and cached connection metadata.
5. On `DOMContentLoaded`, run `ensureBooted()`.
6. Build the current layout from the registry.
7. Load composition CSS, initialize tab navigation, and initialize native panels.
8. Discover matching plugin panel contributions and enable their tab slots.
9. Register lazy-mount handling for later plugin-tab switches.
10. Keep connection state current via ping, socket reconnect handling, and reconnect warmup.

Important: the current code does **not** mount the first plugin tab automatically activated during boot.
`tabSetActive(...)` for the first plugin tab can happen before the `msghub:tabSwitch` listener is registered,
and in the plugin-only case the first activation does not dispatch `msghub:tabSwitch` at all because there is
no previous active tab yet.

---

## Responsibilities

### 1) Build the shared runtime context for panels

`boot.js` constructs the objects that all native panels receive:

```js
const ctx = Object.freeze({
  args,
  adapterInstance,
  msghubSocket,
  msghubRequest,
  api,
  h,
  ui,
  lang,
  elements,
});
```

Important: panels are expected to work against this frozen `ctx`, not against ad-hoc globals.

### 2) Resolve runtime metadata that affects the whole shell

`applyRuntimeAboutPayload()` and `refreshRuntimeAbout()` update shell-wide state from `runtime.about`:

- context-menu branding text
- timezone formatting policy
- cached connection panel metadata
- embedded-admin language override via `backendTextLanguage` when the tab is actually embedded in the admin host (`isEmbeddedInAdmin`)

If the backend does not provide a valid timezone, the shell falls back to UTC and shows a warning toast once.

### 3) Initialize native panels from the registry

For each native panel ID in the active composition, `boot.js`:

1. looks up the panel definition in the registry
2. loads the panel JavaScript assets in the configured order
3. finds `window[initGlobal]`
4. calls `window[initGlobal].init(ctx)`

The returned panel handle is stored in `panelSections`.
If the handle exposes `onConnect()`, `boot.js` can call it in three different situations:

1. immediately after `init(ctx)` during initial panel setup, when `msghubSocket.connected` is already `true`
2. from `onBecomeOnline()` after a successful ping transitioned the shell from offline to online
3. from `triggerWarmupReconnect()` after reconnect warmup succeeded and `api.constants.get()` became available again

Because `onBecomeOnline()` also starts `triggerWarmupReconnect()`, reconnect handling can produce two `onConnect()`
passes for the same panel.

### 4) Hydrate plugin panel tab slots

Structured plugin panel refs from the composition are not active immediately.
`hydratePluginPanels()` matches them against `admin.pluginUi.discover` results, then:

- enables the matching tab
- replaces the temporary loading label with the discovered title
- stores the mount metadata in `pluginPanelTabMap`

Actual plugin bundle mounting is deferred until the tab becomes active.
More precisely: the current implementation mounts a plugin panel only on a later `msghub:tabSwitch` event that is
observed **after** the listener was registered. The first plugin tab selected automatically during boot can miss
that path in both of these current scenarios:

- plugin-only composition: `tabSetActive(...)` runs while no previous tab is active, so `initTabs()` does not dispatch `msghub:tabSwitch`
- mixed composition with a plugin `defaultPanel`: the switch event is dispatched, but it happens before `boot.js` registers the listener

### 5) Own connection and health-state behavior for the shell

`boot.js` is also responsible for shell-level connection UX:

- online/offline classes on the connection bar
- connection info panel contents
- disconnect/reconnect toasts
- periodic `admin.ping`
- reconnect warmup that waits until `api.constants.get()` succeeds again

The UI is treated as online only after a successful ping, not just after a transport-level socket reconnect.

### 6) Provide the global editable-field context menu

Inside `.msghub-root`, `boot.js` replaces the browser context menu with the shell menu from [`./tab-ui.md`](./tab-ui.md).
For text-like inputs, textareas, and `contenteditable` elements it adds standard actions:

- Cut
- Copy
- Paste
- Select all

`Ctrl` + right-click intentionally bypasses the custom menu and leaves the native browser menu available.

---

## Public surface / integration points

`boot.js` does not export a public module object, but it defines the runtime contracts that the rest of the UI relies on.

### Panel initialization contract

Each native panel definition in the registry names an `initGlobal`, for example:

```js
window.MsghubAdminTabMessages.init(ctx)
```

The `init(ctx)` call may return a section handle with optional lifecycle hooks such as `onConnect()`.

### Shared `ctx` contract

Panels receive:

- transport handles: `msghubRequest`, `msghubSocket`
- the facade API: `api`
- the DOM helper: `h`
- shared UI primitives: `ui`
- selected shell elements: `elements`
- adapter and query metadata

### Shell events

`boot.js` listens to:

- `DOMContentLoaded`
- `contextmenu`
- socket `connect`
- socket `disconnect`
- periodic ping timers
- `msghub:tabSwitch` for later plugin-panel lazy mounting

It also triggers an unconditional initial `sendPing()` during module load, before any socket event arrives.

---

## Design notes / invariants

- `ensureBooted()` is idempotent. A cached `bootPromise` prevents duplicate boot sequences.
- Plugin tabs start disabled. They are enabled only when a matching discover contribution and DOM mount container both exist.
- `ctx` is frozen before it is handed to panels. Panels should treat it as read-only runtime state.
- `ctx.elements` exposes getters for `connection`, `pluginsRoot`, `messagesRoot`, and `statsRoot`. In the current shell, `statsRoot` has no matching mount point in [`admin/tab.html`](../../admin/tab.html) and currently resolves to `null`.
- Transport reconnect is not treated as sufficient proof of health. The shell waits for a successful ping before switching to online UX.
- Reconnect warmup is centralized here. Panels are not expected to implement their own retry loop for core shell availability.
- `pickText()` is the shell-side text normalizer for plain strings, admin i18n keys, and language maps such as `{ en, de }`.
- Shell-wide timezone fallback warning is intentionally shown only once per page lifetime.
- The connection panel reports the effective frontend format locale shown to the shell. When `args.locale` is present and valid, that value is shown instead of the old ambient browser-locale source.

---

## Related files

- Implementation: [`admin/tab/boot.js`](../../admin/tab/boot.js)
- Test: [`admin/tab/boot.test.js`](../../admin/tab/boot.test.js)
- Registry source of truth: [`./tab-registry.md`](./tab-registry.md)
- Layout builder: [`./tab-layout.md`](./tab-layout.md)
- Runtime globals and i18n/theme handling: [`./tab-runtime.md`](./tab-runtime.md)
- Shared shell API: [`./tab-api.md`](./tab-api.md)
- UI primitives: [`./tab-ui.md`](./tab-ui.md)
- Plugin bundle host: [`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md)
