# Plugin API

| Item | Contract |
| --- | --- |
| Scope | Plugin-facing contracts only. |
| In scope | Plugin factories, handler entry points, plugin runtime `ctx`, plugin discovery/runtime wiring, plugin-owned Admin UI declarations, plugin-owned Admin UI backend hooks, plugin bundle ctx. |
| Out of scope | Full core DTO schemas, full Admin Tab command atlas, general architecture, non-plugin system APIs. |
| Source of truth | `src/MsgHostApi.js`, `src/MsgIngest.js`, `src/MsgNotify.js`, `src/MsgEngage.js`, `src/MsgBridge.js`, `lib/IoPlugins.js`, `lib/IoPluginResources.js`, `lib/IoManagedMeta.js`, `lib/index.js`, plugin manifests, `lib/IngestStates/index.js`, `lib/IngestStates/admin-ui/rpc.js`, `lib/IngestStates/admin-ui/presets-service.js`, `lib/IngestStates/admin-ui/bulkapply-service.js`, `admin/tab/plugin-ui-host.js`. |

| Availability label | Meaning |
| --- | --- |
| `all plugin ctx` | Available in every handler call context that reaches a running plugin. |
| `ingest-derived ctx` | `MsgIngest` ctx, bridge ingest-side ctx, engage ingest-side ctx. |
| `notify-derived ctx` | `MsgNotify` ctx, bridge notify-side ctx, engage notify-side ctx. |
| `engage ctx` | Any ctx passed to an Engage plugin after `MsgEngage` adds `ctx.api.action`. |

## Plugin <> Core

### Factory and handler entry points

| Entry | Ingest | Notify | Bridge | Engage | Contract | Owner | Reference |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `create(options)` | Yes | Yes | Yes | Yes | Plugin factory. Called as `create(options)` with no adapter argument. Must return the handler shape required by the category. | IO runtime calling core hosts | `lib/IoPlugins.js`, `lib/index.js` |
| Function shorthand | Yes | Yes | No | No | Bare function is accepted. Ingest shorthand means `onStateChange(id, state, ctx)`. Notify shorthand means `onNotifications(event, notifications, ctx)`. | Core hosts | `src/MsgIngest.js`, `src/MsgNotify.js` |
| `start(ctx)` | Optional | Optional | Optional | Optional | Lifecycle start hook. For bridge/engage handlers it is wired on the ingest side only. | Core hosts | `src/MsgIngest.js`, `src/MsgNotify.js`, `src/MsgBridge.js`, `src/MsgEngage.js` |
| `stop(ctx)` | Optional | Optional | Optional | Optional | Lifecycle stop hook. For bridge/engage handlers it is wired on the ingest side only. | Core hosts | `src/MsgIngest.js`, `src/MsgNotify.js`, `src/MsgBridge.js`, `src/MsgEngage.js` |
| `onStateChange(id, state, ctx)` | Optional | No | Optional | Optional | ioBroker state-change handler. | Core hosts | `src/MsgIngest.js`, `src/MsgBridge.js`, `src/MsgEngage.js` |
| `onObjectChange(id, obj, ctx)` | Optional | No | Optional | Optional | ioBroker object-change handler. | Core hosts | `src/MsgIngest.js`, `src/MsgBridge.js`, `src/MsgEngage.js` |
| `onAction(actionInfo, ctx)` | Optional | No | No | No | Ingest-only action-event hook. `actionInfo` is expected to be a plain object and is typically shaped like `{ ref, actionId, type, ts, actor?, payload?, message? }`. | `MsgIngest` | `src/MsgIngest.js` |
| `onNotifications(event, notifications, ctx)` | No | Required | Required | Required | Notification handler. `event` is a value from `ctx.api.constants.notfication.events`. `notifications` is always an array. | `MsgNotify` / bridge wiring / engage wiring | `src/MsgNotify.js`, `src/MsgBridge.js`, `src/MsgEngage.js` |

### Host-provided `ctx.api`

