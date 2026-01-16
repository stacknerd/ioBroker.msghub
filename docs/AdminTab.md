# Admin Tab (Plugin Config UI)

Message Hub ships a custom **Admin Tab** (in the ioBroker admin UI) that is meant to be the primary UI for managing
runtime-managed plugins.

Currently the tab focuses on **Plugin Config** and a small **Stats** view (diagnostics), and it still reserves
placeholders for future features (like dashboards/calendars).

---

## Plugin Config (what it does)

- Lists all available plugin types (auto-discovered from `lib/<plugin>/manifest.js`).
- Shows the current plugin instances and their status.
- Lets you:
  - enable/disable a plugin instance
  - create/delete instances (only when `manifest.supportsMultiple === true`)
  - edit instance options (based on `manifest.options`)

### Plugin “README” (User Guide overlay)

If a plugin has documentation in `docs/plugins/<TypeName>.md`, the Admin Tab can show its **User Guide** section via an
`(i)` button on the plugin card.

Source of truth is the documentation file; the Admin Tab reads it from an auto-generated bundle:

- Generated file: `admin/plugin-readmes.json`
- Generator: `npm run docs:generate` (CI checks via `npm run docs:check`)

### Manifest UI separators (`type: "header"`)

`manifest.options` supports a UI-only separator element:

- `type: "header"` renders a horizontal line (`<hr>`)
- optional `label` renders a small heading below the line
- the element is **not persisted** into `object.native` (Admin UI does not save it)

### Enum dropdowns (`options` / `multiOptions`)

For convenience, the Admin Tab supports dynamic dropdowns based on `MsgConstants`:

- `options: 'MsgConstants.<path>'` renders a single-select dropdown (stored value keeps its original type, e.g. number for `MsgConstants.level`)
- `multiOptions: 'MsgConstants.<path>'` renders a multi-select dropdown for `type: 'string'` fields (stored as CSV string; empty string when nothing is selected)

---

## Stats (diagnostics)

The **Stats** tab provides a read-only snapshot of:

- current message counts (by kind/lifecycle/origin)
- due windows (“fällig” by domain time, not notification due)
- “done” counts based on `lifecycle.state → "closed"` rollups (today / this week / this month)
- I/O diagnostics for persistence and archive (last persisted/flush timestamps, pending queues)

Notes:

- The archive size estimate is intentionally **opt-in** because it can be expensive depending on file backend and file count.
- The backend is powered by `MsgStats` (see [`docs/modules/MsgStats.md`](./modules/MsgStats.md)).

---

## Where configuration is stored

Each plugin instance is stored as a small ioBroker subtree:

- Base object (type `channel`): `msghub.0.<TypeName>.<instanceId>`
  - options are stored in `object.native`
- Enable state (boolean): `msghub.0.<TypeName>.<instanceId>.enable`
- Status state (string): `msghub.0.<TypeName>.<instanceId>.status`

Instance ids are numeric and start at `0` (`0`, `1`, `2`, …).

---

## Applying changes (no adapter restart)

- Enable/disable changes are applied immediately by `IoPlugins` (start/stop single instance).
- Option changes update `object.native` and restart the **single affected instance** when it is enabled.
