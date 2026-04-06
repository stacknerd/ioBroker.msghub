# UI API Reference

| Item | Contract |
| --- | --- |
| Scope | UI-facing contracts only. |
| In scope | Browser/runtime globals, Admin Tab shell builders, native panel `ctx`, `ctx.api`, UI-facing Admin/runtime commands, plugin-owned Admin UI host path, browser lifecycle and mounting invariants. |
| Out of scope | Plugin runtime `ctx` outside UI-facing paths, full core/module API ownership, general architecture, non-UI plugin wiring details. |
| Source of truth | `admin/tab/contracts.d.ts`, `admin/tab/runtime.js`, `admin/tab/api.js`, `admin/tab/ui.js`, `admin/tab/layout.js`, `admin/tab/registry.js`, `admin/tab/boot.js`, `admin/tab/plugin-ui-host.js`, `lib/IoAdminTab.js`, `lib/IoPlugins.js`, `lib/IngestStates/manifest.js`, `src/MsgStore.js`, `src/MsgStats.js`, `main.js`. |

| Area | Owned by | Use this file for |
| --- | --- | --- |
| Browser/runtime shell | `admin/tab/*.js` | Global browser contracts, native panel `ctx`, shell lifecycle, layout/mount helpers. |
| UI <> IO/Admin runtime | `lib/IoAdminTab.js`, `main.js` | Commands and DTOs that browser/UI code consumes directly. |
| UI <> plugin-owned Admin UI | `admin/tab/plugin-ui-host.js`, `lib/IoPlugins.js`, plugin `manifest.adminUi` | Discover, bundle loading, bundle ctx, plugin panel RPC path. |

## Browser Runtime

### Global runtime values and helpers

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `args` | Parsed query object from `window.location.search`. `instance` is normalized to an integer and defaults to `0`. `lang` falls back to the browser base language. `locale` is trimmed and removed when blank, then used only as an optional frontend format-locale override by downstream consumers. `composition` is trimmed and removed when empty. `expert` is normalized only when present. Unknown query keys are preserved. | Browser runtime | `admin/tab/runtime.js` |
| `adapterInstance` | Always `msghub.<args.instance>`. | Browser runtime | `admin/tab/runtime.js` |
| `msghubSocket` | Socket.io client connected to `'/'` with `path: '/socket.io'`. Exposed as `window.msghubSocket`. | Browser runtime | `admin/tab/runtime.js` |
| `msghubRequest(command, message)` | Socket `sendTo` bridge to `adapterInstance`. Resolves with `res.data` when the backend response has `ok: true`. Rejects with `Error(message)` on missing response or backend `ok: false`. | Browser runtime | `admin/tab/runtime.js` |
| `lang` | Active UI text language string. Initially `args.lang` or `'en'` fallback. | Browser runtime | `admin/tab/runtime.js` |
| `overrideLang(newLang)` | Normalizes `newLang` to lowercase, updates `lang`, and invalidates the cached admin i18n load promise. Does nothing when the normalized language is unchanged. | Browser runtime | `admin/tab/runtime.js` |
| `ensureAdminI18nLoaded()` | Loads the Admin Tab dictionary from `admin/i18n/en.json` plus `admin/i18n/<lang>.json` (admin-relative URLs served by the ioBroker admin host). This is separate from the backend runtime catalog at repo-root `i18n/`. The files are merged as `en` fallback overridden by the active language. Returns one shared promise per active language. | Browser runtime | `admin/tab/runtime.js` |
| `hasAdminKey(key)` | Checks whether the currently loaded admin dictionary contains `key`. | Browser runtime | `admin/tab/runtime.js` |
| `mergePluginI18n(pluginType, translations)` | Host-internal dictionary merge for plugin-owned Admin UI translations. Only keys under `msghub.i18n.<pluginType>.ui.` are admitted. Existing keys are never overwritten. | Browser runtime | `admin/tab/runtime.js` |
| `t(key, ...args)` | Returns the translated value when `key` exists in the loaded dictionary; otherwise returns `key`. Replaces `%s` placeholders left to right with the provided args. | Browser runtime | `admin/tab/runtime.js` |
| `pickText(value)` | Browser-side text resolver. Accepts a plain string or a translated object. For objects, uses `value[lang] ?? value.en ?? value.de`. Strings that start with `msghub.i18n.` or already exist in the admin dictionary are translated through `t(...)`. | Boot runtime | `admin/tab/boot.js` |
| `readThemeFromTopWindow()` | Best-effort theme probe against the parent/top-window DOM. Returns `'dark'`, `'light'`, or `null`. | Browser runtime | `admin/tab/runtime.js` |
| `applyTheme(nextTheme)` | Writes `data-msghub-theme="dark|light"` on `document.documentElement`. In `debugTheme` mode it also stores the effective value in `window.__msghubAdminTabTheme`. | Browser runtime | `admin/tab/runtime.js` |
| `detectTheme()` | Theme resolution priority: explicit URL override (`theme`, then legacy `react` when `theme` is absent), then top window, then local storage, then `matchMedia('(prefers-color-scheme: dark)')`, then `'light'`. | Browser runtime | `admin/tab/runtime.js` |
| `window.__msghubAdminTabTheme` | Debug-only mirror of the current effective theme. Written only when `debugTheme` is enabled. | Browser runtime | `admin/tab/runtime.js`, `admin/tab/contracts.d.ts` |
| `window.__msghubAdminTabEntryLoaded` | Optional browser-global flag declared in `contracts.d.ts`. No current shell writer in the inspected code. | Declared browser contract | `admin/tab/contracts.d.ts` |

