'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const { MsgConstants } = require('../../src/MsgConstants');
const { BridgeAlexaShopping } = require('./index');

function createCtx({ message } = {}) {
	const defaults = {
		jsonStateId: 'alexa2.0.Lists.SHOP.json',
		listTitle: 'Alexa shopping list',
		location: 'Supermarket',
		audienceTagsCsv: '',
		fullSyncIntervalMs: 60 * 60 * 1000,
		conflictWindowMs: 5000,
		keepCompleted: 12 * 60 * 60 * 1000,
		aiEnhancement: true,
		categoriesCsv: 'Produce,Bakery,Dairy,Meat,Frozen,Pantry,Drinks,Household,Hygiene,Other',
		aiMinConfidencePct: 80,
	};

	const store = {
		getMessageByRef: sinon.stub().callsFake(ref => (message && message.ref === ref ? message : undefined)),
		addMessage: sinon.spy(),
		removeMessage: sinon.spy(),
		updateMessage: sinon.spy(),
	};

	let startedResolve;
	const started = new Promise(resolve => {
		startedResolve = resolve;
	});

	const ctx = {
		meta: {
			plugin: { instanceId: 1, baseOwnId: 'msghub.0.BridgeAlexaShopping.1', baseFullId: 'msghub.0.BridgeAlexaShopping.1' },
			options: {
				resolveString: (key, value) => (value !== undefined ? value : defaults[key]),
				resolveInt: (key, value) => (value !== undefined ? value : defaults[key]),
				resolveBool: (key, value) => (value !== undefined ? value : defaults[key]),
			},
			resources: {
				setTimeout: () => 1,
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
			i18n: { t: (key, ...args) => (args.length ? require('util').format(key, ...args) : key) },
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
					setForeignState: async () => {},
				},
				subscribe: { subscribeForeignStates: () => {} },
			},
		},
	};

	return { ctx, store, started };
}

describe('BridgeAlexaShopping', () => {
	it('preserves category/quantity when syncing item updates from Alexa', async () => {
		const msg = {
			ref: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json',
			listItems: [
				{
					id: 'a:1',
					name: 'Milk',
					checked: false,
					category: 'Dairy',
					quantity: { val: 1, unit: 'l' },
				},
			],
		};

		const { ctx, store, started } = createCtx({ message: msg });
		const plugin = BridgeAlexaShopping();

		plugin.start(ctx);
		await started;

		store.updateMessage.resetHistory();

		plugin.onStateChange(
			'alexa2.0.Lists.SHOP.json',
			{ val: JSON.stringify([{ id: '1', value: 'Milk', completed: true }]) },
			ctx,
		);

		expect(store.updateMessage).to.have.been.calledOnce;
		const [, patch] = store.updateMessage.getCall(0).args;
		expect(patch).to.have.property('listItems');
		expect(patch.listItems).to.have.property('set');
		expect(patch.listItems.set).to.have.property('a:1');
		expect(patch.listItems.set['a:1']).to.deep.equal({
			name: 'Milk',
			checked: true,
			category: 'Dairy',
			quantity: { val: 1, unit: 'l' },
		});
	});
});
