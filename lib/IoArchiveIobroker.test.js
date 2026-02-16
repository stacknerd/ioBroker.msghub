'use strict';

const { expect } = require('chai');
const fs = require('node:fs/promises');
const { IoArchiveIobroker } = require('./IoArchiveIobroker');
const {
	assertArchiveBackendApi,
	createFsBackedFileApiAdapter,
	parseJsonLines,
	withTempDir,
} = require('./_test.utils');

describe('IoArchiveIobroker', () => {
	it('implements the full archive backend standard API', async () => {
		await withTempDir('msghub-ioarchive-iobroker-contract-', async rootDir => {
			const { adapter } = createFsBackedFileApiAdapter({ rootDir });
			const backend = new IoArchiveIobroker({
				adapter,
				metaId: adapter.namespace,
				baseDir: 'data/archive',
				fileExtension: 'jsonl',
			});
			assertArchiveBackendApi(expect, backend);
		});
	});

	it('performs file-api backed I/O with real filesystem effects', async () => {
		await withTempDir('msghub-ioarchive-iobroker-io-', async rootDir => {
			const { adapter, objects, toAbsPath } = createFsBackedFileApiAdapter({ rootDir });
			let mutated = 0;
			const backend = new IoArchiveIobroker({
				adapter,
				metaId: adapter.namespace,
				baseDir: 'data/archive',
				fileExtension: 'jsonl',
				onMutated: () => {
					mutated += 1;
				},
			});

			await backend.init();

			const meta = objects.get(adapter.namespace);
			expect(meta).to.be.an('object');
			expect(meta.type).to.equal('meta');

			const baseDir = toAbsPath(adapter.namespace, 'data/archive');
			const st = await fs.stat(baseDir);
			expect(st.isDirectory()).to.equal(true);

			expect(backend.runtimeRoot()).to.equal(`iobroker-file-api://${adapter.namespace}/data/archive`);
			expect(backend.probe()).to.deep.equal({ ok: false, reason: 'not-native-backend' });

			const filePath = 'data/archive/topic/ref.20260105.jsonl';
			await backend.appendEntries(
				filePath,
				[{ event: 'create', ref: 'topic.ref', ts: 1 }],
				entry => JSON.stringify(entry),
			);
			await backend.appendEntries(
				filePath,
				[{ event: 'patch', ref: 'topic.ref', ts: 2 }],
				entry => JSON.stringify(entry),
			);
			expect(mutated).to.equal(2);

			const raw = await fs.readFile(toAbsPath(adapter.namespace, filePath), 'utf8');
			const lines = parseJsonLines(raw);
			expect(lines).to.have.length(2);
			expect(lines[0].event).to.equal('create');
			expect(lines[1].event).to.equal('patch');

			const entries = await backend.readDir('data/archive/topic');
			expect(entries.some(e => e.name === 'ref.20260105.jsonl' && e.isDir === false)).to.equal(true);

			const estimate = await backend.estimateSizeBytes();
			expect(estimate.isComplete).to.equal(true);
			expect(estimate.bytes).to.be.a('number');
			expect(estimate.bytes).to.be.greaterThan(0);

			await backend.deleteFile(filePath);
			expect(mutated).to.equal(3);
			try {
				await fs.stat(toAbsPath(adapter.namespace, filePath));
				throw new Error('expected ioBroker archive file to be deleted');
			} catch (e) {
				expect(e && e.code).to.equal('ENOENT');
			}
		});
	});
});
