/**
 * Append-only archive for message lifecycle events.
 * Stores one file per ref under the adapter file namespace.
 */
class MsgArchive {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance for ioBroker file storage.
	 * @param {object} [options] Options object.
	 * @param {string} [options.metaId] File storage root meta ID; defaults to adapter.namespace.
	 * @param {string} [options.baseDir] Base folder for archive files (e.g. "archive").
	 * @param {string} [options.fileExtension] File extension without leading dot (default: "jsonl").
	 * @param {number} [options.flushIntervalMs] Flush interval in ms (0 = immediate).
	 * @param {number} [options.maxBatchSize] Max queued events per ref before forced flush.
	 */
	constructor(adapter, options = {}) {
		if (!adapter) {
			throw new Error('MsgArchive: adapter is required');
		}

		this.adapter = adapter;
		this.metaId = options.metaId || adapter.namespace;
		this.baseDir = typeof options.baseDir === 'string' ? options.baseDir.replace(/^\/+|\/+$/g, '') : 'archive';
		this.fileExtension =
			typeof options.fileExtension === 'string' && options.fileExtension.trim()
				? options.fileExtension.trim().replace(/^\./, '')
				: 'jsonl';
		this.flushIntervalMs =
			typeof options.flushIntervalMs === 'number' && Number.isFinite(options.flushIntervalMs)
				? Math.max(0, options.flushIntervalMs)
				: 10000;
		this.maxBatchSize =
			typeof options.maxBatchSize === 'number' && Number.isFinite(options.maxBatchSize)
				? Math.max(1, options.maxBatchSize)
				: 200;

		this.schemaVersion = 1;

		// Promise chain used as a simple mutex to serialize writes.
		this._op = Promise.resolve();

		// Pending events per ref file key.
		this._pending = new Map();

		this._mapTypeMarker = '__msghubType';
	}

	/**
	 * Call once during startup. Ensures the file storage root exists.
	 */
	async init() {
		await this._ensureMetaObject();
		await this._ensureBaseDir();
		if (this.adapter?.log?.info) {
			this.adapter.log.info(
				`MsgArchive initialized: baseDir=${this.baseDir || '.'}, ext=${this.fileExtension}, interval=${this.flushIntervalMs}ms`,
			);
		}
	}

	/**
	 * Append a full message snapshot (usually on create).
	 *
	 * @param {object} message Full message object.
	 * @param {object} [options] Options.
	 * @param {string} [options.event] Override event name.
	 * @param {boolean} [options.flushNow] Flush immediately.
	 * @param {boolean} [options.throwOnError] Reject promise on failure.
	 */
	appendSnapshot(message, options = {}) {
		if (!message || typeof message !== 'object') {
			return this._handleAppendError(
				'snapshot',
				message?.ref,
				new Error('MsgArchive.appendSnapshot: message is required'),
				options,
			);
		}
		const event = typeof options.event === 'string' && options.event.trim() ? options.event.trim() : 'create';
		return this._appendEvent(message.ref, event, { snapshot: message }, options).catch(err =>
			this._handleAppendError(event, message.ref, err, options),
		);
	}

	/**
	 * Append a patch event.
	 *
	 * @param {string} ref Message ref.
	 * @param {object} patch Patch payload.
	 * @param {object} [options] Options.
	 * @param {boolean} [options.flushNow] Flush immediately.
	 * @param {boolean} [options.throwOnError] Reject promise on failure.
	 */
	appendPatch(ref, patch, options = {}) {
		return this._appendEvent(ref, 'patch', { patch }, options).catch(err =>
			this._handleAppendError('patch', ref, err, options),
		);
	}

	/**
	 * Append a delete event.
	 *
	 * @param {string|object} refOrMessage Message ref or full message object.
	 * @param {object} [options] Options.
	 * @param {boolean} [options.flushNow] Flush immediately.
	 * @param {boolean} [options.throwOnError] Reject promise on failure.
	 */
	appendDelete(refOrMessage, options = {}) {
		const ref = typeof refOrMessage === 'string' ? refOrMessage : refOrMessage?.ref;
		const payload =
			refOrMessage && typeof refOrMessage === 'object' && !Array.isArray(refOrMessage)
				? { snapshot: refOrMessage }
				: {};
		return this._appendEvent(ref, 'delete', payload, options).catch(err =>
			this._handleAppendError('delete', ref, err, options),
		);
	}

