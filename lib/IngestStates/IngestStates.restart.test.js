'use strict';

const { expect } = require('chai');
const { format } = require('node:util');
const { IngestStatesEngine } = require('./Engine');

describe('IngestStates integration: scan → create → update → close across restart', () => {
	function createCtx() {
		const calls = {
			setForeignState: [],
			completeAfterCauseEliminated: [],
		};

		const stateById = new Map();
		const byRef = {};

		let viewRows = [];

		function applyMetricsPatch(msg, patch) {
			const prev = msg.metrics instanceof Map ? msg.metrics : new Map();
			const next = new Map(prev);
			const set = patch?.set && typeof patch.set === 'object' ? patch.set : null;
			const del = Array.isArray(patch?.delete) ? patch.delete : [];
			if (set) {
				for (const [k, v] of Object.entries(set)) {
					next.set(k, v);
				}
			}
			for (const k of del) {
				next.delete(k);
			}
			msg.metrics = next;
		}

		const ctx = {
			api: {
				log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
				i18n: { t: (key, ...args) => format(String(key), ...args) },
				iobroker: {
					ids: { namespace: 'msghub.0' },
					objects: {
						getObjectView: async () => ({ rows: viewRows }),
						setObjectNotExists: async () => undefined,
						getForeignObject: async () => ({ common: { name: 'My Sensor', unit: 'W' } }),
					},
					states: {
						getForeignState: async id => stateById.get(id) || null,
						setForeignState: async (id, state) => {
							calls.setForeignState.push({ id, state });
							stateById.set(id, state);
						},
					},
					subscribe: {
						subscribeForeignStates: () => undefined,
						unsubscribeForeignStates: () => undefined,
						subscribeForeignObjects: () => undefined,
						unsubscribeForeignObjects: () => undefined,
					},
				},
				constants: {
					actions: { type: { close: 'close' } },
					kind: { status: 'status' },
					level: { notice: 10 },
					origin: { type: { automation: 'automation' } },
					lifecycle: {
						state: { open: 'open', acked: 'acked', snoozed: 'snoozed', closed: 'closed', expired: 'expired', deleted: 'deleted' },
					},
				},
				factory: {
					createMessage: msg => ({ ...msg, metrics: new Map() }),
				},
				store: {
					getMessageByRef: ref => byRef[ref] || null,
					addOrUpdateMessage: msg => {
						byRef[msg.ref] = msg;
						return true;
					},
					updateMessage: (ref, patch) => {
						const msg = byRef[ref];
						if (!msg) {
							throw new Error('missing');
						}
						if (patch?.metrics) {
							applyMetricsPatch(msg, patch.metrics);
						}
						for (const [k, v] of Object.entries(patch || {})) {
							if (k === 'metrics') {
								continue;
							}
							msg[k] = v;
						}
						return true;
					},
					completeAfterCauseEliminated: (ref, info) => {
						calls.completeAfterCauseEliminated.push({ ref, info });
						const msg = byRef[ref];
						if (!msg) {
							return false;
						}
							msg.lifecycle = {
								state: ctx.api.constants.lifecycle.state.closed,
								stateChangedAt: Date.now(),
								stateChangedBy: info?.actor || '',
							};
							return true;
						},
					removeMessage: ref => {
						delete byRef[ref];
						return true;
					},
				},
			},
			meta: {
				plugin: { baseFullId: 'msghub.0.IngestStates.0', baseOwnId: 'IngestStates.0', instanceId: 0, regId: 'IngestStates:0' },
				options: {
					resolveInt: (_k, v) => (typeof v === 'number' ? v : 0),
					resolveBool: (_k, v) => Boolean(v),
				},
				managedObjects: { report: () => undefined, applyReported: () => undefined },
				resources: {
					setInterval: () => 1,
					setTimeout: () => 1,
					clearTimeout: () => undefined,
					clearInterval: () => undefined,
				},
			},
		};

		return {
			ctx,
			calls,
			stateById,
			byRef,
			setViewRows: rows => {
				viewRows = rows;
			},
		};
	}

	it('survives restart for Threshold minDuration (TimerService) and then closes on recovery', async () => {
		const { ctx, byRef, stateById, setViewRows } = createCtx();

		const originalNow = Date.now;
		const baseNow = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => baseNow;
		try {
			setViewRows([
				{
					id: 'dev.0.target',
					value: {
						'msghub.0': {
							enabled: true,
							mode: 'threshold',
							'thr.mode': 'lt',
							'thr.value': 10,
							'thr.hysteresis': 0,
							'thr.minDurationValue': 5,
							'thr.minDurationUnit': 1,
						},
					},
				},
			]);

			const engine1 = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
			engine1.start();
			await engine1._queue.current;

			// Condition becomes active -> schedules a persistent timer, but does not create a message yet.
			engine1.onStateChange('dev.0.target', { val: 9 }, ctx);
			stateById.set('dev.0.target', { val: 9 });

			// Persist timers state immediately for the test.
			engine1._timers._flushNow();

			const timersState = stateById.get('msghub.0.IngestStates.0.timers');
			expect(timersState).to.be.ok;

			engine1.stop();

			// Restart: create a new engine that loads the persisted timers json.
			const engine2 = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
			engine2.start();
			await engine2._queue.current;
			await new Promise(resolve => setImmediate(resolve));

			const tid = 'thr:dev.0.target';
			const pending = engine2._timers.get(tid);
			expect(pending).to.be.ok;
			expect(pending.kind).to.equal('threshold.minDuration');

			// Simulate a due timer: TimerService normally deletes it before routing.
			engine2._timers.delete(tid);
			engine2._timers._flushNow();

			engine2._onTimer({ id: tid, ...pending });
			await engine2._queue.current;

			const ref = 'IngestStates.0.threshold.dev.0.target';
			expect(byRef[ref]).to.be.ok;
			expect(byRef[ref].lifecycle.state).to.equal(ctx.api.constants.lifecycle.state.open);

			// Recovery -> close immediately (resetDelay=0 by default).
			engine2.onStateChange('dev.0.target', { val: 10 }, ctx);
			expect(byRef[ref].lifecycle.state).to.equal(ctx.api.constants.lifecycle.state.closed);

			engine2.stop();
		} finally {
			Date.now = originalNow;
		}
	});
});
