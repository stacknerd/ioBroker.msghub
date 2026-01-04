# IngestStates (ioBroker Objects → Custom)

`IngestStates` is a Message Hub **producer plugin** that turns ioBroker datapoints into MsgHub messages based on per-object **Custom** configuration (ioBroker Admin → Objects → Custom).

Status (MVP):

- Infrastructure: scan + subscriptions + config change handling.
- Rule evaluation: **Freshness** is implemented (missing updates); other rule modes are planned.

---

## 1) User Guide

### What it does

- Scans `system/custom` for objects that have MsgHub custom settings (`common.custom.<msghub instance>`).
- Subscribes to the configured datapoints (and selected dependencies).
- For `mode="freshness"`:
  - creates a message when updates stop for too long
  - optionally repeats via `msg.remind*`
  - optionally auto-closes on recovery via `msg.resetOnNormal` (+ delay)

### How to configure (ioBroker Admin)

1. Enable the `IngestStates` plugin instance in the MsgHub Admin Tab (Plugins).
2. In ioBroker Admin → Objects, open a datapoint and go to **Custom**.
3. Enable the MsgHub custom config for your adapter instance (e.g. `msghub.0`).
4. Set:
   - `mode = freshness`
   - `fresh.everyValue` + `fresh.everyUnit`
   - `fresh.evaluateBy = ts|lc`
   - optional: `msg.level`, `msg.kind`, `msg.title`, `msg.text`, `msg.remind*`, `msg.resetOnNormal`

### Notes

- `ts` (last update) changes on every write; `lc` (last change) only on value changes.
- If you enable custom but keep `mode` empty, MsgHub may auto-disable that custom entry to avoid “enabled but misconfigured” setups.

---

## 2) Software Documentation

### Overview

- Type: `IngestStates`
- Family: `Ingest`
- Implementation: `lib/IngestStates/index.js`
- Engine: `lib/IngestStates/Engine.js`
- Custom UI schema: `admin/jsonCustom.json`

### Runtime wiring (IoPlugins)

`IoPlugins` auto-discovers `IngestStates` from `lib/IngestStates/manifest.js` and manages:

- Base object: `msghub.0.IngestStates.0` (options in `object.native`)
- Enable state: `msghub.0.IngestStates.0.enable`
- Status state: `msghub.0.IngestStates.0.status`

### Discovery + subscriptions

The plugin scans:

- `system/custom` view (`ctx.api.iobroker.objects.getObjectView('system','custom',{})`)

and subscribes to:

- foreign objects for configured targets (to observe custom changes)
- foreign states required for routing/evaluation

### Freshness rule (MVP)

Inputs (from Custom config):

- `fresh.everyValue` + `fresh.everyUnit` (seconds multiplier)
- `fresh.evaluateBy = ts|lc`

Behavior:

- When `now - last(ts|lc) > every` → create/open a message.
- When updates resume → close the message (when `msg.resetOnNormal !== false`) or stop reminders.

Message identity:

- `ref = IngestStates.<instanceId>.fresh.<base64url(objectId)>`

---

## Related files

- Implementation: `lib/IngestStates/index.js`
- Manifest: `lib/IngestStates/manifest.js`
- Engine: `lib/IngestStates/Engine.js`
- Custom UI schema: `admin/jsonCustom.json`
- Plugin overview: `docs/plugins/README.md`

