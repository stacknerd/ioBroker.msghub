'use strict';

const assert = require('node:assert/strict');
const { expect } = require('chai');

const {
	buildLogApi,
	buildI18nApi,
	buildIoBrokerApi,
	buildIdsApi,
	buildStoreApi,
	buildActionApi,
	buildFactoryApi,
	buildStatsApi,
} = require('./MsgHostApi');
const { MsgConstants } = require('./MsgConstants');

function createAdapterStub(overrides = {}) {
	const calls = {
		log: { silly: [], debug: [], info: [], warn: [], error: [] },
		objects: [],
		states: [],
		files: [],
		subscribe: [],
		sendTo: [],
	};

	const adapter = {
		namespace: 'msghub.0',
		log: {
			silly: msg => calls.log.silly.push(String(msg)),
			debug: msg => calls.log.debug.push(String(msg)),
			info: msg => calls.log.info.push(String(msg)),
			warn: msg => calls.log.warn.push(String(msg)),
			error: msg => calls.log.error.push(String(msg)),
		},
		...overrides,
	};

	return { adapter, calls };
}

describe('MsgHostApi', () => {
	describe('buildLogApi', () => {
		it('logs with strict string-only methods', () => {
			const { adapter, calls } = createAdapterStub();
			const log = buildLogApi(adapter, { hostName: 'MyHost' });

			expect(Object.isFrozen(log)).to.equal(true);

			log.silly('s');
			log.debug('d');
			log.info('i');
			log.warn('w');
			log.error('e');

			expect(calls.log.silly).to.deep.equal(['s']);
			expect(calls.log.debug).to.deep.equal(['d']);
			expect(calls.log.info).to.deep.equal(['i']);
			expect(calls.log.warn).to.deep.equal(['w']);
			expect(calls.log.error).to.deep.equal(['e']);
		});

		it('throws on non-string messages and includes host+method', () => {
			const { adapter } = createAdapterStub();
			const log = buildLogApi(adapter, { hostName: '  Ingest  ' });
			expect(() => log.info(5)).to.throw(TypeError, 'Ingest: ctx.api.log.info(message) expects a string');
		});

		it('supports per-plugin prefix binding via __bindCaller', () => {
			const { adapter, calls } = createAdapterStub();
			const log = buildLogApi(adapter, { hostName: 'MyHost' });
			const bound = log.__bindCaller({ baseOwnId: 'NotifyStates.0' });

			expect(Object.isFrozen(bound)).to.equal(true);

			bound.debug('hello');
			expect(calls.log.debug).to.deep.equal(['NotifyStates.0: hello']);
		});
	});

	describe('buildI18nApi', () => {
		it('returns null when i18n is not available', () => {
			const { adapter } = createAdapterStub({ i18n: null });
			expect(buildI18nApi(adapter)).to.equal(null);
		});

		it('exposes a small i18n facade when present', () => {
			const { adapter } = createAdapterStub({
				i18n: {
					t: key => `t:${key}`,
					getTranslatedObject: obj => ({ ...obj, __t: true }),
				},
			});
			const i18n = buildI18nApi(adapter);
			expect(i18n).to.not.equal(null);
			expect(Object.isFrozen(i18n)).to.equal(true);
			expect(i18n.t('x')).to.equal('t:x');
			expect(i18n.getTranslatedObject({ a: 1 })).to.deep.equal({ a: 1, __t: true });
		});
	});

	describe('buildStoreApi', () => {
			function createStoreStub() {
				const calls = { add: 0, update: 0, addOrUpdate: 0, remove: 0, getByRef: 0, get: 0, query: 0 };
				const byRef = {};
				const store = {
					addMessage: msg => {
						calls.add += 1;
						return { ok: true, op: 'add', msg };
					},
				updateMessage: (refOrMsg, patch) => {
					calls.update += 1;
					return { ok: true, op: 'update', refOrMsg, patch };
				},
				addOrUpdateMessage: msg => {
					calls.addOrUpdate += 1;
					return { ok: true, op: 'addOrUpdate', msg };
				},
					removeMessage: ref => {
						calls.remove += 1;
						return { ok: true, op: 'remove', ref };
					},
					getMessageByRef: ref => {
						calls.getByRef += 1;
						return byRef[ref] || { ok: true, op: 'getByRef', ref };
					},
					getMessages: () => {
						calls.get += 1;
						return [{ ref: 'm1' }];
					},
					queryMessages: options => {
						calls.query += 1;
						return [{ ref: 'q1', options }];
					},
					msgConstants: {
						kind: { task: 'task', status: 'status' },
						lifecycle: { state: { deleted: 'deleted' } },
					},
				};
				return { store, calls, byRef };
			}

		it('returns null for invalid store', () => {
			expect(buildStoreApi(null, { hostName: 'MsgIngest' })).to.equal(null);
			expect(buildStoreApi(5, { hostName: 'MsgIngest' })).to.equal(null);
		});

		it('exposes read-only store api for non-Ingest hosts', () => {
			const { store, calls } = createStoreStub();
			const api = buildStoreApi(store, { hostName: 'MsgNotify' });

			expect(api).to.not.equal(null);
			expect(Object.isFrozen(api)).to.equal(true);
			expect(api).to.have.all.keys(['getMessageByRef', 'getMessages', 'queryMessages']);

			expect(api.getMessages()).to.deep.equal([{ ref: 'm1' }]);
			expect(api.getMessageByRef('r1')).to.deep.equal({ ok: true, op: 'getByRef', ref: 'r1' });
			expect(api.queryMessages({ a: 1 })[0]).to.have.property('ref', 'q1');

			expect(calls.get).to.equal(1);
			expect(calls.getByRef).to.equal(1);
			expect(calls.query).to.equal(1);
		});

			it('exposes read+write store api for Ingest hosts', () => {
				const { store, calls, byRef } = createStoreStub();
				const api = buildStoreApi(store, { hostName: 'MsgIngest' });

			expect(api).to.not.equal(null);
			expect(Object.isFrozen(api)).to.equal(true);
			expect(api).to.have.property('addMessage');
			expect(api).to.have.property('updateMessage');
			expect(api).to.have.property('addOrUpdateMessage');
			expect(api).to.have.property('removeMessage');
			expect(api).to.have.property('completeAfterCauseEliminated');

					byRef.x = { ref: 'x', kind: 'task' };
					api.addMessage({ ref: 'x' });
					api.updateMessage('x', { title: 't' });
					api.addOrUpdateMessage({ ref: 'x' });
					api.removeMessage('x');
					api.completeAfterCauseEliminated('x', { actor: 'tester' });

				expect(calls.add).to.equal(1);
				expect(calls.update).to.equal(2);
				expect(calls.addOrUpdate).to.equal(1);
				expect(calls.remove).to.equal(1);
			});

			it('completeAfterCauseEliminated: closes tasks and deletes statuses', () => {
				const { store, calls, byRef } = createStoreStub();
				const api = buildStoreApi(store, { hostName: 'MsgIngest' });

				byRef.t1 = { ref: 't1', kind: 'task' };
				byRef.s1 = { ref: 's1', kind: 'status', lifecycle: { state: 'open' } };
				byRef.other = { ref: 'other', kind: 'appointment' };

				api.completeAfterCauseEliminated('t1', { actor: 'tester' });
				api.completeAfterCauseEliminated('s1', { actor: 'tester' });
				api.completeAfterCauseEliminated('other', { actor: 'tester' });

				expect(calls.update).to.equal(1);
				expect(calls.remove).to.equal(1);
			});
		});

	describe('buildFactoryApi', () => {
		it('returns null when not Ingest host', () => {
			const msgFactory = { createMessage: () => ({}) };
			expect(buildFactoryApi(msgFactory, { hostName: 'MsgNotify' })).to.equal(null);
		});

		it('exposes createMessage for Ingest hosts', () => {
			const calls = [];
			const msgFactory = { createMessage: data => (calls.push(data), { ref: 'created', ...data }) };
			const api = buildFactoryApi(msgFactory, { hostName: 'Ingest' });
			expect(api).to.not.equal(null);
			expect(Object.isFrozen(api)).to.equal(true);
			expect(api.createMessage({ a: 1 })).to.deep.equal({ ref: 'created', a: 1 });
			expect(calls).to.deep.equal([{ a: 1 }]);
		});
	});

	describe('buildStatsApi', () => {
		it('returns null when getStats is unavailable', () => {
			expect(buildStatsApi(null)).to.equal(null);
			expect(buildStatsApi({})).to.equal(null);
		});

		it('exposes getStats when present', async () => {
			const calls = [];
			const store = {
				getStats: async options => {
					calls.push(options);
					return { hello: 'world' };
				},
			};

			const api = buildStatsApi(store);
			expect(api).to.not.equal(null);
			expect(Object.isFrozen(api)).to.equal(true);
			expect(api).to.have.property('getStats');

			const res = await api.getStats({ include: { archiveSize: true } });
			expect(res).to.deep.equal({ hello: 'world' });
			expect(calls).to.deep.equal([{ include: { archiveSize: true } }]);
		});
	});

	describe('buildIdsApi', () => {
		it('converts between full ids and own ids', () => {
			const { adapter } = createAdapterStub({ namespace: 'msghub.0' });
			const ids = buildIdsApi(adapter);

			expect(ids.namespace).to.equal('msghub.0');
			expect(ids.toOwnId('msghub.0')).to.equal('');
			expect(ids.toOwnId('msghub.0.x')).to.equal('x');
			expect(ids.toOwnId('other.0.x')).to.equal('other.0.x');
			expect(ids.toFullId('')).to.equal('msghub.0');
			expect(ids.toFullId('x')).to.equal('msghub.0.x');
			expect(ids.toFullId('msghub.0.x')).to.equal('msghub.0.x');
			expect(ids.toFullId('msghub.0')).to.equal('msghub.0');
		});

		it('falls back to identity conversion without namespace', () => {
			const ids = buildIdsApi({ namespace: '' });
			expect(ids.namespace).to.equal('');
			expect(ids.toOwnId('a.b')).to.equal('a.b');
			expect(ids.toFullId('a.b')).to.equal('a.b');
		});
	});

	describe('buildIoBrokerApi', () => {
		it('uses async adapter methods when available', async () => {
			const { adapter, calls } = createAdapterStub({
				async getObjectViewAsync(design, search, params) {
					calls.objects.push(['getObjectViewAsync', design, search, params]);
					return { rows: [{ id: 'x' }], __test: true };
				},
				async setObjectNotExistsAsync(ownId, obj) {
					calls.objects.push(['setObjectNotExistsAsync', ownId, obj]);
				},
				async delObjectAsync(ownId) {
					calls.objects.push(['delObjectAsync', ownId]);
				},
				async getForeignObjectsAsync(pattern, type) {
					calls.objects.push(['getForeignObjectsAsync', pattern, type]);
					return { a: { _id: 'a' } };
				},
				async getForeignObjectAsync(id) {
					calls.objects.push(['getForeignObjectAsync', id]);
					return { _id: id, type: 'state' };
				},
				async extendForeignObjectAsync(id, patch) {
					calls.objects.push(['extendForeignObjectAsync', id, patch]);
				},
				async setStateAsync(ownId, state) {
					calls.states.push(['setStateAsync', ownId, state]);
				},
				async setForeignStateAsync(id, state) {
					calls.states.push(['setForeignStateAsync', id, state]);
				},
				async getForeignStateAsync(id) {
					calls.states.push(['getForeignStateAsync', id]);
					return { val: 1, ack: true };
				},
				subscribeStates(pattern) {
					calls.subscribe.push(['subscribeStates', pattern]);
				},
				unsubscribeStates(pattern) {
					calls.subscribe.push(['unsubscribeStates', pattern]);
				},
				subscribeObjects(pattern) {
					calls.subscribe.push(['subscribeObjects', pattern]);
				},
				unsubscribeObjects(pattern) {
					calls.subscribe.push(['unsubscribeObjects', pattern]);
				},
				subscribeForeignStates(pattern) {
					calls.subscribe.push(['subscribeForeignStates', pattern]);
				},
				unsubscribeForeignStates(pattern) {
					calls.subscribe.push(['unsubscribeForeignStates', pattern]);
				},
				subscribeForeignObjects(pattern) {
					calls.subscribe.push(['subscribeForeignObjects', pattern]);
				},
					unsubscribeForeignObjects(pattern) {
						calls.subscribe.push(['unsubscribeForeignObjects', pattern]);
					},
					async readFileAsync(metaId, fileName) {
						calls.files.push(['readFileAsync', metaId, fileName]);
						return { file: Buffer.from('x'), mimeType: 'application/pdf' };
					},
					async writeFileAsync(metaId, fileName, data) {
						calls.files.push(['writeFileAsync', metaId, fileName, data]);
					},
					async mkdirAsync(metaId, dirName) {
						calls.files.push(['mkdirAsync', metaId, dirName]);
					},
					async delFileAsync(metaId, fileName) {
						calls.files.push(['delFileAsync', metaId, fileName]);
					},
					async renameFileAsync(metaId, oldName, newName) {
						calls.files.push(['renameFileAsync', metaId, oldName, newName]);
					},
				});

			const api = buildIoBrokerApi(adapter, { hostName: 'MyHost' });
				expect(Object.isFrozen(api)).to.equal(true);
				expect(Object.isFrozen(api.objects)).to.equal(true);
				expect(Object.isFrozen(api.states)).to.equal(true);
				expect(Object.isFrozen(api.files)).to.equal(true);
				expect(Object.isFrozen(api.subscribe)).to.equal(true);

			await api.objects.setObjectNotExists('x', { type: 'state' });
			await api.objects.delObject('x');
			const view = await api.objects.getObjectView('system', 'custom', { startkey: 'a', endkey: 'b' });
			const objs = await api.objects.getForeignObjects('system.*');
			const enumObjs = await api.objects.getForeignObjects('enum.rooms.*', 'enum');
			const obj = await api.objects.getForeignObject('system.adapter.test');
			await api.objects.extendForeignObject('system.adapter.test', { common: { name: 'x' } });
			await api.states.setState('x', { val: 2, ack: true });
			await api.states.setForeignState('some.0.y', { val: 3, ack: false });
			const state = await api.states.getForeignState('system.adapter.test.alive');

			assert.deepStrictEqual(objs, { a: { _id: 'a' } });
			assert.deepStrictEqual(enumObjs, { a: { _id: 'a' } });
			assert.deepStrictEqual(obj, { _id: 'system.adapter.test', type: 'state' });
			assert.deepStrictEqual(state, { val: 1, ack: true });
			assert.deepStrictEqual(view, { rows: [{ id: 'x' }], __test: true });

				api.subscribe.subscribeStates('*');
				api.subscribe.unsubscribeForeignObjects('*');

				const pdf = Buffer.from('%PDF');
				const read = await api.files.readFile('msghub.0', 'documents/x.pdf');
				await api.files.mkdir('msghub.0', 'documents');
				await api.files.writeFile('msghub.0', 'documents/x.pdf', pdf);
				await api.files.renameFile('msghub.0', 'documents/x.pdf', 'documents/y.pdf');
				await api.files.deleteFile('msghub.0', 'documents/y.pdf');

				expect(calls.objects).to.deep.equal([
					['setObjectNotExistsAsync', 'x', { type: 'state' }],
					['delObjectAsync', 'x'],
					['getObjectViewAsync', 'system', 'custom', { startkey: 'a', endkey: 'b' }],
				['getForeignObjectsAsync', 'system.*', undefined],
				['getForeignObjectsAsync', 'enum.rooms.*', 'enum'],
				['getForeignObjectAsync', 'system.adapter.test'],
				['extendForeignObjectAsync', 'system.adapter.test', { common: { name: 'x' } }],
			]);
				expect(calls.states).to.deep.equal([
					['setStateAsync', 'x', { val: 2, ack: true }],
					['setForeignStateAsync', 'some.0.y', { val: 3, ack: false }],
					['getForeignStateAsync', 'system.adapter.test.alive'],
				]);
				expect(calls.files).to.deep.equal([
					['readFileAsync', 'msghub.0', 'documents/x.pdf'],
					['mkdirAsync', 'msghub.0', 'documents'],
					['writeFileAsync', 'msghub.0', 'documents/x.pdf', pdf],
					['renameFileAsync', 'msghub.0', 'documents/x.pdf', 'documents/y.pdf'],
					['delFileAsync', 'msghub.0', 'documents/y.pdf'],
				]);
				expect(read).to.deep.equal({ file: Buffer.from('x'), mimeType: 'application/pdf' });
				expect(calls.subscribe).to.deep.equal([
					['subscribeStates', '*'],
					['unsubscribeForeignObjects', '*'],
				]);
			});

		it('binds subscribe methods to the adapter instance', () => {
				const { adapter } = createAdapterStub({
					_subscribeStates: [],
					subscribeStates(pattern) {
						this._subscribeStates.push(pattern);
					},
					_unsubscribeStates: [],
					unsubscribeStates(pattern) {
						this._unsubscribeStates.push(pattern);
					},
					_subscribeForeignStates: [],
					subscribeForeignStates(pattern) {
						this._subscribeForeignStates.push(pattern);
					},
					_unsubscribeForeignStates: [],
					unsubscribeForeignStates(pattern) {
						this._unsubscribeForeignStates.push(pattern);
					},
					_subscribeForeignObjects: [],
					subscribeForeignObjects(pattern) {
						this._subscribeForeignObjects.push(pattern);
					},
					_unsubscribeForeignObjects: [],
					unsubscribeForeignObjects(pattern) {
						this._unsubscribeForeignObjects.push(pattern);
					},
					_subscribeObjects: [],
					subscribeObjects(pattern) {
						this._subscribeObjects.push(pattern);
					},
					_unsubscribeObjects: [],
					unsubscribeObjects(pattern) {
						this._unsubscribeObjects.push(pattern);
					},
				});

				const api = buildIoBrokerApi(adapter, { hostName: 'MyHost' });
				api.subscribe.subscribeStates('a');
				api.subscribe.unsubscribeStates('b');
				api.subscribe.subscribeObjects('c');
				api.subscribe.unsubscribeObjects('d');
				api.subscribe.subscribeForeignStates('e');
				api.subscribe.unsubscribeForeignStates('f');
				api.subscribe.subscribeForeignObjects('g');
				api.subscribe.unsubscribeForeignObjects('h');

				expect(adapter._subscribeStates).to.deep.equal(['a']);
				expect(adapter._unsubscribeStates).to.deep.equal(['b']);
				expect(adapter._subscribeObjects).to.deep.equal(['c']);
				expect(adapter._unsubscribeObjects).to.deep.equal(['d']);
				expect(adapter._subscribeForeignStates).to.deep.equal(['e']);
				expect(adapter._unsubscribeForeignStates).to.deep.equal(['f']);
				expect(adapter._subscribeForeignObjects).to.deep.equal(['g']);
				expect(adapter._unsubscribeForeignObjects).to.deep.equal(['h']);
		});

		it('wraps callback-based adapter methods into promises', async () => {
				const { adapter, calls } = createAdapterStub({
					getObjectView(design, search, params, cb) {
						calls.objects.push(['getObjectView', design, search, params]);
						cb(null, { rows: [{ id: 'y' }] });
					},
					setObjectNotExists(ownId, obj, cb) {
						calls.objects.push(['setObjectNotExists', ownId, obj]);
					cb(null);
				},
				delObject(ownId, cb) {
					calls.objects.push(['delObject', ownId]);
					cb(null);
				},
				getForeignObjects(pattern, typeOrCb, cbMaybe) {
					if (typeof typeOrCb === 'function') {
						calls.objects.push(['getForeignObjects', pattern, undefined]);
						typeOrCb(null, { x: { _id: 'x' } });
						return;
					}
					calls.objects.push(['getForeignObjects', pattern, typeOrCb]);
					cbMaybe(null, { x: { _id: 'x' } });
				},
				getForeignObject(id, cb) {
					calls.objects.push(['getForeignObject', id]);
					cb(null, { _id: id });
				},
				extendForeignObject(id, patch, cb) {
					calls.objects.push(['extendForeignObject', id, patch]);
					cb(null);
				},
				setState(ownId, state, cb) {
					calls.states.push(['setState', ownId, state]);
					cb(null);
				},
				setForeignState(id, state, cb) {
					calls.states.push(['setForeignState', id, state]);
					cb(null);
				},
					getForeignState(id, cb) {
						calls.states.push(['getForeignState', id]);
						cb(null, { val: 3 });
					},
					readFile(metaId, fileName, cb) {
						calls.files.push(['readFile', metaId, fileName]);
						cb(null, { file: Buffer.from('y'), mimeType: 'application/pdf' });
					},
					writeFile(metaId, fileName, data, cb) {
						calls.files.push(['writeFile', metaId, fileName, data]);
						cb(null);
					},
					mkdir(metaId, dirName, cb) {
						calls.files.push(['mkdir', metaId, dirName]);
						cb(null);
					},
					renameFile(metaId, oldName, newName, cb) {
						calls.files.push(['renameFile', metaId, oldName, newName]);
						cb(null);
					},
					delFile(metaId, fileName, cb) {
						calls.files.push(['delFile', metaId, fileName]);
						cb(null);
					},
				});

			const api = buildIoBrokerApi(adapter, { hostName: 'MyHost' });

			await api.objects.setObjectNotExists('x', { type: 'state' });
			await api.objects.delObject('x');
			expect(await api.objects.getObjectView('system', 'custom', { startkey: 'a' })).to.deep.equal({
				rows: [{ id: 'y' }],
			});
			expect(await api.objects.getForeignObjects('*')).to.deep.equal({ x: { _id: 'x' } });
			expect(await api.objects.getForeignObjects('enum.rooms.*', 'enum')).to.deep.equal({ x: { _id: 'x' } });
			expect(await api.objects.getForeignObject('id')).to.deep.equal({ _id: 'id' });
			await api.objects.extendForeignObject('id', { common: {} });
				await api.states.setState('x', { val: 1, ack: true });
				await api.states.setForeignState('some.0.y', { val: 2, ack: false });
				expect(await api.states.getForeignState('id')).to.deep.equal({ val: 3 });

				const pdf = Buffer.from('%PDF');
				const read = await api.files.readFile('msghub.0', 'documents/x.pdf');
				await api.files.mkdir('msghub.0', 'documents');
				await api.files.writeFile('msghub.0', 'documents/x.pdf', pdf);
				await api.files.renameFile('msghub.0', 'documents/x.pdf', 'documents/y.pdf');
				await api.files.deleteFile('msghub.0', 'documents/y.pdf');

				expect(calls.objects).to.deep.equal([
					['setObjectNotExists', 'x', { type: 'state' }],
					['delObject', 'x'],
					['getObjectView', 'system', 'custom', { startkey: 'a' }],
				['getForeignObjects', '*', undefined],
				['getForeignObjects', 'enum.rooms.*', 'enum'],
				['getForeignObject', 'id'],
				['extendForeignObject', 'id', { common: {} }],
			]);
				expect(calls.states).to.deep.equal([
					['setState', 'x', { val: 1, ack: true }],
					['setForeignState', 'some.0.y', { val: 2, ack: false }],
					['getForeignState', 'id'],
				]);
				expect(calls.files).to.deep.equal([
					['readFile', 'msghub.0', 'documents/x.pdf'],
					['mkdir', 'msghub.0', 'documents'],
					['writeFile', 'msghub.0', 'documents/x.pdf', pdf],
					['renameFile', 'msghub.0', 'documents/x.pdf', 'documents/y.pdf'],
					['delFile', 'msghub.0', 'documents/y.pdf'],
				]);
				expect(read).to.deep.equal({ file: Buffer.from('y'), mimeType: 'application/pdf' });
			});

		it('wraps adapter.sendTo into a promise and passes through the response', async () => {
			const { adapter, calls } = createAdapterStub({
				sendTo(instance, command, message, cb) {
					calls.sendTo.push([this === adapter, instance, command, message]);
					cb({ ok: true, instance, command });
				},
			});

			const api = buildIoBrokerApi(adapter, { hostName: 'MyHost' });

			const res = await api.sendTo('target.0', 'do', { a: 1 }, { timeoutMs: 500 });
			expect(res).to.deep.equal({ ok: true, instance: 'target.0', command: 'do' });
			expect(calls.sendTo).to.deep.equal([[true, 'target.0', 'do', { a: 1 }]]);
		});

		it('rejects when adapter.sendTo does not answer before the timeout', async () => {
			const { adapter } = createAdapterStub({
				sendTo(_instance, _command, _message, _cb) {
					// never answers
				},
			});

			const api = buildIoBrokerApi(adapter, { hostName: 'MyHost' });

			let err = null;
			try {
				await api.sendTo('target.0', 'do', { a: 1 }, { timeoutMs: 10 });
			} catch (e) {
				err = e;
			}

			expect(err).to.be.instanceOf(Error);
			expect(err.message).to.include("MyHost: adapter.sendTo('target.0', 'do', ...) timed out after 10ms");
		});

		it('throws on invalid sendTo arguments', () => {
			const { adapter } = createAdapterStub({
				sendTo() {},
			});

			const api = buildIoBrokerApi(adapter, { hostName: 'MyHost' });
			expect(() => api.sendTo('', 'x', {})).to.throw(TypeError, 'MyHost: ctx.api.iobroker.sendTo');
			expect(() => api.sendTo('x', '', {})).to.throw(TypeError, 'MyHost: ctx.api.iobroker.sendTo');
			expect(() => api.sendTo('msghub.0', 'x', {})).to.throw(Error, "cannot target own namespace ('msghub.0')");
		});

			it('throws when a required adapter method is missing', () => {
				const { adapter } = createAdapterStub({});
				const api = buildIoBrokerApi(adapter, { hostName: 'MyHost' });
				expect(() => api.subscribe.subscribeStates('*')).to.throw('MyHost: adapter.subscribeStates is not available');
				expect(() => api.objects.getObjectView('system', 'custom', {})).to.throw(
					'MyHost: adapter.getObjectView is not available',
				);
				expect(() => api.states.setForeignState('x', { val: 1 })).to.throw(
					'MyHost: adapter.setForeignState is not available',
				);
				expect(() => api.objects.setObjectNotExists('x', {})).to.throw(
					'MyHost: adapter.setObjectNotExists is not available',
				);
				expect(() => api.files.writeFile('msghub.0', 'x.txt', 'x')).to.throw(
					'MyHost: adapter.writeFile is not available',
				);
			});
	});

	describe('buildActionApi', () => {
		it('returns null unless hostName contains \"Engage\"', () => {
			const { adapter } = createAdapterStub();
			const store = { getMessageByRef: () => null, updateMessage: () => true };
			expect(buildActionApi(adapter, MsgConstants, store, { hostName: 'MsgNotify' })).to.equal(null);
		});

		it('returns null when store lacks required methods', () => {
			const { adapter } = createAdapterStub();
			expect(buildActionApi(adapter, MsgConstants, {}, { hostName: 'MsgEngage' })).to.equal(null);
		});

		it('builds an action executor for Engage hosts', () => {
			const { adapter } = createAdapterStub();
			const calls = { getByRef: 0, update: 0 };
			const store = {
				getMessageByRef(ref) {
					calls.getByRef += 1;
					expect(ref).to.equal('r1');
					return null;
				},
				updateMessage() {
					calls.update += 1;
					return true;
				},
			};

			const api = buildActionApi(adapter, MsgConstants, store, { hostName: 'MsgEngage' });
			expect(api).to.not.equal(null);
			expect(Object.isFrozen(api)).to.equal(true);
			expect(api).to.have.property('execute');
			expect(api.execute({ ref: 'r1', actionId: 'a1' })).to.equal(false);
			expect(calls.getByRef).to.equal(1);
		});

		it('logs a warning and returns null when MsgAction cannot be required', () => {
			const Module = require('node:module');
			const originalLoad = Module._load;

			const { adapter, calls } = createAdapterStub();
			const store = { getMessageByRef: () => null, updateMessage: () => true };

			Module._load = function (request, parent, isMain) {
				if (typeof request === 'string' && request.includes(`${__dirname}/MsgAction`)) {
					throw new Error('boom');
				}
				return originalLoad.call(this, request, parent, isMain);
			};

			try {
				const api = buildActionApi(adapter, MsgConstants, store, { hostName: 'MsgEngage' });
				expect(api).to.equal(null);
			} finally {
				Module._load = originalLoad;
			}

			expect(calls.log.warn).to.have.length(1);
			expect(calls.log.warn[0]).to.include('MsgEngage: failed to build ctx.api.action');
			expect(calls.log.warn[0]).to.include('boom');
		});
	});
});
