'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const { MsgConstants } = require('../../src/MsgConstants');
const { BridgeAlexaShopping } = require('./index');

const tick = () => new Promise(resolve => setImmediate(resolve));

function createCtx({ message } = {}) {
	const defaults = {
		jsonStateId: 'alexa2.0.Lists.SHOP.json',
		listTitle: 'Alexa shopping list',
		location: 'Supermarket',
		audienceTagsCsv: '',
		audienceChannelsIncludeCsv: '',
		audienceChannelsExcludeCsv: '',
		fullSyncIntervalMs: 60 * 60 * 1000,
		pendingMaxJsonMisses: 30,
		keepCompleted: 12 * 60 * 60 * 1000,
		aiEnhancement: true,
		categoriesCsv: 'Produce,Bakery,Dairy,Meat,Frozen,Pantry,Drinks,Household,Hygiene,Other',
			aiMinConfidencePct: 80,
			parseItemText: true,
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
			i18n: {
				locale: 'en',
				lang: 'en',
				t: (key, ...args) => (args.length ? require('util').format(key, ...args) : key),
			},
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
	it('writes audience.channels include/exclude to the shoppinglist message', async () => {
		const { ctx, store, started } = createCtx();
		ctx.meta.options.resolveString = (key, value) => {
			if (value !== undefined) {
				return value;
			}
			if (key === 'audienceTagsCsv') {
				return 'team';
			}
			if (key === 'audienceChannelsIncludeCsv') {
				return 'Family';
			}
			if (key === 'audienceChannelsExcludeCsv') {
				return 'Silent';
			}
			return '';
		};

		const plugin = BridgeAlexaShopping({ fullSyncIntervalMs: 1 });
		plugin.start(ctx);
		await started;

		expect(store.addMessage).to.have.been.called;
		const msg = store.addMessage.getCalls().map(c => c.args[0]).find(Boolean);
		expect(msg).to.have.property('audience');
		expect(msg.audience).to.deep.equal({
			tags: ['team'],
			channels: { include: ['Family'], exclude: ['Silent'] },
		});
	});

	it('does not patch the shoppinglist message when unchanged', async () => {
		const ref = 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json';
		const msg = {
			ref,
			title: 'Alexa shopping list',
			text: require('util').format('msghub.i18n.BridgeAlexaShopping.msg.syncInfo.text', 'Alexa shopping list'),
			details: { location: 'Supermarket' },
			timing: { notifyAt: Date.now() + 1 },
			listItems: [],
		};

		const { ctx, store, started } = createCtx({ message: msg });

		const plugin = BridgeAlexaShopping({ fullSyncIntervalMs: 1 });
		plugin.start(ctx);
		await started;

		expect(store.updateMessage).to.not.have.been.called;
	});

		it('preserves category/quantity when syncing item updates from Alexa', async () => {
		const msg = {
			ref: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json',
			listItems: [
				{
					id: 'a:1',
					name: 'Milk',
					checked: false,
					category: 'Dairy',
					quantity: { val: 1, unit: 'pcs' },
					perUnit: { val: 1, unit: 'l' },
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

			await tick();

			expect(store.updateMessage).to.have.been.calledOnce;
			const [, patch] = store.updateMessage.getCall(0).args;
			expect(patch).to.have.property('listItems');
			expect(patch.listItems).to.have.property('set');
		expect(patch.listItems.set).to.have.property('a:1');
		expect(patch.listItems.set['a:1']).to.deep.equal({
			name: 'Milk',
			checked: true,
			category: 'Dairy',
			quantity: { val: 1, unit: 'pcs' },
			perUnit: { val: 1, unit: 'l' },
		});
	});

		it('deletes tilde-prefixed Alexa items without pending match', async () => {
		const msg = { ref: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json', listItems: [] };
		const { ctx, store, started } = createCtx({ message: msg });
		const setForeignState = sinon.spy(async () => {});
		ctx.api.iobroker.states.setForeignState = setForeignState;
		const plugin = BridgeAlexaShopping();

		plugin.start(ctx);
		await started;

		store.updateMessage.resetHistory();
		setForeignState.resetHistory();

			plugin.onStateChange(
				'alexa2.0.Lists.SHOP.json',
				{ val: JSON.stringify([{ id: '1', value: '~ Milk - 1 pcs', completed: false }]) },
				ctx,
			);

			await tick();

			expect(store.updateMessage).to.not.have.been.called;
			expect(setForeignState).to.have.been.calledOnce;
			expect(setForeignState.getCall(0).args[0]).to.equal('alexa2.0.Lists.SHOP.items.1.#delete');
		});

		it('deletes mapped Alexa items when local item is missing (even after restart)', async () => {
			const deleted = [];
			const { ctx, started } = createCtx();
			ctx.api.iobroker.states.setForeignState = async id => {
			deleted.push(id);
		};

		const mappingFullId = 'msghub.0.BridgeAlexaShopping.1.mapping';
		ctx.api.iobroker.states.getForeignState = async id => {
			if (id === mappingFullId) {
				return {
					val: JSON.stringify({
						version: 4,
						messageRef: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json',
						jsonStateId: 'alexa2.0.Lists.SHOP.json',
						localToExternal: { 'a:1': '1' },
						externalToLocal: { '1': 'a:1' },
						pendingCreates: {},
						checkedAt: {},
					}),
				};
			}
			return { val: '[]' };
		};

		const plugin = BridgeAlexaShopping({ fullSyncIntervalMs: 1 });
		plugin.start(ctx);
		await started;

			plugin.onNotifications(
				MsgConstants.notfication.events.update,
				[{ ref: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json', listItems: [] }],
				ctx,
			);

			await tick();

			expect(deleted.some(id => id === 'alexa2.0.Lists.SHOP.items.1.#delete')).to.equal(true);
		});

		it('does not delete items when Alexa JSON is missing', async () => {
			const msg = {
				ref: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json',
				listItems: [{ id: 'a:1', name: 'Milk', checked: false }],
			};
			const { ctx, store, started } = createCtx({ message: msg });

			const mappingFullId = 'msghub.0.BridgeAlexaShopping.1.mapping';
			ctx.api.iobroker.states.getForeignState = async id => {
				if (id === mappingFullId) {
					return {
						val: JSON.stringify({
							version: 4,
							messageRef: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json',
							jsonStateId: 'alexa2.0.Lists.SHOP.json',
							localToExternal: { 'a:1': '1' },
							externalToLocal: { '1': 'a:1' },
							pendingCreates: {},
							checkedAt: {},
						}),
					};
				}
				return { val: JSON.stringify([{ id: '1', value: 'Milk', completed: false }]) };
			};

			const plugin = BridgeAlexaShopping({ fullSyncIntervalMs: 1 });
			plugin.start(ctx);
			await started;

			store.updateMessage.resetHistory();

			plugin.onStateChange('alexa2.0.Lists.SHOP.json', null, ctx);
			await tick();
			expect(store.updateMessage).to.not.have.been.called;
		});

		it('requires 3 empty snapshots before deleting all mapped items', async () => {
			const msg = {
				ref: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json',
				listItems: [{ id: 'a:1', name: 'Milk', checked: false }],
			};
			const { ctx, store, started } = createCtx({ message: msg });

			const mappingFullId = 'msghub.0.BridgeAlexaShopping.1.mapping';
			ctx.api.iobroker.states.getForeignState = async id => {
				if (id === mappingFullId) {
					return {
						val: JSON.stringify({
							version: 4,
							messageRef: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json',
							jsonStateId: 'alexa2.0.Lists.SHOP.json',
							localToExternal: { 'a:1': '1' },
							externalToLocal: { '1': 'a:1' },
							pendingCreates: {},
							checkedAt: {},
						}),
					};
				}
				return { val: JSON.stringify([{ id: '1', value: 'Milk', completed: false }]) };
			};

			const plugin = BridgeAlexaShopping({ fullSyncIntervalMs: 1 });
			plugin.start(ctx);
			await started;

			store.updateMessage.resetHistory();

			plugin.onStateChange('alexa2.0.Lists.SHOP.json', { val: '[]' }, ctx);
			await tick();
			plugin.onStateChange('alexa2.0.Lists.SHOP.json', { val: '[]' }, ctx);
			await tick();
			expect(store.updateMessage).to.not.have.been.called;

			plugin.onStateChange('alexa2.0.Lists.SHOP.json', { val: '[]' }, ctx);
			await tick();
			expect(store.updateMessage).to.have.been.calledOnce;
			const [, patch] = store.updateMessage.getCall(0).args;
			expect(patch.listItems).to.have.property('delete');
			expect(patch.listItems.delete).to.deep.equal(['a:1']);
		});

		it('skips import and export when Alexa connection is false', async () => {
			const msg = {
				ref: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json',
				listItems: [{ id: 'a:1', name: 'Milk', checked: false }],
			};
			const { ctx, store, started } = createCtx({ message: msg });
			const setForeignState = sinon.spy(async () => {});
			ctx.api.iobroker.states.setForeignState = setForeignState;

			const mappingFullId = 'msghub.0.BridgeAlexaShopping.1.mapping';
			ctx.api.iobroker.states.getForeignState = async id => {
				if (id === 'alexa2.0.info.connection') {
					return { val: false };
				}
				if (id === mappingFullId) {
					return {
						val: JSON.stringify({
							version: 4,
							messageRef: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json',
							jsonStateId: 'alexa2.0.Lists.SHOP.json',
							localToExternal: { 'a:1': '1' },
							externalToLocal: { '1': 'a:1' },
							pendingCreates: {},
							checkedAt: {},
						}),
					};
				}
				return { val: JSON.stringify([{ id: '1', value: 'Milk', completed: false }]) };
			};

			const plugin = BridgeAlexaShopping({ fullSyncIntervalMs: 1 });
			plugin.start(ctx);
			await started;

			store.updateMessage.resetHistory();
			setForeignState.resetHistory();

			plugin.onStateChange(
				'alexa2.0.Lists.SHOP.json',
				{ val: JSON.stringify([{ id: '1', value: 'Milk', completed: true }]) },
				ctx,
			);
			plugin.onNotifications(MsgConstants.notfication.events.update, [msg], ctx);

			await tick();

			expect(store.updateMessage).to.not.have.been.called;
			expect(setForeignState).to.not.have.been.called;
		});
	});
