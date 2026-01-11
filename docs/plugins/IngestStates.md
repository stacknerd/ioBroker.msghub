# IngestStates (ioBroker Objects → Custom)

`IngestStates` is a Message Hub **producer plugin** that creates and maintains MsgHub messages based on monitoring rules
configured per ioBroker object (**Objects → Custom**).

This document has two parts:

1) **User Guide** (simple language, examples, best practices)
2) **Software Documentation** (technical reference, internals, and current behavior)

---

## 1) User Guide (Rule authors / Admin users)

### What IngestStates is for

IngestStates is for “I want a message when …” monitoring on top of ioBroker datapoints.

Examples:

- “Warn me if the humidity goes outside 35–60%.”
- “Warn me if a sensor has not reported anything for 12 hours.”
- “When a valve turns on, I expect the water meter to increase within 10 minutes.”
- “My value never settles / keeps drifting for too long.”
- “Detect a session: started / ended (e.g. washing machine).”

### How it works (mental model)

- You pick a datapoint in ioBroker (**Objects**).
- You attach a rule to it in **Custom** (for your `msghub.X` instance).
- When the rule becomes true, MsgHub creates (or reuses) a message and keeps it up to date.
- When the rule becomes normal again, MsgHub can remove the message automatically (recommended) or keep it until you close it manually.

### Quick start

1. Enable `IngestStates` in MsgHub Admin Tab → **Plugins**.
2. In ioBroker Admin → **Objects**, open a datapoint and go to **Custom**.
3. Enable the **MsgHub custom config** (example: `msghub.0`).
4. In **Monitoring**, select a rule type and fill out the corresponding rule tab.
5. In **Message**, decide how the message should look and behave (title/text/audience/reminders/auto-remove…).

### Choosing the right rule type (quick decision help)

- If the problem is “too high/too low / outside a range / wrong boolean”: use **Threshold**.
- If the problem is “sensor does not report anymore”: use **Freshness**.
- If the problem is “when A is active, B must react within time X”: use **Dependency (Trigger)**.
- If the problem is “value never calms down / keeps trending for too long”: use **Non-settling**.
- If you want “started / ended” behavior: use **Session**.

### Messages: “store truth” vs “notifications”

MsgHub keeps a message in its store (so you can see the problem state), and it can also notify you.
These are related but not identical:

- A message can be **open** in the store without constantly notifying you (e.g. snoozed, cooldown, reminders off).
- A message can update silently (metrics updates) without producing notification noise.

### Actions (buttons) you can use

Actions are defined by the rule (not by a per-object “actions” setting):

- **Ack**: “I saw it.” The message stays as-is; IngestStates does not “re-open” it just because the condition is still true.
- **Snooze (4h)**: suppresses notifications for 4 hours (the message can still be updated silently).
- **Close**: offered automatically when auto-remove is disabled, so you can always get rid of a message.
- **Delete**: used only for the *session start* message (so you can permanently dismiss it during the running session).

### Shared “Message” settings (what they mean)

These settings apply to all rule types:

- **Kind / Level**
  - Kind: usually “status” (a condition) or “task” (something to do).
  - Level: notice / warning / error (how important is it).
- **Task planning (only for Kind = “task”)**
  - **Estimated time**: stores an estimate for how long the task will take.
  - **Due in**: sets a due date relative to “now” when the message is created.
- **Title / Text (optional)**
  - If you leave them empty, the rule provides a helpful default text.
  - If you provide your own text, it is used as-is.
- **Audience (optional)**
  - Tags and Channels are comma-separated lists (CSV). Use this to send different messages to different integrations/users.
- **Reminder**
  - Optional repeated notifications while the issue stays active.
  - Use this for “still broken” reminders, not for high-frequency telemetry.
- **Back to normal**
  - “Auto-remove message(s)” closes the message automatically when the condition becomes normal again.
  - Optional “Delay” helps against flapping (briefly normal → briefly bad → normal…).
- **Cooldown**
  - After a message was closed, cooldown prevents “close → instant reopen → notify again” spam.
  - Important: cooldown does not “hide valid warnings” in the store. If the condition returns during cooldown, MsgHub keeps the store truthful and delays/avoids the next notification.

