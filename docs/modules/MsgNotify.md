# MsgNotify (Message Hub): dispatch notification events to plugins

`MsgNotify` is the notification dispatcher of Message Hub.
It takes a **notification event** (like `"added"`, `"due"` or `"updated"`) plus one or more messages, and then forwards that
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

In Message Hub a “notification” is simply a **Message Hub `Message` object** that is being announced to the outside world.

- The `notification` payload is the message itself (not a separate schema).
- The `event` tells plugins *why* the message is sent now (added/due/updated/deleted/expired).
- `meta` is optional metadata that can help plugins (for example: where the dispatch came from).

`MsgNotify` does not interpret message content. It only forwards it.

Practical note: in the default core wiring, `MsgStore` dispatches a **rendered view** of messages (see `MsgRender`),
so notifier plugins typically receive already-rendered `title`/`text`/`details` fields.

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

## What it intentionally does NOT do

To keep Message Hub maintainable, `MsgNotify` deliberately does **not**:

- deliver to a specific channel/system (that is the job of notifier plugins)
- mutate messages (scheduling, acknowledge, housekeeping, … lives in `MsgStore` and/or Engage integrations)
- implement filtering semantics (plugins can filter, or they can query the store for derived views when `ctx.api.store` is available)
- implement batching semantics beyond the stable “array” handler signature

---

## Plugin handler shapes

You can register a notifier plugin in two ways:

- **Function plugin**: `(event, notifications, ctx) => void`
  - This is treated as `onNotifications`.
- **Object plugin**:
  - `{ onNotifications(event, notifications, ctx), start?(ctx), stop?(ctx) }`

Notes:

- Registering the same id again overwrites the previous plugin.
- Object handlers are bound so `this` works as expected.
- `start(ctx)` is called best-effort on registration.
- `stop(ctx)` is called best-effort on unregister and on overwrite.

---

## Plugin context: `ctx = { api, meta }`

Every dispatch call passes the same context shape:

- `ctx.api`: stable capabilities provided by Message Hub
  - `ctx.api.constants`
    - `MsgConstants` values (levels, kinds, origin types, allowed notify events, …)
  - `ctx.api.store` (optional; `null` when `MsgNotify` was constructed without a store)
    - `getMessageByRef(ref)`
    - `getMessages()`
    - `queryMessages({ where, page?, sort? })`
  - `ctx.api.iobroker`: ioBroker facade (promises where applicable)
  - `ctx.api.i18n`: optional i18n facade (may be `null`)
  - `ctx.api.log`: strict string-only logging facade
- `ctx.meta`: dispatch metadata provided by the caller (e.g. `MsgStore`)
  - plus `running` (boolean)

This split is intentional:

- `api` stays stable and explicit (“what you are allowed to do”)
- `meta` stays flexible (“what the current dispatch is about”)

---

## Design guidelines / invariants (the important rules)

### 1) Event names are *values*, not keys

`dispatch()` expects the **stored event value** from `MsgConstants.notfication.events`, for example:

- `"added"`
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

### `new MsgNotify(adapter, msgConstants, options?)`

- `adapter` is used for logging.
- `msgConstants` is the source of truth for allowed notification events (`MsgConstants.notfication.events`).
- `options.store` (optional) provides a store instance so notifier plugins can read via `ctx.api.store.*`.

### `registerPlugin(id, handler)`

Registers (or overwrites) a notifier plugin.

Supported handler shapes:

- Function handler: `(event, notifications, ctx) => void`
- Object handler: `{ onNotifications(event, notifications, ctx) { ... }, start?(ctx), stop?(ctx) }`

Object handlers are bound so `this` works as expected.

Optional lifecycle:

- If present, `start(ctx)` is called best-effort right after `registerPlugin(...)`.
- If present, `stop(ctx)` is called best-effort on `unregisterPlugin(...)` (and also on overwrite).

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
- `api` contains stable capabilities (for example: `api.constants`, `api.log`, and optionally `api.store`).
- `meta` is optional dispatch metadata provided by the caller.

Example plugin: `lib/NotifyStates/index.js` implements `onNotifications(event, notifications, ctx)` and typically uses `ctx.meta`.

---

## Important behavior and caveats

These details matter in real installations:

- **Dispatch is synchronous**
  - Plugins are called one after another (per notification).
  - If one plugin is slow, everything after it is delayed.
- **Stable call shape, even when non-batched**
  - `notifications` is always an array (today it’s typically one element per call).
- **Store access is optional**
  - `ctx.api.store` exists only when `MsgNotify` is constructed with a store instance.
  - In the default adapter wiring, `MsgStore` passes itself, so notifier plugins can use `ctx.api.store.queryMessages(...)` for derived views.
- **Start/stop are best-effort**
  - Exceptions are caught and logged.
  - A failing plugin should not prevent Message Hub from working.

---

## Practical guidance (for plugin authors)

- Keep plugin handlers fast and robust (they run in the same process as the adapter).
- Do not assume “exactly one” notification forever; always handle arrays.
- If you need filtering/routing, use message fields (`kind`, `level`, `audience`, …) and the `event`.
- Avoid throwing errors. `MsgNotify` will catch them, but your plugin should still try to be best-effort.

---

## Conventions in this repo

- Notifier plugins live in `lib/` and are exported via `lib/index.js`.
- Plugin modules follow `Notify*` (example: `lib/NotifyStates/index.js`).

---

## Minimal example (notifier plugin)

This is a small pattern you will see in `lib/`:

```js
function NotifyExample() {
	return {
		onNotifications(event, notifications, ctx) {
			for (const msg of notifications) {
				if (msg.kind !== ctx.api.constants.kind.task) continue;
				ctx.api.log.info(`event=${event} ref=${msg.ref} title=${msg.title}`);
			}
		},
	};
}

module.exports = { NotifyExample };
```

---

## Related files

- Implementation: `src/MsgNotify.js`
- Notification triggers and semantics: `src/MsgStore.js` and `docs/modules/MsgStore.md`
- Allowed event values: `src/MsgConstants.js` (`MsgConstants.notfication.events`)
- Example notifier plugin: `lib/NotifyStates/index.js`
- Plugin exports: `lib/index.js`
