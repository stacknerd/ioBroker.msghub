'use strict';

const { expect } = require('chai');
const { format } = require('node:util');
const { SessionRule } = require('./Session');

describe('IngestStates SessionRule', () => {
	function createStubs({ startEnabled = true } = {}) {
		const calls = {
			startUpsert: [],
			startMetrics: [],
			endUpsert: [],
			endMetrics: [],
			endClose: [],
			removeStartMessage: [],
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
				constants: {
					lifecycle: { state: { deleted: 'deleted' } },
				},
				store: {
					getMessageByRef: ref => byRef[ref] || null,
					removeMessage: ref => {
						calls.removeStartMessage.push(ref);
						return true;
					},
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
			meta: {
				plugin: { baseOwnId: 'msghub.0.IngestStates.0', regId: 'IngestStates:0' },
			},
		};

		const startWriter = {
			presetId: startEnabled ? 'startPreset' : '',
			onUpsert: (ref, info) => {
				calls.startUpsert.push({ ref, ...info });
				return true;
			},
			onMetrics: (ref, info) => {
				calls.startMetrics.push({ ref, ...info });
				return true;
			},
			onClose: ref => {
				calls.endClose.push({ ref });
				return true;
			},
		};

		const endWriter = {
			presetId: 'endPreset',
			onUpsert: (ref, info) => {
				calls.endUpsert.push({ ref, ...info });
				return true;
			},
			onMetrics: (ref, info) => {
				calls.endMetrics.push({ ref, ...info });
				return true;
			},
			onClose: ref => {
				calls.endClose.push({ ref });
				return true;
			},
		};

		const messageWritersByPresetKey = {
			SessionStartId: startWriter,
			SessionEndId: endWriter,
			DefaultId: endWriter,
			$fallback: endWriter,
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

		return { ctx, messageWritersByPresetKey, timers, calls, byRef };
	}

	it('creates start message, closes previous end message, and emits end message on stop', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({ startEnabled: true });

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new SessionRule({
				ctx,
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
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('counter', { val: 100 });
			rule.onStateChange('price', { val: 2 });

			rule.onStateChange('a.b.c', { val: 60 }); // start

			expect(calls.endClose).to.have.length(1);
			expect(calls.startUpsert).to.have.length(1);
			expect(calls.startUpsert[0].actions.map(a => a.type)).to.deep.equal(['ack', 'snooze', 'delete']);
			expect(calls.startUpsert[0].startAt).to.equal(now);
			expect(calls.startUpsert[0].metrics['state-name']).to.deep.equal({ val: 'c', unit: '' });
			expect(calls.startUpsert[0].metrics['session-start']).to.deep.equal({ val: Date.UTC(2025, 0, 1, 12, 0, 0), unit: 'ms' });
			expect(calls.startUpsert[0].metrics['session-startval']).to.deep.equal({ val: 100, unit: '' });

			now += 10_000;
			rule.onStateChange('counter', { val: 103 });
			rule.onStateChange('a.b.c', { val: 10 }); // stop (immediate)

			expect(calls.endUpsert).to.have.length(1);
			expect(calls.endUpsert[0].actions.map(a => a.type)).to.deep.equal(['ack', 'snooze']);
			expect(calls.endUpsert[0].startAt).to.equal(Date.UTC(2025, 0, 1, 12, 0, 0));
			expect(calls.endUpsert[0].endAt).to.equal(now);
			expect(calls.endUpsert[0].metrics['state-name']).to.deep.equal({ val: 'c', unit: '' });
			expect(calls.endUpsert[0].metrics['session-start']).to.deep.equal({ val: Date.UTC(2025, 0, 1, 12, 0, 0), unit: 'ms' });
			expect(calls.endUpsert[0].metrics['session-startval']).to.deep.equal({ val: 100, unit: '' });
			expect(calls.endUpsert[0].metrics['session-counter']).to.deep.equal({ val: 3, unit: '' });
			expect(calls.endUpsert[0].metrics['session-cost']).to.deep.equal({ val: 6, unit: '' });

			expect(calls.removeStartMessage).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it('uses a persistent startMinHold timer before creating the start message', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({ startEnabled: true });

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new SessionRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					startThreshold: 50,
					startMinHoldValue: 5,
					startMinHoldUnit: 1,
					stopThreshold: 15,
					stopDelayValue: 0,
					stopDelayUnit: 60,
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 60 }); // start candidate

			expect(calls.startUpsert).to.have.length(0);
			expect(calls.timerSet.some(([id, t]) => id === 'sess:startHold:a.b.c' && t.kind === 'session.startHold')).to.equal(true);

			rule.onTimer({ id: 'sess:startHold:a.b.c', at: now + 5000, kind: 'session.startHold', data: { targetId: 'a.b.c' } });

			expect(calls.startUpsert).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it('uses a persistent stopDelay timer before emitting the end message', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({ startEnabled: true });

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new SessionRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					startThreshold: 50,
					startMinHoldValue: 0,
					startMinHoldUnit: 1,
					stopThreshold: 15,
					stopDelayValue: 5,
					stopDelayUnit: 1,
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 60 }); // start
			expect(calls.startUpsert).to.have.length(1);

			now += 1000;
			rule.onStateChange('a.b.c', { val: 10 }); // stop candidate

			expect(calls.endUpsert).to.have.length(0);
			expect(calls.timerSet.some(([id, t]) => id === 'sess:stopDelay:a.b.c' && t.kind === 'session.stopDelay')).to.equal(true);

			now += 5000;
			rule.onTimer({ id: 'sess:stopDelay:a.b.c', at: now, kind: 'session.stopDelay', data: { targetId: 'a.b.c' } });

			expect(calls.endUpsert).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it('ends the session when the gate turns off', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({ startEnabled: true });

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new SessionRule({
				ctx,
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
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('gate', { val: true });
			rule.onStateChange('a.b.c', { val: 60 }); // start
			expect(calls.startUpsert).to.have.length(1);

			now += 1000;
			rule.onStateChange('gate', { val: false }); // gate off -> end session

			expect(calls.endUpsert).to.have.length(1);
			expect(calls.removeStartMessage).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it('always includes state-name metric by falling back to target id segment', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({ startEnabled: true });

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new SessionRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					startThreshold: 50,
					startMinHoldValue: 0,
					startMinHoldUnit: 1,
					stopThreshold: 15,
					stopDelayValue: 0,
					stopDelayUnit: 1,
				},
				messageWritersByPresetKey,
				timers,
			});

			rule._name = '';
			rule.onStateChange('a.b.c', { val: 60 });
			expect(calls.startUpsert).to.have.length(1);
			expect(calls.startUpsert[0].metrics['state-name']).to.deep.equal({ val: 'c', unit: '' });

			now += 5000;
			rule.onStateChange('a.b.c', { val: 10 });
			expect(calls.endUpsert).to.have.length(1);
			expect(calls.endUpsert[0].metrics['state-name']).to.deep.equal({ val: 'c', unit: '' });
		} finally {
			Date.now = originalNow;
		}
	});
});
