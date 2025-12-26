'use strict';

const { expect } = require('chai');
const { NotifyIoBrokerState } = require('./');
const { MsgConstants } = require('../../src/MsgConstants');

function makeAdapter() {
	const objects = new Map();
	const states = new Map();
	const logs = { info: [], warn: [], debug: [] };
	const adapter = {
		log: {
			info: msg => logs.info.push(msg),
			warn: msg => logs.warn.push(msg),
			debug: msg => logs.debug.push(msg),
		},
		setObjectNotExistsAsync: async (id, obj) => {
			if (!objects.has(id)) {
				objects.set(id, obj);
			}
		},
		setStateAsync: async (id, state) => {
			states.set(id, state);
		},
	};
	return { adapter, objects, states, logs };
}

function flushPromises() {
	return new Promise(resolve => setImmediate(resolve));
}

describe('NotifyIoBrokerState', () => {
	it('precreates latest, kind, and level states per event', async () => {
		const { adapter, objects } = makeAdapter();
		NotifyIoBrokerState(adapter);
		await flushPromises();
		await flushPromises();

		const eventValues = Object.values(MsgConstants.notfication.events);
		const kindKeys = Object.keys(MsgConstants.kind);
		const levelKeys = Object.keys(MsgConstants.level);
		const expectedIds = new Set();

		for (const eventValue of eventValues) {
			expectedIds.add(`notifications.latest.${eventValue}`);
		}
		for (const kindKey of kindKeys) {
			for (const eventValue of eventValues) {
				expectedIds.add(`notifications.byKind.${kindKey}.${eventValue}`);
			}
		}
		for (const levelKey of levelKeys) {
			for (const eventValue of eventValues) {
				expectedIds.add(`notifications.byLevel.${levelKey}.${eventValue}`);
			}
		}

		expect(objects.size).to.equal(expectedIds.size);
		for (const id of expectedIds) {
			expect(objects.has(id)).to.equal(true);
		}
	});

	it('writes latest, kind, and level states for the event', async () => {
		const { adapter, states } = makeAdapter();
		const plugin = NotifyIoBrokerState(adapter, { includeContext: true });
		const msg = {
			ref: 'ref-1',
			kind: MsgConstants.kind.task,
			level: MsgConstants.level.notice,
		};
		const ctx = { source: 'unit' };
		plugin.onNotifications('update', [msg], ctx);
		await flushPromises();
		await flushPromises();

		const latest = JSON.parse(states.get('notifications.latest.updated').val);
		expect(latest.event).to.equal('update');
		expect(latest.notifications).to.deep.equal(msg);
		expect(latest.ctx).to.deep.equal(ctx);

		const kindState = JSON.parse(states.get('notifications.byKind.task.updated').val);
		expect(kindState.event).to.equal('update');
		expect(kindState.notification).to.deep.equal(msg);
		expect(kindState.ctx).to.deep.equal(ctx);

		const levelState = JSON.parse(states.get('notifications.byLevel.notice.updated').val);
		expect(levelState.event).to.equal('update');
		expect(levelState.notification).to.deep.equal(msg);
		expect(levelState.ctx).to.deep.equal(ctx);
	});

	it('accepts event values and level keys', async () => {
		const { adapter, states } = makeAdapter();
		const plugin = NotifyIoBrokerState(adapter);
		const msg = {
			ref: 'ref-2',
			kind: 'task',
			level: 'warning',
		};
		plugin.onNotifications('due', [msg]);
		await flushPromises();
		await flushPromises();

		const kindState = JSON.parse(states.get('notifications.byKind.task.due').val);
		expect(kindState).to.deep.equal(msg);

		const levelState = JSON.parse(states.get('notifications.byLevel.warning.due').val);
		expect(levelState).to.deep.equal(msg);
	});

	it('maps numeric levels and skips invalid events', async () => {
		const { adapter, states } = makeAdapter();
		const plugin = NotifyIoBrokerState(adapter);
		const msg = { ref: 'ref-3', kind: 'task', level: '10' };
		plugin.onNotifications('updated', [msg]);
		plugin.onNotifications('unknown', [msg]);
		await flushPromises();
		await flushPromises();

		const levelState = JSON.parse(states.get('notifications.byLevel.notice.updated').val);
		expect(levelState).to.deep.equal(msg);
		expect(states.has('notifications.latest.unknown')).to.equal(false);
	});
});
