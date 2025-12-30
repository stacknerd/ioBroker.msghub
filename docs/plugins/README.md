# Message Hub Plugins (IO Layer) – Developer Guide

This document focuses on **how to integrate your own custom plugin** into Message Hub:
what interfaces exist, what data you receive, and how the adapter wires plugins at runtime.

If you want the “big picture” first, see [`docs/README.md`](../README.md). For the core internals, see [`docs/modules/README.md`](../modules/README.md).

## Mental model: code-level plugins vs. runtime wiring

There are two related, but different things called “plugins”:

1. **Code-level plugin handlers**
   - JavaScript handlers that implement the Ingest, Notify, Bridge, or Engage interface.
   - They are called by the plugin hosts `MsgIngest` and `MsgNotify` (Bridge/Engage are wired into both via helpers).

2. **Runtime plugin management**
   - On a running ioBroker adapter instance you need enable/disable switches and configuration storage.
   - In this repo, that job is done by `IoPlugins` (`lib/IoPlugins.js`).

`IoPlugins` reads plugin config from ioBroker objects, creates enable toggles, and registers/unregisters the plugin handlers into the two plugin hosts.

Read more: [`docs/plugins/IoPlugins.md`](./IoPlugins.md)

## Status of this repo (built-in plugins)

This repository currently ships only a small set of built-in plugins:

- `IngestRandomChaos` (demo/load generator ingest plugin)
- `IngestHue` (Hue device health ingest plugin)
- `EngageSendTo` (control plane via ioBroker `sendTo`)
- `NotifyStates` (writes notifications to ioBroker states)
- `NotifyDebug` (debug notifier)

There are no built-in `Bridge...` plugins yet. The core supports this plugin family, and you can add your own.

## Plugin families (concept): `Ingest` / `Notify` / `Bridge` / `Engage`

This project uses “plugin families” to keep responsibilities clean and predictable. The important bit is not the name,
but **what direction of communication** a plugin supports and **what it is allowed to do**.

| Family | Type prefix | Direction | What it is | Allowed to do |
| --- | --- | --- | --- | --- |
| Ingest | `Ingest...` | inbound only | **Producer**: turns external signals into MsgHub messages | Create/update/remove messages (via store + factory) |
| Notify | `Notify...` | outbound only | **Receiver**: reacts to MsgHub events and delivers them | Deliver events/messages (best-effort), no store mutation, no actions |
| Bridge | `Bridge...` | bidirectional | **External sync**: packages ingest+notify wiring as one runtime instance | Ingest + Notify semantics (single handler wired into both hosts) |
| Engage | `Engage...` | bidirectional | **Interactive channel**: delivers messages *and* accepts user intents back | Ingest + Notify + execute whitelisted actions (via MsgAction) |

### What “Engage” means (and what it doesn’t)

An **Engage plugin** is the “human interaction layer”:

- Outbound: it receives MsgHub notification events (like a Notify plugin) and can present them on a channel (Telegram,
  Web UI, wall display, …).
- Inbound: it can receive user input back on that same channel (button click, command, form submit, …) and translate it
  into either:
  - **message mutations** (create/update/remove), and/or
  - **action execution** via the core action layer (`MsgAction`).

Engage is explicitly *not* the same as “a web UI”. Telegram, a web app, a dashboard, or a passive display can all be
Engage channels. “UI” is just one possible transport.

### Why “Notify must stay dumb” (design rule)

You can technically implement “ack over the same channel” without Engage by mixing behaviors into a Notify plugin.
But that blurs boundaries quickly (store mutation from a receiver, action execution from a delivery-only integration).

So the functional contract we want to enforce is:

- `Notify` is **one-way** (MsgHub → channel).
- `Engage` is **two-way** (MsgHub ↔ user via a channel) and is the only family that may execute actions.

This keeps “delivery” and “interaction” separate, and it makes it much easier to reason about side-effects and future
security/ACL decisions.

### Architecture around `IoPlugins` + `MsgBridge` (ASCII)