Practical recommendation (good defaults to start with):

- Keep **Auto-remove** enabled for most rules.
- Use a small **Delay** (e.g. 1–5 minutes) if your source flaps.
- Use **Cooldown** if you see a lot of “close → reopen” noise.

### Location (room) auto-detection

If your datapoint is assigned to an ioBroker room (`enum.rooms.*`), IngestStates stores the room name as
`Location` in the message details. This can help notification integrations and UI grouping.

### Writing your own text (optional, advanced)

Some rule defaults (and your own texts) can include placeholders like:

- `{{m.state-value}}` (current value)
- `{{m.lastSeenAt|datetime}}` (timestamp as date/time)
- `{{m.lastSeenAt|durationSince}}` (“how long ago”)

Formatting note for `durationSince` / `durationUntil`:

- `< 1min`: `56s`
- `< 1h`: `34m` (rounded)
- `< 1 day`: `3:45h` (rounded)
- `>= 1 day`: `1d 4h` (rounded)

Tip: start with defaults. Only customize title/text once the rule behavior is correct.

---

## 1.1 Rule types (explained with examples)

### Threshold (value outside a limit/range)

Use Threshold when “the value should be inside a limit/range, otherwise alert”.

Typical use cases:

- Battery below 10%
- Humidity outside 35–60%
- Window contact is TRUE for too long (boolean)

How it behaves:

- When the value enters the “bad” area, a message appears (immediately or after an optional minimum duration).
- While active, the message stores the latest value as a metric.
- When the value returns to normal, the message is closed automatically (if enabled) or stays until you close it.

Options you will see in the Threshold tab:

- **Condition type**
  - “Too low / Too high” (single limit)
  - “Outside / Inside range” (two limits)
  - “Boolean TRUE/FALSE” (useful for contacts, switches, errors)
- **Hysteresis**
  - Adds a “buffer zone” to avoid flapping around the boundary.
  - Example (too high): alert above 50, but clear only when value goes below 48.
- **Minimum duration**
  - “Condition must stay bad for X before creating the message.”
  - This avoids short spikes.

What “back to normal” means here:

- For numeric limits/ranges, the value must cross the “safe side” again (with hysteresis, the safe side is slightly wider).
- For boolean conditions, it must become the opposite value (TRUE → FALSE, or FALSE → TRUE).

How to tune it (common patterns):

- **Flapping around a boundary** → increase hysteresis, or add a reset delay (Message tab).
- **Short spikes** → use minimum duration.
- **You want a human-friendly message** → start with defaults, then adjust title/text once you like the behavior.

Practical examples:

- Humidity outside 35–60%, hysteresis 2%: the message clears only once it is clearly back inside.
- Power above 500W for at least 5 minutes: avoids “short kettle spike” alerts.

### Freshness (no update / no change for too long)

Use Freshness when the datapoint should be “alive”, and missing updates likely mean “sensor offline” or “adapter stuck”.

Two variants:

- **No update**: alert if the datapoint did not receive any update for X.
- **No value change**: alert if the *value* did not change for X (useful when devices only report on change).

How to choose between “update” and “change”:

- If the device sends keepalives (updates even when the value stays the same) → use **No update**.
- If the device only sends values when they change → use **No value change**.
- If you are unsure: look at the datapoint’s “last update” vs “last change” timestamps in ioBroker.

How it behaves:

- IngestStates tracks the last update/change timestamp.
- When the “age” exceeds your configured threshold, a message is opened.
- When a new update/change arrives, the message is closed (if configured).

Important note:

- Freshness needs periodic evaluation. If the plugin’s global “Evaluate interval” is set to `0` (event-only),
  Freshness will not create alerts because it has no tick to compare “now vs last update”.

Examples:

- Temperature sensor: “at least one update every 12 hours”
- Heartbeat / keepalive: “at least once every 5 minutes”

### Dependency (Trigger): “When A happens, B must react”

Use this rule when one datapoint acts as a “trigger”, and another datapoint must react within a time window.