	/**
	 * Append a lifecycle event for a ref. Internal helper.
	 *
	 * @param {string} ref Message ref.
	 * @param {string} event Event type (e.g. "create", "patch", "delete").
	 * @param {object} [payload] Additional event payload (snapshot, patch, etc).
	 * @param {object} [options] Options.
	 * @param {boolean} [options.flushNow] Flush immediately.
	 * @returns {Promise<void>} Resolves when the event is persisted.
	 */
	_appendEvent(ref, event, payload = {}, options = {}) {
		if (typeof ref !== 'string' || !ref.trim()) {
			return Promise.reject(new Error('MsgArchive: ref is required'));
		}
		if (typeof event !== 'string' || !event.trim()) {
			return Promise.reject(new Error('MsgArchive: event is required'));
		}

		const { ts, ref: _ref, event: _event, ...rest } = payload || {};
		const entry = {
			schema_v: this.schemaVersion,
			ts: typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now(),
			ref: ref.trim(),
			event: event.trim(),
			...rest,
		};

		return this._enqueueEvent(ref, entry, Boolean(options.flushNow));
	}

	/**
	 * Logs append errors and optionally rethrows.
	 *
	 * @param {string} action Action label.
	 * @param {string} ref Message ref.
	 * @param {Error} err Error instance.
	 * @param {object} options Options.
	 * @returns {Promise<void>} Resolves unless throwOnError is set.
	 */
	_handleAppendError(action, ref, err, options = {}) {
		const safeRef = ref ? String(ref) : '<unknown>';
		if (this.adapter?.log?.warn) {
			this.adapter.log.warn(`MsgArchive ${action} failed for ref ${safeRef}: ${err?.message || err}`);
		}
		if (options.throwOnError) {
			return Promise.reject(err);
		}
		return Promise.resolve();
	}

	/**
	 * Flushes all pending events immediately.
	 */
	async flushPending() {
		const pendingEntries = Array.from(this._pending.entries());
		if (pendingEntries.length === 0) {
			return this._op;
		}

		const flushes = pendingEntries.map(([refKey, pending]) => this._flushRef(refKey, pending));
		await Promise.allSettled(flushes);
		return this._op;
	}

	/**
	 * Serializes async operations to avoid concurrent writes.
	 *
	 * @param {() => Promise<any>} fn Operation to run in the serialized queue.
	 */
	_queue(fn) {
		this._op = this._op.then(fn, fn);
		return this._op;
	}

	/**
	 * Ensures the meta object exists and has the correct type.
	 */
	async _ensureMetaObject() {
		const obj = await this.adapter.getObjectAsync(this.metaId);

		if (obj) {
			if (obj.type !== 'meta') {
				throw new Error(
					`File-Storage Root "${this.metaId}" exists but is type "${obj.type}", not "meta". ` +
						`Choose another metaId (e.g. "${this.metaId}.__files") or delete/rename the existing object "${this.metaId}".`,
				);
			}
			return;
		}

		await this.adapter.setObjectAsync(this.metaId, {
			type: 'meta',
			common: {
				name: `${this.adapter.name} file storage`,
				type: 'meta.user',
			},
			native: {},
		});
	}

	/**
	 * Ensures the base directory exists in file storage.
	 */
	async _ensureBaseDir() {
		if (!this.baseDir || typeof this.adapter.mkdirAsync !== 'function') {
			return;
		}
		try {
			await this.adapter.mkdirAsync(this.metaId, this.baseDir);
		} catch {
			// ignore; some backends auto-create folders on write
		}
	}

	/**
	 * Adds an entry to the queue for a ref.
	 *
	 * @param {string} ref Message ref.
	 * @param {object} entry Event entry.
	 * @param {boolean} flushNow Force immediate flush.
	 * @returns {Promise<void>} Promise resolved when the entry is written.
	 */
	_enqueueEvent(ref, entry, flushNow) {
		const refKey = this._normalizeRef(ref);
		let pending = this._pending.get(refKey);

		if (!pending) {
			pending = {
				events: [],
				waiters: [],
				timer: null,
				flushing: false,
				flushPromise: null,
			};
			this._pending.set(refKey, pending);
		}

		pending.events.push(entry);

		const promise = new Promise((resolve, reject) => {
			pending.waiters.push({ resolve, reject });
		});

		if (flushNow || !this.flushIntervalMs || pending.events.length >= this.maxBatchSize) {
			this._flushRef(refKey, pending);
		} else if (!pending.timer) {
			pending.timer = setTimeout(() => this._flushRef(refKey, pending), this.flushIntervalMs);
		}

		return promise;
	}

