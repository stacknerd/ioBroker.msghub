'use strict';

const { expect } = require('chai');
const { MsgStore } = require('./MsgStore');
const { MsgConstants } = require('./MsgConstants');

function createAdapter() {
	const logs = { warn: [] };
	const adapter = {
		name: 'msghub',
		namespace: 'msghub.0',
		locale: 'en-US',
		log: {
			warn: msg => logs.warn.push(msg),
			debug: () => {},
			silly: () => {},
			info: () => {},
		},
		getObjectAsync: async () => ({ type: 'meta' }),
		setObjectAsync: async () => {},
		mkdirAsync: async () => {},
		writeFileAsync: async () => {},
		readFileAsync: async () => ({ file: '' }),
	};
	return { adapter, logs };
}

function createStorage() {
	const writes = [];
	const storage = {
		writeJson: value => writes.push(value),
		flushPending: () => {},
	};
	return { storage, writes };
}

function createRenderer() {
	const calls = [];
	const renderOne = msg => {
		calls.push(msg);
		if (!msg || typeof msg !== 'object') {
			return msg;
		}
		return { ...msg, __rendered: true };
	};
	const msgRender = {
		renderMessage: renderOne,
		renderMessages: msgs => (Array.isArray(msgs) ? msgs.map(renderOne) : msgs),
	};
	return { msgRender, calls };
}

	function createFactory({ applyPatch } = {}) {
		return {
			applyPatch:
				applyPatch ||
				((existing, patch) => {
					const updated = { ...existing, ...patch };
					if (patch?.lifecycle && typeof patch.lifecycle === 'object' && !Array.isArray(patch.lifecycle)) {
						const existingState = existing?.lifecycle?.state || MsgConstants.lifecycle.state.open;
						const patchState = patch.lifecycle.state;
						const lifecycle = { ...(existing?.lifecycle || { state: existingState }), ...patch.lifecycle };
						// Core-owned timestamp: ignore patch attempts and bump on state changes.
						delete lifecycle.stateChangedAt;
						if (typeof patchState === 'string' && patchState !== existingState) {
							lifecycle.stateChangedAt = Date.now();
						} else if (existing?.lifecycle && Object.prototype.hasOwnProperty.call(existing.lifecycle, 'stateChangedAt')) {
							lifecycle.stateChangedAt = existing.lifecycle.stateChangedAt;
						}
						updated.lifecycle = lifecycle;
					}
					return updated;
				}),
		};
	}

function createFactoryWithUpdatedAt() {
	return {
		applyPatch: (existing, patch) => {
			const updated = { ...existing, ...patch };
			const timing = { ...(existing?.timing || {}), ...(patch?.timing || {}) };
			const patchKeys = Object.keys(patch || {}).filter(key => key !== 'ref' && key !== 'timing');
			const isSilent = patchKeys.length === 1 && patchKeys[0] === 'metrics';

			if (!isSilent) {
				timing.updatedAt = Date.now();
			}

			updated.timing = timing;
			return updated;
		},
	};
}

function createStore({
	messages = [],
	factory,
	storage,
	adapter,
	msgArchive,
	msgRender,
	msgNotify,
	options,
	msgConstants,
} = {}) {
	const { adapter: defaultAdapter, logs } = createAdapter();
	const { storage: defaultStorage, writes } = createStorage();
	const { msgRender: defaultRender } = createRenderer();
	const msgFactory = factory || createFactory();

	const store = new MsgStore(adapter || defaultAdapter, msgConstants || MsgConstants, msgFactory, {
		notifierIntervalMs: 0,
		initialMessages: messages,
		...(options || {}),
	});
	store.msgStorage = storage || defaultStorage;
	store.msgRender = msgRender || defaultRender;
	store.msgArchive = msgArchive || {
		appendSnapshot: () => {},
		appendPatch: () => {},
		appendDelete: () => {},
		flushPending: () => {},
	};
	store.msgNotify = msgNotify || { dispatch: () => {} };

	return { store, logs, writes, msgFactory };
}

