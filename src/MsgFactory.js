/**
 * Message model overview
 *
 * This block documents the canonical shape of a `Message` object used by the MsgHub.
 * A `Message` is the single, normalized payload that represents something the system
 * wants to surface to the user (e.g., a task, a status update, an appointment, or a
 * shopping list). The goal is to keep a stable core schema for storage, transport,
 * and UI rendering, while still allowing optional, type-specific extensions.
 *
 * Design goals:
 * - Stable identification: `ref` is an internal, unique, persistent ID used for
 *   deduplication, updates, and cross-references.
 * - Clear presentation: `title` and `text` are the primary human-readable fields for UI/TTS.
 * - Classification: `level` and `kind` describe urgency/severity and the domain type.
 * - Traceability: `origin` records where the message came from (manual, import, automation)
 *   and optionally which external system/id it was derived from.
 * - Temporal semantics: `timing` holds creation/update timestamps plus optional lifecycle
 *   and domain timestamps (e.g., due dates or appointment start/end).
 * - Extensibility: optional sections (`details`, `metrics`, `attachments`, `actions`, etc.)
 *   allow richer structured content without bloating the required core fields.
 *
 * Conventions:
 * - All timestamps are numeric epoch values (milliseconds since Unix epoch), unless stated otherwise.
 * - Optional fields may be omitted if unknown; nullable fields are explicitly set to `null`
 *   when a value is known to be "not applicable" or has been cleared.
 * - Arrays preserve order as provided by the producer (e.g., list item order).
 *
 * Message {
 *   ref: string                   // internal unique ID (stable)
 *
 *   // Presentation
 *   title: string                 // UI headline (e.g., "Hallway")
 *   text: string                  // free-form description
 *
 *   // Classification
 *   level: 0|10|20|30             // none/notice/warning/error
 *   kind: "task"|"status"|"appointment"|"shoppinglist"|"inventorylist"
 *
 *   origin: {
 *     type: "manual"|"import"|"automation"
 *     system?: string             // e.g., "alexa", "icloud", "dwd"
 *     id?: string                 // external ID (from upstream system)
 *   }
 *
 *   timing: {
 *     createdAt: number
 *     updatedAt?: number
 *     expiresAt?: number | null
 *     notifyAt?: number | null
 *
 *     dueAt?: number | null       // task
 *     startAt?: number | null     // appointment
 *     endAt?: number | null       // appointment
 *   }
 *
 *   // Structured details (optional; mainly for task/status/appointment)
 *   details?: {
 *     location?: string
 *     task?: string
 *     reason?: string
 *     tools?: string[]
 *     consumables?: string[]
 *   }
 *
 *   // Metrics (optional)
 *   metrics?: Map<string, { val: number|string|boolean|null, unit: string, ts: number }>
 *
 *   // Attachments (optional)
 *   attachments?: Array<{
 *     type: "ssml"|"image"|"video"|"file"
 *     value: string
 *   }>
 *
 *   // List items (only for kind="shoppinglist"|"inventorylist")
 *   listItems?: Array<{
 *     id: string
 *     name: string
 *     category?: string
 *     quantity?: { val: number; unit: string }
 *     checked: boolean
 *   }>
 *
 *   // Actions (optional)
 *   actions?: Array<{
 *     type: "ack"|"delete"|"close"|"open"|"link"|"custom"
 *     // Semantics:
 *     // - ack: mark as seen/acknowledged (do not remove)
 *     // - delete: remove the message
 *     // - close: complete/finish an operation or dismiss an alarm
 *     // - open: open/activate something (UI navigation or triggering)
 *     // - link: navigation only (no side effects)
 *     // - custom: anything else (device action / automation / plugin-specific)
 *
 *     id: string
 *     payload?: Record<string, unknown> | null
 *     ts?: number
 *   }>
 *
 *   // Progress (optional; mainly for task)
 *   progress: {
 *     startedAt?: number | null
 *     finishedAt?: number | null
 *     percentage: number | null
 *   }
 *
 *   dependencies?: string[]
 * }
 */

/**
 * Builds normalized message objects for Msghub.
 * Validates and sanitizes user input, enforces enum constraints, and removes
 * undefined fields so the stored payload is compact and predictable.
 */
class MsgFactory {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance with msgconst and logging.
	 * @param {import('./MsgConstants').MsgConstants} msgConstants Centralized enum-like constants.
	 */
	constructor(adapter, msgConstants) {
		if (!adapter) {
			throw new Error('MsgFactory: adapter is required');
		}
		if (!msgConstants) {
			throw new Error('MsgFactory: msgConstants is required');
		}
		this.adapter = adapter;
		this.msgConstants = msgConstants;

		// create ValueSets only once
		this.levelValueSet = new Set(Object.values(this.msgConstants.level));
		this.kindValueSet = new Set(Object.values(this.msgConstants.kind));
		this.originTypeValueSet = new Set(Object.values(this.msgConstants.origin.type));
		this.attachmentsTypeValueSet = new Set(Object.values(this.msgConstants.attachments.type));
		this.actionsTypeValueSet = new Set(Object.values(this.msgConstants.actions.type));
	}