| Entry | Available in ctx | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `ctx.api.constants` | all plugin ctx | Full `MsgConstants` object as exposed by the host. The nested schema is core-owned. | Core hosts | `src/MsgIngest.js`, `src/MsgNotify.js` |
| `ctx.api.config` | all plugin ctx | Effective config snapshot or `null`. Presence requires a positive numeric `schemaVersion`. Treat as read-only snapshot. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.log.silly(message)` | all plugin ctx | String-only log call. Throws `TypeError` for non-string input. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.log.debug(message)` | all plugin ctx | String-only log call. Throws `TypeError` for non-string input. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.log.info(message)` | all plugin ctx | String-only log call. Throws `TypeError` for non-string input. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.log.warn(message)` | all plugin ctx | String-only log call. Throws `TypeError` for non-string input. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.log.error(message)` | all plugin ctx | String-only log call. Throws `TypeError` for non-string input. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.i18n` | all plugin ctx | Optional i18n facade or `null`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.i18n.t(key, ...args)` | all plugin ctx when `ctx.api.i18n !== null` | Forwards to the wired runtime translator. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.i18n.getTranslatedObject(obj, lang)` | all plugin ctx when `ctx.api.i18n !== null` | Forwards to the wired runtime translator. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.i18n.i18nlocale` | all plugin ctx when `ctx.api.i18n !== null` | Runtime i18n locale string. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.format` | all plugin ctx | Optional format facade or `null`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.format.formatlocale` | all plugin ctx when `ctx.api.format !== null` | Runtime format locale string. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.ai` | all plugin ctx | Optional AI facade or `null`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.ai.getStatus()` | all plugin ctx when `ctx.api.ai !== null` | Forwards to the wired AI status API. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.ai.text(request)` | all plugin ctx when `ctx.api.ai !== null` | Forwards to the wired AI text API. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.ai.json(request)` | all plugin ctx when `ctx.api.ai !== null` | Forwards to the wired AI JSON API. | `MsgHostApi` | `src/MsgHostApi.js` |
### Store, factory, and action capabilities

| Entry | Available in ctx | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `ctx.api.store` | all plugin ctx when a store is wired | Store facade or `null`. Write methods are only exposed on ingest-derived ctx. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.store.getMessageByRef(ref, filter?)` | all plugin ctx when `ctx.api.store !== null` | Forwards to `store.getMessageByRef(ref, filter)`. Filter semantics are store-owned. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.store.getMessages()` | all plugin ctx when `ctx.api.store !== null` | Forwards to `store.getMessages()`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.store.queryMessages(options)` | all plugin ctx when `ctx.api.store !== null` | Forwards to `store.queryMessages(options)`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.store.addMessage(msg)` | ingest-derived ctx when `ctx.api.store !== null` | Forwards to `store.addMessage(msg)`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.store.updateMessage(msgOrRef, patch)` | ingest-derived ctx when `ctx.api.store !== null` | Forwards to `store.updateMessage(msgOrRef, patch)`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.store.addOrUpdateMessage(msg)` | ingest-derived ctx when `ctx.api.store !== null` | Forwards to `store.addOrUpdateMessage(msg)`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.store.removeMessage(ref, { actor? })` | ingest-derived ctx when `ctx.api.store !== null` | Removes by `ref`. Blank refs return `false`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.store.completeAfterCauseEliminated(ref, { actor? })` | ingest-derived ctx when `ctx.api.store !== null` | Convenience helper. Status messages are removed. Task messages are closed with `progress.percentage = 100` and `timing.notifyAt = null`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.factory` | ingest-derived ctx | Factory facade or `null`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.factory.createMessage(data)` | ingest-derived ctx when `ctx.api.factory !== null` | Forwards to `msgFactory.createMessage(data)`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.action` | engage ctx | Action facade or `null`. | `MsgHostApi` / `MsgEngage` | `src/MsgHostApi.js`, `src/MsgEngage.js` |
| `ctx.api.action.execute({ ref, actionId, actor?, payload?, snoozeForMs? })` | engage ctx when `ctx.api.action !== null` | Executes a whitelisted message action through `msgAction.execute(...)`. | `MsgHostApi` / `MsgEngage` | `src/MsgHostApi.js`, `src/MsgEngage.js` |

### ioBroker facade

| Entry | Available in ctx | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `ctx.api.iobroker.ids.namespace` | all plugin ctx | Adapter namespace string. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.ids.toOwnId(fullId)` | all plugin ctx | Strips the adapter namespace prefix when present. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.ids.toFullId(ownId)` | all plugin ctx | Adds the adapter namespace prefix when missing. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.sendTo(instance, command, message?, options?)` | all plugin ctx | Promisified `adapter.sendTo(...)`. `instance` and `command` must be non-empty strings. Sending to the own namespace is rejected. Default timeout is `10000` ms. `timeoutMs <= 0` disables the timeout. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.objects.setObjectNotExists(ownId, obj)` | all plugin ctx | Creates an own object under the adapter namespace when missing. Returns a `Promise<void>`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.objects.delObject(ownId)` | all plugin ctx | Deletes an own object. Returns a `Promise<void>`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.objects.getObjectView(design, search, params)` | all plugin ctx | Forwards to the Objects DB view query. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.objects.getForeignObjects(pattern, type?)` | all plugin ctx | Reads foreign objects by pattern. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.objects.getForeignObject(id)` | all plugin ctx | Reads one foreign object by id. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.objects.extendForeignObject(id, patch)` | all plugin ctx | Patches one foreign object by id. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.states.setState(ownId, state)` | all plugin ctx | Writes one own state. Returns a `Promise<void>`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.states.setForeignState(id, state)` | all plugin ctx | Writes one foreign state. Returns a `Promise<void>`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.states.getForeignState(id)` | all plugin ctx | Reads one foreign state. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.subscribe.subscribeStates(pattern)` | ingest-derived ctx | Subscribes to own states. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.subscribe.unsubscribeStates(pattern)` | ingest-derived ctx | Unsubscribes from own states. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.subscribe.subscribeObjects(pattern)` | ingest-derived ctx | Subscribes to own objects. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.subscribe.unsubscribeObjects(pattern)` | ingest-derived ctx | Unsubscribes from own objects. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.subscribe.subscribeForeignStates(pattern)` | ingest-derived ctx | Subscribes to foreign states. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.subscribe.unsubscribeForeignStates(pattern)` | ingest-derived ctx | Unsubscribes from foreign states. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.subscribe.subscribeForeignObjects(pattern)` | ingest-derived ctx | Subscribes to foreign objects. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.subscribe.unsubscribeForeignObjects(pattern)` | ingest-derived ctx | Unsubscribes from foreign objects. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.files.readFile(metaId, filePath)` | all plugin ctx | Reads one ioBroker file-storage entry. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.files.writeFile(metaId, filePath, data)` | all plugin ctx | Writes one ioBroker file-storage entry. Returns a `Promise<void>`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.files.mkdir(metaId, dirPath)` | all plugin ctx | Creates one ioBroker file-storage directory. Returns a `Promise<void>`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.files.renameFile(metaId, oldPath, newPath)` | all plugin ctx | Renames or moves one ioBroker file-storage entry. Returns a `Promise<void>`. | `MsgHostApi` | `src/MsgHostApi.js` |
| `ctx.api.iobroker.files.deleteFile(metaId, filePath)` | all plugin ctx | Deletes one ioBroker file-storage entry. Returns a `Promise<void>`. | `MsgHostApi` | `src/MsgHostApi.js` |

