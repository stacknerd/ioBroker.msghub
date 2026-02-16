/**
 * IoStorageIobroker
 * =================
 * ioBroker file-API backend for MsgStorage persistence.
 */

'use strict';

/**
 * ioBroker storage backend for single-file JSON persistence.
 */
class IoStorageIobroker {
	/**
	 * @param {object} options Backend options.
	 * @param {import('@iobroker/adapter-core').AdapterInstance} options.adapter Adapter instance.
	 * @param {string} [options.metaId] ioBroker file meta id.
	 * @param {string} [options.baseDir] Base directory below `metaId`.
	 */
	constructor(options) {
		const opt = options && typeof options === 'object' && !Array.isArray(options) ? options : null;
		if (!opt) {
			throw new Error('IoStorageIobroker: options are required');
		}
		if (!opt.adapter || typeof opt.adapter !== 'object') {
			throw new Error('IoStorageIobroker: options.adapter is required');
		}
		this.adapter = opt.adapter;
		this.metaId = typeof opt.metaId === 'string' && opt.metaId ? opt.metaId : this.adapter.namespace;
		this.baseDir = typeof opt.baseDir === 'string' ? opt.baseDir.replace(/^\/+|\/+$/g, '') : '';
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
	 * Build relative file path for one file name under the configured base directory.
	 *
	 * @param {string} fileName Storage file name.
	 * @returns {string} Relative path below `metaId`.
	 */
	filePathFor(fileName) {
		const name = typeof fileName === 'string' ? fileName.replace(/^\/+/, '') : '';
		return this.baseDir ? `${this.baseDir}/${name}` : name;
	}

	/**
	 * Read one file as UTF-8 text.
	 *
	 * @param {string} filePath Relative file path below `metaId`.
	 * @returns {Promise<string>} UTF-8 text content.
	 */
	async readText(filePath) {
		const res = await this.adapter.readFileAsync(this.metaId, filePath);
		const raw = res && typeof res === 'object' && 'file' in res ? res.file : res;
		if (raw == null) {
			return '';
		}
		return Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
	}

	/**
	 * Write one file directly (overwrite mode).
	 *
	 * @param {string} filePath Relative file path below `metaId`.
	 * @param {string} text UTF-8 text content.
	 * @returns {Promise<{mode:'override'|'fallback'|'rename', bytes:number}>} Write result.
	 */
	async writeText(filePath, text) {
		const payload = String(text ?? '');
		await this.adapter.writeFileAsync(this.metaId, filePath, payload);
		return { mode: 'override', bytes: Buffer.byteLength(payload, 'utf8') };
	}

	/**
	 * Write one file using tmp + rename when available, with direct-write fallback.
	 *
	 * @param {string} filePath Relative file path below `metaId`.
	 * @param {string} text UTF-8 text content.
	 * @returns {Promise<{mode:'override'|'fallback'|'rename', bytes:number}>} Write result.
	 */
	async writeTextAtomic(filePath, text) {
		const payload = String(text ?? '');
		const bytes = Buffer.byteLength(payload, 'utf8');
		const tmpPath = `${filePath}.tmp`;

		// @ts-expect-error `renameFileAsync` is optional on adapter runtime
		if (typeof this.adapter.renameFileAsync !== 'function') {
			await this.adapter.writeFileAsync(this.metaId, filePath, payload);
			return { mode: 'override', bytes };
		}

		try {
			await this.adapter.writeFileAsync(this.metaId, tmpPath, payload);

			if (typeof this.adapter.delFileAsync === 'function') {
				try {
					await this.adapter.delFileAsync(this.metaId, filePath);
				} catch {
					// best-effort
				}
			}

			// @ts-expect-error `renameFileAsync` is optional on adapter runtime
			await this.adapter.renameFileAsync(this.metaId, tmpPath, filePath);
			return { mode: 'rename', bytes };
		} catch (e) {
			this.adapter?.log?.warn?.(
				`IoStorageIobroker atomic write failed (${e?.message || e}), writing directly to ${filePath}`,
			);
			await this.adapter.writeFileAsync(this.metaId, filePath, payload);
			return { mode: 'fallback', bytes };
		} finally {
			if (typeof this.adapter.delFileAsync === 'function') {
				try {
					await this.adapter.delFileAsync(this.metaId, tmpPath);
				} catch {
					// best-effort
				}
			}
		}
	}

	/**
	 * Delete one file (best-effort).
	 *
	 * @param {string} filePath Relative file path below `metaId`.
	 * @returns {Promise<void>} Resolves when delete attempt finished.
	 */
	async deleteFile(filePath) {
		try {
			if (typeof this.adapter.delFileAsync === 'function') {
				await this.adapter.delFileAsync(this.metaId, filePath);
				return;
			}
		} catch {
			// fall through
		}
		try {
			if (typeof this.adapter.unlinkAsync === 'function') {
				await this.adapter.unlinkAsync(this.metaId, filePath);
			}
		} catch {
			// best-effort
		}
	}

	/**
	 * Runtime root descriptor.
	 *
	 * @returns {string} ioBroker file-api root URI for diagnostics.
	 */
	runtimeRoot() {
		return `iobroker-file-api://${this.metaId}/${this.baseDir || ''}`;
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

module.exports = { IoStorageIobroker };
