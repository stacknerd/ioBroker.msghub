'use strict';

const { expect } = require('chai');

const { IngestHue } = require('./index');
const { MsgConstants } = require('../../src/MsgConstants');

const flush = () => new Promise(resolve => setImmediate(resolve));

function makeI18n() {
	const format = (template, args) => {
		if (typeof template !== 'string') {
			return '';
		}
		let i = 0;
		return template.replace(/%s/g, () => String(args?.[i++] ?? ''));
	};
	return { t: (s, ...args) => format(String(s), args) };
}

function makeLog() {
	const calls = { debug: [], warn: [] };
	return {
		calls,
		log: {
			debug: msg => calls.debug.push(msg),
			warn: msg => calls.warn.push(msg),
		},
	};
}

function makeStore() {
	const calls = { addOrUpdateMessage: [], completeAfterCauseEliminated: [] };
	return {
		calls,
		addOrUpdateMessage(msg) {
			calls.addOrUpdateMessage.push(msg);
		},
		completeAfterCauseEliminated(ref, info) {
			calls.completeAfterCauseEliminated.push([ref, info]);
		},
	};
}

function makeFactory() {
	const calls = { createMessage: [] };
	return {
		calls,
		createMessage(payload) {
			calls.createMessage.push(payload);
			return { ...payload };
		},
	};
}

function makeManagedObjects() {
	const calls = { report: [], applyReported: 0 };
	return {
		calls,
		report(ids, info) {
			calls.report.push([ids, info]);
			return Promise.resolve();
		},
		applyReported() {
			calls.applyReported += 1;
			return Promise.resolve();
		},
	};
}

function makeIoBroker({ foreignObjects = {}, foreignStates = {} } = {}) {
	const calls = {
		subscribeForeignStates: [],
		unsubscribeForeignStates: [],
		getForeignObjects: [],
		getForeignObject: [],
		getForeignState: [],
	};

	const objects = {
		getForeignObjects(pattern) {
			calls.getForeignObjects.push(pattern);
			if (pattern === 'enum.rooms.*') {
				return Promise.resolve(
					Object.fromEntries(Object.entries(foreignObjects).filter(([id]) => id.startsWith('enum.rooms.'))),
				);
			}
			if (pattern === 'hue.*') {
				return Promise.resolve(Object.fromEntries(Object.entries(foreignObjects).filter(([id]) => id.startsWith('hue.'))));
			}
			return Promise.resolve({});
		},
		getForeignObject(id) {
			calls.getForeignObject.push(id);
			return Promise.resolve(foreignObjects[id] || null);
		},
	};

	const states = {
		getForeignState(id) {
			calls.getForeignState.push(id);
			return Promise.resolve(foreignStates[id] || null);
		},
	};

	const subscribe = {
		subscribeForeignStates(id) {
			calls.subscribeForeignStates.push(id);
		},
		unsubscribeForeignStates(id) {
			calls.unsubscribeForeignStates.push(id);
		},
	};

	return { calls, iobroker: { objects, states, subscribe } };
}

function makeCtx({ log, i18n, store, factory, iobroker, managedObjects } = {}) {
	return {
		api: {
			log,
			i18n,
			store,
			factory,
			constants: MsgConstants,
			iobroker,
		},
		meta: {
			plugin: { baseOwnId: 'IngestHue.0' },
			resources: { setTimeout, clearTimeout },
			managedObjects,
		},
	};
}

