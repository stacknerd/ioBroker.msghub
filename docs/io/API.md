# IO API Reference

| Item | Contract |
| --- | --- |
| Scope | IO-/runtime-facing contracts only. |
| In scope | Adapter-side runtime bridges, plugin orchestration, platform-side state surfaces, UI/backend command routers, IO-brokered bundle/RPC paths, and IO-owned helper contracts exposed across layer boundaries. |
| Out of scope | Browser-only shell contracts (`docs/ui/API.md`), plugin-facing ctx details (`docs/plugins/API.md`), core-internal DTO semantics owned by `src/`, and archive/storage backend implementation APIs except where they surface through IO-owned commands or status payloads. |
| Source of truth | `main.js`, `lib/index.js`, `lib/IoAdminCapabilities.js`, `lib/IoAdminTab.js`, `lib/IoWebUi.js`, `lib/IoAdminConfig.js`, `lib/IoCoreConnection.js`, `lib/IoPlugins.js`, `lib/IoPluginResources.js`, `lib/IoManagedMeta.js`, `lib/IngestStates/manifest.js`, `src/MsgStore.js`, `src/MsgStats.js`. |

| Area | Owned by | Use this file for |
| --- | --- | --- |
| IO <> Core | `main.js`, `lib/IoCoreConnection.js`, `lib/IoPlugins.js`, `lib/IoAdminCapabilities.js`, `lib/IoAdminTab.js`, `lib/IoWebUi.js`, `lib/IoAdminConfig.js` | Adapter/runtime bridge entry points and the composition-root routing boundary. |
| IO <> Plugins | `lib/index.js`, `lib/IoPlugins.js`, `lib/IoPluginResources.js`, `lib/IoManagedMeta.js` | Catalog, instance tree, enable-state orchestration, messagebox ownership, bundle brokering, tracked resources, managed metadata. |
| IO <> UI | `main.js`, `lib/IoAdminCapabilities.js`, `lib/IoAdminTab.js`, `lib/IoWebUi.js`, `lib/IoAdminConfig.js` | `ui.bootstrap`, `admin.*`, `web.*`, `config.*`, and the shared `about` payload used by legacy `runtime.about`. |

## IO <> Core

### Runtime bridge entry points

