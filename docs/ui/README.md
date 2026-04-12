# Message Hub UI Docs (`docs/ui/`) – Overview

This document explains the **UI layer** of Message Hub: the browser-side Admin UI, its runtime bridge, and the role the UI plays in the overall system.

The UI is the operator-facing part of the project. It does not own message semantics, plugin business logic, or persistence. Its job is to present those capabilities in a usable form, collect user input, and forward that input through stable runtime contracts.

If you are looking for the core engine, jump to [`docs/modules/README.md`](../modules/README.md).
If you are looking for ioBroker/runtime bridge code, jump to [`docs/io/README.md`](../io/README.md).
If you are looking for plugin implementation details, jump to [`docs/plugins/README.md`](../plugins/README.md).

Detailed UI documents and generated implementation docs are linked at the bottom of this page.

For the public path-based web host that reuses the AdminTab shell through the ioBroker `web` adapter, see [`./web.md`](./web.md).

## What the Admin UI is (and what it is not)

The current Message Hub UI is the **Admin Tab** inside the ioBroker admin interface.
It is the main place where an operator can:

- inspect Message Hub data from a browser
- configure plugins and plugin instances
- open plugin-owned management panels
- trigger UI-side workflows that call into backend runtime commands

The UI intentionally does not:

- run its own standalone Message Hub web server
- expose its own network port
- bypass backend contracts and read plugin internals directly
- own business rules that belong in the core or in plugins

In other words: the UI is an access surface, not a second backend.

For the supported Admin Tab URL/query/hash behavior, start with [`./url-parameters.md`](./url-parameters.md). That guide documents the implemented `instance` / `lang` / `locale` / `composition` / `expert` / `theme` handling, hash navigation, and the legacy `react` theme alias.

## Composition: one UI, multiple representations

Message Hub uses a composition-based UI model.
That means there is not just “one screen”, but one browser-facing UI shell that can host multiple **presentation compositions**.

Today this mainly means:

- **core panels** that belong to the Admin Tab shell itself
- **plugin-owned panels** that are contributed by plugins and mounted by the host

This is important because the UI is intentionally split into reusable layers:

- a shared shell and runtime in `admin/tab/`
- backend-facing command handlers in `lib/IoAdminTab.js`
- plugin-owned UI bundles in `lib/<PluginType>/admin-ui/`

So the system has one UI surface, but multiple concrete views and panel compositions inside it.

## Where the UI sits in the repository and architecture

In simple terms, the repository is split into four major areas:

- **Core** in `src/`: message model, lifecycle, rendering, store, dispatch
- **IO/runtime layer** in `lib/Io*` + adapter wiring: ioBroker-specific integration, runtime commands, backend bridges
- **Plugins** in `lib/<PluginType>/`: integration logic and plugin-owned functionality
- **UI** in `admin/` + `docs/ui/`: browser-side operator workflows and their documentation

The browser code lives in `admin/`.
The backend bridge for that browser code lives mainly in `lib/IoAdminTab.js`.
Plugin-owned Admin UI code lives under each plugin, for example `lib/IngestStates/admin-ui/`.

This placement is deliberate:

- the UI should stay browser-focused
- backend contracts should stay in the IO/runtime layer
- plugin-specific UI should stay with the plugin that owns it

Long-term, this also supports a cleaner plugin boundary where plugin-specific UI and backend logic can move together.

## Data interfaces to the rest of the system

The UI talks to the rest of Message Hub through defined runtime interfaces.
It does not directly manipulate core state in the browser.

At a high level, the data flow looks like this:

1. The browser-side Admin UI calls backend commands.
2. The backend bridge (`IoAdminTab`) validates/routes those commands.
3. The IO/runtime layer talks to core modules or plugins.
4. Results are returned to the browser as response DTOs.

The UI therefore sits on top of multiple system blocks:

