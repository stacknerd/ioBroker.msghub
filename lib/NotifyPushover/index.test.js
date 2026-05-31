'use strict';

const { expect } = require('chai');

const { NotifyPushover } = require('./index');
const { MsgConstants } = require('../../src/MsgConstants');

const flush = () => new Promise(resolve => setImmediate(resolve));

function makeLog() {
	const calls = { info: [], warn: [] };
	return {
		calls,
		log: {
			info: msg => calls.info.push(msg),
			warn: msg => calls.warn.push(msg),
		},
	};
}

function makeOptionsResolver(values) {
	const get = (key, fallback) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback);
	return {
		resolveString: (key, fallback) => String(get(key, fallback) ?? ''),
		resolveInt: (key, fallback) => Number(get(key, fallback)),
	};
}

function makeCtx({ options, sendTo, getForeignState, templates, gates, states } = {}) {
	const { log } = makeLog();
	const stateMap = states || new Map();
	const objectCalls = [];
	const setStateCalls = [];
	return {
		ctx: {
			api: {
				log,
				constants: MsgConstants,
				i18n: { t: key => (key === 'msghub.i18n.NotifyPushover.image.title.label' ? 'neues Foto' : key) },
				iobroker: {
					sendTo,
					objects: {
						setObjectNotExists: (id, obj) => {
							objectCalls.push([id, obj]);
							return Promise.resolve();
						},
					},
					states: {
						getForeignState: id => {
							if (stateMap.has(id)) {
								return Promise.resolve({ val: stateMap.get(id) });
							}
							return getForeignState ? getForeignState(id) : Promise.resolve({ val: '' });
						},
						setState: (id, state) => {
							setStateCalls.push([id, state]);
							stateMap.set(id, String(state?.val || ''));
							return Promise.resolve();
						},
					},
				},
				templates: templates || { renderStates: async text => text },
			},
			meta: { options, gates: gates || { register: () => null } },
		},
		log,
		states: stateMap,
		objectCalls,
		setStateCalls,
	};
}

