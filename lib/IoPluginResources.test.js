'use strict';

const { expect } = require('chai');
const { IoPluginResources } = require('./IoPluginResources');

describe('IoPluginResources timers', () => {
	it('clears tracked timers on dispose (and forgets manually cleared ones)', () => {
		const calls = [];
		let nextHandle = 1;
		const timers = {
			setTimeout: (_fn, ms) => {
				const h = nextHandle++;
				calls.push(['setTimeout', h, ms]);
				return h;
			},
			clearTimeout: h => calls.push(['clearTimeout', h]),
			setInterval: (_fn, ms) => {
				const h = nextHandle++;
				calls.push(['setInterval', h, ms]);
				return h;
			},
			clearInterval: h => calls.push(['clearInterval', h]),
		};

		const resources = new IoPluginResources({ regId: 'Test:0', timers, log: { warn: () => {} } });

		const timeout = resources.setTimeout(() => {}, 10);
		const interval = resources.setInterval(() => {}, 20);
		resources.clearTimeout(timeout);

		resources.disposeAll();

		expect(calls).to.deep.equal([
			['setTimeout', 1, 10],
			['setInterval', 2, 20],
			['clearTimeout', 1],
			['clearInterval', 2],
		]);
	});
});

describe('IoPluginResources subscriptions', () => {
	it('tracks subscribe/unsubscribe pairs and forgets when manually unsubscribed', () => {
		const calls = [];
		const subscribeApi = {
			subscribeStates: pattern => calls.push(['subscribeStates', pattern]),
			unsubscribeStates: pattern => calls.push(['unsubscribeStates', pattern]),
		};

		const resources = new IoPluginResources({ regId: 'Test:0', log: { warn: () => {} } });
		const wrapped = resources.wrapSubscribeApi(subscribeApi);

		wrapped.subscribeStates('demo.0.x');
		wrapped.unsubscribeStates('demo.0.x');
		resources.disposeAll();

		expect(calls).to.deep.equal([
			['subscribeStates', 'demo.0.x'],
			['unsubscribeStates', 'demo.0.x'],
		]);
	});

	it('unsubscribes tracked subscriptions on dispose', () => {
		const calls = [];
		const subscribeApi = {
			subscribeStates: pattern => calls.push(['subscribeStates', pattern]),
			unsubscribeStates: pattern => calls.push(['unsubscribeStates', pattern]),
		};

		const resources = new IoPluginResources({ regId: 'Test:0', log: { warn: () => {} } });
		const wrapped = resources.wrapSubscribeApi(subscribeApi);

		wrapped.subscribeStates('demo.0.x');
		resources.disposeAll();

		expect(calls).to.deep.equal([
			['subscribeStates', 'demo.0.x'],
			['unsubscribeStates', 'demo.0.x'],
		]);
	});
});

