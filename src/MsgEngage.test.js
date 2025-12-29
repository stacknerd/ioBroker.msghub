'use strict';

const { expect } = require('chai');
const { MsgEngage } = require('./MsgEngage');
const { MsgConstants } = require('./MsgConstants');

function makeAdapter() {
	const logs = { warn: [], info: [] };
	const adapter = {
		log: {
			info: msg => logs.info.push(msg),
			warn: msg => logs.warn.push(msg),
		},
	};
	return { adapter, logs };
}

function makeHosts() {
	const calls = [];
	let ingestHandler = null;
	let notifyHandler = null;

	const msgIngest = {
		registerPlugin: (id, handler) => {
			calls.push(['ingest.register', id]);
			ingestHandler = handler;
		},
		unregisterPlugin: id => {
			calls.push(['ingest.unregister', id]);
		},
	};

	const msgNotify = {
		registerPlugin: (id, handler) => {
			calls.push(['notify.register', id]);
			notifyHandler = handler;
		},
		unregisterPlugin: id => {
			calls.push(['notify.unregister', id]);
		},
	};

	return { calls, msgIngest, msgNotify, getHandlers: () => ({ ingestHandler, notifyHandler }) };
}

describe('MsgEngage', () => {
	it('registers ingest+notify and decorates ctx.api.action', () => {
		const { adapter } = makeAdapter();
		const { calls, msgIngest, msgNotify, getHandlers } = makeHosts();

		const storeCalls = { updateMessage: [] };
		const message = {
			ref: 'm1',
			actions: [{ id: 'ack-1', type: MsgConstants.actions.type.ack }],
			lifecycle: { state: MsgConstants.lifecycle.state.open },
			timing: { notifyAt: Date.now() + 60_000 },
		};
		const store = {
			getMessageByRef: ref => (ref === 'm1' ? message : undefined),
			updateMessage: (ref, patch) => {
				storeCalls.updateMessage.push([ref, patch]);
				return true;
			},
		};

		const handler = {
			start(ctx) {
				expect(ctx.api).to.have.property('action');
				expect(ctx.api.action).to.have.property('execute');
				const ok = ctx.api.action.execute({ ref: 'm1', actionId: 'ack-1', actor: 'engage:test' });
				expect(ok).to.equal(true);
			},
			onNotifications(event, notifications, ctx) {
				expect(event).to.equal('due');
				expect(notifications).to.have.length(1);
				expect(ctx.api).to.have.property('action');
			},
		};

		MsgEngage.registerEngage(
			'EngageDemo:0',
			handler,
			{ msgIngest, msgNotify, adapter, msgConstants: MsgConstants, store },
		);

		expect(calls.map(c => c[0])).to.deep.equal(['ingest.register', 'notify.register']);
		expect(calls[0][1]).to.equal('EngageDemo:0.ingest');
		expect(calls[1][1]).to.equal('EngageDemo:0.notify');

		const { ingestHandler, notifyHandler } = getHandlers();
		expect(ingestHandler).to.be.an('object');
		expect(notifyHandler).to.be.an('object');

		ingestHandler.start({ api: Object.freeze({ constants: MsgConstants }), meta: {} });
		notifyHandler.onNotifications('due', [{ ref: 'm1' }], { api: Object.freeze({ constants: MsgConstants }), meta: {} });

		expect(storeCalls.updateMessage).to.have.length(1);
		expect(storeCalls.updateMessage[0][0]).to.equal('m1');
		expect(storeCalls.updateMessage[0][1]).to.have.nested.property('lifecycle.state', MsgConstants.lifecycle.state.acked);
	});
});

