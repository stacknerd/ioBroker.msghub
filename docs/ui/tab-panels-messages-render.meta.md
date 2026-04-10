# admin/tab/panels/messages/render.meta.js: panel shell, toolbar, paging, and status areas

`admin/tab/panels/messages/render.meta.js` renders the non-row part of the Messages panel.
It creates the toolbar, table-tools row, paging controls, metadata, empty state, and the table shell that the other
renderers use.

In short: this file provides the stable DOM frame around the Messages table body.

---

## Where it sits in the system

`index.js` creates the meta renderer before the header and table renderers, because it is the module that creates
the table DOM nodes they need.

The renderer receives only callbacks and shared state. It does not call backend APIs directly. That makes it the
view/controller layer for panel shell interactions, while `index.js` stays responsible for the actual load logic.

---

## Responsibilities

1. Build and mount the static panel shell.
   - Toolbar with refresh, auto refresh, delete, paging, and page-size controls
   - One-line metadata area
   - Table-tools row with meta, paging, and page-size controls
   - Table wrapper with `table`, `colgroup`, `thead`, and `tbody`
   - Empty-state area

2. Keep global panel controls in sync with shared state.
   - `updateButtons()` updates refresh and auto-refresh controls.
   - `updateDeleteButton()` applies expert-mode visibility, count text, and disabled state.
   - `updatePaging()` updates page info and button visibility/disabled state.

3. Render non-row status content.
   - `setMeta({ generatedAtText, timeZone, source })`
   - `setEmptyVisible(visible)`
   - `updateTbody(rows, { showLoadingRow })`

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabMessagesRenderMeta = {
  createMetaRenderer
}
```

`createMetaRenderer(options)` returns a facade with:

- `mount(root)`
- `updateDeleteButton()`
- `updatePaging()`
- `updateButtons()`
- `setMeta(meta)`
- `setEmptyVisible(visible)`
- `updateTbody(rows, options)`
- `elements`

`elements` exposes the live DOM references that other modules need, especially:

- `refreshBtn`, `deleteBtn`, `autoBtn`
- `firstBtn`, `prevBtn`, `nextBtn`, `lastBtn`, `pageInfoEl`
- `pageSizeSelect`
- `tableEl`, `colgroupEl`, `theadEl`, `tbodyEl`

The page-size select currently offers: `10`, `25`, `50`, `100`, `250`.

---

## Design notes / invariants

- `mount(root)` writes the shell in a fixed order: toolbar, table tools, table wrapper, empty state.
- The delete button is both hidden and disabled outside expert mode.
- In expert mode, the delete button label includes the current visible selection count as `(<n>)` when at least one row is selected.
- The refresh button is disabled only for non-silent loading. During silent loading it stays present and gets a loading class instead.
- First/last paging buttons are only shown when `pages >= 10`.
- `setMeta(...)` renders one visible line but stores time zone and source details in the `title` tooltip.
- `updateTbody([], { showLoadingRow: true })` inserts a loading row whose `colspan` comes from `state.tableColCount`.
- Load failures are surfaced by the panel coordinator as toasts; this renderer keeps the shell visible instead of owning an inline error banner.

---

## Related files

- Implementation: `admin/tab/panels/messages/render.meta.js`
- Test: `admin/tab/panels/messages/render.meta.test.js`
- Panel entry: [`./tab-panels-messages-entry.md`](./tab-panels-messages-entry.md)
- Header renderer: [`./tab-panels-messages-render.header.md`](./tab-panels-messages-render.header.md)
- Table renderer: [`./tab-panels-messages-render.table.md`](./tab-panels-messages-render.table.md)
- Admin frontend overview: `docs/ui/README.md`
