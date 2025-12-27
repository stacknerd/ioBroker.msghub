'use strict';

const { expect } = require('chai');
const { MsgPlugins, MsgPluginsCategories } = require('./MsgPlugins');

function makeAdapter({ namespace = 'msghub.0', objects: initialObjects, states: initialStates } = {}) {
	const objects = new Map(Object.entries(initialObjects || {}));
	const states = new Map(Object.entries(initialStates || {}));
	const subscriptions = [];
	const calls = { delObject: [], setState: [] };
	const logs = { warn: [], error: [] };

	const adapter = {
		namespace,
		log: {
			debug() {},
			info() {},
			warn: msg => logs.warn.push(msg),
			error: msg => logs.error.push(msg),
		},
		subscribeStates: id => subscriptions.push(id),
		getObjectAsync: async id => objects.get(id),
		setObjectNotExistsAsync: async (id, obj) => {
			if (!objects.has(id)) {
				objects.set(id, obj);
			}
		},
		extendObjectAsync: async (id, patch) => {
			const cur = objects.get(id) || {};
			objects.set(id, { ...cur, ...patch, common: { ...(cur.common || {}), ...(patch.common || {}) } });
		},
		delObjectAsync: async id => {
			calls.delObject.push(id);
			objects.delete(id);
		},
		getStateAsync: async id => states.get(id),
		setStateAsync: async (id, state) => {
			calls.setState.push([id, state]);
			states.set(id, state);
		},
	};

	return { adapter, objects, states, subscriptions, calls, logs };
}

