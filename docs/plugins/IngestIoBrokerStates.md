# Producer: ioBroker States

This document describes a proposed **producer** inside `ioBroker.msghub` that turns ioBroker state behavior into normalized Message Hub messages.

The goal is to make “health checks”, “expectations”, “correlations”, and “process/session detection” configurable **per datapoint** using ioBroker **Custom settings** (`admin/jsonCustom.json`), while keeping Message Hub itself a clean message/notification hub.

Status: infrastructure implemented (scan + subscriptions + change logging); rule evaluation is still WIP.

---

## 1. Where this fits in Message Hub (`msghub`)

Message Hub (`msghub`) already provides:

- a normalized, validated message model (`src/MsgFactory.js`)
- constants for level/kind (`src/MsgConstants.js`)
- storage + updates by stable `ref` (`src/MsgStore.js`, etc.)
- output plugins (e.g., `lib/NotifyIoBrokerStates/index.js` writes notifications to states)

This producer is an **input side** component:

- it subscribes to a set of ioBroker states
- evaluates rules
- creates/updates/removes Message Hub messages

---

## 2. ioBroker timestamps: `ts` vs `lc`

ioBroker states provide two relevant timestamps:

- `ts` (last update): changes on every write (even if the value stays the same)
- `lc` (last change): changes only on real value changes

Choosing the wrong timestamp is a common source of false positives:

- devices with keepalives → use `ts`
- devices that only send on change → use `lc`

Therefore, the UI provides:

- `fresh.evaluateBy = "ts" | "lc"` (only for the “Freshness / Heartbeat” rule)

---

## 3. Configuration (Customs)

Rules are configured per datapoint in ioBroker’s “Objects → Custom” UI.

- UI schema: `admin/jsonCustom.json`
- stored on objects in `common.custom` under the adapter instance key

The producer currently:

1. scans `system/custom` (`getObjectViewAsync('system','custom',{})`) to find objects with msghub custom settings
2. subscribes to those objects to log custom changes (`objectChange`)
3. subscribes only to required states (target state + dependencies)
4. periodically rescans to discover newly added customs (polling)

Current implementation entry:

- `lib/IngestIoBrokerStates/index.js`
- `lib/IngestIoBrokerStates/Engine.js`

---

## 4. General message strategy (anti-spam)

To keep Message Hub usable, the producer must avoid flooding.

### Stable `ref` and updates

Each rule should map to a stable message reference, e.g.:

- `ref = "iob:<objectId>:<ruleType>[:<refSuffix>]"` (exact format is implementation detail)

When the same issue persists, the producer should **update** the existing message instead of creating new ones.

### Cooldown / reminders

- Cooldown: suppress repeated messages for the same active issue (`msg.cooldownValue` + `msg.cooldownUnit`).
- Reminders: optional periodic “still broken” pings (`msg.remindValue` + `msg.remindUnit`, `0 = off`).

### Resolution handling

When an issue is resolved, the producer should:

- update the message to indicate recovery and/or
- set `expiresAt` so it disappears automatically and/or
- explicitly remove/close it (depending on Message Hub semantics you choose)

UI hint:

- `msg.resetOnNormal`: auto-close when normal again
- `msg.resetDelayValue` + `msg.resetDelayUnit`: optional delay before auto-close

---

## 5. Rule types

All rules share:

- `mode` (selects rule type)
- message settings (`msg.*`)

### 5.1 Rule 1 — Freshness / Heartbeat

**Purpose:** detect missing updates (sensor offline/defect).

**UI fields**

- `fresh.everyValue`, `fresh.everyUnit`: maximum expected gap between updates/changes

**Intended behavior**

- if `now - last(ts|lc) > every` → violation message (level configurable)
- when updates resume → resolve the message

**Example**

Temperature sensor:

- every: 12 hours
- evaluateBy: `lc` (if it only sends on change) or `ts` (if it sends keepalives)

---

### 5.2 Rule 2 — Triggered expectation (dependency / cause→effect)

**Purpose:** “If trigger A is active, then target B must react within a window.”

Examples:

- valve ON → water meter must increase within 10 minutes
- plug ON → power must rise above 5 W within 30 seconds

**UI fields**

Trigger definition:

- `trg.id`: trigger state id
- `trg.operator`: `eq|neq|gt|lt|truthy|falsy`
- `trg.valueType`: `boolean|number|string` (not used for truthy/falsy)
- `trg.valueBool|trg.valueNumber|trg.valueString`: comparison value

Window:

- `trg.windowValue`, `trg.windowUnit`

Expectation on the monitored datapoint:

- `trg.expectation`: `changed|deltaUp|deltaDown|thresholdGte|thresholdLte`
- `trg.minDelta`: for delta expectations
- `trg.threshold`: for threshold expectations

**Intended behavior**

1. When trigger becomes active → arm a time window and store baseline
2. If expectation satisfied inside the window → considered OK (usually no message)
3. If window expires without satisfaction → violation message
4. When trigger becomes inactive → disarm (and optionally resolve any active violation)

**Key pitfalls & mitigations**

- measurement latency: use larger windows and/or grace times
- coarse counters: use `minDelta` and avoid tiny thresholds

---

### 5.3 Rule 3 — Non-settling / continuous activity (anomaly)

**Purpose:** detect values that “do not settle” or show suspicious long-running trends.

Examples:

- water meter increases continuously for hours → possible leak
- a value fluctuates continuously without a quiet phase → suspicious behavior

**UI fields**

Profile selection:

- `ns.profile`: `activity` or `trend`
- `ns.minDelta`: ignore noise smaller than this delta (0 = any change counts)

Activity profile (no quiet gap):

