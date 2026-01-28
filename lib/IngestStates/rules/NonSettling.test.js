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

		const ctx = {
			api: {
				log: { debug: () => undefined },
				i18n: {
					t: (key, ...args) => format(String(key), ...args),
				},
				store: {
					getMessageByRef: () => null,
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
				calls.onUpsert.push({ ref, ...info });
				return true;
			},
			onMetrics: (ref, info) => {
				calls.onMetrics.push({ ref, ...info });
				return true;
			},
			onClose: ref => {
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
			expect(calls.onUpsert[0].metrics['state-value']).to.deep.equal({ val: 0, unit: 'n/a' });
			expect(calls.onUpsert[0].metrics.trendStartedAt).to.deep.equal({ val: startedAt, unit: 'ms' });
			expect(calls.onMetrics).to.have.length(0);

			now += 1000;
			rule.onStateChange('a.b.c', { val: 5, ts: now }); // start stable candidate
			now += 2000;
			rule.onStateChange('a.b.c', { val: 5, ts: now }); // stable after quietGap

			expect(calls.onClose).to.have.length(1);
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
			expect(calls.onUpsert[0].metrics.trendDir.val).to.equal('up');
			expect(calls.onUpsert[0].metrics.trendMinToMax.val).to.equal(7);
			expect(calls.onMetrics).to.have.length(0);

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
});