Examples:

- Valve turns ON → water meter must increase within 10 minutes
- Plug turns ON → power must become >= 5W within 30 seconds
- Heating turns ON → flow temperature must rise by at least 2°C within 15 minutes

How it behaves:

- The window starts **only when the trigger becomes active** (rising edge).
- If the trigger becomes inactive before the window ends, the timer is cancelled and no message is created.
- If the window ends and the expectation is not met, a message is opened.
- If the expectation becomes true later, the message closes via your normal “Back to normal” settings.

How to configure it (in simple terms):

- Pick the **trigger datapoint** (the one that “starts the window”).
- Decide what “trigger is active” means:
  - simplest: “trigger is truthy” (on/off, motion, enable flags)
  - advanced: “trigger equals X / greater than X / less than X”
- Choose the **time window** (how long you give the system to react).
- Choose the **expected reaction** of the monitored datapoint:
  - “it changed” (value change)
  - “it increased/decreased by at least …”
  - “it reached at least / at most …”

Common pitfalls:

- If you choose “greater/less than”, the trigger value must be numeric (strings like `"12"` still work; non-numeric does not).
- Choose a window that matches real-world latency (slow devices and adapter schedules can easily need minutes).

Example (valve → meter):

- Trigger datapoint: `valveState`
- Trigger active: “truthy”
- Window: `10 minutes`
- Expectation: “increased by at least 1” (delta up)

If the valve turns on, but the meter does not move within 10 minutes, you get a message.
When the meter finally moves, the message can close automatically (if auto-remove is enabled).

### Non-settling value (never stable / unexpected trend)

Use this when the problem is not “too high/low”, but “the value behaves oddly for a long time”.

There are two profiles:

#### Profile “Activity” (never becomes stable)

Use when the value keeps moving/fluctuating and never reaches a stable phase.

You control:

- What counts as a relevant change (minimum delta)
- How long continuous activity is tolerated (max continuous)
- How long it must stay “quiet” to be considered stable (quiet gap)

The message is opened when the value has been continuously “not stable” for longer than the max duration.
The message is cleared when the value becomes stable again (quiet phase long enough).

Example (activity):

- Datapoint: `humidity`
- Minimum delta: `1` (ignore tiny noise)
- Quiet gap: `10 min` (must be calm for 10 min to count as stable)
- Max continuous: `6 h` (alert if it never calms down for 6 hours)

How to tune:

- If you get alerts too early → increase max continuous.
- If it never clears even though it looks stable → increase quiet gap or increase minimum delta (noise).

#### Profile “Trend” (keeps rising or falling)

Use when the value keeps moving in one direction for too long.

You control:

- Direction (up / down / any)
- How long the trend must persist (trend window)
- How much total movement must happen before it counts (minimum total delta)

Tip:

- If “no more updates” should be treated as a problem, combine this rule with **Freshness** (they solve different problems).

Example (trend):

- Datapoint: `waterMeter`
- Direction: `up`
- Trend window: `30 min`
- Minimum delta: `0.1` (ignore tiny counter wobble)
- Minimum total delta: `5` (alert only if there was meaningful movement)

Important note:

- This rule clears based on new incoming values (a “broken trend”), not based on silence. If the device stops reporting,
  the rule does not treat that as “back to normal” (use Freshness for missing updates).

### Session (Start/Stop): “Detect a run and summarize”

Use Session when you want a start/end message for a process that can be detected from a “power” datapoint.

Typical examples:

- Washing machine / dishwasher cycle
- Pump run
- Heating cycle (with a power threshold)

How it behaves:

- Start: power rises above the start threshold (optionally must stay above it for a minimum hold time).
- End: power falls below the stop threshold (optionally must stay below it for a stop delay).
- Optional gate: a separate on/off datapoint can enable/disable monitoring; switching the gate off ends a running session.
- Optional counter + price datapoints can be used to calculate session consumption/cost metrics.

Options you will see in the Session tab:

- **Gate (optional)**
  - Lets you “enable/disable” monitoring from another datapoint (e.g. a mode switch).
  - If the gate turns off during a running session, the session ends.
