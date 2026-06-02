# Core API Reference

This document covers core-owned contracts in `src/`.

Plugin-facing ctx member tables live in [`docs/plugins/API.md`](../plugins/API.md). IO-brokered runtime and Admin contracts live in [`docs/io/API.md`](../io/API.md). Browser/UI contracts live in [`docs/ui/API.md`](../ui/API.md).

## Scope

| Field | Value |
| --- | --- |
| Scope | Core-owned entry points, core-owned data contracts, and invariants that IO and plugins must respect. `MsgStorage` and `MsgArchive` are core infrastructure included here as source-of-truth modules, but their external contract is surfaced through `MsgStore` rather than as standalone IO/plugin entry points. |
| In scope | `src/MsgAction.js`, `src/MsgAi.js`, `src/MsgArchive.js`, `src/MsgBridge.js`, `src/MsgConfig.js`, `src/MsgConstants.js`, `src/MsgEngage.js`, `src/MsgFactory.js`, `src/MsgHostApi.js`, `src/MsgIngest.js`, `src/MsgNotificationPolicy.js`, `src/MsgNotify.js`, `src/MsgRender.js`, `src/MsgStorage.js`, `src/MsgStore.js` |
| Out of scope | IO plugin discovery/registration/admin routing, browser/runtime host wiring, plugin manifest schema, plugin bundle/UI contracts |
| Source of truth | `src/MsgAction.js`, `src/MsgAi.js`, `src/MsgArchive.js`, `src/MsgBridge.js`, `src/MsgConfig.js`, `src/MsgConstants.js`, `src/MsgEngage.js`, `src/MsgFactory.js`, `src/MsgHostApi.js`, `src/MsgIngest.js`, `src/MsgNotificationPolicy.js`, `src/MsgNotify.js`, `src/MsgRender.js`, `src/MsgStorage.js`, `src/MsgStore.js` |

## Area Ownership

| Contract area | Core owner | Neighbor reference |
| --- | --- | --- |
| Canonical message mutation, rendered read boundary, lifecycle maintenance | `MsgStore` | [`docs/io/API.md`](../io/API.md) for IO transport surfaces |
| Config normalization and public config snapshot | `MsgConfig` | [`docs/plugins/API.md`](../plugins/API.md) for the plugin-facing snapshot surface |
| Core constants and enum values | `MsgConstants` | [`docs/plugins/API.md`](../plugins/API.md) for host-exposed constant access |
| Message creation, patching, and normalization | `MsgFactory` | [`docs/plugins/API.md`](../plugins/API.md) for factory access exposed by ingest hosts |
| Ingest host registration and dispatch | `MsgIngest` | [`docs/plugins/API.md`](../plugins/API.md) for plugin-facing ctx members |
| Notification host registration and dispatch | `MsgNotify` | [`docs/plugins/API.md`](../plugins/API.md) for plugin-facing ctx members |
| Bidirectional bridge / engage wiring helpers | `MsgBridge`, `MsgEngage` | [`docs/plugins/API.md`](../plugins/API.md) for plugin runtime usage |
| Host API facade builders | `MsgHostApi` | [`docs/plugins/API.md`](../plugins/API.md) for the resulting facades |
| Core action execution | `MsgAction` | [`docs/plugins/API.md`](../plugins/API.md) for Engage-side `ctx.api.action` exposure |
| AI facade for plugin hosts | `MsgAi` | [`docs/plugins/API.md`](../plugins/API.md) for host-exposed AI access |
| Rendered output boundary | `MsgRender` | [`docs/io/API.md`](../io/API.md) for IO-side consumers of rendered results |
| Due-notification scheduling policy | `MsgNotificationPolicy` | [`docs/io/API.md`](../io/API.md) for IO-side consumers of due-related results |
| Persistence and archive infrastructure | `MsgStorage`, `MsgArchive` | Publicly surfaced through `MsgStore`; this file does not treat them as standalone IO/plugin entry domains |

