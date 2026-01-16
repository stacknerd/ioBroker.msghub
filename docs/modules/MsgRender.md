# MsgRender (Message Hub): render a view from raw messages

`MsgRender` is a lightweight template renderer for Message Hub messages.
It resolves simple placeholders like `{{m.temperature}}` or `{{t.createdAt|datetime}}` and returns a rendered **view**
of `title`, `text` and selected `details` fields.

Important: `MsgRender` is **view-only**. It does not change the stored/canonical message.

---

## Where it sits in the system

Simplified flow:

1. A producer plugin creates or patches a message (usually via `MsgFactory` and `MsgStore`).
2. `MsgStore` stores the **raw** message in its canonical list (`fullList`).
3. When a consumer reads messages (`getMessages()`, `getMessageByRef()`, …), `MsgStore` returns a **rendered view**:
   - `MsgRender.renderMessage(msg)` returns the message with rendered `title`/`text`/`details` plus a view-only `display` block.
4. The rendered output is used for UI or human-facing text, but it is not written back to storage.

This keeps the persisted data stable and compact, while still allowing dynamic display text.

---

## What problem does it solve?

Some messages should show values that are only known at runtime, for example:

- “Temperature is 21.7 °C”
- “Last seen at 13:45”
- “Task started 10 minutes ago”

Instead of rebuilding the entire title/text every time, a message can contain templates, and the actual values live in:

- `msg.metrics` (a `Map` of measured values), and/or
- `msg.timing` (time-related fields like `createdAt`, `notifyAt`, `remindEvery`, `timeBudget`, …).
- `msg.details` (structured message context like `location`, `task`, `tools`, …)

`MsgRender` combines both into human-readable strings.

---

## What gets rendered?

`MsgRender` renders these fields:

- `title` from `msg.title`
- `text` from `msg.text`
- `details` from selected `msg.details` fields
- `display` (view-only) from message classification and render config

The `display` block is intended for presentation helpers (e.g. prefix tokens) and is not part of the canonical persisted message.

Only a small subset of `details` is rendered on purpose (predictability and safety):

- string fields: `details.location`, `details.task`, `details.reason`
- string entries inside arrays: `details.tools[]`, `details.consumables[]`

All other `details` keys (and non-string values) are left unchanged.

---

## Template model (what you can write inside `{{ ... }}`)

A placeholder always uses this shape:

`{{ <path> | <filter> | <filter> ... }}`

Examples:

```js
Temp is {{m.temperature}}
Created at {{t.createdAt|datetime}}
Flag: {{m.enabled|bool:on/off|default:unknown}}
```

### Paths

#### Metrics: `m.<key>`

Metrics come from `msg.metrics`, which is expected to be:

`Map<string, { val, unit?, ts? }>`

You can reference:

- `m.<key>` (default formatting, often “value + unit”)
- `m.<key>.val` (raw value)
- `m.<key>.unit` (unit string)
- `m.<key>.ts` (timestamp in Unix ms)

Examples:

```js
{{m.temperature}}      // "21.75 C" (formatted, locale-aware)
{{m.temperature.val}}  // "21.75"
{{m.temperature.unit}} // "C"
{{m.temperature.ts}}   // 1735776000000
```

Practical note: metric keys are split by `.` internally, so keep metric keys simple (avoid dots).

#### Timing: `t.<field>` (or `timing.<field>`)

Timing values come from `msg.timing` (plain object). Example fields:

- `createdAt`, `updatedAt`
- `remindEvery`, `timeBudget` (durations in ms)
- `notifyAt`, `dueAt`, `expiresAt`
- `startAt`, `endAt`

Example:

```js
{{t.createdAt}}         // raw timestamp value
{{timing.createdAt}}    // same as above
{{t.createdAt|datetime}} // formatted date/time (locale-aware)
```

#### Details: `d.<field>` (or `details.<field>`)

Details values come from `msg.details` (plain object). Common fields include:

- `location`, `task`, `reason` (strings)
- `tools`, `consumables` (arrays)

Rules:

- Scalars are returned as-is.
- Arrays are joined with `', '` (for example `{{d.tools}}`).

