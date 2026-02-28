'use strict';

const assert = require('node:assert/strict');
const { expect } = require('chai');

const {
	DEFAULT_MAP_TYPE_MARKER,
	serializeWithMaps,
	deserializeWithMaps,
	ensureMetaObject,
	ensureBaseDir,
	createOpQueue,
	shouldDispatchByAudienceChannels,
} = require('./MsgUtils');

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function createAdapterStub(overrides = {}) {
	const calls = {
		getObjectAsync: [],
		setObjectAsync: [],
		mkdirAsync: [],
	};

	const adapter = {
		name: 'msghub',
		async getObjectAsync(id) {
			calls.getObjectAsync.push(id);
			return null;
		},
		async setObjectAsync(id, obj) {
			calls.setObjectAsync.push({ id, obj });
		},
		async mkdirAsync(metaId, dir) {
			calls.mkdirAsync.push({ metaId, dir });
		},
		...overrides,
	};

	return { adapter, calls };
}

describe('MsgUtils', () => {
	describe('DEFAULT_MAP_TYPE_MARKER', () => {
		it('is the expected default marker string', () => {
			assert.equal(DEFAULT_MAP_TYPE_MARKER, '__msghubType');
		});
	});

	describe('serializeWithMaps', () => {
		it('serializes plain JSON without modification', () => {
			const value = { a: 1, b: 'x', c: [true, null], d: { e: 5 } };
			const text = serializeWithMaps(value);
			assert.equal(typeof text, 'string');
			assert.deepStrictEqual(JSON.parse(text), value);
		});

		it('encodes Maps with the default marker', () => {
			const value = {
				m: new Map([
					['a', 1],
					['b', { nested: true }],
				]),
			};

			const text = serializeWithMaps(value);
			const parsed = JSON.parse(text);

			assert.deepStrictEqual(parsed, {
				m: {
					[DEFAULT_MAP_TYPE_MARKER]: 'Map',
					value: [
						['a', 1],
						['b', { nested: true }],
					],
				},
			});
		});

		it('encodes a root Map', () => {
			const value = new Map([
				['x', 1],
				['y', 2],
			]);

			const text = serializeWithMaps(value);
			const parsed = JSON.parse(text);

			assert.deepStrictEqual(parsed, {
				[DEFAULT_MAP_TYPE_MARKER]: 'Map',
				value: [
					['x', 1],
					['y', 2],
				],
			});
		});

		it('encodes nested Maps recursively', () => {
			const inner = new Map([
				['k', 'v'],
				['n', 2],
			]);

			const value = {
				outer: new Map([['inner', inner]]),
			};

			const text = serializeWithMaps(value);
			const revived = deserializeWithMaps(text);

			assert.ok(revived.outer instanceof Map);
			assert.ok(revived.outer.get('inner') instanceof Map);
			assert.deepStrictEqual(Array.from(revived.outer.get('inner').entries()), Array.from(inner.entries()));
		});

		it('supports a custom marker key', () => {
			const marker = '__customMarker';
			const value = { m: new Map([['a', 1]]) };

			const text = serializeWithMaps(value, marker);
			const parsed = JSON.parse(text);

			assert.deepStrictEqual(parsed, {
				m: {
					[marker]: 'Map',
					value: [['a', 1]],
				},
			});
		});
	});

	describe('deserializeWithMaps', () => {
		it('revives Maps encoded with the default marker', () => {
			const input = JSON.stringify({
				m: {
					[DEFAULT_MAP_TYPE_MARKER]: 'Map',
					value: [
						['a', 1],
						['b', 2],
					],
				},
			});

			const output = deserializeWithMaps(input);
			assert.ok(output.m instanceof Map);
			assert.deepStrictEqual(Array.from(output.m.entries()), [
				['a', 1],
				['b', 2],
			]);
		});

		it('revives a root Map encoded with the default marker', () => {
			const input = JSON.stringify({
				[DEFAULT_MAP_TYPE_MARKER]: 'Map',
				value: [
					['a', 1],
					['b', 2],
				],
			});

			const output = deserializeWithMaps(input);
			assert.ok(output instanceof Map);
			assert.deepStrictEqual(Array.from(output.entries()), [
				['a', 1],
				['b', 2],
			]);
		});

		it('ignores non-Map-like objects (missing/invalid "value")', () => {
			const input = JSON.stringify({
				m1: { [DEFAULT_MAP_TYPE_MARKER]: 'Map' },
				m2: { [DEFAULT_MAP_TYPE_MARKER]: 'Map', value: 'nope' },
				m3: { [DEFAULT_MAP_TYPE_MARKER]: 'Map', value: { a: 1 } },
			});

			const output = deserializeWithMaps(input);
			assert.deepStrictEqual(output, {
				m1: { [DEFAULT_MAP_TYPE_MARKER]: 'Map' },
				m2: { [DEFAULT_MAP_TYPE_MARKER]: 'Map', value: 'nope' },
				m3: { [DEFAULT_MAP_TYPE_MARKER]: 'Map', value: { a: 1 } },
			});
		});

		it('does not revive when the marker key does not match', () => {
			const marker = '__other';
			const input = JSON.stringify({
				m: {
					[marker]: 'Map',
					value: [['a', 1]],
				},
			});

			const output = deserializeWithMaps(input, '__different');
			assert.deepStrictEqual(output, {
				m: {
					[marker]: 'Map',
					value: [['a', 1]],
				},
			});
		});

		it('roundtrips mixed structures with nested Maps', () => {
			const value = {
				a: 1,
				b: [new Map([['x', 1]]), { c: new Map([[1, { y: 2 }]]) }],
			};

			const text = serializeWithMaps(value);
			const output = deserializeWithMaps(text);

			assert.equal(output.a, 1);
			assert.ok(output.b[0] instanceof Map);
			assert.deepStrictEqual(Array.from(output.b[0].entries()), [['x', 1]]);
			assert.ok(output.b[1].c instanceof Map);
			assert.deepStrictEqual(Array.from(output.b[1].c.entries()), [[1, { y: 2 }]]);
		});
	});

	describe('ensureMetaObject', () => {
		it('does nothing when the meta object exists and is type "meta"', async () => {
			const { adapter, calls } = createAdapterStub({
				async getObjectAsync(id) {
					calls.getObjectAsync.push(id);
					return { _id: id, type: 'meta', common: {}, native: {} };
				},
			});

			await ensureMetaObject(adapter, 'msghub.0.__files');

			assert.deepStrictEqual(calls.getObjectAsync, ['msghub.0.__files']);
			assert.deepStrictEqual(calls.setObjectAsync, []);
		});

		it('throws when an existing object is not type "meta"', async () => {
			const { adapter, calls } = createAdapterStub({
				async getObjectAsync(id) {
					calls.getObjectAsync.push(id);
					return { _id: id, type: 'state', common: {}, native: {} };
				},
			});

			await expect(ensureMetaObject(adapter, 'msghub.0.__files')).to.be.rejectedWith(
				Error,
				'File-Storage Root "msghub.0.__files" exists but is type "state", not "meta".',
			);
			assert.deepStrictEqual(calls.setObjectAsync, []);
		});

		it('creates the meta object when it does not exist', async () => {
			const { adapter, calls } = createAdapterStub();

			await ensureMetaObject(adapter, 'msghub.0.__files');

			assert.deepStrictEqual(calls.getObjectAsync, ['msghub.0.__files']);
			assert.equal(calls.setObjectAsync.length, 1);
			assert.equal(calls.setObjectAsync[0].id, 'msghub.0.__files');
			assert.deepStrictEqual(calls.setObjectAsync[0].obj, {
				type: 'meta',
				common: {
					name: 'msghub file storage',
					type: 'meta.user',
				},
				native: {},
			});
		});
	});

	describe('ensureBaseDir', () => {
		it('returns early when baseDir is falsy', async () => {
			const { adapter, calls } = createAdapterStub();
			await ensureBaseDir(adapter, 'msghub.0.__files', '');
			await ensureBaseDir(adapter, 'msghub.0.__files', null);
			await ensureBaseDir(adapter, 'msghub.0.__files', undefined);
			assert.deepStrictEqual(calls.mkdirAsync, []);
		});

		it('returns early when adapter.mkdirAsync is missing', async () => {
			const { adapter } = createAdapterStub({ mkdirAsync: undefined });
			await ensureBaseDir(adapter, 'msghub.0.__files', 'a/b');
		});

		it('creates each path segment for a simple baseDir', async () => {
			const { adapter, calls } = createAdapterStub();
			await ensureBaseDir(adapter, 'msghub.0.__files', 'a/b/c');
			assert.deepStrictEqual(calls.mkdirAsync, [
				{ metaId: 'msghub.0.__files', dir: 'a' },
				{ metaId: 'msghub.0.__files', dir: 'a/b' },
				{ metaId: 'msghub.0.__files', dir: 'a/b/c' },
			]);
		});

		it('normalizes slashes and skips empty segments', async () => {
			const { adapter, calls } = createAdapterStub();
			await ensureBaseDir(adapter, 'msghub.0.__files', '/a//b/');
			assert.deepStrictEqual(calls.mkdirAsync, [
				{ metaId: 'msghub.0.__files', dir: 'a' },
				{ metaId: 'msghub.0.__files', dir: 'a/b' },
			]);
		});

		it('continues when mkdirAsync fails for some segments', async () => {
			const { adapter, calls } = createAdapterStub({
				async mkdirAsync(metaId, dir) {
					calls.mkdirAsync.push({ metaId, dir });
					if (dir === 'a') throw new Error('backend does not support mkdir');
				},
			});

			await ensureBaseDir(adapter, 'msghub.0.__files', 'a/b/c');
			assert.deepStrictEqual(calls.mkdirAsync, [
				{ metaId: 'msghub.0.__files', dir: 'a' },
				{ metaId: 'msghub.0.__files', dir: 'a/b' },
				{ metaId: 'msghub.0.__files', dir: 'a/b/c' },
			]);
		});
	});

	describe('createOpQueue', () => {
		it('returns a queue function with a current promise', () => {
			const queue = createOpQueue();
			assert.equal(typeof queue, 'function');
			assert.ok(queue.current instanceof Promise);
		});

		it('runs operations sequentially (no overlap)', async () => {
			const queue = createOpQueue();
			const events = [];

			const op1 = queue(async () => {
				events.push('op1:start');
				await delay(30);
				events.push('op1:end');
				return 1;
			});

			const op2 = queue(async () => {
				events.push('op2:start');
				await delay(5);
				events.push('op2:end');
				return 2;
			});

			assert.strictEqual(queue.current, op2);
			assert.equal(await op1, 1);
			assert.equal(await op2, 2);
			assert.deepStrictEqual(events, ['op1:start', 'op1:end', 'op2:start', 'op2:end']);
		});

		it('continues processing even if an operation rejects', async () => {
			const queue = createOpQueue();
			const events = [];

			const op1 = queue(async () => {
				events.push('op1:start');
				await delay(5);
				events.push('op1:error');
				throw new Error('boom');
			});

			const op2 = queue(async () => {
				events.push('op2:start');
				await delay(5);
				events.push('op2:end');
				return 'ok';
			});

			await expect(op1).to.be.rejectedWith(Error, 'boom');
			await expect(op2).to.eventually.equal('ok');
			assert.deepStrictEqual(events, ['op1:start', 'op1:error', 'op2:start', 'op2:end']);
		});
	});

	describe('shouldDispatchByAudienceChannels', () => {
		it('treats plugin channel "*" and "all" as match-all (ignores include/exclude)', () => {
			const msg = { audience: { channels: { include: ['x'], exclude: ['x'] } } };
			expect(shouldDispatchByAudienceChannels(msg, '*')).to.equal(true);
			expect(shouldDispatchByAudienceChannels(msg, 'all')).to.equal(true);
			expect(shouldDispatchByAudienceChannels(msg, ' All ')).to.equal(true);
		});

		it('treats empty plugin channel as unscoped-only', () => {
			expect(shouldDispatchByAudienceChannels({ audience: { channels: { include: ['x'] } } }, '')).to.equal(false);
			expect(shouldDispatchByAudienceChannels({ audience: { channels: { exclude: ['x'] } } }, '')).to.equal(true);
			expect(shouldDispatchByAudienceChannels({}, '')).to.equal(true);
		});

		it('applies include/exclude for non-empty plugin channels', () => {
			expect(shouldDispatchByAudienceChannels({ audience: { channels: { include: ['push'] } } }, 'push')).to.equal(true);
			expect(shouldDispatchByAudienceChannels({ audience: { channels: { include: ['other'] } } }, 'push')).to.equal(false);
			expect(shouldDispatchByAudienceChannels({ audience: { channels: { exclude: ['push'] } } }, 'push')).to.equal(false);
			expect(shouldDispatchByAudienceChannels({ audience: { channels: { exclude: ['PUSH'] } } }, 'push')).to.equal(false);
		});
	});
});
