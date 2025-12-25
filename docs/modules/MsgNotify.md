# MsgNotify (MsgHub): dispatch notification events to plugins

`MsgNotify` is the notification dispatcher of MsgHub.
It takes a **notification event** (like `"due"` or `"updated"`) plus one or more messages, and then forwards that
information to all registered notifier plugins.

Important: `MsgNotify` does **not** send notifications by itself. It only calls plugins that do the actual delivery
(for example writing to ioBroker states, sending push messages, TTS, …).

---

## Where it sits in the system

A typical (simplified) flow looks like this:

1. A message is created/updated/removed inside `MsgStore`.
2. `MsgStore` decides that an event should be announced (e.g. a message becomes due).
3. `MsgStore` calls `msgNotify.dispatch(event, messages, meta)`.
4. `MsgNotify` validates the event name and fans out the call to all registered notifier plugins.

So `MsgNotify` is the “bridge” between the **core message store** and the **delivery mechanisms**.

---

## What is a “notification” here?

In MsgHub a “notification” is simply a **MsgHub `Message` object** that is being announced to the outside world.

- The `notification` payload is the message itself (not a separate schema).
- The `event` tells plugins *why* the message is sent now (due/updated/deleted/expired).
- `meta` is optional metadata that can help plugins (for example: where the dispatch came from).

`MsgNotify` does not interpret message content. It only forwards it.

---

## Core responsibilities

`MsgNotify` mainly does four things:

1. **Validate event names**
   - `dispatch()` only accepts event values defined in `MsgConstants.notfication.events`.
   - Unsupported event names throw an error early so problems are visible.

2. **Normalize input**
   - `messages` can be a single object or an array.
   - Invalid entries (null / non-objects) are ignored.

3. **Fan out to plugins**
   - Each registered plugin is called with a stable handler signature.
   - Plugins are responsible for doing the real delivery work.

4. **Isolate failures**
   - Plugin errors are caught and logged.
   - A broken plugin must not block other plugins.

---

## Design guidelines / invariants (the important rules)

### 1) Event names are *values*, not keys

`dispatch()` expects the **stored event value** from `MsgConstants.notfication.events`, for example:

- `"due"`
- `"updated"` (note: the key is `update`, the value is `"updated"`)
- `"deleted"`
- `"expired"`

It does not accept the object keys unless they happen to match the value.

### 2) No message state mutation

`MsgNotify` does not change messages.
It does not move timestamps like `timing.notifyAt`, and it does not mark a message as “already notified”.
Those rules live in `MsgStore` and/or in plugins.

### 3) One-message dispatch (stable plugin interface)

Internally, `dispatch()` sends messages **one by one**.
But every plugin still receives an array (`notifications`) to keep the interface stable for potential future batching.

Practical consequence: today the plugin usually receives `notifications.length === 1`, but it should still handle arrays.

### 4) Fault isolation

Each plugin call is wrapped in a `try/catch`.
If one plugin fails, others still run.

---

## Public API (what you call)

### `new MsgNotify(adapter, msgConstants)`

- `adapter` is used for logging.
- `msgConstants` is the source of truth for allowed notification events (`MsgConstants.notfication.events`).

### `registerPlugin(id, handler)`

Registers (or overwrites) a notifier plugin.

Supported handler shapes:

- Function handler: `(event, notifications, ctx) => void`
- Object handler: `{ onNotifications(event, notifications, ctx) { ... } }`

Object handlers are bound so `this` works as expected.

### `unregisterPlugin(id)`

Removes a plugin. If the id is unknown, nothing happens.

### `dispatch(event, messages, meta?)`

Dispatches a notification event.

- Throws if `event` is not in `MsgConstants.notfication.events` values.
- Accepts a single message object or an array of message objects.
- Ignores invalid entries.
- Returns the number of dispatched messages (valid objects only).

---

## Plugin contract (what plugins receive)

Every plugin is called like:

```js
plugin(event, [notification], { api, meta });
```

Where:

- `event` is a string like `"due"` or `"updated"`.
- `notifications` is always an array (currently one element per call).
- `api` contains stable capabilities (currently: `api.constants`).
- `meta` is optional dispatch metadata provided by the caller.

Example plugin: `lib/NotifyIoBrokerState.js` implements `onNotifications(event, notifications, ctx)` and typically uses `ctx.meta`.

---

## Practical guidance (for plugin authors)

- Keep plugin handlers fast and robust (they run in the same process as the adapter).
- Do not assume “exactly one” notification forever; always handle arrays.
- If you need filtering/routing, use message fields (`kind`, `level`, `audience`, …) and the `event`.
- Avoid throwing errors. `MsgNotify` will catch them, but your plugin should still try to be best-effort.

---

## Conventions in this repo

- Notifier plugins live in `lib/` and are exported via `lib/index.js`.
- Plugin filenames follow `Notify<System>.js` (example: `lib/NotifyIoBrokerState.js`).

---

## Related files

- Implementation: `src/MsgNotify.js`
- Notification triggers and semantics: `src/MsgStore.js` and `src/MsgStore.md`
- Allowed event values: `src/MsgConstants.js` (`MsgConstants.notfication.events`)
- Example notifier plugin: `lib/NotifyIoBrokerState.js`
- Plugin exports: `lib/index.js`
