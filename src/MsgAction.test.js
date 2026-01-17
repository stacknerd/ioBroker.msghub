'use strict';

const { expect } = require('chai');
const { MsgAction } = require('./MsgAction');
const { MsgConstants } = require('./MsgConstants');

function createAdapter() {
	const logs = { warn: [], debug: [] };
	const adapter = {
		log: {
			warn: msg => logs.warn.push(String(msg)),
			debug: msg => logs.debug.push(String(msg)),
		},
	};
	return { adapter, logs };
}

function withFixedNow(now, fn) {
	const original = Date.now;
	Date.now = () => now;
	try {
		return fn();
	} finally {
		Date.now = original;
	}
}

describe('MsgAction', () => {
	it('policy: action matrix (open/acked/snoozed/quasiDeleted)', () => {
		const { adapter } = createAdapter();
		const store = { getMessageByRef: () => null, updateMessage: () => true };
		const msgAction = new MsgAction(adapter, MsgConstants, store);

		const action = type => ({ id: `id_${type}`, type });
		const msg = state => ({ ref: 'r1', lifecycle: { state }, timing: {} });

		// open: everything allowed (core workflow actions)
		expect(msgAction.isActionAllowed(msg(MsgConstants.lifecycle.state.open), action(MsgConstants.actions.type.ack))).to.equal(true);
		expect(msgAction.isActionAllowed(msg(MsgConstants.lifecycle.state.open), action(MsgConstants.actions.type.close))).to.equal(true);
		expect(msgAction.isActionAllowed(msg(MsgConstants.lifecycle.state.open), action(MsgConstants.actions.type.delete))).to.equal(true);
		expect(msgAction.isActionAllowed(msg(MsgConstants.lifecycle.state.open), action(MsgConstants.actions.type.snooze))).to.equal(true);

		// acked: close/delete only
		expect(msgAction.isActionAllowed(msg(MsgConstants.lifecycle.state.acked), action(MsgConstants.actions.type.ack))).to.equal(false);
		expect(msgAction.isActionAllowed(msg(MsgConstants.lifecycle.state.acked), action(MsgConstants.actions.type.close))).to.equal(true);
		expect(msgAction.isActionAllowed(msg(MsgConstants.lifecycle.state.acked), action(MsgConstants.actions.type.delete))).to.equal(true);
		expect(msgAction.isActionAllowed(msg(MsgConstants.lifecycle.state.acked), action(MsgConstants.actions.type.snooze))).to.equal(false);

		// snoozed: ack/close/delete only
		expect(msgAction.isActionAllowed(msg(MsgConstants.lifecycle.state.snoozed), action(MsgConstants.actions.type.ack))).to.equal(true);
		expect(msgAction.isActionAllowed(msg(MsgConstants.lifecycle.state.snoozed), action(MsgConstants.actions.type.close))).to.equal(true);
		expect(msgAction.isActionAllowed(msg(MsgConstants.lifecycle.state.snoozed), action(MsgConstants.actions.type.delete))).to.equal(true);
		expect(msgAction.isActionAllowed(msg(MsgConstants.lifecycle.state.snoozed), action(MsgConstants.actions.type.snooze))).to.equal(false);

		// quasi-deleted: nothing allowed
		for (const state of [
			MsgConstants.lifecycle.state.closed,
			MsgConstants.lifecycle.state.deleted,
			MsgConstants.lifecycle.state.expired,
		]) {
			expect(msgAction.isActionAllowed(msg(state), action(MsgConstants.actions.type.ack))).to.equal(false);
			expect(msgAction.isActionAllowed(msg(state), action(MsgConstants.actions.type.close))).to.equal(false);
			expect(msgAction.isActionAllowed(msg(state), action(MsgConstants.actions.type.delete))).to.equal(false);
			expect(msgAction.isActionAllowed(msg(state), action(MsgConstants.actions.type.snooze))).to.equal(false);
		}
	});

	it('buildActions: splits into actions + actionsInactive', () => {
		const { adapter } = createAdapter();
		const store = { getMessageByRef: () => null, updateMessage: () => true };
		const msgAction = new MsgAction(adapter, MsgConstants, store);

		const message = {
			ref: 'r1',
			lifecycle: { state: MsgConstants.lifecycle.state.acked },
			timing: {},
			actions: [
				{ id: 'ack1', type: MsgConstants.actions.type.ack },
				{ id: 'close1', type: MsgConstants.actions.type.close },
				{ id: 'delete1', type: MsgConstants.actions.type.delete },
				{ id: 'snooze1', type: MsgConstants.actions.type.snooze, payload: { forMs: 1000 } },
			],
		};

		const out = msgAction.buildActions(message);
		expect(out).to.be.an('object');
		expect(out.actions.map(a => a.id)).to.deep.equal(['close1', 'delete1']);
		expect(out.actionsInactive.map(a => a.id)).to.deep.equal(['ack1', 'snooze1']);
	});

	it('policy: blocks snooze when message is acked', () => {
		const { adapter } = createAdapter();
		const store = { getMessageByRef: () => null, updateMessage: () => true };
		const msgAction = new MsgAction(adapter, MsgConstants, store);
		const msg = {
			ref: 'r1',
			lifecycle: { state: MsgConstants.lifecycle.state.acked },
			timing: {},
		};
		const action = { id: 's1', type: MsgConstants.actions.type.snooze };
		expect(msgAction.isActionAllowed(msg, action)).to.equal(false);
	});

	it('policy: blocks snooze when message is snoozed', () => {
		const { adapter } = createAdapter();
		const store = { getMessageByRef: () => null, updateMessage: () => true };
		const msgAction = new MsgAction(adapter, MsgConstants, store);
		const msg = {
			ref: 'r1',
			lifecycle: { state: MsgConstants.lifecycle.state.snoozed },
			timing: { notifyAt: Date.now() + 1000 },
		};
		const action = { id: 's1', type: MsgConstants.actions.type.snooze };
		expect(msgAction.isActionAllowed(msg, action)).to.equal(false);
	});

	it('rejects missing ref', () => {
		const { adapter } = createAdapter();
		const store = { getMessageByRef: () => null, updateMessage: () => true };
		const msgAction = new MsgAction(adapter, MsgConstants, store);
		expect(msgAction.execute({ actionId: 'a1' })).to.equal(false);
	});

	it('rejects missing actionId', () => {
		const { adapter } = createAdapter();
		const store = { getMessageByRef: () => null, updateMessage: () => true };
		const msgAction = new MsgAction(adapter, MsgConstants, store);
		expect(msgAction.execute({ ref: 'r1' })).to.equal(false);
	});

	it('rejects unknown message', () => {
		const { adapter } = createAdapter();
		const store = { getMessageByRef: () => null, updateMessage: () => true };
		const msgAction = new MsgAction(adapter, MsgConstants, store);
		expect(msgAction.execute({ ref: 'r1', actionId: 'a1' })).to.equal(false);
	});

	it('rejects actionId that is not whitelisted in message.actions[]', () => {
		const { adapter } = createAdapter();
		const recorded = [];
		const store = {
			getMessageByRef: () => ({ ref: 'r1', actions: [{ id: 'a2', type: MsgConstants.actions.type.ack }] }),
			updateMessage: () => true,
			msgArchive: {
				appendAction: (ref, payload) => {
					recorded.push({ ref, payload });
					return Promise.resolve();
				},
			},
		};
		const msgAction = new MsgAction(adapter, MsgConstants, store);
		expect(msgAction.execute({ ref: 'r1', actionId: 'a1' })).to.equal(false);
		expect(recorded).to.have.length(1);
		expect(recorded[0].ref).to.equal('r1');
		expect(recorded[0].payload.actionId).to.equal('a1');
		expect(recorded[0].payload.ok).to.equal(false);
		expect(recorded[0].payload.reason).to.equal('not_allowed');
	});

	it('acks: patches lifecycle.state + clears notifyAt', () => {
		const { adapter } = createAdapter();
		let patched = null;
		const recorded = [];
		const store = {
			getMessageByRef: () => ({
				ref: 'r1',
				actions: [{ id: 'ack1', type: MsgConstants.actions.type.ack }],
				lifecycle: { state: MsgConstants.lifecycle.state.open },
				timing: { notifyAt: 123 },
			}),
			updateMessage: (_ref, patch) => {
				patched = patch;
				return true;
			},
			msgArchive: {
				appendAction: (ref, payload) => {
					recorded.push({ ref, payload });
					return Promise.resolve();
				},
			},
		};
		const msgAction = new MsgAction(adapter, MsgConstants, store);

		withFixedNow(1000, () => {
			expect(msgAction.execute({ ref: 'r1', actionId: 'ack1', actor: 'UI' })).to.equal(true);
		});

			expect(patched).to.deep.equal({
				lifecycle: { state: 'acked', stateChangedBy: 'UI' },
				timing: { notifyAt: null },
			});
		expect(recorded).to.have.length(1);
		expect(recorded[0].ref).to.equal('r1');
			expect(recorded[0].payload.actionId).to.equal('ack1');
			expect(recorded[0].payload.type).to.equal('ack');
			expect(recorded[0].payload.ok).to.equal(true);
			expect(recorded[0].payload.actor).to.equal('UI');
			expect(recorded[0].payload.payload).to.equal(null);
		});

	it('acks: blocked by policy when message is already acked', () => {
		const { adapter } = createAdapter();
		let updates = 0;
		const recorded = [];
		const store = {
			getMessageByRef: () => ({
				ref: 'r1',
				actions: [{ id: 'ack1', type: MsgConstants.actions.type.ack }],
				lifecycle: { state: MsgConstants.lifecycle.state.acked },
				timing: {},
			}),
			updateMessage: () => {
				updates += 1;
				return true;
			},
			msgArchive: {
				appendAction: (ref, payload) => {
					recorded.push({ ref, payload });
					return Promise.resolve();
				},
			},
		};
		const msgAction = new MsgAction(adapter, MsgConstants, store);
		expect(msgAction.execute({ ref: 'r1', actionId: 'ack1' })).to.equal(false);
		expect(updates).to.equal(0);
			expect(recorded).to.have.length(1);
			expect(recorded[0].payload.ok).to.equal(false);
			expect(recorded[0].payload.reason).to.equal('blocked_by_policy');
			expect(recorded[0].payload.actor).to.equal(null);
			expect(recorded[0].payload.payload).to.equal(null);
		});

	it('snooze: uses forMs from action.payload and sets notifyAt=now+forMs', () => {
		const { adapter } = createAdapter();
		let patched = null;
		const store = {
			getMessageByRef: () => ({
				ref: 'r1',
				actions: [{ id: 's1', type: MsgConstants.actions.type.snooze, payload: { forMs: 5000 } }],
				lifecycle: { state: MsgConstants.lifecycle.state.open },
				timing: { notifyAt: 123 },
			}),
			updateMessage: (_ref, patch) => {
				patched = patch;
				return true;
			},
		};
		const msgAction = new MsgAction(adapter, MsgConstants, store);

		withFixedNow(1000, () => {
			expect(msgAction.execute({ ref: 'r1', actionId: 's1', actor: null })).to.equal(true);
		});

			expect(patched).to.deep.equal({
				lifecycle: { state: 'snoozed', stateChangedBy: null },
				timing: { notifyAt: 6000 },
	});

	it('snooze: rejects when message is already acked', () => {
		const { adapter } = createAdapter();
		let patched = null;
		const store = {
			getMessageByRef: () => ({
				ref: 'r1',
				actions: [{ id: 's1', type: MsgConstants.actions.type.snooze, payload: { forMs: 5000 } }],
				lifecycle: { state: MsgConstants.lifecycle.state.acked },
				timing: {},
			}),
			updateMessage: (_ref, patch) => {
				patched = patch;
				return true;
			},
		};
		const msgAction = new MsgAction(adapter, MsgConstants, store);
		expect(msgAction.execute({ ref: 'r1', actionId: 's1' })).to.equal(false);
		expect(patched).to.equal(null);
	});
});

	it('snooze: allows overriding forMs via snoozeForMs', () => {
		const { adapter } = createAdapter();
		let patched = null;
		const store = {
			getMessageByRef: () => ({
				ref: 'r1',
				actions: [{ id: 's1', type: MsgConstants.actions.type.snooze, payload: { forMs: 5000 } }],
				lifecycle: { state: MsgConstants.lifecycle.state.open },
				timing: { notifyAt: 123 },
			}),
			updateMessage: (_ref, patch) => {
				patched = patch;
				return true;
			},
		};
		const msgAction = new MsgAction(adapter, MsgConstants, store);

		withFixedNow(1000, () => {
			expect(msgAction.execute({ ref: 'r1', actionId: 's1', actor: 'UI', snoozeForMs: 10000 })).to.equal(true);
		});

		expect(patched).to.deep.equal({
			lifecycle: { state: 'snoozed', stateChangedBy: 'UI' },
			timing: { notifyAt: 11000 },
		});
	});

	it('snooze: rejects invalid snoozeForMs even when action.payload.forMs is valid', () => {
		const { adapter } = createAdapter();
		let patched = null;
		const store = {
			getMessageByRef: () => ({
				ref: 'r1',
				actions: [{ id: 's1', type: MsgConstants.actions.type.snooze, payload: { forMs: 5000 } }],
				lifecycle: { state: MsgConstants.lifecycle.state.open },
				timing: { notifyAt: 123 },
			}),
			updateMessage: (_ref, patch) => {
				patched = patch;
				return true;
			},
		};
		const msgAction = new MsgAction(adapter, MsgConstants, store);

		withFixedNow(1000, () => {
			expect(msgAction.execute({ ref: 'r1', actionId: 's1', snoozeForMs: 0 })).to.equal(false);
		});
		expect(patched).to.equal(null);
	});

	it('snooze: rejects missing/invalid forMs', () => {
		const { adapter } = createAdapter();
		const store = {
			getMessageByRef: () => ({
				ref: 'r1',
				actions: [{ id: 's1', type: MsgConstants.actions.type.snooze, payload: {} }],
				lifecycle: { state: MsgConstants.lifecycle.state.open },
				timing: {},
			}),
			updateMessage: () => true,
		};
		const msgAction = new MsgAction(adapter, MsgConstants, store);
		expect(msgAction.execute({ ref: 'r1', actionId: 's1' })).to.equal(false);
	});

	it('accepts non-core action types as no-op (and records them)', () => {
		const { adapter } = createAdapter();
		const recorded = [];
		let updates = 0;
		const store = {
			getMessageByRef: () => ({
				ref: 'r1',
				actions: [{ id: 'o1', type: MsgConstants.actions.type.open, payload: { foo: 'bar' } }],
				lifecycle: { state: MsgConstants.lifecycle.state.open },
				timing: {},
			}),
			updateMessage: () => {
				updates += 1;
				return true;
			},
			msgArchive: {
				appendAction: (ref, payload) => {
					recorded.push({ ref, payload });
					return Promise.resolve();
				},
			},
			};
			const msgAction = new MsgAction(adapter, MsgConstants, store);
			expect(msgAction.execute({ ref: 'r1', actionId: 'o1', actor: 'UI' })).to.equal(true);
			expect(updates).to.equal(0);
			expect(recorded).to.have.length(1);
			expect(recorded[0].payload.ok).to.equal(true);
			expect(recorded[0].payload.noop).to.equal(true);
			expect(recorded[0].payload.reason).to.equal('non_core');
			expect(recorded[0].payload.type).to.equal(MsgConstants.actions.type.open);
			expect(recorded[0].payload.actor).to.equal('UI');
			expect(recorded[0].payload.payload).to.deep.equal({ foo: 'bar' });
		});
	});
