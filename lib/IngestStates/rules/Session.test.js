'use strict';

const { expect } = require('chai');
const { format } = require('node:util');
const { SessionRule } = require('./Session');

describe('IngestStates SessionRule', () => {
	function createStubs({ startEnabled = true } = {}) {
		const calls = {
			openStartActive: [],
			patchStartMetrics: [],
			closeEndOnStart: [],
			openActive: [],
			patchMetrics: [],
			removeStartMessage: [],
			timerSet: [],
			timerDelete: [],
		};

		const byRef = {};

		const message = {
			ctx: {
				api: {
					i18n: {
						t: (key, ...args) => format(String(key), ...args),
					},
					constants: {
						lifecycle: { state: { deleted: 'deleted' } },
					},
					store: {
						getMessageByRef: ref => byRef[ref] || null,
					},
					iobroker: {
						objects: {
							getForeignObject: async () => ({ common: {} }),
						},
						states: {
							getForeignState: async () => null,
						},
					},
				},
			},
			makeRef: (suffix = '') => `IngestStates.0.session.a.b.c${suffix}`,
			isSessionStartEnabled: () => startEnabled,
			openStartActive: info => {
				calls.openStartActive.push(info);
				return true;
			},
			patchStartMetrics: info => {
				calls.patchStartMetrics.push(info);
				return true;
			},
			closeEndOnStart: info => {
				calls.closeEndOnStart.push(info);
				return true;
			},
			openActive: info => {
				calls.openActive.push(info);
				return true;
			},
			patchMetrics: info => {
				calls.patchMetrics.push(info);
				return true;
			},
			removeStartMessage: () => {
				calls.removeStartMessage.push(true);
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

		return { message, timers, calls, byRef };
	}

	it('creates start message, closes previous end message, and emits end message on stop', () => {
		const { message, timers, calls } = createStubs({ startEnabled: true });

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new SessionRule({
				targetId: 'a.b.c',
				ruleConfig: {
					startThreshold: 50,
					startMinHoldValue: 0,
					startMinHoldUnit: 1,
					stopThreshold: 15,
					stopDelayValue: 0,
					stopDelayUnit: 60,
					cancelStopIfAboveStopThreshold: true,
					energyCounterId: 'counter',
					pricePerKwhId: 'price',
				},
				message,
				timers,
			});

			rule.onStateChange('counter', { val: 100 });
			rule.onStateChange('price', { val: 2 });

			rule.onStateChange('a.b.c', { val: 60 }); // start

			expect(calls.closeEndOnStart).to.have.length(1);
			expect(calls.openStartActive).to.have.length(1);
			expect(calls.openStartActive[0].defaultTitle).to.contain('started');
			expect(calls.openStartActive[0].actions.map(a => a.type)).to.deep.equal(['ack', 'snooze', 'delete']);

			now += 10_000;
			rule.onStateChange('counter', { val: 103 });
			rule.onStateChange('a.b.c', { val: 10 }); // stop (immediate)

			expect(calls.openActive).to.have.length(1);
			expect(calls.openActive[0].defaultTitle).to.contain('ended');
			expect(calls.openActive[0].actions.map(a => a.type)).to.deep.equal(['ack', 'snooze']);

			expect(calls.patchMetrics).to.have.length(1);
			expect(calls.patchMetrics[0].set['session-start']).to.deep.equal({ val: Date.UTC(2025, 0, 1, 12, 0, 0), unit: 'ms' });
			expect(calls.patchMetrics[0].set['session-startval']).to.deep.equal({ val: 100, unit: '' });
			expect(calls.patchMetrics[0].set['session-counter']).to.deep.equal({ val: 3, unit: '' });
			expect(calls.patchMetrics[0].set['session-cost']).to.deep.equal({ val: 6, unit: '' });

			expect(calls.removeStartMessage).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it('uses a persistent startMinHold timer before creating the start message', () => {
		const { message, timers, calls } = createStubs({ startEnabled: true });

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new SessionRule({
				targetId: 'a.b.c',
				ruleConfig: {
					startThreshold: 50,
					startMinHoldValue: 5,
					startMinHoldUnit: 1,
					stopThreshold: 15,
					stopDelayValue: 0,
					stopDelayUnit: 60,
				},
				message,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 60 }); // start candidate

			expect(calls.openStartActive).to.have.length(0);
			expect(calls.timerSet.some(([id, t]) => id === 'sess:startHold:a.b.c' && t.kind === 'session.startHold')).to.equal(true);

			rule.onTimer({ id: 'sess:startHold:a.b.c', at: now + 5000, kind: 'session.startHold', data: { targetId: 'a.b.c' } });

			expect(calls.openStartActive).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it('uses a persistent stopDelay timer before emitting the end message', () => {
		const { message, timers, calls } = createStubs({ startEnabled: true });

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new SessionRule({
				targetId: 'a.b.c',
				ruleConfig: {
					startThreshold: 50,
					startMinHoldValue: 0,
					startMinHoldUnit: 1,
					stopThreshold: 15,
					stopDelayValue: 5,
					stopDelayUnit: 1,
				},
				message,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 60 }); // start
			expect(calls.openStartActive).to.have.length(1);

			now += 1000;
			rule.onStateChange('a.b.c', { val: 10 }); // stop candidate

			expect(calls.openActive).to.have.length(0);
			expect(calls.timerSet.some(([id, t]) => id === 'sess:stopDelay:a.b.c' && t.kind === 'session.stopDelay')).to.equal(true);

			now += 5000;
			rule.onTimer({ id: 'sess:stopDelay:a.b.c', at: now, kind: 'session.stopDelay', data: { targetId: 'a.b.c' } });

			expect(calls.openActive).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it('ends the session when the gate turns off', () => {
		const { message, timers, calls } = createStubs({ startEnabled: true });

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new SessionRule({
				targetId: 'a.b.c',
				ruleConfig: {
					onOffId: 'gate',
					onOffActive: 'truthy',
					startThreshold: 50,
					startMinHoldValue: 0,
					startMinHoldUnit: 1,
					stopThreshold: 15,
					stopDelayValue: 0,
					stopDelayUnit: 1,
				},
				message,
				timers,
			});

			rule.onStateChange('gate', { val: true });
			rule.onStateChange('a.b.c', { val: 60 }); // start
			expect(calls.openStartActive).to.have.length(1);

			now += 1000;
			rule.onStateChange('gate', { val: false }); // gate off -> end session

			expect(calls.openActive).to.have.length(1);
			expect(calls.removeStartMessage).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});
});
