'use strict';

const { expect } = require('chai');
const { TargetMessageWriter } = require('./MessageWriter');

describe('IngestStates TargetMessageWriter', () => {
	function createCtx({ metricsMaxIntervalMs = 60_000 } = {}) {
		const calls = {
			createMessage: [],
			addMessage: [],
			updateMessage: [],
			completeAfterCauseEliminated: [],
		};

		const byRef = {};

		function applyMetricsPatch(prevMsg, metricsPatch) {
			const prev = prevMsg.metrics instanceof Map ? prevMsg.metrics : new Map();
			const next = new Map(prev);

			const set = metricsPatch?.set && typeof metricsPatch.set === 'object' ? metricsPatch.set : null;
			if (set) {
				for (const [k, v] of Object.entries(set)) {
					next.set(k, v);
				}
			}

			const del = Array.isArray(metricsPatch?.delete) ? metricsPatch.delete : [];
			for (const k of del) {
				next.delete(k);
			}

			prevMsg.metrics = next;
		}

		function applyUpdatePatch(ref, patch) {
			const prev = byRef[ref];
			const next = { ...prev };

			for (const [k, v] of Object.entries(patch || {})) {
				if (k === 'metrics') {
					applyMetricsPatch(next, v);
					continue;
				}
				if (k === 'timing' && v && typeof v === 'object' && !Array.isArray(v)) {
					next.timing = { ...(prev.timing || {}), ...v };
					continue;
				}
				next[k] = v;
			}

			byRef[ref] = next;
		}

		const ctx = {
			api: {
				constants: {
					actions: { type: { close: 'close' } },
					kind: { status: 'status', task: 'task' },
					origin: { type: { automation: 'automation' } },
					lifecycle: { state: { open: 'open' } },
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
					updateMessage: (ref, patch) => {
						calls.updateMessage.push({ ref, patch });
						if (!byRef[ref]) {
							return false;
						}
						applyUpdatePatch(ref, patch);
						return true;
					},
					completeAfterCauseEliminated: (ref, info) => {
						calls.completeAfterCauseEliminated.push({ ref, info });
						return true;
					},
				},
			},
			meta: {
				plugin: { instanceId: 0, regId: 'IngestStates:0' },
				options: { resolveInt: (_k, def) => (typeof def === 'number' ? metricsMaxIntervalMs : metricsMaxIntervalMs) },
			},
		};

		return { ctx, calls, byRef };
	}

	function makePreset(overrides = {}) {
			const base = {
				schema: 'msghub.IngestStatesMessagePreset.v1',
				presetId: 'p1',
				description: '',
				ownedBy: null,
				message: {
					kind: 'status',
					level: 20,
				title: 'T',
				text: 'X',
				timing: { remindEvery: 0, cooldown: 0, timeBudget: 0, dueInMs: 0 },
				details: { task: '', reason: '', tools: [], consumables: [] },
				audience: { tags: [], channels: { include: [], exclude: [] } },
				actions: [],
			},
			policy: { resetOnNormal: true },
			ui: {},
		};

		const preset = { ...base, ...(overrides || {}) };
		preset.message = { ...base.message, ...(overrides.message || {}) };
		preset.message.timing = { ...base.message.timing, ...(overrides.message?.timing || {}) };
		preset.message.details = { ...base.message.details, ...(overrides.message?.details || {}) };
		preset.message.audience = { ...base.message.audience, ...(overrides.message?.audience || {}) };
		preset.policy = { ...base.policy, ...(overrides.policy || {}) };
		return preset;
	}

	it('creates message from preset (timing/details/location/actions/metrics)', () => {
		const { ctx, calls, byRef } = createCtx();

		const preset = makePreset({
			presetId: 'p1',
			message: {
				icon: '🧊',
				title: 'Line 1\\nLine 2',
				text: 'A\\r\\nB\\nC',
				actions: [{ id: 'open', type: 'open' }],
				timing: { remindEvery: 60_000, cooldown: 15_000, timeBudget: 10_000, dueInMs: 5_000 },
				details: { task: 'do', reason: 'because' },
			},
			policy: { resetOnNormal: true },
		});

		const presetProvider = { getPreset: () => preset };
		const locationProvider = { getLocation: () => 'Kitchen' };

		const writer = new TargetMessageWriter(ctx, {
			targetId: '0_userdata.0.s1',
			presetKey: 'DefaultId',
			presetId: 'p1',
			presetProvider,
			locationProvider,
		});

		const ref = 'r1';
		const ok = writer.onUpsert(ref, {
			now: 100,
			startAt: 1000,
			notifyAt: 2000,
			actions: [{ id: 'ack', type: 'ack' }],
			metrics: { temp: { val: 21, unit: 'C' } },
		});

		expect(ok).to.equal(true);
		expect(calls.createMessage).to.have.length(1);
		expect(calls.addMessage).to.have.length(1);

		const created = byRef[ref];
		expect(created.title).to.equal('Line 1\nLine 2');
		expect(created.text).to.equal('A\nB\nC');
		expect(created.icon).to.equal('🧊');

		expect(created.timing).to.include({
			notifyAt: 2000,
			startAt: 1000,
			remindEvery: 60_000,
			cooldown: 15_000,
			timeBudget: 10_000,
			dueAt: 1000 + 5_000,
		});

		expect(created.details).to.include({ task: 'do', reason: 'because', location: 'Kitchen' });
		expect(created.actions.map(a => a.id)).to.deep.equal(['ack', 'open']);

		expect(created.metrics).to.be.instanceof(Map);
		expect(created.metrics.get('temp')).to.deep.include({ val: 21, unit: 'C', ts: 100 });
	});

	it('patches only changed fields (no audience/lifecycle/notifyAt/startAt patch)', () => {
		const { ctx, calls, byRef } = createCtx();

		const preset = makePreset({
			presetId: 'p1',
			message: {
				level: 30,
				title: 'new title',
				text: 'new text',
				actions: [{ id: 'open', type: 'open' }],
				timing: { remindEvery: 1000, cooldown: 2000, timeBudget: 10_000, dueInMs: 5_000 },
			},
		});
		const presetProvider = { getPreset: () => preset };

		const writer = new TargetMessageWriter(ctx, {
			targetId: '0_userdata.0.s1',
			presetKey: 'DefaultId',
			presetId: 'p1',
			presetProvider,
			locationProvider: { getLocation: () => '' },
		});

		const ref = 'r2';
		byRef[ref] = {
			ref,
			kind: 'status',
			level: 20,
			title: 'old title',
			text: 'old text',
			audience: { tags: ['x'] },
			lifecycle: { state: 'open' },
			timing: { notifyAt: 123, startAt: 1000, remindEvery: null, cooldown: null, timeBudget: null, dueAt: null },
			actions: [],
			metrics: new Map([['temp', { val: 21, unit: 'C', ts: 1 }]]),
		};

		const ok = writer.onUpsert(ref, {
			now: 200,
			startAt: 9999,
			notifyAt: 9999,
			metrics: { temp: { val: 21, unit: 'C' }, hum: { val: 50, unit: '%' } },
		});

		expect(ok).to.equal(true);
		expect(calls.updateMessage).to.have.length(1);

		const patch = calls.updateMessage[0].patch;
		expect(patch).to.not.have.property('audience');
		expect(patch).to.not.have.property('lifecycle');
		expect(patch).to.not.have.nested.property('timing.notifyAt');
		expect(patch).to.not.have.nested.property('timing.startAt');

		expect(patch).to.include({ title: 'new title', text: 'new text', level: 30 });
		expect(patch).to.have.nested.property('timing.remindEvery', 1000);
		expect(patch).to.have.nested.property('timing.cooldown', 2000);
		expect(patch).to.not.have.nested.property('timing.timeBudget');
		expect(patch).to.not.have.nested.property('timing.dueAt');

		expect(patch.actions).to.deep.equal([{ id: 'open', type: 'open' }]);
		expect(patch.metrics).to.have.nested.property('set.hum.val', 50);
		expect(patch.metrics).to.not.have.nested.property('set.temp');
	});

	it('patches icon when preset defines it and clears when missing', () => {
		const { ctx, calls, byRef } = createCtx();

		const ref = 'r_icon_1';
		byRef[ref] = { ref, kind: 'status', level: 20, title: 't', text: 'x', icon: '🔥', timing: {}, actions: [] };

		const writerSet = new TargetMessageWriter(ctx, {
			targetId: '0_userdata.0.s1',
			presetKey: 'DefaultId',
			presetId: 'p1',
			presetProvider: { getPreset: () => makePreset({ message: { title: 't', text: 'x', level: 20, icon: '🧊' } }) },
		});

		const ok1 = writerSet.onUpsert(ref, { now: 1, startAt: 1 });
		expect(ok1).to.equal(true);
		expect(calls.updateMessage).to.have.length(1);
		expect(calls.updateMessage[0].patch).to.have.property('icon', '🧊');

		const writerClear = new TargetMessageWriter(ctx, {
			targetId: '0_userdata.0.s1',
			presetKey: 'DefaultId',
			presetId: 'p1',
			presetProvider: {
				getPreset: () => {
					const p = makePreset({ message: { title: 't', text: 'x', level: 20 } });
					delete p.message.icon;
					return p;
				},
			},
		});

		const ok2 = writerClear.onUpsert(ref, { now: 2, startAt: 2 });
		expect(ok2).to.equal(true);
		expect(calls.updateMessage).to.have.length(2);
		expect(calls.updateMessage[1].patch).to.have.property('icon', null);
	});

	it('does not patch timeBudget/dueAt (user-editable timing)', () => {
		const { ctx, calls, byRef } = createCtx();

		const preset = makePreset({
			message: {
				title: 't',
				text: 'x',
				level: 20,
				timing: { remindEvery: 0, cooldown: 0, timeBudget: 10_000, dueInMs: 5_000 },
			},
		});

		const writer = new TargetMessageWriter(ctx, {
			targetId: '0_userdata.0.s1',
			presetKey: 'DefaultId',
			presetId: 'p1',
			presetProvider: { getPreset: () => preset },
		});

		const ref = 'r3';
		byRef[ref] = {
			ref,
			kind: 'status',
			level: 20,
			title: 't',
			text: 'x',
			timing: { startAt: 1000, dueAt: 123, timeBudget: 456, remindEvery: null, cooldown: null },
			metrics: new Map(),
			actions: [],
			details: preset.message.details,
		};

		const ok1 = writer.onUpsert(ref, { now: 200, startAt: 9999 });
		expect(ok1).to.equal(false);
		expect(calls.updateMessage).to.have.length(0);

		const preset2 = makePreset({
			message: {
				title: 't',
				text: 'x',
				level: 20,
				timing: { remindEvery: 0, cooldown: 0, timeBudget: 22_000, dueInMs: 7_000 },
			},
		});
		const writer2 = new TargetMessageWriter(ctx, {
			targetId: '0_userdata.0.s1',
			presetKey: 'DefaultId',
			presetId: 'p1',
			presetProvider: { getPreset: () => preset2 },
		});

		const ok2 = writer2.onUpsert(ref, { now: 201, startAt: 9999 });
		expect(ok2).to.equal(false);
		expect(calls.updateMessage).to.have.length(0);
	});

	it('patches metrics with throttling and supports deletes', () => {
		const { ctx, calls, byRef } = createCtx({ metricsMaxIntervalMs: 60_000 });

		const writer = new TargetMessageWriter(ctx, {
			targetId: '0_userdata.0.s1',
			presetKey: 'DefaultId',
			presetId: 'p1',
			presetProvider: { getPreset: () => makePreset() },
		});

		const ref = 'r4';
		byRef[ref] = {
			ref,
			kind: 'status',
			level: 20,
			title: 't',
			text: 'x',
			timing: {},
			metrics: new Map([['a', { val: 1, unit: '', ts: 1 }]]),
		};

		const ok1 = writer.onMetrics(ref, { set: { a: { val: 2, unit: '' } }, now: 10_000 });
		expect(ok1).to.equal(true);
		expect(calls.updateMessage).to.have.length(1);

		const ok2 = writer.onMetrics(ref, { set: { a: { val: 3, unit: '' } }, now: 10_001 });
		expect(ok2).to.equal(false);

		const ok3 = writer.onMetrics(ref, { set: { a: { val: 4, unit: '' } }, now: 10_002, force: true });
		expect(ok3).to.equal(true);
		expect(calls.updateMessage).to.have.length(2);

		const ok4 = writer.onMetrics(ref, { delete: ['a'], now: 20_000, force: true });
		expect(ok4).to.equal(true);
		expect(calls.updateMessage).to.have.length(3);
		expect(calls.updateMessage[2].patch).to.have.nested.property('metrics.delete').that.deep.equals(['a']);
	});

	it('close behavior: resetOnNormal=false adds close action; resetOnNormal=true completes', () => {
		const { ctx, calls, byRef } = createCtx();

		const writerKeepOpen = new TargetMessageWriter(ctx, {
			targetId: '0_userdata.0.s1',
			presetKey: 'DefaultId',
			presetId: 'p1',
			presetProvider: { getPreset: () => makePreset({ policy: { resetOnNormal: false } }) },
		});

		const ref1 = 'r5';
		byRef[ref1] = {
			ref: ref1,
			actions: [{ id: 'ack', type: 'ack' }],
			timing: { remindEvery: 123 },
		};

		const ok1 = writerKeepOpen.onClose(ref1);
		expect(ok1).to.equal(true);
		expect(calls.updateMessage).to.have.length(1);
		expect(calls.updateMessage[0].patch.actions.map(a => a.id)).to.deep.equal(['ack', 'close']);
		expect(calls.updateMessage[0].patch).to.have.nested.property('timing.remindEvery', null);

		const writerAutoClose = new TargetMessageWriter(ctx, {
			targetId: '0_userdata.0.s1',
			presetKey: 'DefaultId',
			presetId: 'p1',
			presetProvider: { getPreset: () => makePreset({ policy: { resetOnNormal: true } }) },
		});

		const ref2 = 'r6';
		byRef[ref2] = { ref: ref2, timing: {}, actions: [] };

		const ok2 = writerAutoClose.onClose(ref2);
		expect(ok2).to.equal(true);
		expect(calls.completeAfterCauseEliminated).to.have.length(1);
	});

	it('switches to textRecovered on close and back to text on next upsert', () => {
		const { ctx, calls, byRef } = createCtx();
		const preset = makePreset({
			message: {
				title: 'Normal title',
				text: 'Normal text',
				textRecovered: 'Recovered text',
				level: 20,
			},
			policy: { resetOnNormal: false },
		});
		const writer = new TargetMessageWriter(ctx, {
			targetId: '0_userdata.0.s1',
			presetKey: 'DefaultId',
			presetId: 'p1',
			presetProvider: { getPreset: () => preset },
		});

		const ref = 'r_text_flip';
		byRef[ref] = {
			ref,
			kind: 'status',
			level: 20,
			title: 'Normal title',
			text: 'Normal text',
			timing: { remindEvery: 123 },
			actions: [{ id: 'ack', type: 'ack' }],
			metrics: new Map(),
		};

		const closeOk = writer.onClose(ref);
		expect(closeOk).to.equal(true);
		expect(calls.updateMessage).to.have.length(1);
		expect(calls.updateMessage[0].patch).to.have.property('text', 'Recovered text');
		expect(calls.updateMessage[0].patch.actions.map(a => a.id)).to.deep.equal(['ack', 'close']);

		const upsertOk = writer.onUpsert(ref, { now: 200, startAt: 1000 });
		expect(upsertOk).to.equal(true);
		expect(calls.updateMessage).to.have.length(2);
		expect(calls.updateMessage[1].patch).to.have.property('text', 'Normal text');
	});
});
