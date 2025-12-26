# MsgPlugins (Message Hub): adapter-side plugin runtime

`MsgPlugins` is the **runtime manager** that wires Message Hub plugins into the running ioBroker adapter.
It lives on the adapter side (in `lib/`) and is responsible for turning a static plugin catalog into “real” plugin instances
that can be enabled/disabled and configured via ioBroker objects.

In short: **it creates the plugin switches, loads plugin options, and registers/unregisters plugins at runtime.**

---

## Where it sits in the system

Message Hub has a clear split between **core** and **IO/integration**:

- The adapter (`main.js`) owns the `MsgStore` instance (core in `src/`).
- `MsgStore` owns two plugin hosts:
  - `msgIngest` (producer plugins): inbound ioBroker events → message create/update/remove
  - `msgNotify` (notifier plugins): message notification events → delivery actions
- `MsgPlugins` is the adapter’s “plugin runtime” that connects the catalog in `lib/index.js` to those two hosts.

A typical flow on startup:

1. `main.js` creates `MsgStore` and initializes it.
2. `main.js` calls `await MsgPlugins.create(adapter, msgStore)`.
3. `MsgPlugins` ensures enable-switch states exist and subscribes to them.
4. `MsgPlugins` registers all plugins that are currently enabled.
5. The adapter starts the ingest host (`msgStore.msgIngest.start()`), so producers can receive events.

---

## Core responsibilities

`MsgPlugins` mainly does three things:

1. **Maintain enable/disable switches (ioBroker states)**
   - For every catalog entry, it ensures a boolean state exists.
   - Users can toggle these switches in ioBroker (write with `ack: false`).

2. **Persist and load plugin options**
   - Plugin options are stored in the same ioBroker object under `native` (raw JSON).
   - On registration, options are read and passed to the plugin factory.

3. **Register/unregister plugin instances**
   - Enabled ingest plugins are registered into `msgStore.msgIngest`.
   - Enabled notify plugins are registered into `msgStore.msgNotify`.
   - When a user toggles a switch, the plugin is started/stopped accordingly.

---

## What it intentionally does NOT do

These are deliberate boundaries:

- **No plugin discovery**: the list of available plugins is fixed by the catalog in `lib/index.js`.
- **No option validation/normalization**: `native` is passed through as-is; each plugin owns its own config schema.
- **No “bridge host layer”**: bridge wiring is implemented by `src/MsgBridge.js`, but events still flow through the existing hosts (`MsgIngest` and `MsgNotify`).

---

## Enable/disable + config storage model

### One object per plugin instance

For each plugin instance, `MsgPlugins` uses one ioBroker object id for two purposes:

- enable switch: the **state value** (`boolean`)
- configuration: the object’s **`native`** payload (raw JSON)

This keeps plugin configuration in one place and makes toggling easy.

### ID scheme (today)

- Own/base id: `<PluginType>.<instanceId>`
- Full id: `<adapter.namespace>.<PluginType>.<instanceId>`

Instance id is currently always numeric `0`.

Example (adapter instance `msghub.0`):

- enable/config object: `msghub.0.NotifyIoBrokerStates.0`
- own id form (inside adapter APIs): `NotifyIoBrokerStates.0`

### Important semantics / invariants

- The boolean state value is the **source of truth** (persisted in ioBroker).
- Enable toggles are triggered only by state writes with `ack: false` (user intent).
- After applying the change, `MsgPlugins` writes the final value back with `ack: true` to **commit** the new state.
- Toggle operations are serialized via `createOpQueue()` to avoid overlapping start/stop sequences.
- If the id already exists as a non-state object (legacy/accidental), it is migrated by deleting and recreating it as
  `type=state` (best-effort preserving `native`).

---

## Runtime behavior (how it works)

### 1) Initialization: create and subscribe to enable states

`init()` ensures every plugin in the catalog has an enable state and subscribes to it.

- Seeding happens only once: if the state does not exist yet, it is created and initialized using `defaultEnabled` from the catalog.
- If the state already exists, the stored value is used.

Important: `MsgPlugins` subscribes to *exact* ids (one per plugin). It does not subscribe to wildcards.