Note: `Engage` is wired via `MsgEngage` (see “Engage plugins” below).

```
ioBroker Objects (per plugin instance)
  - state boolean      -> enable/disable (ack:false = user intent)
  - object.native JSON -> plugin options
            |
            v
      IoPlugins (lib/)
      - ensures control states exist
      - loads options from native
      - registers/unregisters:
          - Ingest...  -> msgIngest.registerPlugin(...)
          - Notify...  -> msgNotify.registerPlugin(...)
          - Bridge...  -> MsgBridge.registerBridge(...)  (registered as `.ingest` + `.notify`)
          - Engage...  -> MsgEngage.registerEngage(...)  (registered as `.ingest` + `.notify`, with actions)
             |                     |
             v                     v
       MsgIngest (src/)       MsgNotify (src/)
       (producer host)        (notifier host)
             |                     |
             v                     v
      Ingest handlers         Notify handlers
        (lib/...)               (lib/...)
             \                   /
              \                 /
               v               v
                  MsgStore (src/)
      (canonical list + persistence/archive/dispatch)
```

## Quick start: add your own plugin (recommended path)

### 1) Choose a plugin type and name

Message Hub supports four plugin families:

- **Ingest plugins** (type prefix `Ingest...`): ioBroker events → message create/update/remove
- **Notify plugins** (type prefix `Notify...`): Message Hub events → delivery (one-way)
- **Bridge plugins** (type prefix `Bridge...`): bidirectional integrations (one enable switch; registered as ingest+notify via `MsgBridge`)
- **Engage plugins** (type prefix `Engage...`): interactive channels (bidirectional; messages + inbound intents + actions)

Naming is not cosmetic: `IoPlugins` enforces the prefix by category to prevent catalog mistakes
(today: `Ingest` / `Notify` / `Bridge` / `Engage`).

### 2) Implement the plugin factory in `lib/`

Convention in this repo:

- One plugin = one folder: `lib/<TypeName>/index.js`
- The export is a factory: `<TypeName>(options) => handler` (**breaking change; runtime wiring must match this**)

The runtime will pass your `options` from ioBroker `native` plus an extra field:

- `options.pluginBaseObjectId` (full id) so you can create states below your own subtree if needed

Example: ingest plugin skeleton:

```js
// lib/IngestMyPlugin/index.js
'use strict';

function IngestMyPlugin(options) {
  return {
    start(ctx) {
      // optional: subscribe / discovery using ctx.api.iobroker.*
      // ctx.api.log.info('IngestMyPlugin started');
    },
    onStateChange(id, state, ctx) {
      // decide: ignore / create / patch
      // writes go through ctx.api.store.*
    },
  };
}

module.exports = { IngestMyPlugin };
```

Example: notify plugin skeleton:

```js
// lib/NotifyMyPlugin/index.js
'use strict';

function NotifyMyPlugin(options) {
  return {
    onNotifications(event, notifications, ctx) {
      // deliver best-effort (notifications is an array)
    },
  };
}

module.exports = { NotifyMyPlugin };
```

Example: engage plugin skeleton (interactive channel):

```js
// lib/EngageMyChannel/index.js
'use strict';

function EngageMyChannel(options) {
  return {
    start(ctx) {
      // optional: connect, poll, webhook registration, etc.
      // inbound user intents may translate into:
      // - ctx.api.store.addMessage/updateMessage/removeMessage(...)
      // - ctx.api.store.completeAfterCauseEliminated(ref, { actor, finishedAt })
      // - ctx.api.action.execute({ ref, actionId, actor, payload })
    },
    stop(ctx) {
      // cleanup timers/subscriptions/connections
    },
    onNotifications(event, notifications, ctx) {
      // outbound: deliver messages to your channel (may include interactive affordances)
    },
  };
}

module.exports = { EngageMyChannel };
```

Example: bridge plugin skeleton (bidirectional integration):

