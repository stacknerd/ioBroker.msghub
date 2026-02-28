# Message Hub IO Layer Docs (`docs/io/`) – Overview

This path documents the platform/runtime IO layer of Message Hub.

Scope:

- ioBroker/native storage backends
- archive writer strategy resolution (`native` vs `iobroker`)
- runtime diagnostics surfaces for IO strategy/status
- adapter wiring that injects IO backends into core modules

Design boundary:

- Core modules (`src/`) only depend on backend contracts.
- IO implementations (`lib/Io*`) provide environment-specific behavior.

## IO Documents

<!-- AUTO-GENERATED:MODULE-INDEX:START -->
- `IoAdminConfig`: [`./IoAdminConfig.md`](./IoAdminConfig.md)
- `IoAdminTab`: [`./IoAdminTab.md`](./IoAdminTab.md)
- `IoArchiveIobroker`: [`./IoArchiveIobroker.md`](./IoArchiveIobroker.md)
- `IoArchiveNative`: [`./IoArchiveNative.md`](./IoArchiveNative.md)
- `IoArchiveResolver`: [`./IoArchiveResolver.md`](./IoArchiveResolver.md)
- `IoStorageIobroker`: [`./IoStorageIobroker.md`](./IoStorageIobroker.md)
<!-- AUTO-GENERATED:MODULE-INDEX:END -->
