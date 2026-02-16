'use strict';

const { expect } = require('chai');
const { format } = require('node:util');
const { TriggeredRule } = require('./Triggered');

describe('IngestStates TriggeredRule', () => {
	function createStubs() {
		const calls = {
			onUpsert: [],
			onMetrics: [],
			onClose: [],
			timerSet: [],
			timerDelete: [],
		};

		const ctx = {
			api: {
				log: { debug: () => undefined },
				i18n: {
					t: (key, ...args) => format(String(key), ...args),
				},
				iobroker: {
					objects: {
						getForeignObject: async () => ({ common: { name: 'My Target', unit: 'W' } }),
					},
					states: {
						getForeignState: async () => null,
					},
				},
			},
			meta: {
				plugin: { baseOwnId: 'msghub.0.IngestStates.0' },
			},
		};

		const writer = {
			presetId: 'preset',
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

		const messageWritersByPresetKey = { TriggeredId: writer, DefaultId: writer, $fallback: writer };

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

		return { ctx, messageWritersByPresetKey, timers, calls };
	}

	it('does not patch state-name from object meta before any message is active', async () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs();
		new TriggeredRule({
			ctx,
			targetId: 'a.b.c',
			ruleConfig: {
				id: 'x.y.trg',
				operator: 'truthy',
				windowValue: 5,
				windowUnit: 1,
				expectation: 'changed',
			},
			messageWritersByPresetKey,
			timers,
		});

		await new Promise(resolve => setImmediate(resolve));
		expect(calls.onMetrics).to.have.length(0);
	});

	it('opens when expectation is not met within the window (changed via lc)', async () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new TriggeredRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					id: 'x.y.trg',
					operator: 'truthy',
					windowValue: 5,
					windowUnit: 1,
					expectation: 'changed',
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 1, lc: 1000 });
			rule.onStateChange('x.y.trg', { val: true }); // rising edge -> start window

			expect(calls.timerSet).to.have.length(1);

			// Fire the window timer; expectation still not met -> message opens.
			timers._timers.get('trg:a.b.c').at = now; // make due
			rule.onTimer({ id: 'trg:a.b.c', at: now, kind: 'triggered.window', data: timers._timers.get('trg:a.b.c').data });

			await new Promise(resolve => setImmediate(resolve));

			expect(calls.onUpsert).to.have.length(1);
			expect(calls.onUpsert[0].actions.map(a => a.type)).to.deep.equal(['ack', 'snooze', 'close']);
			expect(calls.onUpsert[0].startAt).to.equal(now);
			expect(calls.onUpsert[0].metrics['state-name'].unit).to.equal('');
			expect(['c', 'My Target']).to.include(calls.onUpsert[0].metrics['state-name'].val);
			expect(calls.onUpsert[0].metrics['state-value']).to.deep.equal({ val: 1, unit: 'W' });
			// object meta lookup is async -> state-name may also arrive via a metric patch
			const nameMetricCall = calls.onMetrics.find(c => c?.set?.['state-name']?.val === 'My Target');
			if (nameMetricCall) {
				expect(nameMetricCall.set['state-name']).to.deep.equal({ val: 'My Target', unit: '' });
			}
		} finally {
			Date.now = originalNow;
		}
	});

	it('cancels when trigger becomes inactive before the window ends', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new TriggeredRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					id: 'x.y.trg',
					operator: 'truthy',
					windowValue: 5,
					windowUnit: 1,
					expectation: 'changed',
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 1, lc: 1000 });
			rule.onStateChange('x.y.trg', { val: true }); // rising edge -> start window
			rule.onStateChange('x.y.trg', { val: false }); // falls -> cancel

			expect(calls.timerDelete).to.deep.equal(['trg:a.b.c']);
			expect(calls.onUpsert).to.have.length(0);
		} finally {
			Date.now = originalNow;
		}
	});

	it('closes when expectation becomes true after the message exists', async () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new TriggeredRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					id: 'x.y.trg',
					operator: 'truthy',
					windowValue: 5,
					windowUnit: 1,
					expectation: 'changed',
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 1, lc: 1000 });
			rule.onStateChange('x.y.trg', { val: true }); // rising edge -> start window

			rule.onTimer({ id: 'trg:a.b.c', at: now, kind: 'triggered.window', data: timers._timers.get('trg:a.b.c').data });

			await new Promise(resolve => setImmediate(resolve));
			expect(calls.onUpsert).to.have.length(1);

			// Later, expectation met (lc changes) -> close requested.
			rule.onStateChange('a.b.c', { val: 1, lc: 2000 });
			expect(calls.onClose).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it('does not open when expectation is met within the window (deltaUp)', () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new TriggeredRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					id: 'x.y.trg',
					operator: 'truthy',
					windowValue: 5,
					windowUnit: 1,
					expectation: 'deltaUp',
					minDelta: 3,
				},
				messageWritersByPresetKey,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 0, lc: 1000 });
			rule.onStateChange('x.y.trg', { val: true }); // rising edge -> start window
			expect(calls.timerSet).to.have.length(1);

			// Target reacts within the window.
			rule.onStateChange('a.b.c', { val: 5, lc: 1000 });
			expect(calls.timerDelete).to.deep.equal(['trg:a.b.c']);
			expect(calls.onUpsert).to.have.length(0);
		} finally {
			Date.now = originalNow;
		}
	});

	it('always includes state-name metric by falling back to target id segment', async () => {
		const { ctx, messageWritersByPresetKey, timers, calls } = createStubs();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new TriggeredRule({
				ctx,
				targetId: 'a.b.c',
				ruleConfig: {
					id: 'x.y.trg',
					operator: 'truthy',
					windowValue: 5,
					windowUnit: 1,
					expectation: 'changed',
				},
				messageWritersByPresetKey,
				timers,
			});

			rule._name = '';
			rule.onStateChange('a.b.c', { val: 1, lc: 1000 });
			rule.onStateChange('x.y.trg', { val: true });
			rule.onTimer({ id: 'trg:a.b.c', at: now, kind: 'triggered.window', data: timers._timers.get('trg:a.b.c').data });

			await new Promise(resolve => setImmediate(resolve));

			expect(calls.onUpsert).to.have.length(1);
			expect(calls.onUpsert[0].metrics['state-name'].unit).to.equal('');
			expect(['c', 'My Target']).to.include(calls.onUpsert[0].metrics['state-name'].val);
		} finally {
			Date.now = originalNow;
		}
	});
});