```js
// lib/BridgeMySystem/index.js
'use strict';

function BridgeMySystem(options) {
  const shared = { options };

  return {
    start(ctx) {
      // optional: subscribe / discovery / resync using ctx.api.iobroker.*
    },
    onStateChange(id, state, ctx) {
      // inbound: external -> Message Hub mutations (via ctx.api.store.*)
    },
    onNotifications(event, notifications, ctx) {
      // outbound: Message Hub events -> external delivery
    },
  };
}

module.exports = { BridgeMySystem };
```

### 3) Add the plugin to the catalog (`lib/index.js`)

To make the plugin show up as a runtime-managed plugin, add it to `IoPluginsCatalog`:

- choose `type` (stable identifier; usually the factory name)
- put it into the correct category list (`ingest` / `notify` / `bridge` / `engage`)
- set `defaultEnabled` and `defaultOptions`
- set `create` to your factory

After that, the adapter’s `IoPlugins` layer will create the enable/config object and can start/stop your plugin.

Note: `IoPlugins` wires `ingest` / `notify` / `bridge` / `engage`.

### 4) Create documentation and keep indexes updated

- Add `docs/plugins/<TypeName>.md` (or run `npm run docs:generate` to create a stub)
- Fill the stub and keep the README index clean (CI checks via `npm run docs:check`)

## Runtime model: enable/disable + configuration

With `IoPlugins`, each plugin instance is represented by one ioBroker object id that has **two roles**:

- the **state value** (`boolean`) is the enable switch
- the object’s **`native`** JSON is the plugin options

Practical consequences:

- Enable/disable is done by writing the boolean with `ack: false` (user intent)
- Changing `native` does not automatically reconfigure a running plugin
  - practical rule: disable + enable (or restart the adapter) to apply option changes

ID scheme (today):

- own id (inside adapter APIs): `<TypeName>.<instanceId>` (instance id is currently always `0`)
- full id (in ioBroker object tree): `<namespace>.<TypeName>.<instanceId>` (example: `msghub.0.NotifyStates.0`)
  - `namespace` is available as `ctx.api.iobroker.ids.namespace`

`IoPlugins` also passes `options.pluginBaseObjectId` to your factory as the **full id** of that base object.
Many ioBroker adapter APIs expect “own ids” (without namespace). Use `ctx.api.iobroker.ids.toOwnId(fullId)` / `toFullId(ownId)` instead of manual string slicing.

Bridge plugins follow the same storage model (one enable/config object, options in `native`), but they result in **two registrations**
behind the scenes (ingest + notify) via `MsgBridge`.

## Interfaces you must implement

Both plugin hosts pass the same shape of context:

- `ctx.api`: stable capabilities (depends on host)
- `ctx.meta`: call metadata (who triggered the call, plus `running`, plus host-provided helpers)

Plugins should treat the core as a black box:
use `ctx.api.*` and do not mutate `MsgStore` internals.

---

## Plugin metadata (`ctx.meta`)

`ctx.meta` is **not** a capability surface like `ctx.api`. It is a small “call context” object:

- it contains information about why/how a plugin function was called (for debugging / attribution)
- it may contain host-provided helper functions that are not part of the stable API builders

### Common field

- `ctx.meta.running` (`boolean`): whether the host is currently running.

### Managed Meta reporter (ingest plugins)

When the adapter is wired via `IoPlugins`, ingest plugins receive an additional helper:

- `await ctx.meta.managedObjects.report(ids, { managedText })`
- `await ctx.meta.managedObjects.applyReported()`

This lets ingest plugins report which ioBroker objects they “own”/monitor (typically foreign states). MsgHub then writes a small metadata block into those objects:

- `managedBy`
- `managedText`
- `managedSince`
- `managedMessage` (`true` while actively managed; used by the Admin UI)

Where it is stored:

- `obj.common.custom[<adapter namespace>].managedMeta` (example key: `common.custom.msghub.0.managedMeta`)

Signature:

- `ids`: `string` or `string[]` (ioBroker object ids, usually full foreign ids)
- `managedText`: string (should already be localized via `ctx.api.i18n.t(...)`)

