# Message Hub Plugins (IO Layer) – Developer Guide

This document focuses on **how to integrate your own custom plugin** into Message Hub:
what interfaces exist, what data you receive, and how the adapter wires plugins at runtime.

If you want the “big picture” first, see [`docs/README.md`](../README.md). For the core internals, see [`docs/modules/README.md`](../modules/README.md).

## Mental model: code-level plugins vs. runtime wiring

There are two related, but different things called “plugins”:

1. **Code-level plugin handlers**
   - JavaScript handlers that implement the Ingest or Notify interface.
   - They are called by the plugin hosts `MsgIngest` and `MsgNotify`.

2. **Runtime plugin management**
   - On a running ioBroker adapter instance you need enable/disable switches and configuration storage.
   - In this repo, that job is done by `MsgPlugins` (`lib/MsgPlugins.js`).

`MsgPlugins` reads plugin config from ioBroker objects, creates enable toggles, and registers/unregisters the plugin handlers into the two plugin hosts.

Read more: [`docs/plugins/MsgPlugins.md`](./MsgPlugins.md)

### Architecture around `MsgPlugins` + `MsgBridge` (ASCII)

```
ioBroker Objects (per plugin instance)
  - state boolean      -> enable/disable (ack:false = user intent)
  - object.native JSON -> plugin options
            |
            v
      MsgPlugins (lib/)
      - ensures control states exist
      - loads options from native
      - registers/unregisters:
          - Ingest...  -> msgIngest.registerPlugin(...)
          - Notify...  -> msgNotify.registerPlugin(...)
          - Bridge...  -> MsgBridge.registerBridge(...)  (ingest + notify as a pair)
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

Message Hub supports three plugin families:

- **Ingest plugins** (type prefix `Ingest...`): ioBroker events → message create/update/remove
- **Notify plugins** (type prefix `Notify...`): Message Hub events → delivery actions
- **Bridge plugins** (type prefix `Bridge...`): bidirectional integrations (one enable switch, but returns `{ ingest, notify }`)

Naming is not cosmetic: `MsgPlugins` enforces the prefix by category to prevent catalog mistakes.

### 2) Implement the plugin factory in `lib/`

Convention in this repo:

- One plugin = one folder: `lib/<TypeName>/index.js`
- The export is a factory: `<TypeName>(adapter, options) => handler`

The runtime will pass your `options` from ioBroker `native` plus an extra field:

- `options.pluginBaseObjectId` (full id) so you can create states below your own subtree if needed

Example: ingest plugin skeleton:

```js
// lib/IngestMyPlugin/index.js
'use strict';