	/**
	 * Creates a normalized message object from the provided data.
	 * Required fields are validated, optional fields are sanitized, and any
	 * undefined values are stripped from the final payload.
	 *
	 * @param {object} [options] Raw message fields.
	 * @param {string} [options.ref] Stable, printable identifier for the message (required).
	 * @param {string} [options.title] Human readable title shown in the UI (required).
	 * @param {string} [options.text] Main message body text (required).
	 * @param {number} [options.level] Severity level from msgconst.level (required).
	 * @param {string} [options.kind] Message kind from msgconst.kind (required).
	 * @param {object} [options.origin] Origin metadata including type/system/id (required).
	 * @param {object} [options.timing] Timing metadata including due/start/end.
	 * @param {object} [options.details] Structured details like location or tools.
	 * @param {Map<string, {val: number|string|boolean|null, unit: string, ts: number}>} [options.metrics] Structured metrics.
	 * @param {Array<{type: "ssml"|"image"|"video"|"file", value: string}>} [options.attachments] Attachment list.
	 * @param {Array<{id: string, name: string, category?: string, quantity?: { val: number; unit: string }, checked: boolean}>} [options.listItems] List items for shopping or inventory lists.
	 * @param {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom", id: string, payload?: Record<string, unknown>|null, ts?: number}>} [options.actions] Action descriptors.
	 * @param {object} [options.progress] Progress metadata such as percentage and timestamps.
	 * @param {string[]|string} [options.dependencies] Related message refs as array or CSV string.
	 * @returns {object|null} Normalized message object, or null when validation fails.
	 */
	createMessage({
		ref,
		title,
		text,
		level,
		kind,
		origin = {},
		timing = {},
		details = {},
		metrics,
		attachments,
		listItems,
		actions,
		progress = {},
		dependencies = [],
	} = {}) {
		try {
			// "kind" vorab normalisieren, da für zeiten (timing) benötigt
			const normkind = this._normalizeMsgEnum(kind, this.kindValueSet, 'kind', { required: true });

			const msg = {
				ref: this._normalizeMsgRef(ref),
				title: this._normalizeMsgString(title, 'title', { required: true }),
				text: this._normalizeMsgString(text, 'text', { required: true }),
				level: this._normalizeMsgEnum(level, this.levelValueSet, 'level', { required: true }),
				kind: normkind,
				origin: this._normalizeMsgOrigin(origin),
				timing: this._normalineMsgTiming(timing, normkind),
				details: this._normalizeMsgDetails(details),
				metrics: this._normalizeMsgMetrics(metrics),
				attachments: this._normalizeMsgAttachments(attachments),
			listItems: this._normalizeMsgListItems(listItems, normkind),
				actions: this._normalizeMsgActions(actions),
				progress: this._normalineMsgProgress(progress),
				dependencies: this._normalizeMsgArray(dependencies, 'dependencies'),
			};

			return this._removeUndefinedKeys(msg);
		} catch (e) {
			if (this.adapter?.log?.error) {
				this.adapter.log.error(e);
			}
		}

		return null;
	}

	/**
	 * Updates an existing message with a partial patch.
	 * Only fields present in the patch are processed; other fields are preserved.
	 * Optional fields can be cleared by passing `null`.
	 *
	 * Patch semantics (examples show effects):
	 * - Scalars (title/text/level): replace the value.
	 *   - applyPatch(existing, { title: 'New title' })
	 *     => sets title to 'New title', keeps all other fields.
	 *
	 * - timing/details/progress: partial object, only provided keys are touched.
	 *   - applyPatch(existing, { timing: { dueAt: 123 } })
	 *     => sets/updates timing.dueAt; other timing fields stay as-is.
	 *   - applyPatch(existing, { timing: { notifyAt: null } })
	 *     => removes timing.notifyAt from the message.
	 *
	 *   - applyPatch(existing, { progress: { percentage: 60 } })
	 *     => updates progress.percentage to 60, keeps startedAt/finishedAt unchanged.
	 *   - applyPatch(existing, { progress: { delete: ['finishedAt'] } })
	 *     => removes progress.finishedAt (percentage is preserved).
	 *
	 * - metrics (Map):
	 *   - Replace all metrics:
	 *     applyPatch(existing, { metrics: new Map([['temperature', { val: 21, unit: 'C', ts: 1 }]]) })
	 *     => replaces the entire metrics map with the provided one (after normalization).
	 *   - Patch metrics with set/delete:
	 *     applyPatch(existing, {
	 *       metrics: {
	 *         set: { temperature: { val: 22.3, unit: 'C', ts: 2 } },
	 *         delete: ['humidity']
	 *       }
	 *     })
	 *     => upserts 'temperature' (adds if missing, replaces if existing),
	 *        and removes the 'humidity' metric entry.
	 *
	 * - attachments (array, index-based):
	 *   - Replace the array:
	 *     applyPatch(existing, { attachments: [{ type: 'image', value: 'file.png' }] })
	 *     => replaces the entire attachments array.
	 *   - Patch by index:
	 *     applyPatch(existing, { attachments: { delete: [0, 2] } })
	 *     => deletes elements at indices 0 and 2 (highest index first).
	 *
	 * - actions (array of objects, id-based):
	 *   - Replace all actions:
	 *     applyPatch(existing, { actions: [{ id: 'ack-1', type: 'ack' }] })
	 *     => replaces the entire actions array.
	 *   - Patch actions by id:
	 *     applyPatch(existing, {
	 *       actions: { set: { 'ack-1': { type: 'ack' } }, delete: ['oldActionId'] }
	 *     })
	 *     => upserts action with id 'ack-1' and removes action 'oldActionId'.
	 *
	 * - listItems (array of objects, id-based):
	 *   - Replace all listItems:
	 *     applyPatch(existing, { listItems: [{ id: 'milk', name: 'Milk', checked: false }] })
	 *     => replaces the entire listItems array.
	 *   - Patch listItems by id:
	 *     applyPatch(existing, {
	 *       listItems: {
	 *         set: { milk: { name: 'Milk', checked: false } },
	 *         delete: ['oldItemId']
	 *       }
	 *     })
	 *     => upserts item with id 'milk' (creates or replaces it),
	 *        and removes any list item with id 'oldItemId'.
	 *
	 * - dependencies (string list):
	 *   - Replace all dependencies:
	 *     applyPatch(existing, { dependencies: ['a', 'b'] })
	 *     => replaces the entire dependencies list.
	 *   - Patch dependencies:
	 *     applyPatch(existing, { dependencies: { set: ['a', 'b'], delete: ['c'] } })
	 *     => sets dependencies to ['a','b'] and removes 'c' if present.
	 *
	 * The following fields are immutable after creation and may not change:
	 * `ref`, `kind`, `origin`, `timing.createdAt`.
	 *
	 * @param {object} existing Previously normalized message object.
	 * @param {object} [patch] Partial update payload.
	 * @param {string} [patch.title] Updated title (required when provided).
	 * @param {string} [patch.text] Updated text (required when provided).
	 * @param {number} [patch.level] Updated severity level (required when provided).
	 * @param {string} [patch.ref] Message ref (must match existing ref).
	 * @param {string} [patch.kind] Message kind (must match existing kind).
	 * @param {object} [patch.origin] Origin object (must match existing origin).
	 * @param {object} [patch.timing] Timing patch (only provided fields are applied).
	 * @param {object|null} [patch.details] Updated structured details or null to clear.
	 * @param {Map<string, {val: number|string|boolean|null, unit: string, ts: number}>|{set?: Map<string, {val: number|string|boolean|null, unit: string, ts: number}>|Record<string, {val: number|string|boolean|null, unit: string, ts: number}>, delete?: string[]}|null} [patch.metrics] Metrics patch or null to clear.
	 * @param {Array<{type: "ssml"|"image"|"video"|"file", value: string}>|{set?: Array<{type: "ssml"|"image"|"video"|"file", value: string}>, delete?: number[]}|null} [patch.attachments] Attachments patch or null to clear.
	 * @param {Array<{id: string, name: string, category?: string, quantity?: { val: number; unit: string }, checked: boolean}>|{set?: Array<{id: string, name: string, category?: string, quantity?: { val: number; unit: string }, checked: boolean}>|Record<string, {name: string, category?: string, quantity?: { val: number; unit: string }, checked: boolean}>, delete?: string[]}|null} [patch.listItems] List items patch or null to clear.
	 * @param {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom", id: string, payload?: Record<string, unknown>|null, ts?: number}>|{set?: Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom", id: string, payload?: Record<string, unknown>|null, ts?: number}>|Record<string, {type: "ack"|"delete"|"close"|"open"|"link"|"custom", payload?: Record<string, unknown>|null, ts?: number}>, delete?: string[]}|null} [patch.actions] Actions patch or null to clear.
	 * @param {object|{set?: object, delete?: string[]}|null} [patch.progress] Progress patch or null to clear.
	 * @param {string[]|string|{set?: string[]|string, delete?: string[]}|null} [patch.dependencies] Dependencies patch or null to clear.
	 * @returns {object|null} Updated message or null when validation fails.
	 */
	applyPatch(existing, patch = {}) {
		try {
			if (!this.isValidMessage(existing)) {
				throw new TypeError('updateMessage: existing message must be an valid message object');
			}

			const updated = { ...existing };
			let refreshUpdatedAt = false;
			const has = key => Object.prototype.hasOwnProperty.call(patch, key);

			if (has('ref')) {
				const patchRef = this._normalizeMsgRef(patch.ref);
				if (patchRef !== existing.ref) {
					throw new TypeError('applyPatch: ref is immutable');
				}
			}
			if (has('kind')) {
				const patchKind = this._normalizeMsgEnum(patch.kind, this.kindValueSet, 'kind', { required: true });
				if (patchKind !== existing.kind) {
					throw new TypeError('applyPatch: kind is immutable');
				}
			}
			if (has('origin')) {
				const patchOrigin = this._normalizeMsgOrigin(patch.origin);
				if (!this._isSameOrigin(existing.origin, patchOrigin)) {
					throw new TypeError('applyPatch: origin is immutable');
				}
			}
			if (
				has('timing') &&
				patch.timing &&
				typeof patch.timing === 'object' &&
				Object.prototype.hasOwnProperty.call(patch.timing, 'createdAt')
			) {
				const patchCreatedAt = this._normalizeMsgTime(patch.timing.createdAt, 'timing.createdAt');
				if (patchCreatedAt !== existing.timing?.createdAt) {
					throw new TypeError('applyPatch: timing.createdAt is immutable');
				}
			}

			if (has('title')) {
				updated.title = this._normalizeMsgString(patch.title, 'title', { required: true });
				refreshUpdatedAt = true;
			}
			if (has('text')) {
				updated.text = this._normalizeMsgString(patch.text, 'text', { required: true });
				refreshUpdatedAt = true;
			}
			if (has('level')) {
				updated.level = this._normalizeMsgEnum(patch.level, this.levelValueSet, 'level', { required: true });
				refreshUpdatedAt = true;
			}
			if (has('details')) {
				updated.details = patch.details === null ? undefined : this._normalizeMsgDetails(patch.details);
				refreshUpdatedAt = true;
			}
			if (has('metrics')) {
				updated.metrics = this._applyMetricsPatch(existing.metrics, patch.metrics);
				// refreshUpdatedAt = true; // currently it is not considered a update if only the metrics change
			}
			if (has('attachments')) {
				updated.attachments = this._applyArrayPatchByIndex(
					existing.attachments,
					patch.attachments,
					this._normalizeMsgAttachments.bind(this),
					'attachments',
				);
				refreshUpdatedAt = true;
			}
			if (has('listItems')) {
				updated.listItems = this._applyListItemsPatch(existing.listItems, patch.listItems, existing.kind);
				refreshUpdatedAt = true;
			}
			if (has('actions')) {
				updated.actions = this._applyActionsPatch(existing.actions, patch.actions);
				refreshUpdatedAt = true;
			}
			if (has('progress')) {
				updated.progress = this._applyProgressPatch(existing.progress, patch.progress);
				refreshUpdatedAt = true;
			}
			if (has('dependencies')) {
				updated.dependencies = this._applyDependenciesPatch(existing.dependencies, patch.dependencies);
				refreshUpdatedAt = true;
			}
			if (has('timing')) {
				refreshUpdatedAt = true;
			}

			updated.timing = this._normalineMsgTiming(has('timing') ? patch.timing : {}, existing.kind, {
				existing,
				setUpdatedAt: refreshUpdatedAt,
			});
			//tbd: update timing and merge refreshUpdatedAt-demand as well

			return this._removeUndefinedKeys(updated);
		} catch (e) {
			this.adapter?.log?.error?.(e);
			return null;
		}
	}

