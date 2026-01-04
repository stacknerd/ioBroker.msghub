# Plugin API (ctx.api / ctx.meta)

This document is a **plugin-facing API reference** for Message Hub when plugins are wired through `IoPlugins`.

Terminology:

- Plugins receive a context object `ctx = { api, meta }` from the hosts (`MsgIngest`, `MsgNotify`).
- `IoPlugins` injects additional stable metadata into `ctx.meta.*` and wraps some APIs (like subscription tracking).

Handler call shapes (for orientation):

- Ingest-side calls: `onStateChange(id, state, ctx)` / `onObjectChange(id, obj, ctx)` (plus `start(ctx)` / `stop(ctx)`).
- Notify-side calls: `onNotifications(event, notificationsArray, ctx)`.

## Overview table

Columns:

- **Meta oder API**: whether the entry lives in `ctx.api.*`, `ctx.meta.*`, or is provided as plugin factory option.
- **Gruppe**: top-level group (example: `iobroker`).
- **Funktion**: function/property name (example: `getForeignObject`).
- **Ingest**: ✓ if available for Ingest plugins.
- **Notify**: ✓ if available for Notify plugins.
- **Bridge**: ✓ if available for Bridge plugins.
- **Engage**: ✓ if available for Engage plugins.
- **Kurzbeschreibung**: short behavioral contract.
- **Bereitstellende Klasse**: code-level owner/builder.
- **Link zur Doku**: most relevant documentation entry point.

