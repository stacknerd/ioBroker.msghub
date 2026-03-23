# admin/tab/panels/messages/menus.js: header, row, and overlay context menus

`admin/tab/panels/messages/menus.js` owns the context-menu layer of the Messages panel.
It translates state and message payloads into menu trees and routes the selected action back into panel callbacks.

In short: this file is the command surface behind header menus, row menus, and JSON-overlay copy menus.

---

## Where it sits in the system

`index.js` creates one menu facade and passes it to:

- [`./tab-panels-messages-render.header.md`](./tab-panels-messages-render.header.md) for sort and filter header menus
- [`./tab-panels-messages-render.table.md`](./tab-panels-messages-render.table.md) for per-row context menus
- [`./tab-panels-messages-overlay.json.md`](./tab-panels-messages-overlay.json.md) for the overlay copy menu

The menu module depends on:

- shared panel state
- the data facade for filter reads and writes
- `ctx.api.ui.contextMenu`
- callbacks supplied by `index.js` for query changes, JSON opening, archive opening, copying, action execution, and link opening

---

## Responsibilities

1. Build the header sort menu.
   - `openHeaderSortMenu(anchor, { field })` offers ascending and descending sort directions.
   - Selecting one direction updates `state.sortField` and `state.sortDir`, resets `pageIndex` to `1`, closes the menu, and triggers `onQueryChanged()`.

2. Build the header filter menu.
   - `openHeaderFilterMenu(anchor, { key, options, selected, autoOpenSubmenu })` renders a checkbox submenu for the given column.
   - For sortable filter columns, the menu also exposes sort controls.
   - “Select all” and “select none” rebuild the submenu state and then reopen it.

3. Build row and overlay copy menus.
   - `buildCopyMenuItems(msg)` creates copy actions for JSON, ref, title, and text.
   - `openJsonOverlayContextMenu(event, msg)` reuses those items in the large JSON overlay.

4. Build the row context menu.
   - `openRowContextMenu(event, msg)` combines JSON, archive, action, and copy entries.
   - The actions submenu includes supported core actions and valid HTTP(S) link actions from `msg.actions`.

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabMessagesMenus = {
  createMessagesMenus
}
```

`createMessagesMenus(options)` returns a frozen facade with:

- `openHeaderSortMenu(anchor, payload)`
- `openHeaderFilterMenu(anchor, payload)`
- `openRowContextMenu(event, msg)`
- `openJsonOverlayContextMenu(event, msg)`

Important options passed in by `index.js`:

- `ui`, `t`, `state`, `dataApi`
- `onQueryChanged`
- `openMessageJson`
- `openArchiveOverlay`
- `copyTextToClipboard`
- `safeStr`, `pick`
- optional `isArchiveActionEnabled`
- optional `onActionExecute`
- optional `onLinkOpen`

---

## Design notes / invariants

- Sorting and filtering are state mutations, not direct backend calls. The actual reload is always delegated through `onQueryChanged()`.
- Header filter menus operate on `Set` values stored in `state.columnFilters`.
- The submenu item id format for filter menus is `messages-filter:${filterKey}`.
- Archive actions are feature-gated. The item can be present in the row menu, but it is disabled unless `isArchiveActionEnabled(msg) === true`.
- Link actions are accepted only when their payload contains an `http://` or `https://` URL in `url`, `href`, or `link`.
- Missing callbacks are tolerated. For example, action submenu items can exist without an `onSelect` handler when no execution callback was supplied.
- Copy actions show an `ok` toast only after the copy promise resolves successfully.

---

## Related files

- Implementation: `admin/tab/panels/messages/menus.js`
- Test: `admin/tab/panels/messages/menus.test.js`
- Panel entry: [`./tab-panels-messages-index.md`](./tab-panels-messages-index.md)
- Header renderer: [`./tab-panels-messages-render.header.md`](./tab-panels-messages-render.header.md)
- Table renderer: [`./tab-panels-messages-render.table.md`](./tab-panels-messages-render.table.md)
- JSON overlay: [`./tab-panels-messages-overlay.json.md`](./tab-panels-messages-overlay.json.md)
- Admin frontend overview: `docs/ui/README.md`
