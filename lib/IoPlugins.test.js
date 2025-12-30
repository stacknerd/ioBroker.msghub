'use strict';

const { expect } = require('chai');
const { IoPlugins, IoPluginsCategories } = require('./IoPlugins');
const { MsgConstants } = require('../src/MsgConstants');

function makeAdapter({ namespace = 'msghub.0', objects: initialObjects, states: initialStates } = {}) {
	const objects = new Map(Object.entries(initialObjects || {}));
	const states = new Map(Object.entries(initialStates || {}));
	const subscriptions = [];
	const calls = { delObject: [], setState: [] };
	const logs = { warn: [], error: [] };

	const formatTemplate = (template, args) => {
		if (typeof template !== 'string') {
			return '';
		}
		let i = 0;
		return template.replace(/%s/g, () => String(args?.[i++] ?? ''));
	};

	const adapter = {
		namespace,
		i18n: {
			t: (s, ...args) => formatTemplate(s, args),
			getTranslatedObject: (s, ...args) => {
				const txt = formatTemplate(s, args);
				return { en: txt, de: txt };
			},
		},
		log: {
			debug() {},
			info() {},
			warn: msg => logs.warn.push(msg),
			error: msg => logs.error.push(msg),
		},
		subscribeStates: id => subscriptions.push(id),
		getObjectAsync: async id => objects.get(id),
		getForeignObjectAsync: async id => objects.get(id) || null,
		setObjectNotExistsAsync: async (id, obj) => {
			if (!objects.has(id)) {
				objects.set(id, obj);
			}
		},
		extendObjectAsync: async (id, patch) => {
			const cur = objects.get(id) || {};
			objects.set(id, { ...cur, ...patch, common: { ...(cur.common || {}), ...(patch.common || {}) } });
		},
		extendForeignObjectAsync: async (id, patch) => {
			const cur = objects.get(id) || {};
			const next = { ...cur, ...patch };
			const curCommon = (cur && typeof cur.common === 'object' && cur.common && !Array.isArray(cur.common)) ? cur.common : {};
			const patchCommon = (patch && typeof patch.common === 'object' && patch.common && !Array.isArray(patch.common)) ? patch.common : {};
			next.common = { ...curCommon, ...patchCommon };

			// Deep-merge `common.custom` (needed for managedMeta stamping).
			const curCustom = (curCommon && typeof curCommon.custom === 'object' && curCommon.custom && !Array.isArray(curCommon.custom)) ? curCommon.custom : {};
			const patchCustom = (patchCommon && typeof patchCommon.custom === 'object' && patchCommon.custom && !Array.isArray(patchCommon.custom)) ? patchCommon.custom : {};
			const mergedCustom = { ...curCustom, ...patchCustom };
			for (const [key, val] of Object.entries(patchCustom)) {
				if (val && typeof val === 'object' && !Array.isArray(val) && curCustom[key] && typeof curCustom[key] === 'object') {
					const curEntry = curCustom[key];
					const patchEntry = val;
					mergedCustom[key] = { ...curEntry, ...patchEntry };
					if (patchEntry.managedMeta && typeof patchEntry.managedMeta === 'object' && curEntry.managedMeta && typeof curEntry.managedMeta === 'object') {
						mergedCustom[key].managedMeta = { ...curEntry.managedMeta, ...patchEntry.managedMeta };
					}
				}
			}
			if (Object.keys(mergedCustom).length > 0) {
				next.common.custom = mergedCustom;
			}

			objects.set(id, next);
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

	return {
		msgIngest,
		msgNotify,
		msgConstants: MsgConstants,
		getMessageByRef: () => undefined,
		updateMessage: () => true,
		ingestRegistered,
		notifyRegistered,
		ingestUnregistered,
		notifyUnregistered,
	};
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('IoPlugins', () => {
	it('seeds enable states from catalog defaults and subscribes to them', async () => {
		const { adapter, objects, states, subscriptions, calls } = makeAdapter();
		const store = makeMsgStore();

		const catalog = {
			[IoPluginsCategories.ingest]: [
				{
					type: 'IngestDemo',
					label: 'Ingest Demo',
					defaultEnabled: true,
					supportsMultiple: false,
					defaultOptions: { x: 1 },
					create: () => () => {},
				},
			],
			[IoPluginsCategories.notify]: [
				{
					type: 'NotifyDemo',
					label: 'Notify Demo',
					defaultEnabled: false,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => ({ onNotifications: () => {} }),
				},
			],
			[IoPluginsCategories.bridge]: [
				{
					type: 'BridgeDemo',
					label: 'Bridge Demo',
					defaultEnabled: false,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => ({ start: () => {}, onNotifications: () => {} }),
				},
			],
		};

		const mgr = new IoPlugins(adapter, store, { catalog });
		await mgr.init();

			expect(subscriptions).to.deep.equal(['IngestDemo.0.enable', 'NotifyDemo.0.enable', 'BridgeDemo.0.enable']);
			expect(objects.get('IngestDemo.0')?.type).to.equal('channel');
			expect(objects.get('IngestDemo.0')?.native).to.deep.equal({ x: 1 });
			expect(objects.get('IngestDemo.0.enable')?.type).to.equal('state');
			expect(objects.get('IngestDemo.0.status')?.type).to.equal('state');

			expect(states.get('IngestDemo.0.enable')).to.deep.equal({ val: true, ack: true });
			expect(states.get('NotifyDemo.0.enable')).to.deep.equal({ val: false, ack: true });
			expect(states.get('BridgeDemo.0.enable')).to.deep.equal({ val: false, ack: true });
			expect(states.get('IngestDemo.0.status')).to.deep.equal({ val: 'stopped', ack: true });
			expect(states.get('NotifyDemo.0.status')).to.deep.equal({ val: 'stopped', ack: true });
			expect(states.get('BridgeDemo.0.status')).to.deep.equal({ val: 'stopped', ack: true });
			expect(calls.setState).to.have.length(6);
		});

	it('does not overwrite existing enable state values', async () => {
		const { adapter, calls } = makeAdapter({
			states: {
				'IngestDemo.0.enable': { val: false, ack: true },
			},
		});
		const store = makeMsgStore();
		const catalog = {
			[IoPluginsCategories.ingest]: [
				{
					type: 'IngestDemo',
					label: 'Ingest Demo',
					defaultEnabled: true,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => () => {},
				},
			],
			[IoPluginsCategories.notify]: [],
			[IoPluginsCategories.bridge]: [],
		};

			const mgr = new IoPlugins(adapter, store, { catalog });
			await mgr.init();

			// Enable value must not be overwritten; status may be seeded.
			expect(calls.setState).to.have.length(1);
		});

	it('passes pluginBaseObjectId in options when registering', async () => {
		const { adapter } = makeAdapter();
		const store = makeMsgStore();
		const received = [];

		const catalog = {
			[IoPluginsCategories.ingest]: [
					{
						type: 'IngestDemo',
						label: 'Ingest Demo',
						defaultEnabled: true,
						supportsMultiple: false,
						defaultOptions: {},
						create: options => {
							received.push(options);
							return () => {};
						},
					},
				],
			[IoPluginsCategories.notify]: [],
			[IoPluginsCategories.bridge]: [],
		};

		const mgr = new IoPlugins(adapter, store, { catalog });
		await mgr.init();
		await mgr.registerEnabled();

		expect(received).to.have.length(1);
		expect(received[0].pluginBaseObjectId).to.equal('msghub.0.IngestDemo.0');
	});

	it('writes managedMeta under common.custom.<namespace>', async () => {
		const foreignId = 'hue.0.demoSwitch1.battery';
		const { adapter, objects } = makeAdapter({
			objects: {
				[foreignId]: {
					_id: foreignId,
					type: 'state',
					common: { name: 'Battery', custom: {} },
					native: {},
				},
			},
		});
		const store = makeMsgStore();

		const catalog = {
			[IoPluginsCategories.ingest]: [
				{
					type: 'IngestDemo',
					label: 'Ingest Demo',
					defaultEnabled: false,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => () => {},
				},
			],
			[IoPluginsCategories.notify]: [],
			[IoPluginsCategories.bridge]: [],
			[IoPluginsCategories.engage]: [],
		};

			const mgr = new IoPlugins(adapter, store, { catalog });
			await mgr.init();

			const reporter = mgr._managedMeta.createReporter({
				category: IoPluginsCategories.ingest,
				type: 'IngestDemo',
				instanceId: 0,
				pluginBaseObjectId: 'msghub.0.IngestDemo.0',
			});
			await reporter.report(foreignId, { managedText: 'x' });
			await reporter.applyReported();

			const updated = objects.get(foreignId);
			expect(updated?.common?.custom).to.have.property('msghub.0');
			expect(updated.common.custom['msghub.0']).to.have.property('managedMeta');
			expect(updated.common.custom['msghub.0'].managedMeta).to.include({
				managedBy: 'msghub.0.IngestDemo.0',
				managedText: 'x',
			});
			expect(updated.common.custom['msghub.0'].managedMeta.managedSince).to.be.a('string');
			expect(updated?.native?.meta).to.equal(undefined);
		});

	it('throws when a plugin base object exists with an incompatible type', async () => {
		const { adapter, objects, states, calls } = makeAdapter({
			objects: {
				'IngestDemo.0': {
					type: 'state',
					common: { name: 'existing' },
					native: { x: 2 },
				},
			},
			states: {
				'IngestDemo.0': { val: false, ack: true },
			},
		});
		const store = makeMsgStore();
		const catalog = {
			[IoPluginsCategories.ingest]: [
				{
					type: 'IngestDemo',
					label: 'Ingest Demo',
					defaultEnabled: false,
					supportsMultiple: false,
					defaultOptions: { x: 1, y: 3 },
					create: () => () => {},
				},
			],
			[IoPluginsCategories.notify]: [],
			[IoPluginsCategories.bridge]: [],
		};

		const mgr = new IoPlugins(adapter, store, { catalog });
		let caught = null;
		try {
			await mgr.init();
		} catch (e) {
			caught = e;
		}

		expect(caught).to.be.instanceOf(Error);
		expect(String(caught.message)).to.include("must be type='channel'");
		expect(calls.delObject).to.deep.equal([]);
		expect(objects.get('IngestDemo.0')?.type).to.equal('state');
		expect(objects.has('IngestDemo.0.enable')).to.equal(false);
		expect(objects.has('IngestDemo.0.status')).to.equal(false);
		expect(states.has('IngestDemo.0.enable')).to.equal(false);
	});

		it('toggles plugins on ack:false state changes and ignores ack:true writes', async () => {
			const { adapter, states, objects } = makeAdapter();
			const store = makeMsgStore();

		const catalog = {
			[IoPluginsCategories.ingest]: [
				{
					type: 'IngestDemo',
					label: 'Ingest Demo',
					defaultEnabled: true,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => () => {},
				},
			],
			[IoPluginsCategories.notify]: [],
			[IoPluginsCategories.bridge]: [],
		};

			const mgr = await IoPlugins.create(adapter, store, { catalog });
			expect(store.ingestRegistered.has('IngestDemo:0')).to.equal(true);

			// Seed a non-empty watchlist state (and its object) to verify it is cleared on stop.
			objects.set('IngestDemo.0.watchlist', { type: 'state', common: {}, native: {} });
			states.set('IngestDemo.0.watchlist', { val: '["x"]', ack: true });

			// ack:true writes are ignored (including our own "commit" writes).
			mgr.handleStateChange('msghub.0.IngestDemo.0.enable', { val: false, ack: true });
			expect(store.ingestRegistered.has('IngestDemo:0')).to.equal(true);

		// Disable via state change (ack:false = user intent).
		mgr.handleStateChange('msghub.0.IngestDemo.0.enable', { val: false, ack: false });
		await mgr._queue.current;
		await flush();

		expect(store.ingestRegistered.has('IngestDemo:0')).to.equal(false);
		expect(store.ingestUnregistered).to.deep.equal(['IngestDemo:0']);
		expect(states.get('IngestDemo.0.enable')).to.deep.equal({ val: false, ack: true });
		expect(states.get('IngestDemo.0.status')).to.deep.equal({ val: 'stopped', ack: true });
		expect(states.get('IngestDemo.0.watchlist')).to.deep.equal({ val: '[]', ack: true });
	});

	describe('bridge wiring', () => {
		it('registers/unregisters a bridge as ingest+notify pair', async () => {
			const { adapter } = makeAdapter();
			const store = makeMsgStore();

			const catalog = {
				[IoPluginsCategories.ingest]: [],
				[IoPluginsCategories.notify]: [],
				[IoPluginsCategories.bridge]: [
					{
						type: 'BridgeTest',
						label: 'Bridge Test',
						defaultEnabled: true,
						supportsMultiple: false,
						defaultOptions: {},
						create: () => ({ start: () => {}, onNotifications: () => {} }),
					},
				],
			};

			const mgr = await IoPlugins.create(adapter, store, { catalog });

			expect(store.ingestRegistered.has('BridgeTest:0.ingest')).to.equal(true);
			expect(store.notifyRegistered.has('BridgeTest:0.notify')).to.equal(true);

			// Disable via state change (ack:false = user intent).
			mgr.handleStateChange('msghub.0.BridgeTest.0.enable', { val: false, ack: false });
			await mgr._queue.current;
			await flush();

			expect(store.ingestRegistered.has('BridgeTest:0.ingest')).to.equal(false);
			expect(store.notifyRegistered.has('BridgeTest:0.notify')).to.equal(false);
			expect(store.notifyUnregistered).to.deep.equal(['BridgeTest:0.notify']);
			expect(store.ingestUnregistered).to.deep.equal(['BridgeTest:0.ingest']);
		});
	});

	describe('engage wiring', () => {
		it('registers/unregisters an engage plugin as ingest+notify with actions', async () => {
			const { adapter } = makeAdapter();
			const store = makeMsgStore();

			const catalog = {
				[IoPluginsCategories.ingest]: [],
				[IoPluginsCategories.notify]: [],
				[IoPluginsCategories.bridge]: [],
				[IoPluginsCategories.engage]: [
					{
						type: 'EngageTest',
						label: 'Engage Test',
						defaultEnabled: true,
						supportsMultiple: false,
						defaultOptions: {},
						create: () => ({ start: () => {}, onNotifications: () => {} }),
					},
				],
			};

			const mgr = await IoPlugins.create(adapter, store, { catalog });

			expect(store.ingestRegistered.has('EngageTest:0.ingest')).to.equal(true);
			expect(store.notifyRegistered.has('EngageTest:0.notify')).to.equal(true);

			// Disable via state change (ack:false = user intent).
			mgr.handleStateChange('msghub.0.EngageTest.0.enable', { val: false, ack: false });
			await mgr._queue.current;
			await flush();

			expect(store.ingestRegistered.has('EngageTest:0.ingest')).to.equal(false);
			expect(store.notifyRegistered.has('EngageTest:0.notify')).to.equal(false);
			expect(store.notifyUnregistered).to.deep.equal(['EngageTest:0.notify']);
			expect(store.ingestUnregistered).to.deep.equal(['EngageTest:0.ingest']);
		});
	});

	it('does not abort startup when one enabled plugin fails to create', async () => {
		const { adapter } = makeAdapter();
		const store = makeMsgStore();

		const catalog = {
			[IoPluginsCategories.ingest]: [
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
			[IoPluginsCategories.notify]: [
				{
					type: 'NotifyOk',
					label: 'Working notify plugin',
					defaultEnabled: true,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => ({ onNotifications: () => {} }),
				},
			],
			[IoPluginsCategories.bridge]: [],
		};

		const mgr = await IoPlugins.create(adapter, store, { catalog });
		expect(mgr).to.be.ok;

		expect(store.ingestRegistered.has('IngestBoom:0')).to.equal(false);
		expect(store.notifyRegistered.has('NotifyOk:0')).to.equal(true);
	});

	it('rejects catalog entries with wrong type prefix for their category', async () => {
		const { adapter } = makeAdapter();
		const store = makeMsgStore();
		const catalog = {
			[IoPluginsCategories.ingest]: [
				{
					type: 'BadType',
					label: 'Bad',
					defaultEnabled: true,
					supportsMultiple: false,
					defaultOptions: {},
					create: () => () => {},
				},
			],
			[IoPluginsCategories.notify]: [],
			[IoPluginsCategories.bridge]: [],
		};

		let err;
		try {
			await IoPlugins.create(adapter, store, { catalog });
		} catch (e) {
			err = e;
		}
		expect(err).to.be.instanceof(Error);
		expect(err.message).to.match(/must start with 'Ingest'/);
	});
});