Semantics:

- `report(...)` buffers ids (deduped); it does not write immediately.
- `applyReported()` performs the writes (managedMeta stamping + watchlist update) and clears the buffer.
- Stored `managedBy` is always `options.pluginBaseObjectId` (e.g. `"msghub.0.IngestHue.0"`).
- Best-effort: failures are logged and swallowed.
- Minimal writes: only updates when content differs or `managedSince` is missing.
- Cleanup: when a plugin instance is disabled, MsgHub clears the plugin watchlist and marks previously listed objects as “no longer managed” (`managedMessage=false`). If the object has no active IngestStates rule (`mode===""`) and `enabled===true`, MsgHub also sets `enabled=false`.

If a plugin depends on this feature, validate it in `start(ctx)` (throw a clear error when missing).

---

## Plugin API reference (`ctx.api`)

The plugin hosts expose a **capability-based** API surface:

- It is intentionally smaller than the full ioBroker adapter API.
- It is designed so plugins can be tested without a real adapter.
- It is shared between `MsgIngest` and `MsgNotify` via `src/MsgHostApi.js` (and Engage builds on the same surface).

### Common fields (Ingest + Notify + Engage)

- `ctx.api.constants`: shared enum-like constants (`MsgConstants`) used across MsgHub (levels, kinds, origin types, notification events, …).
- `ctx.api.log`: logging facade (string-only)
  - `debug(message)`, `info(message)`, `warn(message)`, `error(message)`
  - Best practice: format yourself with template literals, e.g. ``ctx.api.log.info(`foo=${foo}`)``.
  - Non-string arguments throw.
- `ctx.api.i18n`: optional i18n facade (can be `null`)
  - `t(key, ...args)` and `getTranslatedObject(key, ...args)`
  - Best practice: if your plugin requires i18n, validate it in `start(ctx)` and throw a clear error when missing.
- `ctx.api.iobroker`: ioBroker interaction facade (Promises where applicable)
  - `ids` (ID helpers)
    - `ids.namespace`: adapter namespace (e.g. `msghub.0`)
    - `ids.toOwnId(fullId)`: strip `<namespace>.` from a full id (returns the input if it’s not under the namespace)
    - `ids.toFullId(ownId)`: add `<namespace>.` to an own id (returns the input if it already has the prefix)
    - Best practice: use this to convert `options.pluginBaseObjectId` before calling ioBroker APIs that expect “own ids”.
  - `objects` (foreign object access)
    - `objects.setObjectNotExists(ownId, obj): Promise<void>`
    - `objects.delObject(ownId): Promise<void>`
    - `objects.getForeignObjects(pattern, type?): Promise<Record<string, ioBroker.Object>>`
    - `objects.getForeignObject(id): Promise<ioBroker.Object|null>`
    - `objects.extendForeignObject(id, patch): Promise<void>` (deep-merge for `common/native`)
    - Best practice: keep `extendForeignObject` patches minimal to avoid overwriting unrelated data.
  - `states` (foreign state access)
    - `states.setState(ownId, state): Promise<void>`
    - `states.getForeignState(id): Promise<ioBroker.State|null>`
  - `subscribe` (subscriptions)
    - `subscribeStates(pattern)`, `unsubscribeStates(pattern)`
    - `subscribeObjects(pattern)`, `unsubscribeObjects(pattern)`
    - `subscribeForeignStates(idOrPattern)`, `unsubscribeForeignStates(idOrPattern)`
    - `subscribeForeignObjects(idOrPattern)`, `unsubscribeForeignObjects(idOrPattern)`

### Ingest plugins (producer)

Host: `MsgIngest` (see [`docs/modules/MsgIngest.md`](../modules/MsgIngest.md))

What you receive:

