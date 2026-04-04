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

`ensureBooted()` first checks `resolvePanelMode()`. If `args.panel` is set, it takes the
**Single-Panel-Mode path** and returns early — composition resolution, layout building, and
`msghub:tabSwitch` listener registration are all skipped. Otherwise it takes the normal
**composition path** described below.

### Single-Panel-Mode path (`args.panel` set)

1. Create `ui` via `createUi()`, `api` via `createAdminApi(...)`, and the frozen `ctx`.
2. `resolvePanelMode()` resolves the target panel descriptor (or returns an error result).
3. If the target is unresolvable: load i18n, render a hard error message, and stop.
4. For a **core panel** target: call `buildSinglePanelShell(descriptor)`, load i18n and CSS, activate the panel, and initialize native panel assets — no tab strip.
5. For a **plugin panel** target: load i18n, call `admin.pluginUi.discover({ lang })`, match the contribution, call `buildSinglePanelShell(descriptor)`, reuse `hydratePluginPanels` to populate `pluginPanelTabMap`, activate the panel, and mount the plugin bundle immediately.
6. Keep connection state current (same as the composition path).

No `msghub:tabSwitch` listener is registered in Single-Panel-Mode because there are no tab switches.

### Composition path (normal)

1. Create `ui` via `createUi()`.
2. Create `api` via `createAdminApi(...)`.
3. Build the frozen panel context `ctx`.
4. Fetch `runtime.about` to update branding, timezone policy, and cached connection metadata.
5. On `DOMContentLoaded`, run `ensureBooted()`.
6. Build the current layout from the registry.
7. Load composition CSS, activate the initial panel (`initTabs()` for tabbed layouts, `activatePanel(...)` for single layouts), and initialize native panels.
8. Discover matching plugin panel contributions and enable their tab slots.
9. Register lazy-mount handling for later plugin-tab switches.
10. Keep connection state current via ping, guarded resume-triggered recovery checks, socket reconnect handling, and reconnect warmup.

Important: plugin panel activation after discover is resolved in this order:

1. URL hash, when it targets a hydrated plugin tab
2. composition `defaultPanel`, when it resolves to a hydrated plugin tab
3. first enabled plugin tab, but only for plugin-only compositions

If a plugin tab becomes active during boot before the lazy-load event listener is registered,
`boot.js` mounts that plugin panel immediately so the initial selection is not lost.

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
When static i18n text is refreshed afterwards, `applyStaticI18n()` also resynchronizes the derived document title via
the async `updateDocumentTitle()` path.

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

Before native panel initialization, `boot.js` also establishes the initial visible panel for the current layout:

- `tabs`: via `initTabs({ defaultPanelId })`
- `single`: via `activatePanel('tab-...')`

This keeps initial visibility and document-title derivation on the same activation path.

### 4) Hydrate plugin panel tab slots

Structured plugin panel refs from the composition are not active immediately.
`hydratePluginPanels()` matches them against `admin.pluginUi.discover` results, then:

- merges plugin-owned Admin-UI i18n from discover into the runtime dictionary before any shell metadata is resolved
- enables the matching tab
- stores `data-i18n=contrib.label` on the tab and replaces the temporary loading label with `t(contrib.label)`
- stores the mount metadata in `pluginPanelTabMap`
- calls `normalizePluginPanel(contrib, ref)` and `registerPanelDescriptor(descriptor)` so that `panelDescriptors` in `layout.js` is populated before the user first activates a plugin tab
- mirrors `descriptor.category` to the plugin panel container as `span.msghub-paneltype-<category>` when present

Actual plugin bundle mounting is lazy by default, but `boot.js` also mounts a plugin panel immediately when it
became active during boot before the later `msghub:tabSwitch` listener could observe that activation.

`hydratePluginPanels()` is also reused in the Single-Panel-Mode plugin path (see above) to populate
`pluginPanelTabMap` via the same mechanism. In that context the tab DOM elements do not exist, but
`hydratePluginPanels` handles absent `tabEl` results gracefully — the `if (tabEl)` block is skipped
and `pluginPanelTabMap.set(...)` still executes. The bundle is then mounted immediately after.

### 5) Handle `panel=` Single-Panel-Mode

When `args.panel` is set, `ensureBooted()` calls `resolvePanelMode()` and takes an early-return
path before composition resolution begins. This path produces a minimal single-panel shell:

- no `<nav class="msghub-tabs">` tab strip
- no `msghub:tabSwitch` listener
- no composition CSS, no wildcard discover, no layout-building from the registry
- `api.host.viewId` is `null`, `api.host.layout` is `'single'`, `api.host.panels` is a single-element array

A hard error is rendered (and boot stops) when the target panel cannot be resolved from the
registry (core) or from discover results (plugin).

### 6) Own connection and health-state behavior for the shell

