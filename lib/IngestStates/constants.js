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
			timing: { timeBudget: 0, dueInMs: 0, expiresInMs: 0, cooldown: 0, remindEvery: 0 },
			details: { task: '', reason: '', tools: [], consumables: [] },
			audience: { tags: [], channels: { include: [], exclude: [] } },
			actions: [],
		},
		policy: { resetOnNormal: false },
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

/**
 * Catalog of template variables (metrics) available per rule type.
 *
 * Rules emit metrics into message payloads. Preset authors reference them as {{m.<key>}}
 * placeholders in title/text templates. This catalog is the single source of truth for
 * which metrics each rule makes available and under which subset conditions.
 *
 * MetricEntry shape:
 *   type       - value type: 'string' | 'number' | 'timestamp' | 'enum'
 *                The UI layer maps types to MsgRender filter suggestions (not this catalog).
 *   enumValues - (enum only) frozen array of possible values; plugin-owned domain knowledge.
 *   labelKey   - i18n key for the metric's short UI display name.
 *   helpKey    - i18n key for the metric's explanatory tooltip.
 *   subset     - null   = available in all subsets
 *                array  = available when the preset's subset is one of those values
 *                Uses the same subset language as presetTemplateV1.subset.
 *
 * Subset filter logic:
 *   null                      → always available
 *   s.includes(presetSubset)  → available
 */
const ruleTemplateCatalog = Object.freeze({
	threshold: Object.freeze({
		metrics: Object.freeze({
			// Subsets: lt | gt | inside | outside | truthy | falsy
			'state-name': Object.freeze({
				type: 'string',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateName.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateName.help',
				subset: null,
			}),
			'state-value': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateValue.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateValue.help',
				subset: null,
			}),
			'state-min': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.threshold.metric.stateMin.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.threshold.metric.stateMin.help',
				subset: Object.freeze(['lt', 'inside', 'outside']),
			}),
			'state-max': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.threshold.metric.stateMax.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.threshold.metric.stateMax.help',
				subset: Object.freeze(['gt', 'inside', 'outside']),
			}),
			'state-recovered-at': Object.freeze({
				type: 'timestamp',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateRecoveredAt.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateRecoveredAt.help',
				subset: null,
			}),
		}),
	}),

	freshness: Object.freeze({
		metrics: Object.freeze({
			'state-name': Object.freeze({
				type: 'string',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateName.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateName.help',
				subset: null,
			}),
			'state-value': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateValue.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateValue.help',
				subset: null,
			}),
			'state-ts': Object.freeze({
				type: 'timestamp',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.freshness.metric.stateTs.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.freshness.metric.stateTs.help',
				subset: null,
			}),
			'state-lc': Object.freeze({
				type: 'timestamp',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.freshness.metric.stateLc.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.freshness.metric.stateLc.help',
				subset: null,
			}),
			'state-recovered-at': Object.freeze({
				type: 'timestamp',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateRecoveredAt.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateRecoveredAt.help',
				subset: null,
			}),
		}),
	}),

	cycle: Object.freeze({
		metrics: Object.freeze({
			'state-name': Object.freeze({
				type: 'string',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateName.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateName.help',
				subset: null,
			}),
			'cycle-lastResetAt': Object.freeze({
				type: 'timestamp',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.cycle.metric.cycleLastResetAt.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.cycle.metric.cycleLastResetAt.help',
				subset: null,
			}),
			'cycle-subCounter': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.cycle.metric.cycleSubCounter.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.cycle.metric.cycleSubCounter.help',
				subset: null,
			}),
			// Emitted only when a count-based period is configured (period > 0).
			'cycle-period': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.cycle.metric.cyclePeriod.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.cycle.metric.cyclePeriod.help',
				subset: null,
			}),
			'cycle-remaining': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.cycle.metric.cycleRemaining.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.cycle.metric.cycleRemaining.help',
				subset: null,
			}),
			// Emitted only when a time-based window is configured (timeMs > 0).
			'cycle-timeMs': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.cycle.metric.cycleTimeMs.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.cycle.metric.cycleTimeMs.help',
				subset: null,
			}),
			'cycle-timeBasedDueAt': Object.freeze({
				type: 'timestamp',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.cycle.metric.cycleTimeBasedDueAt.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.cycle.metric.cycleTimeBasedDueAt.help',
				subset: null,
			}),
		}),
	}),

	triggered: Object.freeze({
		metrics: Object.freeze({
			'state-name': Object.freeze({
				type: 'string',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateName.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateName.help',
				subset: null,
			}),
			'state-value': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateValue.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateValue.help',
				subset: null,
			}),
			'trigger-name': Object.freeze({
				type: 'string',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.triggered.metric.triggerName.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.triggered.metric.triggerName.help',
				subset: null,
			}),
			'trigger-value': Object.freeze({
				type: 'string',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.triggered.metric.triggerValue.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.triggered.metric.triggerValue.help',
				subset: null,
			}),
			'state-recovered-at': Object.freeze({
				type: 'timestamp',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateRecoveredAt.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateRecoveredAt.help',
				subset: null,
			}),
		}),
	}),

	nonSettling: Object.freeze({
		metrics: Object.freeze({
			// Subsets: activity | trend
			'state-name': Object.freeze({
				type: 'string',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateName.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateName.help',
				subset: null,
			}),
			'state-value': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateValue.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateValue.help',
				subset: null,
			}),
			'state-recovered-at': Object.freeze({
				type: 'timestamp',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateRecoveredAt.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateRecoveredAt.help',
				subset: null,
			}),
			// Both activity and trend profiles emit these when range data is available.
			trendStartedAt: Object.freeze({
				type: 'timestamp',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.nonSettling.metric.trendStartedAt.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.nonSettling.metric.trendStartedAt.help',
				subset: null,
			}),
			trendStartValue: Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.nonSettling.metric.trendStartValue.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.nonSettling.metric.trendStartValue.help',
				subset: null,
			}),
			trendMin: Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.nonSettling.metric.trendMin.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.nonSettling.metric.trendMin.help',
				subset: null,
			}),
			trendMax: Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.nonSettling.metric.trendMax.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.nonSettling.metric.trendMax.help',
				subset: null,
			}),
			trendMinToMax: Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.nonSettling.metric.trendMinToMax.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.nonSettling.metric.trendMinToMax.help',
				subset: null,
			}),
			trendDir: Object.freeze({
				type: 'enum',
				enumValues: Object.freeze(['up', 'down', '']),
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.nonSettling.metric.trendDir.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.nonSettling.metric.trendDir.help',
				subset: null,
			}),
		}),
	}),

	session: Object.freeze({
		metrics: Object.freeze({
			'state-name': Object.freeze({
				type: 'string',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateName.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.common.metric.stateName.help',
				subset: null,
			}),
			'session-counter-start': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.session.metric.sessionCounterStart.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.session.metric.sessionCounterStart.help',
				subset: null,
			}),
			'session-counter': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.session.metric.sessionCounter.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.session.metric.sessionCounter.help',
				subset: null,
			}),
			'session-cost': Object.freeze({
				type: 'number',
				labelKey: 'msghub.i18n.IngestStates.admin.templateCatalog.session.metric.sessionCost.label',
				helpKey: 'msghub.i18n.IngestStates.admin.templateCatalog.session.metric.sessionCost.help',
				subset: null,
			}),
		}),
	}),
});

module.exports = {
	presetSchema,
	presetTemplateV1,
	fallbackPresetId,
	createFallbackPreset,
	jsonCustomDefaults,
	ruleTemplateCatalog,
};
