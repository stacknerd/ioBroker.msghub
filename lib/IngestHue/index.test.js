'use strict';

const { expect } = require('chai');
const { format } = require('node:util');

const { IngestHue } = require('./index');
const { manifest } = require('./manifest');
const { MsgConstants } = require('../../src/MsgConstants');

const flush = () => new Promise(resolve => setImmediate(resolve));

const translations = Object.freeze({
	'msghub.i18n.core.common.consumables.battery.aaa.label': 'AAA',
	'msghub.i18n.core.common.consumables.battery.cr2032.label': 'CR2032',
	'msghub.i18n.core.common.tools.screwdriver.ph2.label': 'PH2 Phillips screwdriver',
	'msghub.i18n.core.common.tools.unknown.label': 'Unknown tool',
	'msghub.i18n.IngestHue.managed.battery.text': 'Battery states below %s and closed at %s.',
	'msghub.i18n.IngestHue.managed.reachable.text': 'Reachability states are monitored.',
	'msghub.i18n.IngestHue.model.dimmerSwitch.label': 'Dimmer switch',
	'msghub.i18n.IngestHue.model.hueDevice.label': 'Hue device',
	'msghub.i18n.IngestHue.model.motionSensor.label': 'Motion sensor',
	'msghub.i18n.IngestHue.model.smartButton.label': 'Smart button',
	'msghub.i18n.IngestHue.msg.battery.reason': 'Battery level is %s%%',
	'msghub.i18n.IngestHue.msg.battery.task': 'Replace batteries in "%s"',
	'msghub.i18n.IngestHue.msg.battery.text': 'The battery is down to %s%%. Please replace it soon.',
	'msghub.i18n.IngestHue.msg.battery.title': "%s '%s': battery low",
	'msghub.i18n.IngestHue.msg.reachable.reason': 'Device is not reachable',
	'msghub.i18n.IngestHue.msg.reachable.text': 'The device has been unreachable for {{m.state-lc|durationSince}}.',
	'msghub.i18n.IngestHue.msg.reachable.title': "%s '%s': not reachable",
});

function makeI18n() {
	return {
		t(key, ...args) {
			return format(translations[key] || key, ...args);
		},
	};
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
	const messages = new Map();
	const calls = { addOrUpdateMessage: [], getMessageByRef: [], updateMessage: [], completeAfterCauseEliminated: [] };
	return {
		calls,
		addOrUpdateMessage(msg) {
			calls.addOrUpdateMessage.push(msg);
			messages.set(msg.ref, msg);
			return true;
		},
		getMessageByRef(ref, filter = 'all') {
			calls.getMessageByRef.push([ref, filter]);
			return messages.get(ref);
		},
		updateMessage(ref, patch) {
			calls.updateMessage.push([ref, patch]);
			const existing = messages.get(ref);
			if (!existing) {
				return false;
			}
			const next = { ...existing };
			for (const key of ['icon', 'title', 'text', 'level', 'details']) {
				if (Object.prototype.hasOwnProperty.call(patch, key)) {
					next[key] = patch[key];
				}
			}
			if (patch.timing) {
				next.timing = { ...(next.timing || {}) };
				for (const [key, value] of Object.entries(patch.timing)) {
					if (value === null) {
						delete next.timing[key];
					} else {
						next.timing[key] = value;
					}
				}
			}
			if (patch.metrics) {
				next.metrics = next.metrics instanceof Map ? new Map(next.metrics) : new Map();
				for (const [key, value] of Object.entries(patch.metrics.set || {})) {
					next.metrics.set(key, value);
				}
				for (const key of patch.metrics.delete || []) {
					next.metrics.delete(key);
				}
			}
			messages.set(ref, next);
			return true;
		},
		completeAfterCauseEliminated(ref, info) {
			calls.completeAfterCauseEliminated.push([ref, info]);
			return true;
		},
	};
}

function makeFactory() {
	return {
		createMessage(payload) {
			return { ...payload };
		},
	};
}

