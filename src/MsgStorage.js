/**
 * Lightweight persistence store for ioBroker file storage.
 * Persists arbitrary JSON structures (e.g. Array<Message>) into a file under
 * the adapter's file namespace (adapter instance, e.g. "myadapter.0").
 *
 * Requires: adapter.readFileAsync/writeFileAsync
 * Optional: adapter.delFileAsync/renameFileAsync (for atomic writes).
 */

const {
	DEFAULT_MAP_TYPE_MARKER,
	serializeWithMaps,
	deserializeWithMaps,
	ensureMetaObject,
	ensureBaseDir,
	createOpQueue,
} = require(`${__dirname}/MsgUtils`);

/**
 * Storage helper that serializes adapter file I/O for message data.
 */
class MsgStorage {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter instance of Msghub
	 * @param {object} [options] Options Array
	 * @param {string} [options.metaId] Object ID of the "meta" root. Defaults to adapter.namespace.
	 * @param {string} [options.baseDir] Base folder for storage file (e.g. "data").
	 * @param {string} [options.fileName] File name (e.g. "messages.json").
	 * @param {number} [options.writeIntervalMs] Throttle window in ms (0 = write immediately).
	 */
	constructor(adapter, options = {}) {
		if (!adapter) {
			throw new Error('MsgStorage: adapter is required');
		}

		this.adapter = adapter;
		this.metaId = options.metaId || adapter.namespace;
		this.baseDir = typeof options.baseDir === 'string' ? options.baseDir.replace(/^\/+|\/+$/g, '') : '';
		this.fileName = options.fileName || 'messages.json';
		this.writeIntervalMs =
			typeof options.writeIntervalMs === 'number' && Number.isFinite(options.writeIntervalMs)
				? Math.max(0, options.writeIntervalMs)
				: 10000;

		// Promise chain used as a simple mutex to serialize operations.
		this._queue = createOpQueue();

		// Throttle state: the latest value to persist and its pending promise.
		this._pendingValue = undefined;
		this._flushTimer = null;
		this._flushPromise = null;
		this._flushResolve = null;
		this._flushReject = null;

		this._mapTypeMarker = DEFAULT_MAP_TYPE_MARKER;
	}

	/**
	 * Call once during startup. Ensures the file storage root exists.
	 */
	async init() {
		await ensureMetaObject(this.adapter, this.metaId);
		await ensureBaseDir(this.adapter, this.metaId, this.baseDir);
		if (this.adapter?.log?.info) {
			const filePath = this._filePathFor(this.fileName);
			this.adapter.log.info(`MsgStorage initialized: file=${filePath}, interval=${this.writeIntervalMs}ms`);
		}
	}

	/**
	 * Writes JSON immediately (no throttling).
	 * Uses atomic write (tmp + rename) when supported.
	 *
	 * @param {any} value file content (json)
	 */
	async _writeNow(value) {
		const tmpName = `${this.fileName}.tmp`;
		const filePath = this._filePathFor(this.fileName);
		const tmpPath = this._filePathFor(tmpName);
		const json = serializeWithMaps(value, this._mapTypeMarker);
		const sizeBytes = Buffer.byteLength(json, 'utf8');

		// If rename is unavailable, fall back to a direct write.
		// @ts-expect-error renameFileAsync may not be avialable
		if (typeof this.adapter.renameFileAsync !== 'function') {
			await this.adapter.writeFileAsync(this.metaId, filePath, json);
			if (this.adapter?.log?.debug) {
				this.adapter.log.debug(`MsgStorage: ${filePath} written, mode=override, ${sizeBytes} bytes`);
			}
			return;
		}

		// Atomic write: write tmp file, then replace the target via rename.
		try {
			await this.adapter.writeFileAsync(this.metaId, tmpPath, json);

			if (typeof this.adapter.delFileAsync === 'function') {
				try {
					await this.adapter.delFileAsync(this.metaId, filePath);
				} catch {
					// Ignore if the target does not exist or deletion is unsupported.
				}
			}

			// @ts-expect-error renameFileAsync may not be avialable
			await this.adapter.renameFileAsync(this.metaId, tmpPath, filePath);
			if (this.adapter?.log?.debug) {
				this.adapter.log.debug(`MsgStorage: ${filePath} written, mode=rename, ${sizeBytes} bytes`);
			}
		} catch (e) {
			// If rename fails, log and fall back to direct write.
			this.adapter.log.warn(`Atomic write failed (${e?.message || e}), writing directly to ${filePath}`);
			await this.adapter.writeFileAsync(this.metaId, filePath, json);
			if (this.adapter?.log?.debug) {
				this.adapter.log.debug(`MsgStorage: ${filePath} written, mode=fallback, ${sizeBytes} bytes`);
			}
		} finally {
			// Best-effort cleanup of the tmp file.
			if (typeof this.adapter.delFileAsync === 'function') {
				try {
					await this.adapter.delFileAsync(this.metaId, tmpPath);
				} catch {
					// ignore
				}
			}
		}
	}

