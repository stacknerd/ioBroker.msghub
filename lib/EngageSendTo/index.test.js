'use strict';

const { expect } = require('chai');

const { EngageSendTo } = require('./index');

function makeLog() {
	const calls = { debug: [], warn: [], silly: [] };
	return {
		calls,
		log: {
			debug: msg => calls.debug.push(msg),
			warn: msg => calls.warn.push(msg),
			silly: msg => calls.silly.push(msg),
		},
	};
}

function makeStore(seed = []) {
	const messages = new Map(seed.map(m => [m.ref, m]));
	const calls = { addMessage: [], updateMessage: [], removeMessage: [], queryMessages: [] };

	return {
		calls,
		addMessage(msg) {
			calls.addMessage.push(msg);
			if (!msg || typeof msg.ref !== 'string' || !msg.ref.trim()) {
				return false;
			}
			if (messages.has(msg.ref)) {
				return false;
			}
			messages.set(msg.ref, msg);
			return true;
		},
		updateMessage(ref, patch) {
			calls.updateMessage.push([ref, patch]);
			const cur = messages.get(ref);
			if (!cur) {
				return false;
			}
			messages.set(ref, { ...cur, ...patch });
			return true;
		},
		getMessageByRef(ref) {
			return messages.get(ref);
		},
		removeMessage(ref) {
			calls.removeMessage.push(ref);
			messages.delete(ref);
		},
		queryMessages(opts) {
			calls.queryMessages.push(opts);
			return { items: Array.from(messages.values()), total: messages.size };
		},
	};
}

function makeFactory({ accept = true } = {}) {
	const calls = { createMessage: [] };
	return {
		calls,
		createMessage(payload) {
			calls.createMessage.push(payload);
			if (!accept) {
				return null;
			}
			const ref = typeof payload?.ref === 'string' && payload.ref.trim() ? payload.ref.trim() : '';
			if (!ref) {
				return null;
			}
			return { ...payload, ref };
		},
	};
}

function makeAction(store) {
	const calls = { execute: [] };
	return {
		calls,
		execute({ ref, actionId, actor, payload }) {
			calls.execute.push({ ref, actionId, actor, payload });
			const cur = store.getMessageByRef(ref);
			if (!cur) {
				return false;
			}
			store.updateMessage(ref, { lastAction: { actionId, actor, payload } });
			return true;
		},
	};
}

function makeCtx({ log, store, factory, action } = {}) {
	return {
		api: { log, store, factory, action },
		meta: { plugin: {}, resources: {} },
	};
}

