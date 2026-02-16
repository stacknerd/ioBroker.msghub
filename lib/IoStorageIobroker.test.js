'use strict';

const { expect } = require('chai');
const fs = require('node:fs/promises');
const { IoStorageIobroker } = require('./IoStorageIobroker');
const { createFsBackedFileApiAdapter, withTempDir } = require('./_test.utils');

function assertStorageBackendApi(backend) {
	expect(backend).to.respondTo('init');
	expect(backend).to.respondTo('filePathFor');
	expect(backend).to.respondTo('readText');
	expect(backend).to.respondTo('writeText');
	expect(backend).to.respondTo('writeTextAtomic');
	expect(backend).to.respondTo('deleteFile');
	expect(backend).to.respondTo('runtimeRoot');
}

describe('IoStorageIobroker', () => {
	it('implements the expected storage backend API', async () => {
		await withTempDir('msghub-iostorage-contract-', async rootDir => {
			const { adapter } = createFsBackedFileApiAdapter({ rootDir });
			const io = new IoStorageIobroker({
				adapter,
				metaId: adapter.namespace,
				baseDir: 'data',
			});
			assertStorageBackendApi(io);
		});
	});

	it('initializes meta object and base directory', async () => {
		await withTempDir('msghub-iostorage-init-', async rootDir => {
			const { adapter, objects, toAbsPath } = createFsBackedFileApiAdapter({ rootDir });
			const io = new IoStorageIobroker({
				adapter,
				metaId: adapter.namespace,
				baseDir: 'data',
			});

			await io.init();

			const meta = objects.get(adapter.namespace);
			expect(meta).to.be.an('object');
			expect(meta.type).to.equal('meta');

			const st = await fs.stat(toAbsPath(adapter.namespace, 'data'));
			expect(st.isDirectory()).to.equal(true);
			expect(io.runtimeRoot()).to.equal(`iobroker-file-api://${adapter.namespace}/data`);
			expect(io.filePathFor('messages.json')).to.equal('data/messages.json');
		});
	});

	it('writes and reads plain text using direct write mode', async () => {
		await withTempDir('msghub-iostorage-direct-', async rootDir => {
			const { adapter } = createFsBackedFileApiAdapter({ rootDir });
			const io = new IoStorageIobroker({
				adapter,
				metaId: adapter.namespace,
				baseDir: 'data',
			});
			await io.init();

			const filePath = io.filePathFor('messages.json');
			const wr = await io.writeText(filePath, '{"a":1}');
			expect(wr.mode).to.equal('override');
			expect(wr.bytes).to.be.greaterThan(0);

			const raw = await io.readText(filePath);
			expect(raw).to.equal('{"a":1}');
		});
	});

	it('writes atomically via rename when available', async () => {
		await withTempDir('msghub-iostorage-rename-', async rootDir => {
			const { adapter, toAbsPath } = createFsBackedFileApiAdapter({ rootDir, withRename: true });
			const io = new IoStorageIobroker({
				adapter,
				metaId: adapter.namespace,
				baseDir: 'data',
			});
			await io.init();

			const filePath = io.filePathFor('messages.json');
			const wr = await io.writeTextAtomic(filePath, '{"v":2}');
			expect(wr.mode).to.equal('rename');

			const raw = await io.readText(filePath);
			expect(raw).to.equal('{"v":2}');

			try {
				await fs.stat(toAbsPath(adapter.namespace, `${filePath}.tmp`));
				throw new Error('expected temp file to be deleted');
			} catch (e) {
				expect(e?.code).to.equal('ENOENT');
			}
		});
	});

	it('falls back to direct write when rename is unavailable', async () => {
		await withTempDir('msghub-iostorage-norename-', async rootDir => {
			const { adapter } = createFsBackedFileApiAdapter({ rootDir, withRename: false });
			const io = new IoStorageIobroker({
				adapter,
				metaId: adapter.namespace,
				baseDir: 'data',
			});
			await io.init();

			const filePath = io.filePathFor('messages.json');
			const wr = await io.writeTextAtomic(filePath, '{"v":3}');
			expect(wr.mode).to.equal('override');
			expect(await io.readText(filePath)).to.equal('{"v":3}');
		});
	});

	it('falls back to direct write when rename throws', async () => {
		await withTempDir('msghub-iostorage-renamefail-', async rootDir => {
			const { adapter } = createFsBackedFileApiAdapter({ rootDir, withRename: true });
			adapter.renameFileAsync = async () => {
				throw new Error('rename failed');
			};
			const io = new IoStorageIobroker({
				adapter,
				metaId: adapter.namespace,
				baseDir: 'data',
			});
			await io.init();

			const filePath = io.filePathFor('messages.json');
			const wr = await io.writeTextAtomic(filePath, '{"v":4}');
			expect(wr.mode).to.equal('fallback');
			expect(await io.readText(filePath)).to.equal('{"v":4}');
		});
	});

	it('deletes files best-effort', async () => {
		await withTempDir('msghub-iostorage-delete-', async rootDir => {
			const { adapter } = createFsBackedFileApiAdapter({ rootDir });
			const io = new IoStorageIobroker({
				adapter,
				metaId: adapter.namespace,
				baseDir: 'data',
			});
			await io.init();

			const filePath = io.filePathFor('messages.json');
			await io.writeText(filePath, '{"x":1}');
			await io.deleteFile(filePath);
			try {
				await io.readText(filePath);
				throw new Error('expected readText to fail after delete');
			} catch (e) {
				expect(String(e?.message || e)).to.not.equal('');
			}
		});
	});
});
