'use strict';

const { expect } = require('chai');
const { MsgStorage } = require('./MsgStorage');
const { IoStorageIobroker } = require('../lib/IoStorageIobroker');

function createAdapter({ withRename = true } = {}) {
	const files = new Map();
	const objects = new Map();
	const logs = { debug: [], warn: [] };

	const adapter = {
		name: 'msghub',
		namespace: 'msghub.0',
		log: {
			debug: msg => logs.debug.push(msg),
			warn: msg => logs.warn.push(msg),
		},
		getObjectAsync: async id => objects.get(id),
		setObjectAsync: async (id, obj) => {
			objects.set(id, obj);
		},
		readFileAsync: async (metaId, fileName) => {
			const key = `${metaId}/${fileName}`;
			if (!files.has(key)) {
				throw new Error('ENOENT');
			}
			return { file: Buffer.from(files.get(key)) };
		},
		writeFileAsync: async (metaId, fileName, data) => {
			const key = `${metaId}/${fileName}`;
			files.set(key, data);
		},
		delFileAsync: async (metaId, fileName) => {
			const key = `${metaId}/${fileName}`;
			if (!files.has(key)) {
				throw new Error('ENOENT');
			}
			files.delete(key);
		},
	};

	if (withRename) {
		adapter.renameFileAsync = async (metaId, from, to) => {
			const fromKey = `${metaId}/${from}`;
			const toKey = `${metaId}/${to}`;
			if (!files.has(fromKey)) {
				throw new Error('ENOENT');
			}
			const data = files.get(fromKey);
			files.set(toKey, data);
			files.delete(fromKey);
		};
	}

	return { adapter, files, objects, logs };
}

function createStorage(adapter, options = {}) {
	const opt = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
	const baseDir = typeof opt.baseDir === 'string' ? opt.baseDir : '';
	return new MsgStorage(adapter, {
		...opt,
		createStorageBackend: () =>
			new IoStorageIobroker({
				adapter,
				metaId: adapter.namespace,
				baseDir,
			}),
	});
}

