/*
ioBroker States Ingest (msghub) – Custom data model per object
 *
 * Docs: ../docs/plugins/IngestIoBrokerStates.md

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
- All fields that the UI defines as `type: \"objectId\"` are strings (e.g. \"hm-rpc.0....\").

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

const { createOpQueue } = require('../../src/MsgUtils');

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

function normalizeDotKeys(input) {
	if (!isObject(input)) {
		return input;
	}

	const out = {};

	for (const [key, value] of Object.entries(input)) {
		if (key.includes('.')) {
			continue;
		}
		out[key] = isObject(value) ? normalizeDotKeys(value) : value;
	}

	for (const [key, value] of Object.entries(input)) {
		if (!key.includes('.')) {
			continue;
		}
		const parts = key.split('.').filter(Boolean);
		if (parts.length === 0) {
			continue;
		}

		let cur = out;
		for (let i = 0; i < parts.length - 1; i += 1) {
			const p = parts[i];
			if (!isObject(cur[p])) {
				cur[p] = {};
			}
			cur = cur[p];
		}
		cur[parts[parts.length - 1]] = isObject(value) ? normalizeDotKeys(value) : value;
	}

	return out;
}

function normalizeRuleCfg(cfg) {
	if (!isObject(cfg)) {
		return null;
	}
	return normalizeDotKeys(JSON.parse(JSON.stringify(cfg)));
}

function collectRequiredStateIds(targetId, cfg) {
	const ids = new Set();
	if (typeof targetId === 'string' && targetId.trim()) {
		ids.add(targetId);
	}

	const add = val => {
		if (typeof val === 'string' && val.trim()) {
			ids.add(val);
		}
	};

	add(cfg?.trg?.id);
	add(cfg?.sess?.onOffId);
	add(cfg?.sess?.energyCounterId);
	add(cfg?.sess?.pricePerKwhId);

	return ids;
}

function setDiff(prev, next) {
	const added = [];
	const removed = [];
	for (const id of next) {
		if (!prev.has(id)) {
			added.push(id);
		}
	}
	for (const id of prev) {
		if (!next.has(id)) {
			removed.push(id);
		}
	}
	return { added, removed };
}

/**
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter
 * @param {object} [options]
 * @param {number} [options.rescanIntervalMs=180000] Polling interval to discover new customs (0 = off).
 * @param {boolean} [options.traceEvents=false] Log per-event routing/custom payloads.
 */