| Entry | Contract | Counterpart | Owner | Reference |
| --- | --- | --- | --- | --- |
| `new IoCoreConnection(adapter)` | Requires `adapter.namespace`. Owns the official platform-side connection state `info.connection`. | Adapter platform state | IO runtime | `lib/IoCoreConnection.js` |
| `IoCoreConnection.init()` | Ensures the `info.connection` state object exists and seeds it to disconnected. | Adapter startup | IO runtime | `lib/IoCoreConnection.js` |
| `IoCoreConnection.checkHealthLocal({ msgStore? })` | Returns `{ connected, mode: 'local' }` by checking the in-process core runtime shape. | `MsgStore` runtime | IO runtime | `lib/IoCoreConnection.js` |
| `IoCoreConnection.markFromHealth(health)` | Updates the cached health flags and writes `info.connection` with `ack: true`. | Adapter state writer | IO runtime | `lib/IoCoreConnection.js` |
| `IoCoreConnection.markDisconnected()` | Forces `connected = false`, `mode = 'local'`, and writes `info.connection` with `ack: true`. | Adapter state writer | IO runtime | `lib/IoCoreConnection.js` |
| `IoCoreConnection.getRuntimeAbout()` | Returns the minimal `runtime.about.connection` fragment `{ scope: 'core-link', connected, mode: 'local' }`. | `runtime.about` router | IO runtime | `lib/IoCoreConnection.js`, `main.js` |
| `IoPlugins.create(adapter, msgStore, options?)` | Convenience startup path: constructs `IoPlugins`, runs `init()`, then `registerEnabled()`. Requires `msgStore.msgIngest` and `msgStore.msgNotify`. | Core plugin hosts | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.getIngestMeta()` | Returns the meta bundle passed into `MsgIngest.start(...)`. Current implementation returns `{}`. | `MsgIngest` startup | IO runtime | `lib/IoPlugins.js`, `main.js` |
| `new IoAdminTab(adapter, ioPlugins, { msgStore?, pluginUiRpc?, adminCapabilities? })` | Requires `adapter.namespace`. Binds the Admin runtime facade to optional `IoPlugins`, `MsgStore`, a shared `IoPluginUiRpc` service, and the shared `IoAdminCapabilities` authority for canonical payload-token validation. | Admin command router | IO runtime | `lib/IoAdminTab.js` |
| `IoAdminTab.handleCommand(cmd, payload)` | Main backend entry point for `admin.*` commands. All `admin.*` commands require `payload.token` and validate it centrally through `IoAdminCapabilities` before business execution, except `admin.ingestStates.presets.selectOptions*`, which remains reachable without a token for external `jsonCustom` callers. Returns an `{ ok, data|error }` envelope, except for `admin.ingestStates.presets.selectOptions*`, which returns a bare options array. | Admin UI/backend bridge | IO runtime | `lib/IoAdminTab.js` |
| `new IoWebUi(adapter, { msgStore?, ioPlugins?, pluginUiRpc?, adminCapabilities? })` | Requires `adapter.namespace`. Binds the web-safe runtime facade to optional `MsgStore`, `IoPlugins`, a shared `IoPluginUiRpc` service, and the shared `IoAdminCapabilities` authority for canonical payload-token validation. | Web command router | IO runtime | `lib/IoWebUi.js` |
| `IoWebUi.handleCommand(cmd, payload)` | Main backend entry point for `web.*`. All `web.*` commands require `payload.token` and validate it centrally through `IoAdminCapabilities` before business execution. Returns an `{ ok, data|error }` envelope. | Web UI/backend bridge | IO runtime | `lib/IoWebUi.js` |
| `new IoPluginUiRpc(adapter, ioPlugins)` | Requires `adapter.namespace`. Centralizes shared PluginUi RPC validation and host-bound dispatch. | Shared PluginUi RPC dispatcher | IO runtime | `lib/IoPluginUiRpc.js` |
| `IoPluginUiRpc.handleAdminRpc(payload)` | Validates host-bound PluginUi RPC payloads and dispatches to `handleAdminUiRpc`. | Admin PluginUi RPC bridge | IO runtime | `lib/IoPluginUiRpc.js` |
| `IoPluginUiRpc.handleWebRpc(payload)` | Validates host-bound PluginUi RPC payloads and dispatches to `handleWebUiRpc`. | Web PluginUi RPC bridge | IO runtime | `lib/IoPluginUiRpc.js` |
| `new IoAdminCapabilities(adapter, { ioPackage? })` | Requires `adapter.namespace`. Centralizes the host-aware bootstrap/about payload, token issuance, token validation, and canonical payload-token contract for UI entry points. | UI bootstrap bridge | IO runtime | `lib/IoAdminCapabilities.js`, `main.js` |
| `IoAdminCapabilities.buildBootstrap({ host })` | Returns the stable bootstrap payload `{ capabilities, about }`. Admin-host bootstrap currently grants `admin`, `config`, and `web`; `webExtension` bootstrap grants `web`. Each grant has shape `{ token, expiresAt }` with a fixed `2h` TTL. | `ui.bootstrap` router | IO runtime | `lib/IoAdminCapabilities.js`, `main.js` |
| `IoAdminCapabilities.buildAbout()` | Returns the shared `about` payload `{ title, version, time, lang, connection }` currently reused by legacy `runtime.about`. | Shared about payload | IO runtime | `lib/IoAdminCapabilities.js`, `main.js` |
| `IoAdminCapabilities.validateToken({ host, capability, token })` | Validates a minted capability token against host, capability, and expiry. | Token authority | IO runtime | `lib/IoAdminCapabilities.js` |
| `IoAdminCapabilities.consumePayloadToken({ host, capability, payload })` | Reads `payload.token`, validates it, strips it from the business payload, and returns the cleaned payload object. | Canonical payload-token contract | IO runtime | `lib/IoAdminCapabilities.js` |
| `new IoAdminConfig(adapter, { ai?, msgStore?, archiveProbeNative?, adminCapabilities? })` | Requires `adapter.namespace`. Binds the config command facade to optional AI and archive/status services plus the shared `IoAdminCapabilities` authority for canonical payload-token validation. | Config command router | IO runtime | `lib/IoAdminConfig.js` |
| `IoAdminConfig.handleCommand(cmd, payload)` | Main backend entry point for `config.*` commands. All `config.*` commands require `payload.token` and validate it centrally through `IoAdminCapabilities` before business execution. Returns an `{ ok, data|error }` envelope for most commands, after native-patch allowlist filtering. Exception: `config.ai.test` returns only `{ native: { aiTestLastResult } }` without an `ok`/`data` wrapper. | jsonConfig/jsonCustom bridge | IO runtime | `lib/IoAdminConfig.js` |

### `main.js` composition-root routing boundary

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `onReady()` IO bootstrap | Creates `IoCoreConnection`, initializes `MsgStore`, marks core health, creates `IoPlugins`, then creates `IoAdminTab`, `IoWebUi`, and `IoAdminConfig`. `main.js` is composition root only, not a separate API owner. | Composition root | `main.js` |
| `onStateChange(id, state)` | Calls `IoPlugins.handleStateChange(...)` first. When that returns `true`, the event is consumed as a plugin enable toggle and is not forwarded to ingest plugins. For non-null states that were not consumed, `main.js` then calls `IoPlugins.handleGateStateChange(...)` and finally forwards the raw event to `msgStore.msgIngest.dispatchStateChange(...)`. | Composition root | `main.js`, `lib/IoPlugins.js` |
| `onObjectChange(id, obj)` | Forwards object changes directly to `msgStore.msgIngest.dispatchObjectChange(...)`. | Composition root | `main.js` |
| `onMessage(obj)` routing | `admin.*` routes to `IoAdminTab`; `web.*` routes to `IoWebUi`; `config.*` routes to `IoAdminConfig`; `ui.bootstrap` delegates to `IoAdminCapabilities`; legacy `runtime.about` reuses the same shared `about` payload; all other commands are passed to `IoPlugins.dispatchMessagebox(obj)`. | Composition root | `main.js` |
| Missing router service | `_handleAdminCommand` returns `NOT_READY` when `_adminTab` is absent. `_handleWebCommand` returns `NOT_READY` when `_webUi` is absent. `_handleConfigCommand` returns `NOT_READY` when `_adminConfig` is absent. Messagebox dispatch returns `NOT_READY` when no handler is registered. | Composition root | `main.js` |
| Uncaught message-route exception | `main.js` wraps uncaught `onMessage` errors as `{ ok: false, error: { code: 'INTERNAL', message } }`. | Composition root | `main.js` |

## IO <> Plugins

### Catalog and instance model

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| Runtime catalog source | Available plugins come from `IoPluginsCatalog`, which is built from builtin package discovery under `lib/` and carries resolved package metadata (`sourceKind`, `sourceId`, `packageRoot`) for host-side asset consumers. | IO runtime | `lib/index.js`, `lib/IoPlugins.js` |
| Manifest export contract | Each builtin package must export `{ manifest }` from `manifest.js`, and the module root must export a factory function named exactly like `manifest.type`. | IO runtime | `lib/index.js` |
| Category resolution | `manifest.category` is used when present; otherwise category is inferred from the `type` prefix (`Ingest*`, `Notify*`, `Bridge*`, `Engage*`). Registration still enforces the category-specific prefix. | IO runtime | `lib/index.js`, `lib/IoPlugins.js` |
| Discovery exclusion | `manifest.hidden === true` or `manifest.discoverable === false` excludes a plugin from runtime discovery. | IO runtime | `lib/index.js` |
| Plugin instance base object | Each instance owns a base object `<Type>.<instanceId>` of type `channel`. `object.native` stores raw plugin options. | IO runtime | `lib/IoPlugins.js` |
| Enable state | Each instance owns `<Type>.<instanceId>.enable` of type `boolean`, role `switch`, read/write. | IO runtime | `lib/IoPlugins.js` |
| Status state | Each instance owns `<Type>.<instanceId>.status` of type `string`, role `text`, with states `starting`, `running`, `stopping`, `stopped`, `error`. | IO runtime | `lib/IoPlugins.js` |
| Watchlist state | Instances that use managed metadata may also own `<Type>.<instanceId>.watchlist` of type `string`, role `json`, with JSON array payload. | IO runtime | `lib/IoManagedMeta.js` |
| Registration id | Runtime registration ids are always `${type}:${instanceId}`. | IO runtime | `lib/IoPlugins.js` |
| Desired enable source of truth | The persisted enable state value is the source of truth. `IoPlugins` commits the final desired value back as `ack: true` after register/unregister. | IO runtime | `lib/IoPlugins.js` |
| Reserved native keys | `native.enabled` mirrors desired enable state and is not forwarded into plugin factory options. `native.channel` is runtime-owned channel-routing config and is forwarded into factory options. `native.instances` is reserved and not forwarded into plugin factory options. | IO runtime | `lib/IoPlugins.js` |

### Public `IoPlugins` runtime API

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `IoPlugins.init()` | Ensures enable states exist for all catalog plugins that either already have an instance object tree or have `defaultEnabled === true`. Seeds those states, subscribes to them, and populates the managed instance list. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.getAdminCatalog()` | Legacy alias for `getCatalog()`. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.registerEnabled()` | Registers every currently enabled plugin instance. Registration is idempotent per category and registration id. Failures are logged and do not stop other registrations. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.getCatalog()` | Returns the JSON-safe catalog DTO array without factory functions. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.adminListInstances()` | Legacy alias for `listInstances()`. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.listInstances()` | Returns current instance DTOs discovered from the object tree: `{ category, type, instanceId, enabled, status: string \| null, native }`. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.adminCreateInstance(info)` | Legacy alias for `createInstance(info)`. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.callPluginRuntime({ type, instanceId?, method, args? })` | Adapter-internal bridge to an already registered plugin handler method. Returns `null` when the plugin or method is unavailable. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.createInstance({ category, type })` | Creates the next numeric instance, seeds its object subtree, registers it immediately when the seeded enable state is true, and returns `{ instanceId }`. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.deleteInstance({ type, instanceId })` | Best-effort unregisters the runtime, deletes the entire instance object subtree recursively, and removes the control-state id from the managed set. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.adminUpdateInstance(info)` | Legacy alias for `updateInstanceNative(info)`. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.updateInstanceNative({ type, instanceId, nativePatch })` | Merges a patch into the instance base object's `native` payload. `undefined`/`null` delete keys. `channel` is normalized to a trimmed string, with "unset" becoming `''`. Running instances are restarted in place. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.adminSetEnabled(info)` | Legacy alias for `setInstanceEnabled(info)`. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.setInstanceEnabled({ type, instanceId, enabled })` | Ensures the instance exists, then applies the desired enable toggle and persists it as `ack: true`. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.isPluginControlStateId(id)` | Returns `true` when `id` belongs to a managed plugin enable switch. Accepts own or full ids. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.handleStateChange(id, state)` | Public state-change hook for `main.js`. Returns `true` when the state was consumed as a plugin enable toggle. Ignores `ack: true` control writes but still marks them as consumed. | IO runtime | `lib/IoPlugins.js`, `main.js` |
| `IoPlugins.handleGateStateChange(id, state)` | Public gate-dispatch hook for `main.js`. Returns `true` only when at least one registered gate watcher for `id` was notified. | IO runtime | `lib/IoPlugins.js`, `main.js` |
| `IoPlugins.dispatchMessagebox(obj)` | Dispatches an ioBroker messagebox call to the currently registered Engage-owned handler. Returns `null` when none is registered. | IO runtime | `lib/IoPlugins.js`, `main.js` |
| `IoPlugins.clearMessageboxHandler()` | Clears the current messagebox owner/handler as best-effort cleanup. | IO runtime | `lib/IoPlugins.js`, `main.js` |
| `IoPlugins.createOptionsApi(manifest)` | Returns the IO-owned manifest-bound resolver API `{ resolveInt, resolveString, resolveBool }`. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.buildManifestFromCatalogEntry(plugin)` | Returns the manifest-like subset copied into runtime plugin metadata: `schemaVersion`, `type`, `defaultEnabled`, `supportsMultiple`, `supportsChannelRouting`, `title`, `description`, `options`. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.computeAdminUiBundleHash({ type, panelId })` | Returns a cached `sha256-<hex>` bundle hash. Hash input is JS content, optional CSS content, and all `admin-ui/i18n/*.json` files sorted by filename. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.getAdminUiContributions()` | Returns admin-UI contribution DTOs only for currently running plugin instances that declare `manifest.adminUi`. Returned `bundle.hash` is always `''` in this raw contribution list. | IO runtime | `lib/IoPlugins.js` |
| `IoPlugins.readAdminUiBundle({ type, panelId, lang })` | Reads the plugin-owned Admin UI JS bundle, optional companion CSS, and optional i18n payload with safe-language fallback to `en`. | IO runtime | `lib/IoPlugins.js` |

### IO-owned helper surfaces brokered into plugin runtimes

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `createOptionsApi(manifest).resolveInt(key, value)` | Finite integer coercion with manifest `default`, `min`, and `max` enforcement. | IO runtime | `lib/IoPlugins.js` |
| `createOptionsApi(manifest).resolveBool(key, value)` | Only literal booleans are accepted; everything else falls back to `spec.default === true`. | IO runtime | `lib/IoPlugins.js` |
| `createOptionsApi(manifest).resolveString(key, value)` | Returns the manifest default for `undefined`, `null`, or non-strings. Trims by default unless `spec.trim === false`. | IO runtime | `lib/IoPlugins.js` |
| Messagebox ownership | Exactly one Engage plugin instance may own the adapter messagebox handler at a time. Ownership is tracked by registration id. | IO runtime | `lib/IoPlugins.js` |
| Admin UI bundle hash cache | Cached per process as `${type}:${panelId}` and intentionally never invalidated mid-process. | IO runtime | `lib/IoPlugins.js` |
| Admin UI package-root guard | Both bundle reading and bundle hashing resolve paths relative to the descriptor `packageRoot` and reject escapes with `FORBIDDEN`. | IO runtime | `lib/IoPlugins.js` |

### `IoPluginResources`

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `new IoPluginResources({ regId?, log?, timers? })` | Creates a per-plugin resource tracker for timers, wrapped subscribe APIs, and generic disposers. | IO runtime | `lib/IoPluginResources.js` |
| `add(disposer)` | Tracks either `() => void` or `{ dispose() }`. Returns an internal numeric token. If the tracker is already disposed, the disposer is called immediately and `0` is returned. | IO runtime | `lib/IoPluginResources.js` |
| `disposeAll()` | Best-effort, idempotent disposal. Clears tracked timers first, then runs tracked disposers in LIFO order. | IO runtime | `lib/IoPluginResources.js` |
| `setTimeout(fn, delayMs, ...args)` | Tracks a one-shot timeout and forgets the handle automatically after the callback fires. | IO runtime | `lib/IoPluginResources.js` |
| `clearTimeout(handle)` | Clears a tracked timeout and forgets it. | IO runtime | `lib/IoPluginResources.js` |
| `setInterval(fn, intervalMs, ...args)` | Tracks an interval handle. | IO runtime | `lib/IoPluginResources.js` |
| `clearInterval(handle)` | Clears a tracked interval and forgets it. | IO runtime | `lib/IoPluginResources.js` |
| `wrapSubscribeApi(subscribeApi)` | Returns a frozen wrapper around `ctx.api.iobroker.subscribe.*` that auto-tracks subscriptions and forgets them again when manual unsubs happen. Reuses one wrapped object per raw subscribe API object. | IO runtime | `lib/IoPluginResources.js` |

### `IoManagedMeta`

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `new IoManagedMeta(adapter, { hostName? })` | Requires `adapter.namespace`. Builds an ioBroker API wrapper and starts the best-effort janitor timer. | IO runtime | `lib/IoManagedMeta.js` |
| `dispose()` | Stops the janitor timer. | IO runtime | `lib/IoManagedMeta.js` |
| `runJanitorOnce()` | Public one-shot janitor trigger, primarily for tests/manual debugging. | IO runtime | `lib/IoManagedMeta.js` |
| `createReporter({ category, type, instanceId, pluginBaseObjectId })` | Returns a frozen reporter `{ report, applyReported }` bound to one plugin identity. | IO runtime | `lib/IoManagedMeta.js` |
| `report(ids, { managedText? })` | Buffers one id or an array of ids for the reporter. Non-string ids are ignored. | IO runtime | `lib/IoManagedMeta.js` |
| `applyReported()` | Ensures the watchlist state exists, writes the sorted JSON watchlist, and stamps each reported object under `common.custom.<namespace>` with `managedMeta-*` fields and `enabled: true`. Always best-effort. | IO runtime | `lib/IoManagedMeta.js` |
| `clearWatchlist({ type, instanceId })` | Clears buffered ids, resets the existing watchlist state to `'[]'`, and starts background orphan cleanup for the previously listed ids. Does not create the watchlist state when it does not exist yet. | IO runtime | `lib/IoManagedMeta.js` |

## IO <> UI

### `main.js` message command routing

| Incoming command shape | Routed to | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `ui.bootstrap` | `IoAdminCapabilities.buildBootstrap({ host: 'admin' })` | Neutral bootstrap endpoint. Admin-host response is `{ ok: true, data: { capabilities, about } }`, where `capabilities.admin`, `capabilities.config`, and `capabilities.web` each carry `{ token, expiresAt }` with a fixed `2h` TTL. | Composition root / IO runtime | `main.js`, `lib/IoAdminCapabilities.js` |
| Browser token binding | The AdminTab browser runtime consumes `ui.bootstrap`, caches the grants centrally, injects `payload.token` into every `admin.*`, `config.*`, and `web.*` request, refreshes grants below the 15-minute remainder threshold, and performs one forced re-bootstrap retry on the first token-related failure of the current browser session. | Browser/UI boundary over IO runtime | `admin/tab/runtime.js`, `lib/IoAdminCapabilities.js`, `main.js` |
| `admin.*` | `IoAdminTab.handleCommand(cmd, payload)` | Requires `_adminTab`; otherwise returns `NOT_READY`. `main.js` stays thin and does not perform central token gating; the facade validates `payload.token` through `IoAdminCapabilities`. | Composition root / IO runtime | `main.js`, `lib/IoAdminTab.js` |
| `web.*` | `IoWebUi.handleCommand(cmd, payload)` | Requires `_webUi`; otherwise returns `NOT_READY`. `main.js` stays thin and does not perform central token gating; the facade validates `payload.token` through `IoAdminCapabilities`. | Composition root / IO runtime | `main.js`, `lib/IoWebUi.js` |
| `config.*` | `IoAdminConfig.handleCommand(cmd, payload)` | Requires `_adminConfig`; otherwise returns `NOT_READY`. `main.js` stays thin and does not perform central token gating; the facade validates `payload.token` through `IoAdminCapabilities`. | Composition root / IO runtime | `main.js`, `lib/IoAdminConfig.js` |
| `runtime.about` | `IoAdminCapabilities.buildAbout()` via `main.js` | Legacy/shared about payload. Returns `{ ok: true, data: { title, version, time, lang, connection } }`. It is no longer the target bootstrap contract; `ui.bootstrap` owns that role. | Composition root / IO runtime | `main.js`, `lib/IoAdminCapabilities.js`, `lib/IoCoreConnection.js` |
| Any other command | `IoPlugins.dispatchMessagebox(obj)` | Engage/messagebox escape hatch. `null` becomes `NOT_READY`. | Composition root / IO runtime | `main.js`, `lib/IoPlugins.js` |

### `IoAdminTab` command surface

| Command | Runtime dependency | IO-owned validation / behavior | Response family | Reference |
| --- | --- | --- | --- | --- |
| `admin.plugins.getCatalog` | `ioPlugins.getCatalog()` | Requires a valid admin token via `payload.token`. Returns `NOT_READY` when plugin runtime is not wired. | `{ ok, data: { plugins } }` | `lib/IoAdminTab.js` |
| `admin.plugins.listInstances` | `ioPlugins.getCatalog()`, `ioPlugins.listInstances()` | Requires a valid admin token via `payload.token`. Returns `NOT_READY` when plugin runtime is not wired. Logs unknown `native.*` keys best-effort. | `{ ok, data: { instances } }` | `lib/IoAdminTab.js` |
| `admin.plugins.createInstance` | `ioPlugins.createInstance(payload)` | Requires a valid admin token via `payload.token`. Runtime-owned payload validation lives in `IoPlugins`. | `{ ok, data: { instanceId } }` | `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `admin.plugins.updateInstance` | `ioPlugins.updateInstanceNative(payload)` | Requires a valid admin token via `payload.token`. Runtime-owned payload validation lives in `IoPlugins`. | `{ ok, data: {} }` | `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `admin.plugins.setEnabled` | `ioPlugins.setInstanceEnabled(payload)` | Requires a valid admin token via `payload.token`. Runtime-owned payload validation lives in `IoPlugins`. | `{ ok, data: {} }` | `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `admin.plugins.deleteInstance` | `ioPlugins.deleteInstance(payload)` | Requires a valid admin token via `payload.token`. Runtime-owned payload validation lives in `IoPlugins`. | `{ ok, data: {} }` | `lib/IoAdminTab.js`, `lib/IoPlugins.js` |
| `admin.pluginUi.rpc` | `IoPluginUiRpc.handleAdminRpc(payload)` | Requires a valid admin token via `payload.token`. Thin admin-host facade over the shared PluginUi RPC dispatcher. Validates identity and payload size, resolves the target through the canonical plugin-panel resolver, and dispatches to `handleAdminUiRpc`. | `{ ok, data|error }` | `lib/IoAdminTab.js`, `lib/IoPluginUiRpc.js`, `lib/IoPluginPanelResolver.js` |
| `admin.messages.delete` | `msgStore.removeMessage(ref, { actor: 'AdminTab' })` | Requires a valid admin token via `payload.token`. Trims refs, deduplicates them, rejects zero refs, rejects more than 5000 refs, and returns per-ref misses. | `{ ok, data: { requested, deleted, missing } }` | `lib/IoAdminTab.js` |
| `admin.ingestStates.presets.selectOptions*` | `ioPlugins.callPluginRuntime({ type: 'IngestStates', method: 'getPresetSelectOptions', ... })` | Documented backend exception: reachable without `payload.token` for external `jsonCustom` callers. When a token is supplied, the facade may validate it via `IoAdminCapabilities`; in all cases the business payload reaches IngestStates without `token`. Sanitizes the result to `Array<{ value, label }>` and returns `[]` when the plugin runtime is unavailable. | Bare array, not an `{ ok, data }` envelope | `lib/IoAdminTab.js` |
| empty or non-string `admin.*` command | none | `IoAdminTab.handleCommand(...)` returns `BAD_REQUEST` when `cmd` is blank or not a string. | `{ ok: false, error }` | `lib/IoAdminTab.js` |
| unknown `admin.*` command | none | `IoAdminTab.handleCommand(...)` returns `UNKNOWN_COMMAND` when no dispatch-table entry matches the command. | `{ ok: false, error }` | `lib/IoAdminTab.js` |

