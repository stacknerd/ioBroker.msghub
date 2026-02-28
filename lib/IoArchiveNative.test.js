'use strict';

const { expect } = require('chai');
const fs = require('node:fs/promises');
const path = require('node:path');
const { IoArchiveNative } = require('./IoArchiveNative');
const { assertArchiveBackendApi, createAdapterLogger, parseJsonLines, withTempDir } = require('./_test.utils');

describe('IoArchiveNative', () => {
	it('implements the full archive backend standard API', async () => {
		await withTempDir('msghub-ioarchive-native-contract-', async nativeRootDir => {
			const { adapter } = createAdapterLogger();
			const backend = new IoArchiveNative({
				adapter,
				baseDir: 'data/archive',
				nativeRootDir,
			});
			assertArchiveBackendApi(expect, backend);
		});
	});

	it('returns missing-instance-data-dir when native root is unavailable', async () => {
		const { adapter } = createAdapterLogger();
		const backend = new IoArchiveNative({
			adapter,
			baseDir: 'data/archive',
			nativeRootDir: '',
		});
		const probe = await backend.probe();
		expect(probe).to.deep.equal({ ok: false, reason: 'missing-instance-data-dir' });
	});

	it('performs real native file I/O for append/readDir/delete/estimate', async () => {
		await withTempDir('msghub-ioarchive-native-io-', async nativeRootDir => {
			const { adapter } = createAdapterLogger();
			let mutated = 0;
			const backend = new IoArchiveNative({
				adapter,
				baseDir: 'data/archive',
				nativeRootDir,
				onMutated: () => {
					mutated += 1;
				},
			});

			await backend.init();
			expect(backend.runtimeRoot()).to.equal(path.join(nativeRootDir, 'data/archive'));

			const probe = await backend.probe();
			expect(probe.ok).to.equal(true);

			const filePath = 'data/archive/source/ref.20260105.jsonl';
			await backend.appendEntries(
				filePath,
				[
					{ event: 'create', ref: 'source.ref', ts: 1 },
					{ event: 'patch', ref: 'source.ref', ts: 2 },
				],
				entry => JSON.stringify(entry),
			);
			expect(mutated).to.equal(1);

			const absFile = path.join(nativeRootDir, filePath);
			const raw = await fs.readFile(absFile, 'utf8');
			const lines = parseJsonLines(raw);
			expect(lines).to.have.length(2);
			expect(lines[0].event).to.equal('create');
			expect(lines[1].event).to.equal('patch');

			const entries = await backend.readDir('data/archive/source');
			expect(entries.some(e => e.name === 'ref.20260105.jsonl' && e.isDir === false)).to.equal(true);

			const estimate = await backend.estimateSizeBytes();
			expect(estimate.isComplete).to.equal(true);
			expect(estimate.bytes).to.be.a('number');
			expect(estimate.bytes).to.be.greaterThan(0);

			await backend.deleteFile(filePath);
			expect(mutated).to.equal(2);
			try {
				await fs.stat(absFile);
				throw new Error('expected native archive file to be deleted');
			} catch (e) {
				expect(e && e.code).to.equal('ENOENT');
			}
		});
	});
});
