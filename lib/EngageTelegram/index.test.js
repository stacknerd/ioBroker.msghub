'use strict';

const { expect } = require('chai');

const { EngageTelegram } = require('./index');
const { MsgConstants } = require('../../src/MsgConstants');

const flush = () => new Promise(resolve => setImmediate(resolve));

function makeOptionsResolver(values) {
	const get = (key, fallback) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback);
	return {
		resolveString: (key, fallback) => String(get(key, fallback) ?? ''),
		resolveInt: (key, fallback) => Number(get(key, fallback)),
		resolveBool: (key, fallback) => Boolean(get(key, fallback) ?? fallback),
	};
}

function makeCtx({ options, sendTo, getForeignState, setState, setObjectNotExists, subscribeForeignStates, unsubscribeForeignStates, actionExecute, getMessageByRef, i18nT } = {}) {
	const calls = {
		sendTo: [],
		setState: [],
		setObjectNotExists: [],
		subscribe: [],
		unsubscribe: [],
		actionExecute: [],
	};

	const ctx = {
		api: {
			log: { info: () => undefined, warn: () => undefined, debug: () => undefined },
			constants: MsgConstants,
			i18n: i18nT ? { t: i18nT } : null,
			iobroker: {
				sendTo: (...args) => {
					calls.sendTo.push(args);
					return sendTo(...args);
				},
				states: {
					getForeignState: id => getForeignState(id),
					setState: (id, state) => {
						calls.setState.push([id, state]);
						return setState(id, state);
					},
				},
				objects: {
					setObjectNotExists: (id, obj) => {
						calls.setObjectNotExists.push([id, obj]);
						return setObjectNotExists(id, obj);
					},
				},
				subscribe: {
					subscribeForeignStates: pattern => {
						calls.subscribe.push(pattern);
						return subscribeForeignStates(pattern);
					},
					unsubscribeForeignStates: pattern => {
						calls.unsubscribe.push(pattern);
						return unsubscribeForeignStates(pattern);
					},
				},
			},
			store: { getMessageByRef },
			action: {
				execute: opts => {
					calls.actionExecute.push(opts);
					return actionExecute(opts);
				},
			},
		},
		meta: { options },
	};

	return { ctx, calls };
}

