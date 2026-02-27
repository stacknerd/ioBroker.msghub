'use strict';

const { expect } = require('chai');
const { ensureDefaultPresets } = require('./ensureDefaultPresets');
const { presetSchema } = require('./constants');

function buildCtx({ baseOwnId = 'msghub.0', baseFullId = 'msghub.0' } = {}) {
	const calls = {
		objects: [],
		states: [],
		warnings: [],
	};

	const ctx = {
		meta: {
			plugin: {
				baseOwnId,
				baseFullId,
			},
		},
		api: {
			log: {
				warn: msg => calls.warnings.push(msg),
			},
			constants: {
				kind: { status: 'status-x', task: 'task-x' },
				level: { notice: 123 },
			},
			iobroker: {
				objects: {
					setObjectNotExists: async (id, obj) => {
						calls.objects.push({ id, obj });
					},
				},
				states: {
					setForeignState: async (id, value, ack) => {
						calls.states.push({ id, value, ack });
					},
				},
			},
		},
	};

	return { ctx, calls };
}

function extractPresets(calls) {
	const presets = new Map();
	for (const entry of calls.states) {
		const raw = entry.value;
		if (typeof raw !== 'string') {
			continue;
		}
		const preset = JSON.parse(raw);
		presets.set(preset.presetId, preset);
	}
	return presets;
}

describe('IngestStates ensureDefaultPresets', () => {
	it('returns early when iobroker methods are missing', async () => {
		const { ctx, calls } = buildCtx();
		ctx.api.iobroker.objects.setObjectNotExists = null;
		await ensureDefaultPresets(ctx);
		expect(calls.objects).to.have.length(0);
		expect(calls.states).to.have.length(0);
	});

	it('creates preset objects + states with expected defaults', async () => {
		const { ctx, calls } = buildCtx();
		await ensureDefaultPresets(ctx);

		expect(calls.objects.length).to.equal(calls.states.length);
		expect(calls.objects.length).to.equal(36);

		const presets = extractPresets(calls);
		expect(presets.size).to.equal(36);

		const expectedIds = [
			'freshness_lc_resetOnNormal_true',
			'freshness_lc_resetOnNormal_false',
			'freshness_ts_resetOnNormal_true',
			'freshness_ts_resetOnNormal_false',
			'threshold_lt_resetOnNormal_true',
			'threshold_lt_resetOnNormal_false',
			'threshold_gt_resetOnNormal_true',
			'threshold_gt_resetOnNormal_false',
			'threshold_inside_resetOnNormal_true',
			'threshold_inside_resetOnNormal_false',
			'threshold_outside_resetOnNormal_true',
			'threshold_outside_resetOnNormal_false',
			'threshold_truesy_resetOnNormal_true',
			'threshold_truesy_resetOnNormal_false',
			'threshold_falsy_resetOnNormal_true',
			'threshold_falsy_resetOnNormal_false',
			'cycle_default_task',
			'triggered_changed_resetOnNormal_true',
			'triggered_changed_resetOnNormal_false',
			'triggered_deltaUp_resetOnNormal_true',
			'triggered_deltaUp_resetOnNormal_false',
			'triggered_deltaDown_resetOnNormal_true',
			'triggered_deltaDown_resetOnNormal_false',
			'triggered_thresholdGte_resetOnNormal_true',
			'triggered_thresholdGte_resetOnNormal_false',
			'triggered_thresholdLte_resetOnNormal_true',
			'triggered_thresholdLte_resetOnNormal_false',
			'nonsettling_activity_resetOnNormal_true',
			'nonsettling_activity_resetOnNormal_false',
			'nonsettling_trend_resetOnNormal_true',
			'nonsettling_trend_resetOnNormal_false',
			'session_start_default',
			'session_end_resetOnNormal_true',
			'session_end_resetOnNormal_false',
			'session_end_summary_resetOnNormal_true',
			'session_end_summary_resetOnNormal_false',
		];

		expect(Array.from(presets.keys()).sort()).to.deep.equal(expectedIds.sort());

		const cycle = presets.get('cycle_default_task');
		expect(cycle.schema).to.equal(presetSchema);
		expect(cycle.message.kind).to.equal('task-x');
		expect(cycle.message.level).to.equal(123);

		const sessionStart = presets.get('session_start_default');
		expect(sessionStart.message.kind).to.equal('status-x');
		expect(sessionStart.message.timing.expiresInMs).to.equal(3 * 24 * 60 * 60 * 1000);

		const sessionEndAuto = presets.get('session_end_resetOnNormal_true');
		expect(sessionEndAuto.message.kind).to.equal('task-x');
		expect(sessionEndAuto.message.timing.expiresInMs).to.equal(3 * 24 * 60 * 60 * 1000);

		const sessionEndManual = presets.get('session_end_resetOnNormal_false');
		expect(sessionEndManual.message.kind).to.equal('task-x');
		expect(sessionEndManual.message.timing.expiresInMs).to.equal(0);

		const sessionEndSummaryAuto = presets.get('session_end_summary_resetOnNormal_true');
		expect(sessionEndSummaryAuto.message.kind).to.equal('task-x');
		expect(sessionEndSummaryAuto.message.timing.expiresInMs).to.equal(3 * 24 * 60 * 60 * 1000);

		const sessionEndSummaryManual = presets.get('session_end_summary_resetOnNormal_false');
		expect(sessionEndSummaryManual.message.kind).to.equal('task-x');
		expect(sessionEndSummaryManual.message.timing.expiresInMs).to.equal(0);
	});
});