function withFixedNow(now, fn) {
	const original = Date.now;
	Date.now = () => now;
	try {
		return fn();
	} finally {
		Date.now = original;
	}
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
			// create persists list + notifiedAt(added) patch + notifiedAt(due) patch
			expect(writes).to.have.length(3);
		});
	});

	describe('addMessage recreate', () => {
		it('allows recreate when an existing message is deleted', () => {
			const deletes = [];
			const msgArchive = {
				appendSnapshot: () => {},
				appendPatch: () => {},
				appendDelete: (msg, options) => deletes.push({ msg, options }),
				flushPending: () => {},
			};
			const { store } = createStore({
				messages: [{ ref: 'r1', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.deleted } }],
				msgArchive,
			});

			const ok = store.addMessage({ ref: 'r1', level: 10, text: 'new' });
			expect(ok).to.equal(true);
			expect(store.fullList.filter(msg => msg.ref === 'r1')).to.have.length(1);
			expect(store.getMessageByRef('r1').text).to.equal('new');
			expect(deletes).to.have.length(1);
			expect(deletes[0].msg.ref).to.equal('r1');
			expect(deletes[0].options.event).to.equal('purgeOnRecreate');
		});

		it('allows recreate when an existing message is expired', () => {
			const deletes = [];
			const msgArchive = {
				appendSnapshot: () => {},
				appendPatch: () => {},
				appendDelete: (msg, options) => deletes.push({ msg, options }),
				flushPending: () => {},
			};
			const { store } = createStore({
				messages: [{ ref: 'r1', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.expired } }],
				msgArchive,
			});

			const ok = store.addMessage({ ref: 'r1', level: 10, text: 'new' });
			expect(ok).to.equal(true);
			expect(store.fullList.filter(msg => msg.ref === 'r1')).to.have.length(1);
			expect(store.getMessageByRef('r1').text).to.equal('new');
			expect(deletes).to.have.length(1);
			expect(deletes[0].msg.ref).to.equal('r1');
			expect(deletes[0].options.event).to.equal('purgeOnRecreate');
		});

		it('allows recreate when an existing message is closed', () => {
			const deletes = [];
			const msgArchive = {
				appendSnapshot: () => {},
				appendPatch: () => {},
				appendDelete: (msg, options) => deletes.push({ msg, options }),
				flushPending: () => {},
			};
			const { store } = createStore({
				messages: [{ ref: 'r1', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.closed } }],
				msgArchive,
			});

			// Keep the closed message in place so addMessage has to handle the closed state directly.
			store._lastDeleteClosedAt = Date.now();

			const ok = store.addMessage({ ref: 'r1', level: 10, text: 'new' });
			expect(ok).to.equal(true);
			expect(store.fullList.filter(msg => msg.ref === 'r1')).to.have.length(1);
			expect(store.getMessageByRef('r1').text).to.equal('new');
			expect(deletes).to.have.length(1);
			expect(deletes[0].msg.ref).to.equal('r1');
			expect(deletes[0].options.event).to.equal('purgeOnRecreate');
		});
	});

	describe('notifications', () => {
			it('dispatches immediately on addMessage when notifyAt is missing', () => {
				const received = [];
				const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };
				const { store } = createStore({ msgNotify });

				const msg = { ref: 'r1', level: 10, timing: {} };
				store.addMessage(msg);

				expect(received).to.have.length(2);
				expect(received[0].event).to.equal('added');
				expect(received[0].msg.ref).to.equal('r1');
				expect(received[0].msg.__rendered).to.equal(true);
				expect(received[1].event).to.equal('due');
				expect(received[1].msg.ref).to.equal('r1');
				expect(received[1].msg.__rendered).to.equal(true);
			});

			it('dispatches recovered (no due) when recreating within timing.cooldown', () => {
				const received = [];
				const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };
				const previousChangedAt = 1000;
				const { store } = createStore({
					messages: [
						{
							ref: 'r1',
							level: 10,
							lifecycle: { state: MsgConstants.lifecycle.state.deleted, stateChangedAt: previousChangedAt },
						},
					],
					msgNotify,
				});

				withFixedNow(previousChangedAt + 500, () => {
					store.addMessage({ ref: 'r1', level: 10, timing: { cooldown: 1000 } });
				});

				expect(received).to.have.length(1);
				expect(received[0].event).to.equal('recovered');
				expect(received[0].msg.ref).to.equal('r1');
				expect(received[0].msg.__rendered).to.equal(true);
			});

			it('dispatches recreated + due when recreating after timing.cooldown', () => {
				const received = [];
				const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };
				const previousChangedAt = 1000;
				const { store } = createStore({
					messages: [
						{
							ref: 'r1',
							level: 10,
							lifecycle: { state: MsgConstants.lifecycle.state.deleted, stateChangedAt: previousChangedAt },
						},
					],
					msgNotify,
				});

				withFixedNow(previousChangedAt + 1500, () => {
					store.addMessage({ ref: 'r1', level: 10, timing: { cooldown: 1000 } });
				});

				expect(received).to.have.length(2);
				expect(received[0].event).to.equal('recreated');
				expect(received[0].msg.ref).to.equal('r1');
				expect(received[0].msg.__rendered).to.equal(true);
				expect(received[1].event).to.equal('due');
				expect(received[1].msg.ref).to.equal('r1');
				expect(received[1].msg.__rendered).to.equal(true);
			});

			it('does not dispatch on addMessage when notifyAt is set', () => {
				const received = [];
				const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };
				const { store } = createStore({ msgNotify });

				const msg = { ref: 'r1', level: 10, timing: { notifyAt: Date.now() + 1000 } };
				store.addMessage(msg);

				expect(received).to.have.length(1);
				expect(received[0].event).to.equal('added');
				expect(received[0].msg.ref).to.equal('r1');
				expect(received[0].msg.__rendered).to.equal(true);
			});

		it('dispatches updated + due on updateMessage when notifyAt is missing and update is not silent', () => {
			const received = [];
			const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };
			const factory = createFactoryWithUpdatedAt();
			const now = 1000;
			const { store } = createStore({
				messages: [{ ref: 'r1', level: 10, timing: {} }],
				factory,
				msgNotify,
			});
			store.lastPruneAt = now;

			withFixedNow(now, () => {
				const result = store.updateMessage({ ref: 'r1', text: 'new' });
				expect(result).to.equal(true);
			});

			expect(received).to.have.length(2);
			expect(received[0].event).to.equal('updated');
			expect(received[0].msg.ref).to.equal('r1');
			expect(received[0].msg.__rendered).to.equal(true);
			expect(received[1].event).to.equal('due');
			expect(received[1].msg.ref).to.equal('r1');
			expect(received[1].msg.__rendered).to.equal(true);
		});

		it('does not dispatch on silent update when notifyAt is missing', () => {
			const received = [];
			const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };
			const factory = createFactoryWithUpdatedAt();
			const now = 2000;
			const { store } = createStore({
				messages: [{ ref: 'r1', level: 10, timing: { updatedAt: now } }],
				factory,
				msgNotify,
			});
			store.lastPruneAt = now;

			withFixedNow(now, () => {
				const result = store.updateMessage({ ref: 'r1', metrics: new Map() });
				expect(result).to.equal(true);
			});

			expect(received).to.have.length(0);
		});

		it('dispatches updated but not due when the message is expired', () => {
			const received = [];
			const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };
			const factory = createFactoryWithUpdatedAt();
			const now = 3000;
			const { store } = createStore({
				messages: [{ ref: 'r1', level: 10, timing: { expiresAt: now - 1 } }],
				factory,
				msgNotify,
			});
			store.lastPruneAt = now;

			withFixedNow(now, () => {
				const result = store.updateMessage({ ref: 'r1', text: 'new' });
				expect(result).to.equal(true);
			});

			expect(received).to.have.length(1);
			expect(received[0].event).to.equal('updated');
			expect(received[0].msg.ref).to.equal('r1');
			expect(received[0].msg.__rendered).to.equal(true);
		});

		it('dispatches updated but not due when notifyAt is set', () => {
			const received = [];
			const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };
			const factory = createFactoryWithUpdatedAt();
			const now = 4000;
			const { store } = createStore({
				messages: [{ ref: 'r1', level: 10, timing: { notifyAt: now + 1000 } }],
				factory,
				msgNotify,
			});
			store.lastPruneAt = now;

			withFixedNow(now, () => {
				const result = store.updateMessage({ ref: 'r1', text: 'new' });
				expect(result).to.equal(true);
			});

			expect(received).to.have.length(1);
			expect(received[0].event).to.equal('updated');
			expect(received[0].msg.ref).to.equal('r1');
			expect(received[0].msg.__rendered).to.equal(true);
		});

		it('dispatches planned notifications when notifyAt is due', () => {
			const received = [];
			const msgNotify = { dispatch: (event, msgs) => received.push({ event, msgs }) };
			const now = 5000;
			const messages = [
				{ ref: 'due', level: 10, timing: { notifyAt: now - 1 } },
				{ ref: 'later', level: 10, timing: { notifyAt: now + 1000 } },
				{ ref: 'expired', level: 10, timing: { notifyAt: now - 1, expiresAt: now - 1 } },
			];
			const { store } = createStore({ messages, msgNotify });

			withFixedNow(now, () => {
				store._initiateNotifications();
			});

			expect(received).to.have.length(1);
			expect(received[0].event).to.equal('due');
			expect(received[0].msgs).to.have.length(1);
			expect(received[0].msgs[0].ref).to.equal('due');
			expect(received[0].msgs[0].__rendered).to.equal(true);
		});

			it('uses stealthMode when rescheduling due notifications (no updated event)', () => {
			const received = [];
			const msgNotify = { dispatch: (event, msgs) => received.push({ event, msgs }) };
			const now = 5000;

			const factory = {
				applyPatch: (existing, patch, stealthMode = false) => {
					const updated = { ...existing, ...patch };
					updated.timing = { ...(existing?.timing || {}), ...(patch?.timing || {}) };
					if (!stealthMode) {
						updated.timing.updatedAt = Date.now();
					}
					return updated;
				},
			};

			const messages = [{ ref: 'due', level: 10, timing: { notifyAt: now - 1, remindEvery: 1000 } }];
			const { store } = createStore({ messages, msgNotify, factory });

			withFixedNow(now, () => {
				store._initiateNotifications();
			});

			expect(received).to.have.length(1);
			expect(received[0].event).to.equal('due');
			expect(received[0].msgs[0].__rendered).to.equal(true);
			expect(store.fullList[0].timing.notifyAt).to.equal(now + 1000);
			expect(store.fullList[0].timing.updatedAt).to.equal(undefined);
			});

			it('suppresses repeat due during quiet hours and reschedules notifyAt', () => {
				const received = [];
				const msgNotify = { dispatch: (event, msgs) => received.push({ event, msgs }) };
				const now = new Date(2020, 0, 1, 23, 0, 0, 0).getTime();
				const quietEnd = new Date(2020, 0, 2, 6, 0, 0, 0).getTime();

				const factory = {
					applyPatch: (existing, patch, stealthMode = false) => {
						const updated = { ...existing, ...patch };
						updated.timing = { ...(existing?.timing || {}), ...(patch?.timing || {}) };
						if (patch?.timing?.notifiedAt && typeof patch.timing.notifiedAt === 'object') {
							updated.timing.notifiedAt = { ...(existing?.timing?.notifiedAt || {}), ...(patch.timing.notifiedAt || {}) };
						}
						if (!stealthMode) {
							updated.timing.updatedAt = Date.now();
						}
						return updated;
					},
				};

				const messages = [
					{
						ref: 'due',
						level: 10,
						timing: { notifyAt: now - 1, remindEvery: 1000, notifiedAt: { due: now - 60_000 } },
					},
				];
				const quietHours = { enabled: true, startMin: 22 * 60, endMin: 6 * 60, maxLevel: 20, spreadMs: 0 };
				const { store } = createStore({
					messages,
					msgNotify,
					factory,
					options: { quietHours, quietHoursRandomFn: () => 0 },
				});

				withFixedNow(now, () => {
					store._initiateNotifications();
				});

				expect(received).to.have.length(0);
				expect(store.fullList[0].timing.notifyAt).to.equal(quietEnd);
				expect(store.fullList[0].timing.notifiedAt.due).to.equal(now - 60_000);
			});

			it('dispatches first due during quiet hours and records timing.notifiedAt.due', () => {
				const received = [];
				const msgNotify = { dispatch: (event, msgs) => received.push({ event, msgs }) };
				const now = new Date(2020, 0, 1, 23, 0, 0, 0).getTime();

				const factory = {
					applyPatch: (existing, patch, stealthMode = false) => {
						const updated = { ...existing, ...patch };
						updated.timing = { ...(existing?.timing || {}), ...(patch?.timing || {}) };
						if (patch?.timing?.notifiedAt && typeof patch.timing.notifiedAt === 'object') {
							updated.timing.notifiedAt = { ...(existing?.timing?.notifiedAt || {}), ...(patch.timing.notifiedAt || {}) };
						}
						if (!stealthMode) {
							updated.timing.updatedAt = Date.now();
						}
						return updated;
					},
				};

				const messages = [{ ref: 'due', level: 10, timing: { notifyAt: now - 1, remindEvery: 1000 } }];
				const quietHours = { enabled: true, startMin: 22 * 60, endMin: 6 * 60, maxLevel: 20, spreadMs: 0 };
				const { store } = createStore({
					messages,
					msgNotify,
					factory,
					options: { quietHours, quietHoursRandomFn: () => 0 },
				});

				withFixedNow(now, () => {
					store._initiateNotifications();
				});

				expect(received).to.have.length(1);
				expect(received[0].event).to.equal('due');
				expect(store.fullList[0].timing.notifyAt).to.equal(now + 1000);
				expect(store.fullList[0].timing.notifiedAt.due).to.equal(now);
			});

			it('archives raw messages while notifying rendered views', () => {
				const received = [];
				const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };
				const patches = [];
				const msgArchive = {
					appendSnapshot: () => {},
					appendDelete: () => {},
					appendPatch: (ref, patch, existing, updated) => patches.push({ ref, patch, existing, updated }),
				};
				const factory = createFactoryWithUpdatedAt();
				const now = 6000;
				const { store } = createStore({
					messages: [{ ref: 'r1', level: 10, timing: {}, title: 'T', text: 'old' }],
					factory,
					msgNotify,
					msgArchive,
				});
				store.lastPruneAt = now;

				withFixedNow(now, () => {
					const ok = store.updateMessage({ ref: 'r1', text: 'new' });
					expect(ok).to.equal(true);
				});

				expect(received[0].msg.__rendered).to.equal(true);
				// 1x user patch + notifiedAt(updated) + notifiedAt(due)
				expect(patches).to.have.length(3);
				for (const p of patches) {
					expect(p.updated).to.not.have.property('__rendered');
					expect(p.existing).to.not.have.property('__rendered');
				}
			});
	});

	describe('closed lifecycle cleanup', () => {
		it('soft-deletes closed messages via _deleteClosedMessages', () => {
			const now = 60_000;
			const { store } = createStore({
				messages: [
					{
						ref: 'r1',
						level: 10,
						lifecycle: { state: MsgConstants.lifecycle.state.closed, stateChangedAt: now - 31_000 },
					},
				],
				options: { deleteClosedIntervalMs: 0 },
			});
			withFixedNow(now, () => store._deleteClosedMessages());
			expect(store.getMessageByRef('r1').lifecycle.state).to.equal(MsgConstants.lifecycle.state.deleted);
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
			const { msgRender } = createRenderer();
			const msgFactory = {};
			const store = new MsgStore(adapter, MsgConstants, msgFactory, {
				notifierIntervalMs: 0,
				initialMessages: [{ ref: 'r1', level: 10 }],
			});
			store.msgStorage = storage;
			store.msgRender = msgRender;
			store.msgArchive = { appendSnapshot: () => {}, appendPatch: () => {}, appendDelete: () => {} };
			store.msgNotify = { dispatch: () => {} };

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

		it('does not dispatch updated when stealthMode=true', () => {
			const received = [];
			const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };

			const factory = {
				applyPatch: (existing, patch, stealthMode = false) => {
					const updated = { ...existing, ...patch };
					updated.timing = { ...(existing?.timing || {}), ...(patch?.timing || {}) };
					if (!stealthMode) {
						updated.timing.updatedAt = Date.now();
					}
					return updated;
				},
			};

			const messages = [{ ref: 'r1', level: 10, timing: { createdAt: 1 }, text: 'old' }];
			const { store } = createStore({ messages, msgNotify, factory });

			withFixedNow(2000, () => {
				const ok = store.updateMessage('r1', { text: 'new' }, true);
				expect(ok).to.equal(true);
			});

			expect(store.fullList[0].text).to.equal('new');
			expect(store.fullList[0].timing.updatedAt).to.equal(undefined);
			expect(received).to.have.length(0);
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

			it('adds (recreates) when the ref exists only in quasi-deleted states', () => {
				const received = [];
				const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };
				const { store } = createStore({
					messages: [{ ref: 'r1', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.deleted } }],
					msgNotify,
				});

				const ok = store.addOrUpdateMessage({ ref: 'r1', level: 10, text: 'new' });
				expect(ok).to.equal(true);
				expect(store.getMessageByRef('r1').text).to.equal('new');
				expect(received[0].event).to.equal('recreated');
			});

				it('adds when the ref does not exist', () => {
					const { store, writes } = createStore();
					const result = store.addOrUpdateMessage({ ref: 'r2', level: 10 });
					expect(result).to.equal(true);
					expect(store.getMessages()).to.have.length(1);
					// create persists list + notifiedAt(added) patch + notifiedAt(due) patch
					expect(writes).to.have.length(3);
				});
		});

		describe('read helpers', () => {
			it('finds by ref and returns undefined when missing', () => {
				const { store } = createStore({ messages: [{ ref: 'r1', level: 10 }] });
				expect(store.getMessageByRef('r1')).to.be.an('object');
				expect(store.getMessageByRef('missing')).to.equal(undefined);
			});

			it('supports lifecycle filtering on getMessageByRef', () => {
				const now = 1000;
				const messages = [
					{ ref: 'open', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.open, stateChangedAt: now } },
					{ ref: 'closed', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.closed, stateChangedAt: now } },
					{ ref: 'deleted', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.deleted, stateChangedAt: now } },
				];
				const { store } = createStore({ messages });
				// Prevent maintenance from transforming closed → deleted during this test.
				store._lastDeleteClosedAt = now;
				store.lastPruneAt = now;

				withFixedNow(now, () => {
					expect(store.getMessageByRef('open', 'quasiOpen')).to.be.an('object');
					expect(store.getMessageByRef('open', 'quasiDeleted')).to.equal(undefined);
					expect(store.getMessageByRef('closed', 'quasiDeleted')).to.be.an('object');
					expect(store.getMessageByRef('closed', ['closed'])).to.be.an('object');
					expect(store.getMessageByRef('closed', ['deleted'])).to.equal(undefined);
				});
			});

			it('returns the full list', () => {
				const messages = [{ ref: 'r1', level: 10 }];
				const { store } = createStore({ messages });
				expect(store.getMessages().map(msg => msg.ref)).to.deep.equal(['r1']);
			});
	});

		describe('queryMessages', () => {
		it('excludes deleted and expired by default', () => {
			const messages = [
				{ ref: 'r1', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.open } },
				{ ref: 'r2', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.deleted } },
				{ ref: 'r3', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.expired } },
				{ ref: 'r4', level: 10 }, // no lifecycle => treated as open
			];
			const { store } = createStore({ messages });
			const result = store.queryMessages();
			expect(result.total).to.equal(2);
			expect(result.pages).to.equal(1);
			expect(result.items.map(msg => msg.ref)).to.deep.equal(['r1', 'r4']);
		});

		it('includes deleted/expired only when explicitly requested via lifecycle filter', () => {
			const messages = [
				{ ref: 'r1', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.open } },
				{ ref: 'r2', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.deleted } },
				{ ref: 'r3', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.expired } },
				{ ref: 'r4', level: 10 },
			];
			const { store } = createStore({ messages });
			const result = store.queryMessages({
				where: {
					lifecycle: {
						state: { in: [MsgConstants.lifecycle.state.deleted, MsgConstants.lifecycle.state.expired] },
					},
				},
			});
			expect(result.items.map(msg => msg.ref)).to.deep.equal(['r2', 'r3']);
		});

			it('supports level filtering', () => {
			const messages = [
				{ ref: 'r1', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.open } },
				{ ref: 'r2', level: 20, lifecycle: { state: MsgConstants.lifecycle.state.open } },
				{ ref: 'r3', level: 10, lifecycle: { state: MsgConstants.lifecycle.state.open } },
			];
			const { store } = createStore({ messages });
			const result = store.queryMessages({ where: { level: 10 } });
				expect(result.items.map(msg => msg.ref)).to.deep.equal(['r1', 'r3']);
			});

			it('supports origin.system filtering', () => {
				const messages = [
					{ ref: 'r1', level: 10, origin: { system: 'msghub.0', type: 'IngestStates' } },
					{ ref: 'r2', level: 10, origin: { system: 'msghub.1', type: 'IngestStates' } },
					{ ref: 'r3', level: 10, origin: { system: 'msghub.0', type: 'BridgeAlexaTasks' } },
				];
				const { store } = createStore({ messages });
				const result = store.queryMessages({ where: { origin: { system: 'msghub.0' } } });
				expect(result.items.map(msg => msg.ref)).to.deep.equal(['r1', 'r3']);
			});

		it('supports timing range filters (range implies existence)', () => {
			const messages = [
				{ ref: 'r1', level: 10, timing: { startAt: 1000 } },
				{ ref: 'r2', level: 10, timing: { startAt: 2000 } },
				{ ref: 'r3', level: 10, timing: {} },
			];
			const { store } = createStore({ messages });
			const result = store.queryMessages({ where: { timing: { startAt: { min: 1500, max: 2500 } } } });
			expect(result.items.map(msg => msg.ref)).to.deep.equal(['r2']);
		});

		it('supports timing range filters with orMissing', () => {
			const messages = [
				{ ref: 'r1', level: 10, timing: { startAt: 1000 } },
				{ ref: 'r2', level: 10, timing: { startAt: 2000 } },
				{ ref: 'r3', level: 10, timing: {} },
			];
			const { store } = createStore({ messages });
			const result = store.queryMessages({ where: { timing: { startAt: { max: 1500, orMissing: true } } } });
			expect(result.items.map(msg => msg.ref)).to.deep.equal(['r1', 'r3']);
		});

		it('supports timing range filters for timeBudget (range implies existence)', () => {
			const messages = [
				{ ref: 'r1', level: 10, timing: { timeBudget: 1000 } },
				{ ref: 'r2', level: 10, timing: { timeBudget: 2000 } },
				{ ref: 'r3', level: 10, timing: {} },
			];
			const { store } = createStore({ messages });
			const result = store.queryMessages({ where: { timing: { timeBudget: { min: 1500, max: 2500 } } } });
			expect(result.items.map(msg => msg.ref)).to.deep.equal(['r2']);
		});

		it('supports includes-any and includes-all filters for string lists', () => {
			const messages = [
				{ ref: 'r1', level: 10, audience: { tags: ['Maria'] }, dependencies: ['12'] },
				{ ref: 'r2', level: 10, audience: { tags: ['Eva'] }, dependencies: ['23'] },
				{ ref: 'r3', level: 10, audience: { tags: ['Maria', 'Eva'] }, dependencies: ['12', '23'] },
				{ ref: 'r4', level: 10, dependencies: ['12'] },
			];
			const { store } = createStore({ messages });

			const anyTags = store.queryMessages({ where: { audience: { tags: ['Maria', 'Eva'] } } });
			expect(anyTags.items.map(msg => msg.ref)).to.deep.equal(['r1', 'r2', 'r3']);

			const allTags = store.queryMessages({ where: { audience: { tags: { all: ['Maria', 'Eva'] } } } });
			expect(allTags.items.map(msg => msg.ref)).to.deep.equal(['r3']);

			const anyDeps = store.queryMessages({ where: { dependencies: { any: ['23'] } } });
			expect(anyDeps.items.map(msg => msg.ref)).to.deep.equal(['r2', 'r3']);
		});

		it('supports orMissing for includes filters (audience.tags/dependencies)', () => {
			const messages = [
				{ ref: 'r1', level: 10 }, // missing tags + deps
				{ ref: 'r2', level: 10, audience: { tags: [] }, dependencies: [] },
				{ ref: 'r3', level: 10, audience: { tags: ['Tom'] }, dependencies: ['23'] },
				{ ref: 'r4', level: 10, audience: { tags: ['Eva'] }, dependencies: ['12'] },
			];
			const { store } = createStore({ messages });

			const tags = store.queryMessages({ where: { audience: { tags: { any: ['Tom'], orMissing: true } } } });
			expect(tags.items.map(msg => msg.ref)).to.deep.equal(['r1', 'r2', 'r3']);

			const deps = store.queryMessages({ where: { dependencies: { any: ['23'], orMissing: true } } });
			expect(deps.items.map(msg => msg.ref)).to.deep.equal(['r1', 'r2', 'r3']);
		});

		it('supports audience.channels routing filter (routeTo)', () => {
			const messages = [
				{ ref: 'r1', level: 10, audience: { channels: { include: ['push'] } } },
				{ ref: 'r2', level: 10, audience: { channels: { exclude: ['push'] } } },
				{ ref: 'r3', level: 10 }, // unscoped
				{ ref: 'r4', level: 10, audience: { channels: { include: ['other'] } } },
				{ ref: 'r5', level: 10, audience: { channels: { include: ['push'], exclude: ['push'] } } },
			];
			const { store } = createStore({ messages });

			const push = store.queryMessages({ where: { audience: { channels: { routeTo: 'push' } } } });
			expect(push.items.map(msg => msg.ref)).to.deep.equal(['r1', 'r3']);

			const all = store.queryMessages({ where: { audience: { channels: { routeTo: 'all' } } } });
			expect(all.items.map(msg => msg.ref)).to.deep.equal(['r1', 'r2', 'r3', 'r4', 'r5']);

			const wildcard = store.queryMessages({ where: { audience: { channels: { routeTo: '*' } } } });
			expect(wildcard.items.map(msg => msg.ref)).to.deep.equal(['r1', 'r2', 'r3', 'r4', 'r5']);

			const unscoped = store.queryMessages({ where: { audience: { channels: { routeTo: '' } } } });
			expect(unscoped.items.map(msg => msg.ref)).to.deep.equal(['r2', 'r3']);

			const shorthand = store.queryMessages({ where: { audience: { channels: 'push' } } });
			expect(shorthand.items.map(msg => msg.ref)).to.deep.equal(['r1', 'r3']);

			const any = store.queryMessages({ where: { audience: { channels: ['push', 'other'] } } });
			expect(any.items.map(msg => msg.ref)).to.deep.equal(['r1', 'r2', 'r3', 'r4']);
		});

		it('supports sorting by timing.timeBudget', () => {
			const messages = [
				{ ref: 'r1', level: 10, timing: { timeBudget: 200 } },
				{ ref: 'r2', level: 10, timing: { timeBudget: 100 } },
				{ ref: 'r3', level: 10, timing: {} },
			];
			const { store } = createStore({ messages });
			const result = store.queryMessages({ sort: [{ field: 'timing.timeBudget', dir: 'asc' }] });
			expect(result.items.map(msg => msg.ref)).to.deep.equal(['r2', 'r1', 'r3']);
		});

		it('supports sort and pagination and stays deterministic', () => {
			const messages = [
				{ ref: 'r1', level: 10, timing: { createdAt: 100 } },
				{ ref: 'r2', level: 10, timing: { createdAt: 200 } },
				{ ref: 'r3', level: 10, timing: { createdAt: 300 } },
				{ ref: 'r4', level: 10, timing: { createdAt: 400 } },
				{ ref: 'r5', level: 10, timing: { createdAt: 500 } },
			];
			const { store } = createStore({ messages });
			const result = store.queryMessages({
				sort: [{ field: 'timing.createdAt', dir: 'desc' }],
				page: { size: 2, index: 2 },
			});
			expect(result.total).to.equal(5);
			expect(result.pages).to.equal(3);
			expect(result.items.map(msg => msg.ref)).to.deep.equal(['r3', 'r2']);
		});
	});

	describe('removeMessage guards', () => {
		it('does nothing when the ref does not exist', () => {
			const messages = [{ ref: 'r1', level: 10 }];
			const { store } = createStore({ messages });
			store.removeMessage('missing');
			expect(store.getMessages()).to.have.length(1);
		});

		it('dispatches delete notifications', () => {
			const received = [];
			const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };
			const messages = [{ ref: 'r1', level: 10 }];
			const { store } = createStore({ messages, msgNotify });
			withFixedNow(2000, () => store.removeMessage('r1'));
			expect(received).to.have.length(1);
			expect(received[0].event).to.equal('deleted');
			expect(received[0].msg.ref).to.equal('r1');
			expect(received[0].msg.__rendered).to.equal(true);
			expect(received[0].msg.lifecycle.state).to.equal('deleted');
			expect(received[0].msg.lifecycle.stateChangedAt).to.equal(2000);
		});

		it('soft-deletes the matching message (keeps it in the list)', () => {
			const messages = [{ ref: 'r1', level: 10 }];
			const { store } = createStore({ messages });
			withFixedNow(2000, () => {
				store.removeMessage('r1');
				expect(store.getMessages()).to.have.length(1);
				expect(store.getMessageByRef('r1').lifecycle.state).to.equal('deleted');
			});
		});
	});

	describe('_pruneOldMessages', () => {
		it('soft-expires messages but keeps them in the list', () => {
			const now = 10_000;
			const messages = [
				{ ref: 'r1', level: 10, timing: { expiresAt: now - 1 } },
				{ ref: 'r2', level: 10, timing: { expiresAt: now + 1_000 } },
			];
			const deletes = [];
			const msgArchive = {
				appendDelete: (message, options) => deletes.push({ message, options }),
			};
			const received = [];
			const msgNotify = { dispatch: (event, msg) => received.push({ event, msg }) };
			const { store } = createStore({ messages, msgArchive, msgNotify });
			store.lastPruneAt = now - store.pruneIntervalMs - 1;

			withFixedNow(now, () => {
				store._pruneOldMessages();
				expect(store.getMessages().map(msg => msg.ref)).to.deep.equal(['r1', 'r2']);
			});

			expect(deletes).to.have.length(0);
			expect(received).to.have.length(1);
			expect(received[0].event).to.equal('expired');
			expect(received[0].msg).to.have.length(1);
			expect(received[0].msg[0].ref).to.equal('r1');
			expect(received[0].msg[0].__rendered).to.equal(true);
			expect(received[0].msg[0].lifecycle.state).to.equal('expired');
		});

		it('throttles pruning within the interval', () => {
			const now = 20_000;
			const messages = [{ ref: 'r1', level: 10, timing: { expiresAt: now - 1 } }];
			const { store } = createStore({ messages });
			store.lastPruneAt = now;

			withFixedNow(now, () => {
				store._pruneOldMessages();
				expect(store.getMessages()).to.have.length(1);
			});
		});

		it('hard-deletes messages after the retention window and archives purge', () => {
			const now = 10_000;
			const deletes = [];
			const msgArchive = {
				appendDelete: (message, options) => deletes.push({ message, options }),
			};
			const messages = [
				{
					ref: 'r1',
					level: 10,
					lifecycle: { state: 'deleted', stateChangedAt: now - 2_000, stateChangedBy: 'test' },
				},
			];
			const { store } = createStore({
				messages,
				msgArchive,
				options: { hardDeleteAfterMs: 1000, hardDeleteIntervalMs: 0, hardDeleteStartupDelayMs: 0 },
			});
			store.lastPruneAt = now - store.pruneIntervalMs - 1;

			withFixedNow(now, () => {
				store._pruneOldMessages();
			});

			expect(store.getMessages().map(msg => msg.ref)).to.deep.equal([]);
			expect(deletes).to.have.length(1);
			expect(deletes[0].message.ref).to.equal('r1');
			expect(deletes[0].options).to.deep.equal({ event: 'purge' });
		});

		it('delays hard-deletes during startup to reduce I/O spikes', () => {
			const now = 10_000;
			const deletes = [];
			const msgArchive = {
				appendDelete: (message, options) => deletes.push({ message, options }),
			};
			const messages = [
				{
					ref: 'r1',
					level: 10,
					lifecycle: { state: 'deleted', stateChangedAt: now - 2_000, stateChangedBy: 'test' },
				},
			];
			const { store } = createStore({
				messages,
				msgArchive,
				options: { hardDeleteAfterMs: 1000, hardDeleteIntervalMs: 0, hardDeleteStartupDelayMs: 60_000 },
			});
			store.lastPruneAt = now - store.pruneIntervalMs - 1;

			withFixedNow(now, () => {
				store._pruneOldMessages();
			});

			expect(store.fullList.map(msg => msg.ref)).to.deep.equal(['r1']);
			expect(deletes).to.have.length(0);
			expect(store._hardDeleteTimerDueAt).to.be.greaterThan(0);

			store.onUnload();
		});

		it('hard-deletes in batches when a backlog exists', () => {
			const now = 10_000;
			const deletes = [];
			const msgArchive = {
				appendDelete: (message, options) => deletes.push({ message, options }),
			};
			const messages = [
				{
					ref: 'r1',
					level: 10,
					lifecycle: { state: 'deleted', stateChangedAt: now - 2_000, stateChangedBy: 'test' },
				},
				{
					ref: 'r2',
					level: 10,
					lifecycle: { state: 'deleted', stateChangedAt: now - 2_000, stateChangedBy: 'test' },
				},
			];
			const { store } = createStore({
				messages,
				msgArchive,
				options: {
					hardDeleteAfterMs: 1000,
					hardDeleteIntervalMs: 0,
					hardDeleteStartupDelayMs: 0,
					hardDeleteBatchSize: 1,
					hardDeleteBacklogIntervalMs: 0,
				},
			});
			store.lastPruneAt = now - store.pruneIntervalMs - 1;

			withFixedNow(now, () => {
				store._pruneOldMessages();
			});

			expect(store.fullList.map(msg => msg.ref)).to.deep.equal(['r2']);
			expect(deletes).to.have.length(1);
			expect(deletes[0].message.ref).to.equal('r1');

			withFixedNow(now, () => {
				store._hardDeleteMessages({ force: true });
			});

			expect(store.fullList.map(msg => msg.ref)).to.deep.equal([]);
			expect(deletes).to.have.length(2);
			expect(deletes[1].message.ref).to.equal('r2');
			expect(deletes[1].options).to.deep.equal({ event: 'purge' });
		});
	});
});
