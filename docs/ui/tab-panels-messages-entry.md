# admin/tab/panels/messages/entry.js: host-owned entry for the Messages core panel

`admin/tab/panels/messages/entry.js` is the active host-owned bootstrap document for the Messages core panel.
It publishes the panel-owned asset lists and the required `panelInit(ctx)` function, then wires the already-loaded
Messages submodules into one working panel instance.

In short: this file is both the technical boot contract for the Messages core panel and the panel-local coordinator
that turns the Messages submodules into a usable runtime section.

---

## Where it sits in the system

The Messages panel now boots through the host-owned convention:

1. The backend view contract exposes the core panel only as `'messages'`.
2. [`./tab-core-panel-bootstrap.md`](./tab-core-panel-bootstrap.md) resolves `admin/tab/panels/messages/entry.js`.
3. The helper returns this entry definition with `{ css, js, panelInit(ctx) }`.
4. [`./tab-boot.md`](./tab-boot.md) loads the declared Messages assets and then calls `panelInit(ctx)`.
5. `panelInit(ctx)` validates all Messages submodule globals, builds the panel shell, and returns the lifecycle handle.

This file therefore replaces the previous global panel-entry contract.

---

## Responsibilities

### 1) Publish the Messages bootstrap contract

The exported entry definition owns:

- `css`: the Messages panel stylesheet list
- `js`: the ordered Messages submodule script list
- `panelInit(ctx)`: the only remaining init contract for the Messages core panel

The asset list still matters because the panel submodules are classic scripts that register their local factories
on `window.*`. `panelInit(ctx)` runs only after those submodules were loaded.

### 2) Build one Messages panel instance

`panelInit(ctx)`:

- validates `ctx.elements.messagesRoot`
- validates the required Messages submodule globals
- creates the shared Messages panel state
- creates the data, overlay, menu, renderer, and lifecycle facades
- mounts the static panel shell and performs the initial render

### 3) Own the panel-local workflow

Inside the panel instance, the entry coordinates:

- list loading and request ordering
- bulk deletion
- action execution with confirmation
- JSON and archive overlays
- selection synchronization
- expert-mode toggling
- auto-refresh lifecycle wiring

### 4) Expose the lifecycle handle back to the shell

The current Messages lifecycle handle contains:

```js
{
  onConnect: async () => { ... }
}
```

`onConnect()` loads constants, loads the current messages page, and arms auto refresh.

---

## Public surface / integration points

### Entry definition

The entry assigns one frozen definition to `document.currentScript.__msghubCorePanelEntry`:

```js
{
  css: ['tab/panels/messages/styles.css'],
  js: [
    'tab/panels/messages/state.js',
    'tab/panels/messages/data.messages.js',
    'tab/panels/messages/data.archive.js',
    'tab/panels/messages/overlay.json.js',
    'tab/panels/messages/overlay.archive.js',
    'tab/panels/messages/menus.js',
    'tab/panels/messages/render.table.js',
    'tab/panels/messages/render.header.js',
    'tab/panels/messages/render.meta.js',
    'tab/panels/messages/lifecycle.js',
  ],
  panelInit(ctx)
}
```

### `panelInit(ctx)`

`panelInit(ctx)` expects the normal AdminTab core panel context, especially:

- `ctx.api`
- `ctx.h`
- `ctx.ui`
- `ctx.args`
- `ctx.elements.messagesRoot`

The returned handle is consumed only by [`./tab-boot.md`](./tab-boot.md).

### Important internal helpers

The entry also owns the local helpers that are not exported separately:

- `copyTextToClipboard(...)`
- `syncSelectionUi()`
- `updateSelectAllCheckboxState()`
- `pruneSelectionToVisibleRows()`
- `openArchiveOverlay(ref)`
- `loadMessages(...)`
- `handleDeleteSelection()`
- `applyExpertMode(next)`

Those helpers exist only inside the Messages panel instance and are not shell APIs.

---

## Design notes / invariants

- This file is the **active core panel entry**. There is no legacy global wrapper path left.
- `panelInit(ctx)` is strict: missing root/container or missing submodule globals fail immediately.
- Request ordering is guarded through `state.requestSeq`; stale responses are ignored.
- Selection is tied to the current visible tbody rows and is pruned after each row render.
- Expert mode is additive and polled from the shared state helpers, not event-driven.
- The panel shell stays mounted during load failures; user-facing failures are surfaced through the shared UI primitives.

---

## Related files

- Implementation: [`admin/tab/panels/messages/entry.js`](../../admin/tab/panels/messages/entry.js)
- Bootstrap resolver: [`./tab-core-panel-bootstrap.md`](./tab-core-panel-bootstrap.md)
- Boot consumer: [`./tab-boot.md`](./tab-boot.md)
- State module: [`./tab-panels-messages-state.md`](./tab-panels-messages-state.md)
- Data facade: [`./tab-panels-messages-data.messages.md`](./tab-panels-messages-data.messages.md)
- Lifecycle module: [`./tab-panels-messages-lifecycle.md`](./tab-panels-messages-lifecycle.md)
