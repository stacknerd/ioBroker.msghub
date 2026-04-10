# admin/tab/panels/messages/render.table.js: table row renderer and row interaction logic

`admin/tab/panels/messages/render.table.js` renders the body rows of the Messages table.
Besides DOM creation, it also owns the row-level interaction rules: selection behavior, context-menu handling,
and JSON opening on double-click.

In short: this file defines what one visible message row looks like and how row interactions behave.

---

## Where it sits in the system

`index.js` creates the table renderer after the menu and overlay facades are available. During each render pass,
`index.js` calls `tableApi.renderRows(state.items)` and hands the resulting rows to the meta renderer for tbody replacement.

The renderer depends on:

- shared state from [`./tab-panels-messages-state.md`](./tab-panels-messages-state.md)
- level labels from [`./tab-panels-messages-data.messages.md`](./tab-panels-messages-data.messages.md)
- row-menu callbacks from [`./tab-panels-messages-menus.md`](./tab-panels-messages-menus.md)
- JSON opening from [`./tab-panels-messages-overlay.json.md`](./tab-panels-messages-overlay.json.md)

---

## Responsibilities

1. Render the visible row cells.
   - Optional expert-mode selection checkbox
   - Icon, title, text, location, kind, level, lifecycle, created, updated, origin, progress

2. Apply row selection rules.
   - Non-expert mode behaves like a single-selection view with click-to-toggle and right-click-to-select.
   - Expert mode behaves like a multi-selection view with checkbox support and file-manager-style context selection.

3. Route row interactions.
   - Double-click opens the JSON overlay.
   - Right-click opens the custom row context menu unless Ctrl is pressed.
   - Interactive child controls are excluded from row click handling.

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabMessagesRenderTable = {
  createTableRenderer
}
```

`createTableRenderer(options)` returns:

```js
{
  renderRows(items)
}
```

Important options:

- `h`
- `api`
- `state`
- `safeStr`, `pick`, `formatTs`
- `getLevelLabel`
- `openMessageJson`
- `openRowContextMenu`
- `onSelectionChanged`

`renderRows(items)` returns an array of `<tr>` elements ready to be inserted into the tbody.

---

## Design notes / invariants

- The visible column set must stay aligned with `state.tableColCount`, which is managed by the header renderer.
- Column visibility is intentionally partly CSS-driven: the messages table hides lower-priority columns at narrower breakpoints and switches to horizontal scrolling below `750px` instead of shrinking content into broken layouts.
- Selection rules differ intentionally by mode:
  - non-expert click toggles between “only this row” and “none”
  - non-expert contextmenu selects the row if needed, but does not toggle it off
  - expert click toggles membership in `state.selectedRefs`
  - expert contextmenu preserves existing selection when the row is already selected
- Right-click stores `state.suppressRowClickUntil = Date.now() + 500` so the row does not immediately re-handle the follow-up click.
- Interactive descendants are detected through `closest('input, button, a, select, textarea, label')` and bypass row selection logic.
- Progress percentages are clamped to `0..100` before rendering the `<progress>` element and the visible text.
- The renderer does not fetch data and it does not patch the tbody directly. It only returns rows.

---

## Related files

- Implementation: `admin/tab/panels/messages/render.table.js`
- Test: `admin/tab/panels/messages/render.table.test.js`
- Panel entry: [`./tab-panels-messages-entry.md`](./tab-panels-messages-entry.md)
- Header renderer: [`./tab-panels-messages-render.header.md`](./tab-panels-messages-render.header.md)
- Menus: [`./tab-panels-messages-menus.md`](./tab-panels-messages-menus.md)
- Admin frontend overview: `docs/ui/README.md`