	/**
	 * Validates whether a value resembles a normalized message.
	 *
	 * @param {any} message Candidate message object.
	 * @returns {boolean} True when the message has the required shape and values.
	 */
	isValidMessage(message) {
		// required core objects
		if (
			!this._isPlainObject(message) ||
			!this._isPlainObject(message.origin) ||
			!this._isPlainObject(message.progress)
		) {
			return false;
		}

		// required core fields
		if (
			typeof message.ref !== 'string' ||
			typeof message.title !== 'string' ||
			typeof message.text !== 'string' ||
			typeof message.level !== 'number' ||
			typeof message.kind !== 'string' ||
			typeof message.origin.type !== 'string' ||
			typeof message.progress.percentage !== 'number'
		) {
			return false;
		}

		// vaildate some contents
		if (
			message.ref.length === 0 ||
			!this.levelValueSet.has(message.level) ||
			!this.kindValueSet.has(message.kind) ||
			!this.originTypeValueSet.has(message.origin.type) ||
			message.progress.percentage < 0 ||
			message.progress.percentage > 100
		) {
			return false;
		}

		return true;
	}

	// ======================================
	//        normalize basics
	// ======================================

	/**
	 * Normalizes a string field by type checking and optional trimming.
	 *
	 * @param {any} value Input value to validate.
	 * @param {string} field Field name for error messages.
	 * @param {object} [options] Normalization options.
	 * @param {boolean} [options.required] Whether the value must be a non-empty string.
	 * @param {boolean} [options.trim] Whether to trim whitespace.
	 * @param {string} [options.fallback] Returned when the value is optional but invalid.
	 * @returns {string|undefined} Normalized string or fallback/undefined.
	 */
	_normalizeMsgString(value, field, { required = false, trim = true, fallback = undefined } = {}) {
		if (typeof value !== 'string') {
			if (required) {
				throw new TypeError(`createMessage: '${field}' must be a string, reiceived '${typeof value}' instead`);
			}

			this.adapter?.log?.warn?.(`createMessage: '${field}' must be string, reiceived '${typeof value}' instead`);
			return fallback;
		}
		const text = trim ? value.trim() : value;
		if (required && !text) {
			throw new TypeError(`createMessage: '${field}' is required but a empty string`);
		} else if (!text) {
			this.adapter?.log?.warn?.(`createMessage: '${field}' is a empty string`);
			return fallback;
		}
		return text;
	}