- **Start threshold + start hold (optional)**
  - The value must rise above the threshold to be considered “started”.
  - Start hold requires it to stay above the threshold for a minimum time (debounce).
- **Stop threshold + stop delay (optional)**
  - The value must fall below the threshold to be considered “ended”.
  - Stop delay requires it to stay below the threshold for a minimum time (debounce).
- **Cancel stop when value rises again**
  - Prevents false “end” detections when the value briefly dips below the stop threshold.
- **Energy counter + price (optional)**
  - Lets MsgHub compute “consumed” and “cost” metrics for the end message.
  - Units are taken from the datapoints themselves (could be anything, not just kWh / €).

Messages:

- End message: always created on session end.
- Optional start message: can be created when the session begins.
  - When the end message is created, the start message is soft-deleted (removed), not closed.
  - When a new session starts, the previous end message is closed (cause eliminated) so it does not stay around forever.

Where to configure the start message:

- In the **Message** tab, enable “Create start message” and fill out the separate start-message fields (title/text/audience/etc.).

Example (washing machine):

- Power datapoint: starts above `10 W`, ends below `3 W`
- Start hold: `1 min` (avoid short bumps)
- Stop delay: `10 min` (avoid “pause” ending the session)
- Optional counter datapoint: energy meter
- Optional price datapoint: price per unit

---

## 1.2 Troubleshooting (common issues)

- “Nothing happens”
  - Verify the `IngestStates` plugin instance is enabled and running.
  - Verify the object has the MsgHub custom config enabled (Objects → Custom).
  - Verify the “Monitoring” rule type is selected and the rule is enabled.
  - If you use Freshness: make sure the plugin’s “Evaluate interval” is not `0`.
- “My rule tabs are hidden”
  - The object might be marked as “managed” by another source. In that case, MsgHub hides manual rules.
  - Exception: if `managedBy` contains `IngestStates.<instanceId>`, the UI stays visible for editing.
- “Threshold never triggers”
  - Ensure the datapoint value is numeric (strings like `"42"` are okay; non-numeric strings are ignored).
- “It triggered once and never went away”
  - Check “Back to normal” settings. If auto-remove is disabled, you must close manually.
  - If you configured a reset delay: keep a non-zero evaluate interval so restart-safe closing can run.
- “I see a lot of ‘close → reopen’ noise”
  - Add a reset delay (Back to normal) and/or enable cooldown.
  - Consider hysteresis / minimum duration for Threshold rules.
- “It reopened, but I did not get a notification”
  - That is expected during cooldown: the store becomes open again, but notifications can be delayed/suppressed.

---

## 2) Software Documentation (Technical reference)

### Overview

- Plugin type: `IngestStates` (family: `Ingest`)
- Entry point: `lib/IngestStates/index.js`
- Engine / RuleHost: `lib/IngestStates/Engine.js`
- MessageWriter: `lib/IngestStates/MessageWriter.js`
- Persistent timers: `lib/IngestStates/TimerService.js`
- Rules: `lib/IngestStates/rules/*.js`
- Custom UI schema: `admin/jsonCustom.json`
- Plugin options schema: `lib/IngestStates/manifest.js`

### Design decisions (current behavior)

- One monitored target → one rule instance (keeps rule logic local and testable).
- Actions are rule-defined (hard-coded per rule); there is no per-object “action policy” UI.
- `acked` / `snoozed` are treated as active lifecycle states:
  - the plugin keeps metrics up to date
  - it does not override user intent by forcing “open” again
- Flapping protection uses “silent reopen” semantics:
  - warnings are not dropped
  - the store stays truthful
  - notifications are delayed/avoided during cooldown
- Timers:
  - rules that need restart-safe timing before a message exists use `TimerService` (`…IngestStates.<id>.timers`)
  - delayed close uses metrics-based persistence (MessageWriter), not TimerService

### Plugin instance options (`manifest.js`)

