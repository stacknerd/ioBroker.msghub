/**
 * Append-only archive for message lifecycle events.
 * Stores one JSONL file per ref under the adapter file namespace.
 * Designed for auditability and later replay: events are immutable, ordered by write time,
 * and batched to reduce storage churn while still preserving per-ref ordering.
 */
class MsgArchive {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance used for ioBroker file storage APIs.
	 * @param {object} [options] Optional configuration for storage layout and batching.
	 * @param {string} [options.metaId] File storage root meta ID; defaults to adapter.namespace.
	 * @param {string} [options.baseDir] Base folder for archive files (e.g. "archive"); empty string stores files at root.
	 * @param {string} [options.fileExtension] File extension without leading dot (default: "jsonl").
	 * @param {number} [options.flushIntervalMs] Flush interval in ms (0 = immediate; default 10000).
	 * @param {number} [options.maxBatchSize] Max queued events per ref before forced flush (default 200).
	 */
	constructor(adapter, options = {}) {
		if (!adapter) {
			throw new Error('MsgArchive: adapter is required');
		}

		this.adapter = adapter;
		this.metaId = options.metaId || adapter.namespace;
		this.baseDir = typeof options.baseDir === 'string' ? options.baseDir.replace(/^\/+|\/+$/g, '') : '';
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

		// Promise chain used as a simple mutex to serialize writes across refs.
		this._op = Promise.resolve();

		// Pending events per ref file key, along with timers and waiters.
		this._pending = new Map();

		this._mapTypeMarker = '__msghubType';
	}

	/**
	 * Call once during startup. Ensures the file storage root and base folder exist.
	 *
	 * @returns {Promise<void>} Resolves when the archive is ready for writes.
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
	 * @param {object} message Full message object to persist as a snapshot.
	 * @param {object} [options] Optional behavior overrides.
	 * @param {string} [options.event] Override event name (defaults to "create").
	 * @param {boolean} [options.flushNow] Flush immediately instead of waiting for batching.
	 * @param {boolean} [options.throwOnError] Reject the promise on failure (otherwise log + resolve).
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
	 * @param {string} ref Message ref that identifies the archive file.
	 * @param {object} patch Patch payload requested by the caller (may include ref).
	 * @param {object} [existing] Message before the patch (used to compute diffs).
	 * @param {object} [updated] Message after the patch (used to compute diffs).
	 * @param {object} [options] Optional behavior overrides.
	 * @param {boolean} [options.flushNow] Flush immediately instead of waiting for batching.
	 * @param {boolean} [options.throwOnError] Reject the promise on failure (otherwise log + resolve).
	 */
	appendPatch(ref, patch, existing = undefined, updated = undefined, options = {}) {
		const { resolvedExisting, resolvedUpdated, resolvedOptions } = this._normalizeAppendPatchArgs(
			existing,
			updated,
			options,
		);
		const payload = this._buildPatchPayload(ref, patch, resolvedExisting, resolvedUpdated);
		return this._appendEvent(ref, 'patch', payload, resolvedOptions).catch(err =>
			this._handleAppendError('patch', ref, err, resolvedOptions),
		);
	}

	/**
	 * Normalize appendPatch args to support legacy (ref, patch, options) calls.
	 *
	 * @param {object|undefined} existing Existing message or options object in legacy call shape.
	 * @param {object|undefined} updated Updated message when provided.
	 * @param {object} options Options passed by the caller in the modern signature.
	 * @returns {{resolvedExisting: object|undefined, resolvedUpdated: object|undefined, resolvedOptions: object}} Normalized argument bundle.
	 */
	_normalizeAppendPatchArgs(existing, updated, options) {
		const isOptions =
			existing &&
			typeof existing === 'object' &&
			!Array.isArray(existing) &&
			(Object.prototype.hasOwnProperty.call(existing, 'flushNow') ||
				Object.prototype.hasOwnProperty.call(existing, 'throwOnError'));

		if (updated === undefined && isOptions) {
			return { resolvedExisting: undefined, resolvedUpdated: undefined, resolvedOptions: existing };
		}

		return { resolvedExisting: existing, resolvedUpdated: updated, resolvedOptions: options || {} };
	}