## Core Entry Points

### MsgStore

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `new MsgStore(adapter, msgConstants, msgFactory, options)` | Requires `adapter`, `msgConstants`, `msgFactory`, and `options.store`, `options.storage`, `options.archive`. Creates `msgStorage`, `msgArchive`, `msgRender`, `msgNotify`, `msgIngest`, and `msgActions`. Construction is synchronous and does not perform I/O. | `MsgStore` | `src/MsgStore.js` |
| `await store.init({ loadFromStorage = true } = {})` | Idempotent startup step. Initializes storage and archive. When `loadFromStorage` is true, replaces `fullList` from persisted JSON, then runs a forced prune. Starts the due-notification interval only when `notifierIntervalMs > 0`. | `MsgStore` | `src/MsgStore.js` |
| `store.msgIngest` | Ingest host instance created by the store. Primary entry point for inbound ioBroker state/object/action fan-out. | `MsgStore` | `src/MsgStore.js`, `src/MsgIngest.js` |
| `store.msgNotify` | Notify host instance created by the store. Primary entry point for outbound notification fan-out. | `MsgStore` | `src/MsgStore.js`, `src/MsgNotify.js` |
| `store.addMessage(msg)` | Adds a normalized message object to the canonical list. Rejects invalid payloads, empty refs, non-integer `level`, and duplicate refs unless all existing same-ref entries are quasi-deleted. Persists, archives, dispatches `added` / `recreated` / `recovered`, and may dispatch immediate `due`. | `MsgStore` | `src/MsgStore.js` |
| `store.updateMessage(msgOrRef, patch?, stealthMode = false, _coreToken?)` | Updates an existing message through `MsgFactory.applyPatch(...)`. External callers must not rely on `_coreToken`; the core uses it to allow lifecycle transitions to `deleted` / `expired`. Non-silent updates dispatch `update` and may dispatch immediate `due`. | `MsgStore` | `src/MsgStore.js` |
| `store.addOrUpdateMessage(msg)` | Upsert helper. Uses `getMessageByRef(ref, 'quasiOpen')` to decide between update and recreate/add semantics. | `MsgStore` | `src/MsgStore.js` |
| `store.getMessageByRef(reference, filter = 'all')` | Returns the first matching message as a rendered output view. Supported filters: `'all'`, `'quasiDeleted'`, `'quasiOpen'`, or an explicit lifecycle-state allowlist array. Returns `undefined` when no match exists. | `MsgStore` | `src/MsgStore.js` |
| `store.getMessages()` | Returns a raw snapshot clone of the canonical list. Output is not rendered. | `MsgStore` | `src/MsgStore.js` |
| `store.queryMessages({ where, page, sort } = {})` | Core-owned JSON-friendly query API over the canonical list. Applies a throttled prune first, filters raw messages, then renders only the final result page. Full request/response contract is defined below. | `MsgStore` | `src/MsgStore.js` |
| `store.removeMessage(reference, { actor? } = {})` | Soft-deletes an existing message by patching `lifecycle.state = 'deleted'` through the core-only lifecycle override path, clears `timing.notifyAt`, and dispatches `deleted`. Physical removal happens later through hard-delete retention. | `MsgStore` | `src/MsgStore.js` |
| `store.onUnload()` | Stops ingest plugins, stops notify plugins, clears the due timer and hard-delete timer, and best-effort flushes storage and archive buffers without awaiting them. | `MsgStore` | `src/MsgStore.js` |

