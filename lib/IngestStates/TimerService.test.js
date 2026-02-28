'use strict';

const { expect } = require('chai');
const { TimerService } = require('./TimerService');

describe('IngestStates TimerService', () => {
	function createCtx() {
		const calls = {
			setObjectNotExists: [],
			getForeignState: [],
			setForeignState: [],
			onDue: [],
			setTimeout: [],
			clearTimeout: [],
		};

		const stateById = new Map();

		const ctx = {
			api: {
				iobroker: {
					objects: {
						setObjectNotExists: async (id, obj) => {
							calls.setObjectNotExists.push({ id, obj });
						},
					},
					states: {
						getForeignState: async id => {
							calls.getForeignState.push(id);
							return stateById.get(id) || null;
						},
						setForeignState: async (id, state) => {
							calls.setForeignState.push({ id, state });
							stateById.set(id, state);
						},
					},
				},
			},
			meta: {
				plugin: { baseOwnId: 'IngestStates.0', baseFullId: 'msghub.0.IngestStates.0' },
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
			},
		};

		return { ctx, calls, stateById };
	}

	it('loads persisted timers from the ioBroker json state (best-effort)', async () => {
		const { ctx, stateById } = createCtx();

		stateById.set('msghub.0.IngestStates.0.timers', {
			val: JSON.stringify({
				schemaVersion: 1,
				timers: {
					a: { at: 123, kind: 'k', data: { targetId: 'x' } },
				},
			}),
		});

		const svc = new TimerService(ctx, {
			onDue: timer => {
				throw new Error(`unexpected due: ${timer.id}`);
			},
		});

		await svc.start();

		expect(svc.get('a')).to.deep.equal({ at: 123, kind: 'k', data: { targetId: 'x' } });
	});

	it('flushes set/delete to the persisted json state (best-effort)', async () => {
		const { ctx, calls, stateById } = createCtx();

		const svc = new TimerService(ctx, { onDue: t => calls.onDue.push(t) });
		await svc.start();

		svc.set('a', 123, 'k', { targetId: 'x' });
		svc._flushNow();

		const st1 = stateById.get('msghub.0.IngestStates.0.timers');
		const parsed1 = JSON.parse(st1.val);
		expect(parsed1.timers.a.kind).to.equal('k');
		expect(parsed1.timers.a.data.targetId).to.equal('x');

		svc.delete('a');
		svc._flushNow();

		const st2 = stateById.get('msghub.0.IngestStates.0.timers');
		const parsed2 = JSON.parse(st2.val);
		expect(parsed2.timers).to.deep.equal({});
	});
});

