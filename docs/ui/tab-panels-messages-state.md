# admin/tab/panels/messages/state.js: canonical state and shared helpers

`admin/tab/panels/messages/state.js` is the lowest-level utility module of the Messages panel.
It creates the canonical panel state object and exposes a small set of stateless helpers that the other
Messages modules reuse instead of duplicating their own copies.

In short: this file defines what one Messages panel instance can remember.

---

## Where it sits in the system

`state.js` is loaded first in the Messages panel asset list. `index.js` uses it as the starting point for panel
construction and passes the resulting state object into the data, menu, renderer, and lifecycle modules.

It is therefore a shared dependency of the whole Messages panel cluster:

- [`./tab-panels-messages-index.md`](./tab-panels-messages-index.md) creates the state object, injects the active timestamp formatter, and forwards `ctx.args?.expert`.
- [`./tab-panels-messages-data.messages.md`](./tab-panels-messages-data.messages.md) stores constants, loaded items, pagination, and filters in this state object.
- The renderers and menu module read and mutate selection, sorting, and paging fields.
- [`./tab-panels-messages-lifecycle.md`](./tab-panels-messages-lifecycle.md) uses the auto-refresh and archive-mode fields.

---

## Responsibilities

1. Create the canonical mutable state for one panel instance.
   - Loading flags, request sequencing, current items, totals, metadata, pagination, sorting, and column filters.
   - Expert-mode selection fields and table column count.
   - Archive-related fields that already exist in the contract, even though the archive UI path is not active in normal use.

2. Provide shared helper functions.
   - `isObject(value)` for plain-object checks.
   - `safeStr(value)` for null-safe string conversion.
   - `pick(obj, path)` for dotted-path access.

3. Provide timestamp formatting and expert-mode detection.
   - `formatTs(ts)` uses an injected formatter when one is registered.
   - `detectExpertMode(argsExpert?)` resolves expert mode additively from URL args, session storage, and `_system`.

---

## Public surface / integration points

The module exports one frozen global:

```js
window.MsghubAdminTabMessagesState = {
  createMessagesState,
  detectExpertMode,
  isObject,
  safeStr,
  pick,
  formatTs,
  setFormatTsFormatter
}
```

The most important entry point is `createMessagesState()`. The returned object currently includes:

- refresh and loading state: `autoRefreshMs`, `loading`, `silentLoading`, `autoRefresh`, `autoTimer`
- request bookkeeping: `requestSeq`, `hasLoadedOnce`
- current data snapshot: `constants`, `items`, `total`, `pages`, `lastMeta`, `serverTz`
- query state: `pageIndex`, `pageSize`, `sortField`, `sortDir`, `columnFilters`
- expert mode state: `expertMode`, `selectedRefs`, `syncSelectionUI`, `suppressRowClickUntil`, `headerSelectAllInput`, `tableColCount`
- archive contract state: `archiveMode`, `archiveEdgeOldest`, `archiveEdgeNewest`, `archiveHasMoreBackward`, `archiveHasMoreForward`, `archivePendingNewCount`, `archiveActiveRef`, `archiveItemsByRef`

`setFormatTsFormatter(formatter)` updates a module-global formatter function. `index.js` injects `api.time.formatTs`
through this hook so every Messages submodule sees the same timestamp formatting policy.

`detectExpertMode(argsExpert?)` uses additive semantics:

1. `argsExpert === true` forces expert mode on
2. otherwise `sessionStorage['App.expertMode'] === 'true'`
3. otherwise `window._system.expertMode` or `window.top._system.expertMode`

`false` from the URL does not disable host/session expert mode.

---

## Design notes / invariants

- `createMessagesState()` is the canonical source of default values for this panel. Other Messages submodules assume these keys exist.
- The default sort is always `timing.createdAt desc`.
- The default page size is `50`.
- The default lifecycle filter is not "all states". It is a set with `acked`, `closed`, `open`, and `snoozed`.
  `deleted` and `expired` are excluded from the initial filter.
- `columnFilters` is created via `Object.create(null)`, so it intentionally has no prototype keys.
- `selectedRefs` is a `Set` and `archiveItemsByRef` is a `Map`. Their collection semantics are part of the live state contract.
- `formatTs(ts)` returns `''` for invalid timestamps. Without an injected formatter it falls back to `Intl.DateTimeFormat` in UTC.
- `detectExpertMode()` is best-effort. Host access failures are caught and treated as "not in expert mode".
- The URL flag is additive only. `true` forces expert mode on, while `false` does not disable host-provided expert mode.

---

## Related files

- Implementation: [`admin/tab/panels/messages/state.js`](../../admin/tab/panels/messages/state.js)
- Test: [`admin/tab/panels/messages/state.test.js`](../../admin/tab/panels/messages/state.test.js)
- Panel entry: [`./tab-panels-messages-index.md`](./tab-panels-messages-index.md)
- Data facade: [`./tab-panels-messages-data.messages.md`](./tab-panels-messages-data.messages.md)
- Lifecycle: [`./tab-panels-messages-lifecycle.md`](./tab-panels-messages-lifecycle.md)
- Admin frontend overview: [`./README.md`](./README.md)