Internal runtime coordination such as `urlThemeLocked` is intentionally documented in
[`./tab-runtime.md`](./tab-runtime.md) and [`./tab-layout.md`](./tab-layout.md), not as a UI-facing
panel/plugin contract in this reference.

### Shared shell builders and globals

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `h(tag, attrs?, children?)` | Minimal DOM factory. Supports `class`, `html`, `text`, `on*` listeners, generic attributes, string children, and node children. Returns a real `HTMLElement`. | Layout runtime | `admin/tab/layout.js` |
| `createUi()` | Builds the shared shell UI primitive object with `toast`, `toastClose`, `contextMenu`, `overlayLarge`, `dialog`, `spinner`, and `closeAll`. | UI runtime | `admin/tab/ui.js`, `admin/tab/contracts.d.ts` |
| `createAdminApi(deps)` | Builds the frozen `ctx.api` facade used by native panels and wrapped by the plugin UI host. | Browser API layer | `admin/tab/api.js`, `admin/tab/contracts.d.ts` |
| `initTabs({ defaultPanelId? })` | Wires tab activation against `location.hash`. Skips tabs marked `aria-disabled="true"`. Returns `{ initial, setActive(tabDomId) }`. | Layout runtime | `admin/tab/layout.js`, `admin/tab/contracts.d.ts` |
| `buildLayoutFromRegistry({ contributions? })` | Builds the visible shell layout from `window.MsghubAdminTabRegistry`. Returns `{ layout, panelIds, pluginPanelRefs, defaultPanelId }`. `panelIds` contains native panel ids only. `pluginPanelRefs` contains structured plugin-panel refs. | Layout runtime | `admin/tab/layout.js`, `admin/tab/contracts.d.ts` |
| `resolveViewId()` | Resolves the active composition id in this order: registered `args.composition`, registered `data-msghub-view`, then hard fallback `adminTab`. | Layout runtime | `admin/tab/layout.js`, `admin/tab/contracts.d.ts` |
| `getActiveComposition()` | Returns the registered composition object for `resolveViewId()`, or `null`. | Layout runtime | `admin/tab/layout.js`, `admin/tab/contracts.d.ts` |
| `computeAssetsForComposition(panelIds)` | Dedupe-merges CSS and JS asset paths from registry panel definitions. Returns `{ css, js }`. | Layout runtime | `admin/tab/layout.js`, `admin/tab/contracts.d.ts` |
| `loadCssFiles(files)` | Deduplicated stylesheet loader. Returns `{ failed: string[] }`. Missing files do not reject; they are collected in `failed`. | Layout runtime | `admin/tab/layout.js`, `admin/tab/contracts.d.ts` |
| `loadJsFilesSequential(files)` | Deduplicated script loader. Loads in order. Rejects on the first script load failure. | Layout runtime | `admin/tab/layout.js`, `admin/tab/contracts.d.ts` |
| `getPanelDefinition(panelId)` | Returns the native panel definition from the registry or `null`. | Layout runtime | `admin/tab/layout.js`, `admin/tab/contracts.d.ts` |
| `renderPanelBootError(panelId, err)` | Replaces `#tab-<panelId>` content with a visible boot error block. | Layout runtime | `admin/tab/layout.js`, `admin/tab/contracts.d.ts` |
| `createMsghubPluginUiHost({ request, api })` | Builds the plugin-owned Admin UI host. Returns `{ mount, unmount, retry }`. | Plugin UI host | `admin/tab/plugin-ui-host.js`, `admin/tab/contracts.d.ts` |
| `computeContextMenuPosition(params)` | Viewport-aware menu positioning helper used by the context-menu runtime. Returns `{ x, y }`. | Browser API layer | `admin/tab/api.js`, `admin/tab/contracts.d.ts` |
| `toContextMenuIconVar(iconName)` | Converts a safe icon key into `var(--msghub-icon-<name>)`. Invalid names return `''`. | Browser API layer | `admin/tab/api.js`, `admin/tab/contracts.d.ts` |
| `window.MsghubAdminTabRegistry` | Frozen browser-global registry with `{ panels, compositions }`. | Registry runtime | `admin/tab/registry.js`, `admin/tab/contracts.d.ts` |

### Registry-owned DTOs

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `registry.panels[panelId]` | Native producer definition with owner-local `id`, `label`, `category`, `ui`, and optional `app`. Canonical external ids (`tab-...`) are derived later by `normalizeCorePanel(...)`. | Registry runtime | `admin/tab/registry.js` |
| `registry.compositions[viewId]` | Composition definition with `id`, `layout`, `panels`, `defaultPanel`, and `deviceMode`. The only allowed composition-level `app` block is the special-case `registry.compositions.web.app` for the prepared Public-Web root contract. | Registry runtime | `admin/tab/registry.js` |
| Native composition panel entry | String panel id such as `'messages'` or `'plugins'`. | Registry runtime | `admin/tab/registry.js`, `admin/tab/layout.js` |
| Plugin composition panel entry | Structured ref `{ type: 'pluginPanel', pluginType, instanceId, panelId }`. | Registry runtime | `admin/tab/registry.js`, `admin/tab/layout.js` |
| Wildcard composition | `panels: ['*']`. Native registry panels are rendered first, then all discover contributions as plugin-panel refs. | Layout runtime | `admin/tab/layout.js` |