	/**
	 * Builds a patch payload that includes requested + added/removed diffs.
	 *
	 * @param {string} ref Message ref used to strip redundant ref fields.
	 * @param {object} patch Patch payload requested by the caller.
	 * @param {object|undefined} existing Message before patch (optional).
	 * @param {object|undefined} updated Message after patch (optional).
	 * @returns {object} Patch payload for the archive, including diffs when possible.
	 */
	_buildPatchPayload(ref, patch, existing, updated) {
		const requested = this._stripRefFromPatch(patch, ref);
		if (existing === undefined && updated === undefined) {
			return { ok: true, requested };
		}

		const diff = this._diffValue(existing, updated);
		const payload = { ok: true, requested };
		if (diff?.added !== undefined) {
			payload.added = diff.added;
		}
		if (diff?.removed !== undefined) {
			payload.removed = diff.removed;
		}
		return payload;
	}

	/**
	 * Removes the ref field from the patch when it matches the message ref.
	 *
	 * @param {object} patch Patch payload that may contain a ref field.
	 * @param {string} ref Message ref to compare against.
	 * @returns {object} Patch payload without redundant ref when it matches.
	 */
	_stripRefFromPatch(patch, ref) {
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			return patch;
		}
		if (!Object.prototype.hasOwnProperty.call(patch, 'ref')) {
			return patch;
		}
		if (typeof patch.ref === 'string' && patch.ref.trim() === String(ref).trim()) {
			const { ref: _ref, ...rest } = patch;
			return rest;
		}
		return patch;
	}

	/**
	 * Produces a shallow diff descriptor for archive storage.
	 *
	 * @param {any} existing Value before the change.
	 * @param {any} updated Value after the change.
	 * @returns {{added: any, removed: any} | null} Diff object or null when equal.
	 */
	_diffValue(existing, updated) {
		if (this._isEqual(existing, updated)) {
			return null;
		}
		if (existing instanceof Map && updated instanceof Map) {
			return this._diffMap(existing, updated);
		}
		if (Array.isArray(existing) && Array.isArray(updated)) {
			return { added: updated, removed: existing };
		}
		if (this._isPlainObject(existing) && this._isPlainObject(updated)) {
			const added = {};
			const removed = {};
			const keys = new Set([...Object.keys(existing), ...Object.keys(updated)]);
			keys.forEach(key => {
				if (!Object.prototype.hasOwnProperty.call(updated, key)) {
					removed[key] = existing[key];
					return;
				}
				if (!Object.prototype.hasOwnProperty.call(existing, key)) {
					added[key] = updated[key];
					return;
				}
				const child = this._diffValue(existing[key], updated[key]);
				if (child) {
					if (child.added !== undefined) {
						added[key] = child.added;
					}
					if (child.removed !== undefined) {
						removed[key] = child.removed;
					}
				}
			});
			const hasAdded = Object.keys(added).length > 0;
			const hasRemoved = Object.keys(removed).length > 0;
			if (!hasAdded && !hasRemoved) {
				return null;
			}
			return {
				added: hasAdded ? added : undefined,
				removed: hasRemoved ? removed : undefined,
			};
		}
		return { added: updated, removed: existing };
	}

	/**
	 * Diff two Map instances by key/value changes.
	 *
	 * @param {Map<any, any>} existing Previous map.
	 * @param {Map<any, any>} updated Updated map.
	 * @returns {{added: object, removed: object} | null} Diff object or null when equal.
	 */
	_diffMap(existing, updated) {
		const added = {};
		const removed = {};
		const keys = new Set([...existing.keys(), ...updated.keys()]);
		keys.forEach(key => {
			const hasBefore = existing.has(key);
			const hasAfter = updated.has(key);
			if (!hasAfter && hasBefore) {
				removed[key] = existing.get(key);
				return;
			}
			if (!hasBefore && hasAfter) {
				added[key] = updated.get(key);
				return;
			}
			const before = existing.get(key);
			const after = updated.get(key);
			if (!this._isEqual(before, after)) {
				added[key] = after;
				removed[key] = before;
			}
		});
		const hasAdded = Object.keys(added).length > 0;
		const hasRemoved = Object.keys(removed).length > 0;
		if (!hasAdded && !hasRemoved) {
			return null;
		}
		return {
			added: hasAdded ? added : undefined,
			removed: hasRemoved ? removed : undefined,
		};
	}

	/**
	 * Check for plain objects (Object or null prototype).
	 *
	 * @param {any} v Value to test.
	 * @returns {boolean} True when v is a plain object.
	 */
	_isPlainObject(v) {
		return (
			v !== null &&
			typeof v === 'object' &&
			(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
		);
	}

	/**
	 * Deep-ish equality check for Maps, arrays, and plain objects.
	 *
	 * @param {any} a First value.
	 * @param {any} b Second value.
	 * @returns {boolean} True when values are structurally equal.
	 */
	_isEqual(a, b) {
		if (a === b) {
			return true;
		}
		if (a instanceof Map && b instanceof Map) {
			if (a.size !== b.size) {
				return false;
			}
			for (const [key, val] of a.entries()) {
				if (!b.has(key) || !this._isEqual(val, b.get(key))) {
					return false;
				}
			}
			return true;
		}
		if (Array.isArray(a) && Array.isArray(b)) {
			if (a.length !== b.length) {
				return false;
			}
			for (let i = 0; i < a.length; i += 1) {
				if (!this._isEqual(a[i], b[i])) {
					return false;
				}
			}
			return true;
		}
		if (this._isPlainObject(a) && this._isPlainObject(b)) {
			const aKeys = Object.keys(a);
			const bKeys = Object.keys(b);
			if (aKeys.length !== bKeys.length) {
				return false;
			}
			for (const key of aKeys) {
				if (!Object.prototype.hasOwnProperty.call(b, key) || !this._isEqual(a[key], b[key])) {
					return false;
				}
			}
			return true;
		}
		return false;
	}

	/**
	 * Append a delete event.
	 *
	 * @param {string|object} refOrMessage Message ref or full message object.
	 * @param {object} [options] Optional behavior overrides.
	 * @param {string} [options.event] Override event name (defaults to "delete").
	 * @param {boolean} [options.flushNow] Flush immediately instead of waiting for batching.
	 * @param {boolean} [options.throwOnError] Reject the promise on failure (otherwise log + resolve).
	 */
	appendDelete(refOrMessage, options = {}) {
		const ref = typeof refOrMessage === 'string' ? refOrMessage : refOrMessage?.ref;
		const payload =
			refOrMessage && typeof refOrMessage === 'object' && !Array.isArray(refOrMessage)
				? { snapshot: refOrMessage }
				: {};
		const eventName = typeof options.event === 'string' && options.event.trim() ? options.event.trim() : 'delete';
		return this._appendEvent(ref, eventName, payload, options).catch(err =>
			this._handleAppendError(eventName, ref, err, options),
		);
	}

	/**
	 * Append a lifecycle event for a ref. Internal helper.
	 *
	 * @param {string} ref Message ref used to route to the correct archive file.
	 * @param {string} event Event type (e.g. "create", "patch", "delete").
	 * @param {object} [payload] Additional event payload (snapshot, patch, etc).
	 * @param {object} [options] Optional behavior overrides.
	 * @param {boolean} [options.flushNow] Flush immediately instead of waiting for batching.
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
	 * @param {string} action Action label (snapshot, patch, delete, etc).
	 * @param {string} ref Message ref for logging context.
	 * @param {Error} err Error instance.
	 * @param {object} options Options that may include throwOnError.
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
	 *
	 * @returns {Promise<void>} Resolves when all queued flushes have completed.
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
	 * @returns {Promise<any>} Promise chained onto the internal queue.
	 */
	_queue(fn) {
		this._op = this._op.then(fn, fn);
		return this._op;
	}

	/**
	 * Ensures the meta object exists and has the correct type.
	 *
	 * @returns {Promise<void>} Resolves once the meta object is present.
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
	 *
	 * @returns {Promise<void>} Resolves after attempting to create each path segment.
	 */
	async _ensureBaseDir() {
		if (!this.baseDir || typeof this.adapter.mkdirAsync !== 'function') {
			return;
		}
		const parts = this.baseDir.split('/').filter(Boolean);
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			try {
				await this.adapter.mkdirAsync(this.metaId, current);
			} catch {
				// ignore; some backends auto-create folders on write
			}
		}
	}

	/**
	 * Adds an entry to the queue for a ref.
	 *
	 * @param {string} ref Message ref.
	 * @param {object} entry Event entry already normalized for storage.
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

		// Store waiters so we can resolve/reject all pending appends after the flush.
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

		// Serialize writes so each ref file is appended in order.
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

			// Drop empty pending state to keep memory footprint bounded.
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
	 * @param {Array<object>} events Event entries to append in order.
	 * @returns {Promise<void>} Resolves after the file has been rewritten with the new lines.
	 */
	async _appendEvents(refKey, events) {
		// ioBroker file storage does not expose append, so read + re-write the full JSONL file.
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
	 * @returns {string} Encoded ref key (URL-encoded) suitable for file names.
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
	 * @returns {string} JSON string with Map values encoded as a typed wrapper.
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
