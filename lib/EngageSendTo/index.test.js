'use strict';

const { expect } = require('chai');

const { EngageSendTo } = require('./index');

function createHarness() {
	const messagesByRef = new Map();
	let refSeq = 0;
	const queryCalls = [];

	const factory = {
		createMessage: input => {
			if (!input || typeof input !== 'object' || Array.isArray(input)) {
				return null;
			}
			const ref = typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim() : `ref-${++refSeq}`;
			return { ...input, ref };
		},
	};

	const store = {
		addMessage: msg => {
			if (!msg || typeof msg !== 'object') {
				return false;
			}
			const ref = typeof msg.ref === 'string' ? msg.ref.trim() : '';
			if (!ref || messagesByRef.has(ref)) {
				return false;
			}
			messagesByRef.set(ref, { ...msg });
			return true;
		},
		getMessageByRef: ref => messagesByRef.get(ref),
		getMessages: () => Array.from(messagesByRef.values()),
		queryMessages: ({ where = {}, page = undefined, sort = undefined } = {}) => {
			queryCalls.push({ where, page, sort });

			const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
			const w = isPlainObject(where) ? where : {};

			let items = Array.from(messagesByRef.values());
			if (typeof w.kind === 'string') {
				items = items.filter(m => m?.kind === w.kind);
			}
			if (typeof w.level === 'number') {
				items = items.filter(m => m?.level === w.level);
			}

			if (Array.isArray(sort) && sort.length > 0) {
				const { field, dir } = sort[0] || {};
				if (field === 'ref') {
					items = items.slice().sort((a, b) => String(a?.ref || '').localeCompare(String(b?.ref || '')));
					if (dir === 'desc') {
						items.reverse();
					}
				}
			}

			const total = items.length;
			let pages = 1;

			if (isPlainObject(page) && typeof page.size === 'number' && Number.isFinite(page.size) && page.size > 0) {
				const size = Math.max(1, Math.trunc(page.size));
				const index = typeof page.index === 'number' && Number.isFinite(page.index) ? Math.max(1, Math.trunc(page.index)) : 1;
				pages = Math.max(1, Math.ceil(total / size));
				const start = (index - 1) * size;
				items = items.slice(start, start + size);
			}

			return { total, pages, items };
		},
		updateMessage: (msgOrRef, patch) => {
			const ref = typeof msgOrRef === 'string' ? msgOrRef.trim() : typeof msgOrRef?.ref === 'string' ? msgOrRef.ref.trim() : '';
			if (!ref || !messagesByRef.has(ref)) {
				return false;
			}
			const existing = messagesByRef.get(ref);
			const patchObj = typeof msgOrRef === 'string' ? patch : msgOrRef;
			const next = { ...existing, ...(patchObj || {}), ref: existing.ref };
			messagesByRef.set(ref, next);
			return true;
		},
		removeMessage: ref => {
			const r = typeof ref === 'string' ? ref.trim() : '';
			const existing = messagesByRef.get(r);
			if (!existing) {
				return;
			}
			messagesByRef.set(r, { ...existing, lifecycle: { ...(existing.lifecycle || {}), state: 'deleted' } });
		},
	};

	const actionCalls = [];
	const action = {
		execute: options => {
			actionCalls.push(options);
			return true;
		},
	};

	const logs = { warn: [], info: [], debug: [], error: [] };
	const log = {
		debug: msg => logs.debug.push(msg),
		info: msg => logs.info.push(msg),
		warn: msg => logs.warn.push(msg),
		error: msg => logs.error.push(msg),
	};

	let registeredHandler = null;
	const messagebox = {
		register: handler => {
			registeredHandler = handler;
		},
		unregister: () => {
			registeredHandler = null;
		},
	};

	const ctx = { api: { factory, store, action, log } };

	return { factory, store, action, actionCalls, messagebox, logs, ctx, queryCalls, getRegisteredHandler: () => registeredHandler };
}

