# admin/tab/panels/messages/data.archive.js: archive paging normalization facade

`admin/tab/panels/messages/data.archive.js` is the archive-specific data adapter for the Messages panel.
Its scope is intentionally narrow: normalize archive cursor data, call whichever archive paging API is available,
and return a stable response shape to the rest of the panel.

In short: this file defines the browser-side contract for message archive paging.

---

## Where it sits in the system

`index.js` creates the archive data facade once per panel instance and currently uses it only for cursor-edge
normalization when the archive overlay is opened. The normal row menu keeps the archive action disabled, so this module
is present in the loaded panel but not reachable through the standard user flow.

This module belongs to the archive side of the Messages cluster:

- [`./tab-panels-messages-index.md`](./tab-panels-messages-index.md) constructs the facade and uses `normalizeCursorEdge(...)`.
- [`./tab-panels-messages-overlay.archive.md`](./tab-panels-messages-overlay.archive.md) is the current archive view component.

---

## Responsibilities

1. Normalize archive cursor edges.
   - `normalizeCursorEdge(edge)` accepts `{ ts, tie }`-like input.
   - `ts` is coerced to a finite integer.
   - `tie` is coerced to a string.
   - Invalid edges become `null`.

2. Normalize archive page responses.
   - `normalizePageResponse(response)` accepts both wrapper-style and direct payloads.
   - It always returns `{ ok, data, error }` with normalized `items`, `edgeOldest`, and `edgeNewest`.

3. Resolve and call the active archive paging backend.
   - `pageArchive(params)` prefers `api.archive.page`.
   - If that is missing, it falls back to `api.messages.archivePage`.
   - If neither exists, it delegates to `api.notSupported('messages.archive.page')` when available, which throws a typed `NotSupportedError`. If `api.notSupported` is not available, it throws a plain `Error` instead.

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabMessagesDataArchive = {
  createArchiveDataApi,
  normalizeCursorEdge
}
```

`createArchiveDataApi({ api })` returns a frozen facade with:

- `pageArchive(params)`
- `normalizeCursorEdge(edge)`

The `pageArchive(...)` input currently supports:

- `ref`
- `direction` (`'backward'` by default, `'forward'` when explicitly requested)
- `before`
- `after`
- `limit`
- `includeRaw`

The normalized response shape is:

```js
{
  ok,
  data: {
    items,
    hasMoreBackward,
    hasMoreForward,
    edgeOldest,
    edgeNewest
  },
  error
}
```

---

## Design notes / invariants

- Cursor normalization is strict about `ts` and lenient about `tie`.
  A missing or invalid timestamp invalidates the whole edge; `tie` is stringified.
- `normalizeArchiveItem(item)` preserves the original item object shape and adds normalized `ts` and `__cursor` fields.
  `ts` is coerced to a finite integer when possible; if normalization fails, the raw value is preserved unchanged.
  `__cursor` is normalized via `normalizeCursorEdge` or falls back to the raw field or `null`.
- `pageArchive(...)` always truncates finite numeric limits to integers.
- The module does not manage archive UI state. It only normalizes inputs and outputs for callers.
- The archive contract already exists in the frontend code, but the current Messages row menu passes `isArchiveActionEnabled: () => false`,
  so this path is not active during normal panel use.

---

## Related files

- Implementation: `admin/tab/panels/messages/data.archive.js`
- Test: `admin/tab/panels/messages/data.archive.test.js`
- Panel entry: [`./tab-panels-messages-index.md`](./tab-panels-messages-index.md)
- Archive overlay: [`./tab-panels-messages-overlay.archive.md`](./tab-panels-messages-overlay.archive.md)
- Admin frontend overview: `docs/ui/README.md`