### Host-provided `ctx.meta`

| Entry | Available in ctx | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `ctx.meta.running` | all plugin ctx | Best-effort host running flag. | Core hosts | `src/MsgIngest.js`, `src/MsgNotify.js` |
| `ctx.meta.event` | all plugin ctx when supplied by the caller | Dispatch metadata passthrough. The hosts do not define the enum here; they only forward the provided value. | Core hosts | `src/MsgIngest.js`, `src/MsgNotify.js` |
| Additional `ctx.meta.*` keys from dispatch callers | all plugin ctx | Caller-provided metadata is merged through unchanged before IO runtime decoration. Plugins must tolerate extra keys. | Core hosts | `src/MsgIngest.js`, `src/MsgNotify.js` |

### Core-side invariants

| Contract | Notes | Owner | Reference |
| --- | --- | --- | --- |
| Notify dispatch is one-message-at-a-time | `MsgNotify.dispatch(...)` normalizes input to an array but internally calls plugins one notification at a time, always as `[notification]`. | `MsgNotify` | `src/MsgNotify.js` |
| Notify events are event values, not enum keys | `MsgNotify.dispatch(...)` validates against `Object.values(ctx.api.constants.notfication.events)`. | `MsgNotify` | `src/MsgNotify.js` |
| `ctx.api.store` write methods are host-derived, not category-derived | Bridge and Engage plugins receive write-capable store methods only on ingest-derived ctx. Their notify-derived ctx stays read-only. | `MsgHostApi` / wiring helpers | `src/MsgHostApi.js`, `src/MsgBridge.js`, `src/MsgEngage.js` |
| `ctx.api.action` is not part of plain ingest/notify ctx | Only `MsgEngage` injects action capability. | `MsgEngage` | `src/MsgEngage.js` |
| Bridge and Engage handlers cannot use `onAction` as a wiring hook | `MsgBridge` and `MsgEngage` only wire `start`, `stop`, `onStateChange`, `onObjectChange`, `onNotifications`. | `MsgBridge` / `MsgEngage` | `src/MsgBridge.js`, `src/MsgEngage.js` |

## Plugin <> IO

### Runtime discovery and registration

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| Builtin package discovery | Builtin runtime discovery scans `lib/*/manifest.js` and resolves plugin package descriptors with `sourceKind`, `sourceId`, and `packageRoot`. Host-side consumers work against those resolved descriptors, not against repo-path assumptions. | `lib/index.js` | `lib/index.js` |
| Manifest export | `manifest.js` must export `{ manifest }`. | `lib/index.js` | `lib/index.js` |
| Factory export | The plugin module must export a factory function named exactly like `manifest.type`. | `lib/index.js` | `lib/index.js` |
| Category resolution | `manifest.category` is used when present. Otherwise the category is inferred from the `type` prefix: `Ingest*`, `Notify*`, `Bridge*`, `Engage*`. Even when `manifest.category` is set explicitly, the `type` must still start with the expected prefix for that category; `IoPlugins` enforces this during runtime initialization. | `lib/index.js` / `IoPlugins` | `lib/index.js`, `lib/IoPlugins.js` |
| Discovery exclusion | `manifest.hidden === true` or `manifest.discoverable === false` excludes the plugin from the runtime catalog. | `lib/index.js` | `lib/index.js` |
| Registration id | Runtime registration ids are always `${type}:${instanceId}`. | `IoPlugins` | `lib/IoPlugins.js` |
| Bridge child ids | `MsgBridge` derives child ids as `${regId}.ingest` and `${regId}.notify`. | `MsgBridge` | `src/MsgBridge.js` |
| Engage child ids | `MsgEngage` reuses `MsgBridge` child-id rules after decorating the ctx with `ctx.api.action`. | `MsgEngage` | `src/MsgEngage.js` |