### MsgIngest

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `new MsgIngest(adapter, msgConstants, msgFactory, msgStore, { ai? } = {})` | Requires `adapter`, `msgConstants`, `msgFactory`, and `msgStore`. Builds a frozen `api` facade from `MsgHostApi`. | `MsgIngest` | `src/MsgIngest.js`, `src/MsgHostApi.js` |
| `ingest.api` | Frozen plugin ctx API surface containing `constants`, `config`, `factory`, `store`, `ai`, `i18n`, `format`, `iobroker`, and `log`. Member-level plugin-facing detail is documented in [`docs/plugins/API.md`](../plugins/API.md). | `MsgIngest` | `src/MsgIngest.js`, `src/MsgHostApi.js` |
| `ingest.registerPlugin(id, handler)` | Registers a producer plugin. `handler` may be a function `(id, state, ctx)` or an object with optional `start(ctx)`, `stop(ctx)`, `onStateChange(id, state, ctx)`, `onObjectChange(id, obj, ctx)`, `onAction(actionInfo, ctx)`. Re-registering the same `id` overwrites the previous plugin and best-effort stops it when the host is already running. | `MsgIngest` | `src/MsgIngest.js` |
| `ingest.unregisterPlugin(id)` | Removes a registered plugin. No-op for unknown ids. Best-effort calls the plugin `stop(ctx)` when the host is running. | `MsgIngest` | `src/MsgIngest.js` |
| `ingest.start(meta = {})` | Marks the host as running and best-effort calls every registered plugin `start(ctx)`. Only `meta.managedObjects` is persisted into `_baseMeta` for later ctx builds; other startup-only keys do not carry forward. | `MsgIngest` | `src/MsgIngest.js` |
| `ingest.stop(meta = {})` | Best-effort calls every registered plugin `stop(ctx)` with `ctx.meta.running` still reflecting the pre-stop state, then marks the host as not running. | `MsgIngest` | `src/MsgIngest.js` |
| `ingest.dispatchStateChange(id, state, meta = {})` | Fans one ioBroker state change out to all registered `onStateChange` handlers. Returns the number of handlers called. Invalid/blank ids short-circuit to `0`. | `MsgIngest` | `src/MsgIngest.js` |
| `ingest.dispatchObjectChange(id, obj, meta = {})` | Fans one ioBroker object change out to all registered `onObjectChange` handlers. Returns the number of handlers called. Invalid/blank ids short-circuit to `0`. | `MsgIngest` | `src/MsgIngest.js` |
| `ingest.dispatchAction(actionInfo, meta = {})` | Fans one action-execution event out to all registered `onAction` handlers. Returns the number of handlers called. Non-object payloads short-circuit to `0`. | `MsgIngest` | `src/MsgIngest.js` |
| `ctx.meta` merge rule | Every plugin callback receives `{ api, meta }`. `meta` is built as `{ ..._baseMeta, ...callMeta, running }`, so call-specific keys override persisted base meta, and `running` is always injected last. | `MsgIngest` | `src/MsgIngest.js` |

### MsgIngest action info DTO

| Field | Type | Notes |
| --- | --- | --- |
| `ref` | `string` | Expected message ref. |
| `actionId` | `string` | Expected action identifier. |
| `type` | `string` | Expected action type. |
| `ts` | `number` | Expected timestamp in ms. |
| `actor` | `string?` | Optional attribution. |
| `payload` | `any` | Optional action payload. |
| `message` | `object?` | Optional message snapshot. |

`dispatchAction(...)` only checks that the payload is an object. The minimal field list above is the contract documented by `MsgIngest` itself.

