# admin/tab/panels/messages/data.messages.js: query shaping and enum-aware data access

`admin/tab/panels/messages/data.messages.js` is the data facade for the Messages panel.
It does not render UI and it does not own panel lifecycle decisions. Its job is to convert panel state into backend
query payloads, cache constants, and expose a small enum-aware API to the menu and renderer modules.

In short: this file is the panel-side adapter between Messages state and the backend APIs.

---

## Where it sits in the system

`index.js` creates one data facade per panel instance through `createMessagesDataApi({ api, state, ...helpers })`.
That facade is then shared with:

- [`./tab-panels-messages-entry.md`](./tab-panels-messages-entry.md) for `loadConstants()`, `queryMessagesPage()`, and `deleteMessages()`
- [`./tab-panels-messages-menus.md`](./tab-panels-messages-menus.md) for filter state reads and writes
- [`./tab-panels-messages-render.header.md`](./tab-panels-messages-render.header.md) for filter option lists and enum metadata
- [`./tab-panels-messages-overlay.json.md`](./tab-panels-messages-overlay.json.md) and [`./tab-panels-messages-render.table.md`](./tab-panels-messages-render.table.md) for level label resolution

The backend-facing methods use `ctx.api.constants` and `ctx.api.messages`.

---

## Responsibilities

1. Resolve and cache constants data.
   - `loadConstants()` calls `api.constants.get()`.
   - The result is stored in `state.constants`.
   - If a `lifecycle.state` enum is present, the default lifecycle filter is rebuilt from the canonical keys `acked`, `closed`, `open`, and `snoozed`.

2. Turn UI filter state into backend query payloads.
   - `buildWhereFromFilters()` reads the current filter sets and produces the `where` object passed to `api.messages.query(...)`.
   - It knows the dotted field paths used by the Messages panel: `kind`, `lifecycle.state`, `level`, `origin.system`, and `details.location`.

3. Provide enum-aware helpers for labels and option lists.
   - `getConstantsEnum()`, `listEnumValues()`, `listEnumKeys()`
   - `getLevelLabel()` and `getLevelNumber()`
   - `listDistinctFromItems(path)` for filter options discovered from the currently loaded page
   - `renderFilterValueLabel(filterKey, value)` for user-facing menu labels

4. Expose the backend calls used by the panel.
   - `queryMessagesPage()` wraps `api.messages.query(...)`.
   - `deleteMessages(refs)` wraps `api.messages.delete(refs)`.

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabMessagesDataMessages = {
  createMessagesDataApi
}
```

`createMessagesDataApi(...)` returns a frozen facade with these methods:

- `getFilterSet(key)`
- `setFilterSet(key, nextSet)`
- `getConstantsEnum(path)`
- `listEnumValues(enumObj)`
- `listEnumKeys(enumObj)`
- `getLevelLabel(level)`
- `getLevelNumber(label)`
- `listDistinctFromItems(path)`
- `buildWhereFromFilters()`
- `renderFilterValueLabel(filterKey, value)`
- `loadConstants()`
- `queryMessagesPage()`
- `deleteMessages(refs)`

The query method currently sends a payload with:

```js
{
  query: {
    where,
    page: { index: state.pageIndex, size: state.pageSize },
    sort: [{ field: state.sortField, dir: state.sortDir }]
  }
}
```

---

## Design notes / invariants

- The facade is stateful only through the shared `state` object. It does not keep a second copy of paging, filters, or items.
- Filter semantics are column-specific:
  - `kind` maps to `where.kind.in`
  - `lifecycle.state` maps to `where.lifecycle.state.in`
  - `level` values are converted from labels to numbers before they are sent
  - `origin.system` and `details.location` map into nested `where` objects
- An empty lifecycle filter set is treated specially. It does not mean “match nothing”.
  Instead, the query expands to all known lifecycle states, using constants when available and otherwise falling back to
  `open`, `acked`, `closed`, `snoozed`, `deleted`, and `expired`.
- `renderFilterValueLabel()` only localizes known filter families. Unknown filter keys fall back to the raw string.
- If `loadConstants()` fails, `state.constants` is reset to `null`. The panel can still function with reduced enum help.

---

## Related files

- Implementation: `admin/tab/panels/messages/data.messages.js`
- Test: `admin/tab/panels/messages/data.messages.test.js`
- Panel entry: [`./tab-panels-messages-entry.md`](./tab-panels-messages-entry.md)
- Header renderer: [`./tab-panels-messages-render.header.md`](./tab-panels-messages-render.header.md)
- Menus: [`./tab-panels-messages-menus.md`](./tab-panels-messages-menus.md)
- Admin frontend overview: `docs/ui/README.md`