### Factory input assembled by `IoPlugins`

| Entry | Availability | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| Raw `native` options | all plugin categories | Plugin factories receive the plugin base object `native` merged over manifest-derived defaults. | `IoPlugins` | `lib/IoPlugins.js` |
| Reserved `native.enabled` | all plugin categories | Reserved for runtime state mirroring. Not forwarded to `create(options)`. | `IoPlugins` | `lib/IoPlugins.js` |
| Reserved `native.instances` | all plugin categories | Reserved. Not forwarded to `create(options)`. | `IoPlugins` | `lib/IoPlugins.js` |
| `native.channel` | all plugin categories | Forwarded unchanged when present and copied into `ctx.meta.plugin.channel`. It is runtime-owned, not part of `manifest.options`. | `IoPlugins` / Admin runtime | `lib/IoPlugins.js`, `lib/IoAdminTab.js` |
| `options.pluginBaseObjectId` | all plugin categories | Full base object id for the plugin instance. Matches `ctx.meta.plugin.baseFullId`. | `IoPlugins` | `lib/IoPlugins.js` |
| `options.__messagebox.register(handler)` | engage only | Internal escape hatch for direct ioBroker messagebox ownership. Exactly one Engage plugin instance may own the messagebox handler at a time. | `IoPlugins` | `lib/IoPlugins.js` |
| `options.__messagebox.unregister()` | engage only | Releases the messagebox handler when the current plugin owns it. | `IoPlugins` | `lib/IoPlugins.js` |

### Manifest fields consumed by the runtime

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `manifest.schemaVersion` | Numeric manifest schema version. Copied into `ctx.meta.plugin.manifest.schemaVersion`. | Plugin-owned, consumed by IO runtime | plugin manifests, `lib/IoPlugins.js` |
| `manifest.type` | Stable plugin type. Also drives export name and registration id prefix. | Plugin-owned, consumed by IO runtime | plugin manifests, `lib/index.js`, `lib/IoPlugins.js` |
| `manifest.defaultEnabled` | Default enable state for newly seeded instances. | Plugin-owned, consumed by IO runtime | plugin manifests, `lib/IoPlugins.js` |
| `manifest.supportsMultiple` | Allows multiple numeric instance ids when true. | Plugin-owned, consumed by IO runtime | plugin manifests, `lib/IoPlugins.js` |
| `manifest.supportsChannelRouting` | Enables notification pre-filtering against `ctx.meta.plugin.channel`. | Plugin-owned, consumed by IO runtime | plugin manifests, `lib/IoPlugins.js` |
| `manifest.title` | Forwarded into catalog/admin DTOs and into `ctx.meta.plugin.manifest.title`. | Plugin-owned, consumed by IO runtime | plugin manifests, `lib/IoPlugins.js` |
| `manifest.description` | Forwarded into catalog/admin DTOs and into `ctx.meta.plugin.manifest.description`. | Plugin-owned, consumed by IO runtime | plugin manifests, `lib/IoPlugins.js` |
| `manifest.options` | Full option-schema object. Runtime resolvers only consume per-option `default`, `min`, `max`, and `trim`. The rest is forwarded unchanged to admin/runtime consumers. | Plugin-owned, consumed by IO runtime | plugin manifests, `lib/IoPlugins.js` |
| `manifest.adminUi` | Plugin-owned Admin UI declaration. Not copied into `ctx.meta.plugin.manifest`; see `Plugin <> UI`. | Plugin-owned, consumed by UI/IO runtime | `lib/IngestStates/manifest.js`, `lib/IoPlugins.js` |

### `ctx.meta.plugin.*`

| Entry | Availability | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `ctx.meta.plugin.category` | all plugin ctx when wired through `IoPlugins` | `ingest`, `notify`, `bridge`, or `engage`. | `IoPlugins` | `lib/IoPlugins.js` |
| `ctx.meta.plugin.type` | all plugin ctx when wired through `IoPlugins` | Plugin type string such as `NotifyStates`. | `IoPlugins` | `lib/IoPlugins.js` |
| `ctx.meta.plugin.instanceId` | all plugin ctx when wired through `IoPlugins` | Numeric plugin instance id. | `IoPlugins` | `lib/IoPlugins.js` |
| `ctx.meta.plugin.regId` | all plugin ctx when wired through `IoPlugins` | Registration id `${type}:${instanceId}`. | `IoPlugins` | `lib/IoPlugins.js` |
| `ctx.meta.plugin.baseFullId` | all plugin ctx when wired through `IoPlugins` | Full base object id including adapter namespace. | `IoPlugins` | `lib/IoPlugins.js` |
| `ctx.meta.plugin.baseOwnId` | all plugin ctx when wired through `IoPlugins` | Own base object id without adapter namespace. | `IoPlugins` | `lib/IoPlugins.js` |
| `ctx.meta.plugin.channel` | all plugin ctx when wired through `IoPlugins` | Optional runtime routing channel from `native.channel`. Empty string when absent. | `IoPlugins` | `lib/IoPlugins.js` |
| `ctx.meta.plugin.manifest` | all plugin ctx when wired through `IoPlugins` | Manifest-like subset containing exactly `schemaVersion`, `type`, `defaultEnabled`, `supportsMultiple`, `supportsChannelRouting`, `title`, `description`, and `options`. | `IoPlugins` | `lib/IoPlugins.js` |