### 2) Registration: start enabled plugins

`registerEnabled()` iterates over all managed plugin instances and registers the enabled ones.

Registration is idempotent:

- Each plugin instance gets a stable registration id: `"<type>:<instanceId>"` (example: `NotifyIoBrokerStates:0`).
- If the same id is already registered, it is not registered again.

Options passed to the plugin factory:

- `native` options (raw)
- plus `pluginBaseObjectId` (full id), so the plugin can create its own subtree below it

Example base id:

- `pluginBaseObjectId = "msghub.0.NotifyIoBrokerStates.0"`

### 3) Toggling: start/stop on `stateChange`

`handleStateChange(id, state)` is meant to be called early in the adapter’s `onStateChange` handler.

- If the id belongs to a plugin enable switch, the event is consumed.
- `ack: true` writes are ignored (includes initialization and the “commit” write).
- `ack: false` writes are treated as user intent:
  - `true` → register the plugin
  - `false` → unregister the plugin

This is the integration point in `main.js`:

```js
onStateChange(id, state) {
  if (this._msgPlugins?.handleStateChange?.(id, state)) return;
  this.msgStore.msgIngest.dispatchStateChange(id, state, { source: 'iobroker.stateChange' });
}
```

### 4) Category guards (consistency)

When building states, `MsgPlugins` enforces a naming convention:

- ingest plugin types must start with `Ingest...`
- notify plugin types must start with `Notify...`
- bridge plugin types must start with `Bridge...`

---

## Bridge plugins (bidirectional integrations)

`MsgPlugins` also supports a third catalog category: `bridge`.

Why this exists:

- Many real integrations are bidirectional (external ↔ MsgHub).
- Conceptually they are one integration, but technically they are **two plugin handlers** (one ingest + one notify).

Runtime model:

- The bridge still has exactly one enable/config object id: `msghub.0.<BridgeType>.0`
- `native` stores the bridge options (raw), and the same `pluginBaseObjectId` is passed to the bridge factory.
- The bridge catalog entry must return both handlers:

  - `create(adapter, options)` returns `{ ingest, notify }` (and optionally `{ ingestId, notifyId }`)

Wiring:

- `MsgPlugins` calls `MsgBridge.registerBridge(...)` internally and keeps the returned handle for unregister.

This prevents catalog mistakes like registering an ingest plugin as a notify plugin.

---

## Public API (what the adapter calls)

### `MsgPlugins.create(adapter, msgStore, options?)`
Convenience startup entry point:

- constructs the manager
- runs `init()`
- runs `registerEnabled()`

### `init()`
Ensures enable/config objects exist, subscribes to their ids, and loads the current enable states.

### `registerEnabled()`
Registers all plugins whose enable state is currently `true`.

### `handleStateChange(id, state)`
Consumes plugin enable/disable state changes (and starts/stops plugins).
Returns `true` when the id was a plugin control state.

### `isPluginControlStateId(id)`
Helper for checks/UI logic: returns true if the id matches a known enable switch.

---

## Practical guidance

### For users / operators (in ioBroker)

- Enable/disable is done by writing the boolean state of the plugin object.
- Plugin settings live in the same object under `native`.
- Changing `native` does not automatically reconfigure a running plugin.
  Practical rule: **disable + enable (or restart the adapter)** if you want a plugin to pick up changed options.

### For developers (adding or changing plugins)

- Add the plugin type to the catalog in `lib/index.js` (`MsgPluginsCatalog`).
- Choose a stable `type` name and keep the category prefix (`Ingest...`, `Notify...`).
- Provide sensible `defaultEnabled` and `defaultOptions`.
- Use `options.pluginBaseObjectId` inside the plugin to create your plugin’s own states below that base.

---

## Related files

- Runtime manager: `lib/MsgPlugins.js`
- Plugin catalog: `lib/index.js`
- Adapter wiring: `main.js`
- Plugin overview: `docs/plugins/README.md`
- Plugin hosts: `src/MsgIngest.js`, `src/MsgNotify.js`
- Future bridge coordination: `src/MsgBridge.js`