	/**
	 * Reads and parses JSON from the file store.
	 *
	 * @param {any} [fallback] Returned if the file is missing, empty, or invalid.
	 */
	async readJson(fallback = null) {
		const filePath = this._filePathFor(this.fileName);
		return this._queue(async () => {
			try {
				const res = await this.adapter.readFileAsync(this.metaId, filePath);

				// Controller/adapter-core may return { file: Buffer|string } or a raw Buffer/string.
				const raw = res && typeof res === 'object' && 'file' in res ? res.file : res;

				if (raw == null) {
					if (this.adapter?.log?.warn) {
						this.adapter.log.warn(`MsgStorage: '${filePath}' - file missing or empty`);
					}
					return fallback;
				}

				const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
				if (!text.trim()) {
					if (this.adapter?.log?.warn) {
						this.adapter.log.warn(`MsgStorage: '${filePath}' - empty or whitespace only`);
					}
					return fallback;
				}

				if (this.adapter?.log?.debug) {
					this.adapter.log.debug(`MsgStorage: read '${filePath}', ${Buffer.byteLength(text, 'utf8')} bytes`);
				}

				return deserializeWithMaps(text, this._mapTypeMarker);
			} catch (e) {
				// Treat missing/invalid data as fallback; exact error varies by backend.
				this.adapter.log.debug(
					`MsgStorage: read/parse (${filePath}) failed, using fallback: ${e?.message || e}`,
				);
				return fallback;
			}
		});
	}

	/**
	 * Writes JSON to the file store, optionally throttled.
	 * When throttled, only the latest value is persisted after the interval.
	 *
	 * @param {any} value  file content (json)
	 */
	async writeJson(value) {
		if (!this.writeIntervalMs) {
			return this._queue(() => this._writeNow(value));
		}

		// Keep only the most recent value and schedule a single write.
		this._pendingValue = value;

		if (!this._flushPromise) {
			this._flushPromise = new Promise((resolve, reject) => {
				this._flushResolve = resolve;
				this._flushReject = reject;
			});
		}

		if (!this._flushTimer) {
			this._flushTimer = setTimeout(() => {
				this._flushTimer = null;
				this._finalizeScheduledWrite();
			}, this.writeIntervalMs);
		}

		return this._flushPromise;
	}

	/**
	 * Forces a write of a buffered value, intended for onUnload.
	 */
	async flushPending() {
		if (!this._flushPromise) {
			return this._queue.current;
		}

		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
			this._flushTimer = null;
		}

		return this._finalizeScheduledWrite();
	}

	/**
	 * Completes the scheduled write and resolves the pending promise.
	 *
	 * @returns {Promise<any>} Promise that resolves when the scheduled write completes.
	 */
	_finalizeScheduledWrite() {
		const pending = this._pendingValue;
		this._pendingValue = undefined;

		const resolve = this._flushResolve;
		const reject = this._flushReject;

		this._flushPromise = null;
		this._flushResolve = null;
		this._flushReject = null;

		const writePromise = this._queue(() => this._writeNow(pending));
		writePromise.then(resolve, reject);
		return writePromise;
	}

	/**
	 * Builds a file path under the optional base directory.
	 *
	 * @param {string} fileName File name.
	 * @returns {string} File path.
	 */
	_filePathFor(fileName) {
		return this.baseDir ? `${this.baseDir}/${fileName}` : fileName;
	}
}

module.exports = { MsgStorage };
