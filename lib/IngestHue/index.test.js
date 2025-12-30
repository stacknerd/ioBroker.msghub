'use strict';

const { expect } = require('chai');

const { IngestHue } = require('./index');

const waitFor = async (predicate, { timeoutMs = 250, intervalMs = 5 } = {}) => {
	const started = Date.now();
	// eslint-disable-next-line no-constant-condition
	while (true) {
		if (predicate()) {
			return;
		}
		if (Date.now() - started > timeoutMs) {
			throw new Error('waitFor: timeout');
		}
		await new Promise(resolve => setTimeout(resolve, intervalMs));
	}
};

const createStore = () => {
	const messages = new Map();
	return {
		messages,
		addOrUpdateMessage: msg => messages.set(msg.ref, msg),
		updateMessage: (ref, patch) => {
			const r = typeof ref === 'string' ? ref.trim() : '';
			if (!r || !messages.has(r) || !patch || typeof patch !== 'object') {
				return false;
			}
			const existing = messages.get(r);
			messages.set(r, { ...existing, ...patch, ref: existing.ref });
			return true;
		},
		completeAfterCauseEliminated: (ref, { actor, finishedAt } = {}) => {
			const r = typeof ref === 'string' ? ref.trim() : '';
			if (!r || !messages.has(r)) {
				return false;
			}
			const now = Date.now();
			const patch = {
				lifecycle: { state: 'closed', stateChangedAt: now, stateChangedBy: actor },
				timing: { notifyAt: null },
				progress: { percentage: 100, finishedAt: typeof finishedAt === 'number' ? finishedAt : now },
			};
			messages.set(r, { ...messages.get(r), ...patch });
			return true;
		},
		removeMessage: ref => messages.delete(ref),
	};
};

const createFactory = () => ({
	createMessage: msg => (msg && typeof msg.ref === 'string' ? { ...msg } : null),
});

const createConstants = () => ({
	level: { warning: 20, error: 30 },
	kind: { task: 'task', status: 'status' },
	origin: { type: { automation: 'automation' } },
});

const createI18n = () => ({
	t: (key, ...args) => {
		let text = typeof key === 'string' ? key : key == null ? '' : String(key);
		for (const arg of args) {
			text = text.replace('%s', arg === null ? 'null' : String(arg));
		}
		return text;
	},
	getTranslatedObject: value => {
		if (typeof value === 'string') {
			return value;
		}
		if (!value || typeof value !== 'object') {
			return '';
		}
		if (typeof value.en === 'string') {
			return value.en;
		}
		for (const entry of Object.values(value)) {
			if (typeof entry === 'string') {
				return entry;
			}
		}
		return '';
	},
});

	const createCtx = ({ adapter, store }) => ({
		api: {
		store,
		factory: createFactory(),
		constants: createConstants(),
		i18n: createI18n(),
		iobroker: {
			namespace: adapter.namespace,
			objects: {
				getForeignObjects: pattern => adapter.getForeignObjectsAsync(pattern),
				getForeignObject: id => adapter.getForeignObjectAsync(id),
				extendForeignObject: (id, patch) => adapter.extendForeignObjectAsync(id, patch),
			},
			states: {
				getForeignState: id => adapter.getForeignStateAsync(id),
			},
			subscribe: {
				subscribeForeignStates: id => adapter.subscribeForeignStates(id),
				unsubscribeForeignStates: id => adapter.unsubscribeForeignStates(id),
			},
		},
		log: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
		},
		meta: {
			managedObjects: (() => {
				const pending = new Set();
				return {
					report: async ids => {
						const list = Array.isArray(ids) ? ids : [ids];
						for (const id of list) {
							if (typeof id === 'string' && id) {
								pending.add(id);
							}
						}
					},
					applyReported: async () => {
						for (const id of pending) {
							await adapter.extendForeignObjectAsync(id, {});
						}
						pending.clear();
					},
				};
			})(),
		},
	});

const createAdapterMock = ({ locale = 'en', namespace = 'msghub.0', objectsById, statesById, enumsById }) => {
	const subscribeCalls = [];
	const unsubscribeCalls = [];
	const extendCalls = [];

	return {
		namespace,
		config: { locale },
		log: { debug: () => {}, warn: () => {}, info: () => {} },

		subscribeForeignStates: id => subscribeCalls.push(id),
		unsubscribeForeignStates: id => unsubscribeCalls.push(id),

		getForeignObjectsAsync: async pattern => {
			if (pattern === 'hue.*') {
				return objectsById;
			}
			if (pattern === 'enum.rooms.*') {
				return enumsById;
			}
			return {};
		},

		getForeignObjectAsync: async id => objectsById[id] || null,
		getForeignStateAsync: async id => statesById[id] || null,

		extendForeignObjectAsync: async (id, patch) => {
			extendCalls.push({ id, patch });
		},

		__calls: { subscribeCalls, unsubscribeCalls, extendCalls },
	};
};