- `ns.maxContinuousValue`, `ns.maxContinuousUnit`: max duration without settling
- `ns.quietGapValue`, `ns.quietGapUnit`: duration that counts as “settled”

Trend profile (leak-like):

- `ns.direction`: `up|down|any`
- `ns.trendWindowValue`, `ns.trendWindowUnit`
- `ns.minTotalDelta`: optional minimum overall movement inside window

**Intended behavior**

The rule maintains a small history/state machine, e.g.:

- track “last significant change” timestamps (significant = delta >= minDelta)
- detect whether there is a quiet gap long enough to consider it settled
- for trend: evaluate monotonic direction and total delta over a window

This rule strongly benefits from persistence across restarts (at least the last known timestamps / baselines).

---

### 5.4 Rule 4 — Session / process detection (Start/Stop)

**Purpose:** detect that a consumer process started and later finished, based on power (and optionally an energy counter).

This rule maps directly to scripts like:

- “charging started when power >= 50 W”
- “charging finished when power < 15 W for 5 minutes”
- optionally compute kWh consumed and € cost

**UI fields**

Inputs:

- (power): the configured object itself is treated as power (W)
- `sess.onOffId` (optional): gate state
- `sess.onOffActive`: `truthy|falsy|eq`
- `sess.onOffValue`: value for `eq`

Start detection:

- `sess.startThreshold` (W)
- `sess.startMinHoldValue`, `sess.startMinHoldUnit` (optional debounce; 0 = immediate)

Stop/finish detection:

- `sess.stopThreshold` (W)
- `sess.stopDelayValue`, `sess.stopDelayUnit` (finish only if below threshold for this duration)
- `sess.cancelStopIfAboveStopThreshold` (boolean): abort finish timer when power rises again

Optional summary:

- `sess.energyCounterId` (kWh): store start value and compute delta on finish
- `sess.pricePerKwhId` (€/kWh): optional cost computation
- `sess.roundDigits`: rounding for presentation

**Intended behavior**

This is a small state machine:

- `idle`
  - when power crosses above start threshold (and gate is active) → `running`
  - store `startedAt` and optional `counterStart`
- `running`
  - when power falls below stop threshold → arm finish timer → `stopping`
- `stopping`
  - if power rises above stop threshold and cancel option is enabled → cancel timer → back to `running`
  - if timer expires → `finished`:
    - read optional counterStop, compute kWh and cost
    - update/close message(s)
    - go back to `idle`

**Message lifecycle suggestion**

To avoid clutter:

- create/update a single message on session start (stable `ref`)
- update the same message on finish with a summary and set `expiresAt` (or mark resolved)

**Example (charger)**

- startThreshold = 50 W
- stopThreshold = 15 W
- stopDelay = 5 min
- energyCounterId = `...Stromzaehler` (kWh)
- pricePerKwhId = `...PreisProEinheit`

---

### 5.5 Rule 5 — Threshold warning (low/high/out of range)

**Purpose:** warn when a value falls below/above a threshold or leaves a defined range.

Typical examples:

- battery level < 10%
- tank level > 5000 L
- humidity < 35% (as notice/info)

**UI fields**

Mode:

- `thr.mode`: `lt|gt|outside|inside|truthy|falsy`

Threshold values:

- `thr.value` (number): used for `lt/gt`
- `thr.min` / `thr.max` (number): used for `inside/outside`
 
Note:

- `thr.value` is used for `lt/gt` (there is no `lte/gte` mode in the current UI).

Anti-flap controls:

- `thr.hysteresis` (number): widen the recovery band to avoid oscillation around the boundary
- `thr.minDurationValue` + `thr.minDurationUnit`: condition must hold for this duration before triggering (debounce)

Resolution behavior:

- `msg.resetOnNormal` (boolean): when the value returns to normal, mark the message as resolved/expired

**Intended behavior**

This rule compares the **current value** (numeric) to the configured condition.

1. Detect violation:
   - evaluate `thr.mode` against current value
   - optional debounce: only violate if the condition stays true for `minDuration`
2. Create/update a stable message `ref` for the violation.
3. Recovery:
   - apply hysteresis to decide when the system is “back to normal”
   - if `msg.resetOnNormal` is enabled, resolve/expire the message when normal again

**Notes**

- Threshold rules evaluate on updates of the monitored state; there is no separate `evaluateBy` option in the current UI.
- Hysteresis is strongly recommended for noisy sensor signals.

---

## 6. UI implementation notes

The UI is provided by `admin/jsonCustom.json` and uses `hidden` expressions to show only relevant fields.

Because json-config stores dotted attributes as nested objects, conditions should prefer:

- `data.ns.profile` over `data['ns.profile']`

To be robust across admin versions, the schema currently uses fallback expressions like:

- `((data.ns && data.ns.profile) || data['ns.profile'])`

---

## 7. Implementation outline (for later)

### 7.1 Loading and subscriptions

1. load all objects with msghub custom enabled
2. for each rule:
	   - determine required state ids:
	     - the configured object itself
	     - dependency ids (`trg.id`, `sess.onOffId`, etc.)
3. subscribe only to those ids

### 7.2 Scheduling

Use a priority scheduler:

- freshness checks run at “next expected deadline” per datapoint
- triggered windows create a scheduled expiry check
- session finish timer is explicit

Avoid polling “everything every second”.

### 7.3 Persistence

At minimum persist per-rule runtime state:

- last violation time
- last message ref / last emit time (cooldown)
- session baselines (`counterStart`, `startedAt`)
- non-settling history markers

This can be stored as adapter states or in a small JSON file/state under the adapter namespace.

---

## 8. Current UI location

- Custom schema: `admin/jsonCustom.json`
- Instance config schema (unrelated): `admin/jsonConfig.json`
