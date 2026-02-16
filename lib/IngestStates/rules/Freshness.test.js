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

	it('closes on recovery once and keeps patching lastSeenAt while active', () => {
		const { ctx, messageWritersByPresetKey, calls } = createHarness();

		const rule = new FreshnessRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: { everyValue: 1, everyUnit: 60, evaluateBy: 'ts' }, // 1 minute
			messageWritersByPresetKey,
		});

		rule.onStateChange('a.b.c', { ts: 1000 });
		rule.onTick(1000 + 60_001); // stale -> active

		rule.onStateChange('a.b.c', { ts: 200_000 }); // patch metrics (still active)
		expect(calls.onMetrics).to.have.length(1);
		expect(calls.onMetrics[0].set['state-name'].unit).to.equal('');
		expect(['c', 'My Sensor']).to.include(calls.onMetrics[0].set['state-name'].val);
		expect(calls.onMetrics[0].set['state-ts']).to.deep.equal({ val: 200_000, unit: 'ms' });

		rule.onTick(200_000); // recovered -> close requested once
		expect(calls.onClose).to.have.length(1);

		rule.onTick(200_000 + 10_000); // still normal -> no second close request
		expect(calls.onClose).to.have.length(1);
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