- `onStateChange(id, state, ctx)` and/or `onObjectChange(id, obj, ctx)`
- `ctx.api.store` store facade (single write path for mutations)
  - write API (mutations)
    - `addMessage(msg)`
    - `updateMessage(msgOrRef, patch)`
    - `addOrUpdateMessage(msg)`
    - `removeMessage(ref)`
    - `completeAfterCauseEliminated(ref, { actor?, finishedAt? })`
  - read API (views)
    - `getMessageByRef(ref)`
    - `getMessages()`
    - `queryMessages({ where, page?, sort? })`
- `ctx.api.factory` normalization gate: `createMessage(...)`
- `ctx.api.constants` for enums and shared vocabulary
- `ctx.api.iobroker` for subscriptions and discovery (see API reference above)
- `ctx.api.i18n` / `ctx.api.log` for translations and logging

Where events come from (important):

- ioBroker calls the adapter’s `onStateChange` / `onObjectChange` **only for ids the adapter has subscribed to**.
- `main.js` forwards those subscribed events into `MsgIngest`, which then **fans out to all registered ingest plugins**.
- Plugin enable/disable switches created by `IoPlugins` are intercepted and **not** forwarded to ingest plugins.

Subscribing from inside a plugin:

- Subscribe in `start(ctx)` and unsubscribe in `stop(ctx)` via `ctx.api.iobroker.subscribe.*`.
- Use `subscribeForeignStates(fullId)` / `subscribeForeignObjects(fullId)` for specific external ids.
- Use `subscribeStates(ownId)` / `subscribeObjects(ownId)` for ids in your own namespace (own ids).
- Keep subscriptions narrow (avoid `'*'`); after you subscribe, every matching update will go through the adapter and be fanned out to all ingest plugins, so always filter by `id` inside `onStateChange`.

What you usually do:

- decide whether an event is relevant
- compute a stable `ref` (dedupe key)
- create a new message (via `ctx.api.factory.createMessage`) or patch an existing one (`ctx.api.store.updateMessage`)

### Notify plugins (notifier)

Host: `MsgNotify` (see [`docs/modules/MsgNotify.md`](../modules/MsgNotify.md))

What you receive:

- `(event, notifications, ctx)` where `notifications` is always an array
- `event` is a value from `MsgConstants.notfication.events` (for example `"added"`, `"due"`, `"updated"`)
- optional lifecycle: `start(ctx)` (on registration) and `stop(ctx)` (on unregister/overwrite)
- `ctx.api.constants` for allowed event names and enums
- `ctx.api.store` read API (optional; when the host was constructed with a store)
  - `getMessageByRef(ref)`
  - `getMessages()`
  - `queryMessages({ where, page?, sort? })`
- `ctx.api.i18n` / `ctx.api.log` for translations and logging
- `ctx.api.iobroker` for ID conversion and optional ioBroker read/subscribe tasks (see API reference above)

What you usually do:

- map the message objects to your delivery system (states, push, TTS, ...)
- handle errors best-effort; a notifier should never block other notifiers

Best practices for notify plugins:

- Do not throw on per-message delivery errors; log and continue.
- Avoid blocking work in the notification handler; if you need I/O, batch or queue it.
- If your notifier writes into ioBroker states/objects and you need adapter APIs that are not exposed yet, extend the host API (see `src/MsgHostApi.js`) instead of reaching for `adapter.*`.
- If you need inbound user interaction (actions or message creation), implement an Engage integration instead of a Notify plugin.

### Engage plugins (interactive channel)

An Engage plugin is a **bidirectional, human-facing channel integration**.

It combines the responsibilities of:

- a Producer (`Ingest...`): it may create/update/remove messages, and
- a Receiver (`Notify...`): it receives MsgHub notification events for outbound delivery, and
- the Action layer: it may execute whitelisted message actions based on inbound user intents.

Handler shape (expected):

- `onNotifications(event, notifications, ctx)` (outbound; same signature as Notify)
- optional lifecycle: `start(ctx)` / `stop(ctx)` (recommended to manage polling/webhooks/connections)

What you can do (functional contract):

