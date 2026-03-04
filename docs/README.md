# Message Hub Documentation

Message Hub is an ioBroker adapter that keeps a simple, persistent list of “messages” (tasks, status items, appointments, …) and can dispatch notification events to integrations.

This `docs/` folder is written as **software documentation**: readable for non-developers, but still technical and accurate.

Naming note: the adapter is called **Message Hub**. In code and ioBroker object IDs you will still see `msghub` / `ioBroker.msghub` and `Msg*` classes as shorter technical identifiers.

## Start Here (recommended reading order)

- Getting started (first steps, what you can do today): [`docs/GettingStarted.md`](./GettingStarted.md)
- Admin Tab (configure plugins and instances): [`docs/ui/AdminTab.md`](./ui/AdminTab.md)
- Statistics snapshot (Admin Tab “Stats”, rollups, I/O diagnostics): [`docs/modules/MsgStats.md`](./modules/MsgStats.md)
- Message model (what a “message” is, lifecycle, timing, actions): [`docs/MessageModel.md`](./MessageModel.md)
- Control plane API (create/patch/list via `sendTo`): [`docs/plugins/EngageSendTo.md`](./plugins/EngageSendTo.md)
- Notification output states (what `NotifyStates` writes): [`docs/plugins/NotifyStates.md`](./plugins/NotifyStates.md)

## Developer Docs

- UI docs (Admin tab and future UI surfaces): [`docs/ui/README.md`](./ui/README.md)
- IO runtime layer (platform adapters/backends/resolver): [`docs/io/README.md`](./io/README.md)
- Plugin developer guide (interfaces and `ctx.api`): [`docs/plugins/README.md`](./plugins/README.md)
- Plugin API reference (details for `ctx.api` / `ctx.meta`): [`docs/plugins/API.md`](./plugins/API.md)
- Plugin runtime wiring (enable switches, options in `native`): [`docs/plugins/IoPlugins.md`](./plugins/IoPlugins.md)
- Core modules (store/factory/storage/notify/render): [`docs/modules/README.md`](./modules/README.md)

## What This Repo Ships Today

- Built-in plugins (types, defaults, and docs links): [`docs/plugins/PLUGIN-INDEX.md`](./plugins/PLUGIN-INDEX.md)

## Big Picture: 4 Documentation Paths

This repository now documents four main paths:

- **Core** (`docs/modules/`, code in `src/`): domain model, store, lifecycle, rendering, dispatch.
- **IO layer** (`docs/io/`, code in `lib/Io*` + adapter wiring): platform-specific runtime adapters and storage/archive backends.
- **Plugins** (`docs/plugins/`, code in `lib/<PluginName>/`): integrations that produce/consume message events.
- **UI** (`docs/ui/`, code in `admin/` + AdminTab runtime endpoints): admin-facing surfaces and workflows.

In other words: core owns message semantics, IO owns platform/runtime mechanics, plugins own integrations, and UI owns operator-facing workflows.

### Architecture at a Glance

Simplified flow:

```
ioBroker events -> Plugins (lib/<Type>) -> Core (src/) -> Plugins (lib/<Type>)
      |                 |                    |                |
      |                 +---- via IO/runtime wiring in lib/Io* and main.js ----+
      +--------------------------- operated via Admin/UI (admin/ + docs/ui) -----+
```

Runtime note: plugin types are auto-discovered at adapter startup from `lib/<plugin>/manifest.js` (via `lib/index.js`).
On a running adapter instance, `IoPlugins` (in `lib/`) loads plugin options from ioBroker objects, maintains enable/status
states, and registers/unregisters plugin instances at runtime (including bidirectional `Bridge...` plugins via `MsgBridge`).

## Modules (Core)

Core modules are the stable internal building blocks in `src/`. They implement logic that should not depend on any specific integration.

Read more: [`docs/modules/README.md`](./modules/README.md)

## IO Layer (Platform Runtime)

IO-layer docs describe platform/runtime adapters that keep core logic integration-agnostic, for example:

- archive strategy resolver (`native` vs `iobroker`)
- archive backend implementations
- storage backend implementations
- AdminTab runtime command handlers (`admin.archive.*`, diagnostics mirrors)

Read more: [`docs/io/README.md`](./io/README.md)

## Plugins (Integrations)

Plugins are the integration layer. They should treat the core as a black box: use `ctx.api.*` and do not poke at internal state.

Read more: [`docs/plugins/README.md`](./plugins/README.md)

## UI (Admin / Frontend)

UI docs cover admin surfaces and user-facing flows, currently centered on the Admin Tab.

Read more: [`docs/ui/README.md`](./ui/README.md)

## Language and Format Locale

Message Hub maintains a deliberate separation between three independent language/locale sources and two independent concerns (text translation vs. number/date formatting).

### Text Language (i18n key resolution)

**ioBroker backend language**
- Source: `system.config.common.language`
- Resolved once at adapter startup; requires adapter restart after a system language change.
- Used for: ioBroker state and object names (plugin states, managed-meta watchlist), `jsonCustom` dropdown labels.
- Runtime access: `adapter.i18nBackend` (internal) — not exposed via `ctx.api`.

**AdminTab UI language**
- When embedded in the ioBroker Admin iFrame: resolved from the `runtime.about` response (`data.lang.backendTextLanguage`) on socket connect. This reflects the ioBroker backend language.
- When opened standalone (no parent frame): falls back to `navigator.language`.
- Controls which `admin/i18n/<lang>.json` dictionary the AdminTab loads.

**MsgHub Core text language**
- Source: explicit adapter config field `coreTextLanguage`.
- Fallback: ioBroker backend language when `coreTextLanguage` is not set.
- Used for: message translations in Core and plugins (i18n key resolution for message content).
- Runtime access: `ctx.api.i18n.i18nlocale` (read-only, plugins).

### Format Locale (number and date formatting)

**MsgHub Core format locale**
- Source: explicit adapter config field `coreFormatLocale` (e.g. `de-DE`, `en-US`), default `de-DE`.
- Independent of text language — a German text output can still use `en-US` number formatting.
- Stable fallback for plugins that produce output in an unknown rendering context (e.g. notification plugins).
- Runtime access: `ctx.api.format.formatlocale` (read-only, plugins).

The ioBroker backend format and AdminTab UI format are currently not in use.

See also: [`docs/plugins/API.md`](./plugins/API.md) for the full `ctx.api` reference.

## Where Things Live (Code Map)

- `src/`: core engine (modules)
- `lib/`: plugin implementations + IO/runtime wiring/backends
- `admin/`: Admin tab frontend code
- `main.js`: adapter wiring (registering plugin runtime and dispatching ioBroker events)
