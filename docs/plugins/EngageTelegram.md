# EngageTelegram

`EngageTelegram` is a Message Hub **engage plugin** that integrates with the ioBroker **Telegram adapter**.

It combines two things into one plugin:

1) **Notify (outgoing)**: sends Message Hub `due` notifications to Telegram via `sendTo()` (similar “feeling” to `NotifyPushover`).
2) **Engage (incoming)**: executes Message Hub actions from Telegram inline button clicks and supports simple chat commands.

This document has two parts:

1) A user-facing guide (setup, configuration, best practices).
2) A technical description (how it works internally).

---

## 1) User Guide

### What it does

- Sends Telegram messages for Message Hub `due` notifications (Pushover-like).
- Renders message actions as Telegram **inline buttons** (menu entry + menu navigation).
- Handles button clicks and executes the corresponding Message Hub action (`ack/close/delete/snooze`) by allow-list (`message.actions[]`).
- Provides a minimal command entry point:
  - `/start` replies with a short help message.

### What it intentionally does not do (today)

- It does not create *new* Telegram notifications for `updated/recovered/recreated` events (it only syncs text/buttons and sends newly added image attachments).
- It does not implement a rich chat bot command set (this is intentionally kept modular and small).

### Prerequisites

- ioBroker Telegram adapter installed and configured.
- The Telegram adapter instance must provide:
  - `sendTo('<telegramInstance>', 'send', ...)`
  - The communicate states:
    - `<telegramInstance>.communicate.request`
    - `<telegramInstance>.communicate.requestChatId`
    - `<telegramInstance>.communicate.requestMessageId`
  - A `send` response that can be interpreted as a mapping `{ [chatId]: messageId }` (some adapter versions return this as JSON string or list).
- For image attachments (`attachments[].type === 'image'`), the Telegram adapter must support sending photo messages via `send` payload field `photo` (plus optional `caption`).
  - If you run an older Telegram adapter that does not support this, image attachments will not be delivered (and therefore also cannot be auto-deleted later).

### Quick start (recommended setup)

1. Create one `EngageTelegram` instance in the Message Hub Plugins tab.
2. Set `telegramInstance` to your Telegram adapter instance (example: `telegram.0`).
3. Configure filters (level range, kinds, lifecycle filter) similar to `NotifyPushover`.
4. Enable the plugin instance (`...enable`).
5. Trigger a Message Hub `due` notification and confirm:
   - a Telegram message is sent
   - action buttons appear
6. Click a button and confirm:
   - the corresponding MsgHub action is executed
   - the old Telegram message is cleaned up (buttons removed or message deleted, depending on your settings)

### How to configure

Configuration is done in the Message Hub Admin Tab (Plugins) and uses the schema from `lib/EngageTelegram/manifest.js`.

Common options:

- `telegramInstance` (string)
  - Target adapter instance (example: `telegram.0`).
- `kindsCsv` (string, CSV)
  - Filter by `message.kind` (empty = allow all).
- `levelMin` / `levelMax` (number)
  - Filter by `message.level` (inclusive).
- `audienceTagsAnyCsv` (string, CSV)
  - If set, only messages with at least one matching `audience.tags[]` entry are sent.

Telegram-specific behavior options:

- `disableNotificationUpToLevel` (number)
  - For `message.level <= disableNotificationUpToLevel`, outgoing Telegram sends use `disable_notification: true` (silent notifications).
  - Above this level, `disable_notification: false`.
- Gate options (optional):
  - `gateStateId`, `gateOp`, `gateValue`, `gateBypassFromLevel`
  - This is a **global** send/mute gate for the Telegram integration (useful for maintenance/quiet hours). It is not user-specific.
- Menu action switches (booleans, default `true`):
  - `enableAck`, `enableClose`, `enableSnooze`, `enableOpen`, `enableLink`
  - These only affect which actions are shown in the Telegram menu; the core still enforces the action allow-list via `message.actions[]`.

Commands:

- Commands are fixed to `/...` and currently only `/start` is implemented.
- The callback prefix is fixed to `opt_` (used internally for inline button callbacks).

### Best practices

- Start with a narrow filter:
  - Use `levelMin` and `kindsCsv` to reduce noise.
- Use silent notifications for low-severity messages:
  - Keep `disableNotificationUpToLevel` at `info`/`10` if you want informational messages to be quiet.
- Prefer deleting old notifications on resend:
  - The plugin always deletes the old Telegram messages for a ref before sending the new `due` notification, to keep the chat clean.

### Troubleshooting

Common symptoms and what to check:

- “No Telegram messages are sent”
  - Verify the plugin instance is enabled and running.
  - Verify your filters (especially `levelMin/levelMax`).
  - Confirm that Message Hub actually emits `due` notifications for your messages.

- “Buttons show up, but clicks do nothing”
  - Check adapter logs for `EngageTelegram.* inbound:` and `action:` debug lines.
  - Verify the message contains the action id in `message.actions[]` (it is an allow-list).

- “Text shows raw `<b>...</b>`”
  - This points to Telegram adapter parsing differences (send/edit payload shape). The plugin uses HTML and escapes input.

---

## 2) Software Documentation

### Overview

`EngageTelegram` is registered as an **engage** integration (bidirectional):

- Ingest side: handles ioBroker state changes (Telegram communicate states).
- Notify side: observes Message Hub notifications and sends Telegram messages.

Implementation:

- `lib/EngageTelegram/index.js`

### Runtime wiring (IoPlugins)

`IoPlugins` creates the instance subtree under `msghub.<instance>.EngageTelegram.<instanceId>`:

- Base object: `msghub.0.EngageTelegram.<instanceId>` (options in `object.native`)
- Enable state: `msghub.0.EngageTelegram.<instanceId>.enable`
- Status state: `msghub.0.EngageTelegram.<instanceId>.status`

The plugin subscribes to:

- `<telegramInstance>.communicate.*` (via `subscribeForeignStates`)

### Outgoing notifications (notify path)

- Dispatch event: only `event === 'due'`.
- Payload:
  - `text` uses `parse_mode: 'HTML'` and escapes `message.title`/`message.text` (treated as plain text).
  - `disable_notification` derived from `disableNotificationUpToLevel`.
  - Buttons are rendered as `reply_markup.inline_keyboard`.

### Snooze buttons and overrides

If a message contains at least one `snooze` action and `enableSnooze=true`:

- The root menu contains a `Snooze` entry which opens a snooze submenu.
- The snooze submenu offers a fixed set of durations: `1h`, `4h`, `8h`, `12h`, `24h`.
- On click, the plugin calls `ctx.api.action.execute({ ref, actionId, snoozeForMs })`.

### Incoming interactions (engage path)

Signal source:

- `<telegramInstance>.communicate.request` contains either:
  - a callback selection (inline button clicks), or
  - a user chat message
- `<telegramInstance>.communicate.requestChatId` and `requestMessageId` provide the context.

Dispatch rules:

- Callback path: payload starts with `opt_` (fixed prefix).
- Command path: payload starts with `/` (only `/start` is implemented).

### Callback mapping and internal persistence

Telegram `callback_data` has a tight length limit. The plugin uses a short id:

- Formats:
  - `opt_<shortId>:menu`
  - `opt_<shortId>:nav:<target>[:<actionId>]`
  - `opt_<shortId>:act:<actionId>[:<forMs>]`
- `<shortId>` restricted to `[A-Za-z0-9]`

Persistent state ids (JSON, read-only for users):

- `msghub.0.EngageTelegram.<instanceId>.mappingByRef`
  - Stores `{ "<ref>": { shortId, textHtml, chatMessages: { "<chatId>": <messageId> }, ... } }`
- `msghub.0.EngageTelegram.<instanceId>.mappingShortToRef`
  - Stores `{ "<shortId>": "<ref>" }`

Additional mapping state:

- `mappingByRef[ref].shouldHaveButtons` (boolean)
  - `true`: message is expected to have action buttons and may be updated by the button sync.
  - `false`: buttons have been removed and a confirmation text was shown; further sync/cleanup avoids editing the Telegram message text again (prevents confirmation races).

Cleanup:

- Resend (`due` for the same `ref` again):
  - The old Telegram message(s) for the `ref` are deleted first (always).
  - Then a new Telegram message is sent and the mapping is updated to point to the new messageId(s).
- End-of-life (`deleted` / `expired`):
  - The mapped Telegram messages are deleted (always) and the mapping is removed.
- Retention / GC:
  - Entries that no longer have buttons (`shouldHaveButtons=false`) may be pruned after a retention window (currently 90 days).

### Concurrency / locking

To avoid double execution from repeated clicks:

- Lock scope: `(shortId, chatId)`
- Timeout: 5 seconds (lock auto-releases even when execution fails).

### Related files

- Reference notifier: `lib/NotifyPushover/index.js`
- Engage wiring: `src/MsgEngage.js`
- Plugin runtime: `lib/IoPlugins.js`
- MsgHub host API (sendTo, subscribe, i18n, action): `src/MsgHostApi.js`
