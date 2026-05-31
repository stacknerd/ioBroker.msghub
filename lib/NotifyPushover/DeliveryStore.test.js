'use strict';

const { expect } = require('chai');

const { createDeliveryStore } = require('./DeliveryStore');

function createHarness(initialStates = {}) {
	const states = new Map(Object.entries(initialStates));
	const objectCalls = [];
	const logs = { warn: [], debug: [] };
	const iobroker = {
		objects: {
			setObjectNotExists: (id, obj) => {
				objectCalls.push([id, obj]);
				return Promise.resolve();
			},
		},
		states: {
			getForeignState: id => Promise.resolve({ val: states.get(id) || '' }),
			setState: (id, st) => {
				states.set(id, String(st?.val || ''));
				return Promise.resolve();
			},
		},
	};
	const log = {
		warn: msg => logs.warn.push(msg),
		debug: msg => logs.debug.push(msg),
	};
	return { iobroker, log, states, objectCalls, logs };
}

describe('NotifyPushover DeliveryStore', () => {
	it('creates its json state and persists ref records', async () => {
		const { iobroker, log, states, objectCalls } = createHarness();
		const store = createDeliveryStore({ iobroker, log, baseFullId: 'msghub.0.NotifyPushover.0' });

		await store.ensureObjects();
		store.upsert({
			ref: 'doorbell',
			imagesByValue: { '/tmp/cam1.jpg': { sentAt: 1 } },
			createdAt: 1,
			updatedAt: 2,
		});
		await store.save({ prune: false });

		expect(objectCalls).to.have.length(1);
		expect(objectCalls[0][0]).to.equal('msghub.0.NotifyPushover.0.deliveryByRef');
		const persisted = JSON.parse(states.get('msghub.0.NotifyPushover.0.deliveryByRef'));
		expect(persisted.doorbell.imagesByValue).to.have.property('/tmp/cam1.jpg');
	});

	it('loads persisted records and removes records by ref', async () => {
		const raw = JSON.stringify({
			doorbell: {
				ref: 'doorbell',
				imagesByValue: { '/tmp/cam1.jpg': { sentAt: 1 } },
				createdAt: 1,
				updatedAt: 2,
			},
		});
		const { iobroker, log } = createHarness({ 'msghub.0.NotifyPushover.0.deliveryByRef': raw });
		const store = createDeliveryStore({ iobroker, log, baseFullId: 'msghub.0.NotifyPushover.0' });

		await store.load();

		expect(store.getByRef('doorbell').imagesByValue['/tmp/cam1.jpg']).to.deep.equal({ sentAt: 1 });
		expect(store.removeByRef('doorbell')).to.equal(true);
		expect(store.getByRef('doorbell')).to.equal(null);
	});

	it('keeps empty state on invalid json and logs a warning', async () => {
		const { iobroker, log, logs } = createHarness({ 'msghub.0.NotifyPushover.0.deliveryByRef': '{ invalid' });
		const store = createDeliveryStore({ iobroker, log, baseFullId: 'msghub.0.NotifyPushover.0' });

		await store.load();

		expect(store.getByRef('doorbell')).to.equal(null);
		expect(logs.warn.length).to.be.greaterThan(0);
	});

	it('prunes stale records on save', async () => {
		const { iobroker, log, states } = createHarness();
		const store = createDeliveryStore({
			iobroker,
			log,
			baseFullId: 'msghub.0.NotifyPushover.0',
			retentionMs: 100,
		});

		store.upsert({ ref: 'old', createdAt: 1, updatedAt: 1 });
		store.upsert({ ref: 'fresh', createdAt: 1, updatedAt: 250 });
		await store.save({ nowMs: 300 });

		const persisted = JSON.parse(states.get('msghub.0.NotifyPushover.0.deliveryByRef'));
		expect(persisted).to.not.have.property('old');
		expect(persisted).to.have.property('fresh');
	});
});
