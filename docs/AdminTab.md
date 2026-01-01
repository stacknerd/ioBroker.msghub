# Admin Tab (Plugin Config UI)

Message Hub ships a custom **Admin Tab** (in the ioBroker admin UI) that is meant to be the primary UI for managing
runtime-managed plugins.

At the moment the tab mainly focuses on **Plugin Config**, but it already reserves placeholders for future features
(like dashboards/calendars).

---

## Plugin Config (what it does)

- Lists all available plugin types (auto-discovered from `lib/<plugin>/manifest.js`).
- Shows the current plugin instances and their status.
- Lets you:
  - enable/disable a plugin instance
  - create/delete instances (only when `manifest.supportsMultiple === true`)
  - edit instance options (based on `manifest.options`)

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