describe('IngestHue', () => {
	it('creates battery + reachable messages on startup and tags watched states as managed', async () => {
		const batteryId = 'hue.0.bridge1.switch1.battery';
		const reachableId = 'hue.0.bridge1.switch1.reachable';
		const parentId = 'hue.0.bridge1.switch1';

		const objectsById = {
			[batteryId]: { _id: batteryId, type: 'state', common: { name: { en: 'Battery', de: 'Batterie' } }, native: {} },
			[reachableId]: {
				_id: reachableId,
				type: 'state',
				common: { name: { en: 'Reachable', de: 'Erreichbar' } },
				native: {},
			},
			[parentId]: {
				_id: parentId,
				type: 'channel',
				common: { role: 'ZLLSwitch', name: { en: 'Hallway switch', de: 'Flur Schalter' } },
				native: { modelid: 'RDM001' },
			},
		};

		const statesById = {
			[batteryId]: { val: 5 },
			[reachableId]: { val: false },
		};

		const enumsById = {
			'enum.rooms.living': {
				_id: 'enum.rooms.living',
				type: 'enum',
				common: { name: { en: 'Living Room', de: 'Wohnzimmer' }, members: [parentId] },
				native: {},
			},
		};

			const adapter = createAdapterMock({ objectsById, statesById, enumsById });

			const store = createStore();
			const ctx = createCtx({ adapter, store });

		const plugin = IngestHue();
		plugin.start(ctx);

		const batteryRef = `hue:battery:${batteryId}`;
		const reachableRef = `hue:reachable:${reachableId}`;
		await waitFor(() => store.messages.has(batteryRef) && store.messages.has(reachableRef));

		expect(adapter.__calls.subscribeCalls).to.have.members([batteryId, reachableId]);
		expect(adapter.__calls.extendCalls.map(c => c.id)).to.have.members([batteryId, reachableId]);

		expect(store.messages.get(batteryRef)).to.include({
			ref: batteryRef,
			level: ctx.api.constants.level.warning,
			kind: ctx.api.constants.kind.task,
		});
		expect(store.messages.get(batteryRef).details).to.include({ location: 'Living Room' });

		expect(store.messages.get(reachableRef)).to.include({
			ref: reachableRef,
			level: ctx.api.constants.level.error,
			kind: ctx.api.constants.kind.status,
		});
		expect(store.messages.get(reachableRef).details).to.include({ location: 'Living Room' });
	});

	it('applies battery hysteresis (no removal between thresholds)', async () => {
		const batteryId = 'hue.0.bridge1.switch1.battery';
		const parentId = 'hue.0.bridge1.switch1';
		const objectsById = {
			[batteryId]: { _id: batteryId, type: 'state', common: { name: 'Battery' }, native: {} },
			[parentId]: { _id: parentId, type: 'channel', common: { role: 'ZLLSwitch', name: 'Switch' }, native: { modelid: 'RDM001' } },
		};
		const statesById = { [batteryId]: { val: 5 } };
		const enumsById = {};

		const adapter = createAdapterMock({ objectsById, statesById, enumsById });
		const store = createStore();
				const ctx = createCtx({ adapter, store });

		const plugin = IngestHue();
		plugin.start(ctx);

		const batteryRef = `hue:battery:${batteryId}`;
		await waitFor(() => store.messages.has(batteryRef));

		plugin.onStateChange(batteryId, { val: 10 });
		expect(store.messages.has(batteryRef)).to.equal(true);

		plugin.onStateChange(batteryId, { val: 30 });
		expect(store.messages.has(batteryRef)).to.equal(true);
		expect(store.messages.get(batteryRef)?.lifecycle?.state).to.equal('closed');
	});

	it('filters reachable states by parent role by default (and allows all roles when reachableAllowRoles=[])', async () => {
		const reachableOkId = 'hue.0.bridge1.switch1.reachable';
		const reachableSkipId = 'hue.0.bridge1.temp1.reachable';

		const objectsById = {
			[reachableOkId]: { _id: reachableOkId, type: 'state', common: { name: 'Reachable' }, native: {} },
			[reachableOkId.replace(/\.reachable$/, '')]: {
				_id: reachableOkId.replace(/\.reachable$/, ''),
				type: 'channel',
				common: { role: 'ZLLSwitch', name: 'Switch' },
				native: {},
			},
			[reachableSkipId]: { _id: reachableSkipId, type: 'state', common: { name: 'Reachable' }, native: {} },
			[reachableSkipId.replace(/\.reachable$/, '')]: {
				_id: reachableSkipId.replace(/\.reachable$/, ''),
				type: 'channel',
				common: { role: 'ZLLTemperature', name: 'Temp' },
				native: {},
			},
		};
		const statesById = {
			[reachableOkId]: { val: false },
			[reachableSkipId]: { val: false },
		};
		const enumsById = {};

		{
			const adapter = createAdapterMock({ objectsById, statesById, enumsById });
			const store = createStore();
			const ctx = createCtx({ adapter, store });

			const plugin = IngestHue({ monitorBattery: false });
			plugin.start(ctx);

			const okRef = `hue:reachable:${reachableOkId}`;
			await waitFor(() => store.messages.has(okRef));

			expect(adapter.__calls.subscribeCalls).to.deep.equal([reachableOkId]);
			expect(store.messages.has(`hue:reachable:${reachableSkipId}`)).to.equal(false);
		}

		{
			const adapter = createAdapterMock({ objectsById, statesById, enumsById });
			const store = createStore();
				const ctx = createCtx({ adapter, store });

			const plugin = IngestHue({ monitorBattery: false, reachableAllowRoles: [] });
			plugin.start(ctx);

			await waitFor(
				() => store.messages.has(`hue:reachable:${reachableOkId}`) && store.messages.has(`hue:reachable:${reachableSkipId}`),
			);

			expect(adapter.__calls.subscribeCalls).to.have.members([reachableOkId, reachableSkipId]);
		}
	});
});