- `rescanIntervalMs`: polling interval for `system/custom` discovery (`0` disables polling).
- `evaluateIntervalMs`: rule tick interval (`0` means event-only, where possible).
- `metricsMaxIntervalMs`: throttling for silent metrics patches while a message is active (`0` disables metrics patching).
- `traceEvents`: verbose debug logging (rule discovery/creation, bootstrap state snapshots, timer scheduling, MessageWriter store operations).

### Custom config discovery and normalization (Engine)

Discovery:

- The engine scans ioBroker `system/custom` via `getObjectView('system', 'custom', {})`.
- Only objects with `common.custom.<namespace>` (e.g. `common.custom.msghub.0`) are considered.

Normalization:

- The engine expects flat keys (e.g. `"msg-title"`, `"thr-mode"`). Nested objects and dot keys are ignored.
- Invalid configs are ignored rule-by-rule (best-effort) with a warning; there is no global failure.

Subscriptions:

- The engine subscribes to all required foreign states returned by rule instances.
- It also subscribes to foreign objects of configured targets so config edits trigger a rescan.

Routing:

- State changes are routed to the rule instances that declared the state id as required.
- Optional periodic ticks (`evaluateIntervalMs`) call `rule.onTick(now)`.

### Rule instance contract

Each rule instance is created with:

- `targetId` (monitored state id)
- `ruleConfig` (rule block)
- `message` (TargetMessageWriter for this target)
- optional `timers` (TimerService) for restart-safe timers

And implements:

- `requiredStateIds(): Set<string>`
- `onStateChange(id, state)`
- `onTick(nowMs)`
- optional `onTimer(timer)` for persistent timers
- `dispose()`

### Persistent timers (TimerService)

Some behaviors must work without an existing message and must survive restarts (e.g. Threshold minDuration windows).
For that, `TimerService` persists timers in an internal ioBroker state:

- `msghub.<instance>.IngestStates.<pluginInstanceId>.timers` (role `json`, read-only for users)

Stored JSON shape:

```json
{ "schemaVersion": 1, "timers": { "<id>": { "at": 1730000000000, "kind": "…", "data": { "targetId": "…" } } } }
```

Timers are re-scheduled in memory on startup; very long timeouts are clamped to Node.js safe limits.

### MessageWriter (TargetMessageWriter)

The MessageWriter is rule-agnostic. Rules provide:

- default title/text (translated via `ctx.api.i18n.t(...)`)
- actions allowed for the rule
- metrics to write

The writer provides:

- stable message `ref` generation:
  - end/default: `IngestStates.<instanceId>.<ruleType>.<targetId>`
  - session start: same + `_start`
- message creation and updates via `ctx.api.factory.createMessage` + `ctx.api.store.*`
- audience parsing (CSV tags/channels)
- reminder scheduling via `timing.remindEvery`
- cooldown logic on reopen (delay/avoid notifications but keep store truthful)
- task timing mappings (only for `kind="task"`):
  - `msg-taskTimeBudget*` → `timing.timeBudget` (duration in ms)
  - `msg-taskDueIn*` → `timing.dueAt` (timestamp = now + duration)
  - `dueAt` is set when a message is created/reopened and is not shifted on updates (filled if missing)
- auto-close on recovery via `msg-resetOnNormal`
- metrics patching:
  - change detection + throttling (`metricsMaxIntervalMs`)
  - separate throttling for session start vs end messages
  - throttling is in-memory (restart resets the throttle window)

Title/text resolution:

- If the user configured a custom title/text, it overrides the rule defaults.
- If the user left a field empty, the rule default is used.
- The writer requires both title and text to be present after merging (otherwise it throws; rules must provide defaults).

Lifecycle “active” semantics:

- The writer treats `open`, `acked`, and `snoozed` as active.
- It does not override user intent by “re-opening” acked/snoozed messages.

Actions:

- If `resetOnNormal=false`, the writer injects a `close` action (so the message is always dismissible).

Details / location:

- `details.location` is set best-effort from `enum.rooms.*` memberships (prefix match on the target id).
- The writer merges `details` patches with existing details so it does not drop other fields.

Cooldown semantics (reopen shortly after close):

