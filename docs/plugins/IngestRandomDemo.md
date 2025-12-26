# Producer: IngestRandomDemo

`IngestRandomDemo` is a small **Ingest (producer)** plugin that periodically generates demo messages.
It is meant for development and UI testing: it helps you verify that message creation, updates, notifications, and cleanup work end-to-end.
The plugin does not subscribe to ioBroker states; it only uses a timer and writes to the Message Hub store.
Each demo message gets an `expiresAt` timestamp so it disappears automatically after a short time.

---

## Basics

- Type: `Ingest` (producer)
- Registration ID (as used by `lib/MsgPlugins.js`): `IngestRandomDemo:0`
- Implementation shape: lifecycle plugin (`start()`/`stop()`); no `onStateChange` handler

---

## Config

This plugin is configured by the adapter via `lib/MsgPlugins.js`.

The runtime passes:

- `options.pluginBaseObjectId` (required): full id of the plugin base object (e.g. `msghub.0.IngestRandomDemo.0`).

Options (all optional):

- `intervalMs` (number, default `15000`): how often a demo tick runs.
- `ttlMs` (number, default `120000`): base time-to-live per message.
- `ttlJitter` (number, default `0.5`): TTL randomization ratio; per tick the plugin picks `ttlNow` in the range `ttlMs * (1 ± ttlJitter)` (min. `1000ms`).
- `refPoolSize` (number, default `15`): how many stable message `ref`s exist in the pool (picked randomly per tick).

---

## Behavior

On `start(ctx)`:

- reads allowed `level` and `kind` values from `ctx.api.constants` (MsgConstants)
- immediately runs one tick (so you see messages right away)
- starts an interval timer

On every tick:

- picks a random `ref` from a fixed pool:
  - `msghub.0.IngestRandomDemo.0_ref01`
  - `msghub.0.IngestRandomDemo.0_ref02`
  - ...
- if no message with that `ref` exists yet:
  - creates a new message via `ctx.api.factory.createMessage(...)`
  - writes it via `ctx.api.store.addMessage(...)`
- if the message already exists:
  - patches it via `ctx.api.store.updateMessage(ref, patch)`
  - refreshes `timing.expiresAt` so it stays visible for `ttlNow` after the last update

Dedupe/update strategy:

- the `ref` pool is the dedupe key; the plugin reuses the same refs to avoid unbounded message growth (randomly touching entries in that pool).

On `stop()`:

- clears the timer and releases cached context.

---

Typical message fields created/updated by this plugin:

- `ref`: `${options.pluginBaseObjectId}_ref01` (… `_ref02`, `_ref03`, …)
- `level` / `kind`: random values from MsgConstants
- `origin`: `origin.type = automation`, `origin.system = IngestRandomDemo`
- `timing.expiresAt`: `Date.now() + ttlNow` (a randomized TTL derived from `ttlMs` and `ttlJitter`)

Note: the built-in demo `title`/`text` strings are currently German in `lib/IngestRandomDemo/index.js`.

---

## Related files

- Implementation: `lib/IngestRandomDemo/index.js`
- Plugin overview: `docs/plugins/README.md`
