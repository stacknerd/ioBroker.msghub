'use strict';

const { expect } = require('chai');

const { IngestDwd } = require('./index');
const { MsgConstants } = require('../../src/MsgConstants');

const flush = () => new Promise(resolve => setImmediate(resolve));

function makeOptions({ overrides = {} } = {}) {
	const defaults = {
		dwdInstance: 'dwd.0',
		useAltitudeFilter: false,
		altitudeM: 0,
		audienceTagsCsv: '',
		audienceChannelsIncludeCsv: '',
		audienceChannelsExcludeCsv: '',
		aiEnhancement: false,
		syncDebounceMs: 0,
	};

	return {
		resolveString: (key, value) => (value !== undefined ? value : overrides[key] !== undefined ? overrides[key] : defaults[key]),
		resolveInt: (key, value) => (value !== undefined ? value : overrides[key] !== undefined ? overrides[key] : defaults[key]),
		resolveBool: (key, value) => (value !== undefined ? value : overrides[key] !== undefined ? overrides[key] : defaults[key]),
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

function makeIoBroker({ foreignStates = {} } = {}) {
	const calls = {
		getForeignState: [],
		setState: [],
		setObjectNotExists: [],
		subscribeForeignStates: [],
		unsubscribeForeignStates: [],
	};

	const iobroker = {
		ids: {
			namespace: 'msghub.0',
			toFullId: ownId => `msghub.0.${ownId}`,
		},
		objects: {
			setObjectNotExists: async (id, obj) => calls.setObjectNotExists.push([id, obj]),
		},
		states: {
			getForeignState: async id => {
				calls.getForeignState.push(id);
				return foreignStates[id] || null;
			},
			setState: async (id, state) => calls.setState.push([id, state]),
		},
		subscribe: {
			subscribeForeignStates: id => calls.subscribeForeignStates.push(id),
			unsubscribeForeignStates: id => calls.unsubscribeForeignStates.push(id),
		},
	};

	return { iobroker, calls };
}

function makeStore() {
	const calls = { addMessage: [], updateMessage: [], completeAfterCauseEliminated: [] };
	const byRef = new Map();

	return {
		calls,
		getMessageByRef(ref) {
			return byRef.get(ref);
		},
		getMessages() {
			return Array.from(byRef.values());
		},
		addMessage(msg) {
			calls.addMessage.push(msg);
			byRef.set(msg.ref, msg);
			return true;
		},
		updateMessage(ref, patch) {
			calls.updateMessage.push([ref, patch]);
			const cur = byRef.get(ref);
			if (!cur) {
				return false;
			}
			const next = { ...cur, ...patch };
			if (patch && typeof patch.timing === 'object' && patch.timing && !Array.isArray(patch.timing)) {
				next.timing = { ...(cur.timing || {}), ...(patch.timing || {}) };
			}
			if (patch && typeof patch.details === 'object' && patch.details && !Array.isArray(patch.details)) {
				next.details = { ...(cur.details || {}), ...(patch.details || {}) };
			}
			if (patch && typeof patch.audience === 'object' && patch.audience && !Array.isArray(patch.audience)) {
				next.audience = { ...(cur.audience || {}), ...(patch.audience || {}) };
			}
			byRef.set(ref, next);
			return true;
		},
		completeAfterCauseEliminated(ref, info) {
			calls.completeAfterCauseEliminated.push([ref, info]);
			byRef.delete(ref);
			return true;
		},
	};
}

function makeFactory() {
	return {
		createMessage: msg => msg,
	};
}

function makeCtx({ iobroker, store, options, managedObjects, pluginInstanceId = 0 } = {}) {
	return {
		api: {
			log: { debug() {}, warn() {} },
			iobroker,
			store,
			factory: makeFactory(),
			constants: MsgConstants,
			ai: null,
		},
		meta: {
			options,
			managedObjects,
			resources: {
				setTimeout: fn => {
					fn();
					return 1;
				},
				clearTimeout: () => {},
			},
			plugin: {
				type: 'IngestDwd',
				instanceId: pluginInstanceId,
				regId: `IngestDwd:${pluginInstanceId}`,
				baseOwnId: `IngestDwd.${pluginInstanceId}`,
			},
		},
	};
}

describe('IngestDwd', () => {
	it('imports warning objects into status messages and cleans up when warnings disappear', async () => {
		const now = Date.now();
		const warning = {
			state: 'Baden-Württemberg',
			type: 5,
			level: 3,
			start: now - 60_000,
			end: now + 60_000,
			regionName: 'Kreis Biberach',
			description: 'Es tritt strenger Frost auf.',
			event: 'STRENGER FROST',
			headline: 'Amtliche WARNUNG vor STRENGEM FROST',
			instruction: 'Frostschutzmaßnahmen ergreifen',
			stateShort: 'BW',
			altitudeStart: null,
			altitudeEnd: null,
		};

		const cacheFullId = 'msghub.0.IngestDwd.0.aiCache';

		const { iobroker, calls: brokerCalls } = makeIoBroker({
			foreignStates: {
				'dwd.0.numberOfWarnings': { val: 1 },
				'dwd.0.warning.object': { val: warning },
				[cacheFullId]: { val: '' },
			},
		});
		const store = makeStore();
		// Existing message that should be removed.
		store.addMessage({ ref: 'IngestDwd.0.deadbeefdeadbeef', kind: MsgConstants.kind.status, level: 10, timing: {} });

		const managedObjects = makeManagedObjects();
		const ctx = makeCtx({ iobroker, store, options: makeOptions(), managedObjects });

		const plugin = IngestDwd({ dwdInstance: 'dwd.0', syncDebounceMs: 0 });
		plugin.start(ctx);

		await flush();
		await flush();

		expect(brokerCalls.subscribeForeignStates).to.include('dwd.0.numberOfWarnings');
		expect(brokerCalls.subscribeForeignStates).to.include('dwd.0.warning.object');

		expect(store.calls.addMessage.length).to.be.greaterThanOrEqual(1);
		const msg = store.calls.addMessage.find(
			m =>
				typeof m?.ref === 'string' &&
				m.ref.startsWith('IngestDwd.0.') &&
				m?.origin?.system === 'dwd.0' &&
				m?.origin?.type === MsgConstants.origin.type.import,
		);
		expect(msg).to.be.an('object');
		expect(msg.kind).to.equal(MsgConstants.kind.status);
		expect(msg.origin).to.deep.include({ type: MsgConstants.origin.type.import, system: 'dwd.0' });
		expect(msg.title).to.equal(warning.headline);
		expect(msg.text).to.equal(warning.description);
		expect(msg.level).to.equal(MsgConstants.level.warning);
		expect(msg.details).to.have.property('reason', 'Wetterbedingung');
		expect(msg.details).to.have.property('task', warning.instruction);
		expect(msg.timing).to.have.property('expiresAt', warning.end);
		expect(msg.timing).to.have.property('remindEvery');
		expect(msg.actions.map(a => a.id)).to.deep.equal(['ack', 'snooze1h']);

		// start is in the past => immediate due behavior => plugin ensures a finite notifyAt afterwards.
		expect(store.calls.updateMessage.some(([, patch]) => patch?.timing?.notifyAt != null)).to.equal(true);

		// Cleanup removed the stale ref.
		expect(store.calls.completeAfterCauseEliminated).to.have.length(1);
		expect(store.calls.completeAfterCauseEliminated[0][0]).to.equal('IngestDwd.0.deadbeefdeadbeef');
	});

	it('filters by altitude when configured (inclusive bounds)', async () => {
		const now = Date.now();
		const low = {
			state: 'BW',
			type: 1,
			level: 2,
			start: now - 1000,
			end: now + 60_000,
			regionName: 'Lowland',
			description: 'Low',
			event: 'LOW',
			headline: 'LOW',
			instruction: 'Low',
			stateShort: 'BW',
			altitudeStart: 0,
			altitudeEnd: 100,
		};
		const high = {
			state: 'BW',
			type: 1,
			level: 2,
			start: now - 1000,
			end: now + 60_000,
			regionName: 'Highland',
			description: 'High',
			event: 'HIGH',
			headline: 'HIGH',
			instruction: 'High',
			stateShort: 'BW',
			altitudeStart: 200,
			altitudeEnd: 800,
		};

		const { iobroker } = makeIoBroker({
			foreignStates: {
				'dwd.0.numberOfWarnings': { val: 2 },
				'dwd.0.warning.object': { val: low },
				'dwd.0.warning1.object': { val: high },
			},
		});
		const store = makeStore();
		const managedObjects = makeManagedObjects();
		const ctx = makeCtx({
			iobroker,
			store,
			options: makeOptions({ overrides: { useAltitudeFilter: true, altitudeM: 100 } }),
			managedObjects,
		});

		const plugin = IngestDwd({ dwdInstance: 'dwd.0', useAltitudeFilter: true, altitudeM: 100, syncDebounceMs: 0 });
		plugin.start(ctx);
		await flush();
		await flush();

		const refs = store.calls.addMessage.map(m => m.ref);
		expect(refs.length).to.equal(1);
		expect(store.calls.addMessage[0].details.location).to.match(/Lowland/);
	});
});