function IngestMyPlugin(adapter, options) {
  return {
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

function NotifyMyPlugin(adapter, options) {
  return {
    onNotifications(event, notifications, ctx) {
      // deliver best-effort (notifications is an array)
    },
  };
}

module.exports = { NotifyMyPlugin };
```

Example: bridge plugin skeleton (bidirectional integration):

```js
// lib/BridgeMySystem/index.js
'use strict';

function BridgeMySystem(adapter, options) {
  const shared = { adapter, options };

  return {
    // Optional overrides for registration ids used in MsgIngest/MsgNotify:
    // ingestId: 'BridgeMySystem:0:ingest',
    // notifyId: 'BridgeMySystem:0:notify',

    ingest: {
      onStateChange(id, state, ctx) {
        // inbound: external -> Message Hub mutations
      },
    },
    notify: {
      onNotifications(event, notifications, ctx) {
        // outbound: Message Hub events -> external delivery
      },
    },
  };
}

module.exports = { BridgeMySystem };
```

### 3) Add the plugin to the catalog (`lib/index.js`)

To make the plugin show up as a runtime-managed plugin, add it to `MsgPluginsCatalog`:

- choose `type` (stable identifier; usually the factory name)
- put it into the correct category list (`ingest` / `notify` / `bridge`)
- set `defaultEnabled` and `defaultOptions`
- set `create` to your factory

After that, the adapter’s `MsgPlugins` layer will create the enable/config object and can start/stop your plugin.

### 4) Create documentation and keep indexes updated

- Add `docs/plugins/<TypeName>.md` (or run `npm run docs:generate` to create a stub)
- Fill the stub and keep the README index clean (CI checks via `npm run docs:check`)

## Runtime model: enable/disable + configuration

With `MsgPlugins`, each plugin instance is represented by one ioBroker object id that has **two roles**:

- the **state value** (`boolean`) is the enable switch
- the object’s **`native`** JSON is the plugin options

Practical consequences:

- Enable/disable is done by writing the boolean with `ack: false` (user intent)
- Changing `native` does not automatically reconfigure a running plugin
  - practical rule: disable + enable (or restart the adapter) to apply option changes

ID scheme (today):

- own id (inside adapter APIs): `<TypeName>.<instanceId>` (instance id is currently always `0`)
- full id (in ioBroker object tree): `<adapter.namespace>.<TypeName>.<instanceId>` (example: `msghub.0.NotifyIoBrokerStates.0`)

`MsgPlugins` also passes `options.pluginBaseObjectId` to your factory as the **full id** of that base object.
Many ioBroker adapter APIs expect “own ids”, so plugins commonly strip the adapter namespace first (see `lib/NotifyIoBrokerStates/index.js`).

Bridge plugins follow the same storage model (one enable/config object, options in `native`), but they result in **two registrations**
behind the scenes (ingest + notify) via `MsgBridge`.

## Interfaces you must implement

Both plugin hosts pass the same shape of context:

- `ctx.api`: stable capabilities (depends on host)
- `ctx.meta`: dispatch metadata (who triggered the call, plus `running`)

Plugins should treat the core as a black box:
use `ctx.api.*` and do not mutate `MsgStore` internals.

### Ingest plugins (producer)

Host: `MsgIngest` (see [`docs/modules/MsgIngest.md`](../modules/MsgIngest.md))

What you receive:

- `onStateChange(id, state, ctx)` and/or `onObjectChange(id, obj, ctx)`
- `ctx.api.store` write API: `addMessage`, `updateMessage`, `addOrUpdateMessage`, `removeMessage`, ...
- `ctx.api.factory` normalization gate: `createMessage(...)`
- `ctx.api.constants` for enums and shared vocabulary

What you usually do:

- decide whether an event is relevant
- compute a stable `ref` (dedupe key)
- create a new message (via `ctx.api.factory.createMessage`) or patch an existing one (`ctx.api.store.updateMessage`)

### Notify plugins (notifier)

Host: `MsgNotify` (see [`docs/modules/MsgNotify.md`](../modules/MsgNotify.md))

What you receive:

- `(event, notifications, ctx)` where `notifications` is always an array
- `event` is a value from `MsgConstants.notfication.events` (for example `"due"`, `"updated"`)
- `ctx.api.constants` for allowed event names and enums

What you usually do:

- map the message objects to your delivery system (states, push, TTS, ...)
- handle errors best-effort; a notifier should never block other notifiers

### Bridge plugins (bidirectional)

A “bridge plugin” is not a third host interface. It is a packaging/wiring convenience:
your bridge factory returns **two normal handlers** (ingest + notify), and `MsgPlugins` wires them as a pair via `MsgBridge`.

Bridge factories must return:

- `{ ingest, notify }`
- optionally `ingestId` / `notifyId` to control the registration ids on `MsgIngest` / `MsgNotify`

Implementation tip:
create a shared context object (caches, rate limits, “ready” flags) and close over it from both handlers.

## Bidirectional integrations (“bridges”)

Many integrations are two-way:

- inbound: external changes → update Message Hub messages (ingest plugin)
- outbound: Message Hub events → push changes outward (notify plugin)

Bidirectional integrations are always **two handlers** (ingest + notify), because they connect both directions:

- inbound: external changes → Message Hub mutations
- outbound: Message Hub events → external delivery

You can implement this in two ways:

1. **Two separate plugins** (`Ingest...` + `Notify...`) and wire them together manually (or via `MsgBridge` in adapter code).
2. **One bridge plugin** (`Bridge...`) and let `MsgPlugins` manage it as one runtime instance (one enable switch + one `native` config object).

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
- `IngestIoBrokerStates`: [`./IngestIoBrokerStates.md`](./IngestIoBrokerStates.md)
- `IngestRandomDemo`: [`./IngestRandomDemo.md`](./IngestRandomDemo.md)
- `MsgPlugins`: [`./MsgPlugins.md`](./MsgPlugins.md)
- `NotifyIoBrokerStates`: [`./NotifyIoBrokerStates.md`](./NotifyIoBrokerStates.md)
<!-- AUTO-GENERATED:MODULE-INDEX:END -->