### `IoWebUi` command surface

| Command | Runtime dependency | IO-owned validation / behavior | Response family | Reference |
| --- | --- | --- | --- | --- |
| `web.stats.get` | `msgStore.getStats({ include })` | Requires a valid web token via `payload.token`. Normalizes `include.archiveSize` and non-negative `include.archiveSizeMaxAgeMs`; returns `NOT_READY` when stats runtime is absent. | `{ ok, data: MsgStatsSnapshot }` | `lib/IoWebUi.js`, `src/MsgStats.js` |
| `web.messages.query` | `msgStore.queryMessages(query)` | Requires a valid web token via `payload.token`. Passes through only `query.where`, `query.page`, and `query.sort`; serializes maps to JSON-safe objects; attaches `meta.generatedAt` and local `tz`; returns `BAD_REQUEST` on query errors. | `{ ok, data: { meta, items, total?, pages? } }` | `lib/IoWebUi.js`, `src/MsgStore.js` |
| `web.messages.action` | `msgStore.msgActions.execute({ ref, actionId, actor: 'WebUi' })` | Requires a valid web token via `payload.token`, plus `ref` and `actionId`; returns `REJECTED` when the executor returns false. | `{ ok, data: { executed: true } }` or `{ ok: false, error }` | `lib/IoWebUi.js` |
| `web.constants.get` | `msgStore.msgConstants` | Requires a valid web token via `payload.token`. Returns only `kind`, `lifecycle.state`, `level`, and `notfication.events`. | `{ ok, data: { kind, lifecycle, level, notfication } }` | `lib/IoWebUi.js` |
| `web.pluginUi.bundle.get` | `IoPluginPanelResolver.getPanelByRef(...)`, `ioPlugins.readAdminUiBundle(...)` | Requires a valid web token via `payload.token`. Shared-safe bundle path. Validates `pluginType` and `panelId`, normalizes `instanceId` to integer or `0`, normalizes bundle language and optional `include` / `exclude` projection, resolves the target through the canonical plugin-panel resolver, caches by `(pluginType, instanceId, panelId, hash, lang, projection)`, and enforces JS size `<= 512 KiB` and CSS size `<= 64 KiB` when those parts are present. | `{ ok, data: { apiVersion, moduleFormat: 'esm', hash, ...parts } }` | `lib/IoWebUi.js`, `lib/IoPlugins.js`, `lib/IoPluginPanelResolver.js` |
| `web.pluginUi.rpc` | `IoPluginUiRpc.handleWebRpc(payload)` | Requires a valid web token via `payload.token`. Thin web-host facade over the shared PluginUi RPC dispatcher. Validates identity and payload size, resolves the target through the canonical plugin-panel resolver, and dispatches to `handleWebUiRpc`. | `{ ok, data|error }` | `lib/IoWebUi.js`, `lib/IoPluginUiRpc.js`, `lib/IoPluginPanelResolver.js` |
| `web.ping` | none | Requires a valid web token via `payload.token`. Fixed health probe command. | `{ ok: true, data: 'pong' }` | `lib/IoWebUi.js` |
| empty or non-string web command | none | `IoWebUi.handleCommand(...)` returns `BAD_REQUEST` when `cmd` is blank or not a string. | `{ ok: false, error }` | `lib/IoWebUi.js` |
| unknown `web.*` command | none | `IoWebUi.handleCommand(...)` returns `UNKNOWN_COMMAND` when no dispatch-table entry matches the command. | `{ ok: false, error }` | `lib/IoWebUi.js` |