### `ctx.meta.options.*`

| Entry | Availability | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `ctx.meta.options.resolveInt(key, value)` | all plugin ctx when wired through `IoPlugins` | Reads the option spec from `manifest.options[key]`, falls back to `default`, coerces to a finite integer, then clamps with `min` and `max` when present. | `IoPlugins` | `lib/IoPlugins.js` |
| `ctx.meta.options.resolveBool(key, value)` | all plugin ctx when wired through `IoPlugins` | Accepts only literal booleans. Non-boolean input falls back to `spec.default === true`. | `IoPlugins` | `lib/IoPlugins.js` |
| `ctx.meta.options.resolveString(key, value)` | all plugin ctx when wired through `IoPlugins` | Falls back to string default. Trims by default. `spec.trim === false` preserves whitespace. Non-string input falls back to the default. | `IoPlugins` | `lib/IoPlugins.js` |

### `ctx.meta.resources.*`

| Entry | Availability | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `ctx.meta.resources.setTimeout(fn, delayMs, ...args)` | all plugin ctx when wired through `IoPlugins` | Creates a tracked timeout. The handle is removed automatically after the callback fires. | `IoPluginResources` | `lib/IoPluginResources.js` |
| `ctx.meta.resources.clearTimeout(handle)` | all plugin ctx when wired through `IoPlugins` | Clears a tracked timeout and forgets it. | `IoPluginResources` | `lib/IoPluginResources.js` |
| `ctx.meta.resources.setInterval(fn, intervalMs, ...args)` | all plugin ctx when wired through `IoPlugins` | Creates a tracked interval. | `IoPluginResources` | `lib/IoPluginResources.js` |
| `ctx.meta.resources.clearInterval(handle)` | all plugin ctx when wired through `IoPlugins` | Clears a tracked interval and forgets it. | `IoPluginResources` | `lib/IoPluginResources.js` |
| `ctx.meta.resources.add(disposer)` | all plugin ctx when wired through `IoPlugins` | Registers a best-effort disposer. Supported shapes: `() => void` and `{ dispose() }`. | `IoPluginResources` | `lib/IoPluginResources.js` |

### `ctx.meta.gates.*`

| Entry | Availability | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `ctx.meta.gates.register(options)` | all plugin ctx when wired through `IoPlugins` | Registers a gate watcher and returns `{ dispose() }` or `null`. Required fields: `id`, `op`. Optional fields: `value`, `onOpen`, `onClose`, `onChange`, `fireOnInit`. Supported operators: `true`, `false`, `=`, `>`, `<`. | `IoPlugins` | `lib/IoPlugins.js` |
| Gate callback info | all plugin ctx when `ctx.meta.gates.register(...)` is used | `onOpen`, `onClose`, and `onChange` receive `{ id, open, prevOpen, state }`. | `IoPlugins` | `lib/IoPlugins.js` |

### `ctx.meta.managedObjects.*`

| Entry | Availability | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `ctx.meta.managedObjects.report(ids, { managedText? })` | all plugin ctx for ingest/bridge/engage plugins when wired through `IoPlugins` | Buffers managed-object ids. Accepts one id or an array of ids. | `IoManagedMeta` | `lib/IoManagedMeta.js`, `lib/IoPlugins.js` |
| `ctx.meta.managedObjects.applyReported()` | all plugin ctx for ingest/bridge/engage plugins when wired through `IoPlugins` | Flushes the buffered managed-object ids: updates the watchlist state and stamps managed metadata on the reported objects. | `IoManagedMeta` | `lib/IoManagedMeta.js`, `lib/IoPlugins.js` |

### IO-brokered plugin API behavior

| Entry | Availability | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `ctx.api.templates.renderStates(text)` | all plugin ctx when wired through `IoPlugins` and when `ctx.api.iobroker.states.getForeignState` exists | Replaces `{id}` placeholders by reading the referenced foreign state ids. Missing or unreadable states become empty strings. Returns `Promise<string>`. Non-string input throws `TypeError`. | `IoPlugins` | `lib/IoPlugins.js` |
| `ctx.api.iobroker.subscribe.*` | ingest-derived ctx when wired through `IoPlugins` | Wrapped so subscriptions are tracked and automatically cleaned up on stop/unregister. Manual unsubscribe removes the tracked disposer. | `IoPluginResources` / `IoPlugins` | `lib/IoPluginResources.js`, `lib/IoPlugins.js` |
| `ctx.api.log.*` | all plugin ctx when wired through `IoPlugins` | Rebound so every log line is prefixed with `ctx.meta.plugin.baseOwnId`. Method names stay the same. | `IoPlugins` / `MsgHostApi` | `lib/IoPlugins.js`, `src/MsgHostApi.js` |
| `ctx.api.ai.*` | all plugin ctx when wired through `IoPlugins` and when AI is enabled | Rebound per plugin caller. The visible method names stay the same. | `IoPlugins` / `MsgHostApi` | `lib/IoPlugins.js`, `src/MsgHostApi.js` |