describe('NotifyPushover', () => {
	it('sends due notifications and strips HTML', async () => {
		const calls = { sendTo: [] };
		const sendTo = (instance, cmd, payload) => {
			calls.sendTo.push([instance, cmd, payload]);
			return Promise.resolve();
		};
		const getForeignState = () => Promise.resolve({ val: true });

		const options = makeOptionsResolver({
			pushoverInstance: 'pushover.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: MsgConstants.level.error,
			gateCheckinText: '',
			gateCheckoutText: '',
		});

		const { ctx } = makeCtx({ options, sendTo, getForeignState });
		const h = NotifyPushover({ pluginBaseObjectId: 'msghub.0.NotifyPushover.0' });
		await h.start(ctx);

		h.onNotifications(
			'due',
			[
				{
					ref: 'm1',
					kind: 'task',
					level: MsgConstants.level.warning,
					title: 'Hello',
					text: '<b>World</b>',
					display: { title: 'w Hello', text: 'World' },
					attachments: [
						{ type: 'image', value: '/tmp/x.jpg' },
						{ type: 'image', value: 'https://example.invalid/x.jpg' },
					],
				},
			],
			ctx,
		);

		await flush();
		await flush();

		expect(calls.sendTo).to.have.length(2);
		expect(calls.sendTo[0][0]).to.equal('pushover.0');
		expect(calls.sendTo[0][1]).to.equal('send');
		expect(calls.sendTo[0][2]).to.deep.include({ message: 'World' });
		expect(calls.sendTo[0][2].title).to.equal('w Hello');
		expect(calls.sendTo[0][2]).to.deep.include({ priority: 0 });

		expect(calls.sendTo[1][2]).to.deep.include({ message: '📷', title: 'neues Foto', file: '/tmp/x.jpg' });
	});

	it('respects gate and bypass-from-level', async () => {
		const calls = { sendTo: [] };
		const sendTo = (instance, cmd, payload) => {
			calls.sendTo.push([instance, cmd, payload]);
			return Promise.resolve();
		};
		const getForeignState = () => Promise.resolve({ val: false });

		const options = makeOptionsResolver({
			pushoverInstance: 'pushover.0',
			levelMin: 0,
			levelMax: 50,
			gateStateId: 'gate.0.enabled',
			gateOp: 'true',
			gateValue: '',
			gateBypassFromLevel: MsgConstants.level.error,
			gateCheckinText: '',
			gateCheckoutText: '',
		});

		const registerCalls = [];
		const gates = {
			register: opts => {
				registerCalls.push(opts);
				return { dispose() {} };
			},
		};

		const { ctx } = makeCtx({ options, sendTo, getForeignState, gates });
		const h = NotifyPushover({ pluginBaseObjectId: 'msghub.0.NotifyPushover.0' });
		await h.start(ctx);

		await registerCalls[0].onChange({ open: false, prevOpen: true });

		h.onNotifications(
			'due',
			[
				{
					ref: 'm1',
					kind: 'task',
					level: MsgConstants.level.warning,
					title: 'a',
					text: 'x',
					display: { title: 'w a', text: 'x' },
				},
				{
					ref: 'm2',
					kind: 'task',
					level: MsgConstants.level.error,
					title: 'b',
					text: 'y',
					display: { title: 'e b', text: 'y' },
				},
			],
			ctx,
		);

		await flush();
		await flush();

		expect(calls.sendTo).to.have.length(1);
		expect(calls.sendTo[0][2].title).to.equal('e b');
	});

	it('applies kind/tag filters', async () => {
		const calls = { sendTo: [] };
		const sendTo = (instance, cmd, payload) => {
			calls.sendTo.push([instance, cmd, payload]);
			return Promise.resolve();
		};
		const getForeignState = () => Promise.resolve({ val: true });

		const options = makeOptionsResolver({
			pushoverInstance: 'pushover.0',
			kindsCsv: 'task',
			audienceTagsAnyCsv: 'me',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: MsgConstants.level.error,
			gateCheckinText: '',
			gateCheckoutText: '',
		});

		const { ctx } = makeCtx({ options, sendTo, getForeignState });
		const h = NotifyPushover({ pluginBaseObjectId: 'msghub.0.NotifyPushover.0' });
		await h.start(ctx);

		h.onNotifications(
			'due',
			[
				{
					ref: 'm1',
					kind: 'status',
					level: MsgConstants.level.warning,
					title: 'a',
					text: 'x',
					display: { title: 'w a', text: 'x' },
				},
				{
					ref: 'm2',
					kind: 'task',
					level: MsgConstants.level.warning,
					title: 'b',
					text: 'y',
					audience: { tags: ['other'] },
					display: { title: 'w b', text: 'y' },
				},
				{
					ref: 'm3',
					kind: 'task',
					level: MsgConstants.level.warning,
					title: 'c',
					text: 'z',
					display: { title: 'w c', text: 'z' },
					audience: { tags: ['me', 'other'] },
				},
			],
			ctx,
		);

		await flush();
		await flush();

		expect(calls.sendTo).to.have.length(1);
		expect(calls.sendTo[0][2].title).to.equal('w c');
	});

	it('sends gate check-in/check-out notifications with templates', async () => {
		const calls = { sendTo: [] };
		const sendTo = (instance, cmd, payload) => {
			calls.sendTo.push([instance, cmd, payload]);
			return Promise.resolve();
		};
		const getForeignState = () => Promise.resolve({ val: true });

		const options = makeOptionsResolver({
			pushoverInstance: 'pushover.0',
			levelMin: 0,
			levelMax: 50,
			gateStateId: 'gate.0.enabled',
			gateOp: 'true',
			gateValue: '',
			gateBypassFromLevel: MsgConstants.level.error,
			gateCheckinText: 'open {x.0.val}',
			gateCheckoutText: 'closed {x.0.val}',
		});

		const registerCalls = [];
		const gates = {
			register: opts => {
				registerCalls.push(opts);
				return { dispose() {} };
			},
		};

		const templates = {
			renderStates: async text => text.replace('{x.0.val}', '1'),
		};

		const { ctx } = makeCtx({ options, sendTo, getForeignState, templates, gates });
		const h = NotifyPushover({ pluginBaseObjectId: 'msghub.0.NotifyPushover.0' });
		await h.start(ctx);

		await registerCalls[0].onChange({ open: true, prevOpen: false });
		await registerCalls[0].onOpen({ prevOpen: false });
		await registerCalls[0].onChange({ open: false, prevOpen: true });
		await registerCalls[0].onClose({ prevOpen: true });

		expect(calls.sendTo).to.have.length(2);
		expect(calls.sendTo[0][2]).to.deep.include({ message: 'open 1', priority: 0, sound: 'magic' });
		expect(calls.sendTo[1][2]).to.deep.include({ message: 'closed 1', priority: 0, sound: 'magic' });
	});

	it('sends only new image attachments on updated notifications', async () => {
		const calls = { sendTo: [] };
		const sendTo = (instance, cmd, payload) => {
			calls.sendTo.push([instance, cmd, payload]);
			return Promise.resolve();
		};

		const options = makeOptionsResolver({
			pushoverInstance: 'pushover.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: MsgConstants.level.error,
			gateCheckinText: '',
			gateCheckoutText: '',
		});

		const { ctx } = makeCtx({ options, sendTo });
		const h = NotifyPushover({ pluginBaseObjectId: 'msghub.0.NotifyPushover.0' });
		await h.start(ctx);

		const msg = {
			ref: 'doorbell',
			kind: 'task',
			level: MsgConstants.level.warning,
			title: 'Doorbell',
			text: 'ring',
			attachments: [{ type: 'image', value: '/tmp/cam1.jpg' }],
		};

		h.onNotifications(MsgConstants.notfication.events.due, [msg], ctx);
		await flush();
		await flush();
		await flush();

		expect(calls.sendTo.map(call => call[2])).to.deep.include({
			message: '📷',
			priority: -1,
			title: 'neues Foto',
			file: '/tmp/cam1.jpg',
		});

		calls.sendTo.length = 0;
		h.onNotifications(
			MsgConstants.notfication.events.update,
			[
				{
					...msg,
					attachments: [
						{ type: 'image', value: '/tmp/cam1.jpg' },
						{ type: 'image', value: '/tmp/cam2.jpg' },
						{ type: 'image', value: 'https://example.invalid/cam3.jpg' },
					],
				},
			],
			ctx,
		);
		await flush();
		await flush();
		await flush();

		expect(calls.sendTo).to.have.length(1);
		expect(calls.sendTo[0][2]).to.deep.include({ message: '📷', file: '/tmp/cam2.jpg' });
	});

	it('resets image delivery receipts on a new due notification for the same ref', async () => {
		const calls = { sendTo: [] };
		const sendTo = (instance, cmd, payload) => {
			calls.sendTo.push([instance, cmd, payload]);
			return Promise.resolve();
		};

		const options = makeOptionsResolver({
			pushoverInstance: 'pushover.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: MsgConstants.level.error,
			gateCheckinText: '',
			gateCheckoutText: '',
		});

		const { ctx } = makeCtx({ options, sendTo });
		const h = NotifyPushover({ pluginBaseObjectId: 'msghub.0.NotifyPushover.0' });
		await h.start(ctx);

		const msg = {
			ref: 'doorbell',
			kind: 'task',
			level: MsgConstants.level.warning,
			title: 'Doorbell',
			text: 'ring',
			attachments: [{ type: 'image', value: '/tmp/Bild1.jpeg' }],
		};

		h.onNotifications(MsgConstants.notfication.events.due, [msg], ctx);
		await flush();
		await flush();
		await flush();

		calls.sendTo.length = 0;
		h.onNotifications(MsgConstants.notfication.events.due, [msg], ctx);
		await flush();
		await flush();
		await flush();

		const imageSends = calls.sendTo.filter(call => call[2]?.file === '/tmp/Bild1.jpeg');
		expect(imageSends).to.have.length(1);
		expect(calls.sendTo.some(call => call[2]?.message === 'ring')).to.equal(true);
	});

	it('cleans delivery receipts on deleted and expired notifications', async () => {
		const calls = { sendTo: [] };
		const sendTo = (instance, cmd, payload) => {
			calls.sendTo.push([instance, cmd, payload]);
			return Promise.resolve();
		};

		const options = makeOptionsResolver({
			pushoverInstance: 'pushover.0',
			kindsCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: MsgConstants.level.error,
			gateCheckinText: '',
			gateCheckoutText: '',
		});

		const { ctx, states } = makeCtx({ options, sendTo });
		const h = NotifyPushover({ pluginBaseObjectId: 'msghub.0.NotifyPushover.0' });
		await h.start(ctx);

		const msg = {
			ref: 'doorbell',
			kind: 'task',
			level: MsgConstants.level.warning,
			title: 'Doorbell',
			text: 'ring',
			attachments: [{ type: 'image', value: '/tmp/cam1.jpg' }],
		};

		h.onNotifications(MsgConstants.notfication.events.due, [msg], ctx);
		await flush();
		await flush();
		await flush();

		h.onNotifications(MsgConstants.notfication.events.deleted, [{ ref: 'doorbell' }], ctx);
		await flush();
		await flush();

		let persisted = JSON.parse(states.get('msghub.0.NotifyPushover.0.deliveryByRef') || '{}');
		expect(persisted).to.not.have.property('doorbell');

		h.onNotifications(MsgConstants.notfication.events.due, [msg], ctx);
		await flush();
		await flush();
		await flush();

		h.onNotifications(MsgConstants.notfication.events.expired, [{ ref: 'doorbell' }], ctx);
		await flush();
		await flush();

		persisted = JSON.parse(states.get('msghub.0.NotifyPushover.0.deliveryByRef') || '{}');
		expect(persisted).to.not.have.property('doorbell');
	});
});
