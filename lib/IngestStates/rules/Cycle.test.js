'use strict';

const { expect } = require('chai');
const { CycleRule } = require('./Cycle');

describe('IngestStates CycleRule', () => {
	function createHarness({ period = 25, timeMs = 0 } = {}) {
		const calls = {
			onUpsert: [],
			onMetrics: [],
			onClose: [],
			setForeignState: [],
			setObjectNotExists: [],
			completeAfterCauseEliminated: [],
		};

		const stateById = new Map();

		const ctx = {
			api: {
				constants: { actions: { type: { close: 'close' } } },
				log: { debug: () => undefined },
				iobroker: {
					objects: {
						setObjectNotExists: async (id, obj) => {
							calls.setObjectNotExists.push([id, obj]);
						},
						getForeignObject: async () => ({ common: { name: 'My Counter', unit: 'x' } }),
					},
					states: {
						getForeignState: async id => (stateById.has(id) ? stateById.get(id) : null),
						setForeignState: async (id, st) => {
							stateById.set(id, st);
							calls.setForeignState.push([id, st]);
						},
					},
				},
				store: {
					completeAfterCauseEliminated: (ref, info) => {
						calls.completeAfterCauseEliminated.push([ref, info]);
						return true;
					},
				},
			},
			meta: {
				plugin: { baseOwnId: 'IngestStates.0', baseFullId: 'msghub.0.IngestStates.0' },
			},
		};

		const writer = {
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

		const messageWritersByPresetKey = { CycleId: writer, DefaultId: writer, $fallback: writer };

		const cfg = { period, time: timeMs ? Math.trunc(timeMs / 1000) : 0, timeUnit: 1 };

		return { ctx, messageWritersByPresetKey, calls, stateById, cfg };
	}

	it('does not patch state-name from object meta before any message is active', async () => {
		const { ctx, messageWritersByPresetKey, calls, cfg } = createHarness({ period: 5 });
		new CycleRule({ ctx, targetId: 'linkeddevices.0.a.b.counter', ruleConfig: cfg, messageWritersByPresetKey });

		await new Promise(resolve => setImmediate(resolve));
		expect(calls.onMetrics).to.have.length(0);
	});

	it('accumulates deltas and opens when period is reached', async () => {
		const { ctx, messageWritersByPresetKey, calls, stateById, cfg } = createHarness({ period: 5 });

		const targetId = 'linkeddevices.0.a.b.counter';
		const baseFull = `msghub.0.IngestStates.0.cycle.${targetId}`;
		stateById.set(`${baseFull}.lastCounter`, { val: 10, ack: true });
		stateById.set(`${baseFull}.subCounter`, { val: 0, ack: true });
		stateById.set(`${baseFull}.lastResetAt`, { val: Date.UTC(2025, 0, 1, 0, 0, 0), ack: true });

		const rule = new CycleRule({ ctx, targetId, ruleConfig: cfg, messageWritersByPresetKey });
		await new Promise(resolve => setImmediate(resolve));

		rule.onStateChange(targetId, { val: 15 });

		// subCounter should now be 5 and the message should open.
		expect(calls.onUpsert).to.have.length(1);
		expect(calls.onUpsert[0].ref).to.equal(`IngestStates.0.cycle.${targetId}`);
		expect(calls.onUpsert[0].metrics['state-name'].unit).to.equal('');
		expect(['counter', 'My Counter']).to.include(calls.onUpsert[0].metrics['state-name'].val);
		expect(calls.onUpsert[0].metrics['cycle-subCounter'].val).to.equal(5);
		expect(calls.onUpsert[0].actions.map(a => a.type)).to.include('close');
		expect(calls.onMetrics).to.have.length.greaterThan(0);
		expect(calls.onMetrics[0].set['state-name'].unit).to.equal('');
		expect(['counter', 'My Counter']).to.include(calls.onMetrics[0].set['state-name'].val);

		// Decrease does not subtract, but updates lastCounter.
		rule.onStateChange(targetId, { val: 2 });
		rule.onStateChange(targetId, { val: 3 });
		await new Promise(resolve => setImmediate(resolve));

		const lastSub = calls.setForeignState
			.filter(c => c[0] === `${baseFull}.subCounter`)
			.slice(-1)[0]?.[1]?.val;
		expect(lastSub).to.equal(6);
	});

	it('patches all cycle metrics while active', async () => {
		const { ctx, messageWritersByPresetKey, calls, stateById, cfg } = createHarness({ period: 5, timeMs: 60_000 });

		const targetId = 'linkeddevices.0.a.b.counter';
		const baseFull = `msghub.0.IngestStates.0.cycle.${targetId}`;
		const resetAt = Date.UTC(2025, 0, 1, 0, 0, 0);
		stateById.set(`${baseFull}.lastCounter`, { val: 10, ack: true });
		stateById.set(`${baseFull}.subCounter`, { val: 5, ack: true }); // already due
		stateById.set(`${baseFull}.lastResetAt`, { val: resetAt, ack: true });

		const rule = new CycleRule({ ctx, targetId, ruleConfig: cfg, messageWritersByPresetKey });
		await new Promise(resolve => setImmediate(resolve));

		rule.onTick(resetAt + 1);
		expect(calls.onUpsert).to.have.length(1);
		expect(calls.onMetrics).to.have.length.greaterThan(0);

		const patch = calls.onMetrics[calls.onMetrics.length - 1].set;
		expect(patch).to.have.property('state-name');
		expect(patch).to.have.property('cycle-lastResetAt');
		expect(patch).to.have.property('cycle-subCounter');
		expect(patch).to.have.property('cycle-period');
		expect(patch).to.have.property('cycle-remaining');
		expect(patch).to.have.property('cycle-timeMs');
		expect(patch).to.have.property('cycle-timeBasedDueAt');
	});

	it('patches no cycle metrics in good-state', async () => {
		const { ctx, messageWritersByPresetKey, calls, stateById, cfg } = createHarness({ period: 50, timeMs: 0 });

		const targetId = 'linkeddevices.0.a.b.counter';
		const baseFull = `msghub.0.IngestStates.0.cycle.${targetId}`;
		const resetAt = Date.UTC(2025, 0, 1, 0, 0, 0);
		stateById.set(`${baseFull}.lastCounter`, { val: 10, ack: true });
		stateById.set(`${baseFull}.subCounter`, { val: 1, ack: true }); // far below threshold
		stateById.set(`${baseFull}.lastResetAt`, { val: resetAt, ack: true });

		const rule = new CycleRule({ ctx, targetId, ruleConfig: cfg, messageWritersByPresetKey });
		await new Promise(resolve => setImmediate(resolve));

		rule.onTick(Date.now());
		expect(calls.onUpsert).to.have.length(0);
		expect(calls.onMetrics).to.have.length(0);
	});

	it('treats subCounter=0 (ack:false) as external reset request and completes the message', async () => {
		const { ctx, messageWritersByPresetKey, calls, stateById, cfg } = createHarness({ period: 5 });

		const targetId = 'linkeddevices.0.a.b.counter';
		const baseFull = `msghub.0.IngestStates.0.cycle.${targetId}`;
		stateById.set(`${baseFull}.lastCounter`, { val: 10, ack: true });
		stateById.set(`${baseFull}.subCounter`, { val: 5, ack: true });
		stateById.set(`${baseFull}.lastResetAt`, { val: Date.UTC(2025, 0, 1, 0, 0, 0), ack: true });

		const rule = new CycleRule({ ctx, targetId, ruleConfig: cfg, messageWritersByPresetKey });
		await new Promise(resolve => setImmediate(resolve));

		// Ensure active.
		rule.onTick(Date.now());
		expect(calls.onUpsert.length).to.be.at.least(1);

		rule.onStateChange(`${baseFull}.subCounter`, { val: 0, ack: false, from: 'system.adapter.test' });
		expect(calls.completeAfterCauseEliminated).to.have.length(1);
		expect(calls.completeAfterCauseEliminated[0][0]).to.equal(`IngestStates.0.cycle.${targetId}`);
	});

	it('resets internal counters on close action for its own ref', async () => {
		const { ctx, messageWritersByPresetKey, calls, stateById, cfg } = createHarness({ period: 5 });

		const targetId = 'linkeddevices.0.a.b.counter';
		const baseFull = `msghub.0.IngestStates.0.cycle.${targetId}`;
		stateById.set(`${baseFull}.subCounter`, { val: 5, ack: true });
		stateById.set(`${baseFull}.lastResetAt`, { val: Date.UTC(2025, 0, 1, 0, 0, 0), ack: true });

		const rule = new CycleRule({ ctx, targetId, ruleConfig: cfg, messageWritersByPresetKey });
		await new Promise(resolve => setImmediate(resolve));

		rule.onAction({ ref: `IngestStates.0.cycle.${targetId}`, type: 'close' });
		await new Promise(resolve => setImmediate(resolve));

		const lastReset = calls.setForeignState
			.filter(c => c[0] === `${baseFull}.lastResetAt`)
			.slice(-1)[0]?.[1]?.val;
		expect(lastReset).to.be.a('number');
		expect(calls.completeAfterCauseEliminated).to.have.length(0);
	});
});

describe('CycleRule ruleTemplateCatalog compliance', () => {
	const { ruleTemplateCatalog } = require('../constants');

	function collectAllEmittedMetricKeys(calls) {
		const keys = new Set();
		for (const u of calls.onUpsert ?? []) {
			for (const k of Object.keys(u.metrics ?? {})) keys.add(k);
		}
		for (const m of calls.onMetrics ?? []) {
			for (const k of Object.keys(m.set ?? {})) keys.add(k);
		}
		return keys;
	}

	function getCatalogKeys(ruleId, presetSubset) {
		const rule = ruleTemplateCatalog[ruleId];
		return new Set(
			Object.keys(rule.metrics).filter(key => {
				const e = rule.metrics[key];
				return e.subset === null || e.subset.includes(presetSubset);
			}),
		);
	}

	function assertExactCatalogMatch(emittedKeys, ruleId, presetSubset) {
		const expected = getCatalogKeys(ruleId, presetSubset);
		const unexpected = [...emittedKeys].filter(k => !expected.has(k));
		const missing = [...expected].filter(k => !emittedKeys.has(k));
		expect(unexpected, `unexpected metric keys for ${ruleId}/${presetSubset}`).to.deep.equal([]);
		expect(missing, `missing metric keys for ${ruleId}/${presetSubset}`).to.deep.equal([]);
	}

	it('emits exactly the catalog-declared metric keys (period + time-based config)', async () => {
		const calls = {
			onUpsert: [],
			onMetrics: [],
			onClose: [],
			setForeignState: [],
			setObjectNotExists: [],
			completeAfterCauseEliminated: [],
		};
		const stateById = new Map();
		const ctx = {
			api: {
				constants: { actions: { type: { close: 'close' } } },
				log: { debug: () => undefined },
				iobroker: {
					objects: {
						setObjectNotExists: async (id, obj) => { calls.setObjectNotExists.push([id, obj]); },
						getForeignObject: async () => ({ common: { name: 'Counter', unit: 'x' } }),
					},
					states: {
						getForeignState: async id => (stateById.has(id) ? stateById.get(id) : null),
						setForeignState: async (id, st) => { stateById.set(id, st); calls.setForeignState.push([id, st]); },
					},
				},
				store: {
					completeAfterCauseEliminated: (ref, info) => { calls.completeAfterCauseEliminated.push([ref, info]); return true; },
				},
			},
			meta: { plugin: { baseOwnId: 'IngestStates.0', baseFullId: 'msghub.0.IngestStates.0' } },
		};
		const writer = {
			onUpsert: (ref, info) => { calls.onUpsert.push({ ref, ...info }); return true; },
			onMetrics: (ref, info) => { calls.onMetrics.push({ ref, ...info }); return true; },
			onClose: ref => { calls.onClose.push({ ref }); return true; },
		};
		const messageWritersByPresetKey = { CycleId: writer, DefaultId: writer, $fallback: writer };

		const targetId = 'linkeddevices.0.a.b.counter';
		const baseFull = `msghub.0.IngestStates.0.cycle.${targetId}`;
		const resetAt = Date.UTC(2025, 0, 1, 0, 0, 0);

		// Set up state: lastCounter=10, subCounter=0, lastResetAt set.
		stateById.set(`${baseFull}.lastCounter`, { val: 10, ack: true });
		stateById.set(`${baseFull}.subCounter`, { val: 0, ack: true });
		stateById.set(`${baseFull}.lastResetAt`, { val: resetAt, ack: true });

		// Both period (count-based) and time (time-based) configured so all metric keys are emitted.
		const cfg = { period: 5, time: 60, timeUnit: 1 };
		const rule = new CycleRule({ ctx, targetId, ruleConfig: cfg, messageWritersByPresetKey });

		// Allow async init to read stateById.
		await new Promise(resolve => setImmediate(resolve));

		// Delta = 15 - 10 = 5 = period → opens, emits all metric keys including time-based ones.
		rule.onStateChange(targetId, { val: 15 });

		assertExactCatalogMatch(collectAllEmittedMetricKeys(calls), 'cycle', null);
	});
});
