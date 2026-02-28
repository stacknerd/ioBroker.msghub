'use strict';

const { expect } = require('chai');

const { NotifyStates, manifest } = require('./index');
const { IoPluginResources } = require('../IoPluginResources');
const { IoPlugins, IoPluginsCategories } = require('../IoPlugins');
const { MsgConstants } = require('../../src/MsgConstants');
const { shouldDispatchByAudienceChannels } = require('../../src/MsgUtils');

function createOptionsApiFromIoPlugins(m) {
	const adapter = {
		namespace: 'msghub.0',
		log: { debug() {}, info() {}, warn() {}, error() {} },
		i18n: { t: s => s, getTranslatedObject: s => ({ en: s, de: s }) },
	};
	const msgStore = { msgIngest: {}, msgNotify: {} };
	const emptyCatalog = {
		[IoPluginsCategories.ingest]: [],
		[IoPluginsCategories.notify]: [],
		[IoPluginsCategories.bridge]: [],
		[IoPluginsCategories.engage]: [],
	};
	const ioPlugins = new IoPlugins(adapter, msgStore, { catalog: emptyCatalog });
	return ioPlugins.createOptionsApi(m);
}

function createHarness({ namespace = 'msghub.0', messages = [] } = {}) {
	const setObjectCalls = [];
	const setStateCalls = [];

	const adapterLog = { debug: [], info: [], warn: [], error: [] };
	const log = {
		debug: msg => adapterLog.debug.push(msg),
		info: msg => adapterLog.info.push(msg),
		warn: msg => adapterLog.warn.push(msg),
		error: msg => adapterLog.error.push(msg),
	};

	const iobroker = {
		ids: {
			namespace,
			toOwnId: fullId => {
				const prefix = `${namespace}.`;
				return typeof fullId === 'string' && fullId.startsWith(prefix) ? fullId.slice(prefix.length) : fullId;
			},
		},
		objects: {
			setObjectNotExists: async (id, obj) => {
				setObjectCalls.push({ id, obj });
			},
		},
		states: {
			setState: async (id, state) => {
				setStateCalls.push({ id, state });
			},
		},
	};

	const store = {
		getMessages: () => messages,
		queryMessages: ({ where = {} } = {}) => {
			const w = where && typeof where === 'object' ? where : {};
			let list = Array.isArray(messages) ? messages : [];

			const routeTo = w?.audience?.channels?.routeTo;
			if (typeof routeTo === 'string') {
				list = list.filter(m => shouldDispatchByAudienceChannels(m, routeTo));
			}

			const lifecycleSpec = w?.lifecycle?.state;
			if (typeof lifecycleSpec === 'string' && lifecycleSpec) {
				list = list.filter(m => m?.lifecycle?.state === lifecycleSpec);
			} else if (lifecycleSpec && typeof lifecycleSpec === 'object' && !Array.isArray(lifecycleSpec)) {
				const allow = Array.isArray(lifecycleSpec.in) ? lifecycleSpec.in.filter(s => typeof s === 'string') : [];
				if (allow.length > 0) {
					const set = new Set(allow);
					list = list.filter(m => set.has(m?.lifecycle?.state));
				}
			}

			return { total: list.length, pages: 1, items: list };
		},
	};

	const resources = new IoPluginResources({ regId: 'NotifyStates:0', log });
	const i18n = { t: s => s };
	const ctx = {
		api: { log, i18n, constants: MsgConstants, iobroker, store },
		meta: {
			options: createOptionsApiFromIoPlugins(manifest),
			resources,
			plugin: { baseOwnId: 'NotifyStates.0', channel: '', manifest },
		},
	};

	return { ctx, setObjectCalls, setStateCalls, adapterLog, store };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('NotifyStates Stats', () => {
	it('writes numeric Stats.* states with correct counts', async () => {
		const now = Date.now();
		const h = createHarness({
			messages: [
				{ ref: 'a', lifecycle: { state: 'open' }, timing: { notifyAt: now - 1 } },
				{ ref: 'b', lifecycle: { state: 'open' }, timing: { notifyAt: now + 60_000 } },
				{ ref: 'c', lifecycle: { state: 'deleted' }, timing: { notifyAt: now - 1 } },
				{ ref: 'd', lifecycle: { state: 'expired' }, timing: { notifyAt: now - 1 } },
				{ ref: 'e', lifecycle: { state: 'open' }, timing: { notifyAt: now - 1, expiresAt: now - 1 } },
			],
		});

		const plugin = NotifyStates({
			pluginBaseObjectId: 'msghub.0.NotifyStates.0',
			blobIntervalMs: 0,
			statsMinIntervalMs: 0,
			statsMaxIntervalMs: 0,
		});

		plugin.start(h.ctx);
		await wait(0);

		const statsWrites = h.setStateCalls.filter(c => String(c.id).includes('.Stats.'));
		const byId = new Map(statsWrites.map(c => [c.id, c.state.val]));

		expect(byId.get('NotifyStates.0.Stats.total')).to.equal(5);
		expect(byId.get('NotifyStates.0.Stats.open')).to.equal(3);
		expect(byId.get('NotifyStates.0.Stats.dueNow')).to.equal(1);
		expect(byId.get('NotifyStates.0.Stats.deleted')).to.equal(1);
		expect(byId.get('NotifyStates.0.Stats.expired')).to.equal(1);

		plugin.stop(h.ctx);
	});

	it('filters Stats.* by plugin channel (audience.channels)', async () => {
		const now = Date.now();

		const h = createHarness({
			messages: [
				{ ref: 'a', lifecycle: { state: 'open' }, timing: { notifyAt: now - 1 } }, // unscoped
				{ ref: 'b', lifecycle: { state: 'open' }, timing: { notifyAt: now + 60_000 }, audience: { channels: { include: ['Family'] } } },
				{ ref: 'c', lifecycle: { state: 'open' }, timing: { notifyAt: now - 1 }, audience: { channels: { include: ['Work'] } } },
				{ ref: 'd', lifecycle: { state: 'open' }, timing: { notifyAt: now - 1 }, audience: { channels: { exclude: ['Family'] } } },
				{ ref: 'e', lifecycle: { state: 'deleted' }, timing: { notifyAt: now - 1 }, audience: { channels: { include: ['Family'] } } },
				{ ref: 'f', lifecycle: { state: 'expired' }, timing: { notifyAt: now - 1 }, audience: { channels: { include: ['Work'] } } },
			],
		});

		h.ctx.meta.plugin.channel = 'Family';

		const plugin = NotifyStates({
			pluginBaseObjectId: 'msghub.0.NotifyStates.0',
			blobIntervalMs: 0,
			statsMinIntervalMs: 0,
			statsMaxIntervalMs: 0,
		});

		plugin.start(h.ctx);
		await wait(0);

		const statsWrites = h.setStateCalls.filter(c => String(c.id).includes('.Stats.'));
		const byId = new Map(statsWrites.map(c => [c.id, c.state.val]));

		// channel=Family sees:
		// - unscoped messages
		// - messages including Family
		// but excludes messages excluding Family or scoped to other channels
		expect(byId.get('NotifyStates.0.Stats.total')).to.equal(3);
		expect(byId.get('NotifyStates.0.Stats.open')).to.equal(2);
		expect(byId.get('NotifyStates.0.Stats.dueNow')).to.equal(1);
		expect(byId.get('NotifyStates.0.Stats.deleted')).to.equal(1);
		expect(byId.get('NotifyStates.0.Stats.expired')).to.equal(0);

		plugin.stop(h.ctx);
	});

	it('updates stats after notifications, throttled by statsMinIntervalMs', async () => {
		const h = createHarness({
			messages: [{ ref: 'a', lifecycle: { state: 'open' }, timing: { notifyAt: Date.now() - 1 } }],
		});

		const plugin = NotifyStates({
			pluginBaseObjectId: 'msghub.0.NotifyStates.0',
			blobIntervalMs: 0,
			statsMinIntervalMs: 30,
			statsMaxIntervalMs: 0,
		});

		plugin.start(h.ctx);
		await wait(40); // ensure the next write is allowed immediately
		h.setStateCalls.splice(0);

		plugin.onNotifications('due', [{ kind: 'task', level: 10 }], h.ctx);
		for (let i = 0; i < 50; i++) {
			await wait(2);
			const statsWrites = h.setStateCalls.filter(c => String(c.id).includes('.Stats.'));
			if (statsWrites.length >= 5) {
				break;
			}
		}

		plugin.onNotifications('due', [{ kind: 'task', level: 10 }], h.ctx);

		let statsWrites = h.setStateCalls.filter(c => String(c.id).includes('.Stats.'));
		expect(statsWrites.length).to.be.at.least(5); // first update

		await wait(40); // >= statsMinIntervalMs so the second (throttled) update can fire
		statsWrites = h.setStateCalls.filter(c => String(c.id).includes('.Stats.'));
		expect(statsWrites.length).to.be.at.least(10); // second update

		plugin.stop(h.ctx);
	});

	it('refreshes stats periodically via statsMaxIntervalMs even without notifications', async () => {
		const h = createHarness({
			messages: [{ ref: 'a', lifecycle: { state: 'open' }, timing: { notifyAt: Date.now() - 1 } }],
		});

		const plugin = NotifyStates({
			pluginBaseObjectId: 'msghub.0.NotifyStates.0',
			blobIntervalMs: 0,
			statsMinIntervalMs: 0,
			statsMaxIntervalMs: 20,
		});

		plugin.start(h.ctx);
		await wait(0);

		const initial = h.setStateCalls.filter(c => String(c.id).includes('.Stats.')).length;
		await wait(35);
		const later = h.setStateCalls.filter(c => String(c.id).includes('.Stats.')).length;

		expect(later).to.be.greaterThan(initial);

		plugin.stop(h.ctx);
	});
});

describe('NotifyStates fullJson', () => {
	it('filters fullJson by plugin channel (audience.channels)', async () => {
		const now = Date.now();

		const h = createHarness({
			messages: [
				{ ref: 'a', lifecycle: { state: 'open' }, timing: { notifyAt: now - 1 } }, // unscoped
				{ ref: 'b', lifecycle: { state: 'open' }, timing: { notifyAt: now - 1 }, audience: { channels: { include: ['Family'] } } },
				{ ref: 'c', lifecycle: { state: 'open' }, timing: { notifyAt: now - 1 }, audience: { channels: { include: ['Work'] } } },
				{ ref: 'd', lifecycle: { state: 'open' }, timing: { notifyAt: now - 1 }, audience: { channels: { exclude: ['Family'] } } },
			],
		});

		h.ctx.meta.plugin.channel = 'Family';

		const plugin = NotifyStates({
			pluginBaseObjectId: 'msghub.0.NotifyStates.0',
			blobIntervalMs: 60_000,
			statsMinIntervalMs: 0,
			statsMaxIntervalMs: 0,
		});

		plugin.start(h.ctx);
		await wait(0);

		const blobWrites = h.setStateCalls.filter(c => c.id === 'NotifyStates.0.fullJson');
		expect(blobWrites.length).to.be.greaterThan(0);

		const raw = blobWrites[0].state.val;
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		const refs = Array.isArray(parsed) ? parsed.map(m => m && m.ref).filter(Boolean) : [];

		expect(new Set(refs)).to.deep.equal(new Set(['a', 'b']));

		plugin.stop(h.ctx);
	});
});
