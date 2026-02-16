/**
 * IoArchiveIobroker
 * =================
 * ioBroker file-API archive backend implementation.
 */

/**
 * ioBroker archive backend.
 */
class IoArchiveIobroker {
	/**
	 * @param {object} options Backend options.
	 * @param {import('@iobroker/adapter-core').AdapterInstance} options.adapter Adapter instance.
	 * @param {string} options.metaId ioBroker file meta id.
	 * @param {string} options.baseDir Archive base directory.
	 * @param {string} options.fileExtension Archive file extension.
	 * @param {() => void} [options.onMutated] Mutation callback.
	 */
	constructor(options) {
		const opt = options && typeof options === 'object' && !Array.isArray(options) ? options : null;
		if (!opt) {
			throw new Error('IoArchiveIobroker: options are required');
		}
		if (!opt.adapter || typeof opt.adapter !== 'object') {
			throw new Error('IoArchiveIobroker: options.adapter is required');
		}
		this.adapter = opt.adapter;
		this.metaId = typeof opt.metaId === 'string' && opt.metaId ? opt.metaId : this.adapter.namespace;
		this.baseDir = typeof opt.baseDir === 'string' ? opt.baseDir : '';
		this.fileExtension = typeof opt.fileExtension === 'string' ? opt.fileExtension : 'jsonl';
		this.onMutated = typeof opt.onMutated === 'function' ? opt.onMutated : () => undefined;
		this._ensuredDirs = new Set();
	}

	/**
	 * Initialize backend storage root.
	 *
	 * @returns {Promise<void>} Resolves when meta object and base directory are ensured.
	 */
	async init() {
		await ensureMetaObject(this.adapter, this.metaId);
		await ensureBaseDir(this.adapter, this.metaId, this.baseDir);
	}

	/**
	 * Runtime root descriptor.
	 *
	 * @returns {string} ioBroker file-api root URI for diagnostics.
	 */
	runtimeRoot() {
		return `iobroker-file-api://${this.metaId}/${this.baseDir || ''}`;
	}

	/**
	 * Probe result for native backend compatibility checks.
	 *
	 * @returns {{ok:boolean, reason:string}} Always a negative probe for ioBroker backend.
	 */
	probe() {
		return { ok: false, reason: 'not-native-backend' };
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
		await this._ensureDirForFilePath(filePath);
		const existing = await this._readFileText(filePath);
		const existingTrimmed = existing ? existing.replace(/\s+$/, '') : '';
		const toLine = typeof serializeEntry === 'function' ? serializeEntry : entry => JSON.stringify(entry);
		const newLines = entries.map(entry => toLine(entry)).join('\n');
		const combined = existingTrimmed ? `${existingTrimmed}\n${newLines}\n` : `${newLines}\n`;

		await this.adapter.writeFileAsync(this.metaId, filePath, combined);
		this.onMutated();
		this.adapter?.log?.debug?.(
			`MsgArchive append ${entries.length} event(s) -> ${filePath}, ${Buffer.byteLength(combined, 'utf8')} bytes`,
		);
	}