	/**
	 * Normalizes a numeric field by ensuring it is a finite number.
	 *
	 * @param {any} value Input value to validate.
	 * @param {string} field Field name for error messages.
	 * @param {object} [options] Normalization options.
	 * @param {boolean} [options.required] Whether the value must be > 0.
	 * @param {number} [options.fallback] Returned when the value is optional but invalid.
	 * @returns {number|undefined} Normalized integer or fallback/undefined.
	 */
	_normalizeMsgNumber(value, field, { required = false, fallback = undefined } = {}) {
		if (typeof value !== 'number') {
			if (required) {
				throw new TypeError(`createMessage: '${field}' must be a number, reiceived '${typeof value}' instead`);
			}

			this.adapter?.log?.warn?.(`createMessage: '${field}' must be number, reiceived '${typeof value}' instead`);
			return fallback;
		}
		const ts = Number.isFinite(value) ? Math.trunc(value) : NaN;
		if (required && !(ts > 0)) {
			throw new TypeError(`createMessage: '${field}' is required but zero`);
		} else if (!(ts > 0)) {
			this.adapter?.log?.warn?.(`createMessage: '${field}' is zero`);
			return fallback;
		}
		return ts;
	}

	/**
	 * Normalizes a timestamp field and validates it as a plausible Unix ms value.
	 *
	 * @param {any} value Input value to validate.
	 * @param {string} field Field name for error messages.
	 * @param {object} [options] Normalization options.
	 * @param {boolean} [options.required] Whether the value must be present and valid.
	 * @param {number} [options.fallback] Returned when the value is optional but invalid.
	 * @returns {number|undefined} Normalized timestamp or fallback/undefined.
	 */
	_normalizeMsgTime(value, field, { required = false, fallback = undefined } = {}) {
		const ts = this._normalizeMsgNumber(value, field, { required, fallback });

		if (!this._isPlausibleUnixMs(ts)) {
			throw new TypeError(`createMessage: '${field}' is not a plausible UnixMs timestamp (received:'${ts}')`);
		}

		return ts;
	}

	/**
	 * Normalizes an enum field by validating membership in a known value set.
	 *
	 * @param {any} value Input value to validate.
	 * @param {Set<any>} valueset Allowed values set.
	 * @param {string} field Field name for error messages.
	 * @param {object} [options] Normalization options.
	 * @param {boolean} [options.required] Whether the value must be present and valid.
	 * @param {any} [options.fallback] Returned when the value is optional but invalid.
	 * @returns {any} Normalized value or fallback/undefined.
	 */
	_normalizeMsgEnum(value, valueset, field, { required = false, fallback = undefined } = {}) {
		if (value === undefined || value === null) {
			if (required) {
				throw new TypeError(`createMessage: '${field}' missing`);
			}
			return fallback;
		}

		if (!valueset.has(value)) {
			const valuesetString = Array.from(valueset).join(', ');
			if (required) {
				throw new TypeError(
					`createMessage: '${field}' must be one of '${valuesetString}', received '${value}' instead`,
				);
			}
			this.adapter?.log?.warn?.(
				`createMessage: '${field}' must be one of '${valuesetString}', received '${value}' instead`,
			);
			return fallback;
		}
		return value;
	}