function makeMsgStore() {
	const ingestRegistered = new Set();
	const notifyRegistered = new Set();
	const ingestUnregistered = [];
	const notifyUnregistered = [];

	const msgIngest = {
		registerPlugin: id => ingestRegistered.add(id),
		unregisterPlugin: id => {
			ingestRegistered.delete(id);
			ingestUnregistered.push(id);
		},
	};
	const msgNotify = {
		registerPlugin: id => notifyRegistered.add(id),
		unregisterPlugin: id => {
			notifyRegistered.delete(id);
			notifyUnregistered.push(id);
		},
	};

	return { msgIngest, msgNotify, ingestRegistered, notifyRegistered, ingestUnregistered, notifyUnregistered };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('MsgPlugins', () => {
	it('seeds enable states from catalog defaults and subscribes to them', async () => {
		const { adapter, objects, states, subscriptions, calls } = makeAdapter();
		const store = makeMsgStore();

		const catalog = {
			[MsgPluginsCategories.ingest]: [
				{
					type: 'IngestDemo',
					label: 'Ingest Demo',
					defaultEnabled: true,
					supportsMultiple: false,
					defaultOptions: { x: 1 },
					create: () => () => {},
				},
			],
			[MsgPluginsCategories.notify]: [
				{
					type: 'NotifyDemo',
					label: 'Notify Demo',
					defaultEnabled: false,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => ({ onNotifications: () => {} }),
				},
			],
			[MsgPluginsCategories.bridge]: [
				{
					type: 'BridgeDemo',
					label: 'Bridge Demo',
					defaultEnabled: false,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => ({ ingest: () => {}, notify: { onNotifications: () => {} } }),
				},
			],
		};

		const mgr = new MsgPlugins(adapter, store, { catalog });
		await mgr.init();

		expect(subscriptions).to.deep.equal(['IngestDemo.0', 'NotifyDemo.0', 'BridgeDemo.0']);
		expect(objects.get('IngestDemo.0')?.type).to.equal('state');
		expect(objects.get('IngestDemo.0')?.native).to.deep.equal({ x: 1 });

		expect(states.get('IngestDemo.0')).to.deep.equal({ val: true, ack: true });
		expect(states.get('NotifyDemo.0')).to.deep.equal({ val: false, ack: true });
		expect(states.get('BridgeDemo.0')).to.deep.equal({ val: false, ack: true });
		expect(calls.setState).to.have.length(3);
	});

	it('does not overwrite existing enable state values', async () => {
		const { adapter, calls } = makeAdapter({
			states: {
				'IngestDemo.0': { val: false, ack: true },
			},
		});
		const store = makeMsgStore();
		const catalog = {
			[MsgPluginsCategories.ingest]: [
				{
					type: 'IngestDemo',
					label: 'Ingest Demo',
					defaultEnabled: true,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => () => {},
				},
			],
			[MsgPluginsCategories.notify]: [],
			[MsgPluginsCategories.bridge]: [],
		};

		const mgr = new MsgPlugins(adapter, store, { catalog });
		await mgr.init();

		expect(calls.setState).to.have.length(0);
	});

	it('passes pluginBaseObjectId in options when registering', async () => {
		const { adapter } = makeAdapter();
		const store = makeMsgStore();
		const received = [];

		const catalog = {
			[MsgPluginsCategories.ingest]: [
				{
					type: 'IngestDemo',
					label: 'Ingest Demo',
					defaultEnabled: true,
					supportsMultiple: false,
					defaultOptions: {},
					create: (_adapter, options) => {
						received.push(options);
						return () => {};
					},
				},
			],
			[MsgPluginsCategories.notify]: [],
			[MsgPluginsCategories.bridge]: [],
		};

		const mgr = new MsgPlugins(adapter, store, { catalog });
		await mgr.init();
		await mgr.registerEnabled();

		expect(received).to.have.length(1);
		expect(received[0].pluginBaseObjectId).to.equal('msghub.0.IngestDemo.0');
	});

	it('migrates non-state objects to state while preserving native options (best-effort)', async () => {
		const { adapter, objects, calls } = makeAdapter({
			objects: {
				'IngestDemo.0': {
					type: 'channel',
					common: { name: 'legacy' },
					native: { x: 2 },
				},
			},
		});
		const store = makeMsgStore();
		const catalog = {
			[MsgPluginsCategories.ingest]: [
				{
					type: 'IngestDemo',
					label: 'Ingest Demo',
					defaultEnabled: false,
					supportsMultiple: false,
					defaultOptions: { x: 1, y: 3 },
					create: () => () => {},
				},
			],
			[MsgPluginsCategories.notify]: [],
			[MsgPluginsCategories.bridge]: [],
		};

		const mgr = new MsgPlugins(adapter, store, { catalog });
		await mgr.init();

		expect(calls.delObject).to.deep.equal(['IngestDemo.0']);
		expect(objects.get('IngestDemo.0')?.type).to.equal('state');
		expect(objects.get('IngestDemo.0')?.native).to.deep.equal({ x: 2, y: 3 });
		expect(objects.get('IngestDemo.0')?.common?.name).to.have.property('en');
	});

	it('toggles plugins on ack:false state changes and ignores ack:true writes', async () => {
		const { adapter, states } = makeAdapter();
		const store = makeMsgStore();

		const catalog = {
			[MsgPluginsCategories.ingest]: [
				{
					type: 'IngestDemo',
					label: 'Ingest Demo',
					defaultEnabled: true,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => () => {},
				},
			],
			[MsgPluginsCategories.notify]: [],
			[MsgPluginsCategories.bridge]: [],
		};

		const mgr = await MsgPlugins.create(adapter, store, { catalog });
		expect(store.ingestRegistered.has('IngestDemo:0')).to.equal(true);

		// ack:true writes are ignored (including our own "commit" writes).
		mgr.handleStateChange('msghub.0.IngestDemo.0', { val: false, ack: true });
		expect(store.ingestRegistered.has('IngestDemo:0')).to.equal(true);

		// Disable via state change (ack:false = user intent).
		mgr.handleStateChange('msghub.0.IngestDemo.0', { val: false, ack: false });
		await mgr._queue.current;
		await flush();

		expect(store.ingestRegistered.has('IngestDemo:0')).to.equal(false);
		expect(store.ingestUnregistered).to.deep.equal(['IngestDemo:0']);
		expect(states.get('IngestDemo.0')).to.deep.equal({ val: false, ack: true });
	});

	describe('bridge wiring', () => {
		it('registers/unregisters a bridge as ingest+notify pair', async () => {
			const { adapter } = makeAdapter();
			const store = makeMsgStore();

			const catalog = {
				[MsgPluginsCategories.ingest]: [],
				[MsgPluginsCategories.notify]: [],
				[MsgPluginsCategories.bridge]: [
					{
						type: 'BridgeTest',
						label: 'Bridge Test',
						defaultEnabled: true,
						supportsMultiple: false,
						defaultOptions: {},
						create: () => ({
							ingest: () => {},
							notify: { onNotifications: () => {} },
						}),
					},
				],
			};

			const mgr = await MsgPlugins.create(adapter, store, { catalog });

			expect(store.ingestRegistered.has('BridgeTest:0')).to.equal(true);
			expect(store.notifyRegistered.has('BridgeTest:0')).to.equal(true);

			// Disable via state change (ack:false = user intent).
			mgr.handleStateChange('msghub.0.BridgeTest.0', { val: false, ack: false });
			await mgr._queue.current;
			await flush();

			expect(store.ingestRegistered.has('BridgeTest:0')).to.equal(false);
			expect(store.notifyRegistered.has('BridgeTest:0')).to.equal(false);
			expect(store.ingestUnregistered).to.deep.equal(['BridgeTest:0']);
			expect(store.notifyUnregistered).to.deep.equal(['BridgeTest:0']);
		});
	});

	it('does not abort startup when one enabled plugin fails to create', async () => {
		const { adapter } = makeAdapter();
		const store = makeMsgStore();

		const catalog = {
			[MsgPluginsCategories.ingest]: [
				{
					type: 'IngestBoom',
					label: 'Broken ingest plugin',
					defaultEnabled: true,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => {
						throw new Error('boom');
					},
				},
			],
			[MsgPluginsCategories.notify]: [
				{
					type: 'NotifyOk',
					label: 'Working notify plugin',
					defaultEnabled: true,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => ({ onNotifications: () => {} }),
				},
			],
			[MsgPluginsCategories.bridge]: [],
		};

		const mgr = await MsgPlugins.create(adapter, store, { catalog });
		expect(mgr).to.be.ok;

		expect(store.ingestRegistered.has('IngestBoom:0')).to.equal(false);
		expect(store.notifyRegistered.has('NotifyOk:0')).to.equal(true);
	});

	it('rejects catalog entries with wrong type prefix for their category', async () => {
		const { adapter } = makeAdapter();
		const store = makeMsgStore();
		const catalog = {
			[MsgPluginsCategories.ingest]: [
				{
					type: 'BadType',
					label: 'Bad',
					defaultEnabled: true,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => () => {},
				},
			],
			[MsgPluginsCategories.notify]: [],
			[MsgPluginsCategories.bridge]: [],
		};

		let err;
		try {
			await MsgPlugins.create(adapter, store, { catalog });
		} catch (e) {
			err = e;
		}
		expect(err).to.be.instanceof(Error);
		expect(err.message).to.match(/must start with 'Ingest'/);
	});
});