### MsgNotify

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `new MsgNotify(adapter, msgConstants, { store, ai } = {})` | Requires `adapter` and `msgConstants`. Starts with `_running = true`. Builds a frozen `api` facade from `MsgHostApi`. | `MsgNotify` | `src/MsgNotify.js`, `src/MsgHostApi.js` |
| `notify.api` | Frozen plugin ctx API surface containing `constants`, `config`, `i18n`, `format`, `iobroker`, `log`, `store`, and `ai`. Member-level plugin-facing detail is documented in [`docs/plugins/API.md`](../plugins/API.md). | `MsgNotify` | `src/MsgNotify.js`, `src/MsgHostApi.js` |
| `notify.registerPlugin(id, handler)` | Registers a notification plugin. `handler` may be a function `(event, notificationsArray, ctx)` or an object with required `onNotifications(event, notificationsArray, ctx)` and optional `start(ctx)` / `stop(ctx)`. Re-registering the same `id` overwrites the previous plugin and best-effort stops it first. If `_running` is true, `start(ctx)` runs immediately after registration. | `MsgNotify` | `src/MsgNotify.js` |
| `notify.unregisterPlugin(id)` | Removes a registered plugin. No-op for unknown ids. Best-effort calls the plugin `stop(ctx)` when `_running` is true. | `MsgNotify` | `src/MsgNotify.js` |
| `notify.dispatch(event, messages, meta = {})` | Accepts the notification event value from `MsgConstants.notfication.events`, not the object key. Normalizes `messages` to an array, ignores invalid entries, and dispatches each valid message separately. Returns the number of dispatched messages. Throws on unsupported event values. | `MsgNotify` | `src/MsgNotify.js` |
| Internal per-plugin call shape | Each plugin invocation receives `(event, [notification], ctx)`. Even when `dispatch(...)` is called with an array, `MsgNotify` still invokes plugins one message at a time with a one-element array. | `MsgNotify` | `src/MsgNotify.js` |
| `notify.stop(meta = {})` | Best-effort calls every registered plugin `stop(ctx)`, then marks the host as not running. There is no matching public `start()` method; the host is active from construction until stopped. | `MsgNotify` | `src/MsgNotify.js` |
| `ctx.meta` merge rule | Every plugin callback receives `{ api, meta }`. `meta` is built as `{ ...callMeta, running }`, so the injected `running` flag always reflects the current host state. | `MsgNotify` | `src/MsgNotify.js` |

### MsgBridge and MsgEngage

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `MsgBridge.registerBridge(id, handler, { msgIngest, msgNotify, log } = {})` | Registers one bidirectional integration as two plugins. Requires `msgIngest.registerPlugin/unregisterPlugin`, `msgNotify.registerPlugin/unregisterPlugin`, a non-empty `id`, a handler object with required `onNotifications(...)`, and at least one inbound method among `start`, `onStateChange`, `onObjectChange`. Registration order is always ingest-first. | `MsgBridge` | `src/MsgBridge.js` |
| Bridge handler split | `start` and `stop` are wired only on the ingest side. Notify registration only exposes `onNotifications(...)`. | `MsgBridge` | `src/MsgBridge.js` |
| Bridge IDs | Deterministic derived ids: `ingestId = \`${id}.ingest\``, `notifyId = \`${id}.notify\``. | `MsgBridge` | `src/MsgBridge.js` |
| Bridge rollback | If notify registration throws after ingest registration succeeded, `MsgBridge` performs best-effort rollback by calling `unregister()` and then rethrows the original error. | `MsgBridge` | `src/MsgBridge.js` |
| `MsgEngage.registerEngage(id, handler, deps)` | Engage-specific wrapper over `MsgBridge.registerBridge(...)`. Requires `adapter`, `msgConstants`, and `store`, plus `msgIngest` / `msgNotify`. Resolves an action API from `deps.action` or `buildActionApi(...)`; throws when no executable `action.execute(...)` can be built. | `MsgEngage` | `src/MsgEngage.js`, `src/MsgHostApi.js`, `src/MsgBridge.js` |
| Engage ctx decoration | Rebuilds `ctx.api` with an injected `action` facade and freezes the result before forwarding `start`, `stop`, `onStateChange`, `onObjectChange`, and `onNotifications`. Default notify ctx does not contain `action`; Engage adds it explicitly. | `MsgEngage` | `src/MsgEngage.js` |
| Registration handle | Both `registerBridge(...)` and `registerEngage(...)` return a frozen handle `{ ingestId, notifyId, unregister() }`. `unregister()` is best-effort, idempotent, and never throws. | `MsgBridge` / `MsgEngage` | `src/MsgBridge.js`, `src/MsgEngage.js` |

### MsgHostApi builders