- Everything an Ingest plugin can do:
  - `ctx.api.factory.createMessage(...)` (normalization gate)
  - `ctx.api.store.addMessage(...)`, `updateMessage(...)`, `addOrUpdateMessage(...)`, `removeMessage(...)`, `completeAfterCauseEliminated(...)`
  - `ctx.api.store.getMessageByRef(...)`, `getMessages()`, `queryMessages(...)`
- Plus execute whitelisted actions via MsgAction:
  - `ctx.api.action.execute({ ref, actionId, actor?, payload? })`

How inbound interaction usually works:

- Engage plugins are typically **not driven by ioBroker `stateChange` events** (that is what `MsgIngest` is for).
  Instead, the plugin listens to its own channel (Telegram updates, HTTP callbacks, polling APIs, …) and translates
  inbound events into MsgHub effects by calling `ctx.api.store.*` and/or `ctx.api.action.execute(...)`.
- For “ack over the same channel”: your outbound message must contain enough correlation (e.g. a callback payload) so the
  inbound reply can be mapped back to `{ ref, actionId }`.
- Prefer passing a useful `actor` string when executing actions (e.g. `telegram:<userId>` / `web:<clientId>`). Attribution
  is best-effort and currently does not imply ACLs.

### Bridge plugins (bidirectional)

A “bridge plugin” is not a third host interface. It is a packaging/wiring convenience:
your bridge factory returns **one handler object** that covers both directions, and `IoPlugins` wires it via `MsgBridge`
into `MsgIngest` + `MsgNotify`.

Bridge factories must return:

- required: `onNotifications(event, notifications, ctx)` (outbound)
- inbound (at least one required): `start(ctx)` and/or `onStateChange(id, state, ctx)` and/or `onObjectChange(id, obj, ctx)`
- optional: `stop(ctx)`

Registration ids:

- `IoPlugins` uses a base id like `BridgeFoo:0`
- `MsgBridge` derives the concrete host ids as `BridgeFoo:0.ingest` and `BridgeFoo:0.notify`

Implementation tip:
create a shared context object (caches, rate limits, “ready” flags) and close over it from all handler functions.

## Bidirectional integrations (“bridges”)

Many integrations are two-way:

- inbound: external changes → update Message Hub messages (ingest plugin)
- outbound: Message Hub events → push changes outward (notify plugin)

Bidirectional integrations always have **two directions** (inbound + outbound):

- inbound: external changes → Message Hub mutations
- outbound: Message Hub events → external delivery

You can implement this in two ways:

1. **Two separate plugins** (`Ingest...` + `Notify...`) and wire them together manually (or via `MsgBridge` in adapter code).
2. **One bridge plugin** (`Bridge...`) and let `IoPlugins` manage it as one runtime instance (one enable switch + one `native` config object),
   with a single handler wired into both hosts via `MsgBridge`.

In both cases, the safe wiring helper is `MsgBridge` (see [`docs/modules/MsgBridge.md`](../modules/MsgBridge.md)).

## Common rules and pitfalls

- Keep handlers fast (plugins run in the adapter process).
- Be idempotent where possible (ioBroker events can repeat; restarts happen).
- Use stable ids (`ref`) to avoid uncontrolled message growth.
- Avoid throwing: log and continue; the hosts will isolate failures, but best-effort behavior is still the goal.

## Built-in plugins in this repo

The plugin docs in this folder are for the built-in plugins shipped with this repository. They are also good templates for your own code.

## Modules

<!-- AUTO-GENERATED:MODULE-INDEX:START -->
- `EngageSendTo`: [`./EngageSendTo.md`](./EngageSendTo.md)
- `IngestHue`: [`./IngestHue.md`](./IngestHue.md)
- `IngestRandomChaos`: [`./IngestRandomChaos.md`](./IngestRandomChaos.md)
- `IoPlugins`: [`./IoPlugins.md`](./IoPlugins.md)
- `NotifyDebug`: [`./NotifyDebug.md`](./NotifyDebug.md)
- `NotifyStates`: [`./NotifyStates.md`](./NotifyStates.md)
<!-- AUTO-GENERATED:MODULE-INDEX:END -->