describe('EngageSendTo', () => {
	it('registers/unregisters the messagebox handler on start/stop', async () => {
		const h = createHarness();
		const plugin = EngageSendTo({ __messagebox: h.messagebox });

		expect(h.getRegisteredHandler()).to.equal(null);
		plugin.start(h.ctx);
		expect(h.getRegisteredHandler()).to.be.a('function');

		const beforeStop = await plugin.onMessage({ command: 'list', message: {} });
		expect(beforeStop.ok).to.equal(true);

		plugin.stop(h.ctx);
		expect(h.getRegisteredHandler()).to.equal(null);

		const afterStop = await plugin.onMessage({ command: 'list', message: {} });
		expect(afterStop.ok).to.equal(false);
		expect(afterStop.error.code).to.equal('NOT_READY');
	});

		it('implements create/get/list/remove/patch/upsert/action commands', async () => {
			const h = createHarness();
			const plugin = EngageSendTo({ __messagebox: h.messagebox });
			plugin.start(h.ctx);

		const created = await plugin.onMessage({
			command: 'create',
			message: { ref: 'm1', kind: 'task', level: 1, title: 'T', text: 'X', origin: { type: 'manual', system: 'x', id: 'y' } },
		});
		expect(created.ok).to.equal(true);
		expect(created.data.ref).to.equal('m1');

		const got = await plugin.onMessage({ command: 'get', message: { ref: 'm1' } });
		expect(got.ok).to.equal(true);
		expect(got.data.ref).to.equal('m1');

		const listAll = await plugin.onMessage({ command: 'list', message: {} });
		expect(listAll.ok).to.equal(true);
		expect(listAll.data.items).to.have.length(1);

			const patched = await plugin.onMessage({ command: 'patch', message: { ref: 'm1', patch: { title: 'T2' } } });
			expect(patched.ok).to.equal(true);
			expect(patched.data.message.title).to.equal('T2');

			const updatedAlias = await plugin.onMessage({ command: 'update', message: { ref: 'm1', patch: { title: 'T3' } } });
			expect(updatedAlias.ok).to.equal(false);
			expect(updatedAlias.error.code).to.equal('UNKNOWN_COMMAND');

			const upsertUpdate = await plugin.onMessage({
				command: 'upsert',
				message: { ref: 'm1', title: 'T4', text: 'X', kind: 'task', level: 1, origin: { type: 'manual', system: 'x', id: 'y' } },
			});
		expect(upsertUpdate.ok).to.equal(true);
		expect(upsertUpdate.data.message.title).to.equal('T4');

		const upsertCreate = await plugin.onMessage({
			command: 'upsert',
			message: { ref: 'm2', kind: 'task', level: 1, title: 'A', text: 'B', origin: { type: 'manual', system: 'x', id: 'y' } },
		});
		expect(upsertCreate.ok).to.equal(true);
		expect(upsertCreate.data.ref).to.equal('m2');

		const actionOk = await plugin.onMessage({
			command: 'action',
			message: { ref: 'm1', actionId: 'ack-1', actor: 'tester', payload: { forMs: 123 } },
		});
		expect(actionOk.ok).to.equal(true);
		expect(h.actionCalls).to.have.length(1);
		expect(h.actionCalls[0]).to.deep.equal({ ref: 'm1', actionId: 'ack-1', actor: 'tester', payload: { forMs: 123 } });

		const removed = await plugin.onMessage({ command: 'remove', message: { ref: 'm1' } });
		expect(removed.ok).to.equal(true);
		expect(removed.data.removed).to.equal(true);

		const removedMsg = await plugin.onMessage({ command: 'get', message: 'm1' });
		expect(removedMsg.ok).to.equal(true);
		expect(removedMsg.data.message.lifecycle.state).to.equal('deleted');
	});

	it('returns structured errors for bad requests and unknown commands', async () => {
		const h = createHarness();
		const plugin = EngageSendTo({ __messagebox: h.messagebox });
		plugin.start(h.ctx);

		const badGet = await plugin.onMessage({ command: 'get', message: {} });
		expect(badGet.ok).to.equal(false);
		expect(badGet.error.code).to.equal('BAD_REQUEST');

		const missing = await plugin.onMessage({ command: 'get', message: { ref: 'nope' } });
		expect(missing.ok).to.equal(false);
		expect(missing.error.code).to.equal('NOT_FOUND');

		const unknown = await plugin.onMessage({ command: 'nope', message: {} });
		expect(unknown.ok).to.equal(false);
		expect(unknown.error.code).to.equal('UNKNOWN_COMMAND');
	});

		it('delegates list queries to ctx.api.store.queryMessages', async () => {
			const h = createHarness();
			const plugin = EngageSendTo({ __messagebox: h.messagebox });
			plugin.start(h.ctx);

		await plugin.onMessage({
			command: 'create',
			message: { ref: 'm1', kind: 'task', level: 10, title: 'T', text: 'X', origin: { type: 'manual', system: 'x', id: 'y' } },
		});
			await plugin.onMessage({
				command: 'create',
				message: { ref: 'm2', kind: 'status', level: 20, title: 'S', text: 'Y', origin: { type: 'manual', system: 'x', id: 'y' } },
			});

			const res = await plugin.onMessage({
				command: 'list',
				message: { where: { kind: 'task', level: 10 }, page: { size: 5, index: 1 } },
			});
			expect(res.ok).to.equal(true);
			expect(res.data.items).to.have.length(1);

			expect(h.queryCalls).to.have.length(1);
			expect(h.queryCalls[0].where).to.deep.equal({ kind: 'task', level: 10 });
			expect(h.queryCalls[0].page).to.deep.equal({ size: 5, index: 1 });
			expect(h.queryCalls[0].sort).to.equal(undefined);
		});

	it('passes through where/page/sort for list', async () => {
		const h = createHarness();
		const plugin = EngageSendTo({ __messagebox: h.messagebox });
		plugin.start(h.ctx);

			const query = {
				where: { kind: 'task' },
				page: { size: 10, index: 2 },
				sort: [{ field: 'ref', dir: 'desc' }],
			};
			const res = await plugin.onMessage({ command: 'list', message: query });
			expect(res.ok).to.equal(true);

		expect(h.queryCalls).to.have.length(1);
		expect(h.queryCalls[0]).to.deep.equal({ where: { kind: 'task' }, page: { size: 10, index: 2 }, sort: [{ field: 'ref', dir: 'desc' }] });
	});

	it('returns BAD_REQUEST when queryMessages rejects the query', async () => {
		const h = createHarness();
		h.store.queryMessages = () => {
			throw new Error('boom');
		};
		const plugin = EngageSendTo({ __messagebox: h.messagebox });
		plugin.start(h.ctx);

		const res = await plugin.onMessage({ command: 'list', message: { where: { lifecycle: { state: { in: ['open'], notIn: ['deleted'] } } } } });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});
});
