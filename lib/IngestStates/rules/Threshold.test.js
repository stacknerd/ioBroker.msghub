'use strict';

const { expect } = require('chai');
const { format } = require('node:util');
const { ThresholdRule } = require('./Threshold');

describe('IngestStates ThresholdRule', () => {
		function createMessageStub() {
			const calls = {
				openActive: [],
				patchMetrics: [],
				closeOnNormal: [],
				timerSet: [],
				timerDelete: [],
			};

		const message = {
			ctx: {
				api: {
					i18n: {
						t: (key, ...args) => format(String(key), ...args),
					},
					iobroker: {
						objects: {
							getForeignObject: async () => ({ common: { name: 'My Sensor', unit: 'W' } }),
						},
						states: {
							getForeignState: async () => null,
						},
					},
				},
			},
			openActive: info => {
				calls.openActive.push(info);
				return true;
			},
				patchMetrics: info => {
					calls.patchMetrics.push(info);
					return true;
				},
				closeOnNormal: info => {
					calls.closeOnNormal.push(info);
					return true;
				},
			};

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

		return { message, timers, calls };
	}

	it('opens on bootstrap when the current value is already violating and minDuration is off', async () => {
		const { message, timers, calls } = createMessageStub();
		message.ctx.api.iobroker.states.getForeignState = async () => ({ val: 9 });

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			// Constructor triggers an async bootstrap read via getForeignState().
			new ThresholdRule({
				targetId: 'a.b.c',
				ruleConfig: { mode: 'lt', value: 10, hysteresis: 0, minDurationValue: 0, minDurationUnit: 1 },
				message,
				timers,
			});

			// Allow promise chain in _initValueFromForeignState() to settle.
				await new Promise(resolve => setImmediate(resolve));

				expect(calls.openActive).to.have.length(1);
				expect(calls.openActive[0].startAt).to.equal(now);
				expect(calls.openActive[0].metrics['state-min']).to.deep.equal({ val: 10, unit: 'W' });
				expect(calls.openActive[0].metrics['state-value']).to.deep.equal({ val: 9, unit: 'W' });
				expect(calls.patchMetrics).to.have.length(1);
					expect(calls.patchMetrics[0].set['state-value']).to.deep.equal({ val: 9, unit: 'W' });
			} finally {
				Date.now = originalNow;
			}
		});

	it('opens on lt violation and delays message creation by minDuration', () => {
		const { message, timers, calls } = createMessageStub();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new ThresholdRule({
				targetId: 'a.b.c',
				ruleConfig: { mode: 'lt', value: 10, hysteresis: 2, minDurationValue: 5, minDurationUnit: 1 },
				message,
				timers,
			});

			rule.onStateChange('a.b.c', { val: '9' });

			expect(calls.openActive).to.have.length(0);
			expect(calls.timerSet).to.have.length(1);

			rule.onTimer({ id: 'thr:a.b.c', at: now + 5000, kind: 'threshold.minDuration', data: { targetId: 'a.b.c' } });

				expect(calls.openActive).to.have.length(1);
				expect(calls.openActive[0].startAt).to.equal(now);
				expect(calls.openActive[0].actions.map(a => a.type)).to.deep.equal(['ack', 'snooze']);
				expect(calls.openActive[0].metrics['state-min']).to.deep.equal({ val: 12, unit: 'n/a' });
				expect(calls.openActive[0].metrics['state-value']).to.deep.equal({ val: 9, unit: 'n/a' });
				expect(calls.patchMetrics).to.have.length(1);
				expect(calls.patchMetrics[0].set['state-value']).to.deep.equal({ val: 9, unit: 'n/a' });
			} finally {
				Date.now = originalNow;
			}
		});

		it('provides recovery bounds metrics for outside mode (min/max + hysteresis)', () => {
			const { message, timers, calls } = createMessageStub();

			const rule = new ThresholdRule({
				targetId: 'a.b.c',
				ruleConfig: { mode: 'outside', min: 10, max: 20, hysteresis: 1, minDurationValue: 0, minDurationUnit: 1 },
				message,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 5 });
			expect(calls.openActive).to.have.length(1);
			expect(calls.openActive[0].metrics['state-min'].val).to.equal(11);
			expect(calls.openActive[0].metrics['state-max'].val).to.equal(19);
		});

	it('closes on recovery using hysteresis', () => {
		const { message, timers, calls } = createMessageStub();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		let t = now;
		Date.now = () => t;
		try {
			const rule = new ThresholdRule({
				targetId: 'a.b.c',
				ruleConfig: { mode: 'lt', value: 10, hysteresis: 2, minDurationValue: 0, minDurationUnit: 1 },
				message,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 9 }); // active
			expect(calls.openActive).to.have.length(1);

			t += 1000;
			rule.onStateChange('a.b.c', { val: 11 }); // not yet ok (needs >= 12)
			expect(calls.closeOnNormal).to.have.length(0);

			t += 1000;
			rule.onStateChange('a.b.c', { val: 12 }); // ok
			expect(calls.closeOnNormal).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it('cancels a pending minDuration timer when the condition clears before it fires', () => {
		const { message, timers, calls } = createMessageStub();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new ThresholdRule({
				targetId: 'a.b.c',
				ruleConfig: { mode: 'lt', value: 10, hysteresis: 2, minDurationValue: 5, minDurationUnit: 1 },
				message,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 9 }); // active -> schedule timer
			expect(calls.timerSet).to.have.length(1);
			expect(calls.openActive).to.have.length(0);

			rule.onStateChange('a.b.c', { val: 12 }); // ok -> cancel timer
			expect(calls.timerDelete).to.deep.equal(['thr:a.b.c']);

			rule.onTimer({ id: 'thr:a.b.c', at: now + 5000, kind: 'threshold.minDuration', data: { targetId: 'a.b.c' } });
			expect(calls.openActive).to.have.length(0);
		} finally {
			Date.now = originalNow;
		}
	});

	it('supports boolean truthy mode and closes when the value becomes FALSE', () => {
		const { message, timers, calls } = createMessageStub();

		const rule = new ThresholdRule({
			targetId: 'a.b.c',
			ruleConfig: { mode: 'truthy', minDurationValue: 0, minDurationUnit: 1 },
			message,
			timers,
		});

		rule.onStateChange('a.b.c', { val: 'true' });
		expect(calls.openActive).to.have.length(1);
		expect(calls.openActive[0].defaultText).to.contain('TRUE');

		rule.onStateChange('a.b.c', { val: 'false' });
		expect(calls.closeOnNormal).to.have.length(1);
	});
});
