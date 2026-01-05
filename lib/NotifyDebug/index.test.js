'use strict';

const { expect } = require('chai');

const { NotifyDebug } = require('./index');
const { MsgConstants } = require('../../src/MsgConstants');

function makeCtx({ trace = true } = {}) {
	const calls = { debug: [], info: [] };
	const ctx = {
		api: {
			log: {
				debug: msg => calls.debug.push(msg),
				info: msg => calls.info.push(msg),
			},
			i18n: { t: s => `t(${s})` },
			constants: MsgConstants,
		},
		meta: {
			plugin: { regId: 'NotifyDebug:0', baseFullId: 'msghub.0.NotifyDebug.0', baseOwnId: 'NotifyDebug.0' },
		},
	};
	return { ctx, calls, trace };
}

describe('NotifyDebug', () => {
	it('is a no-op when trace is false', () => {
		const h = NotifyDebug({ trace: false, someText: 'x' });
		expect(() => h.start({})).to.not.throw();
		expect(() => h.stop({})).to.not.throw();
		expect(() => h.onNotifications('due', [{ ref: 'm1' }], {})).to.not.throw();
	});

	it('logs debug/info when trace is enabled', () => {
		const { ctx, calls } = makeCtx();
		const h = NotifyDebug({ trace: true, someText: 'hello' });

		h.start(ctx);
		expect(calls.debug.join('\n')).to.include('NotifyDebug: start');
		expect(calls.debug.join('\n')).to.include('NotifyDebug: options=');
		expect(calls.debug.join('\n')).to.include("NotifyDebug: someText='hello'");
		expect(calls.debug.join('\n')).to.include('NotifyDebug: i18n=');
		expect(calls.debug.join('\n')).to.include("NotifyDebug: plugin regId='NotifyDebug:0'");

		h.onNotifications('due', [{ ref: 'm1', title: 't', text: 'x' }], ctx);
		expect(calls.info[0]).to.match(/NotifyDebug: 'm1' due:/);

		h.stop(ctx);
		expect(calls.debug.join('\n')).to.include('NotifyDebug: stop');
	});
});

