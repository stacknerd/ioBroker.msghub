'use strict';

const presetSchema = 'msghub.IngestStatesMessagePreset.v1';
const fallbackPresetId = '$fallback';

const presetTemplateV1 = Object.freeze({
	schema: presetSchema,
	presetId: '',
	description: '',
	ownedBy: null,
	subset: null,
	message: Object.freeze({
		kind: 'status',
		level: 20,
		icon: '',
		title: '',
		text: '',
		textRecovered: '',
		timing: Object.freeze({
			timeBudget: 0,
			dueInMs: 0,
			expiresInMs: 0,
			cooldown: 0,
			remindEvery: 0,
		}),
		details: Object.freeze({
			task: '',
			reason: '',
			tools: Object.freeze([]),
			consumables: Object.freeze([]),
		}),
		audience: Object.freeze({
			tags: Object.freeze([]),
			channels: Object.freeze({
				include: Object.freeze([]),
				exclude: Object.freeze([]),
			}),
		}),
		actions: Object.freeze([]),
	}),
	policy: Object.freeze({
		resetOnNormal: true,
	}),
	ui: Object.freeze({
		timingUnits: Object.freeze({
			timeBudgetUnit: 60000,
			dueInUnit: 3600000,
			cooldownUnit: 1000,
			remindEveryUnit: 3600000,
		}),
	}),
});

/**
 * Internal fallback preset (not persisted, not user-editable).
 *
 * @param {object} info Inputs.
 * @param {string} info.targetId Monitored object/state id (included in the default text).
 * @returns {object} Preset object.
 */
function createFallbackPreset({ targetId }) {
	const tid = typeof targetId === 'string' ? targetId : '';
	return {
		schema: presetSchema,
		presetId: fallbackPresetId,
		description: 'Internal fallback preset',
		ownedBy: 'internal',
		subset: '',
		message: {
			kind: 'status',
			level: 40,
			icon: '🚨',
			title: 'Missing message preset',
			text: `A message preset is missing or not configured.\n${tid}`,
			textRecovered: '',
			timing: { timeBudget: 0, dueInMs: 0, cooldown: 0, remindEvery: 0 },
			details: { task: '', reason: '', tools: [], consumables: [] },
			audience: { tags: [], channels: { include: [], exclude: [] } },
			actions: [],
		},
		policy: { resetOnNormal: false },
		ui: {
			timingUnits: {
				timeBudgetUnit: 0,
				dueInUnit: 0,
				cooldownUnit: 0,
				remindEveryUnit: 0,
			},
		},
	};
}

const jsonCustomDefaults = Object.freeze({
	mode: '',

	// Threshold (thr-*)
	'thr-mode': 'lt',
	'thr-value': 10,
	'thr-min': 0,
	'thr-max': 100,
	'thr-hysteresis': 0,
	'thr-minDurationValue': 0,
	'thr-minDurationUnit': 60,

	// Freshness (fresh-*)
	'fresh-enable': false,
	'fresh-everyValue': 60,
	'fresh-everyUnit': 60,
	'fresh-evaluateBy': 'ts',

	// Cycle (cyc-*)
	'cyc-period': 25,
	'cyc-time': 0,
	'cyc-timeUnit': 3600,

	// Triggered / dependency (trg-*)
	'trg-id': '',
	'trg-operator': 'eq',
	'trg-valueType': 'boolean',
	'trg-valueBool': true,
	'trg-valueNumber': 0,
	'trg-valueString': '',
	'trg-windowValue': 5,
	'trg-windowUnit': 60,
	'trg-expectation': 'changed',
	'trg-minDelta': 0,
	'trg-threshold': 0,

	// Non-settling (nonset-*)
	'nonset-profile': 'activity',
	'nonset-minDelta': 0,
	'nonset-maxContinuousValue': 180,
	'nonset-maxContinuousUnit': 60,
	'nonset-quietGapValue': 15,
	'nonset-quietGapUnit': 60,
	'nonset-direction': 'up',
	'nonset-trendWindowValue': 6,
	'nonset-trendWindowUnit': 3600,
	'nonset-trendQuietGapValue': 0,
	'nonset-trendQuietGapUnit': 60,
	'nonset-minTotalDelta': 0,

	// Session (sess-*)
	'sess-startThreshold': 50,
	'sess-startMinHoldValue': 0,
	'sess-startMinHoldUnit': 1,
	'sess-stopThreshold': 15,
	'sess-stopDelayValue': 5,
	'sess-stopDelayUnit': 60,
	'sess-enableGate': false,
	'sess-onOffId': '',
	'sess-startGateSemantics': 'gate_then_hold',
	'sess-onOffActive': 'truthy',
	'sess-onOffValue': 'true',
	'sess-enableSummary': false,
	'sess-energyCounterId': '',
	'sess-pricePerKwhId': '',

	// Message (msg-*)
	'msg-DefaultId': '',
	'msg-FreshnessId': '',
	'msg-ThresholdId': '',
	'msg-CycleId': '',
	'msg-SessionStartId': '',
	'msg-SessionEndId': '',
	'msg-TriggeredId': '',
	'msg-NonSettlingId': '',
});

module.exports = {
	presetSchema,
	presetTemplateV1,
	fallbackPresetId,
	createFallbackPreset,
	jsonCustomDefaults,
};
