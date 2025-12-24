'use strict';

const { expect } = require('chai');
const { MsgNotify } = require('./MsgNotify');
const { MsgConstants } = require('./MsgConstants');

function makeAdapter() {
	const logs = { info: [], warn: [], debug: [] };
	const adapter = {
		log: {
			info: msg => logs.info.push(msg),
			warn: msg => logs.warn.push(msg),
			debug: msg => logs.debug.push(msg),
		},
	};
	return { adapter, logs };
}

describe('MsgNotify', () => {
	describe('registerPlugin', () => {
		it('registers a function handler and dispatches', () => {
			const { adapter } = makeAdapter();
			const notify = new MsgNotify(adapter, MsgConstants);
			let receivedEvent = null;
			let received = null;
			let receivedCtx = null;
			notify.registerPlugin('fn', (event, notifications, ctx) => {
				receivedEvent = event;
				received = notifications;
				receivedCtx = ctx;
			});

			const msg = { ref: 'ref-1' };
			const ctx = { source: 'unit' };
			const count = notify.dispatch('due', msg, ctx);

			expect(count).to.equal(1);
			expect(receivedEvent).to.equal('due');
			expect(received).to.deep.equal([msg]);
			expect(receivedCtx).to.deep.equal(ctx);
		});

		it('registers an object handler with binding', () => {
			const { adapter } = makeAdapter();
			const notify = new MsgNotify(adapter, MsgConstants);
			const plugin = {
				calledWith: null,
				ctx: null,
				event: null,
				onNotifications(event, notifications, ctx) {
					this.event = event;
					this.calledWith = notifications;
					this.ctx = ctx;
				},
			};

			notify.registerPlugin('obj', plugin);
			const msg = { ref: 'ref-2' };
			const ctx = { actor: 'tester' };
			notify.dispatch('due', msg, ctx);

			expect(plugin.event).to.equal('due');
			expect(plugin.calledWith).to.deep.equal([msg]);
			expect(plugin.ctx).to.deep.equal(ctx);
		});

		it('rejects invalid id or handler', () => {
			const { adapter } = makeAdapter();
			const notify = new MsgNotify(adapter, MsgConstants);

			expect(() => notify.registerPlugin()).to.throw('MsgNotify.registerPlugin: id is required');
			expect(() => notify.registerPlugin(5, () => {})).to.throw('MsgNotify.registerPlugin: id is required');
			expect(() => notify.registerPlugin('bad', null)).to.throw(
				'MsgNotify.registerPlugin: handler must be a function or { onNotifications }',
			);
		});
	});

	describe('unregisterPlugin', () => {
		it('removes a registered plugin', () => {
			const { adapter } = makeAdapter();
			const notify = new MsgNotify(adapter, MsgConstants);
			let calls = 0;
			notify.registerPlugin('fn', (event, notifications) => {
				expect(event).to.equal('due');
				expect(notifications).to.have.length(1);
				calls += 1;
			});
			notify.unregisterPlugin('fn');
			const count = notify.dispatch('due', { ref: 'ref-3' });

			expect(count).to.equal(1);
			expect(calls).to.equal(0);
		});
	});

	describe('dispatch', () => {
		it('counts and dispatches only valid message objects', () => {
			const { adapter } = makeAdapter();
			const notify = new MsgNotify(adapter, MsgConstants);
			let calls = 0;
			notify.registerPlugin('fn', (event, notifications) => {
				expect(event).to.equal('due');
				expect(notifications).to.have.length(1);
				calls += 1;
			});

			const count = notify.dispatch('due', [null, { ref: 'a' }, 7, { ref: 'b' }]);

			expect(count).to.equal(2);
			expect(calls).to.equal(2);
		});

		it('rejects unknown events', () => {
			const { adapter } = makeAdapter();
			const notify = new MsgNotify(adapter, MsgConstants);
			notify.registerPlugin('fn', () => {});
			expect(() => notify.dispatch('unknown', { ref: 'x' })).to.throw('MsgNotify.dispatch: unsupported event');
		});
	});

	describe('_dispatch', () => {
		it('logs when no plugins are registered', () => {
			const { adapter, logs } = makeAdapter();
			const notify = new MsgNotify(adapter, MsgConstants);

			notify._dispatch('due', { ref: 'ref-4' });

			expect(logs.debug.length).to.equal(1);
			expect(logs.debug[0]).to.include('no plugins registered');
		});

		it('logs a warning when a plugin throws', () => {
			const { adapter, logs } = makeAdapter();
			const notify = new MsgNotify(adapter, MsgConstants);
			notify.registerPlugin('boom', () => {
				throw new Error('fail');
			});

			notify.dispatch('due', { ref: 'ref-5' });

			expect(logs.warn.length).to.equal(1);
			expect(logs.warn[0]).to.include("plugin 'boom' failed");
		});
	});
});
