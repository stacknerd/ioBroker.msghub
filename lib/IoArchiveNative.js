/**
 * IoArchiveNative
 * ===============
 * Native filesystem archive backend implementation.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * Native archive backend.
 */
class IoArchiveNative {
	/**
	 * @param {object} options Backend options.
	 * @param {import('@iobroker/adapter-core').AdapterInstance} options.adapter Adapter instance.
	 * @param {string} options.baseDir Archive base directory.
	 * @param {string} options.nativeRootDir Absolute native archive root directory.
	 * @param {() => void} [options.onMutated] Mutation callback.
	 */
	constructor(options) {
		const opt = options && typeof options === 'object' && !Array.isArray(options) ? options : null;
		if (!opt) {
			throw new Error('IoArchiveNative: options are required');
		}
		if (!opt.adapter || typeof opt.adapter !== 'object') {
			throw new Error('IoArchiveNative: options.adapter is required');
		}
		this.adapter = opt.adapter;
		this.baseDir = typeof opt.baseDir === 'string' ? opt.baseDir : '';
		this.nativeRootDir = typeof opt.nativeRootDir === 'string' ? opt.nativeRootDir : '';
		this.onMutated = typeof opt.onMutated === 'function' ? opt.onMutated : () => undefined;
		this._ensuredDirs = new Set();
	}

	/**
	 * Initialize native root directory.
	 *
	 * @returns {Promise<void>} Resolves when root directory exists.
	 */
	async init() {
		await fs.mkdir(this.nativeRootDir, { recursive: true });
	}

	/**
	 * Runtime root path.
	 *
	 * @returns {string} Absolute runtime root used by archive writes.
	 */
	runtimeRoot() {
		return this._absPath(this.baseDir || '');
	}

	/**
	 * Probe native archive I/O capability.
	 *
	 * @returns {Promise<{ok:boolean, reason:string}>} Probe result.
	 */
	async probe() {
		if (!this.nativeRootDir) {
			return { ok: false, reason: 'missing-instance-data-dir' };
		}

		const probeDir = path.join(this.nativeRootDir, '.probe');
		const probeFile = path.join(probeDir, `native-probe-${process.pid || 'pid'}-${Date.now()}.jsonl`);
		const line1 = JSON.stringify({ step: 1, ts: Date.now() });
		const line2 = JSON.stringify({ step: 2, ts: Date.now() });

		try {
			await fs.mkdir(probeDir, { recursive: true });
			await fs.writeFile(probeFile, `${line1}\n`, 'utf8');
			const firstRead = await fs.readFile(probeFile, 'utf8');
			if (!firstRead.includes(line1)) {
				return { ok: false, reason: 'probe-read-mismatch-initial' };
			}
			await fs.appendFile(probeFile, `${line2}\n`, 'utf8');
			const secondRead = await fs.readFile(probeFile, 'utf8');
			if (!secondRead.includes(line1) || !secondRead.includes(line2)) {
				return { ok: false, reason: 'probe-read-mismatch-append' };
			}
			return { ok: true, reason: 'ok' };
		} catch (e) {
			return { ok: false, reason: `native-probe-failed:${String(e?.message || e)}` };
		} finally {
			try {
				await fs.unlink(probeFile);
			} catch {
				// best-effort cleanup
			}
		}
	}

	/**
	 * Append events to one archive file.
	 *
	 * @param {string} filePath Relative archive file path.
	 * @param {Array<object>} entries Event entries.
	 * @param {(entry: object) => string} serializeEntry Serializer callback from core.
	 * @returns {Promise<void>} Resolves when entries were persisted.
	 */
	async appendEntries(filePath, entries, serializeEntry) {
		const absolutePath = this._absPath(filePath);
		await this._ensureDirForFilePath(filePath);
		const toLine = typeof serializeEntry === 'function' ? serializeEntry : entry => JSON.stringify(entry);
		const newLines = entries.map(entry => toLine(entry)).join('\n');
		await fs.appendFile(absolutePath, `${newLines}\n`, 'utf8');
		this.onMutated();
		this.adapter?.log?.debug?.(`MsgArchive append ${entries.length} event(s) -> ${absolutePath}`);
	}

	/**
	 * Best-effort delete a file.
	 *
	 * @param {string} filePath Relative archive file path.
	 * @returns {Promise<void>} Resolves when delete attempt finished.
	 */
	async deleteFile(filePath) {
		const absolutePath = this._absPath(filePath);
		try {
			await fs.unlink(absolutePath);
			this.onMutated();
		} catch {
			// best-effort
		}
	}

	/**
	 * List one archive directory.
	 *
	 * @param {string} dirPath Relative archive directory path.
	 * @returns {Promise<Array<{name:string, isDir:boolean}>>} Directory entries.
	 */
	async readDir(dirPath) {
		const absoluteDir = this._absPath(dirPath);
		try {
			const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
			const out = [];
			for (const entry of entries || []) {
				if (!entry || typeof entry.name !== 'string' || !entry.name) {
					continue;
				}
				out.push({ name: entry.name, isDir: entry.isDirectory() });
			}
			return out;
		} catch (e) {
			this.adapter?.log?.debug?.(
				`MsgArchive retention native readdir failed (${absoluteDir || '.'}): ${e?.message || e}`,
			);
			return [];
		}
	}

	/**
	 * Estimate archive size in bytes.
	 *
	 * @returns {Promise<{bytes:number|null, isComplete:boolean}>} Size estimate result.
	 */
	async estimateSizeBytes() {
		if (!this.nativeRootDir) {
			return { bytes: null, isComplete: false };
		}

		const queue = [this.nativeRootDir];
		let total = 0;
		let isComplete = true;

		while (queue.length > 0) {
			const dir = queue.shift();
			if (!dir) {
				continue;
			}
			let entries;
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				isComplete = false;
				continue;
			}

			for (const entry of entries || []) {
				if (!entry) {
					continue;
				}
				const abs = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					queue.push(abs);
					continue;
				}
				if (!entry.isFile()) {
					continue;
				}
				try {
					const st = await fs.stat(abs);
					if (typeof st?.size === 'number' && Number.isFinite(st.size)) {
						total += st.size;
					} else {
						isComplete = false;
					}
				} catch {
					isComplete = false;
				}
			}
		}

		return { bytes: total, isComplete };
	}

	/**
	 * Resolve one relative archive path to an absolute native path.
	 *
	 * @param {string} filePath Relative archive path.
	 * @returns {string} Absolute native path.
	 */
	_absPath(filePath) {
		const relative = String(filePath || '').replace(/^\/+/, '');
		return path.join(this.nativeRootDir || '', relative);
	}

	/**
	 * Ensure archive sub-directory exists.
	 *
	 * @param {string} filePath Relative archive file path.
	 * @returns {Promise<void>} Resolves after ensuring directory path.
	 */
	async _ensureDirForFilePath(filePath) {
		const idx = typeof filePath === 'string' ? filePath.lastIndexOf('/') : -1;
		if (idx <= 0) {
			return;
		}
		const dir = filePath.slice(0, idx);
		const key = this._absPath(dir);
		if (!key || this._ensuredDirs.has(key)) {
			return;
		}
		this._ensuredDirs.add(key);
		await fs.mkdir(key, { recursive: true });
	}
}

module.exports = { IoArchiveNative };