### Browser events and shell lifecycle

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `document` event `msghub:tabSwitch` | Fired by `initTabs()` when the active panel changes. Event detail: `{ from?: string, to?: string }`, where values are DOM panel ids such as `tab-messages` or `tab-plugin-IngestStates-0-presets`. | Layout runtime | `admin/tab/layout.js`, `admin/tab/contracts.d.ts` |
| `document` event `msghub:contextMenuOpen` | Fired when the raw shared context menu opens. Event detail is the frozen root-menu state `{ items, anchorPoint, anchorEl, placement, ariaLabel }`. | UI runtime | `admin/tab/ui.js` |
| `document` event `msghub:contextMenuClose` | Fired when the raw shared context menu closes. No detail payload is attached. | UI runtime | `admin/tab/ui.js` |
| Global context menu replacement | Inside `.msghub-root`, the shell replaces the native browser context menu. `Ctrl+right-click` bypasses the custom menu. Blocking spinner/dialog/overlay backdrops suppress it. | Boot runtime | `admin/tab/boot.js` |
| Theme synchronization | `layout.js` reacts to `message`, `storage`, a 1500 ms polling fallback, and top-window mutation observation to keep `data-msghub-theme` synchronized. | Layout runtime | `admin/tab/layout.js`, `admin/tab/runtime.js` |
| Connection probing | The shell sends `admin.ping` every 15 seconds and also on socket connect. Ping timeout is 5000 ms. Online/offline state is derived from ping success, not from socket connect alone. | Boot runtime | `admin/tab/boot.js`, `lib/IoAdminTab.js` |
| Reconnect warmup | On every online transition, the shell calls each panel's `onConnect()` immediately, then starts a warmup loop that retries `api.constants.get()` for up to 30000 ms. If warmup succeeds and the socket is still connected, `onConnect()` is called a second time through the warmup path. | Boot runtime | `admin/tab/boot.js` |

## Native Panel Contract

### Panel entry contract

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `registry.panels[panelId].initGlobal` | Name of the browser global that owns the panel entry point, e.g. `'MsghubAdminTabMessages'`. | Registry runtime | `admin/tab/registry.js`, `admin/tab/boot.js` |
| `win[initGlobal].init(ctx)` | Required export. Called once by the shell with the frozen `ctx` object. Return value is an optional lifecycle handle stored by the shell. | Panel entry | `admin/tab/boot.js`, `admin/tab/panels/messages/index.js`, `admin/tab/panels/plugins/index.js` |
| Lifecycle handle `onConnect()` | Optional method on the object returned by `init(ctx)`. Called by the shell (a) immediately on every online transition and (b) again after a successful constants warmup following a reconnect. | Panel entry | `admin/tab/boot.js` |

### Native panel `ctx`

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `ctx.args` | Shared query-derived runtime args object. | Boot runtime | `admin/tab/boot.js` |
| `ctx.adapterInstance` | Same value as the global `adapterInstance`. | Boot runtime | `admin/tab/boot.js` |
| `ctx.msghubSocket` | Same socket instance as the global `msghubSocket`. | Boot runtime | `admin/tab/boot.js` |
| `ctx.msghubRequest` | Same request bridge as the global `msghubRequest(...)`. Present on `ctx` for internal boot-time wiring only. Direct panel access is a contract violation — use `ctx.api` instead. | Boot runtime | `admin/tab/boot.js` |
| `ctx.api` | Frozen panel API facade returned by `createAdminApi(...)`. | Browser API layer | `admin/tab/boot.js`, `admin/tab/api.js` |
| `ctx.h` | Same DOM helper as the global `h(...)`. | Boot runtime | `admin/tab/boot.js` |
| `ctx.ui` | The raw shared UI primitive object returned by `createUi()`. Native panels receive it directly. | Boot runtime | `admin/tab/boot.js`, `admin/tab/ui.js` |
| `ctx.lang` | Current language snapshot at boot time. It is not a reactive getter. | Boot runtime | `admin/tab/boot.js` |
| `ctx.elements.connection` | Getter for `#msghub-connection`. | Boot runtime | `admin/tab/boot.js` |
| `ctx.elements.pluginsRoot` | Getter for `#plugins-root`. | Boot runtime | `admin/tab/boot.js` |
| `ctx.elements.statsRoot` | Getter for `#stats-root`. | Boot runtime | `admin/tab/boot.js` |
| `ctx.elements.messagesRoot` | Getter for `#messages-root`. | Boot runtime | `admin/tab/boot.js` |

### Raw `ctx.ui` / `createUi()` surface

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `ctx.ui.toast(opts)` | Raw toast primitive. Same variant/id/persist contract as the shared UI runtime. No default message is injected here. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.toastClose(id)` | Closes a named toast immediately. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.contextMenu.open(opts)` | Opens the raw shared context menu with `{ items?, anchorPoint?, anchorEl?, placement?, ariaLabel? }`. Items are used as provided; no `ctx.api` wrapping is applied here. `placement === 'anchor'` or `'below-start'` uses anchor-style positioning; all other values use cursor-style positioning. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.contextMenu.close()` | Closes the raw context menu stack. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.contextMenu.isOpen()` | Returns whether any context menu level is open. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.contextMenu.setBrandingText(text)` | Updates the branding text rendered in the context-menu footer. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.overlayLarge.open(opts)` | Opens the large overlay with `{ title?, bodyEl?, bodyText? }`. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.overlayLarge.close()` | Closes the large overlay. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.overlayLarge.isOpen()` | Returns whether the large overlay is open. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.dialog.confirm(opts)` | Opens the raw confirm dialog and resolves `Promise<boolean>`. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.dialog.close(ok?)` | Closes the confirm dialog. When a confirm promise is pending, resolves it as `ok === true`. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.dialog.isOpen()` | Returns whether the small dialog is open. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.spinner.show(opts)` | Returns a spinner id. `opts.blocking === true` uses the shared overlay. Non-blocking mode renders a persistent neutral toast keyed as `msghub-toast-<spinnerId>`. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.spinner.hide(id?)` | Hides one spinner by id, or all spinners when `id` is omitted. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.spinner.isOpen(id?)` | Without `id`, returns whether any spinner is active. With `id`, checks that specific spinner. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |
| `ctx.ui.closeAll()` | Closes overlay, dialog, context menu, and all spinners in that order. | UI runtime | `admin/tab/ui.js`, `admin/tab/boot.js` |