	/**
	 * Flushes queued events for a ref.
	 *
	 * @param {string} refKey Normalized ref key.
	 * @param {object} pending Pending state object.
	 * @returns {Promise<void>} Promise resolved when the flush completes.
	 */
	_flushRef(refKey, pending) {
		if (pending.flushing) {
			return pending.flushPromise || this._op;
		}

		if (pending.timer) {
			clearTimeout(pending.timer);
			pending.timer = null;
		}

		if (pending.events.length === 0) {
			return this._op;
		}

		const events = pending.events;
		const waiters = pending.waiters;
		pending.events = [];
		pending.waiters = [];
		pending.flushing = true;

		const writePromise = this._queue(() => this._appendEvents(refKey, events));
		pending.flushPromise = writePromise;

		writePromise.then(
			() => waiters.forEach(waiter => waiter.resolve()),
			err => waiters.forEach(waiter => waiter.reject(err)),
		);

		writePromise.finally(() => {
			pending.flushing = false;
			pending.flushPromise = null;

			if (pending.events.length > 0) {
				if (!this.flushIntervalMs) {
					this._flushRef(refKey, pending);
				} else if (!pending.timer) {
					pending.timer = setTimeout(() => this._flushRef(refKey, pending), this.flushIntervalMs);
				}
				return;
			}

			if (pending.waiters.length === 0) {
				this._pending.delete(refKey);
			}
		});

		return writePromise;
	}

	/**
	 * Appends events to the ref file (JSONL).
	 *
	 * @param {string} refKey Normalized ref key.
	 * @param {Array<object>} events Event entries to append.
	 */
	async _appendEvents(refKey, events) {
		const filePath = this._filePathForRef(refKey);
		const existing = await this._readFileText(filePath);
		const existingTrimmed = existing ? existing.replace(/\s+$/, '') : '';
		const newLines = events.map(entry => this._serialize(entry)).join('\n');
		const combined = existingTrimmed ? `${existingTrimmed}\n${newLines}\n` : `${newLines}\n`;

		await this.adapter.writeFileAsync(this.metaId, filePath, combined);

		if (this.adapter?.log?.debug) {
			const sizeBytes = Buffer.byteLength(combined, 'utf8');
			this.adapter.log.debug(`MsgArchive append ${events.length} event(s) -> ${filePath}, ${sizeBytes} bytes`);
		}
	}

	/**
	 * Reads file text from storage (returns empty string when missing).
	 *
	 * @param {string} filePath File path under the file store.
	 * @returns {Promise<string>} File content (utf8) or empty string.
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
			if (this.adapter?.log?.debug) {
				this.adapter.log.debug(`MsgArchive read failed (${filePath}): ${e?.message || e}`);
			}
			return '';
		}
	}

	/**
	 * Returns a normalized ref key that is safe for flat file names.
	 *
	 * @param {string} ref Message ref.
	 * @returns {string} Encoded ref key.
	 */
	_normalizeRef(ref) {
		return encodeURIComponent(String(ref).trim());
	}

	/**
	 * Builds the archive file path for a ref key.
	 *
	 * @param {string} refKey Normalized ref key.
	 * @returns {string} File path under the archive base dir.
	 */
	_filePathForRef(refKey) {
		const fileName = `${refKey}.${this.fileExtension}`;
		return this.baseDir ? `${this.baseDir}/${fileName}` : fileName;
	}

	/**
	 * Serializes data to JSON while preserving Map values.
	 *
	 * @param {any} value Data to serialize.
	 * @returns {string} JSON string with Map values encoded.
	 */
	_serialize(value) {
		return JSON.stringify(value, (key, val) => {
			if (val instanceof Map) {
				return { [this._mapTypeMarker]: 'Map', value: Array.from(val.entries()) };
			}
			return val;
		});
	}
}

module.exports = { MsgArchive };