describe('EngageSendTo', () => {
	it('requires messagebox register/unregister', () => {
		expect(() => EngageSendTo()).to.throw(/register\/unregister/);
		expect(() => EngageSendTo({ __messagebox: { register() {} } })).to.throw(/register\/unregister/);
		expect(() => EngageSendTo({ __messagebox: { unregister() {} } })).to.throw(/register\/unregister/);
	});

	it('registers/unregisters its messagebox handler', () => {
		const messagebox = { register: fn => (messagebox._fn = fn), unregister: () => (messagebox._fn = null) };
		const { log } = makeLog();
		const store = makeStore();
		const factory = makeFactory();
		const action = makeAction(store);

		const h = EngageSendTo({ __messagebox: messagebox });
		h.start(makeCtx({ log, store, factory, action }));
		expect(messagebox._fn).to.be.a('function');
		h.stop();
		expect(messagebox._fn).to.equal(null);
	});

	it('handles create/get/remove with structured responses', async () => {
		const messagebox = { register() {}, unregister() {} };
		const { log } = makeLog();
		const store = makeStore();
		const factory = makeFactory();
		const action = makeAction(store);

		const h = EngageSendTo({ __messagebox: messagebox });
		h.start(makeCtx({ log, store, factory, action }));

		const created = await h.onMessage({
			command: 'create',
			message: { ref: 'm1', title: 't1', text: 'x', icon: '🧪' },
		});
		expect(created.ok).to.equal(true);
		expect(created.data).to.have.property('ref', 'm1');
		expect(created.data).to.have.property('message');
		expect(store.getMessageByRef('m1')).to.be.an('object');
		expect(store.getMessageByRef('m1')).to.have.property('icon', '🧪');

		const fetched = await h.onMessage({ command: 'get', message: 'm1' });
		expect(fetched.ok).to.equal(true);
		expect(fetched.data.ref).to.equal('m1');
		expect(fetched.data.message).to.have.property('title', 't1');

		const removed = await h.onMessage({ command: 'remove', message: { ref: 'm1' } });
		expect(removed.ok).to.equal(true);
		expect(removed.data).to.deep.include({ ref: 'm1', removed: true });
		expect(store.getMessageByRef('m1')).to.equal(undefined);

		const removedAgain = await h.onMessage({ command: 'remove', message: { ref: 'm1' } });
		expect(removedAgain.ok).to.equal(true);
		expect(removedAgain.data).to.deep.equal({ ref: 'm1', removed: false });
	});

	it('handles patch/upsert and strips control keys when needed', async () => {
		const messagebox = { register() {}, unregister() {} };
		const { log } = makeLog();
		const store = makeStore([{ ref: 'm1', title: 'old', text: 't' }]);
		const factory = makeFactory();
		const action = makeAction(store);

		const h = EngageSendTo({ __messagebox: messagebox });
		h.start(makeCtx({ log, store, factory, action }));

		const patched = await h.onMessage({
			command: 'patch',
			message: { ref: 'm1', title: 'new', icon: '🧪', command: 'patch', from: 'x', silent: true, actor: 'x' },
		});
		expect(patched.ok).to.equal(true);
		expect(store.calls.updateMessage).to.have.length(1);
		const patchArg = store.calls.updateMessage[0][1];
		expect(patchArg).to.deep.equal({ ref: 'm1', title: 'new', icon: '🧪' });

		const patched2 = await h.onMessage({
			command: 'patch',
			message: { ref: 'm1', patch: { text: 'changed' }, silent: true },
		});
		expect(patched2.ok).to.equal(true);
		expect(store.calls.updateMessage[1][1]).to.deep.equal({ text: 'changed' });

		const upsertUpdate = await h.onMessage({ command: 'upsert', message: { ref: 'm1', title: 'u1' } });
		expect(upsertUpdate.ok).to.equal(true);
		expect(store.getMessageByRef('m1')).to.have.property('title', 'u1');

		const upsertCreate = await h.onMessage({ command: 'upsert', message: { ref: 'm2', title: 't2' } });
		expect(upsertCreate.ok).to.equal(true);
		expect(store.getMessageByRef('m2')).to.have.property('title', 't2');
	});

	it('handles list and action commands', async () => {
		const messagebox = { register() {}, unregister() {} };
		const { log } = makeLog();
		const store = makeStore([{ ref: 'm1', title: 't' }]);
		const factory = makeFactory();
		const action = makeAction(store);
		const h = EngageSendTo({ __messagebox: messagebox });
		h.start(makeCtx({ log, store, factory, action }));

		const listed = await h.onMessage({ command: 'list', message: { where: { kind: 'x' }, sort: [] } });
		expect(listed.ok).to.equal(true);
		expect(listed.data).to.have.property('items');
		expect(listed.data.items).to.have.length(1);
		expect(store.calls.queryMessages[0]).to.have.property('where');

		const acted = await h.onMessage({
			command: 'action',
			message: { ref: 'm1', actionId: 'ack', actor: 'tester', payload: { x: 1 } },
		});
		expect(acted.ok).to.equal(true);
		expect(action.calls.execute).to.have.length(1);
		expect(store.getMessageByRef('m1')).to.have.property('lastAction');
	});

	it('rejects invalid requests with consistent error shapes', async () => {
		const messagebox = { register() {}, unregister() {} };
		const { log } = makeLog();
		const store = makeStore();
		const factory = makeFactory({ accept: false });
		const action = makeAction(store);
		const h = EngageSendTo({ __messagebox: messagebox });
		h.start(makeCtx({ log, store, factory, action }));

		const badCmd = await h.onMessage({ message: {} });
		expect(badCmd.ok).to.equal(false);
		expect(badCmd.error.code).to.equal('BAD_REQUEST');

		const unknown = await h.onMessage({ command: 'nope', message: {} });
		expect(unknown.ok).to.equal(false);
		expect(unknown.error.code).to.equal('UNKNOWN_COMMAND');

		const badCreate = await h.onMessage({ command: 'create', message: { title: 'no ref' } });
		expect(badCreate.ok).to.equal(false);
		expect(badCreate.error.code).to.equal('VALIDATION_FAILED');

		const missingActionId = await h.onMessage({ command: 'action', message: { ref: 'x' } });
		expect(missingActionId.ok).to.equal(false);
		expect(missingActionId.error.code).to.equal('BAD_REQUEST');

		store.queryMessages = () => {
			throw new Error('bad query');
		};
		const listBadQuery = await h.onMessage({ command: 'list', message: { where: { invalid: 'x' } } });
		expect(listBadQuery.ok).to.equal(false);
		expect(listBadQuery.error.code).to.equal('BAD_REQUEST');
	});
});