- **Core modules** for message data and statistics
- **IO/runtime bridges** for adapter-specific commands and transport
- **Plugins** for plugin configuration, plugin status, and plugin-owned Admin UI RPC
- **ioBroker object/state storage** for persisted options and runtime state

This separation matters because it keeps the browser code replaceable.
The UI can evolve without turning into a hidden backend.

## Current transport and hosting model

The current Admin UI is delivered through the **ioBroker admin web server**.
Message Hub does not ship a separate HTTP server, a second frontend runtime, or its own port.

In practice this means:

- browser assets are served from `admin/`
- the UI runs inside the ioBroker admin environment
- backend requests go through the existing admin/runtime bridge
- plugin-owned Admin UI bundles are also loaded through this path

This keeps deployment simple:

- no additional service to run
- no separate authentication/session model
- no second web deployment pipeline just for Message Hub

## Design foundations

The UI follows a few consistent design ideas:

- **thin browser, explicit contracts**: browser code should call documented runtime APIs instead of guessing backend behavior
- **composition over special cases**: core panels and plugin-owned panels should fit into one host model
- **plugin ownership stays with plugins**: plugin-specific UI, RPC, i18n, and related assets belong to the plugin
- **lightweight host layer**: the Admin Tab host should stay generic and avoid plugin-specific knowledge

## Public Web Host

Besides the embedded Admin Tab, Message Hub also has a path-based public host entry in [`/web.js`](/home/pi/ioBroker.msghub/web.js).

That host:

- runs in the ioBroker `web` adapter context
- reuses the AdminTab shell
- resolves panel apps through narrow internal adapter bridges into the running MsgHub adapter

Read more: [`./web.md`](./web.md)
- **one source of truth per concern**: core owns message semantics, plugins own integration semantics, the UI owns presentation and operator flow

This is also why the recent plugin-owned Admin UI work matters:
it moves more UI ownership into the plugin space instead of keeping special-case overlay code in the generic host.

## Core UI building blocks

The current UI concept is built from three main pieces:

- **Admin Tab shell** in `admin/tab/`
  - panel composition
  - layout
  - shared UI primitives
  - plugin UI host
- **Admin backend bridge** in `lib/IoAdminTab.js`
  - receives browser-side commands
  - routes them into the runtime/backend layer
- **plugin-owned Admin UI bundles** in `lib/<PluginType>/admin-ui/`
  - panel-specific ESM bundles
  - optional companion CSS
  - plugin-owned UI i18n
  - plugin-owned RPC handlers

Together, these pieces create a UI that is browser-based, backend-driven, and increasingly plugin-owned where that makes architectural sense.

## Admin Tab and plugin-owned panels

The Admin Tab is currently the main UI composition.
It combines:

- generic host-owned panels
- plugin-owned panels that are declared in plugin manifests

The host resolves those plugin panels through the backend view payload, loads their ESM bundles, mounts them into the shared shell, and routes plugin-owned RPC calls back to the owning plugin.

This allows the UI to grow without turning the Admin Tab host into a central place for plugin-specific special logic.

The current reference example is **IngestStates**, which contributes dedicated management panels through its own plugin-owned Admin UI bundle.

## Relationship to the rest of the documentation

Use this page as the top-level entry point when you want to understand the UI as a whole.

Then continue based on your question:

- **How does the backend bridge work?**
  - continue with [`docs/io/IoAdminTab.md`](../io/IoAdminTab.md) for the backend command bridge, then [`docs/ui/tab-api.md`](./tab-api.md) and [`docs/ui/tab-runtime.md`](./tab-runtime.md) for the browser-side API/runtime layer
- **How do the browser-side Admin modules fit together?**
  - start with [`docs/ui/tab.md`](./tab.md), [`docs/ui/tab-boot.md`](./tab-boot.md), [`docs/ui/tab-layout.md`](./tab-layout.md), and [`docs/ui/API.md`](./API.md)
