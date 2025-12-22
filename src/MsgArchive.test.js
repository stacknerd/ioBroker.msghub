'use strict';

const { expect } = require('chai');
const { MsgArchive } = require('./MsgArchive');

function createAdapter({ withMkdir = true } = {}) {
	const files = new Map();
	const objects = new Map();
	const logs = { debug: [], warn: [] };
	const mkdirs = [];

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
	};

	if (withMkdir) {
		adapter.mkdirAsync = async (metaId, dir) => {
			mkdirs.push(`${metaId}/${dir}`);
		};
	}

	return { adapter, files, objects, logs, mkdirs };
}

function readJsonl(files, key) {
	const raw = files.get(key) || '';
	return raw
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

describe('MsgArchive', () => {
	it('creates meta object and base dir on init', async () => {
		const { adapter, objects, mkdirs } = createAdapter({ withMkdir: true });
		const archive = new MsgArchive(adapter, { baseDir: 'archive' });

		await archive.init();

		const meta = objects.get(adapter.namespace);
		expect(meta).to.be.an('object');
		expect(meta.type).to.equal('meta');
		expect(mkdirs).to.deep.equal([`${adapter.namespace}/archive`]);
	});

	it('writes a snapshot event as JSONL', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const originalNow = Date.now;
		Date.now = () => 123456;
		try {
			const message = {
				ref: 'a1',
				title: 'hello',
				metrics: new Map([['temp', { val: 21.7, unit: 'C', ts: 1700000 }]]),
			};
			await archive.appendSnapshot(message);

			const key = `${adapter.namespace}/archive/a1.jsonl`;
			const lines = readJsonl(files, key);
			expect(lines).to.have.length(1);
			expect(lines[0].event).to.equal('create');
			expect(lines[0].ref).to.equal('a1');
			expect(lines[0].ts).to.equal(123456);
			expect(lines[0].snapshot).to.be.an('object');
			expect(lines[0].snapshot.metrics.__msghubType).to.equal('Map');
		} finally {
			Date.now = originalNow;
		}
	});

	it('supports overriding the snapshot event name', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		await archive.appendSnapshot({ ref: 'e1', title: 'x' }, { event: 'snapshot' });

		const key = `${adapter.namespace}/archive/e1.jsonl`;
		const lines = readJsonl(files, key);
		expect(lines).to.have.length(1);
		expect(lines[0].event).to.equal('snapshot');
	});

	it('appends patch and delete events to the same ref file', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const ref = 'a/1';
		await archive.appendPatch(ref, { text: 'patch-1' });
		await archive.appendDelete({ ref, title: 'bye' });

		const key = `${adapter.namespace}/archive/a%2F1.jsonl`;
		const lines = readJsonl(files, key);
		expect(lines).to.have.length(2);
		expect(lines[0].event).to.equal('patch');
		expect(lines[1].event).to.equal('delete');
		expect(lines[1].snapshot.title).to.equal('bye');
	});

	it('allows delete by ref without snapshot payload', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		await archive.appendDelete('e2');

		const key = `${adapter.namespace}/archive/e2.jsonl`;
		const lines = readJsonl(files, key);
		expect(lines).to.have.length(1);
		expect(lines[0].event).to.equal('delete');
		expect('snapshot' in lines[0]).to.equal(false);
	});

	it('logs and resolves when ref is missing (default behavior)', async () => {
		const { adapter, files, logs } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		await archive.appendPatch('  ', { a: 1 });
		expect(logs.warn).to.have.length(1);
		expect(files.size).to.equal(0);
	});

	it('rejects when throwOnError is enabled', async () => {
		const { adapter, logs } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		try {
			await archive.appendPatch('', { a: 1 }, { throwOnError: true });
			throw new Error('expected appendPatch to reject');
		} catch (err) {
			expect(err).to.be.instanceOf(Error);
			expect(logs.warn).to.have.length(1);
		}
	});

	it('flushes immediately when flushNow is set', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 1000 });
		await archive.init();

		await archive.appendPatch('e3', { text: 'now' }, { flushNow: true });

		const key = `${adapter.namespace}/archive/e3.jsonl`;
		expect(files.has(key)).to.equal(true);
	});

	it('flushes pending writes when throttled', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 1000 });
		await archive.init();

		const pending = archive.appendPatch('a2', { text: 'later' });
		const key = `${adapter.namespace}/archive/a2.jsonl`;
		expect(files.has(key)).to.equal(false);

		await archive.flushPending();
		await pending;

		expect(files.has(key)).to.equal(true);
	});

	it('flushes when maxBatchSize is reached', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 1000, maxBatchSize: 2 });
		await archive.init();

		const p1 = archive.appendPatch('a3', { text: 'one' });
		const p2 = archive.appendPatch('a3', { text: 'two' });
		await Promise.all([p1, p2]);

		const key = `${adapter.namespace}/archive/a3.jsonl`;
		const lines = readJsonl(files, key);
		expect(lines).to.have.length(2);
		expect(lines[0].patch.text).to.equal('one');
		expect(lines[1].patch.text).to.equal('two');
	});
});
