'use strict';

const { expect } = require('chai');
const { format } = require('node:util');
const { FreshnessRule } = require('./Freshness');

describe('IngestStates FreshnessRule', () => {
	function createMessageStub() {
		const calls = {
			openActive: [],
			patchMetrics: [],
			tryCloseScheduled: [],
			closeOnNormal: [],
		};

		const message = {
			ctx: {
				api: {
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
			},
			openActive: info => {
				calls.openActive.push(info);
				return true;
			},
			patchMetrics: info => {
				calls.patchMetrics.push(info);
				return true;
			},
			tryCloseScheduled: info => {
				calls.tryCloseScheduled.push(info);
				return false;
			},
			closeOnNormal: info => {
				calls.closeOnNormal.push(info);
				return true;
			},
		};

		return { message, calls };
	}

	it('opens on stale and patches lastSeenAt', () => {
		const { message, calls } = createMessageStub();

		const rule = new FreshnessRule({
			targetId: 'a.b.c',
			ruleConfig: { everyValue: 1, everyUnit: 60, evaluateBy: 'ts' }, // 1 minute
			message,
		});

		rule.onStateChange('a.b.c', { ts: 1000 });
		rule.onTick(1000 + 60_001);

		expect(calls.openActive).to.have.length(1);
		expect(calls.openActive[0].defaultTitle).to.contain('without updates');
		expect(calls.openActive[0].defaultText).to.contain('{{m.lastSeenAt|durationSince}}');
		expect(calls.openActive[0].defaultText).to.contain('{{m.lastSeenAt|datetime}}');
		expect(calls.openActive[0].defaultText).to.contain('within 1m');
		expect(calls.openActive[0].actions.map(a => a.type)).to.deep.equal(['ack', 'snooze']);

		expect(calls.patchMetrics).to.have.length(1);
		expect(calls.patchMetrics[0]).to.have.property('force', true);
		expect(calls.patchMetrics[0].set.lastSeenAt).to.deep.equal({ val: 1000, unit: 'ms' });
	});

	it('closes on recovery once and keeps patching lastSeenAt while active', () => {
		const { message, calls } = createMessageStub();

		const rule = new FreshnessRule({
			targetId: 'a.b.c',
			ruleConfig: { everyValue: 1, everyUnit: 60, evaluateBy: 'ts' }, // 1 minute
			message,
		});

		rule.onStateChange('a.b.c', { ts: 1000 });
		rule.onTick(1000 + 60_001); // stale -> active

		rule.onStateChange('a.b.c', { ts: 200_000 }); // should patch metrics (still active)
		expect(calls.patchMetrics).to.have.length(2);
		expect(calls.patchMetrics[1].set.lastSeenAt).to.deep.equal({ val: 200_000, unit: 'ms' });

		rule.onTick(200_000); // recovered -> close requested once
		expect(calls.tryCloseScheduled).to.have.length(1);
		expect(calls.closeOnNormal).to.have.length(1);

		rule.onTick(200_000 + 10_000); // still normal -> no second close request
		expect(calls.tryCloseScheduled).to.have.length(2);
		expect(calls.closeOnNormal).to.have.length(1);
	});

	it('supports evaluateBy=lc (unchanged wording)', () => {
		const { message, calls } = createMessageStub();

		const rule = new FreshnessRule({
			targetId: 'a.b.c',
			ruleConfig: { everyValue: 1, everyUnit: 60, evaluateBy: 'lc' }, // 1 minute
			message,
		});

		rule.onStateChange('a.b.c', { lc: 1000 });
		rule.onTick(1000 + 60_001);

		expect(calls.openActive).to.have.length(1);
		expect(calls.openActive[0].defaultTitle).to.contain('unchanged');
		expect(calls.openActive[0].defaultText).to.contain('has not changed');
		expect(calls.openActive[0].defaultText).to.contain('does not change within 1m');
	});

	it('bootstraps lastSeenAt from foreign state when no events were observed yet', async () => {
		const { message, calls } = createMessageStub();

		message.ctx.api.iobroker.states.getForeignState = async () => ({ ts: 1000 });

		const rule = new FreshnessRule({
			targetId: 'a.b.c',
			ruleConfig: { everyValue: 1, everyUnit: 60, evaluateBy: 'ts' }, // 1 minute
			message,
		});

		rule.onTick(2000); // triggers async bootstrap
		expect(calls.openActive).to.have.length(0);

		await new Promise(resolve => setImmediate(resolve));

		rule.onTick(1000 + 60_001); // now stale based on bootstrapped ts
		expect(calls.openActive).to.have.length(1);
	});
});
