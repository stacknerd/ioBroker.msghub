'use strict';

const { expect } = require('chai');
const { MsgIngest } = require('./MsgIngest');
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

function makeDeps() {
	const calls = {
		addMessage: [],
		updateMessage: [],
		addOrUpdateMessage: [],
		removeMessage: [],
		getMessageByRef: [],
		getMessages: [],
		createMessage: [],
	};

	const msgStore = {
		addMessage: msg => {
			calls.addMessage.push([msg]);
			return { ok: true, op: 'addMessage' };
		},
		updateMessage: (msgOrRef, patch) => {
			calls.updateMessage.push([msgOrRef, patch]);
			return { ok: true, op: 'updateMessage' };
		},
		addOrUpdateMessage: msg => {
			calls.addOrUpdateMessage.push([msg]);
			return { ok: true, op: 'addOrUpdateMessage' };
		},
		removeMessage: ref => {
			calls.removeMessage.push([ref]);
			return { ok: true, op: 'removeMessage' };
		},
		getMessageByRef: ref => {
			calls.getMessageByRef.push([ref]);
			return { ok: true, op: 'getMessageByRef', ref };
		},
		getMessages: () => {
			calls.getMessages.push([]);
			return [{ ref: 'm1' }];
		},
	};

	const msgFactory = {
		createMessage: data => {
			calls.createMessage.push([data]);
			return { ref: 'created', ...data };
		},
	};

	return { msgFactory, msgStore, calls };
}

