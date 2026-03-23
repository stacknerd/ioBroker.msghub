# Message Hub IO Layer Docs (`docs/io/`) – Overview

This document explains the **IO layer** of Message Hub: the adapter-side bridge between the stable core engine and the concrete ioBroker/runtime environment.

The IO layer is where Message Hub stops being a purely internal domain model and starts interacting with the outside world:

- ioBroker objects and states
- file storage backends
- Admin runtime command handling
- plugin/runtime orchestration owned by the adapter side

If you are looking for the core engine itself, jump to [`docs/modules/README.md`](../modules/README.md).
If you are looking for browser-side UI concerns, jump to [`docs/ui/README.md`](../ui/README.md).
If you are looking for plugin implementation details, jump to [`docs/plugins/README.md`](../plugins/README.md).

Detailed IO documents are linked at the bottom of this page.

## What an IO layer is in Message Hub

In this project, the IO layer is the **platform/runtime adapter layer**.
It translates between:

- the stable, integration-agnostic core in `src/`
- the real runtime environment in ioBroker
- adapter-owned orchestration concerns that should not live inside the core

Without this layer, the core would need to know too much about:

- ioBroker state/object APIs
- file storage variants
- admin/runtime command transport
- plugin registration and runtime lifecycle details

That would make the core harder to test, harder to reason about, and much less portable.

The IO layer exists to keep those concerns out of the core while still making them available to the rest of the system through explicit contracts.

## Why the project cannot simply “do without it”

Message Hub is not just an in-memory library.
It runs as an ioBroker adapter and has to interact with a concrete host environment.

That means somebody has to own questions like:

- Where do messages get persisted?
- Which archive backend is active?
- How are ioBroker states and objects read or written?
- How are admin/browser requests routed into backend logic?
- How are plugins loaded, configured, started, and stopped?
- How are adapter-specific resources tracked and cleaned up?

If those concerns were pushed directly into the core, the core would stop being a clean domain layer.
If they were pushed directly into plugins or UI code, ownership would become fragmented and inconsistent.

The IO layer is the place where those runtime-specific responsibilities can live without leaking into every other part of the system.

## What the IO layer does

The current IO layer is responsible for several distinct kinds of work:

- **platform adapters**
  - storage/archive backends
  - runtime resolver logic for backend selection
- **adapter-side orchestration**
  - plugin registration and runtime lifecycle
  - plugin resource tracking and cleanup
  - plugin metadata/config integration with ioBroker
- **Admin/backend bridges**
  - handling runtime commands for the Admin UI
  - brokering plugin-owned Admin UI bundle/RPC paths
- **platform-side state surfaces**
  - connection/health-related adapter state surfaces
  - managed metadata/watchlist persistence where needed

In other words, the IO layer is where Message Hub becomes a working adapter instead of “just” a core engine plus plugins.

## What the IO layer explicitly does not do

The IO layer is important, but it should stay a bridge layer.
It is **not** the place that owns everything.

It should not:

- define the core message model
- own core lifecycle semantics
- own plugin business logic
- own browser-side rendering logic
- become a hidden second core with duplicated domain rules

It may sometimes need to know about those areas at the boundary level, but it should not take ownership of their actual semantics.

That is the design boundary:

- **Core** owns message/domain behavior
- **Plugins** own integration-specific behavior
- **UI** owns presentation and operator-facing workflows
- **IO** owns runtime bridging, environment coupling, and adapter-side orchestration

## Main IO responsibilities in this repository

In the current repo layout, the IO layer mainly lives in `lib/Io*.js`.

Typical examples are:

- `IoAdminTab`
  - adapter-side bridge for Admin UI/backend commands
- `IoPlugins`
  - adapter-side plugin runtime orchestration
- `IoPluginResources`
  - resource cleanup tracking for plugin instances
- `IoManagedMeta`
  - managed metadata stamping/watchlist persistence
- `IoArchive*` / `IoStorage*`
  - concrete persistence/archive backends and resolver logic
- `IoCoreConnection`
  - platform-side connection/health state handling

These files are different from core modules in `src/`:
they are allowed to know about ioBroker/runtime concerns because that is exactly their job.

## Design ideas behind the IO layer

The IO layer follows a few consistent design ideas:

- **keep the core clean**
  - core code should depend on contracts, not on ioBroker APIs
- **make platform coupling explicit**
  - if something is adapter-/runtime-specific, it should be visible as such
- **centralize orchestration**
  - plugin/runtime/admin bridging should not be scattered across unrelated modules
- **prefer narrow bridges over broad leakage**
  - expose small capability surfaces instead of giving every layer direct access to everything
- **best-effort side effects**
  - many runtime operations are operational/infrastructure work and should fail in controlled ways rather than destabilize the adapter

These ideas are also why the IO layer is valuable for future evolution:
it keeps the boundary to the platform explicit and makes refactoring or extraction easier than if those concerns were mixed directly into the core.

## Relationship to the rest of the system

The IO layer sits between the other major domains:

- it connects the **core** to the real runtime environment
- it brokers adapter-side contracts used by **plugins**
- it exposes backend command surfaces consumed by the **UI**

That does not mean every interaction literally passes through every IO module.
It means the IO layer owns the runtime-specific contracts that make those interactions possible in the actual adapter process.

## How to read the IO docs

Use this page as the entry point when your question is mainly about runtime bridging or adapter-side infrastructure.

Then continue based on your question:

- **How does the Admin backend bridge work?**
  - start with [`docs/io/IoAdminTab.md`](./IoAdminTab.md)
- **How does plugin runtime orchestration work?**
  - continue with [`docs/io/IoPlugins.md`](./IoPlugins.md)
- **How do persistence and archive backends work?**
  - continue with the `IoArchive*` and `IoStorage*` documents listed below

## IO Documents

<!-- AUTO-GENERATED:IO-INDEX:START -->
- `API`: [`./API.md`](./API.md)
- `IoAdminConfig`: [`./IoAdminConfig.md`](./IoAdminConfig.md)
- `IoAdminTab`: [`./IoAdminTab.md`](./IoAdminTab.md)
- `IoArchiveIobroker`: [`./IoArchiveIobroker.md`](./IoArchiveIobroker.md)
- `IoArchiveNative`: [`./IoArchiveNative.md`](./IoArchiveNative.md)
- `IoArchiveResolver`: [`./IoArchiveResolver.md`](./IoArchiveResolver.md)
- `IoCoreConnection`: [`./IoCoreConnection.md`](./IoCoreConnection.md)
- `IoManagedMeta`: [`./IoManagedMeta.md`](./IoManagedMeta.md)
- `IoPluginGuards`: [`./IoPluginGuards.md`](./IoPluginGuards.md)
- `IoPluginResources`: [`./IoPluginResources.md`](./IoPluginResources.md)
- `IoPlugins`: [`./IoPlugins.md`](./IoPlugins.md)
- `IoStorageIobroker`: [`./IoStorageIobroker.md`](./IoStorageIobroker.md)
<!-- AUTO-GENERATED:IO-INDEX:END -->