| Builder | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `buildLogApi(adapter, { hostName })` | Returns a strict string-only logger facade with `silly/debug/info/warn/error`. Each method throws on non-string input. Exposes internal `__bindCaller(pluginMeta)` to prepend `baseOwnId` prefixes. | `MsgHostApi` | `src/MsgHostApi.js` |
| `buildI18nApi(adapter)` | Returns `null` unless `adapter.i18nCore.t` exists. Otherwise returns `{ t, getTranslatedObject, i18nlocale }`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `buildFormatApi(adapter)` | Returns `null` unless `adapter.i18nCore` is an object. Otherwise returns `{ formatlocale }`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `buildConfigApi(adapterOrSnapshot)` | Returns the public config snapshot only when `schemaVersion` is a finite positive number. Does not reshape or whitelist fields. Otherwise returns `null`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `buildStoreApi(store, { hostName })` | Returns `null` unless `store` is an object. Always exposes `getMessageByRef`, `getMessages`, `queryMessages`. For ingest hosts only, additionally exposes `addMessage`, `updateMessage`, `addOrUpdateMessage`, `removeMessage`, and `completeAfterCauseEliminated`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `buildActionApi(adapter, msgConstants, store, { hostName })` | Returns `null` when `adapter`, `msgConstants`, or `store` is absent, outside Engage hosts, when `store.getMessageByRef` or `store.updateMessage` is unavailable, or when `store.msgActions.execute` is unavailable. Otherwise returns `{ execute }`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `buildFactoryApi(msgFactory, { hostName })` | Returns `null` outside ingest hosts or when `msgFactory.createMessage` is unavailable. Otherwise returns `{ createMessage }`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `buildAiApi(msgAi)` | Returns `null` unless `msgAi.getStatus` exists. Otherwise returns `{ getStatus, text, json }` and internal `__bindCaller(pluginMeta)` when `msgAi.createCallerApi(...)` is available. | `MsgHostApi` | `src/MsgHostApi.js` |
| `buildIdsApi(adapter)` | Returns `{ namespace, toOwnId(fullId), toFullId(ownId) }`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `buildIoBrokerApi(adapter, { hostName })` | Returns the ioBroker facade used by plugin hosts. Always includes `ids`, `sendTo`, `objects.*`, `states.*`, and `files.*`. Includes `subscribe.*` only for non-notify hosts. The detailed plugin-facing member reference belongs to [`docs/plugins/API.md`](../plugins/API.md). | `MsgHostApi` | `src/MsgHostApi.js` |

## Core-Owned Data Contracts

### `store.queryMessages(...)` request envelope

| Field | Type | Contract |
| --- | --- | --- |
| `where` | `object?` | Filter object. Unknown keys are ignored. |
| `sort` | `Array<{ field: string, dir?: 'asc' \| 'desc' }>?` | Optional sort list. Unknown fields are ignored. `dir` defaults to `'asc'`. |
| `page` | `{ size?: number, index?: number }?` | Optional pagination. `index` is 1-based. When `size` is missing or `<= 0`, paging is disabled. |

### `store.queryMessages(...)` supported `where` fields