	/**
	 * Normalizes a list field to an array of trimmed strings.
	 *
	 * @param {string[]|string|undefined|null} value Input array or comma-separated string.
	 * @param {string} field Field name for warning messages.
	 * @returns {string[]|undefined} Normalized list of strings, or undefined when empty/invalid.
	 */
	_normalizeMsgArray(value, field) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (Array.isArray(value)) {
			const normalized = value
				.filter(entry => typeof entry === 'string')
				.map(entry => entry.trim())
				.filter(entry => entry.length > 0);
			if (normalized.length !== value.length) {
				this.adapter?.log?.warn?.(`createMessage: '${field}'-array contains non-string or empty entries`);
			}
			return normalized.length > 0 ? normalized : undefined;
		}
		if (typeof value === 'string') {
			const normalized = value
				.split(',')
				.map(entry => entry.trim())
				.filter(entry => entry.length > 0);
			return normalized.length > 0 ? normalized : undefined;
		}
		this.adapter?.log?.warn?.(`createMessage: '${field}'-array must be string[] or comma-separated string`);
		return undefined;
	}

	// ======================================
	//     normalize specific fields
	// ======================================

	/**
	 * Normalizes a message reference to printable ASCII only.
	 *
	 * @param {any} value Input reference value.
	 * @returns {string|undefined} Normalized reference or undefined when invalid.
	 */
	_normalizeMsgRef(value) {
		const ref = this._normalizeMsgString(value, 'ref', { required: true });
		// nur druckbare ASCII-Zeichen (Space..~)
		return ref ? ref.replace(/[^\x20-\x7E]/g, '').trim() : ref;
	}

	/**
	 * Normalizes the origin object including enum validation and optional fields.
	 *
	 * @param {object} value Origin input with type/system/id.
	 * @returns {object} Normalized origin object.
	 */
	_normalizeMsgOrigin(value) {
		if (!value || typeof value !== 'object') {
			throw new TypeError(`createMessage: 'origin' must be an object`);
		}
		if (!(typeof value.type === 'string' && value.type.trim() !== '')) {
			throw new TypeError(
				`createMessage: 'origin.type' must be a string, reiceived '${typeof value.type}' instead`,
			);
		}
		const origin = {
			type: this._normalizeMsgEnum(value.type, this.originTypeValueSet, 'origin.type', { required: true }),
			system: value.system ? this._normalizeMsgString(value.system, 'origin.system') : undefined,
			id: value.id ? this._normalizeMsgString(value.id, 'origin.id') : undefined,
		};

		return this._removeUndefinedKeys(origin);
	}

	/**
	 * Normalizes timing fields for both create and update scenarios.
	 * On creation, sets `createdAt` to now. On update, preserves `createdAt`
	 * from the existing message and only applies fields explicitly present
	 * in the provided timing patch.
	 *
	 * @param {object} value Timing input (full timing object or patch).
	 * @param {string} kind Normalized message kind used for timing rules.
	 * @param {object} [options] Normalization options.
	 * @param {object|null} [options.existing] Existing message used to keep `createdAt`.
	 * @param {boolean} [options.setUpdatedAt] Whether to set `updatedAt` to now.
	 * @returns {object} Normalized timing object.
	 */
	_normalineMsgTiming(value, kind, { existing = null, setUpdatedAt = false } = {}) {
		const updating = this.isValidMessage(existing);
		if (!value || typeof value !== 'object') {
			throw new TypeError(`createMessage: 'timing' must be an object`);
		}

		const baseTiming = updating && existing?.timing ? { ...existing.timing } : {};
		const timing = { ...baseTiming };
		const has = key => Object.prototype.hasOwnProperty.call(value, key);

		if (!updating) {
			timing.createdAt = Date.now();
		} else if (baseTiming.createdAt !== undefined) {
			timing.createdAt = baseTiming.createdAt;
		}

		if (updating && setUpdatedAt) {
			timing.updatedAt = Date.now();
		}

		const setTime = (key, kindGuard) => {
			if (!has(key)) {
				return;
			}
			if (value[key] === null) {
				delete timing[key];
				return;
			}
			if (kindGuard && kind !== kindGuard) {
				this.adapter?.log?.warn?.(
					`createMessage: 'timing.${key}' not available on kind == '${kind}' (expected: '${kindGuard}')`,
				);
				return;
			}
			timing[key] = this._normalizeMsgTime(value[key], `timing.${key}`);
		};

		setTime('expiresAt');
		setTime('notifyAt');
		setTime('dueAt', this.msgConstants.kind.task);
		setTime('startAt', this.msgConstants.kind.appointment);
		setTime('endAt', this.msgConstants.kind.appointment);

		return this._removeUndefinedKeys(timing);
	}

	/**
	 * Normalizes structured details into a compact object.
	 *
	 * @param {object} value Details input.
	 * @returns {object|undefined} Normalized details or undefined when empty.
	 */
	_normalizeMsgDetails(value) {
		if (!value || typeof value !== 'object') {
			throw new TypeError(`createMessage: 'details' must be an object`);
		}
		const details = this._removeUndefinedKeys({
			location: value.location ? this._normalizeMsgString(value.location, 'details.location') : undefined,
			task: value.task ? this._normalizeMsgString(value.task, 'details.task') : undefined,
			reason: value.reason ? this._normalizeMsgString(value.reason, 'details.reason') : undefined,
			tools: value.tools ? this._normalizeMsgArray(value.tools, 'details.tools') : undefined,
			consumables: value.consumables
				? this._normalizeMsgArray(value.consumables, 'details.consumables')
				: undefined,
		});
		return Object.keys(details).length > 0 ? details : undefined;
	}

	/**
	 * Normalizes the metrics payload for a message.
	 * Expects a Map of metric entries shaped as { val, unit, ts }.
	 *
	 * @param {Map<string, {val: number|string|boolean|null, unit: string, ts: number}>|undefined|null} value Metrics map payload.
	 * @returns {Map<string, {val: number|string|boolean|null, unit: string, ts: number}>|undefined} Normalized metrics payload.
	 */
	_normalizeMsgMetrics(value) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (!(value instanceof Map)) {
			throw new TypeError(`createMessage: 'metrics' must be a Map`);
		}

		const metrics = new Map();
		for (const [rawKey, entry] of value.entries()) {
			const key = this._normalizeMsgString(rawKey, 'metrics key', { required: true });

			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				this.adapter?.log?.warn?.(`createMessage: 'metrics.${key}' must be an object with { val, unit, ts }`);
				continue;
			}

			const { val, unit, ts } = entry;
			const valOk =
				val === null ||
				typeof val === 'string' ||
				typeof val === 'boolean' ||
				(typeof val === 'number' && Number.isFinite(val));
			if (!valOk) {
				this.adapter?.log?.warn?.(
					`createMessage: 'metrics.${key}.val' must be number|string|boolean|null, received ${typeof val}`,
				);
				continue;
			}
			if (typeof unit !== 'string' || !unit.trim()) {
				this.adapter?.log?.warn?.(`createMessage: 'metrics.${key}.unit' must be a non-empty string`);
				continue;
			}
			const tsOk =
				typeof ts === 'number' && Number.isFinite(ts) && Number.isInteger(ts) && this._isPlausibleUnixMs(ts);
			if (!tsOk) {
				this.adapter?.log?.warn?.(
					`createMessage: 'metrics.${key}.ts' must be a plausible Unix ms timestamp, received '${ts}'`,
				);
				continue;
			}

			metrics.set(key, { val, unit: unit.trim(), ts });
		}

		return metrics.size > 0 ? metrics : undefined;
	}

	/**
	 * Normalizes attachments and validates their type/value fields.
	 *
	 * @param {Array<{type: "ssml"|"image"|"video"|"file", value: string}>|undefined|null} value Attachments input.
	 * @returns {Array<{type: "ssml"|"image"|"video"|"file", value: string}>|undefined} Normalized attachments.
	 */
	_normalizeMsgAttachments(value) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (!Array.isArray(value)) {
			throw new TypeError(`createMessage: 'attachments' must be an array`);
		}

		const attachments = [];
		value.forEach((entry, index) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				this.adapter?.log?.warn?.(`createMessage: 'attachments[${index}]' must be an object`);
				return;
			}

			if (entry.type === undefined || entry.type === null) {
				this.adapter?.log?.warn?.(`createMessage: 'attachments[${index}].type' is required`);
				return;
			}
			const type = this._normalizeMsgEnum(entry.type, this.attachmentsTypeValueSet, `attachments[${index}].type`);
			const val = this._normalizeMsgString(entry.value, `attachments[${index}].value`);

			if (type === undefined || val === undefined) {
				this.adapter?.log?.warn?.(
					`createMessage: 'attachments[${index}]' has empty type('${type}') or val('${val}')`,
				);
				return;
			}

			attachments.push({ type, value: val });
		});

		return attachments.length > 0 ? attachments : undefined;
	}

	/**
	 * Normalizes list items for shopping or inventory lists.
	 *
	 * @param {Array<{id: string, name: string, category?: string, quantity?: { val: number, unit: string }, checked: boolean}>|undefined|null} value List items input.
	 * @param {string} kind Message kind.
	 * @returns {Array<{id: string, name: string, category?: string, quantity?: { val: number, unit: string }, checked: boolean}>|undefined} Normalized list items.
	 */
	_normalizeMsgListItems(value, kind) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (kind !== this.msgConstants.kind.shoppinglist && kind !== this.msgConstants.kind.inventorylist) {
			this.adapter?.log?.warn?.(`createMessage: 'listItems' not available on kind == '${kind}'`);
			return undefined;
		}
		if (!Array.isArray(value)) {
			throw new TypeError(`createMessage: 'listItems' must be an array`);
		}

		const items = [];
		value.forEach((entry, index) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				this.adapter?.log?.warn?.(`createMessage: 'listItems[${index}]' must be an object`);
				return;
			}

			const id = this._normalizeMsgString(entry.id, `listItems[${index}].id`);
			const name = this._normalizeMsgString(entry.name, `listItems[${index}].name`);
			const category = entry.category ? this._normalizeMsgString(entry.category, `listItems[${index}].category`) : undefined;

			if (id === undefined || name === undefined) {
				this.adapter?.log?.warn?.(`createMessage: 'listItems[${index}]' requires non-empty id and name`);
				return;
			}

			let quantity;
			if (entry.quantity !== undefined && entry.quantity !== null) {
				if (!entry.quantity || typeof entry.quantity !== 'object' || Array.isArray(entry.quantity)) {
					this.adapter?.log?.warn?.(
						`createMessage: 'listItems[${index}].quantity' must be an object with { val, unit }`,
					);
				} else {
					const val = this._normalizeMsgNumber(entry.quantity.val, `listItems[${index}].quantity.val`);
					const unit = this._normalizeMsgString(entry.quantity.unit, `listItems[${index}].quantity.unit`);
					if (val === undefined || unit === undefined) {
						this.adapter?.log?.warn?.(
							`createMessage: 'listItems[${index}].quantity' requires val and unit`,
						);
					} else {
						quantity = { val, unit };
					}
				}
			}

			let checked = false;
			if (entry.checked === undefined) {
				checked = false;
			} else if (typeof entry.checked === 'boolean') {
				checked = entry.checked;
			} else {
				this.adapter?.log?.warn?.(`createMessage: 'listItems[${index}].checked' must be boolean`);
			}

			const item = this._removeUndefinedKeys({ id, name, category, quantity, checked });
			items.push(item);
		});

		return items.length > 0 ? items : undefined;
	}

	/**
	 * Applies set/delete patches to metrics.
	 *
	 * @param {Map<string, {val: number|string|boolean|null, unit: string, ts: number}>|undefined} existingMetrics Existing metrics map.
	 * @param {Map<string, {val: number|string|boolean|null, unit: string, ts: number}>|{set?: Map<string, {val: number|string|boolean|null, unit: string, ts: number}>|Record<string, {val: number|string|boolean|null, unit: string, ts: number}>, delete?: string[]}|null|undefined} patch Metrics patch.
	 * @returns {Map<string, {val: number|string|boolean|null, unit: string, ts: number}>|undefined} Updated metrics.
	 */
	_applyMetricsPatch(existingMetrics, patch) {
		if (patch === null) {
			return undefined;
		}
		if (patch instanceof Map) {
			return this._normalizeMsgMetrics(patch);
		}
		if (patch === undefined) {
			return existingMetrics instanceof Map ? existingMetrics : undefined;
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`applyPatch: 'metrics' must be a Map or { set, delete }`);
		}

		const base = existingMetrics instanceof Map ? new Map(existingMetrics) : new Map();
		if ('set' in patch) {
			const setVal = patch.set;
			let setMap;
			if (setVal instanceof Map) {
				setMap = setVal;
			} else if (setVal && typeof setVal === 'object' && !Array.isArray(setVal)) {
				setMap = new Map(Object.entries(setVal));
			} else if (setVal !== undefined) {
				throw new TypeError(`applyPatch: 'metrics.set' must be a Map or object`);
			}

			if (setMap) {
				const normalized = this._normalizeMsgMetrics(setMap);
				if (normalized instanceof Map) {
					for (const [key, value] of normalized.entries()) {
						base.set(key, value);
					}
				}
			}
		}
		if ('delete' in patch && patch.delete !== undefined) {
			if (!Array.isArray(patch.delete)) {
				throw new TypeError(`applyPatch: 'metrics.delete' must be an array`);
			}
			patch.delete.forEach((key, index) => {
				const normKey = this._normalizeMsgString(key, `metrics.delete[${index}]`);
				if (normKey) {
					base.delete(normKey);
				}
			});
		}

		return base.size > 0 ? base : undefined;
	}

	/**
	 * Applies set/delete patches to arrays by index.
	 *
	 * @param {Array<any>|undefined} existingArray Existing array.
	 * @param {Array<any>|{set?: Array<any>, delete?: number[]}|null|undefined} patch Array patch.
	 * @param {(value: Array<any>) => Array<any>|undefined} normalizeFn Normalization function.
	 * @param {string} field Field name for errors.
	 * @returns {Array<any>|undefined} Updated array.
	 */
	_applyArrayPatchByIndex(existingArray, patch, normalizeFn, field) {
		if (patch === null) {
			return undefined;
		}
		if (Array.isArray(patch)) {
			return normalizeFn(patch);
		}
		if (patch === undefined) {
			return Array.isArray(existingArray) ? existingArray : undefined;
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`applyPatch: '${field}' must be an array or { set, delete }`);
		}

		let base = Array.isArray(existingArray) ? [...existingArray] : [];
		if ('set' in patch && patch.set !== undefined) {
			if (!Array.isArray(patch.set)) {
				throw new TypeError(`applyPatch: '${field}.set' must be an array`);
			}
			const normalized = normalizeFn(patch.set);
			base = normalized ? [...normalized] : [];
		}
		if ('delete' in patch && patch.delete !== undefined) {
			if (!Array.isArray(patch.delete)) {
				throw new TypeError(`applyPatch: '${field}.delete' must be an array`);
			}
			const indices = patch.delete.filter(index => Number.isInteger(index)).sort((a, b) => b - a);
			indices.forEach(index => {
				if (index >= 0 && index < base.length) {
					base.splice(index, 1);
				}
			});
		}

		return base.length > 0 ? base : undefined;
	}

	/**
	 * Applies set/delete patches to list items (by id).
	 *
	 * @param {Array<{id: string, name: string, category?: string, quantity?: { val: number, unit: string }, checked: boolean}>|undefined} existingItems Existing list items.
	 * @param {Array<{id: string, name: string, category?: string, quantity?: { val: number; unit: string }, checked: boolean}>|{set?: Array<{id: string, name: string, category?: string, quantity?: { val: number; unit: string }, checked: boolean}>|Record<string, {name: string, category?: string, quantity?: { val: number; unit: string }, checked: boolean}>, delete?: string[]}|null|undefined} patch List items patch.
	 * @param {string} kind Message kind.
	 * @returns {Array<{id: string, name: string, category?: string, quantity?: { val: number, unit: string }, checked: boolean}>|undefined} Updated list items.
	 */
	_applyListItemsPatch(existingItems, patch, kind) {
		if (patch === null) {
			return undefined;
		}
		if (Array.isArray(patch)) {
			return this._normalizeMsgListItems(patch, kind);
		}
		if (patch === undefined) {
			return Array.isArray(existingItems) ? existingItems : undefined;
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`applyPatch: 'listItems' must be an array or { set, delete }`);
		}

		let base = Array.isArray(existingItems) ? [...existingItems] : [];
		if ('set' in patch && patch.set !== undefined) {
			const setVal = patch.set;
			if (Array.isArray(setVal)) {
				const normalized = this._normalizeMsgListItems(setVal, kind);
				base = normalized ? [...normalized] : [];
			} else if (setVal && typeof setVal === 'object' && !Array.isArray(setVal)) {
				const entries = [];
				Object.entries(setVal).forEach(([id, entry]) => {
					if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
						this.adapter?.log?.warn?.(`applyPatch: 'listItems.set.${id}' must be an object`);
						return;
					}
					entries.push({ ...entry, id });
				});
				const normalized = this._normalizeMsgListItems(entries, kind) || [];
				const byId = new Map(base.map(item => [item.id, item]));
				normalized.forEach(item => byId.set(item.id, item));
				base = Array.from(byId.values());
			} else {
				throw new TypeError(`applyPatch: 'listItems.set' must be an array or object`);
			}
		}
		if ('delete' in patch && patch.delete !== undefined) {
			if (!Array.isArray(patch.delete)) {
				throw new TypeError(`applyPatch: 'listItems.delete' must be an array`);
			}
			const deleteSet = new Set();
			patch.delete.forEach((id, index) => {
				const normId = this._normalizeMsgString(id, `listItems.delete[${index}]`);
				if (normId) {
					deleteSet.add(normId);
				}
			});
			if (deleteSet.size > 0) {
				base = base.filter(item => !deleteSet.has(item.id));
			}
		}

		return base.length > 0 ? base : undefined;
	}

	/**
	 * Applies set/delete patches to dependencies.
	 *
	 * @param {string[]|undefined} existingDeps Existing dependencies.
	 * @param {string[]|string|{set?: string[]|string, delete?: string[]}|null|undefined} patch Dependencies patch.
	 * @returns {string[]|undefined} Updated dependencies.
	 */
	_applyDependenciesPatch(existingDeps, patch) {
		if (patch === null) {
			return undefined;
		}
		if (Array.isArray(patch) || typeof patch === 'string') {
			return this._normalizeMsgArray(patch, 'dependencies');
		}
		if (patch === undefined) {
			return Array.isArray(existingDeps) ? existingDeps : undefined;
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`applyPatch: 'dependencies' must be string[]|string or { set, delete }`);
		}

		let base = Array.isArray(existingDeps) ? [...existingDeps] : [];
		if ('set' in patch && patch.set !== undefined) {
			base = this._normalizeMsgArray(patch.set, 'dependencies') || [];
		}
		if ('delete' in patch && patch.delete !== undefined) {
			if (!Array.isArray(patch.delete)) {
				throw new TypeError(`applyPatch: 'dependencies.delete' must be an array`);
			}
			const deleteSet = new Set();
			patch.delete.forEach((dep, index) => {
				const normDep = this._normalizeMsgString(dep, `dependencies.delete[${index}]`);
				if (normDep) {
					deleteSet.add(normDep);
				}
			});
			if (deleteSet.size > 0) {
				base = base.filter(dep => !deleteSet.has(dep));
			}
		}

		return base.length > 0 ? base : undefined;
	}

	/**
	 * Applies set/delete patches to progress (partial updates supported).
	 *
	 * @param {object|undefined} existingProgress Existing progress.
	 * @param {object|{set?: object, delete?: string[]}|null|undefined} patch Progress patch.
	 * @returns {object|undefined} Updated progress.
	 */
	_applyProgressPatch(existingProgress, patch) {
		if (patch === null) {
			return undefined;
		}
		if (patch === undefined) {
			return this._normalineMsgProgress(existingProgress || {});
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`applyPatch: 'progress' must be an object or { set, delete }`);
		}

		let partial = patch;
		if ('set' in patch || 'delete' in patch) {
			const setVal = patch.set;
			if (setVal !== undefined && (!setVal || typeof setVal !== 'object' || Array.isArray(setVal))) {
				throw new TypeError(`applyPatch: 'progress.set' must be an object`);
			}
			partial = setVal || {};
		}

		const merged = { ...(existingProgress || {}) };
		Object.entries(partial).forEach(([key, val]) => {
			if (val === null) {
				delete merged[key];
			} else {
				merged[key] = val;
			}
		});

		if ('delete' in patch && patch.delete !== undefined) {
			if (!Array.isArray(patch.delete)) {
				throw new TypeError(`applyPatch: 'progress.delete' must be an array`);
			}
			patch.delete.forEach((key, index) => {
				const normKey = this._normalizeMsgString(key, `progress.delete[${index}]`);
				if (!normKey) {
					return;
				}
				if (normKey === 'percentage') {
					this.adapter?.log?.warn?.(`applyPatch: progress.percentage cannot be deleted`);
					return;
				}
				delete merged[normKey];
			});
		}

		return this._normalineMsgProgress(merged);
	}

	/**
	 * Applies set/delete patches to actions (by id).
	 *
	 * @param {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom", id: string, payload?: Record<string, unknown>|null, ts?: number}>|undefined} existingActions Existing actions.
	 * @param {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom", id: string, payload?: Record<string, unknown>|null, ts?: number}>|{set?: Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom", id: string, payload?: Record<string, unknown>|null, ts?: number}>|Record<string, {type: "ack"|"delete"|"close"|"open"|"link"|"custom", payload?: Record<string, unknown>|null, ts?: number}>, delete?: string[]}|null|undefined} patch Actions patch.
	 * @returns {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom", id: string, payload?: Record<string, unknown>|null, ts?: number}>|undefined} Updated actions.
	 */
	_applyActionsPatch(existingActions, patch) {
		if (patch === null) {
			return undefined;
		}
		if (Array.isArray(patch)) {
			return this._normalizeMsgActions(patch);
		}
		if (patch === undefined) {
			return Array.isArray(existingActions) ? existingActions : undefined;
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`applyPatch: 'actions' must be an array or { set, delete }`);
		}

		let base = Array.isArray(existingActions) ? [...existingActions] : [];
		if ('set' in patch && patch.set !== undefined) {
			const setVal = patch.set;
			if (Array.isArray(setVal)) {
				const normalized = this._normalizeMsgActions(setVal);
				base = normalized ? [...normalized] : [];
			} else if (setVal && typeof setVal === 'object' && !Array.isArray(setVal)) {
				const entries = [];
				Object.entries(setVal).forEach(([id, entry]) => {
					if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
						this.adapter?.log?.warn?.(`applyPatch: 'actions.set.${id}' must be an object`);
						return;
					}
					entries.push({ ...entry, id });
				});
				const normalized = this._normalizeMsgActions(entries) || [];
				const byId = new Map(base.map(item => [item.id, item]));
				normalized.forEach(item => byId.set(item.id, item));
				base = Array.from(byId.values());
			} else {
				throw new TypeError(`applyPatch: 'actions.set' must be an array or object`);
			}
		}
		if ('delete' in patch && patch.delete !== undefined) {
			if (!Array.isArray(patch.delete)) {
				throw new TypeError(`applyPatch: 'actions.delete' must be an array`);
			}
			const deleteSet = new Set();
			patch.delete.forEach((id, index) => {
				const normId = this._normalizeMsgString(id, `actions.delete[${index}]`);
				if (normId) {
					deleteSet.add(normId);
				}
			});
			if (deleteSet.size > 0) {
				base = base.filter(item => !deleteSet.has(item.id));
			}
		}

		return base.length > 0 ? base : undefined;
	}

	/**
	 * Normalizes actions and validates type and optional fields.
	 *
	 * @param {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom", id: string, payload?: Record<string, unknown>|null, ts?: number}>|undefined|null} value Actions input.
	 * @returns {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom", id: string, payload?: Record<string, unknown>|null, ts?: number}>|undefined} Normalized actions.
	 */
	_normalizeMsgActions(value) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (!Array.isArray(value)) {
			throw new TypeError(`createMessage: 'actions' must be an array`);
		}

		const actions = [];
		value.forEach((entry, index) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				this.adapter?.log?.warn?.(`createMessage: 'actions[${index}]' must be an object`);
				return;
			}
			if (entry.type === undefined || entry.type === null) {
				this.adapter?.log?.warn?.(`createMessage: 'actions[${index}].type' is required`);
				return;
			}

			const type = this._normalizeMsgEnum(entry.type, this.actionsTypeValueSet, `actions[${index}].type`);
			if (type === undefined) {
				return;
			}

			const actionId = this._normalizeMsgString(entry.id, `actions[${index}].id`);
			if (actionId === undefined) {
				this.adapter?.log?.warn?.(`createMessage: 'actions[${index}].id' is required`);
				return;
			}
			const action = { type, id: actionId };

			if ('payload' in entry) {
				if (entry.payload === null) {
					action.payload = null;
				} else if (entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)) {
					action.payload = entry.payload;
				} else if (entry.payload !== undefined) {
					this.adapter?.log?.warn?.(`createMessage: 'actions[${index}].payload' must be an object or null`);
				}
			}

			if (entry.ts !== undefined) {
				const ts = this._normalizeMsgNumber(entry.ts, `actions[${index}].ts`);
				if (ts !== undefined) {
					action.ts = ts;
				}
			}

			actions.push(action);
		});

		return actions.length > 0 ? actions : undefined;
	}

	/**
	 * Normalizes progress fields including percentage and timestamps.
	 *
	 * @param {object} value Progress input with percentage/startedAt/finishedAt.
	 * @returns {object} Normalized progress object.
	 */
	_normalineMsgProgress(value) {
		if (!value || typeof value !== 'object') {
			throw new TypeError(`createMessage: 'progress' must be an object`);
		}
		const progress = {
			percentage: value.percentage ? this._normalizeMsgNumber(value.percentage, 'progress.percentage') : 0,
			startedAt: value.startedAt ? this._normalizeMsgTime(value.startedAt, 'progress.startedAt') : undefined,
			notifyAt: value.finishedAt ? this._normalizeMsgTime(value.finishedAt, 'progress.finishedAt') : undefined,
		};

		return this._removeUndefinedKeys(progress);
	}

	// ======================================
	//       generic Helpers
	// ======================================

	/**
	 * Removes keys with undefined values from an object.
	 *
	 * @param {object} obj Input object.
	 * @returns {object} New object without undefined values.
	 */
	_removeUndefinedKeys(obj) {
		return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
	}

	/**
	 * Checks whether a timestamp is an integer within a plausible Unix ms range.
	 *
	 * @param {any} ts Candidate timestamp.
	 * @param {object} [options] Range options.
	 * @param {number} [options.min] Minimum accepted timestamp.
	 * @param {number} [options.max] Maximum accepted timestamp.
	 * @returns {boolean} True when the timestamp is valid and within range.
	 */
	_isPlausibleUnixMs(ts, { min = Date.UTC(2000, 0, 1), max = Date.UTC(2100, 0, 1) } = {}) {
		return typeof ts === 'number' && Number.isFinite(ts) && Number.isInteger(ts) && ts >= min && ts <= max;
	}

	/**
	 * Checks whether a given value is a plain object (no custom prototype).
	 *
	 * @param {any} v Candidate value.
	 * @returns {boolean} True when the value is a plain object.
	 */
	_isPlainObject(v) {
		return (
			v !== null &&
			typeof v === 'object' &&
			(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
		);
	}

	/**
	 * Compares two origin objects for equality by value.
	 *
	 * @param {object} left Normalized origin object.
	 * @param {object} right Normalized origin object.
	 * @returns {boolean} True when both objects contain the same keys and values.
	 */
	_isSameOrigin(left, right) {
		if (!this._isPlainObject(left) || !this._isPlainObject(right)) {
			return false;
		}
		const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
		for (const key of keys) {
			if (left[key] !== right[key]) {
				return false;
			}
		}
		return true;
	}
}

module.exports = { MsgFactory };
