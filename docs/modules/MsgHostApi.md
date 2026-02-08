# MsgHostApi (Message Hub)

`MsgHostApi` builds small, stable “facade” APIs that are given to plugins via `ctx.api`.
It is used by the plugin hosts `MsgIngest` (producer plugins) and `MsgNotify` (notification plugins).

The main idea is simple: plugins should not talk to the ioBroker adapter instance directly. Instead, they get a
capability-based API surface that stays stable over time, even if the internals of the adapter/hosts change.

---

## Where it sits in the system

`MsgHostApi` is not a standalone service. It is a helper that is called when a host is created:

- `MsgIngest` builds `ctx.api.*` for producer plugins and adds additional capabilities (like `store` and `factory`).
- `MsgNotify` builds `ctx.api.*` for notifier plugins (focused on dispatch + ioBroker helpers).

Internally, the facades mostly forward calls to the underlying ioBroker adapter methods (and they do so in a safe,
promise-based way).

---

## Core responsibilities

1. Provide a **shared plugin API builder** for multiple hosts (`MsgIngest`, `MsgNotify`).
2. Keep the plugin surface **capability-based and stable** (plugins rely on `ctx.api.*`, not on host internals).
3. Avoid duplicated adapter wrapper logic (promisified ioBroker calls, ID helpers, logger safety).
4. Improve safety: fail early with clear errors when required adapter functions are missing, and keep objects immutable.

---

## Public API (what you typically use)

This module exports small builder functions. Hosts call them once and then pass the returned objects to plugins.

- `buildLogApi(adapter, { hostName })` → `ctx.api.log`
- `buildI18nApi(adapter)` → `ctx.api.i18n` (or `null`)
- `buildConfigApi(snapshot)` → `ctx.api.config` (or `null`)
- `buildIoBrokerApi(adapter, { hostName })` → `ctx.api.iobroker`
- `buildStoreApi(store, { hostName })` → `ctx.api.store`
- `buildStatsApi(store)` → `ctx.api.stats` (or `null`)
- `buildFactoryApi(msgFactory, { hostName })` → `ctx.api.factory` (or `null`)
- `buildActionApi(adapter, msgConstants, store, { hostName })` → `ctx.api.action` (or `null`)
- `buildAiApi(msgAi)` → `ctx.api.ai` (or `null`)
- `buildIdsApi(adapter)` → `ctx.api.iobroker.ids` (also exported for reuse)

### `buildLogApi(adapter, { hostName })`

Builds a strict logger facade with `debug/info/warn/error(message)`.

Important behavior:

- Only accepts **strings**. If a plugin passes anything else, it throws a `TypeError`.
- Uses the adapter logger under the hood (`adapter.log.*`).
- The error messages include `hostName` to make debugging easier (for example, `"MsgIngest: ctx.api.log.info(message) expects a string"`).

Why this exists:

- Plugins sometimes log objects by accident. This can lead to noisy logs or unexpected formatting. A strict “string-only”
  contract keeps log output predictable.

### `buildI18nApi(adapter)`

Builds an optional i18n facade:

- Returns `null` when i18n is not available (for example, when `main.js` did not attach `adapter.i18n`).
- Otherwise returns `{ t, getTranslatedObject, locale, i18nlocale, lang }` from the adapter-scoped i18n instance.

This makes translation support opt-in without breaking plugins that do not need it.

### `buildConfigApi(snapshot)`

Builds a read-only snapshot of the effective, normalized MsgHub configuration as `ctx.api.config`.

Source of truth:

- `main.js` builds a normalized config via `MsgConfig.normalize(...)`.
- The plugin-facing subset is stored as a frozen snapshot (for example `this._msgConfigPublic`) and passed into the hosts.
- `MsgHostApi` does not re-interpret config values; it only forwards the snapshot.

Notes:

- The snapshot is schema-versioned (`ctx.api.config.schemaVersion`).
- Only whitelisted, safe fields are included.
- Designed for diagnostics/help commands (for example `/config` in EngageTelegram).

### `buildIdsApi(adapter)`

Builds helpers for converting between:

- **Full IDs**: including adapter namespace (example: `msghub.0.some.state`)
- **Own IDs**: relative to the adapter namespace (example: `some.state`)

API:

- `ids.namespace` – the adapter namespace (empty string if unknown)
- `ids.toOwnId(fullId)` – strips the namespace prefix if present
- `ids.toFullId(ownId)` – adds the namespace prefix if missing

Edge cases are handled on purpose:

- Non-string inputs become `''` (empty string)
- If `ownId` is empty, `toFullId('')` returns the bare namespace
- If the adapter has no namespace, both functions mostly return the input unchanged

