/**
 * MsgArchive
 * ==========
 * Append-only archive for message lifecycle events.
 *
 * Docs: ../docs/modules/MsgArchive.md
 *
 * Core responsibilities
 * - Persist immutable lifecycle events for messages as newline-delimited JSON (JSONL).
 * - Store one archive file per message ref and week segment to keep files small and make per-message inspection easy.
 * - Batch and serialize writes to reduce storage churn while preserving per-ref event ordering.
 *
 * Design guidelines / invariants
 * - Append-only, immutable log: archive entries are never updated or deleted; new events are appended.
 * - Per-ref ordering: events for the same message ref are written in the same order they were enqueued.
 * - Best-effort durability: callers typically do not await archive writes. Errors are logged and can optionally
 *   be rethrown (`throwOnError`) for test/debug scenarios.
 * - JSONL format: each line is a single JSON object. This is friendly for streaming, grepping, and replay tools.
 * - Backend constraints: ioBroker file storage does not provide an "append" API, so appends are implemented as
 *   read-the-whole-file + rewrite-with-added-lines. For large archive files this is O(fileSize) per flush.
 * - Retention: optional best-effort cleanup of old weekly segments (`keepPreviousWeeks`).
 *
 * File naming and refs
 * - Refs are URL-encoded (`encodeURIComponent`) to generate filesystem-friendly path segments.
 * - Dots in the (encoded) ref split the archive path into subdirectories to keep folder listings small,
 *   with one exception: the first `.<digits>` segment is kept as part of the first path segment
 *   (e.g. `IngestHue.0.*` becomes `IngestHue.0/...`, not `IngestHue/0/...`).
 * - Archive files are segmented by local-week (Monday 00:00) and named as:
 *   `<encodedRefWithDotsAsSlashes>.<YYYYMMDD>.<fileExtension>` under `baseDir`,
 *   where `YYYYMMDD` is the Monday start date of the segment in local time.
 *
 * Map-safe JSON
 * - Entries are serialized via `serializeWithMaps()` so `Map` values (e.g. metrics) remain intact.
 */

const { DEFAULT_MAP_TYPE_MARKER, serializeWithMaps, ensureMetaObject, ensureBaseDir, createOpQueue } = require(
	`${__dirname}/MsgUtils`,
);

/**
 * MsgArchive
 */
class MsgArchive {
	/**
	 * Create a new archive instance.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance used for ioBroker file storage APIs.
	 * @param {object} [options] Optional configuration for storage layout and batching.
	 * @param {string} [options.metaId] File storage root meta ID; defaults to adapter.namespace.
	 * @param {string} [options.baseDir] Base folder for archive files (e.g. "data/archive"); empty string stores files at root.
	 * @param {string} [options.fileExtension] File extension without leading dot (default: "jsonl").
	 * @param {number} [options.flushIntervalMs] Flush interval in ms (0 = immediate; default 10000).
	 * @param {number} [options.maxBatchSize] Max queued events per ref before forced flush (default 200).
	 * @param {number} [options.keepPreviousWeeks] How many previous week segments to keep, in addition to the current one (default 3).
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
		this.keepPreviousWeeks =
			typeof options.keepPreviousWeeks === 'number' && Number.isFinite(options.keepPreviousWeeks)
				? Math.max(0, Math.trunc(options.keepPreviousWeeks))
				: 3;

		this.schemaVersion = 1;

		// Promise chain used as a simple mutex to serialize writes across refs.
		this._queue = createOpQueue();

		// Pending events per ref file key, along with timers and waiters.
		this._pending = new Map();

		// Best-effort cache of directories we already attempted to create.
		this._ensuredDirs = new Set();

		this._mapTypeMarker = DEFAULT_MAP_TYPE_MARKER;

		// Best-effort runtime status for diagnostics / stats UIs.
		this._lastFlushedAt = 0;
		this._sizeEstimateAt = 0;
		this._sizeEstimateBytes = null;
		this._sizeEstimateIsComplete = false;
	}

	/**
	 * Determine the local-week segment start (Monday 00:00) for a timestamp.
	 *
	 * @param {number} ts Epoch milliseconds.
	 * @returns {Date} Date set to local Monday 00:00.
	 */
	_weekStartLocal(ts) {
		const t = typeof ts === 'number' && Number.isFinite(ts) ? ts : Date.now();
		const d = new Date(t);
		const day = d.getDay(); // 0 (Sun) .. 6 (Sat)
		const daysSinceMonday = (day + 6) % 7; // Mon -> 0, Sun -> 6
		d.setHours(0, 0, 0, 0);
		d.setDate(d.getDate() - daysSinceMonday);
		return d;
	}

