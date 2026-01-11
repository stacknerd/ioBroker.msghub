'use strict';

const { expect } = require('chai');
const { format } = require('node:util');
const { TriggeredRule } = require('./Triggered');

describe('IngestStates TriggeredRule', () => {
	function createStubs() {
			const calls = {
				openActive: [],
				patchMetrics: [],
				closeOnNormal: [],
				timerSet: [],
				timerDelete: [],
			};

		const message = {
			ctx: {
				api: {
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
			},
			openActive: info => {
				calls.openActive.push(info);
				return true;
			},
			patchMetrics: info => {
				calls.patchMetrics.push(info);
				return true;
			},
				closeOnNormal: info => {
					calls.closeOnNormal.push(info);
					return true;
				},
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

		return { message, timers, calls };
	}

	it('opens when expectation is not met within the window (changed via lc)', async () => {
		const { message, timers, calls } = createStubs();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new TriggeredRule({
				targetId: 'a.b.c',
				ruleConfig: {
					id: 'x.y.trg',
					operator: 'truthy',
					windowValue: 5,
					windowUnit: 1,
					expectation: 'changed',
				},
				message,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 1, lc: 1000 });
			rule.onStateChange('x.y.trg', { val: true }); // rising edge -> start window

			expect(calls.timerSet).to.have.length(1);

			// Fire the window timer; expectation still not met -> message opens.
			timers._timers.get('trg:a.b.c').at = now; // make due
			rule.onTimer({ id: 'trg:a.b.c', at: now, kind: 'triggered.window', data: timers._timers.get('trg:a.b.c').data });

			await new Promise(resolve => setImmediate(resolve));

			expect(calls.openActive).to.have.length(1);
			expect(calls.openActive[0].actions.map(a => a.type)).to.deep.equal(['ack', 'snooze', 'close']);
			expect(calls.patchMetrics).to.have.length(1);
			expect(calls.patchMetrics[0].set['state-value']).to.deep.equal({ val: 1, unit: 'W' });
		} finally {
			Date.now = originalNow;
		}
	});

	it('cancels when trigger becomes inactive before the window ends', () => {
		const { message, timers, calls } = createStubs();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new TriggeredRule({
				targetId: 'a.b.c',
				ruleConfig: {
					id: 'x.y.trg',
					operator: 'truthy',
					windowValue: 5,
					windowUnit: 1,
					expectation: 'changed',
				},
				message,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 1, lc: 1000 });
			rule.onStateChange('x.y.trg', { val: true }); // rising edge -> start window
			rule.onStateChange('x.y.trg', { val: false }); // falls -> cancel

			expect(calls.timerDelete).to.deep.equal(['trg:a.b.c']);
			expect(calls.openActive).to.have.length(0);
		} finally {
			Date.now = originalNow;
		}
	});

	it('closes when expectation becomes true after the message exists', async () => {
		const { message, timers, calls } = createStubs();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new TriggeredRule({
				targetId: 'a.b.c',
				ruleConfig: {
					id: 'x.y.trg',
					operator: 'truthy',
					windowValue: 5,
					windowUnit: 1,
					expectation: 'changed',
				},
				message,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 1, lc: 1000 });
			rule.onStateChange('x.y.trg', { val: true }); // rising edge -> start window

			rule.onTimer({ id: 'trg:a.b.c', at: now, kind: 'triggered.window', data: timers._timers.get('trg:a.b.c').data });

			await new Promise(resolve => setImmediate(resolve));
			expect(calls.openActive).to.have.length(1);

			// Later, expectation met (lc changes) -> close requested.
			rule.onStateChange('a.b.c', { val: 1, lc: 2000 });
			expect(calls.closeOnNormal).to.have.length(1);
		} finally {
			Date.now = originalNow;
		}
	});

	it('does not open when expectation is met within the window (deltaUp)', () => {
		const { message, timers, calls } = createStubs();

		const originalNow = Date.now;
		const now = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => now;
		try {
			const rule = new TriggeredRule({
				targetId: 'a.b.c',
				ruleConfig: {
					id: 'x.y.trg',
					operator: 'truthy',
					windowValue: 5,
					windowUnit: 1,
					expectation: 'deltaUp',
					minDelta: 3,
				},
				message,
				timers,
			});

			rule.onStateChange('a.b.c', { val: 0, lc: 1000 });
			rule.onStateChange('x.y.trg', { val: true }); // rising edge -> start window
			expect(calls.timerSet).to.have.length(1);

			// Target reacts within the window.
			rule.onStateChange('a.b.c', { val: 5, lc: 1000 });
			expect(calls.timerDelete).to.deep.equal(['trg:a.b.c']);
			expect(calls.openActive).to.have.length(0);
		} finally {
			Date.now = originalNow;
		}
	});
});