### `ctx.api.i18n`

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `ctx.api.i18n.lang()` | Returns the language value captured when `createAdminApi(...)` was called. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.i18n.has(key)` | Checks the loaded admin dictionary with `hasAdminKey(...)`. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.i18n.t(key, ...args)` | Translates through the shared browser dictionary. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.i18n.tOr(key, fallback, ...args)` | Returns `fallback` when translation falls through to the raw key. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.i18n.pickText(value)` | Same resolver semantics as `pickText(...)`. | Browser API layer | `admin/tab/api.js`, `admin/tab/boot.js` |

### `ctx.api.ui`

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `ctx.api.ui.toast(opts)` | Pass-through to the shared toast primitive. `opts.text` must render to a non-empty string to show a toast. Recognized variants are `ok`, `warning`, `danger`, otherwise `neutral`. | UI runtime via API facade | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.toastClose(id)` | Closes a named toast immediately. | UI runtime via API facade | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.contextMenu.open(opts)` | Opens the shared context menu. `opts.items` is recursively wrapped so submenu items are also normalized and the menu closes before `onSelect()` runs. | UI runtime via API facade | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.contextMenu.close()` | Closes the current context menu stack. | UI runtime via API facade | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.contextMenu.isOpen()` | Returns whether any context menu level is open. | UI runtime via API facade | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.overlayLarge.open(opts)` | Opens the large overlay. `opts.title` is a string. Content comes from `opts.bodyEl` when it is a DOM node, otherwise from `opts.bodyText` when it is a string. | UI runtime | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.overlayLarge.close()` | Closes the large overlay and restores focus best-effort. | UI runtime | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.overlayLarge.isOpen()` | Returns whether the large overlay is open. | UI runtime | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.dialog.confirm(opts)` | Opens the confirm dialog and resolves `Promise<boolean>`. A second confirm call while one is already pending resolves immediately with `false`. Supports `title`, `text`, `bodyEl`, `confirmText`, `cancelText`, `danger`. | UI runtime | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.dialog.close()` | Closes the small dialog. When a confirm is pending, resolves it as `false` unless the explicit close path passes `true`. | UI runtime | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.dialog.isOpen()` | Returns whether the small dialog is open. | UI runtime | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.spinner.show(opts)` | Returns a spinner id. Blocking spinners use a shared overlay; non-blocking spinners render as persistent neutral toasts. When called through `ctx.api.ui.spinner.show(...)`, a default translated "please wait" message is injected when `opts.message` is blank. | UI runtime via API facade | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.spinner.hide(id?)` | Hides one spinner by id. Without `id`, closes all active spinners. | UI runtime via API facade | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.spinner.isOpen(id?)` | Without `id`, returns whether any spinner is active. With `id`, checks that specific spinner. | UI runtime via API facade | `admin/tab/api.js`, `admin/tab/ui.js` |
| `ctx.api.ui.closeAll()` | Closes overlay, dialog, context menu, and all spinners in that order. | UI runtime via API facade | `admin/tab/api.js`, `admin/tab/ui.js` |

### Context menu item schema

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `'item' \| 'separator' \| 'label' \| 'checkbox'` | Default `'item'` when absent. |
| `label` | `string` | Display text. Required for `item`, `label`, `checkbox`. |
| `id` | `string?` | Optional stable DOM id (`data-msghub-contextmenu-id`). |
| `shortcut` | `string?` | Keyboard shortcut hint rendered in the meta column. |
| `icon` | `string?` | Icon key passed through `toContextMenuIconVar(...)`. |
| `disabled` | `boolean?` | Disables the item. |
| `danger` | `boolean?` | Applies danger styling. |
| `primary` | `boolean?` | Applies primary styling. |
| `checked` | `boolean?` | `checkbox` type only. Initial checked state. |
| `items` | `Array?` | Nested item array for submenu (any item type supports this). |
| `onSelect` | `Function?` | Called when item is activated. In `ctx.api.ui` path, menu closes before `onSelect()` runs. |
| `onToggle` | `Function?` | `checkbox` type only. Called with new boolean checked state. |

`separator` and `label` items use only `type` (and `label` for `label`-type). All other fields are ignored.

### `ctx.api.log`, `ctx.api.host`, `ctx.api.time`, and utility groups

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `ctx.api.log.debug/info/warn/error(...args)` | Console logging with the prefix `msghub:<viewId>`. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.host.viewId` | Active composition/view id. Defaults to `adminTab`. | Browser API layer | `admin/tab/api.js`, `admin/tab/layout.js` |
| `ctx.api.host.layout` | `'tabs'` or `'single'`. Derived from the active composition. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.host.deviceMode` | Composition `deviceMode` value, currently defaulting to `'pc'` when absent. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.host.panels` | Frozen array of string entries from `composition.panels`. Non-string plugin-panel ref objects are filtered out, but string sentinels such as `'*'` (wildcard composition) pass through as-is. Wildcard expansion is owned by `layout.js`, not by `api.js`. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.host.defaultPanel` | Composition `defaultPanel` string or `''`. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.host.adapterInstance` | Same value as `adapterInstance`. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.host.isConnected()` | Returns `!!msghubSocket.connected`. This is transport state only; it is not the same as the shell ping-derived online flag. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.host.isExpertMode()` | Native-panel helper with additive expert semantics: `args.expert === true` wins first, otherwise `sessionStorage['App.expertMode'] === 'true'`, otherwise `window._system.expertMode` / `window.top._system.expertMode`. A false URL flag does not disable host expert mode. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.constants.get()` | Async cached fetch of `admin.constants.get`. Cache age is effectively infinite until invalidated. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.constants.invalidate()` | Clears the constants cache. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.runtime.about()` | Calls `runtime.about`. Returns the backend payload directly when successful. | Browser API layer | `admin/tab/api.js`, `main.js` |
| `ctx.api.time.getPolicy()` | Returns the current normalized timezone policy `{ timeZone, source, isFallbackUtc, warning }`. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.time.setPolicy(policy)` | Normalizes the provided policy. Invalid or missing timezones become `{ timeZone: 'UTC', source: 'fallback-utc', isFallbackUtc: true, warning: 'timezone_fallback_utc:<reason>' }`. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.time.formatTs(ts, options?)` | Formats a finite millisecond timestamp using the current policy timezone. Returns `''` for invalid input and falls back to `String(ts)` on formatting errors. `options.locale` overrides the locale. Otherwise a valid `args.locale` URL override becomes the default frontend format locale; missing or invalid `args.locale` keeps ambient/browser-default behavior. `options.includeTimeZone === true` adds the timezone name. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.time.formatDate(date, options?)` | Same formatting contract as `formatTs(...)`, including `options.locale` precedence and `args.locale` as the default frontend format-locale override when valid. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.notSupported(method)` | Throws `NotSupportedError` with `code: 'NOT_SUPPORTED'`. | Browser API layer | `admin/tab/api.js` |

## UI <> IO

### Command families exposed through `ctx.api`

| `ctx.api` method | Backend command | Request contract | Response contract | Owner | Reference |
| --- | --- | --- | --- | --- | --- |
| `ctx.api.constants.get()` | `admin.constants.get` | No payload fields are used. | `{ kind, lifecycle: { state }, level, notfication: { events } }` | Admin runtime | `admin/tab/api.js`, `lib/IoAdminTab.js` |
| `ctx.api.stats.get(params)` | `admin.stats.get` | `params.include.archiveSize?: boolean`, `params.include.archiveSizeMaxAgeMs?: number`. `archiveSizeMaxAgeMs` is normalized to a non-negative integer. | MsgStats snapshot `{ meta, current, schedule, done, io }`. Nested DTO is owned by `MsgStats`. | Admin runtime | `admin/tab/api.js`, `lib/IoAdminTab.js`, `src/MsgStats.js` |
| `ctx.api.messages.query(params)` | `admin.messages.query` | `params.query.where?: object`, `params.query.page?: object`, `params.query.sort?: object|Array`. Omitted or invalid branches are dropped before forwarding. | `{ meta: { generatedAt, tz }, items, total?, pages? }`. `items` are JSON-safe clones with maps serialized. | Admin runtime | `admin/tab/api.js`, `lib/IoAdminTab.js`, `src/MsgStore.js` |
| `ctx.api.messages.delete(refs)` | `admin.messages.delete` | Array of refs. The backend trims strings, deduplicates them, rejects empty input, and rejects more than 5000 refs. | `{ requested, deleted, missing }` | Admin runtime | `admin/tab/api.js`, `lib/IoAdminTab.js` |
| `ctx.api.messages.executeAction(params)` | `admin.messages.action` | `{ ref, actionId }` are required. | `{ executed: true }` on success. Error code `REJECTED` when the action executor returns false. | Admin runtime | `admin/tab/api.js`, `lib/IoAdminTab.js` |
| `ctx.api.plugins.getCatalog()` | `admin.plugins.getCatalog` | No payload fields are used. | `{ plugins: PluginCatalogEntry[] }` | Admin runtime | `admin/tab/api.js`, `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `ctx.api.plugins.listInstances()` | `admin.plugins.listInstances` | No payload fields are used. | `{ instances: PluginInstanceEntry[] }` | Admin runtime | `admin/tab/api.js`, `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `ctx.api.plugins.createInstance(params)` | `admin.plugins.createInstance` | `{ category, type }` are required by the runtime. | `{ instanceId }` | Admin runtime | `admin/tab/api.js`, `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `ctx.api.plugins.updateInstance(params)` | `admin.plugins.updateInstance` | `{ type, instanceId, nativePatch }` are required by the runtime. | `{}` | Admin runtime | `admin/tab/api.js`, `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `ctx.api.plugins.setEnabled(params)` | `admin.plugins.setEnabled` | `{ type, instanceId, enabled }` | `{}` | Admin runtime | `admin/tab/api.js`, `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `ctx.api.plugins.deleteInstance(params)` | `admin.plugins.deleteInstance` | `{ type, instanceId }` | `{}` | Admin runtime | `admin/tab/api.js`, `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `ctx.api.runtime.about()` | `runtime.about` | No payload fields are used. | `{ title, version, time, lang, connection }` | Main runtime command | `admin/tab/api.js`, `main.js` |

### `admin.constants.get`

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `kind` | Full `MsgConstants.kind` object. | Admin runtime | `lib/IoAdminTab.js` |
| `lifecycle.state` | Full `MsgConstants.lifecycle.state` object. No other `lifecycle` branches are forwarded here. | Admin runtime | `lib/IoAdminTab.js` |
| `level` | Full `MsgConstants.level` object. | Admin runtime | `lib/IoAdminTab.js` |
| `notfication.events` | Full `MsgConstants.notfication.events` object. Spelling is the current code spelling. | Admin runtime | `lib/IoAdminTab.js` |

### `admin.stats.get`

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| Request | `{ include?: { archiveSize?: boolean, archiveSizeMaxAgeMs?: number } }` | Admin runtime | `lib/IoAdminTab.js` |
| Response `meta` | `{ schemaVersion: 1, generatedAt, tz, locale, windows }` | `MsgStats` via Admin runtime | `src/MsgStats.js`, `lib/IoAdminTab.js` |
| Response `current` | Current open-state counters, including `byKind`. | `MsgStats` via Admin runtime | `src/MsgStats.js` |
| Response `schedule` | Due-window counters, including `byKind`. | `MsgStats` via Admin runtime | `src/MsgStats.js` |
| Response `done` | `{ today, thisWeek, thisMonth, lastClosedAt }` | `MsgStats` via Admin runtime | `src/MsgStats.js` |
| Response `io` | `{ storage, archive }` from MsgStorage/MsgArchive status getters when present. | `MsgStats` via Admin runtime | `src/MsgStats.js` |

### `admin.messages.query`, `admin.messages.delete`, `admin.messages.action`

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| Query request | `{ query?: { where?: object, page?: object, sort?: object|Array } }` | Admin runtime | `lib/IoAdminTab.js` |
| Query response | `{ meta: { generatedAt, tz }, items, total?, pages? }` | Admin runtime | `lib/IoAdminTab.js` |
| Delete request | `{ refs: string[] }` | Admin runtime | `lib/IoAdminTab.js` |
| Delete success response | `{ requested, deleted, missing }` | Admin runtime | `lib/IoAdminTab.js` |
| Action request | `{ ref: string, actionId: string }` | Admin runtime | `lib/IoAdminTab.js` |
| Action success response | `{ executed: true }` | Admin runtime | `lib/IoAdminTab.js` |
| Action actor | The runtime always executes with `actor: 'AdminTab'`. | Admin runtime | `lib/IoAdminTab.js` |

### `admin.plugins.*`

| DTO | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `PluginCatalogEntry` | `{ category, type, label?, defaultEnabled, supportsMultiple, supportsChannelRouting, defaultOptions, title, description, options? }` | Plugin catalog surfaced by Admin runtime | `lib/IoPlugins.js`, `lib/IoAdminTab.js` |
| `PluginInstanceEntry` | `{ category, type, instanceId, enabled, status, native }` | Plugin runtime surfaced by Admin runtime | `lib/IoPlugins.js`, `lib/IoAdminTab.js` |
| `createInstance` request | `{ category, type }` | Admin runtime | `lib/IoPlugins.js`, `lib/IoAdminTab.js` |
| `createInstance` response | `{ instanceId }` | Admin runtime | `lib/IoPlugins.js`, `lib/IoAdminTab.js` |
| `updateInstance` request | `{ type, instanceId, nativePatch }` | Admin runtime | `lib/IoPlugins.js`, `lib/IoAdminTab.js` |
| `setEnabled` request | `{ type, instanceId, enabled }` | Admin runtime | `lib/IoPlugins.js`, `lib/IoAdminTab.js` |
| `deleteInstance` request | `{ type, instanceId }` | Admin runtime | `lib/IoPlugins.js`, `lib/IoAdminTab.js` |

### `runtime.about` and auxiliary admin commands

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `runtime.about` response | `{ title, version, time: { timeZone, source }, lang: { backendTextLanguage, coreTextLanguage, coreFormatLocale }, connection }` | Main runtime command | `main.js`, `lib/IoCoreConnection.js` |
| `runtime.about.connection` | `{ scope: 'core-link', connected: boolean, mode: 'local' }` | Core connection runtime | `main.js`, `lib/IoCoreConnection.js` |
| `admin.ping` | Returns `{ ok: true, data: 'pong' }` on the Admin-runtime path. The shell uses it only for health probing, not through `ctx.api`. | Admin runtime | `lib/IoAdminTab.js`, `admin/tab/boot.js` |
| `admin.ingestStates.presets.selectOptions*` | UI-facing Admin/runtime passthrough used outside the Admin Tab shell path. `IoAdminTab` forwards the raw suffix and payload to `IngestStates.getPresetSelectOptions(...)` and returns `Array<{ value, label }>` without an `{ ok, data }` envelope. | Admin runtime | `lib/IoAdminTab.js`, `lib/IngestStates/index.js` |

## UI <> Plugin-Owned Admin UI

### Discover and bundle-loading commands

| Command | Request contract | Response contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `admin.pluginUi.discover` | `{ lang? }` where `lang` is the active shell language used for plugin-owned Admin-UI i18n lookup. | `PluginUiContribution[]` with authoritative content hash filled into `bundle.hash` by `IoAdminTab._pluginUiDiscover()`. Hash failures degrade to `''` per panel. Each contribution may additionally carry `i18n: { lang, translations }` for the requested shell language, with `en` fallback and `null` on soft read failure. | Admin runtime for UI host | `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `admin.pluginUi.bundle.get` | `{ pluginType, instanceId?, panelId, lang? }` | `{ apiVersion, moduleFormat: 'esm', hash, js, css?, i18n }` | Admin runtime for UI host | `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `admin.pluginUi.rpc` | `{ pluginType, instanceId?, panelId, command, payload? }` | Plugin-defined `{ ok, data }` or `{ ok: false, error: { code, message } }` at the backend boundary. `msghubRequest` rejects any `ok: false` response as `Error(message)`, so `error.code` is already absent before the host rejection handler runs. Bundle code always receives the normalized envelope described below. | Admin runtime for UI host | `lib/IoAdminTab.js`, `admin/tab/plugin-ui-host.js` |

### Plugin-owned Admin UI DTOs

| DTO | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `PluginUiContribution` | `{ pluginType, instanceId, panelId, label, description, category?, app?, apiVersion, bundle: { hash }, i18n?: { lang, translations }\|null }` | Admin runtime surfaced from plugin manifests and enriched by `admin.pluginUi.discover` with discover-time shell i18n for the requested language. | `lib/IoPlugins.js`, `lib/IoAdminTab.js` |
| `bundle.get` response | `{ apiVersion, moduleFormat: 'esm', hash, js, css?, i18n }` | Admin runtime | `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `bundle.get.i18n` | `{ lang, translations }` or `null`. `translations` is the parsed plugin-owned language file. | Admin runtime | `lib/IoPlugins.js`, `lib/IoAdminTab.js` |
| `bundle.get.css` | Optional companion CSS from `<bundle.entry>.css`. | Admin runtime | `lib/IoPlugins.js`, `lib/IoAdminTab.js` |