	/**
	 * Best-effort delete a file.
	 *
	 * @param {string} filePath Relative archive file path.
	 * @returns {Promise<void>} Resolves when delete attempt finished.
	 */
	async deleteFile(filePath) {
		try {
			if (typeof this.adapter.delFileAsync === 'function') {
				await this.adapter.delFileAsync(this.metaId, filePath);
				this.onMutated();
				return;
			}
		} catch {
			// fall through
		}

		try {
			if (typeof this.adapter.unlinkAsync === 'function') {
				await this.adapter.unlinkAsync(this.metaId, filePath);
				this.onMutated();
			}
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
		if (typeof this.adapter.readDirAsync !== 'function') {
			return [];
		}
		try {
			const entries = await this.adapter.readDirAsync(this.metaId, dirPath || '');
			const out = [];
			for (const entry of entries || []) {
				const name = typeof entry?.file === 'string' ? entry.file : '';
				if (!name) {
					continue;
				}
				out.push({ name, isDir: entry?.isDir === true });
			}
			return out;
		} catch (e) {
			this.adapter?.log?.debug?.(`MsgArchive readDir failed (${dirPath || '.'}): ${e?.message || e}`);
			return [];
		}
	}

	/**
	 * Estimate archive size in bytes.
	 *
	 * @returns {Promise<{bytes:number|null, isComplete:boolean}>} Size estimate result.
	 */
	async estimateSizeBytes() {
		if (typeof this.adapter.readDirAsync !== 'function') {
			return { bytes: null, isComplete: false };
		}

		const startDir = this.baseDir || '';
		const queue = [startDir];
		let total = 0;
		let isComplete = true;

		while (queue.length > 0) {
			const dir = queue.shift();
			if (typeof dir !== 'string') {
				continue;
			}
			let entries;
			try {
				entries = await this.adapter.readDirAsync(this.metaId, dir);
			} catch {
				continue;
			}

			for (const entry of entries || []) {
				if (!entry) {
					continue;
				}
				const name = typeof entry.file === 'string' ? entry.file : '';
				if (!name) {
					continue;
				}
				if (entry.isDir) {
					queue.push(dir ? `${dir}/${name}` : name);
					continue;
				}
				const size = entry?.stats?.size;
				if (typeof size === 'number' && Number.isFinite(size)) {
					total += size;
				} else {
					isComplete = false;
				}
			}
		}

		return { bytes: total, isComplete };
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
		if (!dir || this._ensuredDirs.has(dir)) {
			return;
		}
		this._ensuredDirs.add(dir);
		await ensureBaseDir(this.adapter, this.metaId, dir);
	}

	/**
	 * Read one archive file as text.
	 *
	 * @param {string} filePath Relative archive file path.
	 * @returns {Promise<string>} File content or empty string when unavailable.
	 */
	async _readFileText(filePath) {
		try {
			const res = await this.adapter.readFileAsync(this.metaId, filePath);
			const raw = res && typeof res === 'object' && 'file' in res ? res.file : res;
			if (raw == null) {
				return '';
			}
			return Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
		} catch (e) {
			this.adapter?.log?.debug?.(`MsgArchive read failed (${filePath}): ${e?.message || e}`);
			return '';
		}
	}
}

/**
 * Ensure ioBroker file meta object exists and is type `meta`.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance.
 * @param {string} metaId Meta object id.
 * @returns {Promise<void>} Resolves when meta object exists.
 */
async function ensureMetaObject(adapter, metaId) {
	const obj = await adapter.getObjectAsync(metaId);
	if (obj) {
		if (obj.type !== 'meta') {
			throw new Error(
				`File-Storage Root "${metaId}" exists but is type "${obj.type}", not "meta". ` +
					`Choose another metaId (e.g. "${metaId}.__files") or delete/rename the existing object "${metaId}".`,
			);
		}
		return;
	}

	await adapter.setObjectAsync(metaId, {
		type: 'meta',
		common: { name: `${adapter.name} file storage`, type: 'meta.user' },
		native: {},
	});
}

/**
 * Ensure base directory exists in ioBroker file storage (best-effort).
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance.
 * @param {string} metaId Meta object id.
 * @param {string} baseDir Base directory path.
 * @returns {Promise<void>} Resolves after best-effort directory creation.
 */
async function ensureBaseDir(adapter, metaId, baseDir) {
	if (!baseDir || typeof adapter.mkdirAsync !== 'function') {
		return;
	}
	const parts = String(baseDir).split('/').filter(Boolean);
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		try {
			await adapter.mkdirAsync(metaId, current);
		} catch {
			// ignore; some backends auto-create folders on write
		}
	}
}

module.exports = { IoArchiveIobroker };
