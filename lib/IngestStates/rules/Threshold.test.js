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

		const i18n = {
			'msghub.i18n.IngestStates.startedAt.v1.text': '\nThis started on {{t.startAt|datetime}}.',
			'msghub.i18n.IngestStates.startedAt.v2.text': '\nThis first happened on {{t.startAt|datetime}}.',
			'msghub.i18n.IngestStates.startedAt.v3.text': '\nFirst noticed on {{t.startAt|datetime}}.',
			'msghub.i18n.IngestStates.startedAt.v4.text': '\nIt’s been like this since {{t.startAt|datetime}}.',
			'msghub.i18n.IngestStates.startedAt.v5.text': '\nThis has been going on since {{t.startAt|datetime}}.',
			'msghub.i18n.IngestStates.startedAt.v6.text': '\nThis began on {{t.startAt|datetime}}.',
			'msghub.i18n.IngestStates.rules.threshold.title.booleanCondition.format': "'%s' boolean condition",
			'msghub.i18n.IngestStates.rules.threshold.title.outsideLimit.format': "'%s' outside the limit",
			'msghub.i18n.IngestStates.rules.threshold.title.outsideRange.format': "'%s' outside the range",
			'msghub.i18n.IngestStates.rules.threshold.title.insideRange.format': "'%s' inside the range",
			'msghub.i18n.IngestStates.rules.threshold.text.truthy.v1.format':
				"For '%s', it’s currently {{m.state-value|bool:TRUE/FALSE}}.\nI’ll clear this message once it switches to FALSE.",
			'msghub.i18n.IngestStates.rules.threshold.text.truthy.v2.format':
				"Quick heads-up: '%s' is {{m.state-value|bool:TRUE/FALSE}} right now.\nI’ll clear this as soon as it flips to FALSE.",
			'msghub.i18n.IngestStates.rules.threshold.text.truthy.v3.format':
				"Just so you know, '%s' is currently {{m.state-value|bool:TRUE/FALSE}}.\nOnce it turns FALSE again, this message goes away.",
			'msghub.i18n.IngestStates.rules.threshold.text.falsy.v1.format':
				"For '%s', it’s currently {{m.state-value|bool:TRUE/FALSE}}.\nI’ll clear this message once it switches to TRUE.",
			'msghub.i18n.IngestStates.rules.threshold.text.falsy.v2.format':
				"FYI: '%s' reads {{m.state-value|bool:TRUE/FALSE}} right now.\nI’ll clear this once it becomes TRUE.",
			'msghub.i18n.IngestStates.rules.threshold.text.falsy.v3.format':
				"Right now '%s' is {{m.state-value|bool:TRUE/FALSE}}.\nAs soon as it flips to TRUE, I’ll drop this message.",
			'msghub.i18n.IngestStates.rules.threshold.text.lt.v1.format':
				"For '%s', the value is {{m.state-value}} — that’s too low.\nOnce it’s back to at least {{m.state-min}}, everything is fine again.",
			'msghub.i18n.IngestStates.rules.threshold.text.lt.v2.format':
				"'%s' is currently at {{m.state-value}}, which is below the limit.\nWhen it reaches {{m.state-min}} or more, we’re good again.",
			'msghub.i18n.IngestStates.rules.threshold.text.lt.v3.format':
				"Heads-up: '%s' dropped to {{m.state-value}}.\nI’ll clear this once it climbs back to {{m.state-min}} or higher.",
			'msghub.i18n.IngestStates.rules.threshold.text.gt.v1.format':
				"For '%s', the value is {{m.state-value}} — that’s too high.\nOnce it’s back to at most {{m.state-max}}, everything is fine again.",
			'msghub.i18n.IngestStates.rules.threshold.text.gt.v2.format':
				"'%s' is currently at {{m.state-value}}, which is above the limit.\nWhen it drops back to {{m.state-max}} or less, things are fine again.",
			'msghub.i18n.IngestStates.rules.threshold.text.gt.v3.format':
				"Quick heads-up: '%s' is at {{m.state-value}} — that’s higher than it should be.\nI’ll clear this once it’s back down to {{m.state-max}} or below.",
			'msghub.i18n.IngestStates.rules.threshold.text.outside.v1.format':
				"For '%s', the value is {{m.state-value}} — it’s outside the desired range.\nOnce it’s back between {{m.state-min}} and {{m.state-max}}, everything is fine again.",
			'msghub.i18n.IngestStates.rules.threshold.text.outside.v2.format':
				"'%s' is at {{m.state-value}}, which is outside the target range.\nWhen it’s between {{m.state-min}} and {{m.state-max}} again, we’re all good.",
			'msghub.i18n.IngestStates.rules.threshold.text.outside.v3.format':
				"FYI: '%s' is currently {{m.state-value}} and out of range.\nI’ll clear this once it’s back in the {{m.state-min}}…{{m.state-max}} window.",
			'msghub.i18n.IngestStates.rules.threshold.text.inside.v1.format':
				"For '%s', the value is {{m.state-value}} — it’s in the desired range (and right now it shouldn’t be).\nOnce it drops below {{m.state-min}} or rises above {{m.state-max}}, everything is fine again.",
			'msghub.i18n.IngestStates.rules.threshold.text.inside.v2.format':
				"'%s' is currently at {{m.state-value}} — it’s inside the range (and that’s not what we want right now).\nI’ll clear this once it goes below {{m.state-min}} or above {{m.state-max}}.",
			'msghub.i18n.IngestStates.rules.threshold.text.inside.v3.format':
				"Heads-up: '%s' is sitting at {{m.state-value}} within the range.\nThis message clears when it leaves the range (below {{m.state-min}} or above {{m.state-max}}).",
		};

		const message = {
			ctx: {
				api: {
					i18n: {
						t: (key, ...args) => {
							const k = String(key);
							const template = Object.prototype.hasOwnProperty.call(i18n, k) ? i18n[k] : k;
							return format(String(template), ...args);
						},
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
					expect(calls.openActive[0].metrics['state-min']).to.deep.equal({ val: 12, unit: '' });
					expect(calls.openActive[0].metrics['state-value']).to.deep.equal({ val: 9, unit: '' });
					expect(calls.patchMetrics).to.have.length(1);
					expect(calls.patchMetrics[0].set['state-value']).to.deep.equal({ val: 9, unit: '' });
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
