'use strict';

const { expect } = require('chai');
const { MsgStore } = require('./MsgStore');

function createAdapter() {
	const logs = { warn: [] };
	const adapter = {
		log: {
			warn: msg => logs.warn.push(msg),
		},
	};
	return { adapter, logs };
}

function createStorage() {
	const writes = [];
	const storage = {
		writeJson: value => writes.push(value),
	};
	return { storage, writes };
}

function createFactory({ applyPatch } = {}) {
	return {
		applyPatch: applyPatch || ((existing, patch) => ({ ...existing, ...patch })),
	};
}

function createStore({ messages = [], factory, storage, adapter } = {}) {
	const { adapter: defaultAdapter, logs } = createAdapter();
	const { storage: defaultStorage, writes } = createStorage();
	const msgFactory = factory || createFactory();

	return {
		store: new MsgStore(adapter || defaultAdapter, messages, msgFactory, storage || defaultStorage),
		logs,
		writes,
		msgFactory,
	};
}

describe('MsgStore', () => {

	describe('addMessage guards', () => {
		it('rejects non-integer levels', () => {
			const { store, writes } = createStore();
			const result = store.addMessage({ ref: 'r1', level: '10' });
			expect(result).to.equal(false);
			expect(store.getMessages()).to.have.length(0);
			expect(writes).to.have.length(0);
		});

		it('rejects duplicate refs', () => {
			const existing = { ref: 'r1', level: 10 };
			const { store, writes } = createStore({ messages: [existing] });
			const result = store.addMessage({ ref: 'r1', level: 10 });
			expect(result).to.equal(false);
			expect(store.getMessages()).to.have.length(1);
			expect(writes).to.have.length(0);
		});
	});

	describe('addMessage success', () => {
		it('adds a valid message and persists', () => {
			const { store, writes } = createStore();
			const result = store.addMessage({ ref: 'r1', level: 10, text: 'hello' });
			expect(result).to.equal(true);
			expect(store.getMessages()).to.have.length(1);
			expect(writes).to.have.length(1);
		});
	});

	describe('updateMessage guards', () => {
		it('rejects empty or non-object patches', () => {
			const { store, writes } = createStore();
			const result = store.updateMessage(null);
			expect(result).to.equal(false);
			expect(writes).to.have.length(0);
		});

		it('rejects ref-only calls with empty ref', () => {
			const { store, writes } = createStore();
			const result = store.updateMessage('   ', { text: 'x' });
			expect(result).to.equal(false);
			expect(writes).to.have.length(0);
		});

		it('rejects patches without a valid ref', () => {
			const { store, writes } = createStore();
			const result = store.updateMessage({ ref: '   ' });
			expect(result).to.equal(false);
			expect(writes).to.have.length(0);
		});

		it('rejects updates for missing refs', () => {
			const { store, writes } = createStore({ messages: [] });
			const result = store.updateMessage({ ref: 'r1', text: 'x' });
			expect(result).to.equal(false);
			expect(writes).to.have.length(0);
		});

		it('rejects updates when factory lacks applyPatch', () => {
			const { adapter, logs } = createAdapter();
			const { storage, writes } = createStorage();
			const msgFactory = {};
			const store = new MsgStore(adapter, [{ ref: 'r1', level: 10 }], msgFactory, storage);

			const result = store.updateMessage({ ref: 'r1', text: 'x' });
			expect(result).to.equal(false);
			expect(logs.warn).to.have.length(1);
			expect(writes).to.have.length(0);
		});

		it('rejects updates when factory returns null', () => {
			const factory = createFactory({ applyPatch: () => null });
			const { store, writes } = createStore({ messages: [{ ref: 'r1', level: 10 }], factory });
			const result = store.updateMessage({ ref: 'r1', text: 'x' });
			expect(result).to.equal(false);
			expect(writes).to.have.length(0);
		});
	});

	describe('updateMessage success', () => {
		it('applies patch and persists', () => {
			const factory = createFactory();
			const { store, writes } = createStore({
				messages: [{ ref: 'r1', level: 10, text: 'old' }],
				factory,
			});

			const result = store.updateMessage({ ref: 'r1', text: 'new' });
			expect(result).to.equal(true);
			expect(store.getMessageByRef('r1').text).to.equal('new');
			expect(writes).to.have.length(1);
		});

		it('accepts ref + patch overload', () => {
			const factory = createFactory();
			const { store, writes } = createStore({
				messages: [{ ref: 'r1', level: 10, text: 'old' }],
				factory,
			});

			const result = store.updateMessage('r1', { text: 'new' });
			expect(result).to.equal(true);
			expect(store.getMessageByRef('r1').text).to.equal('new');
			expect(writes).to.have.length(1);
		});
	});

	describe('addOrUpdateMessage guards', () => {
		it('updates when the ref already exists', () => {
			const factory = createFactory();
			const { store, writes } = createStore({
				messages: [{ ref: 'r1', level: 10, text: 'old' }],
				factory,
			});

			const result = store.addOrUpdateMessage({ ref: 'r1', text: 'new' });
			expect(result).to.equal(true);
			expect(store.getMessageByRef('r1').text).to.equal('new');
			expect(writes).to.have.length(1);
		});

		it('adds when the ref does not exist', () => {
			const { store, writes } = createStore();
			const result = store.addOrUpdateMessage({ ref: 'r2', level: 10 });
			expect(result).to.equal(true);
			expect(store.getMessages()).to.have.length(1);
			expect(writes).to.have.length(1);
		});
	});

	describe('read helpers', () => {
		it('finds by ref and returns undefined when missing', () => {
			const { store } = createStore({ messages: [{ ref: 'r1', level: 10 }] });
			expect(store.getMessageByRef('r1')).to.be.an('object');
			expect(store.getMessageByRef('missing')).to.equal(undefined);
		});

		it('filters by level', () => {
			const messages = [
				{ ref: 'r1', level: 10 },
				{ ref: 'r2', level: 20 },
				{ ref: 'r3', level: 10 },
			];
			const { store } = createStore({ messages });
			const result = store.getMessagesByLevel(10);
			expect(result).to.have.length(2);
			expect(result.map(msg => msg.ref)).to.deep.equal(['r1', 'r3']);
		});

		it('returns the full list', () => {
			const messages = [{ ref: 'r1', level: 10 }];
			const { store } = createStore({ messages });
			expect(store.getMessages()).to.equal(messages);
		});
	});

	describe('removeMessage guards', () => {
		it('does nothing when the ref does not exist', () => {
			const messages = [{ ref: 'r1', level: 10 }];
			const { store } = createStore({ messages });
			store.removeMessage('missing');
			expect(store.getMessages()).to.have.length(1);
		});

		it('removes the matching message', () => {
			const messages = [{ ref: 'r1', level: 10 }];
			const { store } = createStore({ messages });
			store.removeMessage('r1');
			expect(store.getMessages()).to.have.length(0);
		});
	});

	describe('deleteOldMessages guard', () => {
		it('does not modify the list (currently disabled)', () => {
			const messages = [{ ref: 'r1', level: 10 }];
			const { store } = createStore({ messages });
			store.deleteOldMessages();
			expect(store.getMessages()).to.have.length(1);
		});
	});
});
