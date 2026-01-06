'use strict';

const { expect } = require('chai');
const { IoPlugins, IoPluginsCategories } = require('./IoPlugins');
const { MsgConstants } = require('../src/MsgConstants');
const { buildLogApi } = require('../src/MsgHostApi');

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

			// Deep-merge `common.custom` (needed for managed-meta stamping).
			const curCustom = (curCommon && typeof curCommon.custom === 'object' && curCommon.custom && !Array.isArray(curCommon.custom)) ? curCommon.custom : {};
			const patchCustom = (patchCommon && typeof patchCommon.custom === 'object' && patchCommon.custom && !Array.isArray(patchCommon.custom)) ? patchCommon.custom : {};
			const mergedCustom = { ...curCustom, ...patchCustom };
			for (const [key, val] of Object.entries(patchCustom)) {
				if (val && typeof val === 'object' && !Array.isArray(val) && curCustom[key] && typeof curCustom[key] === 'object') {
					const curEntry = curCustom[key];
					const patchEntry = val;
					mergedCustom[key] = { ...curEntry, ...patchEntry };
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
	const ingestHandlers = new Map();
	const notifyHandlers = new Map();

	const msgIngest = {
		registerPlugin: (id, handler) => {
			ingestRegistered.add(id);
			ingestHandlers.set(id, handler);
		},
		unregisterPlugin: id => {
			ingestRegistered.delete(id);
			ingestUnregistered.push(id);
			ingestHandlers.delete(id);
		},
	};
	const msgNotify = {
		registerPlugin: (id, handler) => {
			notifyRegistered.add(id);
			notifyHandlers.set(id, handler);
		},
		unregisterPlugin: id => {
			notifyRegistered.delete(id);
			notifyUnregistered.push(id);
			notifyHandlers.delete(id);
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
		ingestHandlers,
		notifyHandlers,
	};
}

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('IoPlugins', () => {
	it('prefixes ctx.api.log messages with baseOwnId', () => {
		const info = [];
		const { adapter } = makeAdapter();
		adapter.log.info = msg => info.push(String(msg));

		const store = makeMsgStore();
		const mgr = new IoPlugins(adapter, store, { catalog: {} });

		const baseCtx = { api: { log: buildLogApi(adapter, { hostName: 'TestHost' }) }, meta: {} };
		const ctx = mgr._decorateCtxForPlugin(baseCtx, {
			pluginMeta: { baseOwnId: 'IngestDwd.0', regId: 'IngestDwd:0' },
			optionsApi: {},
			resources: null,
			managedObjects: null,
		});

		ctx.api.log.info('hello');
		expect(info).to.deep.equal(['IngestDwd.0: hello']);
	});

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

			// Only create instance 0 automatically for plugins enabled by default.
			expect(subscriptions).to.deep.equal(['IngestDemo.0.enable']);
			expect(objects.get('IngestDemo.0')?.type).to.equal('channel');
			expect(objects.get('IngestDemo.0')?.native).to.deep.equal({ x: 1, enabled: true });
			expect(objects.get('IngestDemo.0.enable')?.type).to.equal('state');
			expect(objects.get('IngestDemo.0.status')?.type).to.equal('state');

			expect(objects.has('NotifyDemo.0')).to.equal(false);
			expect(objects.has('NotifyDemo.0.enable')).to.equal(false);
			expect(objects.has('NotifyDemo.0.status')).to.equal(false);
			expect(objects.has('BridgeDemo.0')).to.equal(false);
			expect(objects.has('BridgeDemo.0.enable')).to.equal(false);
			expect(objects.has('BridgeDemo.0.status')).to.equal(false);

			expect(states.get('IngestDemo.0.enable')).to.deep.equal({ val: true, ack: true });
			expect(states.get('IngestDemo.0.status')).to.deep.equal({ val: 'stopped', ack: true });
			expect(states.has('NotifyDemo.0.enable')).to.equal(false);
			expect(states.has('BridgeDemo.0.enable')).to.equal(false);
			expect(states.has('NotifyDemo.0.status')).to.equal(false);
			expect(states.has('BridgeDemo.0.status')).to.equal(false);
			expect(calls.setState).to.have.length(2);
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

	it('stores channel as an explicit empty string when patched with null', async () => {
		const { adapter, objects } = makeAdapter();
		const store = makeMsgStore();

		// Simulate ioBroker-like "extendObject" merge semantics for `native` (no deletes on missing keys).
		adapter.extendObjectAsync = async (id, patch) => {
			const cur = objects.get(id) || {};
			const next = { ...cur, ...patch, common: { ...(cur.common || {}), ...(patch.common || {}) } };
			const curNative = cur && typeof cur.native === 'object' && cur.native && !Array.isArray(cur.native) ? cur.native : {};
			const patchNative = patch && typeof patch.native === 'object' && patch.native && !Array.isArray(patch.native) ? patch.native : null;
			if (patchNative) {
				next.native = { ...curNative, ...patchNative };
			}
			objects.set(id, next);
		};

		const catalog = {
			[IoPluginsCategories.ingest]: [],
			[IoPluginsCategories.notify]: [
				{
					type: 'NotifyDemo',
					label: 'Notify Demo',
					defaultEnabled: true,
					supportsMultiple: false,
					supportsChannelRouting: true,
					defaultOptions: {},
					create: () => ({ onNotifications: () => {} }),
				},
			],
			[IoPluginsCategories.bridge]: [],
			[IoPluginsCategories.engage]: [],
		};

		const mgr = await IoPlugins.create(adapter, store, { catalog });

		await mgr.updateInstanceNative({ type: 'NotifyDemo', instanceId: 0, nativePatch: { channel: 'X' } });
		expect(objects.get('NotifyDemo.0')?.native?.channel).to.equal('X');

		await mgr.updateInstanceNative({ type: 'NotifyDemo', instanceId: 0, nativePatch: { channel: null } });
		expect(objects.get('NotifyDemo.0')?.native?.channel).to.equal('');
	});

		it('injects ctx.meta.plugin into plugin calls', async () => {
			const { adapter } = makeAdapter();
			const store = makeMsgStore();
			let ingestCtx = null;
			let notifyCtx = null;

			const catalog = {
				[IoPluginsCategories.ingest]: [
					{
						type: 'IngestDemo',
						label: 'Ingest Demo',
						defaultEnabled: true,
						supportsMultiple: false,
						defaultOptions: {},
						create: () => ({
							start(ctx) {
								ingestCtx = ctx;
							},
						}),
					},
				],
				[IoPluginsCategories.notify]: [
					{
						type: 'NotifyDemo',
						label: 'Notify Demo',
						defaultEnabled: true,
						supportsMultiple: false,
						defaultOptions: {},
						create: () => ({
							onNotifications(event, notifications, ctx) {
								notifyCtx = ctx;
							},
						}),
					},
				],
				[IoPluginsCategories.bridge]: [],
				[IoPluginsCategories.engage]: [],
			};

		await IoPlugins.create(adapter, store, { catalog });

		const ingestHandler = store.ingestHandlers.get('IngestDemo:0');
		expect(ingestHandler).to.be.ok;
		ingestHandler.start({ api: {}, meta: { hello: 'world' } });

			expect(ingestCtx?.meta?.hello).to.equal('world');
			expect(ingestCtx?.meta?.managedObjects).to.be.an('object');
			expect(ingestCtx?.meta?.managedObjects?.applyReported).to.be.a('function');
			expect(ingestCtx?.meta?.options).to.be.an('object');
			expect(ingestCtx?.meta?.options?.resolveInt).to.be.a('function');
			expect(ingestCtx?.meta?.options?.resolveString).to.be.a('function');
			expect(ingestCtx?.meta?.options?.resolveBool).to.be.a('function');
			expect(ingestCtx?.meta?.plugin).to.deep.equal({
				category: 'ingest',
				type: 'IngestDemo',
				instanceId: 0,
				regId: 'IngestDemo:0',
				baseFullId: 'msghub.0.IngestDemo.0',
				baseOwnId: 'IngestDemo.0',
				channel: '',
					manifest: {
						schemaVersion: 1,
						type: 'IngestDemo',
						defaultEnabled: true,
						supportsMultiple: false,
						supportsChannelRouting: false,
						title: undefined,
						description: undefined,
						options: {},
					},
			});

			const notifyHandler = store.notifyHandlers.get('NotifyDemo:0');
			expect(notifyHandler).to.be.ok;
			notifyHandler.onNotifications('due', [{ ref: 'm1' }], { api: {}, meta: { foo: 1 } });

			expect(notifyCtx?.meta?.foo).to.equal(1);
			expect(notifyCtx?.meta?.options).to.be.an('object');
			expect(notifyCtx?.meta?.options?.resolveInt).to.be.a('function');
			expect(notifyCtx?.meta?.options?.resolveString).to.be.a('function');
			expect(notifyCtx?.meta?.options?.resolveBool).to.be.a('function');
			expect(notifyCtx?.meta?.plugin).to.deep.equal({
				category: 'notify',
				type: 'NotifyDemo',
				instanceId: 0,
				regId: 'NotifyDemo:0',
				baseFullId: 'msghub.0.NotifyDemo.0',
				baseOwnId: 'NotifyDemo.0',
				channel: '',
					manifest: {
						schemaVersion: 1,
						type: 'NotifyDemo',
						defaultEnabled: true,
						supportsMultiple: false,
						supportsChannelRouting: false,
						title: undefined,
						description: undefined,
						options: {},
					},
			});
		});

			it('routes notifications by message audience.channels and plugin native.channel', async () => {
				const { adapter } = makeAdapter();
				const store = makeMsgStore();
				const calls = [];

				const catalog = {
					[IoPluginsCategories.ingest]: [],
					[IoPluginsCategories.notify]: [
						{
							type: 'NotifyRouted',
							label: 'Notify Routed',
							defaultEnabled: true,
							supportsMultiple: false,
							supportsChannelRouting: true,
							defaultOptions: {},
							create: () => ({
								onNotifications(event, notifications, ctx) {
									calls.push({
										type: 'NotifyRouted',
										event,
										ref: notifications?.[0]?.ref,
										channel: ctx?.meta?.plugin?.channel,
									});
								},
							}),
						},
						{
							type: 'NotifyPlain',
							label: 'Notify Plain',
							defaultEnabled: true,
							supportsMultiple: false,
							supportsChannelRouting: false,
							defaultOptions: {},
							create: () => ({
								onNotifications(event, notifications, ctx) {
									calls.push({
										type: 'NotifyPlain',
										event,
										ref: notifications?.[0]?.ref,
										channel: ctx?.meta?.plugin?.channel,
									});
								},
							}),
						},
					],
					[IoPluginsCategories.bridge]: [],
					[IoPluginsCategories.engage]: [],
				};

				const mgr = await IoPlugins.create(adapter, store, { catalog });

				let routed = store.notifyHandlers.get('NotifyRouted:0');
				let plain = store.notifyHandlers.get('NotifyPlain:0');
				expect(routed).to.be.ok;
				expect(plain).to.be.ok;

				// Default: routed plugin channel empty => deliver only when message include is empty.
				// Plain plugin (supportsChannelRouting=false) always receives.
				routed.onNotifications(
					'due',
					[{ ref: 'm1', audience: { channels: { include: ['x'] } } }],
					{ api: {}, meta: {} },
				);
				plain.onNotifications(
					'due',
					[{ ref: 'm1', audience: { channels: { include: ['x'] } } }],
					{ api: {}, meta: {} },
				);
				expect(calls).to.deep.equal([{ type: 'NotifyPlain', event: 'due', ref: 'm1', channel: '' }]);

				routed.onNotifications('due', [{ ref: 'm2' }], { api: {}, meta: {} });
				plain.onNotifications('due', [{ ref: 'm2' }], { api: {}, meta: {} });
				expect(calls).to.have.length(3);
				expect(calls[1]).to.deep.equal({ type: 'NotifyRouted', event: 'due', ref: 'm2', channel: '' });
				expect(calls[2]).to.deep.equal({ type: 'NotifyPlain', event: 'due', ref: 'm2', channel: '' });

				// Exclude is ignored for empty routed plugin channels.
				routed.onNotifications(
					'due',
					[{ ref: 'm3', audience: { channels: { exclude: ['x'] } } }],
					{ api: {}, meta: {} },
				);
				plain.onNotifications(
					'due',
					[{ ref: 'm3', audience: { channels: { exclude: ['x'] } } }],
					{ api: {}, meta: {} },
				);
				expect(calls).to.have.length(5);
				expect(calls[3]).to.deep.equal({ type: 'NotifyRouted', event: 'due', ref: 'm3', channel: '' });
				expect(calls[4]).to.deep.equal({ type: 'NotifyPlain', event: 'due', ref: 'm3', channel: '' });

				// Set routed plugin channel (update native => restart enabled instance).
				await mgr.updateInstanceNative({ type: 'NotifyRouted', instanceId: 0, nativePatch: { channel: 'Push ' } });
				routed = store.notifyHandlers.get('NotifyRouted:0');
				expect(routed).to.be.ok;

				routed.onNotifications(
					'due',
					[{ ref: 'm4', audience: { channels: { include: ['push'] } } }],
					{ api: {}, meta: {} },
				);
				plain.onNotifications(
					'due',
					[{ ref: 'm4', audience: { channels: { include: ['push'] } } }],
					{ api: {}, meta: {} },
				);
				expect(calls).to.have.length(7);
				expect(calls[5]).to.deep.equal({ type: 'NotifyRouted', event: 'due', ref: 'm4', channel: 'Push' });
				expect(calls[6]).to.deep.equal({ type: 'NotifyPlain', event: 'due', ref: 'm4', channel: '' });

				// include mismatch blocks only routed plugins.
				routed.onNotifications(
					'due',
					[{ ref: 'm5', audience: { channels: { include: ['other'] } } }],
					{ api: {}, meta: {} },
				);
				plain.onNotifications(
					'due',
					[{ ref: 'm5', audience: { channels: { include: ['other'] } } }],
					{ api: {}, meta: {} },
				);
				expect(calls).to.have.length(8);
				expect(calls[7]).to.deep.equal({ type: 'NotifyPlain', event: 'due', ref: 'm5', channel: '' });

				// Exclude wins.
				routed.onNotifications(
					'due',
					[{ ref: 'm6', audience: { channels: { exclude: ['PUSH'] } } }],
					{ api: {}, meta: {} },
				);
				plain.onNotifications(
					'due',
					[{ ref: 'm6', audience: { channels: { exclude: ['PUSH'] } } }],
					{ api: {}, meta: {} },
				);
				expect(calls).to.have.length(9);
				expect(calls[8]).to.deep.equal({ type: 'NotifyPlain', event: 'due', ref: 'm6', channel: '' });

				routed.onNotifications(
					'due',
					[{ ref: 'm7', audience: { channels: { include: ['push'], exclude: ['push'] } } }],
					{ api: {}, meta: {} },
				);
				plain.onNotifications(
					'due',
					[{ ref: 'm7', audience: { channels: { include: ['push'], exclude: ['push'] } } }],
					{ api: {}, meta: {} },
				);
				expect(calls).to.have.length(10);
				expect(calls[9]).to.deep.equal({ type: 'NotifyPlain', event: 'due', ref: 'm7', channel: '' });

				// include empty: routed plugins deliver when not excluded.
				routed.onNotifications('due', [{ ref: 'm8' }], { api: {}, meta: {} });
				expect(calls).to.have.length(11);
				expect(calls[10]).to.deep.equal({ type: 'NotifyRouted', event: 'due', ref: 'm8', channel: 'Push' });

				// Special: plugin channel "*" / "all" disables routing (match-all, like supportsChannelRouting=false).
				await mgr.updateInstanceNative({ type: 'NotifyRouted', instanceId: 0, nativePatch: { channel: 'all' } });
				routed = store.notifyHandlers.get('NotifyRouted:0');
				expect(routed).to.be.ok;

				routed.onNotifications(
					'due',
					[{ ref: 'm9', audience: { channels: { include: ['other'], exclude: ['all'] } } }],
					{ api: {}, meta: {} },
				);
				plain.onNotifications(
					'due',
					[{ ref: 'm9', audience: { channels: { include: ['other'], exclude: ['all'] } } }],
					{ api: {}, meta: {} },
				);
				expect(calls).to.have.length(13);
				expect(calls[11]).to.deep.equal({ type: 'NotifyRouted', event: 'due', ref: 'm9', channel: 'all' });
				expect(calls[12]).to.deep.equal({ type: 'NotifyPlain', event: 'due', ref: 'm9', channel: '' });
			});

			it('routes bridge notifications with the same audience.channels rules', async () => {
				const { adapter } = makeAdapter();
				const store = makeMsgStore();
				const calls = [];

				const catalog = {
					[IoPluginsCategories.ingest]: [],
					[IoPluginsCategories.notify]: [],
					[IoPluginsCategories.bridge]: [
						{
							type: 'BridgeRouted',
							label: 'Bridge Routed',
							defaultEnabled: true,
							supportsMultiple: false,
							supportsChannelRouting: true,
							defaultOptions: { channel: 'Bridge' },
							create: () => ({
								start() {},
								onNotifications(event, notifications, ctx) {
									calls.push({
										type: 'BridgeRouted',
										event,
										ref: notifications?.[0]?.ref,
										channel: ctx?.meta?.plugin?.channel,
									});
								},
							}),
						},
						{
							type: 'BridgePlain',
							label: 'Bridge Plain',
							defaultEnabled: true,
							supportsMultiple: false,
							supportsChannelRouting: false,
							defaultOptions: {},
							create: () => ({
								start() {},
								onNotifications(event, notifications, ctx) {
									calls.push({
										type: 'BridgePlain',
										event,
										ref: notifications?.[0]?.ref,
										channel: ctx?.meta?.plugin?.channel,
									});
								},
							}),
						},
					],
					[IoPluginsCategories.engage]: [],
				};

				await IoPlugins.create(adapter, store, { catalog });

				const routed = store.notifyHandlers.get('BridgeRouted:0.notify');
				const plain = store.notifyHandlers.get('BridgePlain:0.notify');
				expect(routed).to.be.ok;
				expect(plain).to.be.ok;

				routed.onNotifications(
					'updated',
					[{ ref: 'm1', audience: { channels: { include: ['bridge'] } } }],
					{ api: {}, meta: {} },
				);
				plain.onNotifications(
					'updated',
					[{ ref: 'm1', audience: { channels: { include: ['bridge'] } } }],
					{ api: {}, meta: {} },
				);
				expect(calls).to.deep.equal([
					{ type: 'BridgeRouted', event: 'updated', ref: 'm1', channel: 'Bridge' },
					{ type: 'BridgePlain', event: 'updated', ref: 'm1', channel: '' },
				]);

				routed.onNotifications(
					'updated',
					[{ ref: 'm2', audience: { channels: { include: ['other'] } } }],
					{ api: {}, meta: {} },
				);
				plain.onNotifications(
					'updated',
					[{ ref: 'm2', audience: { channels: { include: ['other'] } } }],
					{ api: {}, meta: {} },
				);
				expect(calls).to.have.length(3);
				expect(calls[2]).to.deep.equal({ type: 'BridgePlain', event: 'updated', ref: 'm2', channel: '' });
			});

			it('routes engage notifications with the same audience.channels rules', async () => {
				const { adapter } = makeAdapter();
				const store = makeMsgStore();
				const calls = [];

				const catalog = {
					[IoPluginsCategories.ingest]: [],
					[IoPluginsCategories.notify]: [],
					[IoPluginsCategories.bridge]: [],
					[IoPluginsCategories.engage]: [
						{
							type: 'EngageRouted',
							label: 'Engage Routed',
							defaultEnabled: true,
							supportsMultiple: false,
							supportsChannelRouting: true,
							defaultOptions: { channel: 'Home' },
							create: () => ({
								start() {},
								onNotifications(event, notifications, ctx) {
									calls.push({
										type: 'EngageRouted',
										event,
										ref: notifications?.[0]?.ref,
										channel: ctx?.meta?.plugin?.channel,
									});
								},
							}),
						},
						{
							type: 'EngagePlain',
							label: 'Engage Plain',
							defaultEnabled: true,
							supportsMultiple: false,
							supportsChannelRouting: false,
							defaultOptions: {},
							create: () => ({
								start() {},
								onNotifications(event, notifications, ctx) {
									calls.push({
										type: 'EngagePlain',
										event,
										ref: notifications?.[0]?.ref,
										channel: ctx?.meta?.plugin?.channel,
									});
								},
							}),
						},
					],
				};

				await IoPlugins.create(adapter, store, { catalog });

				const routed = store.notifyHandlers.get('EngageRouted:0.notify');
				const plain = store.notifyHandlers.get('EngagePlain:0.notify');
				expect(routed).to.be.ok;
				expect(plain).to.be.ok;

				routed.onNotifications(
					'due',
					[{ ref: 'm1', audience: { channels: { include: ['home'] } } }],
					{ api: {}, meta: {} },
				);
				plain.onNotifications(
					'due',
					[{ ref: 'm1', audience: { channels: { include: ['home'] } } }],
					{ api: {}, meta: {} },
				);
				expect(calls).to.deep.equal([
					{ type: 'EngageRouted', event: 'due', ref: 'm1', channel: 'Home' },
					{ type: 'EngagePlain', event: 'due', ref: 'm1', channel: '' },
				]);

				routed.onNotifications(
					'due',
					[{ ref: 'm2', audience: { channels: { include: ['other'] } } }],
					{ api: {}, meta: {} },
				);
				plain.onNotifications(
					'due',
					[{ ref: 'm2', audience: { channels: { include: ['other'] } } }],
					{ api: {}, meta: {} },
				);
				expect(calls).to.have.length(3);
				expect(calls[2]).to.deep.equal({ type: 'EngagePlain', event: 'due', ref: 'm2', channel: '' });
			});

		it('injects ctx.meta.resources and auto-tracks ctx.api.iobroker.subscribe.*', async () => {
			const { adapter } = makeAdapter();
			const store = makeMsgStore();
			const calls = [];
			let startCtx = null;
			let stopCtx = null;

			const baseSubscribe = {
				subscribeStates: pattern => calls.push(['subscribeStates', pattern]),
				unsubscribeStates: pattern => calls.push(['unsubscribeStates', pattern]),
			};

			const baseCtx = {
				api: {
					iobroker: {
						subscribe: baseSubscribe,
					},
				},
				meta: {},
			};

			const catalog = {
				[IoPluginsCategories.ingest]: [
					{
						type: 'IngestDemo',
						label: 'Ingest Demo',
						defaultEnabled: true,
						supportsMultiple: false,
						defaultOptions: {},
						create: () => ({
							start(ctx) {
								startCtx = ctx;
								ctx.api.iobroker.subscribe.subscribeStates('a');
								ctx.api.iobroker.subscribe.subscribeStates('b');
								ctx.api.iobroker.subscribe.unsubscribeStates('b');
							},
							stop(ctx) {
								stopCtx = ctx;
							},
						}),
					},
				],
				[IoPluginsCategories.notify]: [],
				[IoPluginsCategories.bridge]: [],
				[IoPluginsCategories.engage]: [],
			};

			await IoPlugins.create(adapter, store, { catalog });

			const ingestHandler = store.ingestHandlers.get('IngestDemo:0');
			expect(ingestHandler).to.be.ok;
			ingestHandler.start(baseCtx);
			ingestHandler.stop(baseCtx);

			expect(startCtx?.meta?.resources).to.be.an('object');
			expect(startCtx?.api?.iobroker?.subscribe).to.not.equal(baseSubscribe);
			expect(stopCtx?.meta?.resources).to.equal(startCtx?.meta?.resources);

			expect(calls).to.deep.equal([
				['subscribeStates', 'a'],
				['subscribeStates', 'b'],
				['unsubscribeStates', 'b'],
				['unsubscribeStates', 'a'],
			]);
		});

		it('disposes resources even when stop throws', async () => {
			const { adapter } = makeAdapter();
			const store = makeMsgStore();
			const calls = [];

			const baseSubscribe = {
				subscribeStates: pattern => calls.push(['subscribeStates', pattern]),
				unsubscribeStates: pattern => calls.push(['unsubscribeStates', pattern]),
			};
			const baseCtx = { api: { iobroker: { subscribe: baseSubscribe } }, meta: {} };

			const catalog = {
				[IoPluginsCategories.ingest]: [
					{
						type: 'IngestDemo',
						label: 'Ingest Demo',
						defaultEnabled: true,
						supportsMultiple: false,
						defaultOptions: {},
						create: () => ({
							start(ctx) {
								ctx.api.iobroker.subscribe.subscribeStates('x');
							},
							stop() {
								throw new Error('boom');
							},
						}),
					},
				],
				[IoPluginsCategories.notify]: [],
				[IoPluginsCategories.bridge]: [],
				[IoPluginsCategories.engage]: [],
			};

			await IoPlugins.create(adapter, store, { catalog });

			const ingestHandler = store.ingestHandlers.get('IngestDemo:0');
			expect(ingestHandler).to.be.ok;
			ingestHandler.start(baseCtx);

			let caught = null;
			try {
				ingestHandler.stop(baseCtx);
			} catch (e) {
				caught = e;
			}
			expect(caught).to.be.instanceOf(Error);

			expect(calls).to.deep.equal([
				['subscribeStates', 'x'],
				['unsubscribeStates', 'x'],
			]);
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
			expect(updated.common.custom['msghub.0']).to.include({
				'managedMeta-managedBy': 'msghub.0.IngestDemo.0',
				'managedMeta-managedText': 'x',
				'managedMeta-managedMessage': true,
			});
			expect(updated.common.custom['msghub.0']['managedMeta-managedSince']).to.be.a('string');
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
