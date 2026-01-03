'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const { MsgConstants } = require('../../src/MsgConstants');
const { BridgeAlexaTasks } = require('./index');

function createCtx({ addOk = true } = {}) {
	const defaults = {
		jsonStateId: 'alexa2.0.Lists.TODO.json',
		audienceTagsCsv: '',
		fullSyncIntervalMs: 60 * 60 * 1000,
		aiEnhancedTitle: false,
		outEnabled: false,
		outKindsCsv: 'task',
		outLevelMin: 10,
		outLevelMax: 30,
		outLifecycleStatesCsv: 'open',
		outAudienceTagsAnyCsv: '',
	};

	const store = {
		addOrUpdateMessage: sinon.stub().returns(addOk),
		getMessages: sinon.stub().returns([]),
	};

	const setForeignState = sinon.spy(async () => {});

	let startedResolve;
	const started = new Promise(resolve => {
		startedResolve = resolve;
	});

	const ctx = {
		meta: {
			plugin: {
				instanceId: 1,
				baseOwnId: 'msghub.0.BridgeAlexaTasks.1',
				baseFullId: 'msghub.0.BridgeAlexaTasks.1',
			},
			options: {
				resolveString: (key, value) => (value !== undefined ? value : defaults[key]),
				resolveInt: (key, value) => (value !== undefined ? value : defaults[key]),
				resolveBool: (key, value) => (value !== undefined ? value : defaults[key]),
			},
			resources: {
				setTimeout: (fn, _ms) => {
					fn();
					return 1;
				},
				clearTimeout: () => {},
				setInterval: () => {
					if (startedResolve) {
						startedResolve();
						startedResolve = null;
					}
					return 1;
				},
			},
		},
		api: {
			constants: MsgConstants,
			i18n: { t: k => k },
			store,
			factory: { createMessage: m => m },
			ai: { getStatus: () => ({ enabled: false }) },
			log: { warn: () => {} },
			iobroker: {
				objects: {
					setObjectNotExists: async () => {},
					extendForeignObject: async () => {},
					getForeignObject: async () => null,
				},
				states: {
					getForeignState: async () => ({ val: '[]' }),
					setState: async () => {},
					setForeignState,
				},
				subscribe: { subscribeForeignStates: () => {} },
			},
		},
	};

	return { ctx, store, setForeignState, started };
}

describe('BridgeAlexaTasks', () => {
	it('deletes Alexa item when import succeeds', async () => {
		const { ctx, store, setForeignState, started } = createCtx({ addOk: true });
		ctx.api.iobroker.states.getForeignState = async () => ({
			val: JSON.stringify([{ id: 'x', value: 'Do thing', completed: false, createdDateTime: Date.now() }]),
		});

		const plugin = BridgeAlexaTasks({ outEnabled: false });
		plugin.start(ctx);
		await started;

		expect(store.addOrUpdateMessage).to.have.been.calledOnce;
		expect(setForeignState).to.have.been.called;
		const calls = setForeignState.getCalls().map(c => c.args[0]);
		expect(calls.some(id => id === 'alexa2.0.Lists.TODO.items.x.#delete')).to.equal(true);
		const deleteCall = setForeignState.getCalls().find(c => c.args[0] === 'alexa2.0.Lists.TODO.items.x.#delete');
		expect(deleteCall.args[1]).to.deep.equal({ val: true, ack: false });
	});

	it('marks Alexa item completed when import fails', async () => {
		const { ctx, store, setForeignState, started } = createCtx({ addOk: false });
		ctx.api.iobroker.states.getForeignState = async () => ({
			val: JSON.stringify([{ id: 'x', value: 'Do thing', completed: false, createdDateTime: Date.now() }]),
		});

		const plugin = BridgeAlexaTasks({ outEnabled: false });
		plugin.start(ctx);
		await started;

		expect(store.addOrUpdateMessage).to.have.been.calledOnce;
		expect(setForeignState).to.have.been.called;
		const calls = setForeignState.getCalls().map(c => c.args[0]);
		expect(calls.some(id => id === 'alexa2.0.Lists.TODO.items.x.completed')).to.equal(true);
		const compCall = setForeignState.getCalls().find(c => c.args[0] === 'alexa2.0.Lists.TODO.items.x.completed');
		expect(compCall.args[1]).to.deep.equal({ val: true, ack: false });
	});

	it('purges mirrored items from Alexa when outbound is disabled', async () => {
		const { ctx, setForeignState, started } = createCtx({ addOk: true });
		const setState = sinon.spy(async () => {});
		ctx.api.iobroker.states.setState = setState;

		const mappingFullId = 'msghub.0.BridgeAlexaTasks.1.mapping';
		ctx.api.iobroker.states.getForeignState = async id => {
			if (id === mappingFullId) {
				return {
					val: JSON.stringify({
						version: 1,
						jsonStateId: 'alexa2.0.Lists.TODO.json',
						out: {
							messageRefToExternal: { 'x-ref': 'x', 'y-ref': 'y' },
							externalToMessageRef: { x: 'x-ref', y: 'y-ref' },
							pendingCreates: {},
						},
					}),
				};
			}
			return { val: JSON.stringify([{ id: 'x', value: 'X', completed: false }, { id: 'y', value: 'Y', completed: false }]) };
		};

		const plugin = BridgeAlexaTasks({ outEnabled: false });
		plugin.start(ctx);
		await started;

		const calls = setForeignState.getCalls().map(c => c.args[0]);
		expect(calls.some(id => id === 'alexa2.0.Lists.TODO.items.x.#delete')).to.equal(true);
		expect(calls.some(id => id === 'alexa2.0.Lists.TODO.items.y.#delete')).to.equal(true);

		const lastWrite = setState.getCalls().slice(-1)[0]?.args?.[1]?.val;
		const persisted = lastWrite ? JSON.parse(lastWrite) : null;
		expect(persisted).to.have.property('out');
		expect(Object.keys(persisted.out.messageRefToExternal || {})).to.have.length(0);
		expect(Object.keys(persisted.out.externalToMessageRef || {})).to.have.length(0);
	});

	it('rebuilds reverse mapping on load (externalToMessageRef)', async () => {
		const { ctx, store, started } = createCtx({ addOk: true });
		const mappingFullId = 'msghub.0.BridgeAlexaTasks.1.mapping';
		ctx.api.iobroker.states.getForeignState = async id => {
			if (id === mappingFullId) {
				return {
					val: JSON.stringify({
						version: 1,
						jsonStateId: 'alexa2.0.Lists.TODO.json',
						out: {
							messageRefToExternal: { 'some-ref': 'x' },
							externalToMessageRef: {},
							pendingCreates: {},
						},
					}),
				};
			}
			return { val: JSON.stringify([{ id: 'x', value: 'Renamed in Alexa', completed: false }]) };
		};

		const plugin = BridgeAlexaTasks({ outEnabled: true });
		plugin.start(ctx);
		await started;

		expect(store.addOrUpdateMessage).to.have.not.been.called;
	});
});
