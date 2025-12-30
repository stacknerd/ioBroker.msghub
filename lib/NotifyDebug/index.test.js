'use strict';

const { expect } = require('chai');

const { NotifyDebug } = require('./index');
const { MsgNotify } = require(`${__dirname}/../../src/MsgNotify`);
const { MsgConstants } = require(`${__dirname}/../../src/MsgConstants`);

function createAdapterMock({ namespace = 'msghub.0' } = {}) {
	const debug = [];
	const info = [];
	const warn = [];
	const error = [];

	return {
		namespace,
		log: {
			debug: message => debug.push(message),
			info: message => info.push(message),
			warn: message => warn.push(message),
			error: message => error.push(message),
		},
		i18n: {
			t: text => `T(${text})`,
			getTranslatedObject: () => null,
		},
		_logs: { debug, info, warn, error },
	};
}

describe('NotifyDebug', () => {
	it('logs start/stop when trace=true', () => {
		const adapter = createAdapterMock();
		const msgNotify = new MsgNotify(adapter, MsgConstants);

		const handler = NotifyDebug({
			trace: true,
			someText: 'hello',
			pluginBaseObjectId: 'msghub.0.NotifyDebug.0',
		});

		msgNotify.registerPlugin('NotifyDebug:0', handler);

		expect(adapter._logs.debug.some(m => m.includes('NotifyDebug: start'))).to.equal(true);
		expect(adapter._logs.debug.some(m => m.includes("someText='hello'"))).to.equal(true);
		expect(adapter._logs.debug.some(m => m.includes('ctx.api.constants.kind='))).to.equal(true);
		expect(adapter._logs.debug.some(m => m.includes("i18n='T(this is translated by ctx.api.i18n.t())'"))).to.equal(true);
		expect(adapter._logs.debug.some(m => m.includes('ctx.api.iobroker.ids='))).to.equal(true);
		expect(adapter._logs.debug.some(m => m.includes("pluginBaseObjectId(full)='msghub.0.NotifyDebug.0'"))).to.equal(true);

		msgNotify.unregisterPlugin('NotifyDebug:0');
		expect(adapter._logs.debug.some(m => m.includes('NotifyDebug: stop'))).to.equal(true);
	});

	it('does not log when trace=false', () => {
		const adapter = createAdapterMock();
		const msgNotify = new MsgNotify(adapter, MsgConstants);

		const handler = NotifyDebug({
			trace: false,
			pluginBaseObjectId: 'msghub.0.NotifyDebug.0',
		});

		msgNotify.registerPlugin('NotifyDebug:0', handler);
		expect(adapter._logs.debug.length).to.equal(0);
	});

	it('stops previous plugin on overwrite', () => {
		const adapter = createAdapterMock();
		const msgNotify = new MsgNotify(adapter, MsgConstants);

		msgNotify.registerPlugin(
			'NotifyDebug:0',
			NotifyDebug({ trace: true, pluginBaseObjectId: 'msghub.0.NotifyDebug.0' }),
		);

		adapter._logs.debug.splice(0);

		msgNotify.registerPlugin(
			'NotifyDebug:0',
			NotifyDebug({ trace: true, pluginBaseObjectId: 'msghub.0.NotifyDebug.0' }),
		);

		expect(adapter._logs.debug.some(m => m.includes('NotifyDebug: stop'))).to.equal(true);
		expect(adapter._logs.debug.some(m => m.includes('NotifyDebug: start'))).to.equal(true);
	});

	it('dispatch calls notifier handler', () => {
		const adapter = createAdapterMock();
		const msgNotify = new MsgNotify(adapter, MsgConstants);

		msgNotify.registerPlugin(
			'NotifyDebug:0',
			NotifyDebug({ trace: true, pluginBaseObjectId: 'msghub.0.NotifyDebug.0' }),
		);

			adapter._logs.debug.splice(0);

			msgNotify.dispatch(MsgConstants.notfication.events.due, { ref: 'x' });
			expect(adapter._logs.debug.some(m => m.includes("NotifyDebug: 'x' due:"))).to.equal(true);
		});

	it('supports function handlers', () => {
		const adapter = createAdapterMock();
		const msgNotify = new MsgNotify(adapter, MsgConstants);

		let called = false;
		msgNotify.registerPlugin('fn', (event, notifications) => {
			called = event === MsgConstants.notfication.events.due && Array.isArray(notifications) && notifications.length === 1;
		});

		msgNotify.dispatch(MsgConstants.notfication.events.due, { ref: 'x' });
		expect(called).to.equal(true);
	});
});
