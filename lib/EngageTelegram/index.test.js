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
	it('sends notifications and clears old buttons for same ref', async () => {
		const sendTo = (_instance, _cmd, payload) => {
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
			deleteOldNotificationOnResend: false,
			kindsCsv: '',
			lifecycleStatesCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 30,
			iconNone: '',
			iconNotice: '',
			iconWarning: 'w',
			iconError: '',
			iconTask: '',
			iconStatus: '',
			iconAppointment: '',
			iconShoppinglist: '',
			iconInventorylist: '',
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 30,
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
			'updated',
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

		// `updated` should not send (Pushover-like due-only behavior)
		expect(calls.sendTo).to.have.length(0);

		h.onNotifications(
			'due',
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

		h.onNotifications(
			'due',
			[
				{
					ref: 'm1',
					kind: 'task',
					level: MsgConstants.level.warning,
					title: 'Hello3',
					text: 'World3',
					actions: [{ type: 'ack', id: 'ack' }],
				},
			],
			ctx,
		);

		await flush();
		await flush();

		const sends = calls.sendTo.filter(([_inst, _cmd, p]) => !p.editMessageText);
		const edits = calls.sendTo.filter(([_inst, _cmd, p]) => !!p.editMessageText);

		expect(sends).to.have.length(2);
		expect(edits.length).to.be.greaterThan(0);
	});

	it('deletes old telegram message on resend when enabled', async () => {
		const calls = { sendPayloads: [] };
		const sendTo = (_instance, _cmd, payload) => {
			calls.sendPayloads.push(payload);
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
			deleteOldNotificationOnResend: true,
			kindsCsv: '',
			lifecycleStatesCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 30,
			iconNone: '',
			iconNotice: '',
			iconWarning: 'w',
			iconError: '',
			iconTask: '',
			iconStatus: '',
			iconAppointment: '',
			iconShoppinglist: '',
			iconInventorylist: '',
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 30,
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
			'due',
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

		h.onNotifications(
			'due',
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

		const deletes = calls.sendPayloads.filter(p => !!p?.deleteMessage);
		expect(deletes).to.have.length(1);
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
			lifecycleStatesCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 30,
			iconNone: '',
			iconNotice: 'n',
			iconWarning: 'w',
			iconError: '',
			iconTask: '',
			iconStatus: '',
			iconAppointment: '',
			iconShoppinglist: '',
			iconInventorylist: '',
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 30,
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
			'due',
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

	it('executes action callback and edits all mapped messages', async () => {
		const sendToCalls = [];
		const sendTo = (_instance, _cmd, payload) => {
			sendToCalls.push(payload);
			if (payload?.editMessageText) {
				return Promise.resolve(null);
			}
			return Promise.resolve({ '765': 33, '999': 34 });
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
		const getMessageByRef = () => msg;
		const actionExecute = () => true;

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			lifecycleStatesCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 30,
			iconNone: '',
			iconNotice: '',
			iconWarning: '',
			iconError: '',
			iconTask: '',
			iconStatus: '',
			iconAppointment: '',
			iconShoppinglist: '',
			iconInventorylist: '',
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 30,
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
			i18nT: (k, ...args) => (args.length > 0 ? `${k}`.replace('%s', args[0]) : k),
		});

		const h = EngageTelegram({ pluginBaseObjectId: 'msghub.0.EngageTelegram.0' });
		await h.start(ctx);

		h.onNotifications('due', [msg], ctx);
		await flush();
		await flush();

		const mappingSave = calls.setState.find(([id]) => id.endsWith('.mappingShortToRef'));
		expect(mappingSave).to.exist;
		const mappingShort = JSON.parse(mappingSave[1].val);
		const shortId = Object.keys(mappingShort)[0];

		h.onStateChange(
			'telegram.0.communicate.request',
			{ val: `[Ben]opt_${shortId}:ack` },
			ctx,
		);

		await flush();
		await flush();

		expect(calls.actionExecute).to.have.length(1);
		expect(calls.actionExecute[0]).to.deep.include({ ref: 'm1', actionId: 'ack' });

		const editPayloads = sendToCalls.filter(p => p?.editMessageText);
		expect(editPayloads).to.have.length(2);
	});

	it('renders exactly three snooze buttons and uses snoozeForMs override', async () => {
		const sendToCalls = [];
		const sendTo = (_instance, _cmd, payload) => {
			sendToCalls.push(payload);
			if (payload?.editMessageText) {
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
			actions: [
				{ type: 'snooze', id: 'snooze-4h', payload: { snooze: { forMs: 4 * 60 * 60 * 1000 } } },
				{ type: 'ack', id: 'ack' },
			],
		};
		const getMessageByRef = () => msg;
		const actionCalls = [];
		const actionExecute = opts => {
			actionCalls.push(opts);
			return true;
		};

		const options = makeOptionsResolver({
			telegramInstance: 'telegram.0',
			kindsCsv: '',
			lifecycleStatesCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 30,
			iconNone: '',
			iconNotice: '',
			iconWarning: '',
			iconError: '',
			iconTask: '',
			iconStatus: '',
			iconAppointment: '',
			iconShoppinglist: '',
			iconInventorylist: '',
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 30,
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

		h.onNotifications('due', [msg], ctx);
		await flush();
		await flush();

		const sent = sendToCalls.find(p => !p?.editMessageText);
		expect(sent).to.exist;
		expect(sent.reply_markup).to.be.an('object');
		expect(sent.reply_markup.inline_keyboard).to.be.an('array');
		expect(sent.reply_markup.inline_keyboard[1]).to.be.an('array');
		expect(sent.reply_markup.inline_keyboard[1]).to.have.length(3);

		const cb = sent.reply_markup.inline_keyboard[1].map(b => b.callback_data);
		expect(cb[0]).to.match(/:snooze-4h:3600000$/);
		expect(cb[1]).to.match(/:snooze-4h:14400000$/);
		expect(cb[2]).to.match(/:snooze-4h:28800000$/);

		const mappingSave = calls.setState.find(([id]) => id.endsWith('.mappingShortToRef'));
		expect(mappingSave).to.exist;
		const mappingShort = JSON.parse(mappingSave[1].val);
		const shortId = Object.keys(mappingShort)[0];

		h.onStateChange('telegram.0.communicate.request', { val: `[Ben]opt_${shortId}:snooze-4h:3600000` }, ctx);
		await flush();
		await flush();

		expect(actionCalls).to.have.length(1);
		expect(actionCalls[0]).to.deep.include({ ref: 'm1', actionId: 'snooze-4h', snoozeForMs: 3600000 });
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
			lifecycleStatesCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 30,
			iconNone: '',
			iconNotice: '',
			iconWarning: '',
			iconError: '',
			iconTask: '',
			iconStatus: '',
			iconAppointment: '',
			iconShoppinglist: '',
			iconInventorylist: '',
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 30,
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
			lifecycleStatesCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 30,
			iconNone: '',
			iconNotice: '',
			iconWarning: '',
			iconError: '',
			iconTask: '',
			iconStatus: '',
			iconAppointment: '',
			iconShoppinglist: '',
			iconInventorylist: '',
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: 30,
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