### `buildIoBrokerApi(adapter, { hostName })`

Builds a small ioBroker facade used by plugins. It contains:

- `iobroker.ids` – the same ID helper object as `buildIdsApi()`
- `iobroker.sendTo(instance, command, message, options?)` – promisified wrapper for `adapter.sendTo(...)` (messagebox)
- `iobroker.objects.*` – basic object access helpers (promisified)
- `iobroker.states.*` – basic state access helpers (promisified)
- `iobroker.subscribe.*` – subscribe/unsubscribe helpers for states and objects
- `iobroker.files.*` – ioBroker file storage helpers (promisified; supports async + callback adapter APIs)

Currently exposed helpers (overview):

- `iobroker.sendTo`: `sendTo(instance, command, message, options?)`
- `iobroker.objects`: `setObjectNotExists`, `delObject`, `getObjectView`, `getForeignObjects`, `getForeignObject`, `extendForeignObject`
- `iobroker.states`: `setState`, `setForeignState`, `getForeignState`
- `iobroker.subscribe`: `subscribeStates/Objects/ForeignStates/ForeignObjects` and matching `unsubscribe...`
- `iobroker.files`: `readFile`, `writeFile`, `mkdir`, `renameFile`, `deleteFile`

Compatibility behavior:

- If the adapter provides `...Async` methods (like `getForeignObjectAsync`), they are used directly.
- Otherwise, the classic callback APIs are wrapped into Promises.

Fail-fast behavior:

- For methods that cannot be emulated (subscribe/unsubscribe), `MsgHostApi` throws a clear error when the adapter method
  is missing. The message includes `hostName` (for example: `"MsgNotify: adapter.subscribeStates is not available"`).

Example (what a plugin sees):

```js
function onStateChange(id, state, ctx) {
  ctx.api.log.info(`changed: ${id}`);
  return ctx.api.iobroker.objects.getForeignObject(id);
}
```

#### `iobroker.sendTo(instance, command, message, options?)`

Promisified wrapper for ioBroker messagebox calls via `adapter.sendTo(...)`.

Behavior:

- Returns a Promise that resolves with the target adapter’s response (whatever the callback receives).
- Rejects when `adapter.sendTo` is missing.
- Throws when `instance === ctx.api.iobroker.ids.namespace` (self-send is blocked by design).
- Best-effort timeout: defaults to `10000`ms; disable by passing `{ timeoutMs: 0 }` (or any `<= 0`).

Example:

```js
try {
  const res = await ctx.api.iobroker.sendTo('telegram.0', 'send', { text: 'Hello' }, { timeoutMs: 15000 });
  ctx.api.log.debug(`sendTo result: ${JSON.stringify(res)}`);
} catch (e) {
  ctx.api.log.warn(`sendTo failed: ${e?.message || e}`);
}
```

#### `iobroker.objects.getForeignObjects(pattern, type?)`

`getForeignObjects` supports an optional `type` argument. This is useful when you need to fetch non-state objects such as
enums:

```js
// Example: load all room enums
const rooms = await ctx.api.iobroker.objects.getForeignObjects('enum.rooms.*', 'enum');
```

Note: Without `type`, some ioBroker installations return primarily state objects. When you expect `type: "enum"` entries,
pass `type: "enum"` explicitly.

#### `iobroker.objects.getObjectView(design, search, params)`

Provides access to ioBroker’s Objects DB views via `adapter.getObjectView(...)` / `adapter.getObjectViewAsync(...)`.

This is the preferred way to do *performant* lookups for certain global indexes like `system/custom` (instead of scanning
all objects via `getForeignObjects('*')`).

Example: list objects that have a `common.custom['msghub.0']` entry:

```js
const customKey = ctx.api.iobroker.ids.namespace; // e.g. "msghub.0"
const res = await ctx.api.iobroker.objects.getObjectView('system', 'custom', {
	startkey: customKey,
	endkey: `${customKey}\u9999`,
	include_docs: true,
});

// ioBroker returns rows; with include_docs, each row may contain row.doc (the object)
const rows = Array.isArray(res?.rows) ? res.rows : [];
```

#### `iobroker.states.setForeignState(id, state)`

Promisified wrapper for `adapter.setForeignState(...)` / `adapter.setForeignStateAsync(...)`.

Example:

```js
await ctx.api.iobroker.states.setForeignState('some.0.device.switch', { val: true, ack: false });
```

#### `iobroker.files.writeFile(metaId, filePath, data)`

