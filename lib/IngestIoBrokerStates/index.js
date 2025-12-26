/*
TODO(IngestIoBrokerStates): Roadmap / next steps
===============================================

Goal: turn ioBroker state + custom configuration into MsgHub messages (create/update/remove),
with minimal subscriptions, strong dedupe, and predictable behavior.

TODO: Keep structure consistent
- `lib/IngestIoBrokerStates/index.js`: plugin entry (thin wrapper)
- `lib/IngestIoBrokerStates/Engine.js`: core engine (stateful, owns scanning/subscriptions/routing)
- `lib/IngestIoBrokerStates/normalizeConfig.js`: dot-key + nested normalization
- `lib/IngestIoBrokerStates/ownObjectGuard.js`: loop protection helpers
- `lib/IngestIoBrokerStates/Registry.js`: registry container
- `lib/IngestIoBrokerStates/rules/*`: rule evaluators (one file per mode)

TODO: Config + registry
- Normalize custom config (nested + dot-keys) through `normalizeConfig.js` only (single source of truth).
- Build a canonical registry shape:
  - rulesByTargetId: Map<targetId, cfgNormalized>
  - requiredStateIdsByTargetId: Map<targetId, Set<stateId>>
  - targetsByStateId: Map<stateId, Set<targetId>>
- Centralize dependency collection per mode (e.g. `dependencies.js`), so Engine does not hardcode fields.

TODO: Subscription strategy
- Ensure subscriptions are diffed (added/removed) and idempotent.
- Decide object subscriptions:
  - subscribe object IDs that currently have custom
  - periodic rescan to find new custom objects (avoid subscribeForeignObjects('*'))
- Keep the own-object loop guard strict (ignore customs on `adapter.namespace*`).

TODO: Message identity / dedupe
- Define stable ref scheme per target + rule, e.g.:
  - `ref = iob:<targetId>:<mode>[:<suffix>]`
- For multi-message rules (e.g. session start vs finish), define explicit suffixes.

TODO: Rule evaluation (incremental rollout)
- Implement `freshness` first:
  - check `ts` vs `lc`, handle `everyValue/everyUnit`
  - schedule/drive evaluation ticks (timer or based on state events)
  - message open/close behavior per `msg.resetOnNormal/resetDelay`
- Implement `threshold`:
  - lt/gt/inside/outside/truthy/falsy, hysteresis, minDuration
- Implement `triggered`:
  - arm window on trigger active, store baseline, detect expectation, emit violation
- Implement `session`:
  - start/stop thresholds, minHold, stopDelay, optional counters/cost summary
- Implement `nonSettling`:
  - activity/trend profiles, history windows; likely needs persistence

TODO: Persistence (rule runtime state)
- Decide what must survive restart per mode:
  - session baselines, triggered arm windows, nonSettling history pointers
- Pick a persistence backend (adapter states or file storage) and define a compact schema.

TODO: Operational behavior + logging
- Default logs: per rescan only summaries + diffs.
- `traceEvents`: optional detailed logs per state/object event (guarded).
- Protect against log spam in large systems.

TODO: Validation + docs
- Update `docs/plugins/IngestIoBrokerStates.md` from spec → implementation notes as features land.
- Add tests per rule and for registry/subscription diffs when rules are implemented.
*/