- If a message was closed and the condition becomes active again within cooldown:
  - the message is made lifecycle-active again (store stays truthful)
  - notification scheduling is delayed/avoided by pushing `timing.notifyAt` into the future
  - if reminders are disabled, `notifyAt` is pushed far into the future (no immediate notification)

Origin/lifecycle:

- `origin`: `{ type: automation, system: 'ioBroker', id: <targetId> }`
- `lifecycle.stateChangedBy`: plugin regId (best-effort), so operator actions are attributable.

### Message identity (stable refs)

The plugin uses stable message references so it can update the same message over time:

- Default/end message ref:
  - `IngestStates.<instanceId>.<ruleType>.<targetId>`
- Session start message ref:
  - same + `_start`

Notes:

- The “ref string” above is the conceptual stable id; MsgHub normalizes it internally where needed.
- Session uses two distinct messages intentionally (start and end semantics are different).

### Managed objects reporting (Engine)

The engine reports configured targets as “managed”:

- It calls `ctx.meta.managedObjects.report(targetId, { managedText })` during scan.
- It calls `ctx.meta.managedObjects.applyReported()` after the scan.

Admin UI integration:

- The Custom UI hides manual rules for objects that are managed by another source.
- Exception: if the object is managed by `IngestStates.<instanceId>`, the UI keeps the IngestStates tabs visible so you can still edit the rule.

### Reset-delay persistence (MessageWriter)

Problem:

- If you use a reset delay (“close X minutes after it becomes normal”), an in-memory timer would be lost on restart.

Solution:

- The scheduled close timestamp is persisted in `message.metrics` under an internal key.
- Rules call `tryCloseScheduled({ now })` on ticks when they are in a “normal” phase.

Internal key:

- `IngestStates.<instanceId>.<ruleType>.<targetId>.resetAt`

Scope:

- This persistence is used for the default/end message.
- The session start message is intentionally handled differently (it is removed by the Session rule, not auto-closed).

Caveat:

- If you set the plugin’s global “Evaluate interval” to `0` (event-only), restart-safe delayed close checks might not run.
  (It will still close while running due to the in-memory timer; the caveat matters mainly across restarts.)

### Metrics patching policy (MessageWriter)

Metrics patches are intentionally silent and throttled:

- Only writes when values actually changed (value + unit comparison).
- Throttles by `metricsMaxIntervalMs` (plugin option), clamped to a minimum of 5s and a maximum of 3h.
- Throttling is in-memory (restart resets the throttle window).
- Applies only while the message is lifecycle-active (open/acked/snoozed).

### Rule details (technical)

#### Freshness (`mode=freshness`, config block `fresh-*`)

- `evaluateBy`: `ts` (update) or `lc` (change)
- Threshold: `everyValue` × `everyUnit` seconds
- Opens when `now - lastSeenAt > thresholdMs`
- Metric:
  - `lastSeenAt`: `{ val: <ms>, unit: 'ms', ts: <now> }`

State timestamps:

- ioBroker `ts` changes on every write/update.
- ioBroker `lc` changes only when the value actually changes.

Bootstrap:

- If the rule has not seen any event yet, it tries to fetch the current foreign state once to initialize `lastSeenAt`.
- If the state is missing/unreadable, it waits until it receives a valid update/change timestamp.

Note: Freshness relies on periodic ticks.

#### Threshold (`mode=threshold`, config block `thr-*`)

Modes:

- `lt` / `gt`: single boundary (`thr-value`)
- `outside` / `inside`: range (`thr-min`, `thr-max`)
- `truthy` / `falsy`: boolean interpretation of the value

Parsing:

- Numeric strings are coerced via `Number(val.trim())`.
- Non-numeric values are ignored (no condition update).

Hysteresis:

- Implemented via different “active” and “ok” regions.
- Some combinations can be nonsensical (e.g. range too small for hysteresis); treated as user error but evaluated safely.

Minimum duration (`thr-minDuration*`):

- Delays **message creation** until the condition has been active continuously for the configured duration.
- Implemented via persistent timers (`TimerService`) so it survives restarts and works with event-only evaluation.

Timer details:

- Timer id: `thr:<targetId>`
- Kind: `threshold.minDuration`
- The timer is started when the condition becomes active and the message does not exist yet.
- If the condition becomes normal before the timer fires, the timer is cancelled.

Metrics:

- `state-value`: `{ val: <current>, unit: <object.common.unit>, ts: <now> }`
- `state-min`: recovery lower bound (includes hysteresis when configured)
- `state-max`: recovery upper bound (includes hysteresis when configured)

Actions:

- The Threshold rule provides `ack` and `snooze (4h)`.
- If auto-remove is disabled, the MessageWriter injects `close` so the message remains dismissible.

#### Triggered (`mode=triggered`, config block `trg-*`)

Trigger activation:

- Trigger defined by `trg-id` + operator/type/value.
- Window starts only on rising edge (inactive → active).

Operator/value matching:

- Operator: `truthy|falsy|eq|neq|gt|lt`
- Value type: `boolean|number|string`
- Compare value comes from the matching config field (`valueBool|valueNumber|valueString`) and is validated on startup.

Window and expectation:

- Window duration: `trg-windowValue` × `trg-windowUnit` seconds.
- Expectation (`trg-expectation`):
  - `changed`: uses `lc` baseline (value change)
  - `deltaUp` / `deltaDown`: numeric delta vs baseline
  - `thresholdGte` / `thresholdLte`: numeric threshold

Persistent timers:

- Window timer stored via `TimerService` (kind `triggered.window`).
- Ensures correct behavior even with `evaluateIntervalMs=0`.

Timer details:

- Timer id: `trg:<targetId>`
- Kind: `triggered.window`
- Timer payload contains the window start timestamp and baseline (best-effort), so restarts keep semantics stable.

Baselines:

- For “changed”, the baseline is `lc` at window start.
- For numeric expectations, the baseline is the parsed numeric value at window start.
- If baseline is missing at window start, the rule tries to fetch the target state once to populate it.

Metrics:

- `state-value`: target current value (best-effort normalized)
- `trigger-value`: trigger current value

#### NonSettling (`mode=nonSettling`, config block `nonset-*`)

Profiles:

- `activity`:
  - `minDelta`: what counts as meaningful change
  - `maxContinuous*`: how long continuous activity is tolerated
  - `quietGap*`: how long the value must remain within minDelta to be considered stable (recovery)
- `trend`:
  - `minDelta`: minimum step size to determine/break a direction
  - `direction`: `up|down|any`
  - `trendWindow*`: how long a trend must persist before alerting
  - `minTotalDelta`: required `max-min` before alerting

Persistent timers:

- An “open” timer is stored via `TimerService` (kind `nonSettling.<profile>.open`) to survive restarts.

Timer details:

- Timer id: `ns:<targetId>:open:<profile>`
- Kind: `nonSettling.activity.open` or `nonSettling.trend.open`
- Timer payload stores the start timestamp and min/max bounds collected so far.

Metrics (trend and activity reuse the same keys):

- `state-value`
- `trendStartedAt`, `trendStartValue`, `trendMin`, `trendMax`, `trendMinToMax`, `trendDir`

#### Session (`mode=session`, config block `sess-*`)

Inputs:

- Power datapoint: `targetId`
- Optional gate: `sess-onOffId` (+ gate logic)
- Optional energy counter: `sess-energyCounterId`
- Optional price-per-unit: `sess-pricePerKwhId`

Start/stop detection:

- Start: above `sess-startThreshold` (optional hold: `sess-startMinHold*`)
- Stop: below `sess-stopThreshold` (optional delay: `sess-stopDelay*`)
- Optional: `sess-cancelStopIfAboveStopThreshold` cancels a pending stop timer when power rises again
- Gate off ends the session immediately

Messages:

- Start message ref suffix `_start` (optional via `msg-sessionStartEnabled`)
- End message ref (always)
- Start message is soft-deleted when the end message is created
- Previous end message is closed when a new session starts

Persistent timers:

- `session.startHold`, `session.stopDelay`, and a far-future `session.active` marker.

Timer details:

