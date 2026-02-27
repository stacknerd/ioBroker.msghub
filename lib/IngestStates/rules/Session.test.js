'use strict';

const { expect } = require('chai');
const { format } = require('node:util');
const { SessionRule } = require('./Session');

describe('IngestStates SessionRule', () => {
	function createStubs({ startEnabled = true, foreignStates = {} } = {}) {
		const calls = {
			startUpsert: [],
			startMetrics: [],
			endUpsert: [],
			endMetrics: [],
			endClose: [],
			removeStartMessage: [],
			timerSet: [],
			timerDelete: [],
			logError: [],
		};

		const byRef = {};
		const foreign = new Map(Object.entries(foreignStates));

		const ctx = {
			api: {
				log: { debug: () => undefined, error: msg => calls.logError.push(String(msg || '')) },
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
						getForeignState: async id => {
							if (!foreign.has(id)) {
								return null;
							}
							return { val: foreign.get(id) };
						},
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

	const flushAsync = () => new Promise(resolve => setImmediate(resolve));

	it('does not patch state-name from object meta before any message is active', async () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({ startEnabled: true });
		ctx.api.iobroker.objects.getForeignObject = async () => ({ common: { name: 'My Session' } });

		new SessionRule({
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

		await new Promise(resolve => setImmediate(resolve));
		expect(calls.startMetrics).to.have.length(0);
	});

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
					enableSummary: true,
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
					enableGate: true,
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

	it('patches all session metrics while active', () => {
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
					stopDelayUnit: 60,
					enableSummary: true,
					energyCounterId: 'counter',
					pricePerKwhId: 'price',
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('counter', { val: 100 });
			rule.onStateChange('price', { val: 2 });
			rule.onStateChange('a.b.c', { val: 60 }); // start session
			expect(calls.startUpsert).to.have.length(1);

			now += 10_000;
			rule.onStateChange('counter', { val: 103 });
			rule.onTick(now);

			expect(calls.startMetrics).to.have.length.greaterThan(0);
			const set = calls.startMetrics[calls.startMetrics.length - 1].set;
			expect(set).to.have.property('state-name');
			expect(set).to.have.property('session-start');
			expect(set).to.have.property('session-startval');
			expect(set).to.have.property('session-counter');
			expect(set).to.have.property('session-cost');
		} finally {
			Date.now = originalNow;
		}
	});

	it('ignores gate completely when enableGate=false (including subscriptions)', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({ startEnabled: true });
		const rule = new SessionRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: {
				enableGate: false,
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
		expect(Array.from(rule.requiredStateIds())).to.not.include('gate');

		rule.onStateChange('gate', { val: false });
		rule.onStateChange('a.b.c', { val: 60 });
		expect(calls.startUpsert).to.have.length(1);
	});

	it('uses gate logic when enableGate=true and blocks start on unknown gate with error log', async () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({ startEnabled: true });
		const rule = new SessionRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: {
				enableGate: true,
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
		expect(Array.from(rule.requiredStateIds())).to.include('gate');

		rule.onStateChange('a.b.c', { val: 60 });
		await flushAsync();
		expect(calls.startUpsert).to.have.length(0);
		expect(calls.logError.length).to.be.greaterThan(0);
	});

	it('best-effort gate read can start the session after unknown gate on enableGate=true', async () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({
			startEnabled: true,
			foreignStates: { gate: true },
		});
		const rule = new SessionRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: {
				enableGate: true,
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

		rule.onStateChange('a.b.c', { val: 60 });
		await flushAsync();
		await flushAsync();
		expect(calls.startUpsert).to.have.length(1);
	});

	it('logs error and does not start when enableGate=true but onOffId is empty', async () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({ startEnabled: true });
		const rule = new SessionRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: {
				enableGate: true,
				onOffId: '',
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

		rule.onStateChange('a.b.c', { val: 60 });
		await flushAsync();
		expect(calls.startUpsert).to.have.length(0);
		expect(calls.logError.length).to.be.greaterThan(0);
	});

	it('disables summary completely when enableSummary=false (no subscriptions, no summary metrics)', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({ startEnabled: true });
		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new SessionRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					enableSummary: false,
					energyCounterId: 'counter',
					pricePerKwhId: 'price',
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

			const required = Array.from(rule.requiredStateIds());
			expect(required).to.not.include('counter');
			expect(required).to.not.include('price');

			rule.onStateChange('counter', { val: 100 });
			rule.onStateChange('price', { val: 2 });
			rule.onStateChange('a.b.c', { val: 60 });
			const startKeys = Object.keys(calls.startUpsert[0].metrics).sort();
			expect(startKeys).to.deep.equal(['session-start', 'state-name']);

			rule.onTick(now + 1000);
			const patchKeys = Object.keys(calls.startMetrics[calls.startMetrics.length - 1].set).sort();
			expect(patchKeys).to.deep.equal(['session-start', 'state-name']);

			now += 2000;
			rule.onStateChange('a.b.c', { val: 10 });
			const endKeys = Object.keys(calls.endUpsert[0].metrics).sort();
			expect(endKeys).to.deep.equal(['session-start', 'state-name']);
		} finally {
			Date.now = originalNow;
		}
	});

	it('enables summary metrics only when enableSummary=true (full metric set)', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({ startEnabled: true });
		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new SessionRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					enableSummary: true,
					energyCounterId: 'counter',
					pricePerKwhId: 'price',
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

			const required = Array.from(rule.requiredStateIds());
			expect(required).to.include('counter');
			expect(required).to.include('price');

			rule.onStateChange('counter', { val: 100 });
			rule.onStateChange('price', { val: 2 });
			rule.onStateChange('a.b.c', { val: 60 });

			now += 10_000;
			rule.onStateChange('counter', { val: 103 });
			rule.onTick(now);

			const expectedMetricKeys = ['session-cost', 'session-counter', 'session-start', 'session-startval', 'state-name'];
			expect(Object.keys(calls.startMetrics[calls.startMetrics.length - 1].set).sort()).to.deep.equal(expectedMetricKeys);

			now += 1000;
			rule.onStateChange('a.b.c', { val: 10 });
			expect(Object.keys(calls.endUpsert[0].metrics).sort()).to.deep.equal(expectedMetricKeys);
		} finally {
			Date.now = originalNow;
		}
	});

	it('latches config during active session and applies changed config only after restart', async () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({
			startEnabled: true,
			foreignStates: { 'a.b.c': 60, gate: false, counter: 100, price: 2 },
		});

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new SessionRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					enableGate: false,
					enableSummary: true,
					onOffId: 'gate',
					energyCounterId: 'counter',
					pricePerKwhId: 'price',
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
			rule.onStateChange('counter', { val: 100 });
			rule.onStateChange('price', { val: 2 });
			rule.onStateChange('a.b.c', { val: 60 });
			expect(calls.startUpsert).to.have.length(1);

			// Simulate config change while session is active.
			rule._enableGate = true;
			rule._enableSummary = false;
			rule._gateId = 'gate';
			rule.onStateChange('gate', { val: false });
			now += 1_000;
			rule.onTick(now);

			// Must stay active and still use latched summary=true for this running session.
			expect(calls.endUpsert).to.have.length(0);
			const activePatchKeys = Object.keys(calls.startMetrics[calls.startMetrics.length - 1].set).sort();
			expect(activePatchKeys).to.include('session-counter');
			expect(activePatchKeys).to.include('session-cost');

			// Restart with new config: gate=true required and summary disabled.
			const { ctx: ctx2, messageWritersByPresetKey: writers2, timers: timers2, calls: calls2 } = createStubs({
				startEnabled: true,
				foreignStates: { 'a.b.c': 60, gate: false, counter: 100, price: 2 },
			});
			const restarted = new SessionRule({
				ctx: ctx2,
				targetId: 'a.b.c',
				ruleConfig: {
					enableGate: true,
					enableSummary: false,
					onOffId: 'gate',
					energyCounterId: 'counter',
					pricePerKwhId: 'price',
					startThreshold: 50,
					startMinHoldValue: 0,
					startMinHoldUnit: 1,
					stopThreshold: 15,
					stopDelayValue: 0,
					stopDelayUnit: 1,
				},
				messageWritersByPresetKey: writers2,
				timers: timers2,
			});
			await flushAsync();
			await flushAsync();
			expect(calls2.startUpsert).to.have.length(0);

			restarted.onStateChange('gate', { val: true });
			restarted.onStateChange('a.b.c', { val: 60 });
			expect(calls2.startUpsert).to.have.length(1);
			expect(Object.keys(calls2.startUpsert[0].metrics).sort()).to.deep.equal(['session-start', 'state-name']);
		} finally {
			Date.now = originalNow;
		}
	});

	it('resets persisted start-hold timer on restart and starts a fresh hold window', async () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs({
			startEnabled: true,
			foreignStates: { 'a.b.c': 60 },
		});
		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			timers._timers.set('sess:startHold:a.b.c', {
				at: now - 1_000,
				kind: 'session.startHold',
				data: { targetId: 'a.b.c' },
			});

			new SessionRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					startThreshold: 50,
					startMinHoldValue: 5,
					startMinHoldUnit: 1,
					stopThreshold: 15,
					stopDelayValue: 0,
					stopDelayUnit: 1,
				},
				messageWritersByPresetKey,
				timers,
			});
			await flushAsync();
			expect(calls.timerDelete).to.include('sess:startHold:a.b.c');
			expect(calls.timerSet.some(([id, t]) => id === 'sess:startHold:a.b.c' && t.kind === 'session.startHold' && t.at === now + 5000)).to.equal(true);
			expect(calls.startUpsert).to.have.length(0);
		} finally {
			Date.now = originalNow;
		}
	});

	it('closes persisted active session on restart (no orphan start message) and starts new session only when start conditions are met', async () => {
		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const restartWithActiveTimer = foreignStates => {
				const stubs = createStubs({ startEnabled: true, foreignStates });
				stubs.timers._timers.set('sess:active:a.b.c', {
					at: now + 100_000,
					kind: 'session.active',
					data: { targetId: 'a.b.c', startedAt: now - 60_000 },
				});
				new SessionRule({
					ctx: stubs.ctx,
					targetId: 'a.b.c',
					ruleConfig: {
						startThreshold: 50,
						startMinHoldValue: 0,
						startMinHoldUnit: 1,
						stopThreshold: 15,
						stopDelayValue: 0,
						stopDelayUnit: 1,
					},
					messageWritersByPresetKey: stubs.messageWritersByPresetKey,
					timers: stubs.timers,
				});
				return stubs;
			};

				const met = restartWithActiveTimer({ 'a.b.c': 60 });
				await flushAsync();
				expect(met.calls.timerDelete).to.include('sess:active:a.b.c');
				expect(met.calls.endUpsert).to.have.length(1);
				expect(met.calls.removeStartMessage).to.have.length(1);
				expect(met.calls.startUpsert).to.have.length(1);

				const notMet = restartWithActiveTimer({ 'a.b.c': 10 });
				await flushAsync();
				expect(notMet.calls.timerDelete).to.include('sess:active:a.b.c');
				expect(notMet.calls.endUpsert).to.have.length(1);
				expect(notMet.calls.removeStartMessage).to.have.length(1);
				expect(notMet.calls.startUpsert).to.have.length(0);
			} finally {
				Date.now = originalNow;
			}
		});
});
