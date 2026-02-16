'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ARCHIVE_BACKEND_API_METHODS = Object.freeze([
	'init',
	'probe',
	'appendEntries',
	'readDir',
	'deleteFile',
	'estimateSizeBytes',
	'runtimeRoot',
]);

/**
 * Assert the shared archive backend standard API.
 *
 * @param {(v:any,m?:string)=>any} expect Chai expect function.
 * @param {any} backend Backend instance under test.
 * @returns {void}
 */
function assertArchiveBackendApi(expect, backend) {
	for (const method of ARCHIVE_BACKEND_API_METHODS) {
		expect(backend, `backend missing '${method}'`).to.respondTo(method);
		expect(backend[method], `backend '${method}' must be a function`).to.be.a('function');
	}
}

/**
 * Create an adapter-like logger object for tests.
 *
 * @param {string} [namespace] Adapter namespace (default: `msghub.0`).
 * @returns {{ adapter: any, logs: Record<string,string[]> }} Adapter + collected log messages.
 */
function createAdapterLogger(namespace = 'msghub.0') {
	const debug = [];
	const info = [];
	const warn = [];
	const error = [];
	const logs = {
		debug,
		info,
		warn,
		error,
	};
	return {
		adapter: {
			name: 'msghub',
			namespace,
			log: {
				debug: msg => logs.debug.push(String(msg)),
				info: msg => logs.info.push(String(msg)),
				warn: msg => logs.warn.push(String(msg)),
				error: msg => logs.error.push(String(msg)),
			},
		},
		logs,
	};
}

/**
 * Create an ioBroker-like file API adapter backed by real local filesystem I/O.
 *
 * @param {object} options Options.
 * @param {string} options.rootDir Root directory for test file storage.
 * @param {string} [options.namespace] Adapter namespace/meta id default (`msghub.0`).
 * @param {boolean} [options.withRename] Whether `renameFileAsync` is exposed (default: true).
 * @returns {{ adapter: any, objects: Map<string, any>, toAbsPath: (metaId: string, relPath?: string) => string }} Adapter + object store + path mapper.
 */
function createFsBackedFileApiAdapter(options) {
	const opt = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
	const rootDir = String(opt.rootDir || '');
	const namespace = typeof opt.namespace === 'string' && opt.namespace ? opt.namespace : 'msghub.0';
	const withRename = opt.withRename !== false;
	const objects = new Map();

	const normalizeRel = relPath => String(relPath || '').replace(/^\/+/, '');
	const toAbsPath = (metaId, relPath = '') => path.join(rootDir, String(metaId || ''), normalizeRel(relPath));

	const adapter = {
		name: 'msghub',
		namespace,
		log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
		getObjectAsync: async id => objects.get(id) || null,
		setObjectAsync: async (id, obj) => {
			objects.set(id, obj);
		},
		mkdirAsync: async (metaId, dirPath) => {
			await fs.mkdir(toAbsPath(metaId, dirPath), { recursive: true });
		},
		writeFileAsync: async (metaId, fileName, data) => {
			const abs = toAbsPath(metaId, fileName);
			await fs.mkdir(path.dirname(abs), { recursive: true });
			await fs.writeFile(abs, data);
		},
		readFileAsync: async (metaId, fileName) => {
			const abs = toAbsPath(metaId, fileName);
			const buf = await fs.readFile(abs);
			return { file: buf };
		},
		readDirAsync: async (metaId, dirPath) => {
			const absDir = toAbsPath(metaId, dirPath);
			let entries = [];
			try {
				entries = await fs.readdir(absDir, { withFileTypes: true });
			} catch (e) {
				if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
					return [];
				}
				throw e;
			}
			const out = [];
			for (const entry of entries) {
				const absEntry = path.join(absDir, entry.name);
				let size = undefined;
				try {
					const st = await fs.stat(absEntry);
					size = typeof st?.size === 'number' ? st.size : undefined;
				} catch {
					// best-effort
				}
				out.push({
					file: entry.name,
					isDir: entry.isDirectory(),
					stats: typeof size === 'number' ? { size } : {},
				});
			}
			return out;
		},
		delFileAsync: async (metaId, fileName) => {
			const abs = toAbsPath(metaId, fileName);
			await fs.unlink(abs);
		},
		unlinkAsync: async (metaId, fileName) => {
			const abs = toAbsPath(metaId, fileName);
			await fs.unlink(abs);
		},
	};
	if (withRename) {
		adapter.renameFileAsync = async (metaId, fromPath, toPath) => {
			const fromAbs = toAbsPath(metaId, fromPath);
			const toAbs = toAbsPath(metaId, toPath);
			await fs.mkdir(path.dirname(toAbs), { recursive: true });
			await fs.rename(fromAbs, toAbs);
		};
	}

	return { adapter, objects, toAbsPath };
}

/**
 * Parse a JSONL string into objects.
 *
 * @param {string} raw JSONL content.
 * @returns {Array<any>} Parsed lines.
 */
function parseJsonLines(raw) {
	return String(raw || '')
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

/**
 * Run a callback in a temporary directory and clean up afterwards.
 *
 * @template T
 * @param {string} prefix Prefix for mkdtemp.
 * @param {(dir:string)=>Promise<T>} fn Callback.
 * @returns {Promise<T>} Callback result.
 */
async function withTempDir(prefix, fn) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

module.exports = {
	ARCHIVE_BACKEND_API_METHODS,
	assertArchiveBackendApi,
	createAdapterLogger,
	createFsBackedFileApiAdapter,
	parseJsonLines,
	withTempDir,
};