describe('MsgIngest', () => {
	describe('constructor', () => {
		it('requires all dependencies', () => {
			const { adapter } = makeAdapter();
			const { msgFactory, msgStore } = makeDeps();

			expect(() => new MsgIngest()).to.throw('MsgIngest: adapter is required');
			expect(() => new MsgIngest(adapter)).to.throw('MsgIngest: msgConstants is required');
			expect(() => new MsgIngest(adapter, MsgConstants)).to.throw('MsgIngest: msgFactory is required');
			expect(() => new MsgIngest(adapter, MsgConstants, msgFactory)).to.throw('MsgIngest: msgStore is required');
			expect(() => new MsgIngest(adapter, MsgConstants, msgFactory, msgStore)).to.not.throw();
		});
	});

	describe('registerPlugin', () => {
		it('rejects invalid id or handler', () => {
			const { adapter } = makeAdapter();
			const { msgFactory, msgStore } = makeDeps();
			const ingest = new MsgIngest(adapter, MsgConstants, msgFactory, msgStore);

			expect(() => ingest.registerPlugin()).to.throw('MsgIngest.registerPlugin: id is required');
			expect(() => ingest.registerPlugin(5, () => {})).to.throw('MsgIngest.registerPlugin: id is required');
			expect(() => ingest.registerPlugin('x')).to.throw('MsgIngest.registerPlugin: handler is required');
			expect(() => ingest.registerPlugin('x', { nope: true })).to.throw(
				'MsgIngest.registerPlugin: handler must be a function or an object with start/stop/onStateChange/onObjectChange',
			);
		});

		it('treats function handlers as onStateChange', () => {
			const { adapter } = makeAdapter();
			const { msgFactory, msgStore, calls } = makeDeps();
			const ingest = new MsgIngest(adapter, MsgConstants, msgFactory, msgStore);

			let receivedId = null;
			let receivedState = null;
			let receivedCtx = null;

			ingest.registerPlugin('fn', (id, state, ctx) => {
				receivedId = id;
				receivedState = state;
				receivedCtx = ctx;
				ctx.api.store.addMessage({ ref: 'r1' });
			});

			const state = { val: 1, ack: false };
			const count = ingest.dispatchStateChange('foo.0.bar', state, { source: 'unit' });

			expect(count).to.equal(1);
			expect(receivedId).to.equal('foo.0.bar');
			expect(receivedState).to.equal(state);
			expect(receivedCtx).to.have.property('api');
			expect(receivedCtx.api.constants).to.equal(MsgConstants);
			expect(receivedCtx).to.have.property('meta');
			expect(receivedCtx.meta).to.deep.equal({ source: 'unit', running: false });
			expect(calls.addMessage).to.deep.equal([[{ ref: 'r1' }]]);
		});

		it('binds object handlers and supports onObjectChange', () => {
			const { adapter } = makeAdapter();
			const { msgFactory, msgStore } = makeDeps();
			const ingest = new MsgIngest(adapter, MsgConstants, msgFactory, msgStore);

			const plugin = {
				thisValue: null,
				stateArgs: null,
				objectArgs: null,
				onStateChange(id, state, ctx) {
					this.thisValue = this;
					this.stateArgs = [id, state, ctx];
				},
				onObjectChange(id, obj, ctx) {
					this.objectArgs = [id, obj, ctx];
				},
			};

			ingest.registerPlugin('obj', plugin);
			ingest.dispatchStateChange('s1', { val: 2 }, { a: 1 });
			ingest.dispatchObjectChange('o1', { type: 'state' }, { b: 2 });

			expect(plugin.thisValue).to.equal(plugin);
			expect(plugin.stateArgs[0]).to.equal('s1');
			expect(plugin.stateArgs[2].meta).to.deep.equal({ a: 1, running: false });
			expect(plugin.objectArgs[0]).to.equal('o1');
			expect(plugin.objectArgs[2].meta).to.deep.equal({ b: 2, running: false });
		});
	});

	describe('start/stop lifecycle', () => {
		it('starts all plugins and passes running=true in ctx.meta', () => {
			const { adapter } = makeAdapter();
			const { msgFactory, msgStore } = makeDeps();
			const ingest = new MsgIngest(adapter, MsgConstants, msgFactory, msgStore);

			const plugin = { startMeta: null, stopMeta: null, start(ctx) { this.startMeta = ctx.meta; }, stop(ctx) { this.stopMeta = ctx.meta; } };
			ingest.registerPlugin('p1', plugin);

			ingest.start({ boot: true });
			expect(plugin.startMeta).to.deep.equal({ boot: true, running: true });

			ingest.stop({ bye: true });
			expect(plugin.stopMeta).to.deep.equal({ bye: true, running: true });
		});

		it('starts newly registered plugins when already running', () => {
			const { adapter } = makeAdapter();
			const { msgFactory, msgStore } = makeDeps();
			const ingest = new MsgIngest(adapter, MsgConstants, msgFactory, msgStore);
			ingest.start({ boot: true });

			const plugin = { startMeta: null, start(ctx) { this.startMeta = ctx.meta; } };
			ingest.registerPlugin('late', plugin);

			expect(plugin.startMeta).to.deep.equal({ reason: 'registerPlugin', pluginId: 'late', running: true });
		});

		it('stops previous plugin when overwriting while running', () => {
			const { adapter } = makeAdapter();
			const { msgFactory, msgStore } = makeDeps();
			const ingest = new MsgIngest(adapter, MsgConstants, msgFactory, msgStore);
			ingest.start();

			const first = { stopMeta: null, stop(ctx) { this.stopMeta = ctx.meta; } };
			ingest.registerPlugin('p', first);

			const second = { startMeta: null, start(ctx) { this.startMeta = ctx.meta; } };
			ingest.registerPlugin('p', second);

			expect(first.stopMeta).to.deep.equal({ reason: 'registerPlugin:overwrite', pluginId: 'p', running: true });
			expect(second.startMeta).to.deep.equal({ reason: 'registerPlugin', pluginId: 'p', running: true });
		});

		it('stops plugins on unregister when running', () => {
			const { adapter } = makeAdapter();
			const { msgFactory, msgStore } = makeDeps();
			const ingest = new MsgIngest(adapter, MsgConstants, msgFactory, msgStore);
			ingest.start();

			const plugin = { stopMeta: null, stop(ctx) { this.stopMeta = ctx.meta; } };
			ingest.registerPlugin('p', plugin);
			ingest.unregisterPlugin('p');

			expect(plugin.stopMeta).to.deep.equal({ reason: 'unregisterPlugin', pluginId: 'p', running: true });
		});
	});

	describe('dispatchStateChange/dispatchObjectChange', () => {
		it('returns 0 for invalid ids', () => {
			const { adapter } = makeAdapter();
			const { msgFactory, msgStore } = makeDeps();
			const ingest = new MsgIngest(adapter, MsgConstants, msgFactory, msgStore);
			ingest.registerPlugin('p', () => {});

			expect(ingest.dispatchStateChange('', { val: 1 })).to.equal(0);
			expect(ingest.dispatchObjectChange('   ', { type: 'state' })).to.equal(0);
		});

		it('counts plugins and isolates plugin failures', () => {
			const { adapter, logs } = makeAdapter();
			const { msgFactory, msgStore } = makeDeps();
			const ingest = new MsgIngest(adapter, MsgConstants, msgFactory, msgStore);

			let okCalls = 0;
			ingest.registerPlugin('ok', () => {
				okCalls += 1;
			});
			ingest.registerPlugin('boom', () => {
				throw new Error('fail');
			});

			const count = ingest.dispatchStateChange('x', { val: 1 });

			expect(count).to.equal(2);
			expect(okCalls).to.equal(1);
			expect(logs.warn.length).to.equal(1);
			expect(logs.warn[0]).to.include("plugin 'boom' failed on stateChange");
		});
	});
});

