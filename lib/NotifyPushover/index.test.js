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

function makeCtx({ options, sendTo, getForeignState } = {}) {
	const { log } = makeLog();
	return {
		ctx: {
			api: {
				log,
				constants: MsgConstants,
				i18n: { t: key => (key === 'msghub.i18n.NotifyPushover.image.title.label' ? 'neues Foto' : key) },
				iobroker: {
					sendTo,
					states: { getForeignState },
				},
			},
			meta: { options },
		},
		log,
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
			lifecycleStatesCsv: '',
			audienceTagsAnyCsv: '',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: MsgConstants.level.error,
		});

		const { ctx } = makeCtx({ options, sendTo, getForeignState });
		const h = NotifyPushover();
		h.start(ctx);

		h.onNotifications(
			'due',
			[
				{
					ref: 'm1',
					kind: 'task',
					level: MsgConstants.level.warning,
					title: 'Hello',
					text: '<b>World</b>',
					display: { titleFullPrefix: 'w', textFullPrefix: 'w' },
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
		});

		const { ctx } = makeCtx({ options, sendTo, getForeignState });
		const h = NotifyPushover();
		h.start(ctx);

		h.onNotifications(
			'due',
			[
				{ ref: 'm1', kind: 'task', level: MsgConstants.level.warning, title: 'a', text: 'x', display: { titleFullPrefix: 'w', textFullPrefix: 'w' } },
				{ ref: 'm2', kind: 'task', level: MsgConstants.level.error, title: 'b', text: 'y', display: { titleFullPrefix: 'e', textFullPrefix: 'e' } },
			],
			ctx,
		);

		await flush();
		await flush();

		expect(calls.sendTo).to.have.length(1);
		expect(calls.sendTo[0][2].title).to.equal('e b');
	});

	it('applies kind/state/tag filters', async () => {
		const calls = { sendTo: [] };
		const sendTo = (instance, cmd, payload) => {
			calls.sendTo.push([instance, cmd, payload]);
			return Promise.resolve();
		};
		const getForeignState = () => Promise.resolve({ val: true });

		const options = makeOptionsResolver({
			pushoverInstance: 'pushover.0',
			kindsCsv: 'task',
			lifecycleStatesCsv: 'open',
			audienceTagsAnyCsv: 'me',
			levelMin: 0,
			levelMax: 50,
			gateStateId: '',
			gateOp: '',
			gateValue: '',
			gateBypassFromLevel: MsgConstants.level.error,
		});

		const { ctx } = makeCtx({ options, sendTo, getForeignState });
		const h = NotifyPushover();
		h.start(ctx);

		h.onNotifications(
			'due',
			[
				{ ref: 'm1', kind: 'status', level: MsgConstants.level.warning, title: 'a', text: 'x', lifecycle: { state: 'open' }, display: { titleFullPrefix: 'w', textFullPrefix: 'w' } },
				{ ref: 'm2', kind: 'task', level: MsgConstants.level.warning, title: 'b', text: 'y', lifecycle: { state: 'closed' }, display: { titleFullPrefix: 'w', textFullPrefix: 'w' } },
				{
					ref: 'm3',
					kind: 'task',
					level: MsgConstants.level.warning,
					title: 'c',
					text: 'z',
					display: { titleFullPrefix: 'w', textFullPrefix: 'w' },
					lifecycle: { state: 'open' },
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
});
