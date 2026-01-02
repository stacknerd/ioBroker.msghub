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

Note: the schema/defaults for these options come from `lib/NotifyDebug/manifest.js`. When options are changed via the
Admin Tab (or `IoPlugins.updateInstanceNative`) for an enabled instance, `IoPlugins` restarts that single instance so
changes apply immediately. If you edit `native` manually in the Objects view, do a disable+enable toggle to apply.

## Runtime wiring (IoPlugins)

When enabled via the built-in plugin runtime:

- Base object id: `msghub.0.NotifyDebug.<instanceId>`
- Enable switch: `msghub.0.NotifyDebug.<instanceId>.enable`
- Status: `msghub.0.NotifyDebug.<instanceId>.status`