| Field | Accepted shapes | Contract |
| --- | --- | --- |
| `where.kind` | `string` or `{ in?: string[], notIn?: string[] }` | Enum filter. `{ in }` and `{ notIn }` are mutually exclusive. |
| `where.origin.type` | `string` or `{ in?: string[], notIn?: string[] }` | Enum filter. |
| `where.origin.system` | `string` or `{ in?: string[], notIn?: string[] }` | Enum filter. |
| `where.lifecycle.state` | `string` or `{ in?: string[], notIn?: string[] }` | Enum filter. Deleted/expired messages are hidden by default unless this field explicitly includes them via scalar or `{ in: [...] }`. |
| `where.level` | `number` or `{ in?: number[], notIn?: number[], min?: number, max?: number }` | Inclusive numeric filter. `{ in }` and `{ notIn }` are mutually exclusive. Ranges may be combined with allow/deny lists. |
| `where.timing.createdAt` | `number` or `{ min?: number, max?: number, orMissing?: boolean }` | Inclusive numeric range. `orMissing` matches `undefined` / `null` only. |
| `where.timing.updatedAt` | `number` or `{ min?: number, max?: number, orMissing?: boolean }` | Inclusive numeric range. |
| `where.timing.expiresAt` | `number` or `{ min?: number, max?: number, orMissing?: boolean }` | Inclusive numeric range. |
| `where.timing.notifyAt` | `number` or `{ min?: number, max?: number, orMissing?: boolean }` | Inclusive numeric range. |
| `where.timing.remindEvery` | `number` or `{ min?: number, max?: number, orMissing?: boolean }` | Inclusive numeric range. |
| `where.timing.timeBudget` | `number` or `{ min?: number, max?: number, orMissing?: boolean }` | Inclusive numeric range. |
| `where.timing.dueAt` | `number` or `{ min?: number, max?: number, orMissing?: boolean }` | Inclusive numeric range. |
| `where.timing.startAt` | `number` or `{ min?: number, max?: number, orMissing?: boolean }` | Inclusive numeric range. |
| `where.timing.endAt` | `number` or `{ min?: number, max?: number, orMissing?: boolean }` | Inclusive numeric range. |
| `where.details.location` | `string`, `string[]`, or `{ in?: string[] }` | String allowlist filter. Implies existence. |
| `where.audience.tags` | `string`, `string[]`, or `{ any?: string[], all?: string[], orMissing?: boolean }` | Includes filter over `message.audience.tags`. `{ any }` and `{ all }` are mutually exclusive. Empty arrays count as missing. |
| `where.audience.channels` | `null`, `string`, `string[]`, or `{ routeTo: null \| string \| string[] }` | Matches through `shouldDispatchByAudienceChannels(...)`. `null` is passed as the default-channel probe. |
| `where.dependencies` | `string`, `string[]`, or `{ any?: string[], all?: string[], orMissing?: boolean }` | Includes filter over `message.dependencies`. `{ any }` and `{ all }` are mutually exclusive. |

### `store.queryMessages(...)` supported sort fields

| Sort field |
| --- |
| `ref` |
| `icon` |
| `title` |
| `text` |
| `level` |
| `kind` |
| `origin.type` |
| `origin.system` |
| `lifecycle.state` |
| `details.location` |
| `timing.createdAt` |
| `timing.updatedAt` |
| `timing.expiresAt` |
| `timing.notifyAt` |
| `timing.remindEvery` |
| `timing.timeBudget` |
| `timing.dueAt` |
| `timing.startAt` |
| `timing.endAt` |
| `progress.percentage` |

Missing sort values are always ordered last. Ties are broken by `ref` for deterministic paging.

### `store.queryMessages(...)` response

| Field | Type | Contract |
| --- | --- | --- |
| `total` | `number` | Match count before paging. |
| `pages` | `number` | `Math.ceil(total / size)` when paging is enabled, otherwise `1`. |
| `items` | `object[]` | Rendered output messages from the selected page. |

| `io.storage` | `object \| null` | `MsgStorage.getStatus()` pass-through, defined below. |
| `io.archive` | `object \| null` | `MsgArchive.getStatus()` pass-through, defined below. |

### `MsgStorage.getStatus()` DTO

| Field | Type | Notes |
| --- | --- | --- |
| `filePath` | `string` | Effective file path for the JSON document. |
| `runtimeRoot` | `string` | Backend runtime root. |
| `writeIntervalMs` | `number` | Write coalescing interval. |
| `lastPersistedAt` | `number \| null` | Timestamp of the last completed persist. |
| `lastPersistedBytes` | `number \| null` | Byte count of the last completed persist. |
| `lastPersistedMode` | `string \| null` | Backend write mode, e.g. atomic override/rename mode. |
| `pending` | `boolean` | `true` while a throttled write promise exists. |

### `MsgArchive.getStatus()` DTO