- **How do plugin-owned UI panels work?**
  - continue with [`docs/ui/tab-plugin-ui-host.md`](./tab-plugin-ui-host.md), then the plugin docs under [`docs/plugins/`](../plugins/README.md)

## UI Documents

<!-- AUTO-GENERATED:UI-INDEX:START -->
- `API`: [`./API.md`](./API.md)
- `tab-api`: [`./tab-api.md`](./tab-api.md)
- `tab-boot`: [`./tab-boot.md`](./tab-boot.md)
- `tab-core-panel-bootstrap`: [`./tab-core-panel-bootstrap.md`](./tab-core-panel-bootstrap.md)
- `tab-globals`: [`./tab-globals.md`](./tab-globals.md)
- `tab-layout`: [`./tab-layout.md`](./tab-layout.md)
- `tab-panels-messages-data.archive`: [`./tab-panels-messages-data.archive.md`](./tab-panels-messages-data.archive.md)
- `tab-panels-messages-data.messages`: [`./tab-panels-messages-data.messages.md`](./tab-panels-messages-data.messages.md)
- `tab-panels-messages-entry`: [`./tab-panels-messages-entry.md`](./tab-panels-messages-entry.md)
- `tab-panels-messages-lifecycle`: [`./tab-panels-messages-lifecycle.md`](./tab-panels-messages-lifecycle.md)
- `tab-panels-messages-menus`: [`./tab-panels-messages-menus.md`](./tab-panels-messages-menus.md)
- `tab-panels-messages-overlay.archive`: [`./tab-panels-messages-overlay.archive.md`](./tab-panels-messages-overlay.archive.md)
- `tab-panels-messages-overlay.json`: [`./tab-panels-messages-overlay.json.md`](./tab-panels-messages-overlay.json.md)
- `tab-panels-messages-render.header`: [`./tab-panels-messages-render.header.md`](./tab-panels-messages-render.header.md)
- `tab-panels-messages-render.meta`: [`./tab-panels-messages-render.meta.md`](./tab-panels-messages-render.meta.md)
- `tab-panels-messages-render.table`: [`./tab-panels-messages-render.table.md`](./tab-panels-messages-render.table.md)
- `tab-panels-messages-state`: [`./tab-panels-messages-state.md`](./tab-panels-messages-state.md)
- `tab-panels-plugins-data.plugins`: [`./tab-panels-plugins-data.plugins.md`](./tab-panels-plugins-data.plugins.md)
- `tab-panels-plugins-entry`: [`./tab-panels-plugins-entry.md`](./tab-panels-plugins-entry.md)
- `tab-panels-plugins-menus`: [`./tab-panels-plugins-menus.md`](./tab-panels-plugins-menus.md)
- `tab-panels-plugins-render.catalog`: [`./tab-panels-plugins-render.catalog.md`](./tab-panels-plugins-render.catalog.md)
- `tab-panels-plugins-render.form`: [`./tab-panels-plugins-render.form.md`](./tab-panels-plugins-render.form.md)
- `tab-panels-plugins-render.instance`: [`./tab-panels-plugins-render.instance.md`](./tab-panels-plugins-render.instance.md)
- `tab-panels-plugins-state`: [`./tab-panels-plugins-state.md`](./tab-panels-plugins-state.md)
- `tab-plugin-ui-host`: [`./tab-plugin-ui-host.md`](./tab-plugin-ui-host.md)
- `tab-runtime`: [`./tab-runtime.md`](./tab-runtime.md)
- `tab-scroll-strip`: [`./tab-scroll-strip.md`](./tab-scroll-strip.md)
- `tab-ui`: [`./tab-ui.md`](./tab-ui.md)
- `tab`: [`./tab.md`](./tab.md)
- `url-parameters`: [`./url-parameters.md`](./url-parameters.md)
- `web`: [`./web.md`](./web.md)
<!-- AUTO-GENERATED:UI-INDEX:END -->
