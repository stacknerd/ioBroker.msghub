# IoPluginResources: per-plugin cleanup tracker for timers, subscriptions, and disposers

`lib/IoPluginResources.js` is part of the Message Hub IO/runtime layer.

It is the small per-plugin helper behind `ctx.meta.resources`.

---

## Where it sits in the system

`IoPluginResources` is created by `IoPlugins` for each registered plugin instance.
It is then injected into the plugin ctx so plugin code can allocate resources through a runtime-owned cleanup layer instead of tracking everything itself.

Its main job is simple:

- remember resources created during plugin runtime,
- dispose them when the plugin stops or is unregistered,
- do that best-effort and idempotently.

---

## Responsibilities

`IoPluginResources` is responsible for:

1. Tracking timeouts created through `setTimeout(...)`.
2. Tracking intervals created through `setInterval(...)`.
3. Clearing tracked timers on `disposeAll()`.
4. Tracking generic disposers registered through `add(...)`.
5. Wrapping `ctx.api.iobroker.subscribe.*` so subscriptions are automatically cleaned up.
6. Forgetting tracked subscriptions when a plugin unsubscribes manually.
7. Disposing everything in a stable order when the plugin is stopped.

---

## Public API / contract surface

### Constructor

```js
new IoPluginResources({ regId?, log?, timers? })
```

- `regId` is used for warning prefixes only
- `log` is optional
- `timers` exists mainly for tests

### `add(disposer)`

Registers a generic disposer.

Supported shapes:

- function: `() => void`
- object with `dispose()`

Returns an internal numeric token.

Special case:

- if the tracker was already disposed, the disposer is executed immediately best-effort and the method returns `0`

### `disposeAll()`

Best-effort cleanup of everything currently tracked.

Order:

1. clear tracked timers
2. run generic disposers in LIFO order

Calling `disposeAll()` multiple times is safe.

### `setTimeout(fn, delayMs, ...args)` / `clearTimeout(handle)`

Timeouts created through this wrapper are tracked automatically.

Important detail:

- one-shot timeouts remove themselves from the tracking map after they fire
- this avoids leaking timer bookkeeping in long-running plugins

### `setInterval(fn, intervalMs, ...args)` / `clearInterval(handle)`

Intervals are tracked until explicitly cleared or until `disposeAll()` runs.

### `wrapSubscribeApi(subscribeApi)`

Wraps `ctx.api.iobroker.subscribe.*` with cleanup-aware tracking.

Wrapped pairs include:

- `subscribeStates` / `unsubscribeStates`
- `subscribeObjects` / `unsubscribeObjects`
- `subscribeForeignStates` / `unsubscribeForeignStates`
- `subscribeForeignObjects` / `unsubscribeForeignObjects`

Behavior:

- subscriptions register internal disposers
- manual unsubscribes remove those tracked disposers again
- wrapped APIs are memoized per input object via `WeakMap`

Limitation:

- if the subscription pattern is empty or otherwise cannot produce a tracking key, subscribe/unsubscribe still run, but manual unsubscribe cannot remove a previously registered disposer entry via key lookup

---

## Design notes / invariants

- Best-effort by design: cleanup failures are logged as warnings and swallowed.
- Idempotent by design: disposal may happen more than once during error or shutdown paths.
- `IoPluginResources` does not own plugin lifecycle; it only owns resource cleanup for one plugin instance.
- The helper is generic on purpose: it knows timers, subscription pairs, and opaque disposers, not plugin semantics.
- If resources are added after disposal, they are immediately disposed best-effort instead of being tracked.

---

## Related files

- Implementation: `lib/IoPluginResources.js`
- Main creator/injector: `lib/IoPlugins.js`
- IO overview: `docs/io/README.md`