function IngestIoBrokerStates(adapter, { rescanIntervalMs = 180000, traceEvents = false } = {}) {
	if (!adapter) {
		throw new Error('IngestIoBrokerStates: adapter is required');
	}

	const rulesByTargetId = new Map();
	const targetsByStateId = new Map();
	let subscribedStateIds = new Set();

	let watchedObjectIds = new Set();
	const lastCustomByObjectId = new Map();

	let running = false;
	let timer = null;
	const queue = createOpQueue();

	const subscribeStates = ids => {
		for (const id of ids) {
			adapter.subscribeForeignStates(id);
		}
	};

	const unsubscribeStates = ids => {
		for (const id of ids) {
			adapter.unsubscribeForeignStates(id);
		}
	};

	const subscribeObjects = ids => {
		for (const id of ids) {
			adapter.subscribeForeignObjects(id);
		}
	};

	const unsubscribeObjects = ids => {
		for (const id of ids) {
			adapter.unsubscribeForeignObjects(id);
		}
	};

	const isOwnObjectId = id => id === adapter.namespace || String(id).startsWith(`${adapter.namespace}.`);

	const rescan = async reason => {
		if (!running) {
			return;
		}
		const nsKey = adapter.namespace;
		const res = await adapter.getObjectViewAsync('system', 'custom', {});

		const nextWatched = new Set();
		const nextStateIds = new Set();

		rulesByTargetId.clear();
		targetsByStateId.clear();

		for (const row of res?.rows || []) {
			const targetId = row?.id;
			if (isOwnObjectId(targetId)) {
				adapter?.log?.error?.(`IngestIoBrokerStates: ignoring custom on own object '${targetId}' (loop protection)`);
				continue;
			}
			const raw = row?.value?.[nsKey];
			if (!raw) {
				continue;
			}

			nextWatched.add(targetId);
			lastCustomByObjectId.set(targetId, JSON.stringify(normalizeRuleCfg(raw)));

			if (!raw.enabled) {
				continue;
			}

			const cfg = normalizeRuleCfg(raw);
			if (!cfg?.enabled) {
				continue;
			}

			rulesByTargetId.set(targetId, cfg);

			for (const stateId of collectRequiredStateIds(targetId, cfg)) {
				nextStateIds.add(stateId);
				const targets = targetsByStateId.get(stateId) || new Set();
				targets.add(targetId);
				targetsByStateId.set(stateId, targets);
			}
		}

		const objDiff = setDiff(watchedObjectIds, nextWatched);
		if (objDiff.added.length) {
			subscribeObjects(objDiff.added);
			if (reason === 'poll') {
				adapter?.log?.info?.(
					`IngestIoBrokerStates: discovered ${objDiff.added.length} new custom object(s): ${objDiff.added.join(', ')}`,
				);
			}
		}
		if (objDiff.removed.length) {
			unsubscribeObjects(objDiff.removed);
			for (const id of objDiff.removed) {
				lastCustomByObjectId.delete(id);
			}
			adapter?.log?.info?.(
				`IngestIoBrokerStates: custom removed for ${objDiff.removed.length} object(s): ${objDiff.removed.join(', ')}`,
			);
		}

		const stateDiff = setDiff(subscribedStateIds, nextStateIds);
		if (stateDiff.added.length) {
			subscribeStates(stateDiff.added);
		}
		if (stateDiff.removed.length) {
			unsubscribeStates(stateDiff.removed);
		}

		watchedObjectIds = nextWatched;
		subscribedStateIds = nextStateIds;
	};

	const start = () => {
		if (running) {
			return;
		}
		running = true;

		queue(() => rescan('start'))
			.then(() => {
				adapter?.log?.info?.(
					`IngestIoBrokerStates: started targets=${rulesByTargetId.size}, requiredStates=${subscribedStateIds.size}, watchedObjects=${watchedObjectIds.size}`,
				);
			})
			.catch(e => {
				adapter?.log?.warn?.(`IngestIoBrokerStates: initial scan failed: ${e?.message || e}`);
			});

		if (typeof rescanIntervalMs === 'number' && rescanIntervalMs > 0) {
			timer = setInterval(() => {
				void queue(() => rescan('poll')).catch(() => undefined);
			}, rescanIntervalMs);
		}
	};

	const stop = () => {
		if (!running) {
			return;
		}
		running = false;

		if (timer) {
			clearInterval(timer);
			timer = null;
		}

		try {
			unsubscribeObjects(Array.from(watchedObjectIds));
			unsubscribeStates(Array.from(subscribedStateIds));
		} finally {
			rulesByTargetId.clear();
			targetsByStateId.clear();
			watchedObjectIds.clear();
			subscribedStateIds.clear();
			lastCustomByObjectId.clear();
		}
	};

	const onStateChange = (id, _stateValue) => {
		const targets = targetsByStateId.get(id);
		if (!targets || targets.size === 0) {
			return;
		}
		if (traceEvents) {
			adapter?.log?.debug?.(
				`IngestIoBrokerStates: stateChange('${id}') routes to ${targets.size} target(s): ${Array.from(targets).join(', ')}`,
			);
		}
		// Rule evaluation comes later.
	};

	const onObjectChange = (id, obj) => {
		const nsKey = adapter.namespace;
		const raw = obj?.common?.custom?.[nsKey] || null;
		const next = raw ? JSON.stringify(normalizeRuleCfg(raw)) : null;
		const prev = lastCustomByObjectId.get(id) ?? null;

		if (prev === next) {
			return;
		}

		if (next === null) {
			lastCustomByObjectId.delete(id);
			adapter?.log?.info?.(`IngestIoBrokerStates: custom removed on '${id}'`);
			return;
		}

		lastCustomByObjectId.set(id, next);
		adapter?.log?.info?.(`IngestIoBrokerStates: custom changed on '${id}' (enabled=${raw?.enabled === true})`);
		if (traceEvents) {
			adapter?.log?.debug?.(`IngestIoBrokerStates: custom now on '${id}': ${next}`);
		}
	};

	const getRegistrySnapshot = () => ({
		targets: rulesByTargetId.size,
		requiredStates: subscribedStateIds.size,
		watchedObjects: watchedObjectIds.size,
	});

	return { start, stop, onStateChange, onObjectChange, getRegistrySnapshot };
}

module.exports = {
	IngestIoBrokerStates,
	_private: { normalizeRuleCfg, normalizeDotKeys, collectRequiredStateIds },
};