Examples:

```js
At {{d.location}}: {{d.task}}
Tools: {{d.tools}}
Consumables: {{details.consumables}}
```

---

## Resolution rules (important behavior)

- Every `{{ ... }}` block is replaced.
- Unknown paths resolve to an empty string (`''`).
- Filters are applied left-to-right: `{{m.temp|num:1|default:--}}`.
- Rendering is not recursive: values inserted by a placeholder are not scanned again for placeholders.

To avoid “missing value = empty output”, use `default`.

---

## Filters (formatting helpers)

Filters are small, deterministic formatting steps. They are intentionally limited.

### `raw`

For metrics, `raw` disables the default “value + unit” formatting:

```js
{{m.temperature}}     // "21.75 C"
{{m.temperature|raw}} // "21.75"
```

### `num:<digits>`

Locale-aware number formatting with a maximum number of fraction digits:

```js
{{m.humidity.val|num:1}} // e.g. "46.2" (depending on locale)
```

Works for numbers and numeric strings.

### `datetime`

Formats a Unix ms timestamp (or a numeric/date string) as a localized date/time:

```js
{{m.lastSeen.ts|datetime}}
{{t.createdAt|datetime}}
```

### `durationSince`

Formats the duration since a Unix ms timestamp (relative to server time via `Date.now()`):

- `< 1 min`: `56s`
- `< 1 h`: `34m` (rounded)
- `< 1 day`: `3:45h` (rounded)
- `>= 1 day`: `1d 4h` (rounded)

If the timestamp is in the future, the output is an empty string.

Examples:

```js
{{m.lastSeenAt|durationSince}}
{{m.lastSeenAt.val|durationSince}}
```

Practical note: for metrics, this filter implies `raw` resolution, so `{{m.lastSeenAt|durationSince}}` works even when
the metric has a unit.

### `durationUntil`

Formats the duration until a Unix ms timestamp (relative to server time via `Date.now()`).

Formatting rules are the same as `durationSince`.

If the timestamp is in the past, the output is an empty string.

Examples:

```js
{{m.nextRunAt|durationUntil}}
{{t.notifyAt|durationUntil}}
```

### `bool:trueLabel/falseLabel`

Maps common boolean inputs to two strings:

```js
{{m.flag|bool:yes/no}}
{{m.enabled|bool:on/off}}
```

Accepted inputs include booleans, numbers (`0/1`), and strings like `true/false`, `yes/no`, `y/n`.

### `default:<fallback>`

Replaces `null`, `undefined`, or `''` with a fallback string:

```js
{{m.missing|default:--}}
{{m.temperature.unit|default:(no unit)}}
```

---

## Public API (what other components call)

### `new MsgRender(adapter, { locale })`

- `adapter` is used for logging only.
- `locale` is used for `Intl.NumberFormat` and `Intl.DateTimeFormat` (default: `en-US`).

### `renderMessage(msg, { locale }): object`

Returns a **new** message object:

- original message fields are copied (shallow)
- `title`, `text`, and selected `details` fields are returned in their rendered form

### `renderMessages(messages, { locale }): Array<object>`

Returns a **new** message list:

- each entry is rendered as if by `renderMessage(msg, { locale })`
- the input list is not mutated

### `renderTemplate(input, { msg, locale }): string`

Renders a single string and resolves placeholders using `msg.metrics` + `msg.timing` + `msg.details`.
Non-strings (and strings without `{{`) are returned unchanged.

---

## Design guidelines / invariants (the key rules)

- Canonical vs. view: never mutate the input message; return a rendered view.
- No hidden state: templates are evaluated on-demand; there is no caching or compilation.
- Graceful degradation: missing metrics/timing do not throw; they resolve to empty output (use `default` if needed).
- Minimal template language: no loops, no conditions, no function calls; just paths + filters.

---

## Related files

- Implementation: `src/MsgRender.js`
- Tests / examples: `src/MsgRender.test.js`
- Where it is used (render on reads/notify): `src/MsgStore.js` and `docs/modules/MsgStore.md`
