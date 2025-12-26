/**
 * MsgStorage
 * ==========
 * Lightweight persistence helper for ioBroker file storage.
 *
 * Docs: ../docs/modules/MsgStorage.md
 *
 * Core responsibilities
 * - Persist a single JSON document (commonly the full message list) under the adapter's file namespace.
 * - Provide a read API with robust fallback behavior for missing/invalid files.
 * - Serialize writes to avoid concurrent file operations and reduce write amplification via throttling.
 *
 * Design guidelines / invariants
 * - Single file, whole-document persistence: callers typically persist the complete current state (e.g. `Array<Message>`).
 *   This class does not implement partial updates or merging.
 * - Best-effort durability: writes are queued and may be throttled; callers are not required to await them. For shutdown
 *   scenarios, call `flushPending()` to force a best-effort final write.
 * - Ordered I/O: all read/write operations are serialized through an internal promise queue (`createOpQueue()`), so the
 *   last scheduled write deterministically “wins”.
 * - Map-safe JSON: values that contain `Map` instances are encoded via `serializeWithMaps()` and revived on read via
 *   `deserializeWithMaps()`. This allows the message model to contain metrics or other maps without losing structure.
 *
 * Required adapter APIs:
 * - `readFileAsync(metaId, path)`
 * - `writeFileAsync(metaId, path, data)`
 *
 * Optional adapter APIs:
 * - `mkdirAsync(metaId, dir)` (used for baseDir creation)
 * - `renameFileAsync(metaId, oldPath, newPath)` + `delFileAsync(metaId, path)` (used for atomic writes)
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
	 * Create a new MsgStorage instance.
	 *
	 * Notes:
	 * - `metaId` is the ioBroker “file namespace root” (usually the adapter instance namespace).
	 * - `baseDir` is a logical folder below `metaId` (slashes are trimmed).
	 * - `writeIntervalMs` enables write coalescing: multiple `writeJson()` calls within the interval
	 *   result in a single persisted write containing the latest value.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance (ioBroker file APIs).
	 * @param {object} [options] Optional configuration.
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
	 * Call once during startup.
	 *
	 * Ensures the ioBroker file storage meta object exists and (optionally) creates the base directory.
	 * This method is async because it may create meta objects and folders.
	 */
	async init() {
		await ensureMetaObject(this.adapter, this.metaId);
		await ensureBaseDir(this.adapter, this.metaId, this.baseDir);
		const filePath = this._filePathFor(this.fileName);
		this.adapter?.log?.info?.(`MsgStorage initialized: file=${filePath}, interval=${this.writeIntervalMs}ms`);
	}

	/**
	 * Writes JSON immediately (no throttling).
	 * Uses atomic write (tmp + rename) when supported.
	 *
	 * Implementation details:
	 * - When `renameFileAsync` is available, the write is performed as:
	 *   1) write `<fileName>.tmp`
	 *   2) delete old target (best-effort)
	 *   3) rename tmp -> target
	 * - When atomic rename is unavailable or fails, falls back to a direct write of the final file.
	 * - Temp file cleanup is best-effort.
	 *
	 * @param {any} value File content (will be JSON serialized).
	 */
	async _writeNow(value) {
		const tmpName = `${this.fileName}.tmp`;
		const filePath = this._filePathFor(this.fileName);
		const tmpPath = this._filePathFor(tmpName);
		const json = serializeWithMaps(value, this._mapTypeMarker);
		const sizeBytes = Buffer.byteLength(json, 'utf8');

		// If rename is unavailable, fall back to a direct write.
		// @ts-expect-error renameFileAsync may not be available
		if (typeof this.adapter.renameFileAsync !== 'function') {
			await this.adapter.writeFileAsync(this.metaId, filePath, json);
			this.adapter?.log?.debug?.(`MsgStorage: ${filePath} written, mode=override, ${sizeBytes} bytes`);
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

			// @ts-expect-error renameFileAsync may not be available
			await this.adapter.renameFileAsync(this.metaId, tmpPath, filePath);
			this.adapter?.log?.debug?.(`MsgStorage: ${filePath} written, mode=rename, ${sizeBytes} bytes`);
		} catch (e) {
			// If rename fails, log and fall back to direct write.
			this.adapter?.log?.warn?.(`Atomic write failed (${e?.message || e}), writing directly to ${filePath}`);
			await this.adapter.writeFileAsync(this.metaId, filePath, json);
			this.adapter?.log?.debug?.(`MsgStorage: ${filePath} written, mode=fallback, ${sizeBytes} bytes`);
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
	 * Behavior:
	 * - Returns `fallback` when the file is missing, empty/whitespace, or contains invalid JSON.
	 * - Revives `Map` instances that were encoded via `serializeWithMaps()`.
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
					this.adapter?.log?.warn?.(`MsgStorage: '${filePath}' - file missing or empty`);
					return fallback;
				}

				const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
				if (!text.trim()) {
					this.adapter?.log?.warn?.(`MsgStorage: '${filePath}' - empty or whitespace only`);
					return fallback;
				}

				this.adapter?.log?.debug?.(`MsgStorage: read '${filePath}', ${Buffer.byteLength(text, 'utf8')} bytes`);

				return deserializeWithMaps(text, this._mapTypeMarker);
			} catch (e) {
				// Treat missing/invalid data as fallback; exact error varies by backend.
				this.adapter?.log?.debug?.(
					`MsgStorage: read/parse (${filePath}) failed, using fallback: ${e?.message || e}`,
				);
				return fallback;
			}
		});
	}

	/**
	 * Writes JSON to the file store, optionally throttled.
	 *
	 * Throttling semantics:
	 * - If `writeIntervalMs` is `0`, the write is queued and executed immediately.
	 * - Otherwise, multiple `writeJson()` calls within the interval are coalesced:
	 *   only the latest value is persisted when the timer fires.
	 *
	 * Return value:
	 * - Returns a promise that resolves once the scheduled write has been persisted.
	 * - Multiple calls during a throttle window share the same promise.
	 *
	 * @param {any} value File content (will be JSON serialized).
	 * @returns {Promise<any>} Resolves when the corresponding write completes.
	 */
	async writeJson(value) {
		if (!this.writeIntervalMs) {
			// Immediate mode still uses the queue to preserve ordering.
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
	 * Forces a write of a buffered value (intended for adapter unload/shutdown).
	 *
	 * If a throttled write is pending, the timer is canceled and the write is performed immediately.
	 * If nothing is pending, this resolves to the current queue tail.
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
	 * Internal helper used by the throttle timer and `flushPending()`.
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

		// Serialize the actual write behind any ongoing operation.
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
