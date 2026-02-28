# NotifyDebug

`NotifyDebug` is a Message Hub **notify (notifier)** plugin intended for development: it logs notification dispatches and a few runtime details to help you understand the current Notify plugin API.

This document has two parts:

1) A user-facing guide (setup, configuration, best practices).
2) A technical description (how it works internally).

---

## 1) User Guide

### What it does

- Logs plugin lifecycle (`start(ctx)`, `stop(ctx)`) when trace is enabled.
- Logs every notification batch received via `onNotifications(event, notifications, ctx)`.
- Does not deliver anything and does not modify the Message Hub store.

### Prerequisites

- None. You only need access to the Message Hub adapter logs.

### Quick start (recommended setup)

1. Create a `NotifyDebug` instance in the Message Hub Plugins tab.
2. Set `trace=true`.
3. Enable the plugin instance (`...enable` switch).
4. Trigger a notification (for example by creating/updating a message) and watch the adapter logs.

### How to configure

Configuration is done in the Message Hub Admin Tab (Plugins) and uses the schema from `lib/NotifyDebug/manifest.js`.

Options:

- `trace` (boolean, default `false`)
  - Enables debug logs for start/stop and dispatches.
- `someText` (string, default `""`)
  - Optional demo value logged at startup.

### Best practices

- Keep this plugin disabled in production; it can produce noisy logs.
- Use it temporarily when developing other plugins or diagnosing notification routing.

### Troubleshooting

- “No logs”
  - Verify `trace=true` and the plugin instance is enabled and running.
  - Check adapter log level; `NotifyDebug` uses `debug` and `info`.

---

## 2) Software Documentation

### Overview

`NotifyDebug` is registered as a **notify** plugin:

- Registration id: `NotifyDebug:<instanceId>` (example: `NotifyDebug:0`)
- Implementation: `lib/NotifyDebug/index.js`

### Runtime wiring (IoPlugins)

- Base object: `msghub.0.NotifyDebug.<instanceId>`
- Enable state: `msghub.0.NotifyDebug.<instanceId>.enable`
- Status state: `msghub.0.NotifyDebug.<instanceId>.status`

### Handler contract

- Factory: `lib/NotifyDebug/index.js` exports `NotifyDebug(options) => handler`.
- Handler methods:
  - `start(ctx)` (optional)
  - `stop(ctx)` (optional)
  - `onNotifications(event, notifications, ctx)` (required)

`event` is a value from `ctx.api.constants.notfication.events` (for example `added`, `due`, `updated`, `deleted`, `expired`).

### What it logs

When `trace=true`, the plugin logs:

- options + a demo `ctx.api.i18n.t(...)` call
- `ctx.api.constants.kind` / `ctx.api.constants.level`
- `ctx.meta.plugin` identity (`regId`, `baseFullId`, `baseOwnId`)
- one log line per notification in the batch: `<ref> <event>: <title> - <text>`

### Related files

- Implementation: `lib/NotifyDebug/index.js`
- Plugin runtime: `lib/IoPlugins.js`
- Dispatcher: `src/MsgNotify.js`
