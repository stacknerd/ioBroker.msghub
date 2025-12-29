'use strict';

const { expect } = require('chai');
const { MsgBridge } = require('./MsgBridge');

function makeHosts({ notifyRegisterThrows = false } = {}) {
	const calls = [];
	const msgIngest = {
		registerPlugin: (id, handler) => {
			calls.push(['ingest.register', id, typeof handler]);
		},
		unregisterPlugin: id => {
			calls.push(['ingest.unregister', id]);
		},
	};
	const msgNotify = {
		registerPlugin: (id, handler) => {
			calls.push(['notify.register', id, typeof handler]);
			if (notifyRegisterThrows) {
				throw new Error('notify failed');
			}
		},
		unregisterPlugin: id => {
			calls.push(['notify.unregister', id]);
		},
	};

	return { calls, msgIngest, msgNotify };
}

describe('MsgBridge', () => {
	it('registers both sides successfully', () => {
		const { calls, msgIngest, msgNotify } = makeHosts();
		MsgBridge.registerBridge(
			'bridge:demo',
			{
				start: () => undefined,
				onNotifications: () => undefined,
			},
			{ msgIngest, msgNotify },
		);

		expect(calls.map(c => c[0])).to.deep.equal(['ingest.register', 'notify.register']);
		expect(calls[0][1]).to.equal('bridge:demo.ingest');
		expect(calls[1][1]).to.equal('bridge:demo.notify');
	});

	it('rolls back ingest when notify registration fails', () => {
		const { calls, msgIngest, msgNotify } = makeHosts({ notifyRegisterThrows: true });
		const fn = () =>
			MsgBridge.registerBridge(
				'bridge:demo',
				{
					start: () => undefined,
					onNotifications: () => undefined,
				},
				{ msgIngest, msgNotify },
			);
		expect(fn).to.throw(/notify failed/);
		expect(calls.map(c => c[0])).to.deep.equal(['ingest.register', 'notify.register', 'ingest.unregister']);
		expect(calls[2][1]).to.equal('bridge:demo.ingest');
	});

	it('unregisters notify first and is idempotent', () => {
		const { calls, msgIngest, msgNotify } = makeHosts();
		const handle = MsgBridge.registerBridge(
			'bridge:demo',
			{
				start: () => undefined,
				onNotifications: () => undefined,
			},
			{ msgIngest, msgNotify },
		);

		handle.unregister();
		handle.unregister();

		expect(calls.map(c => c[0])).to.deep.equal([
			'ingest.register',
			'notify.register',
			'notify.unregister',
			'ingest.unregister',
		]);
	});
});
