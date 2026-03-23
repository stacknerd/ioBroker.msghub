# Message Hub API Overview

This document is the **entry point to the contract landscape** of Message Hub.

It does not try to describe every implementation detail in one place.
Instead, it explains **which API/contract areas exist**, who mainly owns them, who typically consumes them, and where the detailed reference lives.

If you are looking for a specific API surface, use the table below and continue into the corresponding area document.

## What counts as an API/contract here

In Message Hub, an “API” does not only mean a public HTTP endpoint.
It also includes stable technical contracts between major parts of the system, for example:

- host contexts such as `ctx.api.*`
- manifest schemas and plugin declarations
- runtime command surfaces (`sendTo` / Admin runtime commands)
- browser/backend request-response DTOs
- plugin-owned Admin UI contracts
- core-owned data structures and invariants that external layers must respect

This page focuses on those **direct technical contracts**.

It does **not** try to describe every end-to-end interaction path in the system.
For example, the UI may ultimately show Core-owned data, but that does not automatically mean the UI has a direct Core contract.

## Main system blocks

For documentation purposes, the repo is split into four major contract domains:

- **Core** in `src/`
- **IO/runtime layer** in `lib/Io*` and related adapter/runtime bridges
- **Plugins** in `lib/<PluginType>/`
- **UI** in `admin/` and plugin-owned Admin UI bundles

`main.js` is important as the adapter wiring/composition root, but it is **not treated here as its own peer API domain**.
It mainly connects the other four domains.

## Contract Areas

| Contract area | Primary owner | Main consumers | Typical examples | Reference |
|---|---|---|---|---|
| Core-facing contracts | Core (`src/`) | IO layer, plugins | message structures, host-facing core entry points, core invariants | [`docs/modules/API.md`](./modules/API.md) |
| IO/runtime-facing contracts | IO layer (`lib/Io*`) | UI, plugins, core-adjacent adapter wiring | `IoAdminTab`, `IoPlugins`, runtime command bridges, DTOs | [`docs/io/API.md`](./io/API.md) |
| Plugin-facing contracts | Plugins + plugin hosts | plugin implementations | `manifest`, plugin factory/lifecycle, `ctx.api.*`, plugin-owned Admin UI hooks | [`docs/plugins/API.md`](./plugins/API.md) |
| UI-facing contracts | UI shell + UI host/runtime bridge | browser-side modules, plugin-owned Admin UI bundles | Admin browser runtime, bundle ctx, plugin UI RPC, browser/backend DTOs | [`docs/ui/API.md`](./ui/API.md) |

## How to read this map

Start with the document that matches the side of the contract you care about most:

- If you are implementing or reviewing a plugin, start with [`docs/plugins/API.md`](./plugins/API.md)
- If you are working on browser-side Admin UI, start with [`docs/ui/API.md`](./ui/API.md)
- If you are working on runtime bridges and adapter-side command surfaces, start with [`docs/io/API.md`](./io/API.md)
- If you need the host-facing entry points and invariants owned by the core engine, start with [`docs/modules/API.md`](./modules/API.md)

If a contract spans more than one area, the rule is:

- this page gives the overview,
- the area document gives the detailed reference,
- neighboring area documents explain the same boundary from their own side when needed.

## Relationship to the rest of the documentation

These API documents are **not** a replacement for the broader module/area documentation.

Use them together:

- overview + architecture context:
  - [`docs/README.md`](./README.md)
- core concepts and module walkthroughs:
  - [`docs/modules/README.md`](./modules/README.md)
- IO/runtime overview:
  - [`docs/io/README.md`](./io/README.md)
- plugin overview:
  - [`docs/plugins/README.md`](./plugins/README.md)
- UI overview:
  - [`docs/ui/README.md`](./ui/README.md)