### Plugin UI host surface

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `createMsghubPluginUiHost({ request, api })` | Returns `{ mount, unmount, retry }`. `request` is expected to behave like `msghubRequest(...)`. `api` is expected to be the shell `ctx.api`. | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| `host.mount({ container, pluginType, instanceId, panelId, hash? })` | Fetches or reuses a cached bundle, imports the ESM source, merges plugin i18n, appends a `.msghub-plugin-ui-mount` wrapper, injects companion CSS as a sibling `<style>`, then calls `module.mount(ctx)`. Returns a handle used by `unmount(...)` and `retry(...)`. | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| `host.unmount(handle)` | Calls `module.unmount(ctx)` when exported, then clears the host container. Unmount errors are swallowed. | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| `host.retry(handle)` | Drops all cache entries for the same `(pluginType, instanceId, panelId)`, unmounts the current handle, then remounts without a hash hint. | Plugin UI host | `admin/tab/plugin-ui-host.js` |

### Plugin bundle export contract

| Export | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `module.mount(ctx)` | **Required.** Called by the host after the bundle is imported and `ctx.root` is attached to the DOM. The bundle renders into `ctx.root` from this call. | Plugin-owned | `admin/tab/plugin-ui-host.js` |
| `module.unmount(ctx)` | Optional. When exported, called by the host before the container is cleared. Unmount errors are swallowed. | Plugin-owned | `admin/tab/plugin-ui-host.js` |