Promisified wrapper for ioBroker file storage writes.

Notes:

- `metaId` is the ioBroker “file namespace root”, usually the adapter instance namespace (example: `msghub.0`).
- `filePath` is the path below `metaId` (example: `documents/NotifyShoppingPdf.0.pdf`).
- `data` can be a `Buffer` (binary PDFs) or a string.

Example:

```js
const metaId = ctx.api.iobroker.ids.namespace; // "msghub.0"
await ctx.api.iobroker.files.mkdir(metaId, 'documents');
await ctx.api.iobroker.files.writeFile(metaId, 'documents/out.pdf', pdfBuffer);
```

### `buildStoreApi(store, { hostName })`

Builds a small `MsgStore` facade for plugins (`ctx.api.store`).

Derivation rule:

- For ingest hosts (`hostName` contains `"Ingest"`): exposes read + write APIs.
- For notify hosts: exposes read APIs only.

Read APIs:

- `getMessageByRef(ref)`
- `getMessages()` (raw/unrendered snapshot)
- `queryMessages({ where, page?, sort? })`

Write APIs (ingest only):

- `addMessage(msg)`
- `updateMessage(msgOrRef, patch)`
- `addOrUpdateMessage(msg)`
- `removeMessage(ref, { actor? })`
- `completeAfterCauseEliminated(ref, { actor? })`

Notes:

- `removeMessage(ref, { actor? })` performs a soft delete (`lifecycle.state="deleted"`, clears `timing.notifyAt`). `actor` is stored as `lifecycle.stateChangedBy`.
- `completeAfterCauseEliminated(...)` is meant for condition-based ingest plugins: when the external cause becomes OK again,
  the plugin can trigger a standardized workflow depending on `message.kind`:
  - `kind="task"`: patches the message to `lifecycle.state="closed"`, clears `timing.notifyAt`, sets `progress.percentage=100`
  - `kind="status"`: soft-deletes the message via `removeMessage(ref, { actor? })`
  - otherwise: no-op (returns `true`)

### `buildStatsApi(store)`

Builds a small stats facade for plugins (`ctx.api.stats`).

API:

- `stats.getStats(options?)` → returns the same JSON-serializable stats snapshot as `MsgStore.getStats(...)`.

Notes:

- This is a **read-only** helper.
- Some fields can be expensive (for example archive size estimation). Callers should use include flags sparingly.
- This facade returns `null` if the provided store does not expose `getStats(...)`.

### `buildFactoryApi(msgFactory, { hostName })`

Builds a small `MsgFactory` facade for plugins (`ctx.api.factory`).

Derivation rule:

- For ingest hosts (`hostName` contains `"Ingest"`): exposes `createMessage(...)` (normalization gate).
- For other hosts: returns `null`.

### `buildActionApi(adapter, msgConstants, store, { hostName })`

Builds a small `MsgAction` facade for plugins (`ctx.api.action`).

Derivation rule:

- For engage hosts (`hostName` contains `"Engage"`): exposes `execute({ ref, actionId, actor?, payload?, snoozeForMs? })`.
- For other hosts: returns `null` (actions are reserved for Engage).

Implementation note:

- The action executor is owned by the store (`store.msgActions`).
- `ctx.api.action.execute(...)` forwards into that instance.

This keeps policy consistent:

- inbound: `execute(...)` rejects actions that are not allowed in the current lifecycle state
- outbound: store read APIs and notification dispatch may expose `actionsInactive[]` and filter `actions[]` for the same reason

---

## Design guidelines / invariants (the important rules)

### 1) Stable, host-independent plugin surface

Hosts should expose capabilities via `ctx.api.*` and keep that surface stable. Plugins should not depend on host internals
or on the adapter instance directly.

### 2) Capability-based, not “god mode”

Only a limited set of adapter operations are exposed (read objects/states, extend objects, subscribe, basic ids).
If more power is needed, add it deliberately to the facade instead of letting plugins access `adapter` directly.

### 3) Freeze everything

Returned facades are `Object.freeze(...)`-ed so plugins cannot mutate shared API objects accidentally.

### 4) Support different ioBroker adapter styles

The ioBroker API exists in async and callback variants. This module prefers `...Async` when available and falls back to
wrapping callback APIs into Promises.

### 5) Clear errors, early

When a required adapter method is not available, throw a descriptive error including `hostName`.
This keeps failures obvious and reduces “silent no-ops”.

---

## Related files

- Implementation: `src/MsgHostApi.js`
- Used by hosts: `src/MsgIngest.js`, `src/MsgNotify.js`
- Module overview: `docs/modules/README.md`