### IO-side invariants

| Contract | Notes | Owner | Reference |
| --- | --- | --- | --- |
| Resource cleanup is automatic on plugin stop/unregister | `IoPlugins` calls `resources.disposeAll()` in wrapped `stop(...)` paths. | `IoPlugins` / `IoPluginResources` | `lib/IoPlugins.js`, `lib/IoPluginResources.js` |
| Gate watchers subscribe to own or foreign states automatically | Own namespace ids use `subscribeStates`; foreign ids use `subscribeForeignStates`. | `IoPlugins` | `lib/IoPlugins.js` |
| Gate read failure degrades open, not closed | When priming fails, the watcher is marked `open = true` and a warning is logged. | `IoPlugins` | `lib/IoPlugins.js` |
| Channel routing is pre-filtered before `onNotifications(...)` is called | Applies only when `ctx.meta.plugin.manifest.supportsChannelRouting === true`. Non-routing plugins receive the full list. | `IoPlugins` | `lib/IoPlugins.js` |
| Managed metadata is best-effort | `applyReported()` updates `<Type>.<instanceId>.watchlist` and stamps `common.custom.<namespace>.managedMeta-*` without throwing into plugin code. | `IoManagedMeta` | `lib/IoManagedMeta.js` |

### `IngestStates.getPresetSelectOptions(...)`

| Item | Contract | Owner | Reference |
| --- | --- | --- | --- |
| Scope | IO/Admin-runtime path, not the plugin UI host path. Called by `IoAdminTab._ingestStatesPassThrough(...)` through `IoPlugins.callPluginRuntime(...)`. | IO/Admin runtime | `lib/IoAdminTab.js`, `lib/IoPlugins.js` |

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `getPresetSelectOptions({ suffix?, payload? }, ctx?)` | Current plugin runtime method on `IngestStates`. The current host call path supplies only the first argument. Returns `Promise<Array<{ value: string, label: string }>>`. | Plugin-owned, called by IO/Admin runtime | `lib/IngestStates/index.js`, `lib/IoAdminTab.js` |
| `suffix` parsing | The runtime entry interprets `suffix` as `rule[.subset]`. A leading `.` is ignored. | `IngestStates` | `lib/IngestStates/index.js` |
| Payload override | `payload.rule` and `payload.subset` override values derived from the suffix when present. | `IngestStates` | `lib/IngestStates/index.js` |
| `currentValue` handling | When the currently saved preset is filtered out, it is injected back into the returned option list as the first option. | `IngestStates` | `lib/IngestStates/admin-ui/presets-service.js` |
| Return type | Always `Array<{ value: string, label: string }>`; no response envelope. | `IngestStates` | `lib/IngestStates/index.js`, `lib/IngestStates/admin-ui/presets-service.js` |

## Plugin <> UI

### Plugin-owned Admin UI declaration

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `manifest.adminUi.apiVersion` | Admin UI API version string. Current runtime defaults to `'1'` when omitted. | Plugin-owned, consumed by IO/UI runtime | `lib/IngestStates/manifest.js`, `lib/IoPlugins.js` |
| `manifest.adminUi.panels[]` | Flat panel contribution list. Only running plugin instances with declared panels are exposed to the host. | Plugin-owned, consumed by IO/UI runtime | `lib/IngestStates/manifest.js`, `lib/IoPlugins.js` |
| `panel.id` | Panel id, unique within the plugin type. | Plugin-owned | `lib/IngestStates/manifest.js` |
| `panel.title` | Optional translated title object shown in the Admin Tab when present. | Plugin-owned | `lib/IngestStates/manifest.js` |
| `panel.description` | Optional translated description object shown in host DTOs when present. | Plugin-owned | `lib/IngestStates/manifest.js` |
| `panel.bundle.entry` | Relative path to the ESM bundle inside the plugin package root (`packageRoot`). Required. | Plugin-owned, consumed by IO/UI runtime | `lib/IngestStates/manifest.js`, `lib/IoPlugins.js` |
| Companion CSS | Optional stylesheet at the same path as `panel.bundle.entry` with `.js` replaced by `.css`. There is no separate manifest field for CSS. | UI host convention | `lib/IoPlugins.js`, `admin/tab/plugin-ui-host.js` |
| Plugin-owned Admin UI i18n | Optional files under `admin-ui/i18n/<lang>.json`. Loaded by the browser runtime for plugin UI bundles and also visible to backend runtime i18n when the keys use the plugin namespace. | Plugin-owned, consumed by IO/UI runtime | `lib/IoPlugins.js`, `admin/tab/runtime.js` |
| Plugin-owned Backend i18n | Optional files under `packageRoot/i18n/<lang>.json`. Keys must use prefix `msghub.i18n.<TypeName>.*`; foreign keys are rejected with warn. Loaded together with optional `packageRoot/admin-ui/i18n` files by `IoPlugins` on register; removed on unregister. | Plugin-owned, consumed by IoRuntimeI18n | `lib/IoPlugins.js`, `lib/IoRuntimeI18n.js` |