### Plugin bundle `ctx`

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `ctx.root` | Light-DOM mount wrapper `<div class="msghub-plugin-ui-mount" ...>`. This is the plugin render root and CSS scope root. | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.plugin` | `{ type, instanceId }` with `instanceId` passed as the string value supplied by `boot.js`. | Plugin UI host | `admin/tab/plugin-ui-host.js`, `admin/tab/boot.js` |
| `ctx.panel` | `{ id }` for the current panel id. | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.host` | `{ apiVersion: '1', adapterInstance, uiTextLanguage }` | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.dom.h` | Same DOM helper contract as the shell `h(...)`. | Plugin UI host | `admin/tab/plugin-ui-host.js`, `admin/tab/layout.js` |
| `ctx.api.i18n.t(key, ...args)` | Delegates to the shell `api.i18n.t(...)` when present; otherwise returns the raw key. | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.api.ui.toast(opts)` | Narrowed access to the shell toast primitive. | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.api.ui.spinner.show/hide/isOpen` | Narrowed access to shell spinner helpers. | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.api.ui.dialog.confirm(opts)` | Narrowed access to the shell confirm dialog. There is no plugin bundle `dialog.close()` or `dialog.isOpen()`. | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.api.ui.overlayLarge.open/close` | Narrowed access to the large overlay. There is no plugin bundle `overlayLarge.isOpen()`. | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.api.request(command, payload?)` | Bundle-side RPC wrapper for `admin.pluginUi.rpc`. The wrapper always resolves. On successful transport where the backend returns `{ ok: true }`, it resolves with `{ ok: true, data }`. On transport failure or backend `{ ok: false }` (which `msghubRequest` already rejects as `Error(message)`), resolves with `{ ok: false, error: { message } }`. `error.code` is dropped at the `msghubRequest` layer and is never available to the bundle. | Plugin UI host | `admin/tab/plugin-ui-host.js`, `admin/tab/runtime.js`, `lib/IoAdminTab.js` |

