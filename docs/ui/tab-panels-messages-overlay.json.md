# admin/tab/panels/messages/overlay.json.js: annotated JSON viewer for one message

`admin/tab/panels/messages/overlay.json.js` renders one message into the large overlay as annotated JSON.
The goal is not only to dump the raw payload, but to make the structure easier to inspect by adding readable hints
for timestamps, durations, levels, and executable actions.

In short: this file is the detailed inspection view for a single message.

---

## Where it sits in the system

`index.js` creates the JSON overlay controller and passes the resulting `openMessageJson(message)` function into:

- [`./tab-panels-messages-render.table.md`](./tab-panels-messages-render.table.md) for row double-clicks
- [`./tab-panels-messages-menus.md`](./tab-panels-messages-menus.md) for row context menu actions

It also receives panel-level callbacks from `index.js`:

- `openCopyContextMenu(event, msg)` to reuse the same copy actions as the row menu
- `onActionExecute(ref, actionId, actionType)` for core action buttons
- `onLinkOpen(url)` for validated HTTP(S) link actions

The overlay itself uses `ctx.api.ui.overlayLarge`.

---

## Responsibilities

1. Build and reuse the overlay body DOM.
   - The module creates its `jsonPre` body lazily on first use.
   - Later openings reuse the same element instead of rebuilding a new overlay body tree each time.

2. Render an annotated JSON view.
   - Timestamp-like numeric fields receive human-readable date comments.
   - Duration-like fields receive duration comments.
   - Numeric message levels are shown with the resolved level label.
   - String values containing `\n` remain visible as escaped tokens while also wrapping cleanly in the overlay.

3. Turn selected action payloads into clickable controls.
   - Core action types `ack`, `close`, `delete`, and `snooze` can render as buttons.
   - `msg.actionsInactive` still renders those core actions, but disabled.
   - Valid HTTP(S) `link` actions can render as navigation buttons.
   - Unsupported action types such as `open` and `custom` are not turned into executable overlay buttons.

4. Provide the overlay-specific copy context menu.
   - Right-clicking the overlay body opens the copy menu for the current message, unless Ctrl is pressed.

---

## Public surface / integration points

The module exports:

```js
window.MsghubAdminTabMessagesOverlayJson = {
  createJsonOverlay
}
```

`createJsonOverlay(options)` returns:

```js
{
  openMessageJson(message)
}
```

Important factory inputs:

- `ui`
- `t`
- `getServerTimeZone`
- `formatDate`
- `getLevelLabel`
- optional `openCopyContextMenu`
- optional `onActionExecute`
- optional `onLinkOpen`

When `openMessageJson(message)` is called, the module opens `ui.overlayLarge.open(...)` with a translated title and
the cached overlay body element.

---

## Design notes / invariants

- The overlay body is intentionally reused. This keeps the module stateless from the shell’s point of view while still
  avoiding repeated DOM construction.
- Action-button support is intentionally selective:
  - core actions use the same type set as the row menus
  - link actions require a valid `http://` or `https://` URL
  - non-core action types are shown only as JSON, not as executable controls
- Link action buttons are rendered only for `actions` entries. `actionsInactive` renders core action buttons (disabled) but never link navigation buttons.
- If `onActionExecute` is missing, core action buttons can still be rendered but do not get an active handler.
- If JSON annotation or rendering fails, `openMessageJson(...)` falls back to an error string instead of throwing.
- The module does not own message fetching. It only renders the message object it is given.

---

## Related files

- Implementation: `admin/tab/panels/messages/overlay.json.js`
- Test: `admin/tab/panels/messages/overlay.json.test.js`
- Panel entry: [`./tab-panels-messages-entry.md`](./tab-panels-messages-entry.md)
- Row menus: [`./tab-panels-messages-menus.md`](./tab-panels-messages-menus.md)
- Table renderer: [`./tab-panels-messages-render.table.md`](./tab-panels-messages-render.table.md)
- Admin frontend overview: `docs/ui/README.md`