`boot.js` is also responsible for shell-level connection UX:

- online/offline classes on the connection bar
- connection info panel contents
- disconnect/reconnect toasts
- periodic `admin.ping`
- one shared reconnect recovery runner for disconnect, ping-failure, and resume/browser-return triggers
- resume-triggered restart of that runner after a real background/return cycle (`visibilitychange -> visible`) and `pageshow` from bfcache (`event.persisted === true`)
- reconnect warmup that waits until `api.constants.get()` succeeds again
- one guarded hard reload for late critical boot failures after a previously healthy shell

The UI is treated as online only after a successful ping, not just after a transport-level socket reconnect.
When the shell is offline, `boot.js` starts an immediate reconnect attempt and then keeps retrying with
bounded backoff until a successful ping marks the shell online again.
Critical boot failures are classified at the boot layer (for example failed core CSS loads, panel
script load/init failures, or a fatal top-level boot error), not at toast rendering. When the shell
had already been healthy for more than three minutes, `boot.js` may spend exactly one hard reload
to recover from such a late failure.

### 7) Provide the global editable-field context menu

Inside `.msghub-root`, `boot.js` replaces the browser context menu with the shell menu from [`./tab-ui.md`](./tab-ui.md).
For text-like inputs, textareas, and `contenteditable` elements it adds standard actions:

- Cut
- Copy
- Paste
- Select all

`Ctrl` + right-click intentionally bypasses the custom menu and leaves the native browser menu available.
If no shell or panel items are available for the current target, `boot.js` keeps the native browser menu suppressed but does not open an empty custom menu.
Touch long-presses are handled by the shell polyfill in [`./tab-ui.md`](./tab-ui.md); `boot.js` only consumes the resulting `contextmenu` flow.

---

## Public surface / integration points

`boot.js` does not export a public module object, but it defines the runtime contracts that the rest of the UI relies on.

### Panel initialization contract

Each native panel definition in the registry carries `ui.initGlobal`, for example:

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
- `visibilitychange`
- `pageshow`
- socket `connect`
- socket `disconnect`
- periodic ping timers
- `msghub:tabSwitch` for later plugin-panel lazy mounting (composition path only — not registered in `panel=` Single-Panel-Mode)

It also triggers an unconditional initial `sendPing()` during module load, before any socket event arrives.

---

## Design notes / invariants

- `ensureBooted()` is idempotent. A cached `bootPromise` prevents duplicate boot sequences.
- The boot flow is not purely composition-driven. `ensureBooted()` calls `resolvePanelMode()` first; if `args.panel` is set the composition path is bypassed entirely and a minimal single-panel shell is built instead.
- In `panel=` Single-Panel-Mode, `hydratePluginPanels()` is reused for plugin targets so that `pluginPanelTabMap` is populated via the same mechanism as in composition mode. The mount container div must already exist (created by `buildSinglePanelShell`) before `hydratePluginPanels` is called.
- In `panel=` Single-Panel-Mode, i18n is loaded before any error message is rendered so that `t()` produces a translated string rather than a raw key.
- Plugin tabs start disabled. They are enabled only when a matching discover contribution and DOM mount container both exist.
- Initial panel activation is layout-aware: tabbed compositions use `initTabs()`, single compositions call the shared `activatePanel(...)` path directly.
- `ctx` is frozen before it is handed to panels. Panels should treat it as read-only runtime state.
- `ctx.elements` exposes getters for `connection`, `pluginsRoot`, `messagesRoot`, and `statsRoot`. In the current shell, `statsRoot` has no matching mount point in [`admin/tab.html`](../../admin/tab.html) and currently resolves to `null`.
- Transport reconnect is not treated as sufficient proof of health. The shell waits for a successful ping before switching to online UX.
- The healthy-shell marker is written only after `ensureBooted()` completed and the first successful ping marked the shell online.
- Resume recovery is shell-owned and stays internal to `boot.js`; native panels do not receive a dedicated `onResume()` hook.
- Resume recovery is armed only after the page was actually backgrounded; a normal reload/open must not trigger the resume restart path.
- Reconnect warmup is centralized here. Panels are not expected to implement their own retry loop for core shell availability.
- Early boot failures remain visible; only late critical failures after a previously healthy shell may trigger one guarded hard reload.
- `pickText()` still exists in `runtime.js`, but hard-migrated panel/app metadata in the shell path no longer use it. `boot.js` resolves `data-i18n` nodes and plugin panel labels key-strict via `t(...)`.
- Shell-wide timezone fallback warning is intentionally shown only once per page lifetime.
- The connection panel reports the effective frontend format locale shown to the shell. When `args.locale` is present and valid, that value is shown instead of the old ambient browser-locale source.
- The global `contextmenu` listener is intentionally shared between mouse right-click and the synthetic long-press flow. It is the fallback path for both mouse and touch.

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
