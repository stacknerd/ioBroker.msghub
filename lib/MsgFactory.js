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
 * - Arrays preserve order as provided by the producer (e.g., shopping list item order).
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
 *   kind: "task"|"status"|"appointment"|"shoppinglist"
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
 *   metrics?: Map<string, { val: number|string|boolean|null, unit: string }>
 *
 *   // Attachments (optional)
 *   attachments?: Array<{
 *     type: "ssml"|"image"|"video"|"file"
 *     value: string
 *   }>
 *
 *   // Shopping list (only for kind="shoppinglist")
 *   shoppinglistItems?: Array<{
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
 *     id?: string | null
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

const { MsgConstants } = require(`${__dirname}/MsgConstants`);

/**
 * Builds normalized message objects for Msghub.
 * Validates and sanitizes user input, enforces enum constraints, and removes
 * undefined fields so the stored payload is compact and predictable.
 */
class MsgFactory {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance with msgconst and logging.
	 */
	constructor(adapter) {
		if (!adapter) {
			throw new Error('MsgFactory: adapter is required');
		}
		this.adapter = adapter;
		this.msgconst = MsgConstants;

		// create LevelSets once
		this.levelValueSet = new Set(Object.values(this.msgconst.level));
		this.kindValueSet = new Set(Object.values(this.msgconst.kind));
		this.originTypeValueSet = new Set(Object.values(this.msgconst.origin.type));
		this.attachmentsTypeValueSet = new Set(Object.values(this.msgconst.attachments.type));
		this.actionsTypeValueSet = new Set(Object.values(this.msgconst.actions.type));
		this.enumSetStrings = new Map([
			[this.levelValueSet, Array.from(this.levelValueSet).join(', ')],
			[this.kindValueSet, Array.from(this.kindValueSet).join(', ')],
			[this.originTypeValueSet, Array.from(this.originTypeValueSet).join(', ')],
			[this.attachmentsTypeValueSet, Array.from(this.attachmentsTypeValueSet).join(', ')],
			[this.actionsTypeValueSet, Array.from(this.actionsTypeValueSet).join(', ')],
		]);
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
	 * @param {Map<string, {val: number|string|boolean|null, unit: string}>} [options.metrics] Structured metrics.
	 * @param {Array<{type: "ssml"|"image"|"video"|"file", value: string}>} [options.attachments] Attachment list.
	 * @param {Array<{name: string, category?: string, quantity?: {val: number, unit: string}, checked: boolean}>} [options.shoppinglistItems] Shopping list items.
	 * @param {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom", id?: string|null, payload?: Record<string, unknown>|null, ts?: number}>} [options.actions] Action descriptors.
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
		shoppinglistItems,
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
				shoppinglistItems: this._normaizeMsgShoppinglistItems(shoppinglistItems),
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
			const valuesetString = this._getEnumSetString(valueset);
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
	 * Normalizes timing fields and enforces kind-specific constraints.
	 * Adds a createdAt timestamp and validates optional due/start/end fields.
	 *
	 * @param {object} value Timing input.
	 * @param {string} kind Normalized message kind used for timing rules.
	 * @returns {object} Normalized timing object.
	 */
	_normalineMsgTiming(value, kind) {
		if (!value || typeof value !== 'object') {
			throw new TypeError(`createMessage: 'timing' must be an object`);
		}
		const timing = {
			createdAt: Date.now(),
			expiresAt: value.expiresAt ? this._normalizeMsgTime(value.expiresAt, 'timing.expiresAt') : undefined,
			notifyAt: value.notifyAt ? this._normalizeMsgTime(value.notifyAt, 'timing.notifyAt') : undefined,
		};

		if (value.dueAt) {
			if (kind == this.msgconst.kind.task) {
				// only available on tasks
				timing['dueAt'] = this._normalizeMsgTime(value.dueAt, 'timing.dueAt');
			} else {
				this.adapter?.log?.warn?.(
					`createMessage: 'timing.dueAt' not available on kind == '${kind}' (expected: 'task')`,
				);
			}
		}
		if (value.startAt) {
			if (kind == this.msgconst.kind.appointment) {
				// only available on tasks
				timing['startAt'] = this._normalizeMsgTime(value.startAt, 'timing.startAt');
			} else {
				this.adapter?.log?.warn?.(
					`createMessage: 'timing.startAt' not available on kind == '${kind}' (expected: 'appointment')`,
				);
			}
		}
		if (value.endAt) {
			if (kind == this.msgconst.kind.appointment) {
				// only available on tasks
				timing['endAt'] = this._normalizeMsgTime(value.endAt, 'timing.endAt');
			} else {
				this.adapter?.log?.warn?.(
					`createMessage: 'timing.endAt' not available on kind == '${kind}' (expected: 'appointment')`,
				);
			}
		}

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
	 * Expects a Map of metric entries shaped as { val, unit }.
	 *
	 * @param {Map<string, {val: number|string|boolean|null, unit: string}>|undefined|null} value Metrics map payload.
	 * @returns {Map<string, {val: number|string|boolean|null, unit: string}>|undefined} Normalized metrics payload.
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
				this.adapter?.log?.warn?.(`createMessage: 'metrics.${key}' must be an object with { val, unit }`);
				continue;
			}

			const { val, unit } = entry;
			const valOk =
				val === null ||
				typeof val === 'string' ||
				typeof val === 'boolean' ||
				(typeof val === 'number' && Number.isFinite(val));
			if (!valOk) {
				this.adapter?.log?.warn?.(`createMessage: 'metrics.${key}.val' must be number|string|boolean|null`);
				continue;
			}
			if (typeof unit !== 'string' || !unit.trim()) {
				this.adapter?.log?.warn?.(`createMessage: 'metrics.${key}.unit' must be a non-empty string`);
				continue;
			}

			metrics.set(key, { val, unit: unit.trim() });
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
	 * Normalizes shopping list items and validates required fields.
	 *
	 * @param {Array<{name: string, category?: string, quantity?: {val: number, unit: string}, checked: boolean}>|undefined|null} value Shopping list input.
	 * @returns {Array<{name: string, category?: string, quantity?: {val: number, unit: string}, checked: boolean}>|undefined} Normalized items.
	 */
	_normaizeMsgShoppinglistItems(value) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (!Array.isArray(value)) {
			throw new TypeError(`createMessage: 'shoppinglistItems' must be an array`);
		}

		const items = [];
		value.forEach((entry, index) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				this.adapter?.log?.warn?.(`createMessage: 'shoppinglistItems[${index}]' must be an object`);
				return;
			}

			const name = typeof entry.name === 'string' ? entry.name.trim() : '';
			if (!name) {
				this.adapter?.log?.warn?.(`createMessage: 'shoppinglistItems[${index}].name' is required`);
				return;
			}
			if (typeof entry.checked !== 'boolean') {
				this.adapter?.log?.warn?.(`createMessage: 'shoppinglistItems[${index}].checked' must be boolean`);
				return;
			}

			const item = { name, checked: entry.checked };

			if (entry.category !== undefined) {
				if (typeof entry.category === 'string' && entry.category.trim()) {
					item.category = entry.category.trim();
				} else {
					this.adapter?.log?.warn?.(
						`createMessage: 'shoppinglistItems[${index}].category' must be a non-empty string`,
					);
				}
			}

			if (entry.quantity !== undefined && entry.quantity !== null) {
				if (!entry.quantity || typeof entry.quantity !== 'object' || Array.isArray(entry.quantity)) {
					this.adapter?.log?.warn?.(
						`createMessage: 'shoppinglistItems[${index}].quantity' must be an object`,
					);
				} else {
					const { val, unit } = entry.quantity;
					const valOk = typeof val === 'number' && Number.isFinite(val);
					const unitOk = typeof unit === 'string' && unit.trim().length > 0;

					if (!valOk) {
						this.adapter?.log?.warn?.(
							`createMessage: 'shoppinglistItems[${index}].quantity.val' must be a number`,
						);
					}
					if (!unitOk) {
						this.adapter?.log?.warn?.(
							`createMessage: 'shoppinglistItems[${index}].quantity.unit' must be a non-empty string`,
						);
					}
					if (valOk && unitOk) {
						item.quantity = { val, unit: unit.trim() };
					}
				}
			}

			items.push(item);
		});

		return items.length > 0 ? items : undefined;
	}

	/**
	 * Normalizes actions and validates type and optional fields.
	 *
	 * @param {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom", id?: string|null, payload?: Record<string, unknown>|null, ts?: number}>|undefined|null} value Actions input.
	 * @returns {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom", id?: string|null, payload?: Record<string, unknown>|null, ts?: number}>|undefined} Normalized actions.
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

			const action = { type };

			if ('id' in entry) {
				if (entry.id === null) {
					action.id = null;
				} else if (typeof entry.id === 'string' && entry.id.trim()) {
					action.id = entry.id.trim();
				} else if (entry.id !== undefined) {
					this.adapter?.log?.warn?.(`createMessage: 'actions[${index}].id' must be a string or null`);
				}
			}

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
	 * Returns a cached string representation of an enum set.
	 *
	 * @param {Set<any>} valueset Set of allowed enum values.
	 * @returns {string} Comma-separated list of enum values.
	 */
	_getEnumSetString(valueset) {
		const cached = this.enumSetStrings?.get(valueset);
		if (cached) {
			return cached;
		}
		const valuesetString = Array.from(valueset).join(', ');
		if (this.enumSetStrings) {
			this.enumSetStrings.set(valueset, valuesetString);
		}
		return valuesetString;
	}

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
}

module.exports = { MsgFactory };
