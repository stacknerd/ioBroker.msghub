'use strict';

const { expect } = require('chai');
const { format } = require('node:util');
const { FreshnessRule } = require('./Freshness');

describe('IngestStates FreshnessRule', () => {
	function createHarness() {
		const calls = {
			onUpsert: [],
			onMetrics: [],
			onClose: [],
		};

		const ctx = {
			api: {
				log: { debug: () => undefined },
				i18n: {
					t: (key, ...args) => format(String(key), ...args),
				},
				iobroker: {
					objects: {
						getForeignObject: async () => ({ common: { name: 'My Sensor' } }),
					},
					states: {
						getForeignState: async () => ({ ts: 0, lc: 0 }),
					},
				},
			},
			meta: {
				plugin: { baseOwnId: 'msghub.0.IngestStates.0' },
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

	const messageWritersByPresetKey = { FreshnessId: writer, DefaultId: writer, $fallback: writer };
	return { ctx, messageWritersByPresetKey, calls };
	}

	it('does not patch state-name from object meta before any message is active', async () => {
		const { ctx, messageWritersByPresetKey, calls } = createHarness();

		new FreshnessRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: { everyValue: 1, everyUnit: 60, evaluateBy: 'ts' },
			messageWritersByPresetKey,
		});

		await new Promise(resolve => setImmediate(resolve));
		expect(calls.onMetrics).to.have.length(0);
	});

	it('opens on stale and sets state-ts/state-lc via onUpsert metrics', () => {
		const { ctx, messageWritersByPresetKey, calls } = createHarness();

		const rule = new FreshnessRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: { everyValue: 1, everyUnit: 60, evaluateBy: 'ts' }, // 1 minute
			messageWritersByPresetKey,
		});

		rule.onStateChange('a.b.c', { ts: 1000 });
		rule.onTick(1000 + 60_001);

		expect(calls.onUpsert).to.have.length(1);
		expect(calls.onUpsert[0].now).to.equal(61_001);
		expect(calls.onUpsert[0].startAt).to.equal(1000);
		expect(calls.onUpsert[0].actions.map(a => a.type)).to.deep.equal(['ack', 'snooze']);
		expect(calls.onUpsert[0].metrics['state-name'].unit).to.equal('');
		expect(['c', 'My Sensor']).to.include(calls.onUpsert[0].metrics['state-name'].val);
		expect(calls.onUpsert[0].metrics['state-ts']).to.deep.equal({ val: 1000, unit: 'ms' });
		expect(calls.onUpsert[0].metrics['state-lc']).to.equal(undefined);

		// No separate onMetrics call on initial open anymore (metrics are passed via onUpsert).
		expect(calls.onMetrics).to.have.length(0);
	});

	it('patches all freshness metrics while still in bad-state', () => {
		const { ctx, messageWritersByPresetKey, calls } = createHarness();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;

		const rule = new FreshnessRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: { everyValue: 1, everyUnit: 60, evaluateBy: 'ts' },
			messageWritersByPresetKey,
		});

		try {
			rule.onStateChange('a.b.c', { ts: now - 200_000, lc: now - 200_000, val: 1 });
			rule.onTick(now); // stale -> open

			rule.onStateChange('a.b.c', { ts: now - 120_000, lc: now - 120_000, val: 2 }); // still stale
			expect(calls.onMetrics).to.have.length(1);
			expect(calls.onMetrics[0].set).to.have.property('state-name');
			expect(calls.onMetrics[0].set).to.have.property('state-value');
			expect(calls.onMetrics[0].set).to.have.property('state-ts');
			expect(calls.onMetrics[0].set).to.have.property('state-lc');
		} finally {
			Date.now = originalNow;
		}
	});

	it('patches no freshness live metrics in good-state', () => {
		const { ctx, messageWritersByPresetKey, calls } = createHarness();

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;

		const rule = new FreshnessRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: { everyValue: 1, everyUnit: 60, evaluateBy: 'ts' },
			messageWritersByPresetKey,
		});

		try {
			rule.onStateChange('a.b.c', { ts: now - 120_000, lc: now - 120_000, val: 1 });
			rule.onTick(now); // stale -> open

			now += 1000;
			rule.onStateChange('a.b.c', { ts: now, lc: now, val: 2 }); // bad -> good
			const afterRecoveryIdx = calls.onMetrics.length;

			now += 1000;
			rule.onStateChange('a.b.c', { ts: now, lc: now, val: 3 }); // good
			rule.onTick(now);

			const goodStatePatches = calls.onMetrics.slice(afterRecoveryIdx);
			expect(goodStatePatches.some(c => c?.set?.['state-name'])).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.['state-value'])).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.['state-ts'])).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.['state-lc'])).to.equal(false);
		} finally {
			Date.now = originalNow;
		}
	});

	it('closes on recovery once and patches only state-recovered-at in good-state', () => {
		const { ctx, messageWritersByPresetKey, calls } = createHarness();

		const originalNow = Date.now;
		let now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;

		const rule = new FreshnessRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: { everyValue: 1, everyUnit: 60, evaluateBy: 'ts' }, // 1 minute
			messageWritersByPresetKey,
		});

		try {
			rule.onStateChange('a.b.c', { ts: now - 120_000 }); // old sample
			rule.onTick(now); // stale -> active

			now += 1000;
			rule.onStateChange('a.b.c', { ts: now }); // bad -> good transition
			expect(calls.onMetrics).to.have.length(1);
			expect(calls.onMetrics[0].set).to.deep.equal({
				'state-recovered-at': { val: now, unit: 'ms' },
			});
			const afterRecoveryIdx = calls.onMetrics.length;

			now += 1000;
			rule.onStateChange('a.b.c', { ts: now, val: 42 }); // still good -> no more patches
			const goodStatePatches = calls.onMetrics.slice(afterRecoveryIdx);
			expect(goodStatePatches).to.have.length(0);
			expect(goodStatePatches.some(c => c?.set?.['state-name'])).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.['state-value'])).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.['state-ts'])).to.equal(false);
			expect(goodStatePatches.some(c => c?.set?.['state-lc'])).to.equal(false);

			rule.onTick(now); // recovered -> close requested once
			expect(calls.onClose).to.have.length(1);

			rule.onTick(now + 10_000); // still normal -> no second close request
			expect(calls.onClose).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it('supports evaluateBy=lc (unchanged wording)', () => {
		const { ctx, messageWritersByPresetKey, calls } = createHarness();

		const rule = new FreshnessRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: { everyValue: 1, everyUnit: 60, evaluateBy: 'lc' }, // 1 minute
			messageWritersByPresetKey,
		});

		rule.onStateChange('a.b.c', { lc: 1000 });
		rule.onTick(1000 + 60_001);

		expect(calls.onUpsert).to.have.length(1);
		expect(calls.onUpsert[0].startAt).to.equal(1000);
		expect(calls.onUpsert[0].metrics['state-lc']).to.deep.equal({ val: 1000, unit: 'ms' });
		expect(calls.onUpsert[0].metrics['state-ts']).to.equal(undefined);
	});

	it('bootstraps lastSeenAt from foreign state when no events were observed yet', async () => {
		const { ctx, messageWritersByPresetKey, calls } = createHarness();

		ctx.api.iobroker.states.getForeignState = async () => ({ ts: 1000 });

		const rule = new FreshnessRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: { everyValue: 1, everyUnit: 60, evaluateBy: 'ts' }, // 1 minute
			messageWritersByPresetKey,
		});

		rule.onTick(2000); // triggers async bootstrap
		expect(calls.onUpsert).to.have.length(0);

		await new Promise(resolve => setImmediate(resolve));

		rule.onTick(1000 + 60_001); // now stale based on bootstrapped ts
		expect(calls.onUpsert).to.have.length(1);
	});
});