### Plugin-owned Admin UI manifest fields consumed by the UI path

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `manifest.adminUi.apiVersion` | API version string for plugin-owned Admin UI. `IoPlugins.getAdminUiContributions()` defaults to `'1'` when absent. | Plugin-owned, consumed by UI path | `lib/IngestStates/manifest.js`, `lib/IoPlugins.js` |
| `manifest.adminUi.panels[]` | Flat panel list. Only running plugin instances with declared panels are discoverable. | Plugin-owned, consumed by UI path | `lib/IngestStates/manifest.js`, `lib/IoPlugins.js` |
| `panel.id` | Panel id unique within one plugin type. | Plugin-owned | `lib/IngestStates/manifest.js` |
| `panel.label` | Plugin-owned admin-ui i18n key surfaced by `discover` and resolved by the shell via `t(...)` when a matching slot is hydrated. | Plugin-owned | `lib/IngestStates/manifest.js`, `admin/tab/boot.js` |
| `panel.description` | Optional string surfaced by `discover`. Built-in plugin manifests currently also use plugin-owned i18n keys here. | Plugin-owned | `lib/IngestStates/manifest.js`, `lib/IoPlugins.js` |
| `panel.category` | Optional discover metadata for semantic grouping. | Plugin-owned | `lib/IngestStates/manifest.js`, `lib/IoPlugins.js` |
| `panel.app` | Optional install/PWA metadata block. Text fields are i18n keys. `app.url` is a host-neutral single-panel target string (current producer contract: stable query params such as `?panel=tab-...`). In the current AdminTab installability/head path, plugin panels do not provide or consume plugin-owned `app.icons`; the shell resolves those slots from the generic host set `admin/icons/pluginUI/*`. | Plugin-owned metadata, host-owned AdminTab icon consumer | `lib/IngestStates/manifest.js`, `lib/IoPlugins.js`, `admin/tab/layout.js` |
| `panel.bundle.entry` | Relative ESM bundle path inside the plugin directory. Required for `discover`, `bundle.get`, and hash computation. | Plugin-owned | `lib/IngestStates/manifest.js`, `lib/IoPlugins.js` |
| Companion CSS convention | Optional stylesheet loaded from the same bundle path with `.js` replaced by `.css`. No separate manifest field exists. | UI path convention | `lib/IoPlugins.js`, `admin/tab/plugin-ui-host.js` |
| Plugin-owned Admin UI i18n | Optional JSON files at `admin-ui/i18n/<lang>.json`. `readAdminUiBundle(...)` falls back from the requested safe language to `en` when needed. | Plugin-owned, consumed by UI path | `lib/IoPlugins.js` |

