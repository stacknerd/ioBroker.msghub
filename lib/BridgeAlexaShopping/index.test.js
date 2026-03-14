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
		messageIcon: '🛒',
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
		updateMessage: sinon.spy((ref, patch) => {
			if (message && message.ref === ref && patch && typeof patch === 'object' && !Array.isArray(patch)) {
				for (const [k, v] of Object.entries(patch)) {
					message[k] = v;
				}
			}
			return true;
		}),
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
				i18nlocale: 'en',
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
		const resolveStringOrig = ctx.meta.options.resolveString;
		ctx.meta.options.resolveString = (key, value) => {
			if (value !== undefined) {
				return value;
			}
			if (key === 'audienceTagsCsv') return 'team';
			if (key === 'audienceChannelsIncludeCsv') return 'Family';
			if (key === 'audienceChannelsExcludeCsv') return 'Silent';
			return resolveStringOrig(key, value);
		};

		const plugin = BridgeAlexaShopping({ fullSyncIntervalMs: 1 });
		plugin.start(ctx);
		await started;

		expect(store.addMessage).to.have.been.called;
		const msg = store.addMessage.getCalls().map(c => c.args[0]).find(Boolean);
		expect(msg).to.have.property('icon', '🛒');
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
			icon: '🛒',
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

	it('patches icon when message icon option changes', async () => {
		const ref = 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json';
		const msg = {
			ref,
			icon: '🛒',
			title: 'Alexa shopping list',
			text: require('util').format('msghub.i18n.BridgeAlexaShopping.msg.syncInfo.text', 'Alexa shopping list'),
			details: { location: 'Supermarket' },
			timing: { notifyAt: Date.now() + 1 },
			listItems: [],
		};

		const { ctx, store, started } = createCtx({ message: msg });
		ctx.meta.options.resolveString = (key, value) => {
			if (value !== undefined) {
				return value;
			}
			if (key === 'messageIcon') return '🧺';
			if (key === 'jsonStateId') return 'alexa2.0.Lists.SHOP.json';
			if (key === 'listTitle') return 'Alexa shopping list';
			if (key === 'location') return 'Supermarket';
			if (key === 'audienceTagsCsv') return '';
			if (key === 'audienceChannelsIncludeCsv') return '';
			if (key === 'audienceChannelsExcludeCsv') return '';
			if (key === 'categoriesCsv') return 'Produce,Bakery,Dairy,Meat,Frozen,Pantry,Drinks,Household,Hygiene,Other';
			return '';
		};

		const plugin = BridgeAlexaShopping({ fullSyncIntervalMs: 1 });
		plugin.start(ctx);
		await started;

		expect(store.updateMessage).to.have.been.calledOnce;
		const [, patch] = store.updateMessage.getCall(0).args;
		expect(patch).to.have.property('icon', '🧺');
	});

	it('prefers i18n text language over format locale for parser selection', async () => {
		const msg = {
			ref: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json',
			listItems: [],
		};

		const { ctx, store, started } = createCtx({ message: msg });
		ctx.api.i18n.i18nlocale = 'de-DE';

		const plugin = BridgeAlexaShopping();
		plugin.start(ctx);
		await started;

		store.updateMessage.resetHistory();

		plugin.onStateChange(
			'alexa2.0.Lists.SHOP.json',
			{ val: JSON.stringify([{ id: '1', value: 'zwei packungen butter', completed: false }]) },
			ctx,
		);

		await tick();

		expect(store.updateMessage).to.have.been.calledOnce;
		const [, patch] = store.updateMessage.getCall(0).args;
		expect(patch).to.have.nested.property('listItems.set');
		const parsed = Object.values(patch.listItems.set || {})[0];
		expect(parsed).to.include({ name: 'Butter', checked: false });
		expect(parsed).to.have.property('quantity');
		expect(parsed.quantity).to.deep.equal({ val: 2, unit: 'pack' });
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

		it('includes packaging and unit fields in AI categorization request for packaged items', async () => {
		const aiJson = sinon.stub().resolves({ ok: true, value: { results: [] } });
		const msg = { ref: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json', listItems: [] };
		const { ctx, store, started } = createCtx({ message: msg });
		ctx.api.ai = { getStatus: () => ({ enabled: true }), json: aiJson };
		ctx.meta.resources.setTimeout = fn => {
			setImmediate(fn);
			return 1;
		};

		const plugin = BridgeAlexaShopping();
		plugin.start(ctx);
		await started;

		store.updateMessage.resetHistory();
		msg.listItems = [
			{ id: 'a:1', name: 'Ananas', checked: false, quantity: { val: 1, unit: 'can' }, perUnit: { val: 400, unit: 'g' } },
		];

		plugin.onStateChange('alexa2.0.Lists.SHOP.json', { val: '[]' }, ctx);
		for (let i = 0; i < 5; i++) await tick();

		expect(aiJson).to.have.been.calledOnce;
		const userContent = JSON.parse(aiJson.getCall(0).args[0].messages.find(m => m.role === 'user').content);
		const item = userContent.items.find(b => b.text === 'Ananas');
		expect(item).to.exist;
		expect(item).to.have.property('key', 'ananas|can');
		expect(item).to.have.property('packaging', 'can');
		expect(item).to.have.property('unit', 'g');
	});

	it('caches under the packaging-aware key so different amounts of the same variant skip the AI', async () => {
		// Regression test for the original bug: "1 Dose Ananas 400g" and "1 Dose Ananas 250g" must
		// share the same cache key "ananas|can" — the specific amount must never be part of the key.
		const aiJson = sinon.stub().resolves({
			ok: true,
			value: { results: [{ key: 'ananas|can', category: 'Produce', confidence: 0.95 }] },
		});
		const msg = { ref: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json', listItems: [] };
		const { ctx, store, started } = createCtx({ message: msg });
		ctx.api.ai = { getStatus: () => ({ enabled: true }), json: aiJson };
		ctx.meta.resources.setTimeout = fn => {
			setImmediate(fn);
			return 1;
		};

		const plugin = BridgeAlexaShopping();
		plugin.start(ctx);
		await started;

		// First run: 400g can — AI is called and learns "ananas|can" → "Produce"
		store.updateMessage.resetHistory();
		msg.listItems = [
			{ id: 'a:1', name: 'Ananas', checked: false, quantity: { val: 1, unit: 'can' }, perUnit: { val: 400, unit: 'g' } },
		];
		plugin.onStateChange('alexa2.0.Lists.SHOP.json', { val: '[]' }, ctx);
		for (let i = 0; i < 5; i++) await tick();
		expect(aiJson).to.have.been.calledOnce;

		// Second run: 250g can — same packaging type, different amount → must hit cache, not AI
		aiJson.resetHistory();
		store.updateMessage.resetHistory();
		msg.listItems = [
			{ id: 'a:1', name: 'Ananas', checked: false, quantity: { val: 1, unit: 'can' }, perUnit: { val: 250, unit: 'g' } },
		];
		plugin.onStateChange('alexa2.0.Lists.SHOP.json', { val: '[]' }, ctx);
		for (let i = 0; i < 5; i++) await tick();
		expect(aiJson).to.not.have.been.called;
	});

	it('uses separate learning keys so canned and fresh items are categorized independently', async () => {
		const categoriesFullId = 'msghub.0.BridgeAlexaShopping.1.categories';
		const preloadedCategories = {
			signature: 'v2|produce|bakery|dairy|meat|frozen|pantry|drinks|household|hygiene|other',
			learned: {
				'ananas|can': { category: 'Produce', confidence: 0.95, updatedAt: Date.now() },
			},
		};

		const aiJson = sinon.stub().resolves({ ok: true, value: { results: [] } });
		const msg = { ref: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json', listItems: [] };
		const { ctx, store, started } = createCtx({ message: msg });
		ctx.api.ai = { getStatus: () => ({ enabled: true }), json: aiJson };
		ctx.meta.resources.setTimeout = fn => {
			setImmediate(fn);
			return 1;
		};
		ctx.api.iobroker.states.getForeignState = async id => {
			if (id === categoriesFullId) {
				return { val: JSON.stringify(preloadedCategories) };
			}
			return { val: '[]' };
		};

		const plugin = BridgeAlexaShopping();
		plugin.start(ctx);
		await started;

		store.updateMessage.resetHistory();
		msg.listItems = [
			// Canned Ananas: key 'ananas|can' → in cache → served without AI call
			{ id: 'a:1', name: 'Ananas', checked: false, quantity: { val: 1, unit: 'can' }, perUnit: { val: 400, unit: 'g' } },
			// Fresh Ananas: key 'ananas' → not in cache → must go to AI
			{ id: 'a:2', name: 'Ananas', checked: false },
		];

		plugin.onStateChange('alexa2.0.Lists.SHOP.json', { val: '[]' }, ctx);
		for (let i = 0; i < 5; i++) await tick();

		// Only the fresh item goes to AI; canned item is served from cache
		expect(aiJson).to.have.been.calledOnce;
		const userContent = JSON.parse(aiJson.getCall(0).args[0].messages.find(m => m.role === 'user').content);
		expect(userContent.items).to.have.length(1);
		expect(userContent.items[0]).to.have.property('key', 'ananas');
		expect(userContent.items[0]).to.not.have.property('packaging');

		// Canned item is patched from cache with 'Produce'
		const patchWithCanned = store.updateMessage.getCalls().map(c => c.args[1]).find(p => p?.listItems?.set?.['a:1']);
		expect(patchWithCanned).to.exist;
		expect(patchWithCanned.listItems.set['a:1']).to.have.property('category', 'Produce');
	});

	it('clears legacy (pre-v2) category cache to prevent stale entries from polluting results', async () => {
		const categoriesFullId = 'msghub.0.BridgeAlexaShopping.1.categories';
		// Old format: no 'v2|' prefix — would be left over from before packaging-aware keys
		const legacyCategories = {
			signature: 'produce|bakery|dairy|meat|frozen|pantry|drinks|household|hygiene|other',
			learned: {
				ananas: { category: 'Produce', confidence: 0.95, updatedAt: Date.now() },
			},
		};

		const aiJson = sinon.stub().resolves({ ok: true, value: { results: [] } });
		const msg = { ref: 'BridgeAlexaShopping.1.alexa2.0.Lists.SHOP.json', listItems: [] };
		const { ctx, store, started } = createCtx({ message: msg });
		ctx.api.ai = { getStatus: () => ({ enabled: true }), json: aiJson };
		ctx.meta.resources.setTimeout = fn => {
			setImmediate(fn);
			return 1;
		};
		ctx.api.iobroker.states.getForeignState = async id => {
			if (id === categoriesFullId) {
				return { val: JSON.stringify(legacyCategories) };
			}
			return { val: '[]' };
		};

		const plugin = BridgeAlexaShopping();
		plugin.start(ctx);
		await started;

		store.updateMessage.resetHistory();
		// Fresh Ananas: old cache had 'ananas → Produce' in legacy format — must be cleared, not served
		msg.listItems = [{ id: 'a:1', name: 'Ananas', checked: false }];

		plugin.onStateChange('alexa2.0.Lists.SHOP.json', { val: '[]' }, ctx);
		for (let i = 0; i < 5; i++) await tick();

		// Signature mismatch clears cache; item must be sent to AI rather than served from stale cache
		expect(aiJson).to.have.been.calledOnce;
		const userContent = JSON.parse(aiJson.getCall(0).args[0].messages.find(m => m.role === 'user').content);
		expect(userContent.items).to.have.length(1);
		expect(userContent.items[0]).to.have.property('key', 'ananas');
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
