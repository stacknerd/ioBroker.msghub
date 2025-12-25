# Producer: IngestRandomDemo

`IngestRandomDemo` is a small **Ingest (producer)** plugin that periodically generates demo messages.
It is meant for development and UI testing: it helps you verify that message creation, updates, notifications, and cleanup work end-to-end.
The plugin does not subscribe to ioBroker states; it only uses a timer and writes to the MsgHub store.
Each demo message gets an `expiresAt` timestamp so it disappears automatically after a short time.

---

## Basics

- Type: `Ingest` (producer)
- Registration ID: free choice (example: `random-demo`)
- Implementation shape: lifecycle plugin (`start()`/`stop()`); no `onStateChange` handler

---

## Config

Configured where the plugin is instantiated (typically in the adapter code that calls `registerPlugin(...)`).

Options (all optional):

- `intervalMs` (number, default `15000`): how often a demo tick runs.
- `ttlMs` (number, default `120000`): time-to-live per message; written as `timing.expiresAt = now + ttlMs`.
- `refPoolSize` (number, default `15`): how many stable message `ref`s are used in a round-robin pool.

---

## Behavior

On `start(ctx)`:

- reads allowed `level` and `kind` values from `ctx.api.constants` (MsgConstants)
- immediately runs one tick (so you see messages right away)
- starts an interval timer

On every tick:

- picks the next `ref` from a fixed pool: `IngestRandomDemo.01`, `IngestRandomDemo.02`, ...
- if no message with that `ref` exists yet:
  - creates a new message via `ctx.api.factory.createMessage(...)`
  - writes it via `ctx.api.store.addMessage(...)`
- if the message already exists:
  - patches it via `ctx.api.store.updateMessage(ref, patch)`
  - refreshes `timing.expiresAt` so it stays visible for `ttlMs` after the last update

Dedupe/update strategy:

- the `ref` pool is the dedupe key; the plugin reuses the same refs to avoid unbounded message growth.

On `stop()`:

- clears the timer and releases cached context.

---

## Examples

Register and start the demo producer (e.g. in `main.js`):

```js
const { IngestRandomDemo } = require(`${__dirname}/lib`);

this.msgStore.msgIngest.registerPlugin(
  'random-demo',
  IngestRandomDemo(this, { intervalMs: 10_000, ttlMs: 60_000, refPoolSize: 5 })
);
this.msgStore.msgIngest.start();
```

Typical message fields created/updated by this plugin:

- `ref`: `IngestRandomDemo.01` (… `.02`, `.03`, …)
- `level` / `kind`: random values from MsgConstants
- `origin`: `origin.type = automation`, `origin.system = IngestRandomDemo`
- `timing.expiresAt`: `Date.now() + ttlMs`

Note: the built-in demo `title`/`text` strings are currently German in `lib/IngestRandomDemo.js`.

---

## Related files

- Implementation: `lib/IngestRandomDemo.js`
- Plugin overview: `docs/plugins/README.md`
