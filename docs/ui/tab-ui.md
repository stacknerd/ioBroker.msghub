# admin/tab/ui.js: shared UI primitives for toast, menu, overlay, dialog, and spinner behavior

`ui.js` creates the shell-level interaction primitives that both core panels and plugin bundles reuse.
It is deliberately backend-free: the file manages DOM, focus, ARIA state, visibility, and interaction flow,
but it does not own any Message Hub data semantics.

The result of `createUi()` is the visual toolbox behind `ctx.api.ui`.

---

## Where it sits in the system

The module is loaded before [`./tab-boot.md`](./tab-boot.md).
`boot.js` creates one shared UI instance:

```js
const ui = createUi();
```

That instance is then:

- used directly by shell code
- wrapped for native panels via [`./tab-api.md`](./tab-api.md)
- partially exposed to plugin bundles via [`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md)

[`admin/tab.html`](../../admin/tab.html) already contains static hosts for:

- `msghub-toast-host`
- `msghub-overlay-large`
- `msghub-dialog-small`
- `msghub-contextmenu`

The spinner host is different: `msghub-spinner-host` is not present in `admin/tab.html` and is created dynamically by `ui.js`.

---

## Responsibilities

### 1) Toast system

The toast layer supports:

- variants: `ok`, `warning`, `danger`, `neutral`
- auto-close or persistent mode
- named replacement by `id`
- explicit close via `toastClose(id)`
- custom close element injection

Named toasts are important for shell flows such as connection status, where a later toast should replace an earlier one.

### 2) Context menu system

The context menu supports:

- normal items
- separators
- labels
- checkbox items
- nested submenus
- icon slots
- viewport-aware positioning
- outside-click, wheel, scroll, resize, and visibility close triggers

The root menu always includes a branding footer.
Submenus are tracked in a stack so `Escape` can close them level by level.

### 3) Modal overlay and confirm dialog

The file provides two modal primitives:

- `overlayLarge` for large detail views
- `dialog.confirm(...)` for small confirm dialogs

Both restore focus to the previously active element when closed.
Both are closed automatically when the active tab changes.

### 4) Spinner handling

Spinners support two modes:

- non-blocking: persistent toast with spinner ring
- blocking: shared full-screen overlay

Multiple spinners can coexist at the same time.
Blocking visibility remains active until the last blocking spinner is closed.

### 5) Global close behavior

`ui.js` centralizes shell-close behavior for:

- `Escape`
- tab switches
- `closeAll()`

That keeps modal and menu cleanup consistent across native panels and plugin panels.

---

## Public surface / integration points

## `createUi()`

Returns one frozen object with these top-level members:

- `toast(opts)`
- `toastClose(id)`
- `contextMenu`
- `overlayLarge`
- `dialog`
- `spinner`
- `closeAll()`

### `contextMenu`

Supports:

- `open(opts)`
- `close()`
- `isOpen()`
- `setBrandingText(text)`

`open(...)` accepts either an explicit `anchorPoint` or an `anchorEl`.

### `overlayLarge`

Supports:

- `open({ title, bodyEl, bodyText })`
- `close()`
- `isOpen()`

### `dialog`

Supports:

- `confirm(opts) -> Promise<boolean>`
- `close(ok)`
- `isOpen()`

### `spinner`

Supports:

- `show(opts) -> id`
- `hide(id?)`
- `isOpen(id?)`

---

## Design notes / invariants

- `createUi()` returns one frozen facade. Callers should treat it as a long-lived singleton for the page.
- Named toasts replace older toasts with the same ID immediately.
- Non-blocking spinners are implemented as persistent toasts, not as a second visual system.
- Blocking spinners share one overlay host. The overlay stays visible while any blocking spinner remains registered.
- The dialog is single-flight: if one confirm promise is still pending, a new `confirm(...)` call resolves `false` immediately instead of stacking dialogs.
- `Escape` handling is ordered: dialog first, then context menu, then overlay.
- `msghub:tabSwitch` closes overlay, dialog, and context menu so tab changes do not leave stale shell UI on screen.
- Context menu positioning always goes through the clamp/flip helper from [`./tab-api.md`](./tab-api.md).
- The toast, overlay, dialog, and context-menu hosts are reused from [`admin/tab.html`](../../admin/tab.html) when present.
- The spinner host is currently not part of [`admin/tab.html`](../../admin/tab.html); `ui.js` creates it dynamically.

---

## Related files

- Implementation: [`admin/tab/ui.js`](../../admin/tab/ui.js)
- Test: [`admin/tab/ui.test.js`](../../admin/tab/ui.test.js)
- API wrapper that exposes these primitives to panels: [`./tab-api.md`](./tab-api.md)
- Boot integration for shell context-menu behavior: [`./tab-boot.md`](./tab-boot.md)
- HTML infrastructure hosts: [`admin/tab.html`](../../admin/tab.html)
