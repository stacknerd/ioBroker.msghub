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
- `buildIoBrokerApi(adapter, { hostName })` → `ctx.api.iobroker`
- `buildStoreApi(store, { hostName })` → `ctx.api.store`
- `buildFactoryApi(msgFactory, { hostName })` → `ctx.api.factory` (or `null`)
- `buildActionApi(adapter, msgConstants, store, { hostName })` → `ctx.api.action` (or `null`)
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
- Otherwise returns `{ t, getTranslatedObject }` from the adapter-scoped i18n instance.

This makes translation support opt-in without breaking plugins that do not need it.

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
- `iobroker.objects.*` – basic object access helpers (promisified)
- `iobroker.states.*` – basic state access helpers (promisified)
- `iobroker.subscribe.*` – subscribe/unsubscribe helpers for states and objects

Currently exposed helpers (overview):

- `iobroker.objects`: `setObjectNotExists`, `delObject`, `getForeignObjects`, `getForeignObject`, `extendForeignObject`
- `iobroker.states`: `setState`, `getForeignState`
- `iobroker.subscribe`: `subscribeStates/Objects/ForeignStates/ForeignObjects` and matching `unsubscribe...`

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

### `buildStoreApi(store, { hostName })`

Builds a small `MsgStore` facade for plugins (`ctx.api.store`).

Derivation rule:

- For ingest hosts (`hostName` contains `"Ingest"`): exposes read + write APIs.
- For notify hosts: exposes read APIs only.

Read APIs:

- `getMessageByRef(ref)`
- `getMessages()`
- `queryMessages({ where, page?, sort? })`

Write APIs (ingest only):

- `addMessage(msg)`
- `updateMessage(msgOrRef, patch)`
- `addOrUpdateMessage(msg)`
- `removeMessage(ref)`

### `buildFactoryApi(msgFactory, { hostName })`

Builds a small `MsgFactory` facade for plugins (`ctx.api.factory`).

Derivation rule:

- For ingest hosts (`hostName` contains `"Ingest"`): exposes `createMessage(...)` (normalization gate).
- For other hosts: returns `null`.

### `buildActionApi(adapter, msgConstants, store, { hostName })`

Builds a small `MsgAction` facade for plugins (`ctx.api.action`).

Derivation rule:

- For engage hosts (`hostName` contains `"Engage"`): exposes `execute({ ref, actionId, actor?, payload? })`.
- For other hosts: returns `null` (actions are reserved for Engage).

`execute(...)` runs through `src/MsgAction.js` and mutates messages via `MsgStore.updateMessage(...)` (whitelist semantics:
only actions present in `message.actions[]` can be executed).

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