describe('EngageTelegram', () => {
	it('only sends notifications for event=due', async () => {
		const sendTo = (_instance, _cmd, _payload) => Promise.resolve({ '1': 10 });
		const getForeignState = () => Promise.resolve({ val: '' });
		const setState = () => Promise.resolve();
		const setObjectNotExists = () => Promise.resolve();
		const subscribeForeignStates = () => undefined;
		const unsubscribeForeignStates = () => undefined;
		const actionExecute = () => true; // not used by EngageTelegram (step 1)
		const getMessageByRef = () => null; // not used by EngageTelegram (step 1)

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 50,
		});

		const { ctx, calls } = makeCtx({
			options,
			sendTo,
			getForeignState,
			setState,
			setObjectNotExists,
			subscribeForeignStates,
			unsubscribeForeignStates,
			actionExecute,
			getMessageByRef,
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		h.onNotifications(
			MsgConstants.notfication.events.update,
			[
				{
					ref: 'm1',
					kind: 'task',
					level: MsgConstants.level.warning,
					title: 'Hello',
					text: 'World',
					actions: [{ type: 'ack', id: 'ack' }],
				},
			],
			ctx,
		);

		await flush();
		await flush();

		// `updated` should not send (due-only behavior)
		expect(calls.sendTo).to.have.length(0);

		h.onNotifications(
			MsgConstants.notfication.events.due,
			[
				{
					ref: 'm1',
					kind: 'task',
					level: MsgConstants.level.warning,
					title: 'Hello2',
					text: 'World2',
					actions: [{ type: 'ack', id: 'ack' }],
				},
			],
			ctx,
		);

		await flush();
		await flush();

		expect(calls.sendTo).to.have.length(1);
	});

	it('deletes old telegram messages on due resend', async () => {
		const sendPayloads = [];
		const sendTo = (_instance, _cmd, payload) => {
			sendPayloads.push(payload);
			if (payload?.deleteMessage) {
				return Promise.resolve(null);
			}
			return Promise.resolve({ '1': 10 });
		};
		const getForeignState = () => Promise.resolve({ val: '' });
		const setState = () => Promise.resolve();
		const setObjectNotExists = () => Promise.resolve();
		const subscribeForeignStates = () => undefined;
		const unsubscribeForeignStates = () => undefined;
		const actionExecute = () => true;
		const getMessageByRef = () => null;

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 50,
		});

		const { ctx } = makeCtx({
			options,
			sendTo,
			getForeignState,
			setState,
			setObjectNotExists,
			subscribeForeignStates,
			unsubscribeForeignStates,
			actionExecute,
			getMessageByRef,
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		const msg = {
			ref: 'm1',
			kind: 'task',
			level: MsgConstants.level.warning,
			title: 'Hello',
			text: 'World',
			actions: [{ type: 'ack', id: 'ack' }],
		};

		h.onNotifications(MsgConstants.notfication.events.due, [msg], ctx);
		await flush();
		await flush();

		h.onNotifications(MsgConstants.notfication.events.due, [{ ...msg, title: 'Hello2' }], ctx);
		await flush();
		await flush();

		const deletes = sendPayloads.filter(p => !!p?.deleteMessage);
		expect(deletes.length).to.equal(1);
	});

	it('deletes telegram messages on deleted/expired', async () => {
		const sendPayloads = [];
		const sendTo = (_instance, _cmd, payload) => {
			sendPayloads.push(payload);
			if (payload?.deleteMessage) {
				return Promise.resolve(null);
			}
			return Promise.resolve({ '1': 10 });
		};
		const getForeignState = () => Promise.resolve({ val: '' });
		const setState = () => Promise.resolve();
		const setObjectNotExists = () => Promise.resolve();
		const subscribeForeignStates = () => undefined;
		const unsubscribeForeignStates = () => undefined;
		const actionExecute = () => true;
		const getMessageByRef = () => null;

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 50,
		});

		const { ctx } = makeCtx({
			options,
			sendTo,
			getForeignState,
			setState,
			setObjectNotExists,
			subscribeForeignStates,
			unsubscribeForeignStates,
			actionExecute,
			getMessageByRef,
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		const msg = {
			ref: 'm1',
			kind: 'task',
			level: MsgConstants.level.warning,
			title: 'Hello',
			text: 'World',
			actions: [{ type: 'ack', id: 'ack' }],
		};

		h.onNotifications(MsgConstants.notfication.events.due, [msg], ctx);
		await flush();
		await flush();

		h.onNotifications(MsgConstants.notfication.events.deleted, [{ ref: 'm1' }], ctx);
		await flush();
		await flush();

		const deletes = sendPayloads.filter(p => !!p?.deleteMessage);
		expect(deletes.length).to.equal(1);
	});

	it('syncs text and menu button on update/recreated/recovered', async () => {
		const sendPayloads = [];
		const sendTo = (_instance, _cmd, payload) => {
			sendPayloads.push(payload);
			if (payload?.editMessageText) {
				return Promise.resolve(null);
			}
			return Promise.resolve({ '1': 10 });
		};
		const getForeignState = () => Promise.resolve({ val: '' });
		const setState = () => Promise.resolve();
		const setObjectNotExists = () => Promise.resolve();
		const subscribeForeignStates = () => undefined;
		const unsubscribeForeignStates = () => undefined;
		const actionExecute = () => true;
		const getMessageByRef = () => null;

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 50,
		});

		const { ctx } = makeCtx({
			options,
			sendTo,
			getForeignState,
			setState,
			setObjectNotExists,
			subscribeForeignStates,
			unsubscribeForeignStates,
			actionExecute,
			getMessageByRef,
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		const msg = {
			ref: 'm1',
			kind: 'task',
			level: MsgConstants.level.warning,
			title: 'Hello',
			text: 'World',
			actions: [{ type: 'ack', id: 'ack' }],
		};

		h.onNotifications(MsgConstants.notfication.events.due, [msg], ctx);
		await flush();
		await flush();

		sendPayloads.length = 0;

		h.onNotifications(MsgConstants.notfication.events.recovered, [{ ...msg, title: 'Hello2', actions: [] }], ctx);
		await flush();
		await flush();

		const edits = sendPayloads.filter(p => !!p?.editMessageText);
		expect(edits.length).to.be.greaterThan(0);
		const lastEdit = edits[edits.length - 1];
		expect(lastEdit.editMessageText.reply_markup.inline_keyboard).to.have.length(0);
	});

	it('adds exactly one menu button when actions are available', async () => {
		const sendToCalls = [];
		const sendTo = (_instance, _cmd, payload) => {
			sendToCalls.push(payload);
			return Promise.resolve({ '1': 10 });
		};
		const getForeignState = () => Promise.resolve({ val: '' });
		const setState = () => Promise.resolve();
		const setObjectNotExists = () => Promise.resolve();
		const subscribeForeignStates = () => undefined;
		const unsubscribeForeignStates = () => undefined;
		const actionExecute = () => true;
		const getMessageByRef = () => null;

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 50,
		});

		const { ctx } = makeCtx({
			options,
			sendTo,
			getForeignState,
			setState,
			setObjectNotExists,
			subscribeForeignStates,
			unsubscribeForeignStates,
			actionExecute,
			getMessageByRef,
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		h.onNotifications(
			MsgConstants.notfication.events.due,
			[
				{
					ref: 'm1',
					kind: 'task',
					level: MsgConstants.level.warning,
					title: 'Hello',
					text: 'World',
					actions: [{ type: 'ack', id: 'ack' }],
				},
			],
			ctx,
		);

		await flush();
		await flush();

		const sent = sendToCalls.find(p => p && !p?.editMessageText && !p?.deleteMessage);
		expect(sent).to.exist;
		expect(sent.reply_markup).to.be.an('object');
		expect(sent.reply_markup.inline_keyboard).to.be.an('array');
		expect(sent.reply_markup.inline_keyboard).to.have.length(1);
		expect(sent.reply_markup.inline_keyboard[0]).to.be.an('array');
		expect(sent.reply_markup.inline_keyboard[0]).to.have.length(1);
		expect(sent.reply_markup.inline_keyboard[0][0]).to.have.property('callback_data').that.matches(/^opt_[A-Za-z0-9]+:menu$/);
	});

	it('does not add a menu button when all menu actions are disabled', async () => {
		const sendToCalls = [];
		const sendTo = (_instance, _cmd, payload) => {
			sendToCalls.push(payload);
			return Promise.resolve({ '1': 10 });
		};
		const getForeignState = () => Promise.resolve({ val: '' });
		const setState = () => Promise.resolve();
		const setObjectNotExists = () => Promise.resolve();
		const subscribeForeignStates = () => undefined;
		const unsubscribeForeignStates = () => undefined;
		const actionExecute = () => true;
		const getMessageByRef = () => null;

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 50,
			enableAck: false,
			enableClose: false,
			enableSnooze: false,
			enableOpen: false,
			enableLink: false,
		});

		const { ctx } = makeCtx({
			options,
			sendTo,
			getForeignState,
			setState,
			setObjectNotExists,
			subscribeForeignStates,
			unsubscribeForeignStates,
			actionExecute,
			getMessageByRef,
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		h.onNotifications(
			MsgConstants.notfication.events.due,
			[
				{
					ref: 'm1',
					kind: 'task',
					level: MsgConstants.level.warning,
					title: 'Hello',
					text: 'World',
					actions: [{ type: 'ack', id: 'ack' }],
				},
			],
			ctx,
		);

		await flush();
		await flush();

		const sent = sendToCalls.find(p => p && !p?.editMessageText && !p?.deleteMessage);
		expect(sent).to.exist;
		expect(sent).to.not.have.property('reply_markup');
	});

	it('sends image attachments as separate telegram messages and dedupes by value', async () => {
		const sendPayloads = [];
		const sendTo = (_instance, _cmd, payload) => {
			sendPayloads.push(payload);
			return Promise.resolve({ '1': 10 });
		};
		const getForeignState = () => Promise.resolve({ val: '' });
		const setState = () => Promise.resolve();
		const setObjectNotExists = () => Promise.resolve();
		const subscribeForeignStates = () => undefined;
		const unsubscribeForeignStates = () => undefined;
		const actionExecute = () => true;
		const getMessageByRef = () => null;

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 50,
		});

		const { ctx } = makeCtx({
			options,
			sendTo,
			getForeignState,
			setState,
			setObjectNotExists,
			subscribeForeignStates,
			unsubscribeForeignStates,
			actionExecute,
			getMessageByRef,
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		const msg = {
			ref: 'klingel',
			kind: 'status',
			level: MsgConstants.level.notice,
			title: 'Haustür',
			text: 'es hat jemand geklingelt',
			actions: [{ type: 'ack', id: 'ack' }],
			attachments: [{ type: 'image', value: '/tmp/cam1.jpg' }],
		};

		h.onNotifications(MsgConstants.notfication.events.due, [msg], ctx);
		await flush();
		await flush();
		await flush();

		const imageSends = sendPayloads.filter(p => p && typeof p === 'object' && 'photo' in p);
		expect(imageSends).to.have.length(1);
		expect(imageSends[0]).to.have.property('photo', '/tmp/cam1.jpg');

		sendPayloads.length = 0;

		// Update with the same image should not resend it.
		h.onNotifications(MsgConstants.notfication.events.update, [msg], ctx);
		await flush();
		await flush();
		await flush();

		const imageSends2 = sendPayloads.filter(p => p && typeof p === 'object' && 'photo' in p);
		expect(imageSends2).to.have.length(0);
	});

	it('creates mapping entries with createdAt when telegram send returns chat message ids', async () => {
		const now = Date.now();
		const getForeignState = () => Promise.resolve({ val: '' });
		const setState = () => Promise.resolve();
		const setObjectNotExists = () => Promise.resolve();
		const subscribeForeignStates = () => undefined;
		const unsubscribeForeignStates = () => undefined;
		const actionExecute = () => true;
		const getMessageByRef = () => null;
		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 50,
		});

		const sendTo = (_instance, _cmd, _payload) => Promise.resolve({ '765': 33 });
		const { ctx, calls } = makeCtx({
			options,
			sendTo,
			getForeignState,
			setState,
			setObjectNotExists,
			subscribeForeignStates,
			unsubscribeForeignStates,
			actionExecute,
			getMessageByRef,
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		h.onNotifications(
			MsgConstants.notfication.events.due,
			[
				{
					ref: 'm1',
					kind: 'task',
					level: MsgConstants.level.warning,
					title: 'Hello',
					text: 'World',
					actions: [{ type: 'ack', id: 'ack' }],
				},
			],
			ctx,
		);

		await flush();
		await flush();

		const mappingSave = calls.setState.find(([id]) => id.endsWith('.mappingByRef'));
		expect(mappingSave).to.exist;
		const mappingByRef = JSON.parse(mappingSave[1].val);
		expect(mappingByRef).to.have.property('m1');
		expect(mappingByRef.m1).to.have.property('createdAt');
		expect(mappingByRef.m1.createdAt).to.be.a('number');
		expect(mappingByRef.m1.createdAt).to.be.greaterThan(now - 2000);
		expect(mappingByRef.m1.createdAt).to.be.lessThan(Date.now() + 2000);
	});

	it('sets disable_notification based on message level', async () => {
		const calls = { sendPayloads: [] };
		const sendTo = (_instance, _cmd, payload) => {
			calls.sendPayloads.push(payload);
			return Promise.resolve({ '1': 10 });
		};
		const getForeignState = () => Promise.resolve({ val: '' });
		const setState = () => Promise.resolve();
		const setObjectNotExists = () => Promise.resolve();
		const subscribeForeignStates = () => undefined;
		const unsubscribeForeignStates = () => undefined;
		const actionExecute = () => true;
		const getMessageByRef = () => null;

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			disableNotificationUpToLevel: MsgConstants.level.notice,
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 50,
		});

		const { ctx } = makeCtx({
			options,
			sendTo,
			getForeignState,
			setState,
			setObjectNotExists,
			subscribeForeignStates,
			unsubscribeForeignStates,
			actionExecute,
			getMessageByRef,
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		h.onNotifications(
			MsgConstants.notfication.events.due,
			[
				{ ref: 'm1', kind: 'task', level: MsgConstants.level.notice, title: 'n', text: 'x', actions: [{ type: 'ack', id: 'ack' }] },
				{ ref: 'm2', kind: 'task', level: MsgConstants.level.warning, title: 'w', text: 'y', actions: [{ type: 'ack', id: 'ack' }] },
			],
			ctx,
		);

		await flush();
		await flush();

		const sent = calls.sendPayloads.filter(p => !p?.editMessageText);
		expect(sent).to.have.length(2);
		expect(sent[0]).to.have.property('disable_notification', true);
		expect(sent[1]).to.have.property('disable_notification', false);
	});

	it('replies to unknown commands', async () => {
		const sendToCalls = [];
		const sendTo = (_instance, _cmd, payload) => {
			sendToCalls.push(payload);
			return Promise.resolve(null);
		};

		const getForeignState = id => {
			if (id === 'telegram.0.communicate.requestChatId') {
				return Promise.resolve({ val: '765' });
			}
			if (id === 'telegram.0.communicate.requestMessageId') {
				return Promise.resolve({ val: 33 });
			}
			return Promise.resolve({ val: '' });
		};
		const setState = () => Promise.resolve();
		const setObjectNotExists = () => Promise.resolve();
		const subscribeForeignStates = () => undefined;
		const unsubscribeForeignStates = () => undefined;
		const actionExecute = () => true;
		const getMessageByRef = () => null;

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 50,
		});

		const { ctx } = makeCtx({
			options,
			sendTo,
			getForeignState,
			setState,
			setObjectNotExists,
			subscribeForeignStates,
			unsubscribeForeignStates,
			actionExecute,
			getMessageByRef,
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		h.onStateChange('telegram.0.communicate.request', { val: '[Ben]/nope' }, ctx);
		await flush();
		await flush();

		expect(sendToCalls).to.have.length(1);
		expect(sendToCalls[0]).to.deep.include({ chatId: '765' });
	});

	it('opens menu on callback and executes actions', async () => {
		const sendToCalls = [];
		const sendTo = (_instance, _cmd, payload) => {
			sendToCalls.push(payload);
			if (payload?.editMessageText) {
				return Promise.resolve(null);
			}
			if (payload?.deleteMessage) {
				return Promise.resolve(null);
			}
			return Promise.resolve({ '765': 33 });
		};

		const getForeignState = id => {
			if (id === 'telegram.0.communicate.requestChatId') {
				return Promise.resolve({ val: '765' });
			}
			if (id === 'telegram.0.communicate.requestMessageId') {
				return Promise.resolve({ val: 33 });
			}
			return Promise.resolve({ val: '' });
		};
		const setState = () => Promise.resolve();
		const setObjectNotExists = () => Promise.resolve();
		const subscribeForeignStates = () => undefined;
		const unsubscribeForeignStates = () => undefined;

		const msg = {
			ref: 'm1',
			kind: 'task',
			level: MsgConstants.level.notice,
			title: 't',
			text: 'x',
			actions: [{ type: 'ack', id: 'ack' }],
		};
		const getMessageByRef = (_ref, _filter) => msg;
		const actionCalls = [];
		const actionExecute = opts => {
			actionCalls.push(opts);
			return true;
		};

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 50,
		});

		const { ctx, calls } = makeCtx({
			options,
			sendTo,
			getForeignState,
			setState,
			setObjectNotExists,
			subscribeForeignStates,
			unsubscribeForeignStates,
			actionExecute,
			getMessageByRef,
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		h.onNotifications(MsgConstants.notfication.events.due, [msg], ctx);
		await flush();
		await flush();

		const mappingSave = calls.setState.find(([id]) => id.endsWith('.mappingShortToRef'));
		expect(mappingSave).to.exist;
		const mappingShort = JSON.parse(mappingSave[1].val);
		const shortId = Object.keys(mappingShort)[0];

		h.onStateChange('telegram.0.communicate.request', { val: `[Ben]opt_${shortId}:menu` }, ctx);
		await flush();
		await flush();
		expect(sendToCalls.some(p => !!p?.editMessageText)).to.equal(true);

		sendToCalls.length = 0;
		h.onStateChange('telegram.0.communicate.request', { val: `[Ben]opt_${shortId}:act:ack` }, ctx);
		await flush();
		await flush();

		expect(actionCalls).to.have.length(1);
		expect(actionCalls[0]).to.deep.include({ ref: 'm1', actionId: 'ack' });
		expect(sendToCalls.some(p => !!p?.editMessageText)).to.equal(true);
	});

	it('handles /start', async () => {
		const sendToCalls = [];
		const sendTo = (_instance, _cmd, payload) => {
			sendToCalls.push(payload);
			return Promise.resolve(null);
		};

		const getForeignState = id => {
			if (id === 'telegram.0.communicate.requestChatId') {
				return Promise.resolve({ val: '765' });
			}
			if (id === 'telegram.0.communicate.requestMessageId') {
				return Promise.resolve({ val: 33 });
			}
			return Promise.resolve({ val: '' });
		};
		const setState = () => Promise.resolve();
		const setObjectNotExists = () => Promise.resolve();
		const subscribeForeignStates = () => undefined;
		const unsubscribeForeignStates = () => undefined;
		const actionExecute = () => true;
		const getMessageByRef = () => null;

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 50,
		});

		const { ctx } = makeCtx({
			options,
			sendTo,
			getForeignState,
			setState,
			setObjectNotExists,
			subscribeForeignStates,
			unsubscribeForeignStates,
			actionExecute,
			getMessageByRef,
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		h.onStateChange('telegram.0.communicate.request', { val: '[Ben]/start' }, ctx);
		await flush();
		await flush();

		expect(sendToCalls).to.have.length(1);
		expect(sendToCalls[0]).to.deep.include({ chatId: '765' });
	});
});