### `IoAdminConfig` command surface

| Command | Runtime dependency | IO-owned validation / behavior | Response family | Reference |
| --- | --- | --- | --- | --- |
| `config.archive.status` | `msgStore.msgArchive.getStatus()` | Requires a valid config token via `payload.token`. Returns `NOT_READY` when the archive runtime is absent. Otherwise returns runtime transparency only. Mirrors runtime archive fields into `native.*`, then filters them through the native allowlist. | `{ ok, data: { archive }, native? }` | `lib/IoAdminConfig.js` |
| `config.archive.retryNative` | `msgStore.msgArchive.getStatus()`, `IoArchiveResolver.probeNativeFor(...)` or injected probe hook | Requires a valid config token via `payload.token`. Probes native viability against current runtime roots. On success returns a startup-time lock intent for `native` plus `restartRequired: true`. On probe failure returns `NATIVE_PROBE_FAILED`. | `{ ok, data, native? }` | `lib/IoAdminConfig.js` |
| `config.archive.forceIobroker` | none beyond current archive snapshot | Requires a valid config token via `payload.token`. Returns explicit startup-time lock intent for the ioBroker writer strategy plus `restartRequired: true`. | `{ ok, data, native }` | `lib/IoAdminConfig.js` |
| `config.ai.test` | `ai.createCallerApi(...)` or an isolated temporary `MsgAi` runtime | Requires a valid config token via `payload.token`. Diagnostics-only connectivity check. Stores the compact summary in `native.aiTestLastResult`. Optional payload overrides may create an isolated temporary AI runtime instead of mutating the shared one. | `{ native: { aiTestLastResult } }`, then allowlist-filtered | `lib/IoAdminConfig.js` |
| Unknown `config.*` | none | Returns `UNKNOWN_COMMAND`. | `{ ok: false, error }` | `lib/IoAdminConfig.js` |

