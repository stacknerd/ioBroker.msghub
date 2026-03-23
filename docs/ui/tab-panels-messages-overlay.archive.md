# admin/tab/panels/messages/overlay.archive.js: archive timeline overlay shell

`admin/tab/panels/messages/overlay.archive.js` renders the archive overlay view for one message reference.
The implementation is deliberately small: it creates a reusable overlay body, renders a simple timeline-like list,
and shows whether older or newer archive pages are available.

In short: this file is the archive-specific large-overlay view for the Messages panel.

---

## Where it sits in the system

`index.js` creates the archive overlay controller and exposes it through its local `openArchiveOverlay(ref)` helper.
That helper resets some archive state, opens the overlay, and renders the currently cached archive snapshot.

At the moment, the normal row menu keeps archive actions disabled, so this module is loaded and wired but not reachable
through the standard Messages panel menu flow.

---

## Responsibilities

1. Lazily create and cache the archive overlay DOM.
   - The module builds one root tree with title, mode line, meta line, info line, and list area.
   - The cached structure is reused across openings until `resetArchiveOverlay()` is called.

2. Render the current archive view model.
   - `renderArchiveView(view)` displays the active `ref`, current archive mode, paging edge availability,
     pending item count, and the current list of archive entries.

3. Open and reset the archive overlay.
   - `openArchiveOverlay(ref)` opens the large overlay with a translated title and an initial follow-mode view.
   - `resetArchiveOverlay()` removes the cached root and clears the stored DOM references.

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabMessagesOverlayArchive = {
  createArchiveOverlay
}
```

`createArchiveOverlay({ ui, t })` returns:

```js
{
  openArchiveOverlay(ref),
  renderArchiveView(view),
  resetArchiveOverlay()
}
```

The `view` object currently used by the renderer includes:

- `ref`
- `mode`
- `pendingNewCount`
- `hasMoreBackward`
- `hasMoreForward`
- `items`

Each item is rendered as a simple `ts · event` row.

---

## Design notes / invariants

- The archive overlay is present in the panel code even though the normal archive action is disabled in the row menu.
- `openArchiveOverlay(ref)` always starts from a follow-mode empty/default view before later render updates are applied.
- The overlay is display-only. It does not fetch archive pages and it does not own archive cursor state.
- Empty archive lists render a translated empty text instead of an empty container.
- Pending count is shown separately from the list and does not mutate the list content by itself.

---

## Related files

- Implementation: `admin/tab/panels/messages/overlay.archive.js`
- Test: `admin/tab/panels/messages/overlay.archive.test.js`
- Panel entry: [`./tab-panels-messages-index.md`](./tab-panels-messages-index.md)
- Archive data facade: [`./tab-panels-messages-data.archive.md`](./tab-panels-messages-data.archive.md)
- Admin frontend overview: `docs/ui/README.md`