describe('IngestHue', () => {
	it('discovers battery/reachable states, subscribes, reports meta and emits messages', async () => {
		const batteryId = 'hue.0.sensor1.battery';
		const reachableId = 'hue.0.switch1.reachable';
		const excludedBatteryId = 'hue.0.lightlevel.battery';
		const excludedReachableId = 'hue.0.temp1.reachable';

		const foreignObjects = {
			'enum.rooms.living': {
				_id: 'enum.rooms.living',
				type: 'enum',
				common: { name: { en: 'Living Room' }, members: ['hue.0.sensor1', 'hue.0.switch1'] },
				native: {},
			},
			[batteryId]: { _id: batteryId, type: 'state', common: { name: { en: 'Sensor 1 Battery' } }, native: {} },
			'hue.0.sensor1': {
				_id: 'hue.0.sensor1',
				type: 'channel',
				common: { role: 'ZLLPresence', name: { en: 'Sensor 1' } },
				native: { modelid: 'SML001' },
			},
			[reachableId]: { _id: reachableId, type: 'state', common: { name: { en: 'Switch 1 Reachable' } }, native: {} },
			'hue.0.switch1': {
				_id: 'hue.0.switch1',
				type: 'channel',
				common: { role: 'ZLLSwitch', name: { en: 'Switch 1' } },
				native: {},
			},
			[excludedBatteryId]: { _id: excludedBatteryId, type: 'state', common: { name: { en: 'Noise Battery' } }, native: {} },
			'hue.0.lightlevel': { _id: 'hue.0.lightlevel', type: 'channel', common: { role: 'ZLLLightLevel' }, native: {} },
			[excludedReachableId]: { _id: excludedReachableId, type: 'state', common: { name: { en: 'Temp Reachable' } }, native: {} },
			'hue.0.temp1': { _id: 'hue.0.temp1', type: 'channel', common: { role: 'ZLLTemperature' }, native: {} },
		};

		const foreignStates = {
			[batteryId]: { val: 5 },
			[reachableId]: { val: false },
			[excludedBatteryId]: { val: 1 },
			[excludedReachableId]: { val: false },
		};

		const { log } = makeLog();
		const store = makeStore();
		const factory = makeFactory();
		const managedObjects = makeManagedObjects();
		const { calls: brokerCalls, iobroker } = makeIoBroker({ foreignObjects, foreignStates });
		const i18n = makeI18n();

		const h = IngestHue();
		h.start(makeCtx({ log, i18n, store, factory, iobroker, managedObjects }));

		await flush();
		await flush();

		expect(brokerCalls.subscribeForeignStates).to.include(batteryId);
		expect(brokerCalls.subscribeForeignStates).to.include(reachableId);
		expect(brokerCalls.subscribeForeignStates).to.not.include(excludedBatteryId);
		expect(brokerCalls.subscribeForeignStates).to.not.include(excludedReachableId);

		const reportedIds = managedObjects.calls.report.flatMap(([ids]) => ids);
		expect(reportedIds).to.include(batteryId);
		expect(reportedIds).to.include(reachableId);
		expect(reportedIds).to.not.include(excludedBatteryId);
		expect(reportedIds).to.not.include(excludedReachableId);

		const emitted = store.calls.addOrUpdateMessage;
		expect(emitted).to.have.length(2);

		const batteryMsg = emitted.find(m => m.ref === `hue:battery:${batteryId}`);
		expect(batteryMsg).to.be.an('object');
		expect(batteryMsg.kind).to.equal(MsgConstants.kind.task);
		expect(batteryMsg.level).to.equal(MsgConstants.level.warning);
		expect(batteryMsg.details).to.have.property('location', 'Living Room');
		expect(batteryMsg.details).to.have.property('consumables');
		expect(batteryMsg.details.consumables.join(',')).to.match(/AAA/);

		const reachMsg = emitted.find(m => m.ref === `hue:reachable:${reachableId}`);
		expect(reachMsg).to.be.an('object');
		expect(reachMsg.kind).to.equal(MsgConstants.kind.status);
		expect(reachMsg.level).to.equal(MsgConstants.level.error);
		expect(reachMsg.details).to.have.property('location', 'Living Room');
	});

	it('reacts to state changes only for watched ids', async () => {
		const batteryId = 'hue.0.sensor1.battery';
		const reachableId = 'hue.0.switch1.reachable';

		const foreignObjects = {
			[batteryId]: { _id: batteryId, type: 'state', common: { name: { en: 'b' } }, native: {} },
			'hue.0.sensor1': { _id: 'hue.0.sensor1', type: 'channel', common: { role: 'ZLLPresence' }, native: { modelid: 'SML001' } },
			[reachableId]: { _id: reachableId, type: 'state', common: { name: { en: 'r' } }, native: {} },
			'hue.0.switch1': { _id: 'hue.0.switch1', type: 'channel', common: { role: 'ZLLSwitch' }, native: {} },
		};
		const foreignStates = { [batteryId]: { val: 10 }, [reachableId]: { val: true } };

		const { log } = makeLog();
		const store = makeStore();
		const factory = makeFactory();
		const managedObjects = makeManagedObjects();
		const { iobroker } = makeIoBroker({ foreignObjects, foreignStates });
		const i18n = makeI18n();

		const h = IngestHue({ batteryCreateBelow: 7, batteryRemoveAbove: 30 });
		h.start(makeCtx({ log, i18n, store, factory, iobroker, managedObjects }));
		await flush();
		await flush();

		h.onStateChange(batteryId, { val: 40 });
		h.onStateChange(reachableId, { val: true });
		h.onStateChange('hue.0.unknown.battery', { val: 1 });

		const refs = store.calls.completeAfterCauseEliminated.map(([ref]) => ref);
		expect(refs).to.include(`hue:battery:${batteryId}`);
		expect(refs).to.include(`hue:reachable:${reachableId}`);
		expect(refs).to.not.include('hue:battery:hue.0.unknown.battery');
	});

	it('startup is best-effort and logs debug on discovery failures', async () => {
		const { log, calls: logCalls } = makeLog();
		const store = makeStore();
		const factory = makeFactory();
		const managedObjects = makeManagedObjects();
		const { iobroker } = makeIoBroker();
		const i18n = makeI18n();

		iobroker.objects.getForeignObjects = () => Promise.reject(new Error('boom'));

		const h = IngestHue();
		expect(() => h.start(makeCtx({ log, i18n, store, factory, iobroker, managedObjects }))).to.not.throw();

		await flush();
		await flush();

		expect(logCalls.warn.length).to.equal(0);
		expect(logCalls.debug.some(s => String(s).includes('getForeignObjects'))).to.equal(true);
		expect(managedObjects.calls.applyReported).to.equal(1);
	});
});

