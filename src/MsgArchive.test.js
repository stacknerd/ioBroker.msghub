'use strict';

const { expect } = require('chai');
const { MsgArchive } = require('./MsgArchive');

function segmentKeyForLocalWeek(ts) {
	const d = new Date(ts);
	const day = d.getDay(); // 0 (Sun) .. 6 (Sat)
	const daysSinceMonday = (day + 6) % 7; // Mon -> 0, Sun -> 6
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - daysSinceMonday);
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, '0');
	const date = String(d.getDate()).padStart(2, '0');
	return `${year}${month}${date}`;
}

async function withMockedNow(ts, fn) {
	const originalNow = Date.now;
	Date.now = () => ts;
	try {
		return await fn();
	} finally {
		Date.now = originalNow;
	}
}

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
		readDirAsync: async (metaId, dir) => {
			const normalized = typeof dir === 'string' ? dir.replace(/^\/+|\/+$/g, '') : '';
			const prefix = `${metaId}/${normalized ? `${normalized}/` : ''}`;
			const children = new Map();

			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) {
					continue;
				}
				const rest = key.slice(prefix.length);
				if (!rest) {
					continue;
				}
				const [first, ...tail] = rest.split('/');
				const isDir = tail.length > 0;
				if (!children.has(first)) {
					children.set(first, isDir);
				} else if (isDir) {
					children.set(first, true);
				}
			}

			return Array.from(children.entries()).map(([file, isDir]) => ({ file, isDir, stats: {} }));
		},
		delFileAsync: async (metaId, fileName) => {
			const key = `${metaId}/${fileName}`;
			files.delete(key);
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

		await withMockedNow(123456, async () => {
			const message = {
				ref: 'a1',
				title: 'hello',
				metrics: new Map([['temp', { val: 21.7, unit: 'C', ts: 1700000 }]]),
			};
			await archive.appendSnapshot(message);

			const segmentKey = segmentKeyForLocalWeek(123456);
			const key = `${adapter.namespace}/archive/a1.${segmentKey}.jsonl`;
			const lines = readJsonl(files, key);
			expect(lines).to.have.length(1);
			expect(lines[0].event).to.equal('create');
			expect(lines[0].ref).to.equal('a1');
			expect(lines[0].ts).to.equal(123456);
			expect(lines[0].snapshot).to.be.an('object');
			expect(lines[0].snapshot.metrics.__msghubType).to.equal('Map');
		});
	});

	it('splits dotted refs into nested directories', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			const ref = 'javascript.0.HaldeGarten.Garten.Frostgefahr.GartenIstJetztFrostsicher';
			await archive.appendSnapshot({ ref, title: 'hello' });

			const segmentKey = segmentKeyForLocalWeek(now);
			const newKey = `${adapter.namespace}/archive/javascript.0/HaldeGarten/Garten/Frostgefahr/GartenIstJetztFrostsicher.${segmentKey}.jsonl`;
			expect(files.has(newKey)).to.equal(true);

			const legacyKey = `${adapter.namespace}/archive/${ref}.${segmentKey}.jsonl`;
			expect(files.has(legacyKey)).to.equal(false);
		});
	});

	it('shortens very long ref path segments to avoid ENAMETOOLONG', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			const longPart = 'Obst%20%26%20Gem%C3%BCse%2C'.repeat(60);
			const ref = `BridgeAlexaShopping.1.${longPart}Sonstiges`;

			await archive.appendSnapshot({ ref, title: 'hello' });
			await archive.appendPatch(ref, { text: 'patch-1' });

			const segmentKey = segmentKeyForLocalWeek(now);
			const created = Array.from(files.keys()).filter(key =>
				key.startsWith(`${adapter.namespace}/archive/BridgeAlexaShopping.1/`),
			);
			expect(created).to.have.length(1);

			const fileKey = created[0];
			const fileName = fileKey.split('/').pop();
			expect(fileName.endsWith(`.${segmentKey}.jsonl`)).to.equal(true);
			expect(Buffer.byteLength(fileName, 'utf8')).to.be.lessThan(200);
			expect(fileName.includes('~')).to.equal(true);

			const lines = readJsonl(files, fileKey);
			expect(lines).to.have.length(2);
			expect(lines[0].event).to.equal('create');
			expect(lines[1].event).to.equal('patch');
		});
	});

	it('supports overriding the snapshot event name', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			await archive.appendSnapshot({ ref: 'e1', title: 'x' }, { event: 'snapshot' });

			const segmentKey = segmentKeyForLocalWeek(now);
			const key = `${adapter.namespace}/archive/e1.${segmentKey}.jsonl`;
			const lines = readJsonl(files, key);
			expect(lines).to.have.length(1);
			expect(lines[0].event).to.equal('snapshot');
		});
	});

	it('appends patch and delete events to the same ref file', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			const ref = 'a/1';
			await archive.appendPatch(ref, { text: 'patch-1' });
			await archive.appendAction(ref, { ok: true, actionId: 'ack1', type: 'ack', actor: 'UI' });
			await archive.appendDelete({ ref, title: 'bye' });

			const segmentKey = segmentKeyForLocalWeek(now);
			const key = `${adapter.namespace}/archive/a%2F1.${segmentKey}.jsonl`;
			const lines = readJsonl(files, key);
			expect(lines).to.have.length(3);
			expect(lines[0].event).to.equal('patch');
			expect(lines[0].ok).to.equal(true);
			expect(lines[0].requested.text).to.equal('patch-1');
			expect(lines[1].event).to.equal('action');
			expect(lines[1].ok).to.equal(true);
			expect(lines[1].actionId).to.equal('ack1');
			expect(lines[1].type).to.equal('ack');
			expect(lines[1].actor).to.equal('UI');
			expect(lines[2].event).to.equal('delete');
			expect(lines[2].snapshot.title).to.equal('bye');
		});
	});

	it('allows delete by ref without snapshot payload', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			await archive.appendDelete('e2');

			const segmentKey = segmentKeyForLocalWeek(now);
			const key = `${adapter.namespace}/archive/e2.${segmentKey}.jsonl`;
			const lines = readJsonl(files, key);
			expect(lines).to.have.length(1);
			expect(lines[0].event).to.equal('delete');
			expect('snapshot' in lines[0]).to.equal(false);
		});
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
			await archive.appendPatch('', { a: 1 }, undefined, undefined, { throwOnError: true });
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

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			await archive.appendPatch('e3', { text: 'now' }, undefined, undefined, { flushNow: true });

			const segmentKey = segmentKeyForLocalWeek(now);
			const key = `${adapter.namespace}/archive/e3.${segmentKey}.jsonl`;
			expect(files.has(key)).to.equal(true);
		});
	});

	it('flushes pending writes when throttled', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 1000 });
		await archive.init();

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			const pending = archive.appendPatch('a2', { text: 'later' });
			const segmentKey = segmentKeyForLocalWeek(now);
			const key = `${adapter.namespace}/archive/a2.${segmentKey}.jsonl`;
			expect(files.has(key)).to.equal(false);

			await archive.flushPending();
			await pending;

			expect(files.has(key)).to.equal(true);
		});
	});

	it('flushes when maxBatchSize is reached', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 1000, maxBatchSize: 2 });
		await archive.init();

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			const p1 = archive.appendPatch('a3', { text: 'one' });
			const p2 = archive.appendPatch('a3', { text: 'two' });
			await Promise.all([p1, p2]);

			const segmentKey = segmentKeyForLocalWeek(now);
			const key = `${adapter.namespace}/archive/a3.${segmentKey}.jsonl`;
			const lines = readJsonl(files, key);
			expect(lines).to.have.length(2);
			expect(lines[0].requested.text).to.equal('one');
			expect(lines[1].requested.text).to.equal('two');
		});
	});

	it('records added/removed diff for patch payloads', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const ref = 'diff-1';
		const existing = { ref, title: 'old', metrics: new Map([['temp', { val: 1 }]]) };
		const updated = { ref, title: 'new', metrics: new Map([['temp', { val: 2 }], ['hum', { val: 3 }]]) };
		const patch = { title: 'new', metrics: { set: { temp: { val: 2 }, hum: { val: 3 } } } };

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			await archive.appendPatch(ref, patch, existing, updated);

			const segmentKey = segmentKeyForLocalWeek(now);
			const key = `${adapter.namespace}/archive/diff-1.${segmentKey}.jsonl`;
			const lines = readJsonl(files, key);
			expect(lines).to.have.length(1);
			expect(lines[0].requested.title).to.equal('new');
			expect(lines[0].added.title).to.equal('new');
			expect(lines[0].removed.title).to.equal('old');
			expect(lines[0].added.metrics.temp).to.deep.equal({ val: 2 });
			expect(lines[0].removed.metrics.temp).to.deep.equal({ val: 1 });
			expect(lines[0].added.metrics.hum).to.deep.equal({ val: 3 });
		});
	});

	it('diffs id-based arrays by id (delete)', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const ref = 'list-1';
		const existing = {
			ref,
			listItems: [
				{ id: 'a', name: 'A', checked: false },
				{ id: 'b', name: 'B', checked: true },
			],
		};
		const updated = {
			ref,
			listItems: [{ id: 'a', name: 'A', checked: false }],
		};
		const patch = { listItems: { delete: ['b'] } };

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			await archive.appendPatch(ref, patch, existing, updated);

			const segmentKey = segmentKeyForLocalWeek(now);
			const key = `${adapter.namespace}/archive/list-1.${segmentKey}.jsonl`;
			const lines = readJsonl(files, key);
			expect(lines).to.have.length(1);
			expect(lines[0].requested.listItems.delete).to.deep.equal(['b']);
			expect(lines[0]).to.not.have.property('added');
			expect(lines[0].removed.listItems).to.deep.equal([{ id: 'b', name: 'B', checked: true }]);
		});
	});

	it('diffs id-based arrays by id (update)', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const ref = 'list-2';
		const existing = {
			ref,
			listItems: [{ id: 'a', name: 'A', checked: false }],
		};
		const updated = {
			ref,
			listItems: [{ id: 'a', name: 'A', checked: true }],
		};
		const patch = { listItems: { set: { a: { checked: true } } } };

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			await archive.appendPatch(ref, patch, existing, updated);

			const segmentKey = segmentKeyForLocalWeek(now);
			const key = `${adapter.namespace}/archive/list-2.${segmentKey}.jsonl`;
			const lines = readJsonl(files, key);
			expect(lines).to.have.length(1);
			expect(lines[0].added.listItems).to.deep.equal([{ id: 'a', name: 'A', checked: true }]);
			expect(lines[0].removed.listItems).to.deep.equal([{ id: 'a', name: 'A', checked: false }]);
		});
	});

	it('does not emit diffs for id-based reorder-only arrays', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const ref = 'list-reorder-1';
		const existing = {
			ref,
			listItems: [
				{ id: 'a', name: 'A', checked: false },
				{ id: 'b', name: 'B', checked: true },
			],
		};
		const updated = {
			ref,
			listItems: [
				{ id: 'b', name: 'B', checked: true },
				{ id: 'a', name: 'A', checked: false },
			],
		};
		const patch = { listItems: updated.listItems };

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			await archive.appendPatch(ref, patch, existing, updated);

			const segmentKey = segmentKeyForLocalWeek(now);
			const key = `${adapter.namespace}/archive/list-reorder-1.${segmentKey}.jsonl`;
			const lines = readJsonl(files, key);
			expect(lines).to.have.length(1);
			expect(lines[0].requested.listItems).to.deep.equal(updated.listItems);
			expect(lines[0]).to.not.have.property('added');
			expect(lines[0]).to.not.have.property('removed');
		});
	});

	it('diffs arrays of unique primitives as sets', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const ref = 'prim-1';
		const existing = { ref, details: { tools: ['a', 'b'] } };
		const updated = { ref, details: { tools: ['a'] } };
		const patch = { details: { tools: ['a'] } };

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			await archive.appendPatch(ref, patch, existing, updated);

			const segmentKey = segmentKeyForLocalWeek(now);
			const key = `${adapter.namespace}/archive/prim-1.${segmentKey}.jsonl`;
			const lines = readJsonl(files, key);
			expect(lines).to.have.length(1);
			expect(lines[0]).to.not.have.property('added');
			expect(lines[0].removed.details.tools).to.deep.equal(['b']);
		});
	});

	it('does not emit diffs for primitive reorder-only arrays', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0 });
		await archive.init();

		const ref = 'prim-reorder-1';
		const existing = { ref, details: { tools: ['a', 'b'] } };
		const updated = { ref, details: { tools: ['b', 'a'] } };
		const patch = { details: { tools: ['b', 'a'] } };

		const now = new Date(2025, 0, 6, 12, 0, 0).getTime();
		await withMockedNow(now, async () => {
			await archive.appendPatch(ref, patch, existing, updated);

			const segmentKey = segmentKeyForLocalWeek(now);
			const key = `${adapter.namespace}/archive/prim-reorder-1.${segmentKey}.jsonl`;
			const lines = readJsonl(files, key);
			expect(lines).to.have.length(1);
			expect(lines[0].requested.details.tools).to.deep.equal(['b', 'a']);
			expect(lines[0]).to.not.have.property('added');
			expect(lines[0]).to.not.have.property('removed');
		});
	});

	it('deletes old weekly segment files based on keepPreviousWeeks', async () => {
		const { adapter, files } = createAdapter();
		const archive = new MsgArchive(adapter, { baseDir: 'archive', flushIntervalMs: 0, keepPreviousWeeks: 0 });
		await archive.init();

		const ref = 'retention.0.demo';
		const week1 = new Date(2025, 0, 6, 12, 0, 0).getTime(); // Monday
		const week2 = new Date(2025, 0, 13, 12, 0, 0).getTime(); // next Monday

		await withMockedNow(week1, async () => {
			await archive.appendPatch(ref, { text: 'w1' });
		});
		await withMockedNow(week2, async () => {
			await archive.appendPatch(ref, { text: 'w2' });
		});

		const k1 = segmentKeyForLocalWeek(week1);
		const k2 = segmentKeyForLocalWeek(week2);
		const path1 = `${adapter.namespace}/archive/retention.0/demo.${k1}.jsonl`;
		const path2 = `${adapter.namespace}/archive/retention.0/demo.${k2}.jsonl`;

		// keepPreviousWeeks=0 keeps only the current week (week2) after the second append.
		expect(files.has(path2)).to.equal(true);
		expect(files.has(path1)).to.equal(false);
	});
});
