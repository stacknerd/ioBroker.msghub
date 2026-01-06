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
- Renders message actions as Telegram **inline buttons**.
- Handles button clicks and executes the corresponding Message Hub action (`ack/close/delete/snooze`) by allow-list (`message.actions[]`).
- Provides a minimal command entry point:
  - `/start` replies with a short help message.

### What it intentionally does not do (today)

- It does not send Telegram messages for `added` / `updated` events (only `due`, plus cleanup on `deleted/expired`).
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
- `lifecycleStatesCsv` (string, CSV)
  - Filter by `message.lifecycle.state` (empty = allow all).
- `audienceTagsAnyCsv` (string, CSV)
  - If set, only messages with at least one matching `audience.tags[]` entry are sent.

Telegram-specific behavior options:

- `disableNotificationUpToLevel` (number)
  - For `message.level <= disableNotificationUpToLevel`, outgoing Telegram sends use `disable_notification: true` (silent notifications).
  - Above this level, `disable_notification: false`.
- `deleteOldNotificationOnResend` (boolean, default `true`)
  - When a new notification for the same `message.ref` is sent:
    - `true`: delete the previous Telegram message via `deleteMessage`
    - `false`: keep the previous message, but remove its buttons via `editMessageText`

Icons:

- Kind icons (title prefix): `iconTask`, `iconStatus`, `iconAppointment`, `iconShoppinglist`, `iconInventorylist`
- Level icons (title prefix): `iconNone`, `iconNotice`, `iconWarning`, `iconError`

Commands:

- Commands are fixed to `/...` and currently only `/start` is implemented.
- The callback prefix is fixed to `opt_` (used internally for inline button callbacks).

### Best practices

- Start with a narrow filter:
  - Use `levelMin` and `kindsCsv` to reduce noise.
- Use silent notifications for low-severity messages:
  - Keep `disableNotificationUpToLevel` at `notice`/`10` if you want informational messages to be quiet.
- Prefer deleting old notifications on resend:
  - `deleteOldNotificationOnResend=true` keeps the chat clean when the same message is re-notified.

### Troubleshooting

Common symptoms and what to check:

- “No Telegram messages are sent”
  - Verify the plugin instance is enabled and running.
  - Verify your filters (especially `levelMin/levelMax` and `lifecycleStatesCsv`).
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

If a message contains at least one `snooze` action:

- The plugin renders exactly three snooze buttons in a dedicated keyboard row.
- It uses the default duration from `actions[].payload.snooze.forMs` when present.
  - If missing/invalid, the default set is `1h`, `4h`, `8h`.
  - If present, the set is derived to always include `1h`, the default, and one “next” duration (example: default `3h` -> `1h/3h/4h`).
- Button callback_data encodes the override duration:
  - `opt_<shortId>:<actionId>:<forMs>`
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

- Format: `opt_<shortId>:<actionId>[:<arg>]`
- `<shortId>` restricted to `[A-Za-z0-9]`

Persistent state ids (JSON, read-only for users):

- `msghub.0.EngageTelegram.<instanceId>.mappingByRef`
  - Stores `{ "<ref>": { shortId, textHtml, chatMessages: { "<chatId>": <messageId> }, ... } }`
- `msghub.0.EngageTelegram.<instanceId>.mappingShortToRef`
  - Stores `{ "<shortId>": "<ref>" }`

Cleanup:

- Before sending a new notification for the same `ref`, the old Telegram message(s) are cleaned up and the mapping is removed.
- On `deleted` / `expired` notifications, mapped messages are also cleaned up.
- Cleanup mode is controlled by `deleteOldNotificationOnResend`:
  - delete message (`deleteMessage`) or remove buttons (`editMessageText`).

### Concurrency / locking

To avoid double execution from repeated clicks:

- Lock scope: `(shortId, chatId)`
- Timeout: 5 seconds (lock auto-releases even when execution fails).

### Related files

- Reference notifier: `lib/NotifyPushover/index.js`
- Engage wiring: `src/MsgEngage.js`
- Plugin runtime: `lib/IoPlugins.js`
- MsgHub host API (sendTo, subscribe, i18n, action): `src/MsgHostApi.js`