- Start-hold timer id: `sess:startHold:<targetId>` (kind `session.startHold`)
- Stop-delay timer id: `sess:stopDelay:<targetId>` (kind `session.stopDelay`)
- Active marker id: `sess:active:<targetId>` (kind `session.active`)
  - Stored as a far-future due timestamp so it survives restarts and acts like durable state.

Metrics:

- `session-start`, `session-startval`, `session-counter`, `session-cost`

---

### Config key reference (UI → stored config)

This section is for developers/power users. It maps the Admin “Custom” UI fields to the stored config keys under
`common.custom.<namespace>` (example: `common.custom.msghub.0`).

General:

- `enabled` (boolean): rule enabled/disabled
- `mode` (string): `threshold|freshness|triggered|nonSettling|session`

Message settings (`msg-*`):

- `msg-kind`: `status|task`
- `msg-level`: `0|10|20|30` (none/notice/warning/error)
- `msg-title`, `msg-text`
- `msg-consumables` (CSV)
- `msg-tools` (CSV)
- `msg-reason`, `msg-task`
- `msg-audienceTags`, `msg-audienceChannels` (CSV strings)
- `msg-remindValue`, `msg-remindUnit` (seconds per unit)
- `msg-resetOnNormal`
- `msg-cooldownValue`, `msg-cooldownUnit` (seconds per unit)

Session start message settings (`msg-sessionStart*`):

- `msg-sessionStartEnabled`
- `msg-sessionStartKind`, `msg-sessionStartLevel`, `msg-sessionStartTitle`, `msg-sessionStartText`
- `msg-sessionStartAudienceTags`, `msg-sessionStartAudienceChannels`

Freshness (`fresh-*`):

- `fresh-everyValue`, `fresh-everyUnit` (seconds per unit)
- `fresh-evaluateBy`: `ts|lc`

Threshold (`thr-*`):

- `thr-mode`: `lt|gt|outside|inside|truthy|falsy`
- `thr-value` (for `lt|gt`)
- `thr-min`, `thr-max` (for `outside|inside`)
- `thr-hysteresis`
- `thr-minDurationValue`, `thr-minDurationUnit` (seconds per unit)

Triggered (`trg-*`):

- `trg-id` (trigger state id)
- `trg-operator`: `eq|neq|gt|lt|truthy|falsy`
- `trg-valueType`: `boolean|number|string`
- compare values (depending on valueType): `trg-valueBool|trg-valueNumber|trg-valueString`
- `trg-windowValue`, `trg-windowUnit` (seconds per unit)
- `trg-expectation`: `changed|deltaUp|deltaDown|thresholdGte|thresholdLte`
- `trg-minDelta` (delta expectations)
- `trg-threshold` (threshold expectations)

NonSettling (`nonset-*`):

- `nonset-profile`: `activity|trend`
- `nonset-minDelta`
- activity-only: `nonset-maxContinuousValue`, `nonset-maxContinuousUnit`, `nonset-quietGapValue`, `nonset-quietGapUnit`
- trend-only: `nonset-direction`, `nonset-trendWindowValue`, `nonset-trendWindowUnit`, `nonset-minTotalDelta`

Session (`sess-*`):

- gate: `sess-onOffId`, `sess-onOffActive` (`truthy|falsy|eq`), `sess-onOffValue` (string compare value for `eq`)
- power thresholds: `sess-startThreshold`, `sess-stopThreshold`
- debounce: `sess-startMinHoldValue`, `sess-startMinHoldUnit`, `sess-stopDelayValue`, `sess-stopDelayUnit`
- stop canceling: `sess-cancelStopIfAboveStopThreshold`
- optional metrics inputs: `sess-energyCounterId`, `sess-pricePerKwhId`

---

## Implementation status (current)

- Engine: scan + rescan debounce + subscriptions + routing + managedObjects reporting
- Rules implemented end-to-end: `freshness`, `threshold`, `triggered`, `nonSettling`, `session`
- MessageWriter: audience parsing, open/update/reopen (cooldown), reminders, actions policy, reset-delay persistence, metrics patching
- Timers: persistent registry state (`...IngestStates.<id>.timers`)
