'use strict';

const { expect } = require('chai');
const { TargetMessageWriter } = require('./MessageWriter');

describe('IngestStates TargetMessageWriter actions', () => {
	function createCtx() {
		const calls = {
			createMessage: [],
			addMessage: [],
			addOrUpdateMessage: [],
			updateMessage: [],
		};

		const byRef = {};

		const ctx = {
			api: {
					constants: {
						actions: { type: { close: 'close' } },
						kind: { status: 'status', task: 'task' },
						level: { notice: 0 },
						origin: { type: { automation: 'automation' } },
						lifecycle: {
						state: {
							open: 'open',
							acked: 'acked',
							snoozed: 'snoozed',
							closed: 'closed',
							expired: 'expired',
							deleted: 'deleted',
						},
					},
				},
				factory: {
					createMessage: msg => {
						calls.createMessage.push(msg);
						return msg;
					},
				},
				store: {
					getMessageByRef: ref => byRef[ref] || null,
					addMessage: msg => {
						calls.addMessage.push(msg);
						byRef[msg.ref] = msg;
						return true;
					},
					addOrUpdateMessage: msg => {
						calls.addOrUpdateMessage.push(msg);
						byRef[msg.ref] = msg;
						return true;
					},
					updateMessage: (ref, patch) => {
						calls.updateMessage.push({ ref, patch });
						if (!byRef[ref]) {
							throw new Error('missing');
						}
						const prev = byRef[ref] || { ref };
						byRef[ref] = { ...prev, ...patch };
						return true;
					},
				},
			},
			meta: {
				plugin: { instanceId: 0, regId: 'IngestStates:0' },
				options: { resolveInt: () => 60_000 },
				resources: {
					setTimeout: () => 1,
					clearTimeout: () => undefined,
				},
			},
		};

		return { ctx, calls, byRef };
	}

	it('does not inject close on create when resetOnNormal=false', () => {
		const { ctx, calls } = createCtx();

			const writer = new TargetMessageWriter(ctx, {
				targetId: 'a.b.c',
				ruleType: 'freshness',
				messageConfig: { resetOnNormal: false },
				startMessageConfig: null,
			});

			writer.openActive({
				defaultTitle: 't',
				defaultText: 'x',
				actions: [
					{ id: 'ack', type: 'ack' },
					{ id: 'snooze', type: 'snooze' },
				],
				now: 1,
			});

			expect(calls.createMessage).to.have.length(1);
			expect(calls.updateMessage).to.have.length(0);
			expect(calls.createMessage[0].actions.map(a => a.type)).to.deep.equal(['ack', 'snooze']);
		});

	it('does not inject close when actions are omitted', () => {
		const { ctx, calls } = createCtx();

		const writer = new TargetMessageWriter(ctx, {
			targetId: 'a.b.c',
			ruleType: 'freshness',
			messageConfig: { resetOnNormal: false },
			startMessageConfig: null,
		});

		writer.openActive({ defaultTitle: 't', defaultText: 'x', now: 1 });

		expect(calls.createMessage).to.have.length(1);
		expect(calls.createMessage[0].actions).to.equal(undefined);
	});

	it('adds close action on closeOnNormal when resetOnNormal=false', () => {
		const { ctx, calls, byRef } = createCtx();

		const writer = new TargetMessageWriter(ctx, {
			targetId: 'a.b.c',
			ruleType: 'freshness',
			messageConfig: { resetOnNormal: false },
			startMessageConfig: null,
		});

		const ref = writer.makeRef();
		byRef[ref] = {
			ref,
			lifecycle: { state: ctx.api.constants.lifecycle.state.acked },
			actions: [{ id: 'ack', type: 'ack' }],
		};

		const ok = writer.closeOnNormal();
		expect(ok).to.equal(true);

		const actionPatches = calls.updateMessage.filter(c => Array.isArray(c.patch.actions));
		expect(actionPatches).to.have.length(1);
		expect(actionPatches[0].patch.actions.map(a => a.type)).to.include.members(['ack', 'close']);
	});
});