### Current plugin-owned Admin UI contributors

| Plugin type | Panel id | apiVersion | Bundle entry | Owner | Reference |
| --- | --- | --- | --- | --- | --- |
| `IngestStates` | `presets` | `1` | `admin-ui/dist/presets.esm.js` | Plugin manifest | `lib/IngestStates/manifest.js` |
| `IngestStates` | `bulkapply` | `1` | `admin-ui/dist/bulkapply.esm.js` | Plugin manifest | `lib/IngestStates/manifest.js` |

### Plugin runtime methods used by the UI/runtime host

| Entry | Availability | Contract | Owner | Reference |
| --- | --- | --- | --- | --- |
| `handleAdminUiRpc({ panelId, command, payload }, ctx?)` | Optional plugin runtime method | Admin-host backend hook for panel RPC. Return contract: `Promise<{ ok: true, data: any } | { ok: false, error: { code: string, message: string } }>` | Plugin-owned, called by UI/IO runtime | `lib/IngestStates/index.js`, `lib/IngestStates/admin-ui/rpc.js` |
| `handleWebUiRpc({ panelId, command, payload }, ctx?)` | Optional plugin runtime method | Web-host backend hook for panel RPC. Return contract matches `handleAdminUiRpc`. Plugins may share an internal dispatcher, but the public hook split is explicit. | Plugin-owned, called by UI/IO runtime | `lib/IngestStates/index.js`, `lib/IngestStates/admin-ui/rpc.js` |

### Current `IngestStates` Admin UI RPC commands

| Panel | Command | Request payload | Success data | Plugin-owned error codes | Owner | Reference |
| --- | --- | --- | --- | --- | --- | --- |
| `presets` | `presets.bootstrap` | `null` or ignored | `{ ingestConstants: { presetSchema, presetTemplate, presetBindingCatalog, ruleTemplateCatalog }, msgConstants: { kind, level } }` | `INTERNAL` only through the RPC dispatcher catch path | `IngestStates` | `lib/IngestStates/admin-ui/rpc.js`, `lib/IngestStates/admin-ui/presets-service.js` |
| `presets` | `presets.list` | `{ rule?, subset?, includeUsage? }` | `Array<{ value, source, ownedBy, subset, kind, level, name, hasOwner, usageCount? }>` | `INTERNAL` only through the RPC dispatcher catch path | `IngestStates` | `lib/IngestStates/admin-ui/rpc.js`, `lib/IngestStates/admin-ui/presets-service.js` |
| `presets` | `presets.get` | `{ presetId }` | `{ presetId, preset, object, state }` | `BAD_REQUEST`, `NOT_FOUND`, `INVALID_PRESET` | `IngestStates` | `lib/IngestStates/admin-ui/rpc.js`, `lib/IngestStates/admin-ui/presets-service.js` |
| `presets` | `presets.create` | `{ preset }` where `preset.presetId` must be absent | `{ presetId }` | `BAD_REQUEST`, `FORBIDDEN`, `CONFLICT` | `IngestStates` | `lib/IngestStates/admin-ui/rpc.js`, `lib/IngestStates/admin-ui/presets-service.js` |
| `presets` | `presets.update` | `{ presetId, preset }` | `{ presetId }` | `BAD_REQUEST`, `NOT_FOUND`, `FORBIDDEN` | `IngestStates` | `lib/IngestStates/admin-ui/rpc.js`, `lib/IngestStates/admin-ui/presets-service.js` |
| `presets` | `presets.delete` | `{ presetId }` | `{ deleted: boolean, presetId }` | `BAD_REQUEST`, `FORBIDDEN` | `IngestStates` | `lib/IngestStates/admin-ui/rpc.js`, `lib/IngestStates/admin-ui/presets-service.js` |
| `bulkapply` | `bulkapply.bootstrap` | `null` or ignored | `{ namespace, jsonCustomDefaults }` | `INTERNAL` only through the RPC dispatcher catch path | `IngestStates` | `lib/IngestStates/admin-ui/rpc.js`, `lib/IngestStates/admin-ui/bulkapply-service.js` |
| `bulkapply` | `bulkapply.configRead` | `{ id }` | `{ custom: object | null }` | `BAD_REQUEST`, `NOT_FOUND` | `IngestStates` | `lib/IngestStates/admin-ui/rpc.js`, `lib/IngestStates/admin-ui/bulkapply-service.js` |
| `bulkapply` | `bulkapply.preview` | `{ pattern, custom, replace?, limit? }` | `{ pattern, totalObjects, matchedStates, willChange, unchanged, sample }` | `BAD_REQUEST` | `IngestStates` | `lib/IngestStates/admin-ui/rpc.js`, `lib/IngestStates/admin-ui/bulkapply-service.js` |
| `bulkapply` | `bulkapply.apply` | `{ pattern, custom, replace? }` | `{ errors: Array<{ id: string, message: string }> }` | `BAD_REQUEST` | `IngestStates` | `lib/IngestStates/admin-ui/rpc.js`, `lib/IngestStates/admin-ui/bulkapply-service.js` |

