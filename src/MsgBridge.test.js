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
		MsgBridge.registerBridge({
			id: 'bridge:demo',
			msgIngest,
			msgNotify,
			ingest: () => undefined,
			notify: { onNotifications: () => undefined },
		});

		expect(calls.map(c => c[0])).to.deep.equal(['ingest.register', 'notify.register']);
	});

	it('rolls back ingest when notify registration fails', () => {
		const { calls, msgIngest, msgNotify } = makeHosts({ notifyRegisterThrows: true });
		const fn = () =>
			MsgBridge.registerBridge({
				id: 'bridge:demo',
				msgIngest,
				msgNotify,
				ingest: () => undefined,
				notify: { onNotifications: () => undefined },
			});
		expect(fn).to.throw(/notify failed/);
		expect(calls.map(c => c[0])).to.deep.equal(['ingest.register', 'notify.register', 'ingest.unregister']);
	});

	it('supports different ids for ingest and notify', () => {
		const { calls, msgIngest, msgNotify } = makeHosts();
		MsgBridge.registerBridge({
			ingestId: 'bridge:demo:in',
			notifyId: 'bridge:demo:out',
			msgIngest,
			msgNotify,
			ingest: () => undefined,
			notify: { onNotifications: () => undefined },
		});

		expect(calls[0][1]).to.equal('bridge:demo:in');
		expect(calls[1][1]).to.equal('bridge:demo:out');
	});
});