/*
ioBroker States Ingest (msghub) – Custom data model per object
 *
 * Docs: ../../docs/plugins/IngestIoBrokerStates.md
 * UI schema (ioBroker custom): ../../admin/jsonCustom.json

This configuration is stored per ioBroker object in `custom` when you enable and configure
msghub monitoring in Admin under “Objects → Custom”.

Storage location (per object):
  obj.common.custom['msghub.<instance>'] = {...}
Example:
  obj.common.custom['msghub.0']

Notes about storage
- ioBroker manages the `enabled` flag itself (custom on/off).
- The configuration can exist in two forms:
  - nested: `{ msg: { resetOnNormal: true } }`
  - flat with dot-keys: `{ 'msg.resetOnNormal': true }`
  The UI/parser logic in this project supports reading both variants.
- Time units are stored as second multipliers (numbers), not as strings:
  1 (seconds), 60 (minutes), 3600 (hours), 86400 (days)

-----------------------------------------------------------------------------
Overview: structure (logical/normalized)
-----------------------------------------------------------------------------
{
  enabled: true,
  meta?: {
    managedBy?: string,
    managedSince?: string,
    managedText?: string
  },
  mode?: 'threshold' | 'freshness' | 'triggered' | 'nonSettling' | 'session',

  thr?:  {...},   // Threshold
  fresh?:{...},   // Freshness / update interval
  trg?:  {...},   // Dependency (trigger → reaction)
  ns?:   {...},   // Non-settling value / trend
  sess?: {...},   // Session (start/stop)

  msg?:  {...},   // Message details + repeats + back-to-normal behavior
  expert?: {}     // reserved (UI currently has no inputs)
}

Object IDs
- All fields that the UI defines as `type: "objectId"` are strings (e.g. "hm-rpc.0....").

-----------------------------------------------------------------------------
thr.* – Threshold
-----------------------------------------------------------------------------
- thr.mode: 'lt' | 'gt' | 'outside' | 'inside' | 'truthy' | 'falsy'
- thr.value: number (lt/gt only)
- thr.min / thr.max: number (inside/outside only)
- thr.hysteresis: number (0 = off; not used for truthy/falsy)
- thr.minDurationValue + thr.minDurationUnit: minimum duration before alerting (unit: 1/60/3600)

-----------------------------------------------------------------------------
fresh.* – Freshness / update interval
-----------------------------------------------------------------------------
- fresh.everyValue + fresh.everyUnit: maximum gap between updates (unit: 60/3600/86400)
- fresh.evaluateBy: 'ts' (lastUpdate) or 'lc' (lastChange)

-----------------------------------------------------------------------------
trg.* – Dependency (trigger → reaction)
-----------------------------------------------------------------------------
Trigger
- trg.id: object ID of the trigger state
- trg.operator: 'eq' | 'neq' | 'gt' | 'lt' | 'truthy' | 'falsy'
- trg.valueType: 'boolean' | 'number' | 'string' (only if a comparison value is needed)
- trg.valueBool / trg.valueNumber / trg.valueString: comparison value (depending on valueType)

Time window
- trg.windowValue + trg.windowUnit (unit: 1/60/3600)

Expected reaction (of this object)
- trg.expectation: 'changed' | 'deltaUp' | 'deltaDown' | 'thresholdGte' | 'thresholdLte'
- trg.minDelta: deltaUp/deltaDown only
- trg.threshold: thresholdGte/thresholdLte only

-----------------------------------------------------------------------------
ns.* – Non-settling value / trend
-----------------------------------------------------------------------------
- ns.profile: 'activity' | 'trend'
- ns.minDelta: number (0 = every change counts)

Profile 'activity' (no quiet phase)
- ns.maxContinuousValue + ns.maxContinuousUnit (unit: 60/3600)
- ns.quietGapValue + ns.quietGapUnit (unit: 60/3600)

Profile 'trend' (leak/trend)
- ns.direction: 'up' | 'down' | 'any'
- ns.trendWindowValue + ns.trendWindowUnit (unit: 3600/86400)
- ns.minTotalDelta: optional minimum total delta within the window (0 = ignore)

-----------------------------------------------------------------------------
sess.* – Session (start/stop)
-----------------------------------------------------------------------------
Optional gate
- sess.onOffId: object ID of a gate switch/state
- sess.onOffActive: 'truthy' | 'falsy' | 'eq'
- sess.onOffValue: string ('eq' only)

Start
- sess.startThreshold: number
- sess.startMinHoldValue + sess.startMinHoldUnit (unit: 1/60)

Stop / finished
- sess.stopThreshold: number
- sess.stopDelayValue + sess.stopDelayUnit (unit: 1/60/3600)
- sess.cancelStopIfAboveStopThreshold: boolean

Optional summary (IDs are strings)
- sess.energyCounterId: consumption/energy counter (kWh)
- sess.pricePerKwhId: cost per consumption unit (optional cost value in the UI)
- sess.roundDigits: rounding in the output

-----------------------------------------------------------------------------
msg.* – Message: details, repeats, back to normal
-----------------------------------------------------------------------------
Details
- msg.kind: 'status' | 'task'
- msg.level: 0 (not defined/none) | 10 (notice) | 20 (warning) | 30 (error)
- msg.title / msg.text: optional; if empty, msghub may use defaults later

Repeats / reminders
- msg.cooldownValue + msg.cooldownUnit: suppress repeats (0 = off; unit: 60/3600/86400)
- msg.remindValue + msg.remindUnit: repeat while still active (0 = off; unit: 1/60/3600/86400)

Back to normal
- msg.resetOnNormal: true = auto-close, false = manual acknowledge
- msg.resetDelayValue + msg.resetDelayUnit: optional delay until removal (0 = immediate; unit: 1/60/3600/86400)

Session-specific (only when mode = 'session')
- msg.sessionStartEnabled: create an additional message on session start
- msg.sessionStartKind / msg.sessionStartLevel / msg.sessionStartTitle / msg.sessionStartText
*/

'use strict';

const { IngestIoBrokerStatesEngine } = require('./Engine');

/**
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter
 * @param {object} [options]
 * @param {number} [options.rescanIntervalMs=180000] Polling interval to discover new customs (0 = off).
 * @param {boolean} [options.traceEvents=false] Log per-event routing/custom payloads.
 */
function IngestIoBrokerStates(adapter, { rescanIntervalMs = 180000, traceEvents = false } = {}) {
	const engine = new IngestIoBrokerStatesEngine(adapter, { rescanIntervalMs, traceEvents });
	return {
		start: () => engine.start(),
		stop: () => engine.stop(),
		onStateChange: (id, state, ctx) => engine.onStateChange(id, state, ctx),
		onObjectChange: (id, obj, ctx) => engine.onObjectChange(id, obj, ctx),
		getRegistrySnapshot: () => engine.getRegistrySnapshot(),
	};
}

module.exports = {
	IngestIoBrokerStates,
};