describe('IngestStates TargetMessageWriter mappings', () => {
	function createCtx({ metricsMaxIntervalMs = 60_000, freezeMeta = false } = {}) {
		const calls = {
			createMessage: [],
			addMessage: [],
			addOrUpdateMessage: [],
			updateMessage: [],
			completeAfterCauseEliminated: [],
			removeMessage: [],
			setTimeout: [],
			clearTimeout: [],
		};

		const byRef = {};

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

		function applyProgressPatch(msg, patch) {
			const prev = msg.progress && typeof msg.progress === 'object' ? msg.progress : {};
			const next = { ...prev };
			const set = patch?.set && typeof patch.set === 'object' ? patch.set : null;
			const del = Array.isArray(patch?.delete) ? patch.delete : [];

			if (set) {
				for (const [k, v] of Object.entries(set)) {
					next[k] = v;
				}
			}
			for (const k of del) {
				delete next[k];
			}
			msg.progress = next;
			}

			const meta = {
				plugin: { instanceId: 0, regId: 'IngestStates:0' },
				options: { resolveInt: () => metricsMaxIntervalMs },
				resources: {
					setTimeout: (fn, ms) => {
						const handle = { fn, ms };
						calls.setTimeout.push(handle);
						return handle;
					},
					clearTimeout: handle => {
						calls.clearTimeout.push(handle);
					},
				},
			};

			const ctx = {
				api: {
					constants: {
						actions: { type: { close: 'close' } },
						kind: { status: 'status', task: 'task' },
					level: { notice: 10 },
					origin: { type: { automation: 'automation' } },
					lifecycle: {
						state: {
							open: 'open',
							acked: 'acked',
							snoozed: 'snoozed',
							closed: 'closed',
							expired: 'expired',
							deleted: 'deleted',
						},
					},
				},
				factory: {
					createMessage: msg => {
						calls.createMessage.push(msg);
						return {
							...msg,
							metrics: new Map(),
						};
					},
				},
				store: {
					getMessageByRef: ref => byRef[ref] || null,
					addMessage: msg => {
						calls.addMessage.push(msg);
						byRef[msg.ref] = msg;
						return true;
					},
					addOrUpdateMessage: msg => {
						calls.addOrUpdateMessage.push(msg);
						byRef[msg.ref] = msg;
						return true;
					},
					updateMessage: (ref, patch) => {
						calls.updateMessage.push({ ref, patch });
						const msg = byRef[ref];
						if (!msg) {
							throw new Error('missing');
						}

						if (patch?.metrics) {
							applyMetricsPatch(msg, patch.metrics);
						}
						if (patch?.progress) {
							applyProgressPatch(msg, patch.progress);
						}

						for (const [k, v] of Object.entries(patch || {})) {
							if (k === 'metrics' || k === 'progress') {
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
							calls.removeMessage.push(ref);
							delete byRef[ref];
							return true;
						},
					},
				},
				meta: freezeMeta ? Object.freeze(meta) : meta,
			};

			return { ctx, calls, byRef };
		}

		it('does not throw when ctx.meta is not extensible (rooms cache)', () => {
			const { ctx, calls } = createCtx({ freezeMeta: true });
			ctx.api.iobroker = { objects: { getForeignObjects: async () => ({}) } };

			const writer = new TargetMessageWriter(ctx, {
				targetId: 'a.b.c',
				ruleType: 'threshold',
				messageConfig: { kind: 'status', level: 10 },
				startMessageConfig: null,
			});

			expect(() => writer.openActive({ defaultTitle: 't', defaultText: 'x', now: 1 })).to.not.throw();
			expect(calls.createMessage).to.have.length(1);
		});

		it('maps taskDueIn/taskTimeBudget to timing when kind=task', () => {
			const { ctx, calls } = createCtx();
			const writer = new TargetMessageWriter(ctx, {
				targetId: 'a.b.c',
			ruleType: 'threshold',
			messageConfig: {
				kind: 'task',
				taskTimeBudget: 5,
				taskTimeBudgetUnit: 60,
				taskDueIn: 24,
				taskDueInUnit: 3600,
			},
			startMessageConfig: null,
		});

		const now = 1000;
		writer.openActive({ defaultTitle: 't', defaultText: 'x', now });

		expect(calls.createMessage).to.have.length(1);
		expect(calls.createMessage[0].timing.timeBudget).to.equal(5 * 60 * 1000);
		expect(calls.createMessage[0].timing.dueAt).to.equal(now + 24 * 3600 * 1000);
	});

	it('does not map task timing fields when kind!=task', () => {
		const { ctx, calls } = createCtx();
		const writer = new TargetMessageWriter(ctx, {
			targetId: 'a.b.c',
			ruleType: 'threshold',
			messageConfig: {
				kind: 'status',
				taskTimeBudget: 5,
				taskTimeBudgetUnit: 60,
				taskDueIn: 24,
				taskDueInUnit: 3600,
			},
			startMessageConfig: null,
		});

		writer.openActive({ defaultTitle: 't', defaultText: 'x', now: 1 });

		expect(calls.createMessage).to.have.length(1);
		expect(calls.createMessage[0].timing).to.not.have.property('timeBudget');
		expect(calls.createMessage[0].timing).to.not.have.property('dueAt');
	});

	it('does not set dueAt/timeBudget on create when configured durations are 0', () => {
		const { ctx, calls } = createCtx();
		const writer = new TargetMessageWriter(ctx, {
			targetId: 'a.b.c',
			ruleType: 'threshold',
			messageConfig: {
				kind: 'task',
				taskTimeBudget: 0,
				taskTimeBudgetUnit: 60,
				taskDueIn: 0,
				taskDueInUnit: 3600,
			},
			startMessageConfig: null,
		});

		writer.openActive({ defaultTitle: 't', defaultText: 'x', now: 1 });

		expect(calls.createMessage).to.have.length(1);
		expect(calls.createMessage[0].timing).to.not.have.property('timeBudget');
		expect(calls.createMessage[0].timing).to.not.have.property('dueAt');
	});

		it('fills details.location from enum.rooms membership and preserves other details', () => {
			const { ctx, calls } = createCtx();
			ctx.api.iobroker = {
				objects: {
					getForeignObjects: () => ({
						'enum.rooms.kitchen': {
							_id: 'enum.rooms.kitchen',
							type: 'enum',
							common: { name: 'Kitchen', members: ['a.b'] },
						},
					}),
				},
			};

			const writer = new TargetMessageWriter(ctx, {
				targetId: 'a.b.c',
				ruleType: 'freshness',
			messageConfig: {},
			startMessageConfig: null,
		});

		writer.openActive({
			defaultTitle: 't',
			defaultText: 'x',
			now: 1,
			details: { reason: 'test' },
		});

			expect(calls.createMessage).to.have.length(1);
			expect(calls.createMessage[0].details).to.deep.equal({ reason: 'test', location: 'Kitchen' });
		});

		it('patches details.location after async room index load', async () => {
			const { ctx, calls, byRef } = createCtx();
			ctx.api.iobroker = {
				objects: {
					getForeignObjects: () =>
						Promise.resolve({
							'enum.rooms.kitchen': {
								_id: 'enum.rooms.kitchen',
								type: 'enum',
								common: { name: 'Kitchen', members: ['a.b'] },
							},
						}),
				},
			};

			const writer = new TargetMessageWriter(ctx, {
				targetId: 'a.b.c',
				ruleType: 'freshness',
				messageConfig: {},
				startMessageConfig: null,
			});

			writer.openActive({
				defaultTitle: 't',
				defaultText: 'x',
				now: 1,
				details: { reason: 'test' },
			});

			expect(calls.createMessage).to.have.length(1);
			const ref = calls.createMessage[0].ref;
			expect(byRef[ref].details).to.deep.equal({ reason: 'test' });

			await new Promise(resolve => setImmediate(resolve));

			const detailPatches = calls.updateMessage
				.filter(c => c.ref === ref)
				.map(c => c.patch)
				.filter(p => p && p.details);
			expect(detailPatches).to.have.length(1);
			expect(detailPatches[0].details).to.deep.equal({ reason: 'test', location: 'Kitchen' });
		});

		it('patches details.location for already-active messages', () => {
			const { ctx, calls, byRef } = createCtx();
			ctx.api.iobroker = {
				objects: {
					getForeignObjects: () => ({
						'enum.rooms.kitchen': {
							_id: 'enum.rooms.kitchen',
							type: 'enum',
							common: { name: 'Kitchen', members: ['a.b'] },
						},
					}),
				},
			};

			const writer = new TargetMessageWriter(ctx, {
				targetId: 'a.b.c',
				ruleType: 'freshness',
			messageConfig: {},
			startMessageConfig: null,
		});

		const ref = writer.makeRef();
		byRef[ref] = {
			ref,
			kind: 'status',
			lifecycle: { state: ctx.api.constants.lifecycle.state.acked },
			details: { reason: 'test' },
			timing: { notifyAt: 1 },
		};

		writer.openActive({ defaultTitle: 't', defaultText: 'x', now: 1 });

		const detailPatches = calls.updateMessage
			.filter(c => c.ref === ref)
			.map(c => c.patch)
			.filter(p => p && p.details);
		expect(detailPatches).to.have.length(1);
		expect(detailPatches[0].details).to.deep.equal({ reason: 'test', location: 'Kitchen' });
	});

	it('maps remindValue/unit to timing.remindEvery', () => {
		const { ctx, calls } = createCtx();
		const writer = new TargetMessageWriter(ctx, {
			targetId: 'a.b.c',
			ruleType: 'threshold',
			messageConfig: { remindValue: 5, remindUnit: 60 },
			startMessageConfig: null,
		});

		writer.openActive({ defaultTitle: 't', defaultText: 'x', now: 1000 });

		expect(calls.createMessage).to.have.length(1);
		expect(calls.createMessage[0].timing.remindEvery).to.equal(5 * 60 * 1000);
		expect(calls.createMessage[0].timing.notifyAt).to.equal(1000);
	});

	it('reopens silently during cooldown when reminders are off', () => {
		const { ctx, calls, byRef } = createCtx();
		const writer = new TargetMessageWriter(ctx, {
			targetId: 'a.b.c',
			ruleType: 'threshold',
			messageConfig: { cooldownValue: 1, cooldownUnit: 60, remindValue: 0, remindUnit: 60 },
			startMessageConfig: null,
		});

		const now = 100_000;
		const ref = writer.makeRef();
		byRef[ref] = {
			ref,
			metrics: new Map(),
			actions: [],
			lifecycle: { state: ctx.api.constants.lifecycle.state.closed, stateChangedAt: now - 10_000 },
		};

		writer.openActive({ defaultTitle: 't', defaultText: 'x', now });

		const patches = calls.updateMessage.filter(c => c.ref === ref);
		const reopenPatch = patches.map(p => p.patch).find(p => p && p.lifecycle);
		expect(reopenPatch).to.be.ok;

		const patch = reopenPatch;
		expect(patch.lifecycle.state).to.equal(ctx.api.constants.lifecycle.state.open);
		expect(patch.timing.notifyAt).to.equal(now + 10 * 365 * 24 * 60 * 60 * 1000);
	});

		it('reopens during cooldown and delays notifyAt when reminders are enabled', () => {
			const { ctx, calls, byRef } = createCtx();
			const writer = new TargetMessageWriter(ctx, {
				targetId: 'a.b.c',
				ruleType: 'threshold',
			messageConfig: { cooldownValue: 1, cooldownUnit: 60, remindValue: 5, remindUnit: 60 },
			startMessageConfig: null,
		});

		const now = 100_000;
		const ref = writer.makeRef();
		const closedAt = now - 10_000;
		const cooldownMs = 60_000;
		byRef[ref] = {
			ref,
			metrics: new Map(),
			actions: [],
			lifecycle: { state: ctx.api.constants.lifecycle.state.closed, stateChangedAt: closedAt },
		};

		writer.openActive({ defaultTitle: 't', defaultText: 'x', now });

		const patches = calls.updateMessage.filter(c => c.ref === ref);
		const reopenPatch = patches.map(p => p.patch).find(p => p && p.lifecycle);
		expect(reopenPatch).to.be.ok;

		const patch = reopenPatch;
			expect(patch.timing.remindEvery).to.equal(5 * 60 * 1000);
			expect(patch.timing.notifyAt).to.equal(closedAt + cooldownMs);
		});

	it('reopens during cooldown from deleted status messages and delays notifyAt', () => {
		const { ctx, calls, byRef } = createCtx();
		const writer = new TargetMessageWriter(ctx, {
			targetId: 'a.b.c',
			ruleType: 'threshold',
			messageConfig: { cooldownValue: 1, cooldownUnit: 60, remindValue: 5, remindUnit: 60 },
			startMessageConfig: null,
		});

			const now = 100_000;
			const ref = writer.makeRef();
			const deletedAt = now - 10_000;
			const cooldownMs = 60_000;
			byRef[ref] = {
				ref,
				metrics: new Map(),
				actions: [],
				lifecycle: { state: ctx.api.constants.lifecycle.state.deleted, stateChangedAt: deletedAt },
			};

		writer.openActive({ defaultTitle: 't', defaultText: 'x', now });

		expect(calls.createMessage).to.have.length(1);
		expect(calls.addMessage).to.have.length(1);

		const created = calls.createMessage[0];
		expect(created.timing.remindEvery).to.equal(5 * 60 * 1000);
		expect(created.timing.notifyAt).to.equal(deletedAt + cooldownMs);
	});

	it('persists resetDelay schedule in metrics and closes when due', () => {
		const { ctx, calls, byRef } = createCtx();
		const writer = new TargetMessageWriter(ctx, {
			targetId: 'a.b.c',
			ruleType: 'freshness',
			messageConfig: { resetOnNormal: true, resetDelayValue: 5, resetDelayUnit: 60 },
			startMessageConfig: null,
		});

		const now = 100_000;
		const ref = writer.makeRef();
		byRef[ref] = {
			ref,
			metrics: new Map(),
			lifecycle: { state: ctx.api.constants.lifecycle.state.open, stateChangedAt: now },
		};

			writer.closeOnNormal();

		const metricKey = `IngestStates.${ctx.meta.plugin.instanceId}.freshness.a.b.c.resetAt`;
		expect(byRef[ref].metrics.has(metricKey)).to.equal(true);

		// Simulate a restart: timer is lost, but the persisted metric remains.
		const dueAt = now - 1;
		byRef[ref].metrics.set(metricKey, { val: dueAt, unit: 'ms', ts: now });

		const ok = writer.tryCloseScheduled({ now });
		expect(ok).to.equal(true);
		expect(calls.completeAfterCauseEliminated).to.have.length(1);
		expect(byRef[ref].metrics.has(metricKey)).to.equal(false);
	});

	it('patchMetrics does change detection and throttling', () => {
		const { ctx, calls, byRef } = createCtx({ metricsMaxIntervalMs: 60_000 });
		const writer = new TargetMessageWriter(ctx, {
			targetId: 'a.b.c',
			ruleType: 'threshold',
			messageConfig: {},
			startMessageConfig: null,
		});

		const ref = writer.makeRef();
		byRef[ref] = {
			ref,
			metrics: new Map([['state-value', { val: 1, unit: 'W', ts: 0 }]]),
			lifecycle: { state: ctx.api.constants.lifecycle.state.open, stateChangedAt: 0 },
		};

		const now = 1000;
		expect(writer.patchMetrics({ set: { 'state-value': { val: 1, unit: 'W' } }, now })).to.equal(false);
		expect(writer.patchMetrics({ set: { 'state-value': { val: 2, unit: 'W' } }, now })).to.equal(true);

		// Throttled.
		expect(writer.patchMetrics({ set: { 'state-value': { val: 3, unit: 'W' } }, now: now + 1000 })).to.equal(
			false,
		);
		expect(writer.patchMetrics({ set: { 'state-value': { val: 3, unit: 'W' } }, now: now + 1000, force: true })).to.equal(
			true,
		);

		expect(calls.updateMessage.filter(c => c.ref === ref)).to.have.length.greaterThan(0);
	});
});