function makeManagedObjects() {
	const calls = { report: [], applyReported: 0 };
	return {
		calls,
		report(ids, info) {
			calls.report.push([Array.isArray(ids) ? ids.slice() : ids, info]);
			return Promise.resolve();
		},
		applyReported() {
			calls.applyReported += 1;
			return Promise.resolve();
		},
	};
}

function makeResources() {
	const calls = { setInterval: [], clearInterval: [] };
	let nextHandle = 1;
	return {
		calls,
		resources: {
			setInterval(fn, ms) {
				const handle = nextHandle++;
				calls.setInterval.push({ handle, fn, ms });
				return handle;
			},
			clearInterval(handle) {
				calls.clearInterval.push(handle);
			},
		},
	};
}

function makeIoBroker({ foreignObjects = {}, foreignStates = {} } = {}) {
	const calls = {
		getForeignObjects: [],
		getForeignObject: [],
		getForeignState: [],
		subscribeForeignStates: [],
		unsubscribeForeignStates: [],
	};

	const objects = {
		getForeignObjects(pattern) {
			calls.getForeignObjects.push(pattern);
			if (pattern === 'enum.rooms.*') {
				return Promise.resolve(
					Object.fromEntries(Object.entries(foreignObjects).filter(([id]) => id.startsWith('enum.rooms.'))),
				);
			}
			if (pattern.endsWith('.*')) {
				const prefix = pattern.slice(0, -1);
				return Promise.resolve(
					Object.fromEntries(Object.entries(foreignObjects).filter(([id]) => id.startsWith(prefix))),
				);
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

function makeOptions(overrides = {}) {
	const specs = manifest.options;
	return {
		resolveString(key, value) {
			const raw = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : value;
			if (typeof raw === 'string') {
				return specs[key]?.trim === false ? raw : raw.trim();
			}
			return String(specs[key]?.default || '');
		},
		resolveInt(key, value) {
			const raw = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : value;
			const n = typeof raw === 'number' ? raw : Number(raw);
			const fallback = specs[key]?.default || 0;
			const finite = Number.isFinite(n) ? Math.trunc(n) : fallback;
			return Math.min(specs[key]?.max ?? finite, Math.max(specs[key]?.min ?? finite, finite));
		},
		resolveBool(key, value) {
			const raw = Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : value;
			return typeof raw === 'boolean' ? raw : specs[key]?.default === true;
		},
	};
}

function makeCtx({ log, iobroker, store, factory, managedObjects, resources, options = {} }) {
	return {
		api: {
			log,
			i18n: makeI18n(),
			iobroker,
			store,
			factory,
			constants: MsgConstants,
		},
		meta: {
			options: makeOptions(options),
			resources,
			plugin: {
				type: 'IngestHue',
				instanceId: 0,
				regId: 'IngestHue:0',
				baseOwnId: 'IngestHue.0',
			},
			managedObjects,
		},
	};
}

describe('IngestHue', () => {
	it('discovers configured Hue states, subscribes, reports metadata, and emits messages', async () => {
		const batteryId = 'hue.1.sensor1.battery';
		const reachableId = 'hue.1.switch1.reachable';
		const excludedBatteryId = 'hue.1.lightlevel.battery';
		const excludedReachableId = 'hue.1.temp1.reachable';
		const otherInstanceId = 'hue.0.sensor1.battery';
		const foreignObjects = {
			'enum.rooms.living': {
				_id: 'enum.rooms.living',
				type: 'enum',
				common: { name: { en: 'Living Room' }, members: ['hue.1.sensor1', 'hue.1.switch1'] },
				native: {},
			},
			'hue.1.sensor1': {
				_id: 'hue.1.sensor1',
				type: 'channel',
				common: { role: 'ZLLPresence', name: { en: 'Motion A' } },
				native: { modelid: 'SML001' },
			},
			[batteryId]: { _id: batteryId, type: 'state', common: { name: { en: 'Battery' }, unit: '%' }, native: {} },
			'hue.1.switch1': {
				_id: 'hue.1.switch1',
				type: 'channel',
				common: { role: 'ZLLSwitch', name: { en: 'Switch A' } },
				native: { modelid: 'RDM003' },
			},
			[reachableId]: { _id: reachableId, type: 'state', common: { name: { en: 'Reachable' } }, native: {} },
			'hue.1.lightlevel': {
				_id: 'hue.1.lightlevel',
				type: 'channel',
				common: { role: 'ZLLLightLevel', name: { en: 'Light level' } },
				native: {},
			},
			[excludedBatteryId]: { _id: excludedBatteryId, type: 'state', common: { name: { en: 'Noise' } }, native: {} },
			'hue.1.temp1': {
				_id: 'hue.1.temp1',
				type: 'channel',
				common: { role: 'ZLLTemperature', name: { en: 'Temperature' } },
				native: {},
			},
			[excludedReachableId]: {
				_id: excludedReachableId,
				type: 'state',
				common: { name: { en: 'Temp reachable' } },
				native: {},
			},
			'hue.0.sensor1': {
				_id: 'hue.0.sensor1',
				type: 'channel',
				common: { role: 'ZLLPresence', name: { en: 'Other' } },
				native: { modelid: 'SML001' },
			},
			[otherInstanceId]: { _id: otherInstanceId, type: 'state', common: { name: 'Other battery' }, native: {} },
		};
		const foreignStates = {
			[batteryId]: { val: 5, lc: 1000, ts: 2000 },
			[reachableId]: { val: false, lc: 3000, ts: 4000 },
			[excludedBatteryId]: { val: 1 },
			[excludedReachableId]: { val: false },
			[otherInstanceId]: { val: 1 },
		};

		const { log } = makeLog();
		const store = makeStore();
		const factory = makeFactory();
		const managedObjects = makeManagedObjects();
		const { resources } = makeResources();
		const { calls: brokerCalls, iobroker } = makeIoBroker({ foreignObjects, foreignStates });

		const plugin = IngestHue();
		plugin.start(
			makeCtx({
				log,
				iobroker,
				store,
				factory,
				managedObjects,
				resources,
				options: {
					hueInstance: 'hue.1',
					audienceTagsCsv: 'ops, hue',
					audienceChannelsIncludeCsv: 'telegram, pushover',
					audienceChannelsExcludeCsv: 'debug',
				},
			}),
		);
		await flush();
		await flush();

		expect(brokerCalls.getForeignObjects).to.include('hue.1.*');
		expect(brokerCalls.subscribeForeignStates).to.include(batteryId);
		expect(brokerCalls.subscribeForeignStates).to.include(reachableId);
		expect(brokerCalls.subscribeForeignStates).to.not.include(excludedBatteryId);
		expect(brokerCalls.subscribeForeignStates).to.not.include(excludedReachableId);
		expect(brokerCalls.subscribeForeignStates).to.not.include(otherInstanceId);

		const reportedIds = managedObjects.calls.report.flatMap(([ids]) => ids);
		expect(reportedIds).to.include(batteryId);
		expect(reportedIds).to.include(reachableId);

		const emitted = store.calls.addOrUpdateMessage;
		expect(emitted).to.have.length(2);

		const batteryMsg = emitted.find(m => m.ref === `IngestHue.0.${batteryId}`);
		expect(batteryMsg).to.include({
			icon: '🪫',
			kind: MsgConstants.kind.task,
			level: MsgConstants.level.warning,
			title: "Motion sensor 'Motion A': battery low",
		});
		expect(batteryMsg.origin).to.deep.equal({
			type: MsgConstants.origin.type.automation,
			system: 'hue.1',
			id: batteryId,
		});
		expect(batteryMsg.timing).to.have.property('timeBudget', 600000);
		expect(batteryMsg.timing.notifyAt).to.be.a('number');
		expect(batteryMsg.timing.remindEvery).to.equal(48 * 60 * 60 * 1000);
		expect(batteryMsg.timing.dueAt - batteryMsg.timing.notifyAt).to.equal(7 * 24 * 60 * 60 * 1000);
		expect(batteryMsg.audience).to.deep.equal({
			tags: ['ops', 'hue'],
			channels: { include: ['telegram', 'pushover'], exclude: ['debug'] },
		});
		expect(batteryMsg.details).to.include({
			location: 'Living Room',
			task: 'Replace batteries in "Motion A"',
			reason: 'Battery level is 5%',
		});
		expect(batteryMsg.details.consumables).to.deep.equal(['AAA', 'AAA']);
		expect(batteryMsg.details.tools).to.deep.equal(['PH2 Phillips screwdriver']);
		expect(batteryMsg.metrics.get('state-value')).to.include({ val: 5, unit: '%' });
		expect(batteryMsg.metrics.get('state-value').ts).to.be.a('number');
		expect(batteryMsg.metrics.get('state-lc')).to.include({ val: 1000, unit: 'ms' });
		expect(batteryMsg.metrics.get('state-ts')).to.include({ val: 2000, unit: 'ms' });

		const reachableMsg = emitted.find(m => m.ref === `IngestHue.0.${reachableId}`);
		expect(reachableMsg).to.include({
			icon: '⛔',
			kind: MsgConstants.kind.status,
			level: MsgConstants.level.error,
			title: "Smart button 'Switch A': not reachable",
		});
		expect(reachableMsg.details).to.include({
			location: 'Living Room',
			reason: 'Device is not reachable',
		});
		expect(reachableMsg.timing.notifyAt).to.be.a('number');
		expect(reachableMsg.timing.remindEvery).to.equal(24 * 60 * 60 * 1000);
		expect(reachableMsg.timing).to.not.have.property('dueAt');
		expect(reachableMsg.audience).to.deep.equal({
			tags: ['ops', 'hue'],
			channels: { include: ['telegram', 'pushover'], exclude: ['debug'] },
		});
		expect(reachableMsg.metrics.get('state-value')).to.include({ val: false, unit: '' });
		expect(reachableMsg.metrics.get('state-lc')).to.include({ val: 3000, unit: 'ms' });
		expect(reachableMsg.metrics.get('state-ts')).to.include({ val: 4000, unit: 'ms' });
	});

	it('updates state metrics only when the watched state data actually changes', async () => {
		const batteryId = 'hue.0.sensor1.battery';
		const foreignObjects = {
			'hue.0.sensor1': {
				_id: 'hue.0.sensor1',
				type: 'channel',
				common: { role: 'ZLLPresence', name: { en: 'Motion A' } },
				native: { modelid: 'SML001' },
			},
			[batteryId]: { _id: batteryId, type: 'state', common: { name: 'Battery', unit: '%' }, native: {} },
		};
		const foreignStates = { [batteryId]: { val: 5, lc: 1000, ts: 2000 } };
		const { log } = makeLog();
		const store = makeStore();
		const factory = makeFactory();
		const managedObjects = makeManagedObjects();
		const { resources } = makeResources();
		const { iobroker } = makeIoBroker({ foreignObjects, foreignStates });
		const plugin = IngestHue();

		plugin.start(
			makeCtx({
				log,
				iobroker,
				store,
				factory,
				managedObjects,
				resources,
				options: { audienceTagsCsv: 'static' },
			}),
		);
		await flush();
		await flush();

		store.calls.updateMessage.length = 0;
		plugin.onStateChange(batteryId, { val: 5, lc: 1000, ts: 2000 });
		expect(store.calls.updateMessage).to.have.length(0);

		plugin.onStateChange(batteryId, { val: 5, lc: 1000, ts: 2001 });
		expect(store.calls.updateMessage).to.have.length(1);
		const patch = store.calls.updateMessage[0][1];
		expect(Object.keys(patch)).to.deep.equal(['metrics']);
		const metricsPatch = patch.metrics;
		expect(metricsPatch.set).to.have.all.keys(['state-ts']);
		expect(metricsPatch.set['state-ts']).to.include({ val: 2001, unit: 'ms' });
		expect(metricsPatch.set['state-ts'].ts).to.be.a('number');
	});

	it('omits timeBudget for unknown Hue models', async () => {
		const batteryId = 'hue.0.unknown.battery';
		const foreignObjects = {
			'hue.0.unknown': {
				_id: 'hue.0.unknown',
				type: 'channel',
				common: { role: 'ZLLPresence', name: { en: 'Unknown A' } },
				native: { modelid: 'UNKNOWN' },
			},
			[batteryId]: { _id: batteryId, type: 'state', common: { name: 'Battery' }, native: {} },
		};
		const foreignStates = { [batteryId]: { val: 5 } };
		const { log } = makeLog();
		const store = makeStore();
		const factory = makeFactory();
		const managedObjects = makeManagedObjects();
		const { resources } = makeResources();
		const { iobroker } = makeIoBroker({ foreignObjects, foreignStates });
		const plugin = IngestHue();

		plugin.start(makeCtx({ log, iobroker, store, factory, managedObjects, resources }));
		await flush();
		await flush();

		const msg = store.calls.addOrUpdateMessage.find(m => m.ref === `IngestHue.0.${batteryId}`);
		expect(msg).to.be.an('object');
		expect(msg.timing).to.have.property('notifyAt').that.is.a('number');
		expect(msg.timing).to.have.property('remindEvery', 48 * 60 * 60 * 1000);
		expect(msg.timing).to.not.have.property('timeBudget');
	});

	it('closes messages by cause-eliminated when state values recover', async () => {
		const batteryId = 'hue.0.sensor1.battery';
		const reachableId = 'hue.0.switch1.reachable';
		const foreignObjects = {
			'hue.0.sensor1': {
				_id: 'hue.0.sensor1',
				type: 'channel',
				common: { role: 'ZLLPresence', name: { en: 'Motion A' } },
				native: { modelid: 'SML001' },
			},
			[batteryId]: { _id: batteryId, type: 'state', common: { name: 'Battery' }, native: {} },
			'hue.0.switch1': {
				_id: 'hue.0.switch1',
				type: 'channel',
				common: { role: 'ZLLSwitch', name: { en: 'Switch A' } },
				native: {},
			},
			[reachableId]: { _id: reachableId, type: 'state', common: { name: 'Reachable' }, native: {} },
		};
		const foreignStates = { [batteryId]: { val: 10 }, [reachableId]: { val: false } };
		const { log } = makeLog();
		const store = makeStore();
		const factory = makeFactory();
		const managedObjects = makeManagedObjects();
		const { resources } = makeResources();
		const { iobroker } = makeIoBroker({ foreignObjects, foreignStates });
		const plugin = IngestHue();

		plugin.start(makeCtx({ log, iobroker, store, factory, managedObjects, resources }));
		await flush();
		await flush();

		plugin.onStateChange(batteryId, { val: 30 });
		plugin.onStateChange(reachableId, { val: true });
		plugin.onStateChange('hue.0.unknown.battery', { val: 100 });

		expect(store.calls.completeAfterCauseEliminated).to.deep.include([
			`IngestHue.0.${batteryId}`,
			{ actor: 'IngestHue:0' },
		]);
		expect(store.calls.completeAfterCauseEliminated).to.deep.include([
			`IngestHue.0.${reachableId}`,
			{ actor: 'IngestHue:0' },
		]);
		expect(store.calls.completeAfterCauseEliminated.map(([ref]) => ref)).to.not.include(
			'IngestHue.0.hue.0.unknown.battery',
		);
	});

	it('honors monitor checkboxes and disables the periodic rescan at zero milliseconds', async () => {
		const batteryId = 'hue.0.sensor1.battery';
		const reachableId = 'hue.0.switch1.reachable';
		const foreignObjects = {
			'hue.0.sensor1': {
				_id: 'hue.0.sensor1',
				type: 'channel',
				common: { role: 'ZLLPresence', name: { en: 'Motion A' } },
				native: { modelid: 'SML001' },
			},
			[batteryId]: { _id: batteryId, type: 'state', common: { name: 'Battery' }, native: {} },
			'hue.0.switch1': {
				_id: 'hue.0.switch1',
				type: 'channel',
				common: { role: 'ZLLSwitch', name: { en: 'Switch A' } },
				native: {},
			},
			[reachableId]: { _id: reachableId, type: 'state', common: { name: 'Reachable' }, native: {} },
		};
		const foreignStates = { [batteryId]: { val: 1 }, [reachableId]: { val: false } };
		const { log } = makeLog();
		const store = makeStore();
		const factory = makeFactory();
		const managedObjects = makeManagedObjects();
		const { calls: resourceCalls, resources } = makeResources();
		const { calls: brokerCalls, iobroker } = makeIoBroker({ foreignObjects, foreignStates });
		const plugin = IngestHue();

		plugin.start(
			makeCtx({
				log,
				iobroker,
				store,
				factory,
				managedObjects,
				resources,
				options: { monitorBattery: false, monitorReachable: true, rescanIntervalMs: 0 },
			}),
		);
		await flush();
		await flush();

		expect(resourceCalls.setInterval).to.have.length(0);
		expect(brokerCalls.subscribeForeignStates).to.not.include(batteryId);
		expect(brokerCalls.subscribeForeignStates).to.include(reachableId);
		expect(store.calls.addOrUpdateMessage.map(m => m.ref)).to.deep.equal([`IngestHue.0.${reachableId}`]);
	});

	it('uses the periodic rescan to add new Hue states and unsubscribe removed states', async () => {
		const firstId = 'hue.0.first.battery';
		const secondId = 'hue.0.second.battery';
		const foreignObjects = {
			'hue.0.first': {
				_id: 'hue.0.first',
				type: 'channel',
				common: { role: 'ZLLPresence', name: { en: 'First' } },
				native: { modelid: 'SML001' },
			},
			[firstId]: { _id: firstId, type: 'state', common: { name: 'Battery' }, native: {} },
		};
		const foreignStates = { [firstId]: { val: 5 }, [secondId]: { val: 5 } };
		const { log } = makeLog();
		const store = makeStore();
		const factory = makeFactory();
		const managedObjects = makeManagedObjects();
		const { calls: resourceCalls, resources } = makeResources();
		const { calls: brokerCalls, iobroker } = makeIoBroker({ foreignObjects, foreignStates });
		const plugin = IngestHue();

		plugin.start(
			makeCtx({
				log,
				iobroker,
				store,
				factory,
				managedObjects,
				resources,
				options: { rescanIntervalMs: 1000 },
			}),
		);
		await flush();
		await flush();

		expect(resourceCalls.setInterval).to.have.length(1);
		delete foreignObjects[firstId];
		delete foreignObjects['hue.0.first'];
		foreignObjects['hue.0.second'] = {
			_id: 'hue.0.second',
			type: 'channel',
			common: { role: 'ZLLPresence', name: { en: 'Second' } },
			native: { modelid: 'SML001' },
		};
		foreignObjects[secondId] = { _id: secondId, type: 'state', common: { name: 'Battery' }, native: {} };

		await resourceCalls.setInterval[0].fn();
		await flush();

		expect(brokerCalls.unsubscribeForeignStates).to.include(firstId);
		expect(brokerCalls.subscribeForeignStates).to.include(secondId);
		expect(store.calls.addOrUpdateMessage.map(m => m.ref)).to.include(`IngestHue.0.${secondId}`);
	});

	it('keeps startup best-effort when discovery fails', async () => {
		const { log, calls: logCalls } = makeLog();
		const store = makeStore();
		const factory = makeFactory();
		const managedObjects = makeManagedObjects();
		const { resources } = makeResources();
		const { iobroker } = makeIoBroker();
		iobroker.objects.getForeignObjects = () => Promise.reject(new Error('boom'));
		const plugin = IngestHue();

		expect(() => plugin.start(makeCtx({ log, iobroker, store, factory, managedObjects, resources }))).to.not.throw();
		await flush();
		await flush();

		expect(logCalls.debug.some(msg => String(msg).includes('getForeignObjects'))).to.equal(true);
		expect(logCalls.warn).to.have.length(0);
		expect(managedObjects.calls.applyReported).to.equal(1);
	});
});
