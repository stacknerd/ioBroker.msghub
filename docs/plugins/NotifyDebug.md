# NotifyDebug

Bare-minimum skeleton for a `Notify...` plugin.

## Purpose

This plugin does not deliver anything. It is only a template that shows the current Notify plugin API and logs:

- lifecycle: `start(ctx)` and `stop(ctx)` (when supported by the host)
- notification dispatches: `onNotifications(event, notifications, ctx)`

## Factory + handler contract

- `lib/NotifyDebug/index.js` exports `NotifyDebug(options) => handler`
- The handler implements:
  - `start(ctx)` (optional)
  - `stop(ctx)` (optional)
  - `onNotifications(event, notifications, ctx)`

## Options (`native`)

- `trace` (`boolean`, default `false`): enable all debug logs (start/stop + notification dispatches).
- `someText` (`string`, optional): small demo value logged at startup when set.

## Runtime wiring (IoPlugins)

When enabled via the built-in plugin runtime:

- Base object id: `msghub.0.NotifyDebug.0`
- Enable switch: `msghub.0.NotifyDebug.0.enable`
- Status: `msghub.0.NotifyDebug.0.status`
