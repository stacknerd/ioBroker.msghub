# admin/tab/panels/messages/index.js: messages panel entry and coordinator

`admin/tab/panels/messages/index.js` is the orchestration layer for the native Messages panel in the Admin tab.
It does not own one isolated concern. Instead, it wires the panel submodules together, provides the shared action
handlers, drives loading and rendering, and returns the lifecycle hook that `boot.js` calls on connect.

In short: this file turns the individual Messages submodules into one working panel instance.

---

## Where it sits in the system

The Messages panel is registered as a native panel in the backend UI registry (`lib/IoUiRegistry.js`). Its asset list loads the Messages
submodules in a fixed order and ends with `admin/tab/panels/messages/index.js`. After that, `boot.js` calls the
panel initializer through the global `window.MsghubAdminTabMessages`.

Inside the panel, `index.js` sits above the specialized submodules:

- [`./tab-panels-messages-state.md`](./tab-panels-messages-state.md) provides the shared mutable state and common helpers.
- [`./tab-panels-messages-data.messages.md`](./tab-panels-messages-data.messages.md) shapes backend queries and enum lookups.
- [`./tab-panels-messages-data.archive.md`](./tab-panels-messages-data.archive.md) normalizes archive paging contracts.
- [`./tab-panels-messages-overlay.json.md`](./tab-panels-messages-overlay.json.md) and [`./tab-panels-messages-overlay.archive.md`](./tab-panels-messages-overlay.archive.md) provide large-overlay views.
- [`./tab-panels-messages-menus.md`](./tab-panels-messages-menus.md) owns header and row context menus.
- [`./tab-panels-messages-render.meta.md`](./tab-panels-messages-render.meta.md), [`./tab-panels-messages-render.header.md`](./tab-panels-messages-render.header.md), and [`./tab-panels-messages-render.table.md`](./tab-panels-messages-render.table.md) render the panel shell and table.
- [`./tab-panels-messages-lifecycle.md`](./tab-panels-messages-lifecycle.md) schedules auto refresh and reacts to visibility changes.

---

## Responsibilities

1. Build one panel instance from the loaded globals.
   - `init(ctx)` verifies that all required Messages globals exist.
   - It creates the shared state object, injects the timestamp formatter into the state module, and constructs the data, menu, overlay, renderer, and lifecycle facades.

2. Own the active panel workflow.
   - It mounts the static shell, renders the table header, and performs the full render pass after state changes.
   - It runs `loadConstants()` and `loadMessages()` and keeps loading, pagination, selection, and metadata state coherent.
   - Load failures are surfaced through shell toasts; there is no inline error area in the panel shell.

3. Provide the panel-level action handlers.
   - Toolbar actions: refresh, delete selection, toggle auto refresh, change page, change page size.
   - Row actions: execute core actions after confirmation, open JSON overlay, open archive overlay, open validated link actions.
   - Clipboard copying for row and overlay context menus.

4. Bridge the panel to the shell lifecycle.
   - The returned `onConnect()` loads constants, loads the current messages page, and then starts auto refresh scheduling.
   - `index.js` also binds the lifecycle listeners immediately during initialization.

5. Apply additive expert-mode handling inside the panel.
   - `ctx.args?.expert` is forwarded to `detectExpertMode(...)`.
   - The forwarding happens once during initialization and again in the 1500 ms polling loop.
   - URL expert mode adds to host/session expert mode; it does not replace or suppress it.

---

## Public surface / integration points

The module exports one frozen global:

```js
window.MsghubAdminTabMessages = {
  init(ctx)
}
```

`init(ctx)` expects the native panel init context assembled by `boot.js`, especially:

- `ctx.api` with `i18n`, `messages`, `constants`, `time`, and `ui`
- `ctx.args` for optional runtime flags such as `expert`
- `ctx.h` as the DOM helper used across the Admin tab
- `ctx.elements.messagesRoot` as the mount point

The return value is a panel lifecycle handle with:

```js
{
  onConnect: async () => { ... }
}
```

Important internal integration points:

- `state.syncSelectionUI` is assigned by `index.js`, because selection updates need access to live table DOM.
- `menus.js`, `render.table.js`, and `render.header.js` all call back into `index.js` through selection and query-change hooks.
- The lifecycle module uses `loadMessages({ keepPopover: true, silent: true })` for follow-mode refreshes.

---

## Design notes / invariants

- Initialization is strict. Missing `messagesRoot` or any required submodule causes an immediate error instead of a partial panel.
- Request ordering is guarded by `state.requestSeq`. Older `loadMessages()` responses are ignored if a newer request has already started.
- The first render path is intentionally different from later refreshes:
  - before the first successful load, a loading row is rendered
  - during later silent refreshes, the existing rows stay visible
- The panel shell intentionally stays mounted during failures. The coordinator reports load problems via toast instead of replacing the shell with an error banner.
- Expert mode is polled, not event-driven. `detectExpertMode(ctx.args?.expert)` is applied once immediately and then every 1500 ms.
- Selection is tied to the currently visible rows. After each row render, `pruneSelectionToVisibleRows()` removes selections that no longer exist in the current tbody.
- The archive overlay is wired, but the normal row menu keeps the archive action disabled by passing `isArchiveActionEnabled: () => false`.
- `onConnect()` is the point where the panel starts talking to the backend. `init(ctx)` alone only builds the local panel instance.

---

## Related files

- Implementation: [`admin/tab/panels/messages/index.js`](../../admin/tab/panels/messages/index.js)
- Test: [`admin/tab/panels/messages/index.test.js`](../../admin/tab/panels/messages/index.test.js)
- State: [`./tab-panels-messages-state.md`](./tab-panels-messages-state.md)
- Data facade: [`./tab-panels-messages-data.messages.md`](./tab-panels-messages-data.messages.md)
- Lifecycle: [`./tab-panels-messages-lifecycle.md`](./tab-panels-messages-lifecycle.md)
- Admin frontend overview: [`./README.md`](./README.md)