| Field | Type | Notes |
| --- | --- | --- |
| `baseDir` | `string` | Archive base directory relative to the backend root. |
| `configuredStrategyLock` | `string` | Requested strategy lock (`''`, `'native'`, `'iobroker'`). |
| `effectiveStrategy` | `string` | Effective archive backend strategy. |
| `effectiveStrategyReason` | `string` | Reason for the effective strategy. |
| `nativeRootDir` | `string` | Native archive root when available. |
| `runtimeRoot` | `string` | Backend runtime root. |
| `nativeProbeError` | `string` | Native strategy probe error text when present. |
| `writeDisabled` | `boolean` | Whether archive writes are disabled. |
| `fileExtension` | `string` | Archive segment extension without leading dot. |
| `flushIntervalMs` | `number` | Archive flush interval. |
| `maxBatchSize` | `number` | Forced flush threshold per ref queue. |
| `keepPreviousWeeks` | `number` | Retained previous weekly segments in addition to the current one. |
| `lastFlushedAt` | `number \| null` | Timestamp of the last completed archive flush. |
| `pending.refs` | `number` | Number of refs with queued events. |
| `pending.events` | `number` | Total queued event count. |
| `pending.flushingRefs` | `number` | Number of refs currently flushing. |
| `approxSizeBytes` | `number \| null` | Best-effort cached size estimate. |
| `approxSizeUpdatedAt` | `number \| null` | Timestamp of the cached size estimate. |
| `approxSizeIsComplete` | `boolean` | Whether the estimate covered the full archive. |

## Core Invariants

| Invariant | Contract owner | Reference |
| --- | --- | --- |
| `MsgStore.fullList` is the canonical raw message list. Rendered output is a boundary view only and must not be written back as canonical state. | `MsgStore` | `src/MsgStore.js` |
| Message mutation is centralized in `MsgStore.addMessage(...)`, `updateMessage(...)`, `addOrUpdateMessage(...)`, and `removeMessage(...)`. External code must not bypass store mutation semantics. | `MsgStore` | `src/MsgStore.js` |
| `getMessages()` returns raw snapshot clones, while `getMessageByRef()` and `queryMessages()` return rendered output views. | `MsgStore` | `src/MsgStore.js` |
| Notify dispatch always receives rendered messages. Storage and archive writes always use canonical raw messages. | `MsgStore` | `src/MsgStore.js` |
| `queryMessages(...)` hides `deleted` and `expired` by default. They are included only when `where.lifecycle.state` explicitly includes them. | `MsgStore` | `src/MsgStore.js` |
| Core-only lifecycle transitions to `deleted` and `expired` rely on the internal `_CORE_LIFECYCLE_TOKEN`; that override is not a public external contract. | `MsgStore` | `src/MsgStore.js` |
| Due-notification policy is store-owned. `MsgStore` may reopen snoozed messages, reschedule quiet-hours repeats, reschedule or clear `notifyAt`, and append `timing.notifiedAt[event]` markers before/after notify dispatch. | `MsgStore` | `src/MsgStore.js` |
| `MsgNotify.dispatch(...)` accepts notification event values only, not constant object keys. | `MsgNotify` | `src/MsgNotify.js` |
| Each notify plugin call receives a one-element notification array even when dispatch starts from a multi-message batch. | `MsgNotify` | `src/MsgNotify.js` |
| Bridge registration order is ingest-first, IDs are deterministic, and rollback is best-effort rather than atomic. | `MsgBridge` | `src/MsgBridge.js` |
| `ctx.api.action` is not part of the default notify host surface. It is injected only by `MsgEngage`. | `MsgEngage` | `src/MsgEngage.js`, `src/MsgHostApi.js` |
| `MsgHostApi` capability derivation is host-sensitive: store writes/factory exist only for ingest hosts, action only for Engage hosts, subscribe helpers are omitted on notify hosts. | `MsgHostApi` | `src/MsgHostApi.js` |