### Current plugin-owned Admin UI contributors

| Plugin type | Panel id | apiVersion | Bundle entry | Owner | Reference |
| --- | --- | --- | --- | --- | --- |
| `IngestStates` | `presets` | `1` | `admin-ui/dist/presets.esm.js` | Plugin-owned | `lib/IngestStates/manifest.js` |
| `IngestStates` | `bulkapply` | `1` | `admin-ui/dist/bulkapply.esm.js` | Plugin-owned | `lib/IngestStates/manifest.js` |

## UI Invariants

| Contract | Notes | Owner | Reference |
| --- | --- | --- | --- |
| Native panels and plugin bundles do not get the same boundary strength | Native panels receive raw `msghubRequest`, `msghubSocket`, and `ui` in `ctx`. Plugin bundles receive only the narrowed bundle `ctx`. | Boot runtime / plugin UI host | `admin/tab/boot.js`, `admin/tab/plugin-ui-host.js` |
| `host.panels` excludes plugin panel refs | Native panel `ctx.api.host.panels` contains string entries from `composition.panels` with non-string plugin-panel refs removed. In wildcard compositions this array may contain `'*'` rather than expanded panel ids. | Browser API layer | `admin/tab/api.js` |
| `ctx.api.i18n.lang()` is a boot-time snapshot | `createAdminApi(...)` captures `lang` by value. `overrideLang(...)` updates global language state, but existing `ctx.api.i18n.lang()` closures keep the captured value until the API is rebuilt. | Browser API layer | `admin/tab/api.js`, `admin/tab/runtime.js` |
| `runtime.about` updates shell-wide policy | `boot.js` uses `runtime.about` to update branding text, timezone policy, cached connection metadata, and embedded-admin language override. The connection panel still reports the frontend format locale locally, with `args.locale` able to override that browser-side source when valid. | Boot runtime | `admin/tab/boot.js`, `main.js` |
| Timezone fallback is explicit | Missing or invalid runtime timezone metadata becomes a UTC fallback policy and may trigger one warning toast. | Browser API layer / boot runtime | `admin/tab/api.js`, `admin/tab/boot.js` |
| Plugin bundle cache key includes language | Bundle cache identity is `(pluginType, instanceId, panelId, hash, lang)` because the bundle response may contain language-specific i18n payloads. | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| `discover` hash is advisory, `bundle.get` hash is authoritative | `IoAdminTab._pluginUiDiscover()` best-effort computes hashes, but `bundle.get` recomputes the authoritative content hash. | Admin runtime | `lib/IoAdminTab.js` |
| `bundle.get` enforces size limits | JS is limited to 512 KiB. CSS and plugin i18n payloads are limited to 64 KiB each. | Admin runtime | `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| Plugin UI uses Light DOM only | There is no Shadow DOM contract for plugin panels. Companion CSS is injected as a sibling of `ctx.root`, not into `ctx.root` itself. | Plugin UI host | `admin/tab/plugin-ui-host.js` |
| Admin-UI i18n stays separate from backend/runtime i18n | Shell text dictionaries come from `admin/i18n/*`. The repo-root `i18n/*` tree is a separate backend/runtime catalog and is not the source of Admin Tab text. | Browser runtime | `admin/tab/runtime.js` |
| Plugin-panel tabs start disabled | `buildLayoutFromRegistry(...)` renders plugin-panel tabs with `aria-disabled="true"` until `hydratePluginPanels(...)` finds a matching discover contribution. | Layout runtime / boot runtime | `admin/tab/layout.js`, `admin/tab/boot.js` |
| Plugin panel bundles are lazy-mounted | After hydration, the shell mounts a plugin panel only when `msghub:tabSwitch` activates that plugin tab for the first time. | Boot runtime | `admin/tab/boot.js` |
| Shell Escape behavior is global | `Escape` closes the dialog first, then submenu levels or context menu, then the large overlay. `msghub:tabSwitch` also closes overlay, dialog, and context menu. | UI runtime | `admin/tab/ui.js` |
