'use strict';

const { expect } = require('chai');
const { format } = require('node:util');
const { NonSettlingRule } = require('./NonSettling');

describe('IngestStates NonSettlingRule', () => {
	function createMessageStub() {
		const calls = {
			onUpsert: [],
			onMetrics: [],
			onClose: [],
			timerSet: [],
			timerDelete: [],
		};
		const byRef = {};

		const ctx = {
			api: {
				log: { debug: () => undefined },
				i18n: {
					t: (key, ...args) => format(String(key), ...args),
				},
				store: {
					getMessageByRef: ref => byRef[ref] || null,
				},
				constants: {
					lifecycle: {
						state: { open: 'open', closed: 'closed', expired: 'expired', deleted: 'deleted' },
					},
				},
				iobroker: {
					objects: {
						getForeignObject: async () => ({ common: { name: 'My Sensor', unit: 'W' } }),
					},
				},
			},
			meta: {
				plugin: { baseOwnId: 'msghub.0.IngestStates.0' },
			},
		};

		const writer = {
			presetId: 'preset',
			onUpsert: (ref, info) => {
				byRef[ref] = { ref, lifecycle: { state: 'open' } };
				calls.onUpsert.push({ ref, ...info });
				return true;
			},
			onMetrics: (ref, info) => {
				calls.onMetrics.push({ ref, ...info });
				return true;
			},
			onClose: ref => {
				delete byRef[ref];
				calls.onClose.push({ ref });
				return true;
			},
		};

		const messageWritersByPresetKey = { NonSettlingId: writer, DefaultId: writer, $fallback: writer };

		const timers = {
			_timers: new Map(),
			get: id => (timers._timers.has(id) ? timers._timers.get(id) : null),
			set: (id, at, kind, data) => {
				const timer = { at, kind, data };
				timers._timers.set(id, timer);
				calls.timerSet.push([id, timer]);
			},
			delete: id => {
				timers._timers.delete(id);
				calls.timerDelete.push(id);
			},
		};

		return { ctx, messageWritersByPresetKey, timers, calls };
	}

	it('does not patch state-name from object meta before any message is active', async () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createMessageStub();
		new NonSettlingRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: {
				profile: 'activity',
				minDelta: 0,
				maxContinuousValue: 2,
				maxContinuousUnit: 1,
				quietGapValue: 2,
				quietGapUnit: 1,
			},
			messageWritersByPresetKey,
			timers,
		});

		await new Promise(resolve => setImmediate(resolve));
		expect(calls.onMetrics).to.have.length(0);
	});

	it('activity: opens after maxContinuous and closes once stable', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createMessageStub();

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new NonSettlingRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					profile: 'activity',
					minDelta: 0,
					maxContinuousValue: 2,
					maxContinuousUnit: 1,
					quietGapValue: 2,
					quietGapUnit: 1,
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 0, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 2, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 0, ts: now });

			expect(calls.onUpsert).to.have.length(0);
			expect(calls.timerSet).to.have.length.greaterThan(0);

			const t = timers.get('ns:a.b.c:open:activity');
			expect(t).to.be.ok;
			expect(t.kind).to.equal('nonSettling.activity.open');
			const startedAt = t.data.startedAt;

			now = t.at;
			rule.onTimer({ id: 'ns:a.b.c:open:activity', at: t.at, kind: t.kind, data: t.data });

			expect(calls.onUpsert).to.have.length(1);
			expect(calls.onUpsert[0].actions.map(a => a.type)).to.deep.equal(['ack', 'snooze']);
			expect(calls.onUpsert[0].startAt).to.equal(startedAt);
			expect(calls.onUpsert[0].metrics['state-name'].unit).to.equal('');
			expect(['c', 'My Sensor']).to.include(calls.onUpsert[0].metrics['state-name'].val);
			expect(calls.onUpsert[0].metrics['state-value']).to.deep.equal({ val: 0, unit: '' });
			expect(calls.onUpsert[0].metrics.trendStartedAt).to.deep.equal({ val: startedAt, unit: 'ms' });
			// object meta lookup is async -> state-name may also arrive via a metric patch
			const nameMetricCall = calls.onMetrics.find(c => c?.set?.['state-name']?.val === 'My Sensor');
			if (nameMetricCall) {
				expect(nameMetricCall.set['state-name']).to.deep.equal({ val: 'My Sensor', unit: '' });
			}

			now += 1000;
			rule.onStateChange('a.b.c', { val: 5, ts: now }); // start stable candidate
			const liveMetricsBeforeRecovery = calls.onMetrics.filter(
				c => c?.set?.['state-value'] || c?.set?.trendStartedAt || c?.set?.trendDir,
			).length;
			now += 2000;
			rule.onStateChange('a.b.c', { val: 5, ts: now }); // stable after quietGap

			const recoveryPatch = calls.onMetrics.find(c => c?.set?.['state-recovered-at']);
			expect(recoveryPatch.set).to.deep.equal({
				'state-recovered-at': { val: now, unit: 'ms' },
			});
			const afterRecoveryIdx = calls.onMetrics.length;
			expect(calls.onClose).to.have.length(1);

			now += 1000;
			rule.onStateChange('a.b.c', { val: 5, ts: now }); // still good
			rule.onTick(now + 1000);
			const goodStatePatches = calls.onMetrics.slice(afterRecoveryIdx);
			expect(goodStatePatches).to.have.length(0);
			expect(goodStatePatches.some(c => c?.set?.['state-name'])).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.['state-value'])).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.trendStartedAt)).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.trendStartValue)).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.trendMin)).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.trendMax)).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.trendMinToMax)).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.trendDir)).to.equal(false);
			const liveMetricsAfterRecovery = calls.onMetrics.filter(
				c => c?.set?.['state-value'] || c?.set?.trendStartedAt || c?.set?.trendDir,
			).length;
			expect(liveMetricsAfterRecovery).to.equal(liveMetricsBeforeRecovery);
		} finally {
			Date.now = originalNow;
		}
	});

	it('activity: closes after quietGap via recovery timer without follow-up event', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createMessageStub();

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new NonSettlingRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					profile: 'activity',
					minDelta: 0,
					maxContinuousValue: 2,
					maxContinuousUnit: 1,
					quietGapValue: 2,
					quietGapUnit: 1,
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 0, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 2, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 0, ts: now });

			const openTimer = timers.get('ns:a.b.c:open:activity');
			now = openTimer.at;
			rule.onTimer({ id: 'ns:a.b.c:open:activity', at: openTimer.at, kind: openTimer.kind, data: openTimer.data });
			expect(calls.onUpsert).to.have.length(1);

			now += 1000;
			rule.onStateChange('a.b.c', { val: 5, ts: now }); // start stable candidate
			const recoveryTimer = timers.get('ns:a.b.c:recover:activity');
			expect(recoveryTimer).to.be.ok;
			expect(recoveryTimer.kind).to.equal('nonSettling.activity.recover');

			now = recoveryTimer.at; // no follow-up state event, timer drives recovery
			rule.onTimer({
				id: 'ns:a.b.c:recover:activity',
				at: recoveryTimer.at,
				kind: recoveryTimer.kind,
				data: recoveryTimer.data,
			});

			expect(calls.onClose).to.have.length(1);
			const recoveryPatch = calls.onMetrics.find(c => c?.set?.['state-recovered-at']);
			expect(recoveryPatch).to.be.ok;
			expect(recoveryPatch.set).to.deep.equal({
				'state-recovered-at': { val: now, unit: 'ms' },
			});
		} finally {
			Date.now = originalNow;
		}
	});

	it('activity: keeps quietGap duration unchanged for fluctuations within minDelta', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createMessageStub();

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new NonSettlingRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					profile: 'activity',
					minDelta: 2,
					maxContinuousValue: 2,
					maxContinuousUnit: 1,
					quietGapValue: 2,
					quietGapUnit: 1,
				},
				messageWritersByPresetKey,
				timers,
			});

			// Drive rule into bad-state/open first.
			rule.onStateChange('a.b.c', { val: 0, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 3, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 0, ts: now });

			const openTimer = timers.get('ns:a.b.c:open:activity');
			now = openTimer.at;
			rule.onTimer({ id: 'ns:a.b.c:open:activity', at: openTimer.at, kind: openTimer.kind, data: openTimer.data });
			expect(calls.onUpsert).to.have.length(1);

			// Start quiet candidate.
			now += 200;
			rule.onStateChange('a.b.c', { val: 10, ts: now });
			const candidateStartedAt = now;
			const expectedRecoveryAt = candidateStartedAt + 2000;
			let recoveryTimer = timers.get('ns:a.b.c:recover:activity');
			expect(recoveryTimer).to.be.ok;
			expect(recoveryTimer.at).to.equal(expectedRecoveryAt);
			expect(recoveryTimer.data.startedAt).to.equal(candidateStartedAt);

			// Fluctuations stay within minDelta (range 9..11 => span 2).
			now += 500;
			rule.onStateChange('a.b.c', { val: 11, ts: now });
			recoveryTimer = timers.get('ns:a.b.c:recover:activity');
			expect(recoveryTimer.at).to.equal(expectedRecoveryAt);
			expect(recoveryTimer.data.startedAt).to.equal(candidateStartedAt);

			now += 500;
			rule.onStateChange('a.b.c', { val: 9, ts: now });
			recoveryTimer = timers.get('ns:a.b.c:recover:activity');
			expect(recoveryTimer.at).to.equal(expectedRecoveryAt);
			expect(recoveryTimer.data.startedAt).to.equal(candidateStartedAt);

			// Recovery happens exactly at original quiet deadline.
			now = expectedRecoveryAt;
			rule.onTimer({
				id: 'ns:a.b.c:recover:activity',
				at: recoveryTimer.at,
				kind: recoveryTimer.kind,
				data: recoveryTimer.data,
			});

			expect(calls.onClose).to.have.length(1);
			const recoveryPatch = calls.onMetrics.find(c => c?.set?.['state-recovered-at']);
			expect(recoveryPatch).to.be.ok;
			expect(recoveryPatch.set['state-recovered-at'].val).to.equal(expectedRecoveryAt);
		} finally {
			Date.now = originalNow;
		}
	});

	it('activity: patches all nonSettling live metrics while still in bad-state', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createMessageStub();

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new NonSettlingRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					profile: 'activity',
					minDelta: 0,
					maxContinuousValue: 2,
					maxContinuousUnit: 1,
					quietGapValue: 2,
					quietGapUnit: 1,
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 0, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 2, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 0, ts: now });

			const t = timers.get('ns:a.b.c:open:activity');
			now = t.at;
			rule.onTimer({ id: 'ns:a.b.c:open:activity', at: t.at, kind: t.kind, data: t.data });

			now += 1000;
			rule.onTick(now); // still bad -> live metrics patch

			expect(calls.onMetrics.length).to.be.greaterThan(0);
			const patch = calls.onMetrics[calls.onMetrics.length - 1].set;
			expect(patch).to.have.property('state-name');
			expect(patch).to.have.property('state-value');
			expect(patch).to.have.property('trendStartedAt');
			expect(patch).to.have.property('trendStartValue');
			expect(patch).to.have.property('trendMin');
			expect(patch).to.have.property('trendMax');
			expect(patch).to.have.property('trendMinToMax');
			expect(patch).to.have.property('trendDir');
			expect(patch).to.not.have.property('state-recovered-at');
		} finally {
			Date.now = originalNow;
		}
	});

	it('activity: patches no nonSettling live metrics in good-state', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createMessageStub();

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new NonSettlingRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					profile: 'activity',
					minDelta: 0,
					maxContinuousValue: 2,
					maxContinuousUnit: 1,
					quietGapValue: 2,
					quietGapUnit: 1,
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 0, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 2, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 0, ts: now });

			const t = timers.get('ns:a.b.c:open:activity');
			now = t.at;
			rule.onTimer({ id: 'ns:a.b.c:open:activity', at: t.at, kind: t.kind, data: t.data });

			now += 1000;
			rule.onStateChange('a.b.c', { val: 5, ts: now }); // stable candidate start
			now += 2000;
			rule.onStateChange('a.b.c', { val: 5, ts: now }); // stable -> good/close
			const afterRecoveryIdx = calls.onMetrics.length;

			now += 1000;
			rule.onStateChange('a.b.c', { val: 5, ts: now }); // still good
			rule.onTick(now + 1000);

			const goodStatePatches = calls.onMetrics.slice(afterRecoveryIdx);
			expect(goodStatePatches.some(c => c?.set?.['state-name'])).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.['state-value'])).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.trendStartedAt)).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.trendStartValue)).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.trendMin)).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.trendMax)).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.trendMinToMax)).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.trendDir)).to.equal(false);
		} finally {
			Date.now = originalNow;
		}
	});

	it('trend: opens after trendWindow and closes on direction break', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createMessageStub();

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new NonSettlingRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					profile: 'trend',
					minDelta: 0,
					direction: 'up',
					trendWindowValue: 2,
					trendWindowUnit: 1,
					minTotalDelta: 5,
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 0, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 3, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 7, ts: now });

			const t = timers.get('ns:a.b.c:open:trend');
			expect(t).to.be.ok;
			expect(t.kind).to.equal('nonSettling.trend.open');

			now = t.at;
			rule.onTimer({ id: 'ns:a.b.c:open:trend', at: t.at, kind: t.kind, data: t.data });

			expect(calls.onUpsert).to.have.length(1);
			expect(calls.onUpsert[0].startAt).to.equal(t.data.startedAt);
			expect(calls.onUpsert[0].metrics['state-name'].unit).to.equal('');
			expect(['c', 'My Sensor']).to.include(calls.onUpsert[0].metrics['state-name'].val);
			expect(calls.onUpsert[0].metrics.trendDir.val).to.equal('up');
			expect(calls.onUpsert[0].metrics.trendMinToMax.val).to.equal(7);
			const nameMetricCall2 = calls.onMetrics.find(c => c?.set?.['state-name']?.val === 'My Sensor');
			if (nameMetricCall2) {
				expect(nameMetricCall2.set['state-name']).to.deep.equal({ val: 'My Sensor', unit: '' });
			}

			now += 1000;
			rule.onStateChange('a.b.c', { val: 0, ts: now }); // breaks "up"
			expect(calls.onClose).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it('trend(any): determines direction once delta exceeds minDelta', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createMessageStub();

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new NonSettlingRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					profile: 'trend',
					minDelta: 2,
					direction: 'any',
					trendWindowValue: 2,
					trendWindowUnit: 1,
					minTotalDelta: 0,
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 0, ts: now });
			now += 500;
			rule.onStateChange('a.b.c', { val: 1, ts: now }); // not enough yet
			now += 500;
			rule.onStateChange('a.b.c', { val: 3, ts: now }); // determines direction up

			const t = timers.get('ns:a.b.c:open:trend');
			expect(t).to.be.ok;

			now = t.at;
			rule.onTimer({ id: 'ns:a.b.c:open:trend', at: t.at, kind: t.kind, data: t.data });

			expect(calls.onUpsert).to.have.length(1);
			expect(calls.onUpsert[0].startAt).to.equal(t.data.startedAt);
			expect(calls.onUpsert[0].metrics.trendDir.val).to.equal('up');
			expect(calls.onMetrics).to.have.length(0);
		} finally {
			Date.now = originalNow;
		}
	});

	it('can open from a persisted activity timer payload (restart-safe)', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createMessageStub();

		const startedAt = Date.UTC(2025, 0, 1, 12, 0, 0);
		const openAt = startedAt + 2000;

		timers.set('ns:a.b.c:open:activity', openAt, 'nonSettling.activity.open', {
			profile: 'activity',
			targetId: 'a.b.c',
			startedAt,
			startValue: 1,
			min: 1,
			max: 5,
		});

		const rule = new NonSettlingRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: {
				profile: 'activity',
				minDelta: 0,
				maxContinuousValue: 2,
				maxContinuousUnit: 1,
				quietGapValue: 2,
				quietGapUnit: 1,
			},
			messageWritersByPresetKey,
			timers,
		});

		rule.onStateChange('a.b.c', { val: 1, ts: startedAt });

		rule.onTimer({
			id: 'ns:a.b.c:open:activity',
			at: openAt,
			kind: 'nonSettling.activity.open',
			data: timers.get('ns:a.b.c:open:activity').data,
		});

		expect(calls.onUpsert).to.have.length(1);
		expect(calls.onUpsert[0].startAt).to.equal(startedAt);
		expect(calls.onUpsert[0].metrics.trendStartedAt.val).to.equal(startedAt);
		expect(calls.onMetrics).to.have.length(0);
	});

	it('keeps state-name metric when opening from persisted timer without prior value sample', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createMessageStub();

		const startedAt = Date.UTC(2025, 0, 1, 12, 0, 0);
		const openAt = startedAt + 2000;

		timers.set('ns:a.b.c:open:activity', openAt, 'nonSettling.activity.open', {
			profile: 'activity',
			targetId: 'a.b.c',
			startedAt,
			startValue: 1,
			min: 1,
			max: 5,
		});

		const rule = new NonSettlingRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: {
				profile: 'activity',
				minDelta: 0,
				maxContinuousValue: 2,
				maxContinuousUnit: 1,
				quietGapValue: 2,
				quietGapUnit: 1,
			},
			messageWritersByPresetKey,
			timers,
		});

		rule.onTimer({
			id: 'ns:a.b.c:open:activity',
			at: openAt,
			kind: 'nonSettling.activity.open',
			data: timers.get('ns:a.b.c:open:activity').data,
		});

		expect(calls.onUpsert).to.have.length(1);
		expect(calls.onUpsert[0].metrics['state-name']).to.deep.equal({ val: 'c', unit: '' });
	});
});