### Plugin bundle export contract

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `export async function mount(ctx)` | Required. The host always calls `module.mount(ctx)` after loading the bundle. | Plugin bundle, called by UI host | `admin/tab/plugin-ui-host.js` |
| `export async function unmount(ctx)` | Optional. The host calls it only when exported. | Plugin bundle, called by UI host | `admin/tab/plugin-ui-host.js` |

### Bundle ctx passed to `mount(ctx)` / `unmount(ctx)`

| Entry | Contract | Owner | Reference |
| --- | --- | --- | --- |
| `ctx.root` | Light-DOM mount root for the panel. Render inside this element. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.plugin.type` | Plugin type string. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.plugin.instanceId` | Plugin instance id as passed by the host mount call. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.panel.id` | Panel id. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.host.apiVersion` | Current host API version string. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.host.adapterInstance` | Adapter instance id such as `msghub.0`. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.host.uiTextLanguage` | Active Admin Tab language. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.dom.h` | DOM helper function exposed from the Admin Tab runtime. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.api.request(command, payload?)` | Promise-based host-bound RPC helper. The AdminTab host currently routes this to `admin.pluginUi.rpc`; a future web host routes the same bundle contract to `web.pluginUi.rpc`. The wrapper always resolves. On successful transport where the backend returns `{ ok: true }`, it resolves with `{ ok: true, data }`. On transport failure or any backend `{ ok: false }` response, it resolves with `{ ok: false, error: { message } }`. The required namespace token is attached centrally by the browser runtime transport, not by bundle code. `error.code` is not forwarded to the bundle. | UI host | `admin/tab/plugin-ui-host.js`, `admin/tab/runtime.js` |
| `ctx.api.i18n.t(key, ...args)` | Admin runtime translator after plugin-owned Admin UI translations have been merged. | UI host / runtime | `admin/tab/plugin-ui-host.js`, `admin/tab/runtime.js` |
| `ctx.api.ui.toast(opts)` | Forwards to the Admin UI toast helper. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.api.ui.spinner.show(opts?)` | Opens the Admin UI spinner. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.api.ui.spinner.hide(id?)` | Hides the Admin UI spinner. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.api.ui.spinner.isOpen(id?)` | Returns whether the Admin UI spinner is currently open. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.api.ui.dialog.confirm(opts)` | Forwards to the Admin UI confirmation dialog helper. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.api.ui.overlayLarge.open(opts)` | Opens the large overlay helper. | UI host | `admin/tab/plugin-ui-host.js` |
| `ctx.api.ui.overlayLarge.close()` | Closes the large overlay helper. | UI host | `admin/tab/plugin-ui-host.js` |

### UI-side invariants

| Contract | Notes | Owner | Reference |
| --- | --- | --- | --- |
| Only running plugin instances contribute panels | `getAdminUiContributions()` only includes currently registered runtime handlers with declared `adminUi.panels[]`. | `IoPlugins` | `lib/IoPlugins.js` |
| `panel.bundle.entry` is path-constrained to the plugin package root | Asset resolution is relative to the resolved descriptor `packageRoot`; escapes outside that package root are rejected. | `IoPlugins` | `lib/IoPlugins.js` |
| Bundle hash is artifact-based | The hash is computed from JS bundle content, optional companion CSS content, and every `admin-ui/i18n/*.json` filename and file content. | `IoPlugins` | `lib/IoPlugins.js` |
| Bundle size limits are enforced by the shared-safe backend bundle path | JS is limited to `512 KiB`; companion CSS and each i18n payload are limited to `64 KiB`. | `IoWebUi` / `IoPlugins` | `lib/IoWebUi.js`, `lib/IoPlugins.js` |
| Plugin Admin UI i18n is namespace-limited | Only keys under `msghub.i18n.<PluginType>.ui.*` are merged into the runtime dictionary. Existing keys are never overwritten. | Admin runtime | `admin/tab/runtime.js` |
| Admin UI i18n fallback is language then `en` | `readAdminUiBundle(...)` first tries the requested language, then `en`. | `IoPlugins` | `lib/IoPlugins.js` |
| Companion CSS is discovered by filename convention, not by manifest field | The host looks for `<bundle.entry>.css` automatically. | `IoPlugins` / UI host | `lib/IoPlugins.js`, `admin/tab/plugin-ui-host.js` |