| Meta oder API | Gruppe | Funktion | Ingest | Notify | Bridge | Engage | Kurzbeschreibung | Bereitstellende Klasse | Link zur Doku |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| API | `constants` | `ctx.api.constants` | ✓ | ✓ | ✓ | ✓ | Centralized enums/constants (notification events, lifecycle states, …). | `MsgIngest` / `MsgNotify` | `../modules/MsgConstants.md` |
| API | `log` | `silly(message)` | ✓ | ✓ | ✓ | ✓ | String-only logger. Throws on non-string. | `buildLogApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `log` | `debug(message)` | ✓ | ✓ | ✓ | ✓ | String-only logger. Throws on non-string. | `buildLogApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `log` | `info(message)` | ✓ | ✓ | ✓ | ✓ | String-only logger. Throws on non-string. | `buildLogApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `log` | `warn(message)` | ✓ | ✓ | ✓ | ✓ | String-only logger. Throws on non-string. | `buildLogApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `log` | `error(message)` | ✓ | ✓ | ✓ | ✓ | String-only logger. Throws on non-string. | `buildLogApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `i18n` | `t(key, ...args)` | ✓ | ✓ | ✓ | ✓ | Optional i18n; `ctx.api.i18n` can be `null` if not wired. | `buildI18nApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `i18n` | `getTranslatedObject(obj, lang)` | ✓ | ✓ | ✓ | ✓ | Optional i18n helper; `ctx.api.i18n` can be `null` if not wired. | `buildI18nApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `ai` | `getStatus()*` | ✓ | ✓ | ✓ | ✓ | Returns AI module status; best-effort helper. | `buildAiApi()` (`src/MsgHostApi.js`), bound by `IoPlugins` | `../modules/MsgAi.md` |
| API | `ai` | `text(request)*` | ✓ | ✓ | ✓ | ✓ | Best-effort text completion helper. | `buildAiApi()` (`src/MsgHostApi.js`), bound by `IoPlugins` | `../modules/MsgAi.md` |
| API | `ai` | `json(request)*` | ✓ | ✓ | ✓ | ✓ | Best-effort JSON completion helper. | `buildAiApi()` (`src/MsgHostApi.js`), bound by `IoPlugins` | `../modules/MsgAi.md` |
| API | `store` | `getMessageByRef(ref)` | ✓ | ✓ | ✓ | ✓ | Look up a message by stable `ref` (read-only on notify-side). | `buildStoreApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `store` | `getMessages()` | ✓ | ✓ | ✓ | ✓ | Get full message list snapshot (read-only on notify-side). | `buildStoreApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `store` | `queryMessages(options)` | ✓ | ✓ | ✓ | ✓ | Query messages with filters/paging (read-only on notify-side). | `buildStoreApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `store` | `addMessage(msg)` | ✓ |  | ✓ | ✓ | Add a normalized message into the store (inbound ctx only). | `buildStoreApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `store` | `updateMessage(msgOrRef, patch)` | ✓ |  | ✓ | ✓ | Patch a message by ref/object (inbound ctx only). | `buildStoreApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `store` | `addOrUpdateMessage(msg)` | ✓ |  | ✓ | ✓ | Upsert by `ref` (inbound ctx only). | `buildStoreApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `store` | `removeMessage(ref)` | ✓ |  | ✓ | ✓ | Soft-delete a message (`lifecycle.state="deleted"`) (inbound ctx only). | `buildStoreApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `store` | `completeAfterCauseEliminated(ref, options?)` | ✓ |  | ✓ | ✓ | Shortcut: close message + set progress to finished (inbound ctx only). | `buildStoreApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `stats` | `getStats(options?)` | ✓ | ✓ | ✓ | ✓ | Returns a JSON-serializable stats snapshot (current/schedule/done/io). | `buildStatsApi()` (`src/MsgHostApi.js`) + `MsgStats` | `../modules/MsgStats.md` |
| API | `factory` | `createMessage(data)` | ✓ |  | ✓ | ✓ | Normalization gate for “create” paths (inbound ctx only). | `buildFactoryApi()` (`src/MsgHostApi.js`) | `../modules/MsgFactory.md` |
| API | `action` | `execute({ ref, actionId, actor?, payload? })` |  |  |  | ✓ | Execute whitelisted actions from `message.actions[]` (mutates store). | `MsgEngage` + `buildActionApi()` (`src/MsgHostApi.js`) | `../modules/MsgEngage.md`<br>`../modules/MsgAction.md` |
| API | `iobroker.ids` | `namespace` | ✓ | ✓ | ✓ | ✓ | Adapter namespace (example: `msghub.0`). | `buildIdsApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.ids` | `toOwnId(fullId)` | ✓ | ✓ | ✓ | ✓ | Strip namespace prefix if present. | `buildIdsApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.ids` | `toFullId(ownId)` | ✓ | ✓ | ✓ | ✓ | Add namespace prefix if missing. | `buildIdsApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker` | `sendTo(instance, command, message, options?)` | ✓ | ✓ | ✓ | ✓ | Promisified wrapper for `adapter.sendTo(...)` (messagebox); blocks self-send to `ctx.api.iobroker.ids.namespace`; default timeout `10000`ms (set `options.timeoutMs <= 0` to disable). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.objects` | `setObjectNotExists(ownId, obj)` | ✓ | ✓ | ✓ | ✓ | Create an object under adapter namespace if missing (async/callback compatible). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.objects` | `delObject(ownId)` | ✓ | ✓ | ✓ | ✓ | Delete an own object (async/callback compatible). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.objects` | `getObjectView(design, search, params)` | ✓ | ✓ | ✓ | ✓ | Query Objects DB view (use for performant lookups like `system/custom`). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.objects` | `getForeignObjects(pattern, type?)` | ✓ | ✓ | ✓ | ✓ | Get foreign objects by pattern; `type` is optional (e.g. `'enum'`). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.objects` | `getForeignObject(id)` | ✓ | ✓ | ✓ | ✓ | Get a single foreign object by id. | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.objects` | `extendForeignObject(id, patch)` | ✓ | ✓ | ✓ | ✓ | Patch a foreign object by id. | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.states` | `setState(ownId, state)` | ✓ | ✓ | ✓ | ✓ | Set an own state (async/callback compatible). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.states` | `setForeignState(id, state)` | ✓ | ✓ | ✓ | ✓ | Set a foreign state (async/callback compatible). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.states` | `getForeignState(id)` | ✓ | ✓ | ✓ | ✓ | Read a foreign state (async/callback compatible). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.subscribe` | `subscribeStates(pattern)` | ✓ | ✓ | ✓ | ✓ | Subscribe to own states; when wired via `IoPlugins`, auto-cleaned up on stop. | `buildIoBrokerApi()` + `IoPluginResources.wrapSubscribeApi()` | `../modules/MsgHostApi.md`<br>`./IoPlugins.md` |
| API | `iobroker.subscribe` | `unsubscribeStates(pattern)` | ✓ | ✓ | ✓ | ✓ | Unsubscribe from own states; when wired via `IoPlugins`, also forgets tracked cleanup. | `buildIoBrokerApi()` + `IoPluginResources.wrapSubscribeApi()` | `../modules/MsgHostApi.md`<br>`./IoPlugins.md` |
| API | `iobroker.subscribe` | `subscribeObjects(pattern)` | ✓ | ✓ | ✓ | ✓ | Subscribe to own objects; when wired via `IoPlugins`, auto-cleaned up on stop. | `buildIoBrokerApi()` + `IoPluginResources.wrapSubscribeApi()` | `../modules/MsgHostApi.md`<br>`./IoPlugins.md` |
| API | `iobroker.subscribe` | `unsubscribeObjects(pattern)` | ✓ | ✓ | ✓ | ✓ | Unsubscribe from own objects; when wired via `IoPlugins`, also forgets tracked cleanup. | `buildIoBrokerApi()` + `IoPluginResources.wrapSubscribeApi()` | `../modules/MsgHostApi.md`<br>`./IoPlugins.md` |
| API | `iobroker.subscribe` | `subscribeForeignStates(pattern)` | ✓ | ✓ | ✓ | ✓ | Subscribe to foreign states; when wired via `IoPlugins`, auto-cleaned up on stop. | `buildIoBrokerApi()` + `IoPluginResources.wrapSubscribeApi()` | `../modules/MsgHostApi.md`<br>`./IoPlugins.md` |
| API | `iobroker.subscribe` | `unsubscribeForeignStates(pattern)` | ✓ | ✓ | ✓ | ✓ | Unsubscribe from foreign states; when wired via `IoPlugins`, also forgets tracked cleanup. | `buildIoBrokerApi()` + `IoPluginResources.wrapSubscribeApi()` | `../modules/MsgHostApi.md`<br>`./IoPlugins.md` |
| API | `iobroker.subscribe` | `subscribeForeignObjects(pattern)` | ✓ | ✓ | ✓ | ✓ | Subscribe to foreign objects; when wired via `IoPlugins`, auto-cleaned up on stop. | `buildIoBrokerApi()` + `IoPluginResources.wrapSubscribeApi()` | `../modules/MsgHostApi.md`<br>`./IoPlugins.md` |
| API | `iobroker.subscribe` | `unsubscribeForeignObjects(pattern)` | ✓ | ✓ | ✓ | ✓ | Unsubscribe from foreign objects; when wired via `IoPlugins`, also forgets tracked cleanup. | `buildIoBrokerApi()` + `IoPluginResources.wrapSubscribeApi()` | `../modules/MsgHostApi.md`<br>`./IoPlugins.md` |
| API | `iobroker.files` | `readFile(metaId, filePath)` | ✓ | ✓ | ✓ | ✓ | Read a file from ioBroker file storage (raw result passed through; commonly `{ file, mimeType? }`). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.files` | `writeFile(metaId, filePath, data)` | ✓ | ✓ | ✓ | ✓ | Write a file into ioBroker file storage (`data` may be `Buffer` or string). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.files` | `mkdir(metaId, dirPath)` | ✓ | ✓ | ✓ | ✓ | Create a directory in ioBroker file storage (best-effort; async/callback compatible). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.files` | `renameFile(metaId, oldPath, newPath)` | ✓ | ✓ | ✓ | ✓ | Rename/move a file within ioBroker file storage (async/callback compatible). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| API | `iobroker.files` | `deleteFile(metaId, filePath)` | ✓ | ✓ | ✓ | ✓ | Delete a file within ioBroker file storage (adapter API is `delFile`; facade uses `deleteFile`). | `buildIoBrokerApi()` (`src/MsgHostApi.js`) | `../modules/MsgHostApi.md` |
| Meta | `host` | `ctx.meta.running` | ✓ | ✓ | ✓ | ✓ | Host runtime flag (best-effort; `true` while host is running). | `MsgIngest` / `MsgNotify` | `../modules/MsgIngest.md`<br>`../modules/MsgNotify.md` |
| Meta | `plugin` | `category` | ✓ | ✓ | ✓ | ✓ | Plugin family category: `ingest | notify | bridge | engage`. | `IoPlugins` (`lib/IoPlugins.js`) | `./IoPlugins.md` |
| Meta | `plugin` | `type` | ✓ | ✓ | ✓ | ✓ | Plugin type name (example: `NotifyStates`). | `IoPlugins` (`lib/IoPlugins.js`) | `./IoPlugins.md` |
| Meta | `plugin` | `instanceId` | ✓ | ✓ | ✓ | ✓ | Numeric instance id (usually `0`). | `IoPlugins` (`lib/IoPlugins.js`) | `./IoPlugins.md` |
| Meta | `plugin` | `regId` | ✓ | ✓ | ✓ | ✓ | Registration id in hosts (example: `NotifyStates:0`). | `IoPlugins` (`lib/IoPlugins.js`) | `./IoPlugins.md` |
| Meta | `plugin` | `baseFullId` | ✓ | ✓ | ✓ | ✓ | Full base object id (example: `msghub.0.NotifyStates.0`). | `IoPlugins` (`lib/IoPlugins.js`) | `./IoPlugins.md` |
| Meta | `plugin` | `baseOwnId` | ✓ | ✓ | ✓ | ✓ | Own base object id (example: `NotifyStates.0`). | `IoPlugins` (`lib/IoPlugins.js`) | `./IoPlugins.md` |
| Meta | `plugin` | `manifest` | ✓ | ✓ | ✓ | ✓ | Manifest-like object (schema version, defaults, and `options` schema). | `IoPlugins.buildManifestFromCatalogEntry()` | `./IoPlugins.md` |
| Meta | `options` | `resolveInt(key, value)` | ✓ | ✓ | ✓ | ✓ | Resolve integer options with manifest defaults and optional `min/max`. | `IoPlugins.createOptionsApi()` | `./IoPlugins.md` |
| Meta | `options` | `resolveBool(key, value)` | ✓ | ✓ | ✓ | ✓ | Resolve boolean options with manifest defaults. | `IoPlugins.createOptionsApi()` | `./IoPlugins.md` |
| Meta | `options` | `resolveString(key, value)` | ✓ | ✓ | ✓ | ✓ | Resolve string options with manifest defaults; trims whitespace. | `IoPlugins.createOptionsApi()` | `./IoPlugins.md` |
| Meta | `resources` | `setTimeout(fn, delayMs, ...args)` | ✓ | ✓ | ✓ | ✓ | Timeout tracked and auto-cleared on stop/unregister. | `IoPluginResources` (`lib/IoPluginResources.js`) | `./IoPlugins.md` |
| Meta | `resources` | `clearTimeout(handle)` | ✓ | ✓ | ✓ | ✓ | Clears a tracked timeout and forgets it. | `IoPluginResources` (`lib/IoPluginResources.js`) | `./IoPlugins.md` |
| Meta | `resources` | `setInterval(fn, intervalMs, ...args)` | ✓ | ✓ | ✓ | ✓ | Interval tracked and auto-cleared on stop/unregister. | `IoPluginResources` (`lib/IoPluginResources.js`) | `./IoPlugins.md` |
| Meta | `resources` | `clearInterval(handle)` | ✓ | ✓ | ✓ | ✓ | Clears a tracked interval and forgets it. | `IoPluginResources` (`lib/IoPluginResources.js`) | `./IoPlugins.md` |
| Meta | `resources` | `add(disposer)` | ✓ | ✓ | ✓ | ✓ | Register cleanup disposer (`() => void` or `{ dispose() }`) for stop/unregister. | `IoPluginResources` (`lib/IoPluginResources.js`) | `./IoPlugins.md` |
| Meta | `managedObjects` | `report(ids, { managedText? })` | ✓ |  | ✓ |  | Buffer “managed” object ids for stamping and watchlist persistence. | `IoManagedMeta.createReporter()` | `./IoPlugins.md` |
| Meta | `managedObjects` | `applyReported()` | ✓ |  | ✓ |  | Persist watchlist + stamp `common.custom.<ns>.managedMeta` best-effort. | `IoManagedMeta.createReporter()` | `./IoPlugins.md` |
| Meta (factory option) | `options` | `pluginBaseObjectId` | ✓ | ✓ | ✓ | ✓ | Full base object id passed to `create(options)` for creating plugin-owned states. | `IoPlugins._registerOne()` | `./IoPlugins.md` |
| Meta (factory option) | `options` | `__messagebox.register(handler)` |  |  |  | ✓ | Register adapter messagebox handler (owned by exactly one Engage plugin). | `IoPlugins.dispatchMessagebox()` + `IoPlugins._adoptMessageboxHandler()` | `./IoPlugins.md` |
| Meta (factory option) | `options` | `__messagebox.unregister()` |  |  |  | ✓ | Release messagebox handler if owned by this plugin instance. | `IoPlugins._releaseMessageboxHandler()` | `./IoPlugins.md` |

\* Optional / wiring-dependent capability (for example `ctx.api.ai` can be `null` when AI is not configured).
