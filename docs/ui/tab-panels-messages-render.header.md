# admin/tab/panels/messages/render.header.js: table header, colgroup, and header-state updates

`admin/tab/panels/messages/render.header.js` renders the Messages table header and maintains the visible header state.
That includes the colgroup definition, sort/filter buttons, badge updates, and the select-all checkbox used in expert mode.

In short: this file owns the table header structure and the header-side selection affordances.

---

## Where it sits in the system

`index.js` creates the header renderer after the meta renderer, because the header renderer needs direct access to
the `colgroup`, `thead`, and `tbody` elements created by [`./tab-panels-messages-render.meta.md`](./tab-panels-messages-render.meta.md).

It uses:

- shared state from [`./tab-panels-messages-state.md`](./tab-panels-messages-state.md)
- enum and option helpers from [`./tab-panels-messages-data.messages.md`](./tab-panels-messages-data.messages.md)
- menu opening functions from [`./tab-panels-messages-menus.md`](./tab-panels-messages-menus.md)

---

## Responsibilities

1. Render the header structure.
   - `renderThead()` rebuilds the colgroup and thead according to the current expert-mode state.
   - It inserts the optional select column only in expert mode.

2. Build the header interaction targets.
   - Sort-only columns get sort buttons.
   - Filter columns get combined sort/filter buttons with badge placeholders.
   - Clicking or right-clicking the surrounding `<th>` opens the same menu as clicking the embedded button.

3. Maintain header-side state.
   - `updateHeaderButtons()` refreshes filter counts and active sort direction markers.
   - The expert-mode select-all checkbox updates `state.selectedRefs` from the currently rendered tbody rows.

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabMessagesRenderHeader = {
  createHeaderRenderer
}
```

`createHeaderRenderer(options)` returns:

```js
{
  renderThead(),
  updateHeaderButtons()
}
```

Important options:

- `h`, `t`
- `state`
- `dataApi`
- `menusApi`
- `colgroupEl`, `theadEl`, `tbodyEl`
- `onSelectionChanged`

The current column model is:

- optional `select` column in expert mode
- `icon`
- `title`
- `text`
- `location`
- `kind`
- `level`
- `lifecycle`
- `created`
- `updated`
- `origin`
- `progress`

---

## Design notes / invariants

- `state.tableColCount` is set here and is part of the shared render contract used by the meta renderer for loading rows.
- The table has `11` columns in normal mode and `12` in expert mode.
- The header button registry (`headerBtns`) is rebuilt on each `renderThead()` call. Later state updates rely on that fresh registry.
- The column model is paired with responsive CSS rules in `styles.css`: lower-priority columns are hidden at narrower breakpoints, and under `750px` the table wrapper becomes a horizontal scroll container instead of squeezing content into unreadable widths.
- Sort/filter support is column-specific:
  - sort-only: `icon`, `title`, `text`, `timing.createdAt`, `timing.updatedAt`, `progress.percentage`
  - filter-capable: `details.location`, `kind`, `level`, `lifecycle.state`, `origin.system`
- Ctrl-right-click bypasses the custom menu opening logic when clicking directly on the sort or filter button.
  Ctrl-right-clicking the surrounding `<th>` area (outside the button) still opens the custom menu, because the
  `<th>` wrapper always calls `preventDefault()` and dispatches a synthetic contextmenu event, without `ctrlKey`, to the button.
- The select-all checkbox operates on the rows that are actually present in the current tbody, not on the full backend result set.

---

## Related files

- Implementation: `admin/tab/panels/messages/render.header.js`
- Test: `admin/tab/panels/messages/render.header.test.js`
- Panel entry: [`./tab-panels-messages-entry.md`](./tab-panels-messages-entry.md)
- Meta renderer: [`./tab-panels-messages-render.meta.md`](./tab-panels-messages-render.meta.md)
- Menus: [`./tab-panels-messages-menus.md`](./tab-panels-messages-menus.md)
- Admin frontend overview: `docs/ui/README.md`