describe('MsgStorage', () => {
	it('creates a meta object on init when missing', async () => {
		const { adapter, objects } = createAdapter();
		const storage = createStorage(adapter);
		await storage.init();

		const meta = objects.get(adapter.namespace);
		expect(meta).to.be.an('object');
		expect(meta.type).to.equal('meta');
	});

	it('throws if the meta object exists with the wrong type', async () => {
		const { adapter, objects } = createAdapter();
		objects.set(adapter.namespace, { type: 'state' });
		const storage = createStorage(adapter);

		try {
			await storage.init();
			throw new Error('expected init to throw');
		} catch (err) {
			expect(err).to.be.instanceOf(Error);
		}
	});

	it('returns fallback when file is missing', async () => {
		const { adapter } = createAdapter();
		const storage = createStorage(adapter);
		await storage.init();

		const fallback = { ok: true };
		const data = await storage.readJson(fallback);
		expect(data).to.equal(fallback);
	});

	it('returns fallback when file contains invalid JSON', async () => {
		const { adapter, files } = createAdapter();
		const storage = createStorage(adapter);
		await storage.init();

		files.set(`${adapter.namespace}/messages.json`, '{ invalid');
		const data = await storage.readJson({ ok: true });
		expect(data).to.deep.equal({ ok: true });
	});

	it('reads and parses JSON from the file store', async () => {
		const { adapter, files } = createAdapter();
		const storage = createStorage(adapter);
		await storage.init();

		files.set(`${adapter.namespace}/messages.json`, JSON.stringify({ a: 1, b: 'x' }));
		const data = await storage.readJson();
		expect(data).to.deep.equal({ a: 1, b: 'x' });
	});

	it('preserves Map values during write and read', async () => {
		const { adapter } = createAdapter();
		const storage = createStorage(adapter, { writeIntervalMs: 0 });
		await storage.init();

		const metrics = new Map([['temp', { val: 1, unit: 'C', ts: Date.UTC(2025, 0, 1) }]]);
		await storage.writeJson({ metrics });
		const data = await storage.readJson();

		expect(data.metrics).to.be.instanceOf(Map);
		expect(data.metrics.get('temp')).to.deep.equal({ val: 1, unit: 'C', ts: Date.UTC(2025, 0, 1) });
	});

	it('writes JSON via rename when supported', async () => {
		const { adapter, files } = createAdapter({ withRename: true });
		const storage = createStorage(adapter, { writeIntervalMs: 0 });
		await storage.init();

		await storage.writeJson({ a: 1 });
		const key = `${adapter.namespace}/messages.json`;
		expect(files.has(key)).to.equal(true);
		expect(JSON.parse(files.get(key))).to.deep.equal({ a: 1 });
		expect(files.has(`${adapter.namespace}/messages.json.tmp`)).to.equal(false);
	});

	it('stores files under baseDir when configured', async () => {
		const { adapter, files } = createAdapter({ withRename: true });
		const storage = createStorage(adapter, { baseDir: 'data', writeIntervalMs: 0 });
		await storage.init();

		await storage.writeJson({ a: 1 });
		const key = `${adapter.namespace}/data/messages.json`;
		expect(files.has(key)).to.equal(true);
		expect(JSON.parse(files.get(key))).to.deep.equal({ a: 1 });
	});

	it('writes JSON directly when rename is not supported', async () => {
		const { adapter, files } = createAdapter({ withRename: false });
		const storage = createStorage(adapter, { writeIntervalMs: 0 });
		await storage.init();

		await storage.writeJson({ a: 2 });
		const key = `${adapter.namespace}/messages.json`;
		expect(files.has(key)).to.equal(true);
		expect(JSON.parse(files.get(key))).to.deep.equal({ a: 2 });
	});

	it('throttles writes and persists only the latest value', async () => {
		const { adapter, files } = createAdapter();
		const storage = createStorage(adapter, { writeIntervalMs: 50 });
		await storage.init();

		const p1 = storage.writeJson({ a: 1 });
		const p2 = storage.writeJson({ a: 2 });
		await storage.flushPending();
		await Promise.all([p1, p2]);

		const key = `${adapter.namespace}/messages.json`;
		expect(JSON.parse(files.get(key))).to.deep.equal({ a: 2 });
	});

	it('does not write immediately when throttled, but flushPending persists latest value', async () => {
		const { adapter, files } = createAdapter();
		const storage = createStorage(adapter, { writeIntervalMs: 100 });
		await storage.init();

		const p1 = storage.writeJson({ a: 1 });
		const p2 = storage.writeJson({ a: 2 });
		const key = `${adapter.namespace}/messages.json`;
		expect(files.has(key)).to.equal(false);

		await storage.flushPending();
		await Promise.all([p1, p2]);

		expect(JSON.parse(files.get(key))).to.deep.equal({ a: 2 });
	});

	it('writes after the throttle interval without flushPending', async () => {
		const { adapter, files } = createAdapter();
		const storage = createStorage(adapter, { writeIntervalMs: 20 });
		await storage.init();

		const p1 = storage.writeJson({ a: 1 });
		const p2 = storage.writeJson({ a: 2 });
		await Promise.all([p1, p2]);

		const key = `${adapter.namespace}/messages.json`;
		expect(JSON.parse(files.get(key))).to.deep.equal({ a: 2 });
	});

	it('exposes status with lastPersistedAt after write', async () => {
		const { adapter } = createAdapter({ withRename: false });
		const storage = createStorage(adapter, { writeIntervalMs: 0 });
		await storage.init();

		await storage.writeJson({ a: 1 });
		const status = storage.getStatus();
		expect(status).to.have.property('filePath');
		expect(status).to.have.property('lastPersistedAt');
		expect(status.lastPersistedAt).to.be.a('number');
		expect(status.lastPersistedAt).to.be.greaterThan(0);
		expect(status.pending).to.equal(false);
	});
});