	/**
	 * Format a date as YYYYMMDD in local time.
	 *
	 * @param {Date} d Date instance (local time).
	 * @returns {string} YYYYMMDD.
	 */
	_formatLocalYyyyMmDd(d) {
		const year = d.getFullYear();
		const month = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${year}${month}${day}`;
	}

	/**
	 * Compute the segment key for a timestamp (local-week start, Monday 00:00).
	 *
	 * @param {number} ts Epoch milliseconds.
	 * @returns {string} Segment key as YYYYMMDD.
	 */
	_segmentKeyForTs(ts) {
		return this._formatLocalYyyyMmDd(this._weekStartLocal(ts));
	}

	/**
	 * Returns the set of segment keys that should be kept, based on `keepPreviousWeeks`.
	 *
	 * Semantics:
	 * - keepPreviousWeeks = 0 -> keep only the current segment
	 * - keepPreviousWeeks = 3 -> keep current + 3 previous segments (4 segments total)
	 *
	 * @param {number} nowTs Timestamp used to determine the "current week".
	 * @returns {Set<string>} Set of segment keys (YYYYMMDD) to keep.
	 */
	_segmentKeysToKeep(nowTs) {
		const keep =
			typeof this.keepPreviousWeeks === 'number' && Number.isFinite(this.keepPreviousWeeks)
				? this.keepPreviousWeeks
				: 0;
		const start = this._weekStartLocal(nowTs);
		const keys = new Set();
		for (let i = 0; i <= keep; i += 1) {
			const d = new Date(start.getTime());
			d.setDate(d.getDate() - i * 7);
			keys.add(this._formatLocalYyyyMmDd(d));
		}
		return keys;
	}

	/**
	 * Compute directory + base name for a ref key (already URL-encoded).
	 *
	 * @param {string} refKey Encoded ref key (encodeURIComponent(ref)).
	 * @returns {{dirPath: string, baseName: string}} Directory path and base filename (without segment/ext).
	 */
	_refPathInfo(refKey) {
		const segments = this._refPathSegments(refKey);
		const baseName = segments.length > 0 ? segments[segments.length - 1] : String(refKey || '').trim() || 'unknown';
		const relDir = segments.length > 1 ? segments.slice(0, -1).join('/') : '';
		const dirPath = this.baseDir ? (relDir ? `${this.baseDir}/${relDir}` : this.baseDir) : relDir;
		return { dirPath, baseName };
	}

	/**
	 * Convert an encoded ref key into path segments.
	 *
	 * Rules:
	 * - Split by dot (`.`) to create folder segments.
	 * - Exception: when the second segment is numeric (plugin instance), keep `<name>.<digits>` together.
	 *
	 * @param {string} refKey Encoded ref key (encodeURIComponent(ref)).
	 * @returns {string[]} Path segments.
	 */
	_refPathSegments(refKey) {
		const key = String(refKey || '').trim();
		if (!key) {
			return [];
		}

		const parts = key.split('.').filter(Boolean);
		if (parts.length >= 2 && /^[0-9]+$/.test(parts[1])) {
			return [`${parts[0]}.${parts[1]}`, ...parts.slice(2)];
		}
		return parts;
	}

	/**
	 * Best-effort delete a file from adapter file storage.
	 *
	 * @param {string} filePath Full file path under the adapter file store.
	 * @returns {Promise<void>}
	 */
	async _deleteFile(filePath) {
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
	 * Enforce retention policy for a single ref by deleting old weekly segment files (best-effort).
	 *
	 * @param {string} refKey Encoded ref key.
	 * @returns {Promise<void>}
	 */
	async _applyRetention(refKey) {
		const keep =
			typeof this.keepPreviousWeeks === 'number' && Number.isFinite(this.keepPreviousWeeks)
				? this.keepPreviousWeeks
				: 0;
		if (keep < 0) {
			return;
		}
		if (typeof this.adapter.readDirAsync !== 'function') {
			return;
		}

		const keepKeys = this._segmentKeysToKeep(Date.now());
		const { dirPath, baseName } = this._refPathInfo(refKey);
		const prefix = `${baseName}.`;
		const suffix = `.${this.fileExtension}`;

		let entries;
		try {
			entries = await this.adapter.readDirAsync(this.metaId, dirPath || '');
		} catch (e) {
			this.adapter?.log?.debug?.(`MsgArchive retention readDir failed (${dirPath || '.'}): ${e?.message || e}`);
			return;
		}

		const deletions = [];
		for (const entry of entries || []) {
			if (!entry || entry.isDir) {
				continue;
			}
			const file = entry.file;
			if (typeof file !== 'string' || !file.startsWith(prefix) || !file.endsWith(suffix)) {
				continue;
			}
			const segmentKey = file.slice(prefix.length, file.length - suffix.length);
			if (!/^[0-9]{8}$/.test(segmentKey)) {
				continue;
			}
			if (keepKeys.has(segmentKey)) {
				continue;
			}

			const fullPath = dirPath ? `${dirPath}/${file}` : file;
			deletions.push(this._deleteFile(fullPath));
		}

		if (deletions.length > 0) {
			await Promise.allSettled(deletions);
			this.adapter?.log?.debug?.(
				`MsgArchive retention: deleted ${deletions.length} old segment file(s) for ${baseName} (keepPreviousWeeks=${keep})`,
			);
		}
	}

	/**
	 * Call once during startup.
	 *
	 * Ensures the ioBroker file storage meta object exists and (optionally) creates the base directory.
	 * This method is async because it may create meta objects and folders.
	 *
	 * @returns {Promise<void>} Resolves when the archive is ready for writes.
	 */
	async init() {
		await ensureMetaObject(this.adapter, this.metaId);
		await ensureBaseDir(this.adapter, this.metaId, this.baseDir);
		this.adapter?.log?.info?.(
			`MsgArchive initialized: baseDir=${this.baseDir || '.'}, ext=${this.fileExtension}, interval=${this.flushIntervalMs}ms, keepPreviousWeeks=${this.keepPreviousWeeks}`,
		);
	}

	/**
	 * Append a full message snapshot.
	 *
	 * Typical usage:
	 * - Called by `MsgStore.addMessage()` to record the initial state of a message.
	 *
	 * The default archive event name is `"create"`, but can be overridden (e.g. for imports).
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
	 * Typical usage:
	 * - Called by `MsgStore.updateMessage()` to record the requested patch plus optional diffs.
	 *
	 * Payload details:
	 * - The archive stores `requested` (the patch with redundant `ref` stripped when possible).
	 * - If `existing` and `updated` are provided, a shallow diff is computed and stored as `added`/`removed`.
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
		const payload = this._buildPatchPayload(ref, patch, existing, updated);
		return this._appendEvent(ref, 'patch', payload, options).catch(err =>
			this._handleAppendError('patch', ref, err, options),
		);
	}

	/**
	 * Append an action event.
	 *
	 * Typical usage:
	 * - Called by `MsgAction.execute()` to record the action intent and result for audit/debug/replay.
	 *
	 * Notes:
	 * - This is intentionally separate from `"patch"` events: `"action"` records the *intent* while `"patch"`
	 *   records the resulting message mutation (if any).
	 *
	 * @param {string} ref Message ref that identifies the archive file.
	 * @param {object} action Action payload (recommended fields: `actionId`, `type`, `actor`, `ok`, `reason`, ...).
	 * @param {object} [options] Optional behavior overrides.
	 * @param {boolean} [options.flushNow] Flush immediately instead of waiting for batching.
	 * @param {boolean} [options.throwOnError] Reject the promise on failure (otherwise log + resolve).
	 */
	appendAction(ref, action, options = {}) {
		const payload =
			action && typeof action === 'object' && !Array.isArray(action)
				? action
				: {
						action,
					};
		return this._appendEvent(ref, 'action', payload, options).catch(err =>
			this._handleAppendError('action', ref, err, options),
		);
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
			return this._diffArray(existing, updated);
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
	 * Diff two arrays with some heuristics to keep archive diffs compact.
	 *
	 * - For id-based arrays (array of plain objects with unique `id`), we diff by `id` and only record
	 *   added/removed/changed entries.
	 * - For primitive sets (array of unique primitives), we record only added/removed items.
	 * - For reorders (same items, different order), we treat id-based arrays and primitive sets as order-insensitive
	 *   and omit diffs (keeps archives small; order is typically not semantically relevant for these fields).
	 *
	 * @param {any[]} existing Previous array.
	 * @param {any[]} updated Updated array.
	 * @returns {{added: any, removed: any}} Diff object.
	 */
	_diffArray(existing, updated) {
		const byId = this._diffArrayById(existing, updated);
		if (byId) {
			return byId;
		}

		const primitive = this._diffArrayAsPrimitiveSet(existing, updated);
		if (primitive) {
			return primitive;
		}

		return { added: updated, removed: existing };
	}

	/**
	 * Attempt an id-based array diff.
	 *
	 * @param {any[]} existing Previous array.
	 * @param {any[]} updated Updated array.
	 * @returns {{added: any[]|undefined, removed: any[]|undefined}|null} Diff, or null when not applicable.
	 */
	_diffArrayById(existing, updated) {
		const before = this._indexArrayById(existing);
		if (!before) {
			return null;
		}
		const after = this._indexArrayById(updated);
		if (!after) {
			return null;
		}

		const removed = [];
		const added = [];

		const afterIds = new Set(after.order);
		const beforeIds = new Set(before.order);

		const changedIds = new Set();
		for (const id of before.order) {
			if (!after.map.has(id)) {
				continue;
			}
			const beforeItem = before.map.get(id);
			const afterItem = after.map.get(id);
			if (!this._isEqual(beforeItem, afterItem)) {
				changedIds.add(id);
			}
		}

		for (const id of before.order) {
			if (!afterIds.has(id) || changedIds.has(id)) {
				removed.push(before.map.get(id));
			}
		}
		for (const id of after.order) {
			if (!beforeIds.has(id) || changedIds.has(id)) {
				added.push(after.map.get(id));
			}
		}

		if (removed.length === 0 && added.length === 0) {
			// Likely a reorder only; treat id-based arrays as order-insensitive and omit diffs.
			return { added: undefined, removed: undefined };
		}

		return {
			added: added.length > 0 ? added : undefined,
			removed: removed.length > 0 ? removed : undefined,
		};
	}

	/**
	 * Build an id -> item index for arrays of plain objects with a unique string `id`.
	 *
	 * @param {any[]} arr Array to index.
	 * @returns {{order: string[], map: Map<string, any>}|null} Index bundle or null when not applicable.
	 */
	_indexArrayById(arr) {
		const map = new Map();
		const order = [];
		for (const item of arr) {
			if (!this._isPlainObject(item)) {
				return null;
			}
			const id = typeof item.id === 'string' ? item.id.trim() : '';
			if (!id) {
				return null;
			}
			if (map.has(id)) {
				return null;
			}
			map.set(id, item);
			order.push(id);
		}
		return { order, map };
	}

	/**
	 * Attempt a set-like diff for arrays of unique primitives.
	 *
	 * @param {any[]} existing Previous array.
	 * @param {any[]} updated Updated array.
	 * @returns {{added: any[]|undefined, removed: any[]|undefined}|null} Diff or null when not applicable.
	 */
	_diffArrayAsPrimitiveSet(existing, updated) {
		const before = this._indexPrimitiveArray(existing);
		if (!before) {
			return null;
		}
		const after = this._indexPrimitiveArray(updated);
		if (!after) {
			return null;
		}

		const removed = [];
		const added = [];

		for (const item of existing) {
			if (!after.set.has(this._primitiveKey(item))) {
				removed.push(item);
			}
		}
		for (const item of updated) {
			if (!before.set.has(this._primitiveKey(item))) {
				added.push(item);
			}
		}

		if (removed.length === 0 && added.length === 0) {
			// Likely a reorder only; treat primitive sets as order-insensitive and omit diffs.
			return { added: undefined, removed: undefined };
		}

		return {
			added: added.length > 0 ? added : undefined,
			removed: removed.length > 0 ? removed : undefined,
		};
	}

	/**
	 * Index an array of unique primitives.
	 *
	 * @param {any[]} arr Array to index.
	 * @returns {{set: Set<string>}|null} Index or null when not applicable.
	 */
	_indexPrimitiveArray(arr) {
		const set = new Set();
		for (const item of arr) {
			const isPrimitive =
				item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean';
			if (!isPrimitive) {
				return null;
			}
			const key = this._primitiveKey(item);
			if (set.has(key)) {
				return null;
			}
			set.add(key);
		}
		return { set };
	}

	/**
	 * Build a stable key for primitives to avoid collisions between types (e.g. "1" vs 1).
	 *
	 * @param {string|number|boolean|null} v Primitive.
	 * @returns {string} Stable key.
	 */
	_primitiveKey(v) {
		if (v === null) {
			return 'null';
		}
		if (typeof v === 'string') {
			return `s:${v}`;
		}
		if (typeof v === 'number') {
			if (Number.isNaN(v)) {
				return 'n:NaN';
			}
			if (Object.is(v, -0)) {
				return 'n:-0';
			}
			return `n:${String(v)}`;
		}
		return `b:${v ? '1' : '0'}`;
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
	 * Notes:
	 * - The default archive event name is `"delete"`. Callers may override it (e.g. `{ event: "expired" }`).
	 * - If a full message object is provided, the archive stores it as a snapshot payload for auditability.
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
	 * This normalizes the entry shape (schema version, timestamp, ref, event) and then enqueues it for batching.
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
		this.adapter?.log?.warn?.(`MsgArchive ${action} failed for ref ${safeRef}: ${err?.message || err}`);
		if (options.throwOnError) {
			return Promise.reject(err);
		}
		return Promise.resolve();
	}

	/**
	 * Flushes all pending events immediately.
	 *
	 * This is intended for shutdown/unload flows where we want a best-effort write of all buffered events.
	 *
	 * @returns {Promise<void>} Resolves when all queued flushes have completed.
	 */
	async flushPending() {
		const pendingEntries = Array.from(this._pending.entries());
		if (pendingEntries.length === 0) {
			return this._queue.current;
		}

		const flushes = pendingEntries.map(([refKey, pending]) => this._flushRef(refKey, pending));
		await Promise.allSettled(flushes);
		return this._queue.current;
	}

	/**
	 * Adds an entry to the queue for a ref.
	 *
	 * Batching semantics:
	 * - Events are buffered per ref key.
	 * - The returned promise resolves when the buffered events that include this entry have been flushed.
	 * - `flushNow` or `flushIntervalMs=0` forces an immediate flush.
	 * - `maxBatchSize` also forces a flush to bound memory usage.
	 *
	 * @param {string} ref Message ref.
	 * @param {object} entry Event entry already normalized for storage.
	 * @param {boolean} flushNow Force immediate flush.
	 * @returns {Promise<void>} Promise resolved when the entry is written.
	 */
	_enqueueEvent(ref, entry, flushNow) {
		// Encode refs to create filesystem-friendly file names.
		const refKey = encodeURIComponent(String(ref).trim());
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
			// Flush immediately when requested or when thresholds are reached.
			this._flushRef(refKey, pending);
		} else if (!pending.timer) {
			// Otherwise schedule exactly one flush timer per ref.
			pending.timer = setTimeout(() => this._flushRef(refKey, pending), this.flushIntervalMs);
		}

		return promise;
	}

	/**
	 * Flushes queued events for a ref.
	 *
	 * Concurrency:
	 * - At most one flush per refKey runs at a time (`pending.flushing`).
	 * - Actual storage writes are serialized via the global `_queue` so file reads/writes do not overlap.
	 *
	 * @param {string} refKey Normalized ref key.
	 * @param {object} pending Pending state object.
	 * @returns {Promise<void>} Promise resolved when the flush completes.
	 */
	_flushRef(refKey, pending) {
		if (pending.flushing) {
			return pending.flushPromise || this._queue.current;
		}

		if (pending.timer) {
			clearTimeout(pending.timer);
			pending.timer = null;
		}

		if (pending.events.length === 0) {
			return this._queue.current;
		}

		const events = pending.events;
		const waiters = pending.waiters;
		pending.events = [];
		pending.waiters = [];
		pending.flushing = true;

		// Serialize writes so each ref file is appended in order and storage operations don't overlap.
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
				// New events arrived while we were flushing; schedule another flush.
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
	 * Implementation detail:
	 * - ioBroker file storage does not expose append, so this does a read + rewrite of the full file.
	 * - We preserve a trailing newline and avoid accidental blank lines by trimming the existing tail.
	 *
	 * @param {string} refKey Normalized ref key.
	 * @param {Array<object>} events Event entries to append in order.
	 * @returns {Promise<void>} Resolves after the file has been rewritten with the new lines.
	 */
	async _appendEvents(refKey, events) {
		const bySegment = new Map();
		for (const entry of events) {
			const ts = typeof entry?.ts === 'number' && Number.isFinite(entry.ts) ? entry.ts : Date.now();
			const segmentKey = this._segmentKeyForTs(ts);
			const list = bySegment.get(segmentKey) || [];
			list.push(entry);
			bySegment.set(segmentKey, list);
		}

		for (const [segmentKey, entries] of bySegment.entries()) {
			const filePath = this._filePathForRef(refKey, segmentKey);
			await this._ensureDirForFilePath(filePath);
			const existing = await this._readFileText(filePath);
			const existingTrimmed = existing ? existing.replace(/\s+$/, '') : '';
			const newLines = entries.map(entry => serializeWithMaps(entry, this._mapTypeMarker)).join('\n');
			const combined = existingTrimmed ? `${existingTrimmed}\n${newLines}\n` : `${newLines}\n`;

			await this.adapter.writeFileAsync(this.metaId, filePath, combined);
			this._lastFlushedAt = Date.now();
			this._sizeEstimateAt = 0;
			this._sizeEstimateBytes = null;
			this._sizeEstimateIsComplete = false;

			this.adapter?.log?.debug?.(
				`MsgArchive append ${entries.length} event(s) -> ${filePath}, ${Buffer.byteLength(combined, 'utf8')} bytes`,
			);
		}

		// Best-effort retention cleanup for this ref.
		try {
			await this._applyRetention(refKey);
		} catch {
			// must never break archiving
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
			this.adapter?.log?.debug?.(`MsgArchive read failed (${filePath}): ${e?.message || e}`);
			return '';
		}
	}

	/**
	 * Ensure the folder path for a file exists (best-effort).
	 *
	 * @param {string} filePath File path under the file store.
	 * @returns {Promise<void>}
	 */
	async _ensureDirForFilePath(filePath) {
		const idx = typeof filePath === 'string' ? filePath.lastIndexOf('/') : -1;
		if (idx <= 0) {
			return;
		}
		const dir = filePath.slice(0, idx);
		if (this._ensuredDirs.has(dir)) {
			return;
		}
		this._ensuredDirs.add(dir);
		await ensureBaseDir(this.adapter, this.metaId, dir);
	}

	/**
	 * Builds the archive file path for a ref key.
	 *
	 * @param {string} refKey Normalized ref key.
	 * @param {string} segmentKey Segment key (YYYYMMDD) for the weekly file, or undefined to omit.
	 * @returns {string} File path under the archive base dir.
	 */
	_filePathForRef(refKey, segmentKey) {
		const key = String(refKey || '').trim();
		const relPath = this._refPathSegments(refKey).join('/');
		const safeSegment =
			typeof segmentKey === 'string' && /^[0-9]{8}$/.test(segmentKey.trim()) ? segmentKey.trim() : null;
		const fileName = safeSegment
			? `${relPath || key || 'unknown'}.${safeSegment}.${this.fileExtension}`
			: `${relPath || key || 'unknown'}.${this.fileExtension}`;
		return this.baseDir ? `${this.baseDir}/${fileName}` : fileName;
	}

	/**
	 * Return best-effort runtime status for diagnostics / UIs.
	 *
	 * @returns {{ baseDir: string, fileExtension: string, flushIntervalMs: number, maxBatchSize: number, keepPreviousWeeks: number, lastFlushedAt: number|null, pending: { refs: number, events: number, flushingRefs: number }, approxSizeBytes: number|null, approxSizeUpdatedAt: number|null, approxSizeIsComplete: boolean }} Status snapshot.
	 */
	getStatus() {
		let pendingRefs = 0;
		let pendingEvents = 0;
		let flushingRefs = 0;

		for (const p of this._pending.values()) {
			if (!p) {
				continue;
			}
			if (p.flushing) {
				flushingRefs += 1;
			}
			if (Array.isArray(p.events) && p.events.length > 0) {
				pendingRefs += 1;
				pendingEvents += p.events.length;
			}
		}

		return {
			baseDir: this.baseDir || '',
			fileExtension: this.fileExtension,
			flushIntervalMs: this.flushIntervalMs,
			maxBatchSize: this.maxBatchSize,
			keepPreviousWeeks: this.keepPreviousWeeks,
			lastFlushedAt: this._lastFlushedAt || null,
			pending: { refs: pendingRefs, events: pendingEvents, flushingRefs },
			approxSizeBytes: typeof this._sizeEstimateBytes === 'number' ? this._sizeEstimateBytes : null,
			approxSizeUpdatedAt: this._sizeEstimateAt || null,
			approxSizeIsComplete: this._sizeEstimateIsComplete === true,
		};
	}

	/**
	 * Best-effort estimate of archive size on disk (bytes).
	 *
	 * Notes:
	 * - This may be expensive depending on backend and file count; callers should use caching (maxAgeMs).
	 * - Some ioBroker backends may not provide file sizes via `readDirAsync(...).stats.size`; in that case this returns null.
	 *
	 * @param {{ maxAgeMs?: number }} [options] Cache/maxAge options.
	 * @returns {Promise<{ bytes: number|null, updatedAt: number, isComplete: boolean }>} Estimate result.
	 */
	async estimateSizeBytes({ maxAgeMs = 5 * 60 * 1000 } = {}) {
		const now = Date.now();
		const cachedAt = this._sizeEstimateAt;
		if (cachedAt && now - cachedAt < maxAgeMs) {
			return {
				bytes: typeof this._sizeEstimateBytes === 'number' ? this._sizeEstimateBytes : null,
				updatedAt: cachedAt,
				isComplete: this._sizeEstimateIsComplete === true,
			};
		}

		if (typeof this.adapter.readDirAsync !== 'function') {
			this._sizeEstimateAt = now;
			this._sizeEstimateBytes = null;
			this._sizeEstimateIsComplete = false;
			return { bytes: null, updatedAt: now, isComplete: false };
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

		this._sizeEstimateAt = now;
		this._sizeEstimateBytes = total;
		this._sizeEstimateIsComplete = isComplete;
		return { bytes: total, updatedAt: now, isComplete };
	}
}

module.exports = { MsgArchive };
