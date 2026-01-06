# NotifyPushover

`NotifyPushover` is a Message Hub **notifier plugin** (MsgNotify plugin) that sends Message Hub `due` notifications to a configured Pushover adapter instance via ioBroker `sendTo()`.

This document has two parts:

1) A user-facing guide (setup, configuration, best practices).
2) A technical description (how it works internally).

---

## 1) User Guide

### What it does

- Sends Message Hub notifications (`event: "due"`) to `iobroker.pushover` (or compatible) via `sendTo('<pushover.0>', 'send', payload)`.
- Filters which messages are sent (kind, level range, lifecycle states, audience tags).
- Optional: blocks delivery behind a gate state (presence/arming/etc.).
- If a message has image attachments, sends one additional low-priority Pushover message per image.

What it intentionally does not do:

- It does not send `added/updated/deleted/expired` events (only `due`).
- It does not implement rate limiting or “spam protection”.
- It does not download images: only local plain file paths are accepted for image attachments.

### Prerequisites

- A running Pushover adapter instance (example: `pushover.0`) with working credentials.
- Message Hub must be running and the plugin instance must be enabled.

### Quick start (recommended setup)

1. Create one `NotifyPushover` instance in the Message Hub Plugins tab.
2. Set:
   - `pushoverInstance` to your adapter instance (default: `pushover.0`)
   - optionally: filters (`kindsCsv`, `levelMin/max`, `lifecycleStatesCsv`, `audienceTagsAnyCsv`)
   - priorities/icons to match your desired urgency mapping
3. Optional gate:
   - set `gateStateId` and a `gateOp` (and `gateValue` if needed)
4. Enable the plugin instance (`...enable` switch).
5. Make a message due (or create one without `timing.notifyAt`) and verify the Pushover notification arrives.

### How to configure

Configuration is done in the Message Hub Admin Tab (Plugins) and uses the schema from `lib/NotifyPushover/manifest.js`.

Target:

- `pushoverInstance` (string)
  - The adapter instance to call via `sendTo`, e.g. `pushover.0`.

Message filters (all optional; empty = allow all):

- `kindsCsv` (string, CSV)
  - Filters by `message.kind` (example: `task,status,appointment`).
- `levelMin` / `levelMax` (number)
  - Inclusive level range.
- `lifecycleStatesCsv` (string, CSV)
  - Filters by `message.lifecycle.state` (example: `open,acked,closed,snoozed,deleted,expired`).
- `audienceTagsAnyCsv` (string, CSV)
  - If set, only messages with at least one matching `audience.tags` entry are sent.

Priority + title icons:

- `priorityNone` / `priorityNotice` / `priorityWarning` / `priorityError` (number)
  - Per-level Pushover priority mapping (`-1` low, `0` normal, `1` high).
- `iconNone` / `iconNotice` / `iconWarning` / `iconError` (string)
  - Prefix icons used in the Pushover `title` (example defaults: `''`, `ℹ️`, `⚠️`, `🛑`).

Title icons (per message kind):

- `iconTask` / `iconStatus` / `iconAppointment` / `iconShoppinglist` / `iconInventorylist` (string)
  - Additional prefix icons used in the Pushover `title`, based on `message.kind`.

Gate (optional):

- `gateStateId` (string)
  - A foreign state id used as a gate (example: presence state).
- `gateOp` (string)
  - One of: `>`, `<`, `=`, `true`, `false`.
  - Empty disables the gate.
- `gateValue` (string)
  - Comparison value for `>`, `<`, `=` (numeric or string).
  - Ignored for `true` / `false`.
- `gateBypassFromLevel` (number)
  - If `message.level >= gateBypassFromLevel`, the gate is bypassed and the notification is always sent.
  - Default: `99` (effectively disabled for built-in levels 0/10/20/30).

### How to find the correct `pushoverInstance`

In ioBroker Admin:

- Open the Instances tab.
- Find your Pushover adapter instance.
- Use the instance id as value (example: `pushover.0`).

### Gate examples

Presence boolean gate (only send when `true`):

- `gateStateId = some.0.presence`
- `gateOp = true`

Numeric threshold gate (only send when value is greater than 0):

- `gateStateId = some.0.presenceCount`
- `gateOp = >`
- `gateValue = 0`

### Troubleshooting

- “No notifications arrive”
  - Verify the plugin instance is enabled and `Status` is `running`.
  - Verify your Pushover adapter instance can receive `sendTo(..., 'send', ...)` commands (test with an existing script).
  - Confirm messages are actually dispatched as `due` (Message Hub may treat missing `notifyAt` as “due now”).

- “Images do not arrive”
  - Only attachments with `type: "image"` and a local plain file path (`value` without `://`) are sent.
  - URLs are ignored by design.

---

## 2) Software Documentation

### Overview

`NotifyPushover` is a delivery-only integration registered as a **Notify** plugin:

- Input: Message Hub notifications via `MsgNotify` (`onNotifications(event, notifications, ctx)`).
- Output: `ctx.api.iobroker.sendTo(pushoverInstance, 'send', payload)`.

Implementation:

- `lib/NotifyPushover/index.js`

### Runtime wiring (IoPlugins)

When enabled via the built-in plugin runtime:

- Base object id: `msghub.0.NotifyPushover.<instanceId>`
- Enable switch: `msghub.0.NotifyPushover.<instanceId>.enable`
- Status: `msghub.0.NotifyPushover.<instanceId>.status`

Registration ID (as used by `lib/IoPlugins.js`):

- `NotifyPushover:<instanceId>` (example: `NotifyPushover:0`)

### Event handling

- Only `event === "due"` is handled.
- All other events are ignored.

### Filter semantics

Filtering mirrors the same “optional filter” shape used by other plugins in this repo:

- If the CSV list is empty → that filter is disabled (allows all).
- If the CSV list is non-empty → the message must match.

Level filtering:

- `message.level` must be numeric and within `[levelMin..levelMax]` (inclusive).

Audience tag filtering:

- If `audienceTagsAnyCsv` is set, `message.audience.tags` must contain at least one exact matching tag (trimmed).

### Gate semantics

If both `gateStateId` and `gateOp` are set, the plugin reads the foreign state and applies:

- `true` / `false`: strict boolean comparison (`state.val === true/false`)
- `>` / `<`: numeric comparison (`Number(state.val)` vs `Number(gateValue)`)
- `=`: numeric comparison when both sides are numeric, otherwise string comparison (`String(state.val).trim() === gateValue`)

If the gate is not configured (empty `gateStateId` or empty `gateOp`), delivery is not gated.

Gate bypass:

- If `message.level >= gateBypassFromLevel`, the gate result is ignored for that message.

### Payload mapping

For each matching message, the plugin sends:

- `message`: `message.text` with HTML tags removed
- `title`: `<kindIcon><levelIcon> <message.title>` (trimmed; missing/empty icons are omitted)
- `priority`: mapped per level (`priorityNone/Notice/Warning/Error`)
- `sound`: hard-coded to `"incoming"`

### Image attachments

If `message.attachments[]` contains entries with:

- `type: "image"`
- `value` is a local plain path (no `://`)

Then one extra Pushover message is sent per image:

- `message: "📷"`
- `title: "neues Foto"`
- `priority: -1`
- `file: <attachment.value>`

---

## Related files

- Implementation: `lib/NotifyPushover/index.js`
- Manifest: `lib/NotifyPushover/manifest.js`
- Dispatcher: `src/MsgNotify.js`
- Plugin overview: `docs/plugins/README.md`