### IO-owned native patch allowlist for `config.*`

| Native key | Meaning | Owner | Reference |
| --- | --- | --- | --- |
| `archiveEffectiveStrategyLock` | Persisted lock intent for archive strategy selection at next startup. | IO runtime | `lib/IoAdminConfig.js` |
| `archiveLockReason` | Human/machine-readable reason for the archive strategy lock. | IO runtime | `lib/IoAdminConfig.js` |
| `archiveLockedAt` | Millisecond timestamp of the current archive strategy lock intent. | IO runtime | `lib/IoAdminConfig.js` |
| `archiveRuntimeStrategy` | Current runtime archive strategy mirror for config transparency. | IO runtime | `lib/IoAdminConfig.js` |
| `archiveRuntimeReason` | Current runtime archive strategy reason mirror. | IO runtime | `lib/IoAdminConfig.js` |
| `archiveRuntimeRoot` | Current runtime archive root mirror. | IO runtime | `lib/IoAdminConfig.js` |
| `aiTestLastResult` | Latest compact AI test result string for config feedback. | IO runtime | `lib/IoAdminConfig.js` |

## IO Invariants

| Contract | Notes | Owner | Reference |
| --- | --- | --- | --- |
| `main.js` is composition root only | It wires IO services together and routes messages/state changes, but it is not a separate IO API domain. | Composition root | `main.js` |
| Control-state handling short-circuits ingest forwarding | When `IoPlugins.handleStateChange(...)` returns `true`, `main.js` must not forward that state change to ingest plugins. | Composition root / IO runtime | `main.js`, `lib/IoPlugins.js` |
| Gate watchers are side-channel notifications, not event consumption | `handleGateStateChange(...)` does not stop normal ingest dispatch. `main.js` calls it before forwarding non-null states to ingest plugins. | Composition root / IO runtime | `main.js`, `lib/IoPlugins.js` |
| `IoAdminTab` owns only `admin.*` | Config commands are explicitly out of scope and belong to `IoAdminConfig`. | IO runtime | `lib/IoAdminTab.js`, `lib/IoAdminConfig.js` |
| `IoWebUi` owns the migrated web-safe command set | `web.ping`, `web.stats.get`, `web.constants.get`, `web.messages.query`, `web.messages.action`, `web.pluginUi.bundle.get`, and `web.pluginUi.rpc` no longer live under `admin.*` except for the intentionally separate `admin.pluginUi.rpc`. | IO runtime | `lib/IoWebUi.js`, `lib/IoAdminTab.js` |
| `IoAdminConfig` native writes are hard-scoped | Any `native.*` keys outside `CONFIG_NATIVE_ALLOWLIST` are dropped before the response leaves `IoAdminConfig`. | IO runtime | `lib/IoAdminConfig.js` |
| `IoAdminCapabilities` is the single bootstrap/about authority | `main.js` delegates admin-host `ui.bootstrap` to `IoAdminCapabilities`, and legacy `runtime.about` reuses the same `about` builder instead of defining a separate target contract in `main.js`. | Composition root / IO runtime | `main.js`, `lib/IoAdminCapabilities.js` |
| `payload.token` is the canonical privileged-namespace token contract | `IoAdminCapabilities` defines `payload.token` as the uniform backend token contract for `admin.*`, `config.*`, and `web.*`. `IoAdminTab`, `IoAdminConfig`, and `IoWebUi` enforce it facade-side before business execution. The single documented backend exception is `admin.ingestStates.presets.selectOptions*` for external `jsonCustom` callers. | IO runtime | `lib/IoAdminCapabilities.js`, `lib/IoAdminTab.js`, `lib/IoAdminConfig.js`, `lib/IoWebUi.js` |
| Plugin Admin UI contributions are runtime-only | `getAdminUiContributions()` includes only currently registered plugin instances with `manifest.adminUi`. Configured but not started plugins are excluded. | IO runtime | `lib/IoPlugins.js` |
| PluginUi RPC is host-bound and split by hook | The backend path owns `pluginType`, `instanceId`, and `panelId`. Admin RPC calls `handleAdminUiRpc`; web RPC calls `handleWebUiRpc`; both flow through the shared dispatcher `IoPluginUiRpc`. | IO runtime | `lib/IoAdminTab.js`, `lib/IoWebUi.js`, `lib/IoPluginUiRpc.js` |
| `admin.ingestStates.presets.selectOptions*` intentionally breaks the normal envelope rule | This pass-through returns a bare select-options array instead of `{ ok, data }` so jsonCustom-style callers can consume it directly. | IO runtime | `lib/IoAdminTab.js` |
| Resource and managed-metadata cleanup are best-effort | `IoPluginResources` disposal and `IoManagedMeta` stamping/janitor work must never crash the adapter. | IO runtime | `lib/IoPluginResources.js`, `lib/IoManagedMeta.js` |
