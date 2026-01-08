/**
 * Message model overview
 *
 * Docs: ../docs/modules/MsgFactory.md
 *
 * This block documents the canonical shape of a `Message` object used by the MsgHub.
 * A `Message` is the single, normalized payload that represents something the system
 * wants to surface to the user (e.g., a task, a status update, an appointment, or a
 * shopping list). The goal is to keep a stable core schema for storage, transport,
 * and UI rendering, while still allowing optional, type-specific extensions.
 *
 * Design goals:
 * - Stable identification: `ref` is an internal, unique, persistent ID used for
 *   deduplication, updates, and cross-references. When omitted, a ref can be
 *   auto-generated; recurring events should provide origin.id so the auto-ref
 *   stays stable across updates.
 * - Clear presentation: `title` and `text` are the primary human-readable fields for UI/TTS.
 * - Classification: `level` and `kind` describe urgency/severity and the domain type.
 * - Traceability: `origin` records where the message came from (manual, import, automation)
 *   and optionally which external system/id it was derived from.
 * - Lifecycle semantics: `lifecycle` holds the current workflow/UI state (open/acked/closed/...) with attribution.
 * - Temporal semantics: `timing` holds creation/update timestamps plus optional reminder/domain timestamps
 *   (e.g., notifyAt/remindEvery, timeBudget planning duration, due dates, appointment start/end).
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
 *   ref: string                   // internal unique ID (stable; auto-generated when omitted)
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
 *   lifecycle: {
 *     state: "open"|"acked"|"closed"|"snoozed"|"deleted"|"expired"
 *     stateChangedAt?: number
 *     stateChangedBy?: string | null
 *   }
 *
 *   timing: {
 *     createdAt: number
 *     updatedAt?: number
 *     expiresAt?: number | null
 *     notifyAt?: number | null
 *     remindEvery?: number | null
 *     timeBudget?: number | null // planning duration (ms)
 *
 *     // Domain time fields (optional; semantics depend on kind)
 *     dueAt?: number | null
 *     startAt?: number | null
 *     endAt?: number | null
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
 *     perUnit?: { val: number; unit: string }
 *     checked: boolean
 *   }>
 *
 *   // Actions (optional)
 *   actions?: Array<{
 *     type: "ack"|"delete"|"close"|"open"|"link"|"custom"|"snooze"
 *     // Semantics:
 *     // - ack: mark as seen/acknowledged (do not remove)
 *     // - delete: delete/hide (soft delete; hard delete is a separate concern)
 *     // - close: complete/finish an operation or dismiss an alarm
 *     // - snooze: postpone a reminder/notification by updating notifyAt
 *     // - open: open/activate something (UI navigation or triggering)
 *     // - link: navigation only (no side effects)
 *     // - custom: anything else (device action / automation / plugin-specific)
 *
 *     id: string
 *     payload?: Record<string, unknown> | null
 *   }>
 *
 *   // Progress (optional; mainly for task)
 *   progress: {
 *     startedAt?: number
 *     finishedAt?: number
 *     percentage: number
 *   }
 *
 *   // Audience hints (optional; used by notification plugins)
 *   audience?: {
 *     tags?: string[]
 *     channels?: {
 *       include?: string[]
 *       exclude?: string[]
 *     }
 *   }
 *   // Semantics:
 *   // - tags are free-form IDs (no user management, no validation).
 *   // - channels.include = only these channels; exclude = never these (exclude wins).
 *   // - when audience is missing, there is no delivery restriction.
 *
 *   dependencies?: string[]
 *
 * }
 */

const crypto = require('crypto');

/**
 * MsgFactory
 * ==========
 * Central normalization and validation component for MsgHub `Message` objects.
 *
 * Core responsibilities
 * - Provide a single "normalization gate" (`createMessage`) that turns producer input into the canonical schema.
 * - Provide a single patching/validation gate (`applyPatch`) that applies updates with consistent semantics.
 * - Enforce enum constraints (`level`, `kind`, `origin.type`, attachment/action types) via `msgConstants`.
 * - Keep persisted payloads compact and predictable by omitting empty optional structures.
 *
 * Design guidelines / invariants
 * - Strict core schema: required fields must be present and correctly typed; invalid input results in `null`.
 * - Stable identity: `ref` is normalized to an ASCII/URL-safe identifier; when missing, an auto-ref is generated
 *   so the message remains addressable (updates/deletes). For recurring items, producers should provide `origin.id`
 *   so auto-generated refs stay stable across updates.
 * - Kind-driven rules: some fields are only meaningful for specific kinds (e.g. `listItems` for list kinds).
 * - `undefined` vs `null`: `undefined` means "not present" and is removed before persistence; `null` is used by
 *   patch operations as an explicit signal to clear/remove a field.
 */
class MsgFactory {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter ioBroker adapter instance (logger + lifecycle).
	 * @param {import('./MsgConstants').MsgConstants} msgConstants Centralized enum-like constants (kinds/levels/origin/etc.).
	 */
	constructor(adapter, msgConstants) {
		if (!adapter) {
			throw new Error('MsgFactory: adapter is required');
		}
		this.adapter = adapter;

		if (!msgConstants) {
			throw new Error('MsgFactory: msgConstants is required');
		}
		this.msgConstants = msgConstants;

		// Cache the allowed enum values once so we can validate quickly without repeatedly
		// allocating arrays (Object.values(...)) on every message normalization call.
		this.levelValueSet = new Set(Object.values(this.msgConstants.level));
		this.kindValueSet = new Set(Object.values(this.msgConstants.kind));
		this.originTypeValueSet = new Set(Object.values(this.msgConstants.origin.type));
		this.attachmentsTypeValueSet = new Set(Object.values(this.msgConstants.attachments.type));
		this.actionsTypeValueSet = new Set(Object.values(this.msgConstants.actions.type));
		this.lifecycleStateValueSet = new Set(Object.values(this.msgConstants.lifecycle?.state));

		// Monotonic sequence that is appended to auto-generated refs to reduce the chance
		// of collisions when multiple messages are created within the same millisecond.
		this._autoRefSeq = 0;
	}

	/**
	 * Creates a normalized message object from the provided data.
	 * Required fields are validated, optional fields are sanitized, and any
	 * undefined values are stripped from the final payload.
	 *
	 * Important behavioral notes:
	 * - This method is intentionally strict: invalid required fields throw and are caught
	 *   inside this method, resulting in `null` and a log entry.
	 * - Normalization tries to keep the message compact. Empty optional sub-objects
	 *   (e.g. `details`, `audience`) are returned as `undefined` and removed.
	 * - `ref` is normalized to a URL/ASCII-safe identifier; when omitted, an auto-ref
	 *   is generated so the message can still be stored and referenced.
	 *
	 * @param {object} [options] Raw message fields.
	 * @param {string} [options.ref] Stable, printable identifier for the message (required unless auto-ref is used).
	 * @param {string} [options.title] Human readable title shown in the UI (required).
	 * @param {string} [options.text] Main message body text (required).
	 * @param {number} [options.level] Severity level from msgconst.level (required).
	 * @param {string} [options.kind] Message kind from msgconst.kind (required).
	 * @param {object} [options.origin] Origin metadata including type/system/id (required).
	 * @param {object} [options.timing] Timing metadata including due/start/end and timeBudget.
	 * @param {object} [options.details] Structured details like location or tools.
	 * @param {object} [options.audience] Audience hints (tags/channels) for notification plugins.
	 * @param {object} [options.lifecycle] Lifecycle state (state + attribution timestamps).
	 * @param {Map<string, {val: number|string|boolean|null, unit: string, ts: number}>} [options.metrics] Structured metrics.
	 * @param {Array<{type: "ssml"|"image"|"video"|"file", value: string}>} [options.attachments] Attachment list.
	 * @param {Array<{id: string, name: string, category?: string, quantity?: { val: number; unit: string }, perUnit?: { val: number; unit: string }, checked: boolean}>} [options.listItems] List items for shopping or inventory lists.
	 * @param {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom"|"snooze", id: string, payload?: Record<string, unknown>|null}>} [options.actions] Action descriptors.
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
		audience = {},
		lifecycle = {},
		metrics,
		attachments,
		listItems,
		actions,
		progress = {},
		dependencies = [],
	} = {}) {
		try {
			// Core-owned timestamps: ignore producer-provided values. These are derived/enforced by the core.
			const safeLifecycle =
				lifecycle && typeof lifecycle === 'object' && !Array.isArray(lifecycle) ? { ...lifecycle } : lifecycle;
			if (safeLifecycle && typeof safeLifecycle === 'object' && !Array.isArray(safeLifecycle)) {
				delete safeLifecycle.stateChangedAt;
				// Core-owned lifecycle states: deleted/expired are only set by the store.
				const deletedState = this.msgConstants.lifecycle?.state?.deleted;
				const expiredState = this.msgConstants.lifecycle?.state?.expired;
				const state = typeof safeLifecycle.state === 'string' ? safeLifecycle.state.trim() : '';
				if (state && (state === deletedState || state === expiredState)) {
					delete safeLifecycle.state;
				}
			}
			const safeProgress =
				progress && typeof progress === 'object' && !Array.isArray(progress) ? { ...progress } : progress;
			if (safeProgress && typeof safeProgress === 'object' && !Array.isArray(safeProgress)) {
				delete safeProgress.startedAt;
				delete safeProgress.finishedAt;
			}
			const safeTiming = timing && typeof timing === 'object' && !Array.isArray(timing) ? { ...timing } : timing;
			if (safeTiming && typeof safeTiming === 'object' && !Array.isArray(safeTiming)) {
				delete safeTiming.createdAt;
				delete safeTiming.updatedAt;
			}

			// Normalize `kind` first because it drives kind-specific validation rules later
			// (e.g., timing fields like dueAt/startAt/endAt and whether listItems are allowed).
			const normkind = this._normalizeMsgEnum(kind, this.kindValueSet, 'kind', { required: true });

			// Normalize the remaining required core fields.
			const normOrigin = this._normalizeMsgOrigin(origin);
			const normTitle = this._normalizeMsgString(title, 'title', { required: true });
			const normText = this._normalizeMsgString(text, 'text', { required: true });
			const normLevel = this._normalizeMsgEnum(level, this.levelValueSet, 'level', { required: true });
			const normDetails = this._normalizeMsgDetails(details);

			// Build the canonical message structure. Each helper returns either a normalized value
			// or `undefined` (meaning: omit the field entirely).
			const msg = {
				ref: this._resolveMsgRef(ref, { kind: normkind, origin: normOrigin, title: normTitle }),
				title: normTitle,
				text: normText,
				level: normLevel,
				kind: normkind,
				origin: normOrigin,
				lifecycle: this._normalizeMsgLifecycle(safeLifecycle),
				timing: this._normalineMsgTiming(safeTiming, normkind),
				details: normDetails,
				audience: this._normalizeMsgAudience(audience),
				metrics: this._normalizeMsgMetrics(metrics),
				attachments: this._normalizeMsgAttachments(attachments),
				listItems: this._normalizeMsgListItems(listItems, normkind),
				actions: this._normalizeMsgActions(actions),
				progress: this._normalineMsgProgress(safeProgress),
				dependencies: this._normalizeMsgArray(dependencies, 'dependencies'),
			};

			// Persisted payloads should not contain `undefined` keys because they are ambiguous in JSON,
			// waste space, and make downstream consumers more complex.
			return this._removeUndefinedKeys(msg);
		} catch (e) {
			this.adapter?.log?.error?.(e);
		}

		return null;
	}

	/**
	 * Updates an existing message with a partial patch.
	 * Only fields present in the patch are processed; other fields are preserved.
	 * Optional fields can be cleared by passing `null`.
	 *
	 * This is the canonical "update" API used by the adapter. It follows a consistent
	 * patch language across nested structures:
	 * - For objects: provide a partial object (only keys present are updated).
	 * - For arrays: either replace the array, or use `{ set, delete }` depending on the field.
	 * - For Maps: either replace with a Map, or use `{ set, delete }`.
	 *
	 * Timestamp semantics:
	 * - `timing.createdAt` is immutable.
	 * - `timing.updatedAt` is refreshed when the patch is considered user-visible.
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
	 *   - applyPatch(existing, { timing: { timeBudget: 900000 } })
	 *     => sets/updates the planning duration (ms).
	 *   - applyPatch(existing, { progress: { percentage: 60 } })
	 *     => updates progress.percentage to 60, sets startedAt on first start (percentage > 0),
	 *        clears finishedAt when percentage < 100, and sets finishedAt when percentage == 100.
	 *
	 * - audience (object):
	 *   - Partial updates:
	 *     applyPatch(existing, { audience: { tags: ['admin'] } })
	 *     => updates tags, keeps existing channels.
	 *   - Clear a field:
	 *     applyPatch(existing, { audience: { channels: null } })
	 *     => removes audience.channels.
	 *   - Clear all:
	 *     applyPatch(existing, { audience: null })
	 *     => removes audience.
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
	 * @param {object} [patch.timing] Timing patch (only provided fields are applied, supports timeBudget).
	 * @param {object|null} [patch.details] Updated structured details or null to clear.
	 * @param {object|null} [patch.lifecycle] Lifecycle patch (partial allowed) or null to reset to "open".
	 * @param {object|null} [patch.audience] Audience patch (partial allowed) or null to clear.
	 * @param {Map<string, {val: number|string|boolean|null, unit: string, ts: number}>|{set?: Map<string, {val: number|string|boolean|null, unit: string, ts: number}>|Record<string, {val: number|string|boolean|null, unit: string, ts: number}>, delete?: string[]}|null} [patch.metrics] Metrics patch or null to clear.
	 * @param {Array<{type: "ssml"|"image"|"video"|"file", value: string}>|{set?: Array<{type: "ssml"|"image"|"video"|"file", value: string}>, delete?: number[]}|null} [patch.attachments] Attachments patch or null to clear.
	 * @param {Array<{id: string, name: string, category?: string, quantity?: { val: number; unit: string }, checked: boolean}>|{set?: Array<{id: string, name: string, category?: string, quantity?: { val: number; unit: string }, checked: boolean}>|Record<string, {name: string, category?: string, quantity?: { val: number; unit: string }, checked: boolean}>, delete?: string[]}|null} [patch.listItems] List items patch or null to clear.
	 * @param {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom"|"snooze", id: string, payload?: Record<string, unknown>|null}>|{set?: Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom"|"snooze", id: string, payload?: Record<string, unknown>|null}>|Record<string, {type: "ack"|"delete"|"close"|"open"|"link"|"custom"|"snooze", payload?: Record<string, unknown>|null}>, delete?: string[]}|null} [patch.actions] Actions patch or null to clear.
	 * @param {object|{set?: object, delete?: string[]}|null} [patch.progress] Progress patch or null to clear.
	 * @param {string[]|string|{set?: string[]|string, delete?: string[]}|null} [patch.dependencies] Dependencies patch or null to clear.
	 * @param {boolean} [stealthMode] When true, applies a "silent" patch by suppressing the `timing.updatedAt` bump. This is intended for housekeeping (e.g. rescheduling `notifyAt`) where consumers should not treat the message as "new".
	 * @param {object} [options] Internal options (core only).
	 * @returns {object|null} Updated message or null when validation fails.
	 */
	applyPatch(existing, patch = {}, stealthMode = false, options = {}) {
		try {
			if (!this.isValidMessage(existing)) {
				throw new TypeError('applyPatch: existing message must be a valid message object');
			}

			// Start with a shallow copy; nested objects are replaced/merged by the individual
			// patch handlers below (timing/details/progress/audience/...).
			const updated = { ...existing };
			const patchOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
			let refreshUpdatedAt = false;
			const has = key => Object.prototype.hasOwnProperty.call(patch, key);
			const isEqual = (a, b) => {
				if (Object.is(a, b)) {
					return true;
				}
				if (a instanceof Map && b instanceof Map) {
					if (a.size !== b.size) {
						return false;
					}
					for (const [key, val] of a.entries()) {
						if (!b.has(key) || !isEqual(val, b.get(key))) {
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
						if (!isEqual(a[i], b[i])) {
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
						if (!Object.prototype.hasOwnProperty.call(b, key) || !isEqual(a[key], b[key])) {
							return false;
						}
					}
					return true;
				}
				return false;
			};
			const markUserVisibleChange = (before, after) => {
				// Once we know we have a user-visible change, no further comparisons are needed.
				if (refreshUpdatedAt) {
					return;
				}
				if (!isEqual(before, after)) {
					refreshUpdatedAt = true;
				}
			};

			// Enforce immutability: the caller may provide these fields, but only with the
			// exact same value as the existing message.
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

			// Apply scalar field updates. When one of these changes, we consider it a user-visible
			// update and refresh timing.updatedAt.
			if (has('title')) {
				const value = this._normalizeMsgString(patch.title, 'title', { required: true });
				markUserVisibleChange(existing.title, value);
				updated.title = value;
			}
			if (has('text')) {
				const value = this._normalizeMsgString(patch.text, 'text', { required: true });
				markUserVisibleChange(existing.text, value);
				updated.text = value;
			}
			if (has('level')) {
				const value = this._normalizeMsgEnum(patch.level, this.levelValueSet, 'level', { required: true });
				markUserVisibleChange(existing.level, value);
				updated.level = value;
			}
			if (has('details')) {
				const value = patch.details === null ? undefined : this._normalizeMsgDetails(patch.details);
				markUserVisibleChange(existing.details, value);
				updated.details = value;
			}
			if (has('lifecycle')) {
				const value = this._applyLifecyclePatch(existing.lifecycle, patch.lifecycle, patchOptions);
				markUserVisibleChange(existing.lifecycle, value);
				updated.lifecycle = value;
			}
			if (has('audience')) {
				const value = this._applyAudiencePatch(existing.audience, patch.audience);
				markUserVisibleChange(existing.audience, value);
				updated.audience = value;
			}
			if (has('metrics')) {
				updated.metrics = this._applyMetricsPatch(existing.metrics, patch.metrics);
				// Intentionally *not* refreshing updatedAt when only metrics change:
				// metrics are treated as high-frequency telemetry that should not "bump" the message.
			}
			if (has('attachments')) {
				const value = this._applyArrayPatchByIndex(
					existing.attachments,
					patch.attachments,
					this._normalizeMsgAttachments.bind(this),
					'attachments',
				);
				markUserVisibleChange(existing.attachments, value);
				updated.attachments = value;
			}
			if (has('listItems')) {
				const value = this._applyListItemsPatch(existing.listItems, patch.listItems, existing.kind);
				markUserVisibleChange(existing.listItems, value);
				updated.listItems = value;
			}
			if (has('actions')) {
				const value = this._applyActionsPatch(existing.actions, patch.actions);
				markUserVisibleChange(existing.actions, value);
				updated.actions = value;
			}
			if (has('progress')) {
				const value = this._applyProgressPatch(existing.progress, patch.progress);
				markUserVisibleChange(existing.progress, value);
				updated.progress = value;
			}
			if (has('dependencies')) {
				const value = this._applyDependenciesPatch(existing.dependencies, patch.dependencies);
				markUserVisibleChange(existing.dependencies, value);
				updated.dependencies = value;
			}

			const timing = this._normalineMsgTiming(has('timing') ? patch.timing : {}, existing.kind, { existing });
			if (has('timing')) {
				markUserVisibleChange(existing?.timing || {}, timing);
			}
			if (refreshUpdatedAt && !stealthMode) {
				timing.updatedAt = Date.now();
			}
			updated.timing = timing;
			// TODO: If timing-only changes should also bump updatedAt, move that decision into
			// `_normalineMsgTiming` (so timing normalization can decide based on the specific keys).

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
		// This is a lightweight structural validation used before applying patches.
		// It intentionally only validates the stable "core" parts of the schema.

		// Required core objects.
		if (
			!this._isPlainObject(message) ||
			!this._isPlainObject(message.origin) ||
			!this._isPlainObject(message.progress)
		) {
			return false;
		}

		// Required core fields (type checks only).
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

		// Validate constraints/ranges and enum membership.
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
	 * @overload
	 * @param {any} value Input value to validate.
	 * @param {string} field Field name for error messages.
	 * @param {{ required: true, trim?: boolean, fallback?: string }} options Normalization options.
	 * @returns {string} Normalized string.
	 */
	/**
	 * @overload
	 * @param {any} value Input value to validate.
	 * @param {string} field Field name for error messages.
	 * @param {{ required?: false, trim?: boolean, fallback?: string }} [options] Normalization options.
	 * @returns {string|undefined} Normalized string or fallback/undefined.
	 */
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
				throw new TypeError(`'${field}' must be a string, received '${typeof value}' instead`);
			}

			this.adapter?.log?.warn?.(`MsgFactory: '${field}' must be a string, received '${typeof value}' instead`);
			return fallback;
		}
		const text = trim ? value.trim() : value;
		if (required && !text) {
			throw new TypeError(`'${field}' is required but an empty string`);
		} else if (!text) {
			this.adapter?.log?.warn?.(`MsgFactory: '${field}' is an empty string`);
			return fallback;
		}
		return text;
	}

	/**
	 * Normalizes a numeric field by ensuring it is a finite number.
	 *
	 * MsgHub mostly uses numbers as *positive integers* (timestamps, indices, counts).
	 * Therefore this helper:
	 * - does not coerce strings to numbers
	 * - truncates fractional inputs (e.g. 12.9 -> 12)
	 * - treats non-positive values as invalid (<= 0)
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
				throw new TypeError(`'${field}' must be a number, received '${typeof value}' instead`);
			}

			this.adapter?.log?.warn?.(`MsgFactory: '${field}' must be a number, received '${typeof value}' instead`);
			return fallback;
		}
		const ts = Number.isFinite(value) ? Math.trunc(value) : NaN;
		if (required && !(ts > 0)) {
			throw new TypeError(`'${field}' is required but zero`);
		} else if (!(ts > 0)) {
			this.adapter?.log?.warn?.(`MsgFactory: '${field}' is zero`);
			return fallback;
		}
		return ts;
	}

	/**
	 * Normalizes a numeric field by ensuring it is a finite, positive number.
	 *
	 * Unlike `_normalizeMsgNumber()`, this helper preserves fractional values (e.g. `0.33`).
	 * It is used for domain values like list item quantities.
	 *
	 * @param {any} value Input value to validate.
	 * @param {string} field Field name for error messages.
	 * @param {object} [options] Normalization options.
	 * @param {boolean} [options.required] Whether the value must be > 0.
	 * @param {number} [options.fallback] Returned when the value is optional but invalid.
	 * @returns {number|undefined} Normalized number or fallback/undefined.
	 */
	_normalizeMsgPositiveNumber(value, field, { required = false, fallback = undefined } = {}) {
		if (typeof value !== 'number') {
			if (required) {
				throw new TypeError(`'${field}' must be a number, received '${typeof value}' instead`);
			}

			this.adapter?.log?.warn?.(`MsgFactory: '${field}' must be a number, received '${typeof value}' instead`);
			return fallback;
		}

		const num = Number.isFinite(value) ? value : NaN;
		if (required && !(num > 0)) {
			throw new TypeError(`'${field}' is required but not positive`);
		}
		if (!(num > 0)) {
			this.adapter?.log?.warn?.(`MsgFactory: '${field}' is not positive`);
			return fallback;
		}

		return num;
	}

	/**
	 * Normalizes a timestamp field and validates it as a plausible Unix ms value.
	 *
	 * Plausibility is enforced via `_isPlausibleUnixMs()` to catch common unit errors:
	 * - seconds vs milliseconds (e.g. 1730000000 is "seconds", which would be too small)
	 * - human input mistakes (negative, NaN, far-future values)
	 *
	 * The default allowed range is intentionally conservative (2000..2100) because this is
	 * a home-automation context and helps detect accidental unit conversions early.
	 *
	 * @param {any} value Input value to validate.
	 * @param {string} field Field name for error messages.
	 * @param {object} [options] Normalization options.
	 * @param {boolean} [options.required] Whether the value must be present and valid.
	 * @param {number} [options.fallback] Returned when the value is optional but invalid.
	 * @returns {number|undefined} Normalized timestamp or fallback/undefined.
	 */
	_normalizeMsgTime(value, field, { required = false, fallback = undefined } = {}) {
		// First validate "numberness" and convert to an integer. The caller can decide whether
		// the field is required and what fallback to use.
		const ts = this._normalizeMsgNumber(value, field, { required, fallback });

		// Then apply a plausibility check to catch unit mistakes early (seconds vs ms, etc.).
		if (!this._isPlausibleUnixMs(ts)) {
			throw new TypeError(`'${field}' is not a plausible UnixMs timestamp (received:'${ts}')`);
		}

		return ts;
	}

	/**
	 * Normalizes an enum field by validating membership in a known value set.
	 *
	 * This helper is intentionally strict and does not attempt to coerce between types
	 * (e.g. it will not convert `"10"` to `10`). The caller must pass the correct type.
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
				throw new TypeError(`'${field}' missing`);
			}
			return fallback;
		}

		// Strict membership test: we do not coerce types or attempt fuzzy matching.
		if (!valueset.has(value)) {
			const valuesetString = Array.from(valueset).join(', ');
			if (required) {
				throw new TypeError(`'${field}' must be one of '${valuesetString}', received '${value}' instead`);
			}
			this.adapter?.log?.warn?.(
				`MsgFactory: '${field}' must be one of '${valuesetString}', received '${value}' instead`,
			);
			return fallback;
		}
		return value;
	}

	/**
	 * Normalizes a list field to an array of trimmed strings.
	 *
	 * Supported inputs:
	 * - `string[]`: trims each entry and removes empty / non-string entries
	 * - `string`: either returns `[string]` or splits by comma (configurable)
	 *
	 * The output is `undefined` when the result would be an empty list. This allows callers
	 * to omit optional arrays instead of storing empty arrays everywhere.
	 *
	 * @param {string[]|string|undefined|null} value Input array or comma-separated string.
	 * @param {string} field Field name for warning messages.
	 * @param {object} [options] Normalization options.
	 * @param {boolean} [options.splitString] Whether to split string inputs on commas.
	 * @returns {string[]|undefined} Normalized list of strings, or undefined when empty/invalid.
	 */
	_normalizeMsgArray(value, field, { splitString = true } = {}) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (Array.isArray(value)) {
			// Trim entries and drop empty/non-string items.
			const normalized = [];
			for (const entry of value) {
				if (typeof entry !== 'string') {
					continue;
				}
				const trimmed = entry.trim();
				if (!trimmed) {
					continue;
				}
				normalized.push(trimmed);
			}
			if (normalized.length !== value.length) {
				// The producer sent something unexpected. We still return a best-effort result.
				this.adapter?.log?.warn?.(`MsgFactory: '${field}'-array contains non-string or empty entries`);
			}
			return normalized.length > 0 ? normalized : undefined;
		}
		if (typeof value === 'string') {
			const text = value.trim();
			if (!text) {
				return undefined;
			}
			if (!splitString) {
				// Treat the entire string as a single entry (no CSV split).
				return [text];
			}
			// Default behavior: treat string input as a comma-separated list.
			const normalized = text
				.split(',')
				.map(entry => entry.trim())
				.filter(entry => entry.length > 0);
			return normalized.length > 0 ? normalized : undefined;
		}
		this.adapter?.log?.warn?.(`MsgFactory: '${field}'-array must be string[] or comma-separated string`);
		return undefined;
	}

	// ======================================
	//     normalize specific fields
	// ======================================

	/**
	 * Resolves a message ref, optionally auto-generating for eligible manual messages.
	 *
	 * `ref` is treated as the stable identity of a message. If a producer does not supply
	 * a ref, we still create one so the message can be stored and later addressed (update/delete).
	 *
	 * Auto-refs are designed to be:
	 * - printable and URL/ID safe (see `_normalizeMsgRef`)
	 * - reasonably stable for recurring items if `origin.id` is provided
	 *
	 * @param {any} value Input reference value.
	 * @param {{ kind?: string, origin?: any, title?: string }} [context] Context for auto-ref generation.
	 * @returns {string} Normalized reference.
	 */
	_resolveMsgRef(value, { kind, origin, title } = {}) {
		const hasString = typeof value === 'string' && value.trim();
		if (hasString || (value !== undefined && value !== null && typeof value !== 'string')) {
			// Caller supplied a ref (or at least attempted to). Normalize and validate.
			return this._normalizeMsgRef(value);
		}

		// No ref provided: create an auto-ref so the message remains addressable.
		const originType = origin?.type;
		const originIdNote = origin?.id ? '' : ' (origin.id missing; recurring events should set origin.id)';
		if (originType === this.msgConstants.origin.type.import) {
			this.adapter?.log?.warn?.(`MsgFactory: auto-generated ref for import message without ref${originIdNote}`);
		} else if (originType === this.msgConstants.origin.type.automation) {
			this.adapter?.log?.error?.(
				`MsgFactory: auto-generated ref for automation message without ref${originIdNote}`,
			);
		} else if (!origin?.id) {
			this.adapter?.log?.warn?.(
				'MsgFactory: auto-generated ref without origin.id; recurring events should set origin.id',
			);
		}

		const autoRef = this._buildAutoRef({ kind, origin, title });
		return this._normalizeMsgRef(autoRef);
	}

	/**
	 * Build an auto-generated ref for manual task/appointment messages.
	 *
	 * Structure (conceptually):
	 * - `{origin.type}-{kind}-{origin.system}-{origin.id|title}-{token?}`
	 *
	 * If `origin.id` is present it is preferred because it can provide stability across updates.
	 * Otherwise the ref includes a human-readable `title` segment plus a time/sequence token.
	 *
	 * @param {{ kind?: string, origin?: any, title?: string }} [context] Context for auto-ref generation.
	 * @returns {string} Auto-generated ref.
	 */
	_buildAutoRef({ kind, origin = {}, title } = {}) {
		// Build stable-ish, readable segments first. Each segment is "slugified" and kept short.
		const type = this._formatRefSegment(origin.type, { fallback: 'auto' });
		const kindSegment = this._formatRefSegment(kind, { fallback: 'kind' });
		const system = this._formatRefSegment(origin.system, { fallback: 'origin' });

		if (origin.id) {
			// Prefer upstream IDs for stability. If the id is not slug-safe, we fall back to hashing.
			const idSegment = this._formatRefSegment(origin.id, { fallback: this._hashRefSeed(origin.id).slice(0, 8) });
			return `${type}-${kindSegment}-${system}-${idSegment}`;
		}

		// Without origin.id we include the (normalized) title plus a token to reduce collisions.
		const name = this._formatRefSegment(title, { fallback: 'item' });
		const token = this._nextAutoRefToken();
		return `${type}-${kindSegment}-${system}-${name}-${token}`;
	}

	/**
	 * Create a short monotonic token for auto-generated refs.
	 *
	 * The token combines:
	 * - current time in base36 (compact)
	 * - a short rolling sequence number (to disambiguate within the same millisecond)
	 *
	 * @returns {string} Token safe for ref segments.
	 */
	_nextAutoRefToken() {
		const stamp = Date.now().toString(36);
		const seq = (this._autoRefSeq++ % 0xffff).toString(36).padStart(4, '0');
		return `${stamp}${seq}`;
	}

	/**
	 * Normalize a string into a ref-safe segment.
	 *
	 * This is a small "slugify" implementation:
	 * - lowercases
	 * - replaces non `[a-z0-9]` runs with `-`
	 * - trims leading/trailing dashes
	 *
	 * When slugification would produce an empty string (e.g. only emojis), we fall back
	 * to a short hash segment to keep the ref deterministic.
	 *
	 * @param {any} value Input value.
	 * @param {object} [options] Normalization options.
	 * @param {string} [options.fallback] Fallback when no safe segment is available.
	 * @returns {string} Safe ref segment.
	 */
	_formatRefSegment(value, { fallback = '' } = {}) {
		if (value === undefined || value === null) {
			return fallback;
		}
		const raw = String(value).trim();
		if (!raw) {
			return fallback;
		}
		// Small slugify step: this keeps the ref mostly human-readable.
		const slug = raw
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
		if (slug) {
			return slug;
		}
		return this._hashRefSeed(raw).slice(0, 8);
	}

	/**
	 * Hash a string to keep deterministic yet short ref segments.
	 *
	 * A hash is only used as a last resort (when the segment cannot be expressed as a simple slug).
	 *
	 * @param {any} value Input value.
	 * @returns {string} Hex hash string.
	 */
	_hashRefSeed(value) {
		return crypto.createHash('sha1').update(String(value)).digest('hex');
	}

	/**
	 * Normalizes a message reference to printable ASCII only.
	 *
	 * Why `encodeURIComponent`?
	 * - It produces an ASCII-only representation that is safe to embed into URLs and also
	 *   safe for common storage keys where spaces/special characters can be problematic.
	 * - It is reversible for debugging (unlike hashing), so it keeps refs readable.
	 *
	 * @param {any} value Input reference value.
	 * @returns {string} Normalized reference.
	 */
	_normalizeMsgRef(value) {
		const ref = this._normalizeMsgString(value, 'ref', { required: true });
		let decoded = ref;
		try {
			decoded = decodeURIComponent(ref);
		} catch {
			decoded = ref;
		}
		const saferef = encodeURIComponent(decoded);

		// Log only when normalization changed something (e.g. spaces -> %20).
		if (ref !== saferef) {
			this.adapter?.log?.warn?.(`MsgFactory: received ref='${ref}', normalized to  '${saferef}'`);
		}
		return saferef;
	}

	/**
	 * Normalizes the origin object including enum validation and optional fields.
	 *
	 * `origin` is important for auditability and for auto-ref generation:
	 * - `type` indicates whether the message comes from manual input, an import, or automation.
	 * - `system` is a free-form source identifier (e.g. "icloud", "alexa").
	 * - `id` is an upstream identifier and should be stable for recurring items.
	 *
	 * @param {object} value Origin input with type/system/id.
	 * @returns {object} Normalized origin object.
	 */
	_normalizeMsgOrigin(value) {
		if (!value || typeof value !== 'object') {
			throw new TypeError(`'origin' must be an object`);
		}
		if (!(typeof value.type === 'string' && value.type.trim() !== '')) {
			throw new TypeError(`'origin.type' must be a string, received '${typeof value.type}' instead`);
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
	 * Notes:
	 * - `dueAt`/`startAt`/`endAt` are optional domain timestamps. They are not restricted by `kind` so
	 *   producers can model planned windows (e.g. tasks with a planned start date, statuses with a
	 *   predicted start/end, list kinds with a deadline).
	 * - `timeBudget` is an optional planning duration in ms (not a timestamp).
	 *
	 * Clearing semantics:
	 * - Passing `null` for a timing key removes that key from the message.
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
			throw new TypeError(`'timing' must be an object`);
		}

		// In update scenarios we start from the existing timing object and only touch keys
		// explicitly present in the patch. This prevents accidental loss of timing metadata.
		const baseTiming = updating && existing?.timing ? { ...existing.timing } : {};
		const timing = { ...baseTiming };
		const has = key => Object.prototype.hasOwnProperty.call(value, key);

		if (!updating) {
			// On creation, createdAt is always set (even if the producer omitted timing.createdAt).
			timing.createdAt = Date.now();
		} else if (baseTiming.createdAt !== undefined) {
			// On update, createdAt must remain stable.
			timing.createdAt = baseTiming.createdAt;
		}

		if (updating && setUpdatedAt) {
			// updatedAt is a local "this message changed" marker used by UIs and sync code.
			timing.updatedAt = Date.now();
		}

		// Helper for each timing key:
		// - Only touch keys that are explicitly present in the patch (own properties).
		// - Treat `null` as "delete this key".
		// - (Optional) enforce kind-specific fields.
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
					`MsgFactory: 'timing.${key}' not available on kind == '${kind}' (expected: '${kindGuard}')`,
				);
				return;
			}
			timing[key] = this._normalizeMsgTime(value[key], `timing.${key}`);
		};

		setTime('expiresAt');
		setTime('notifyAt');
		// Reminder interval (duration in ms). This is intentionally treated as a duration, not a timestamp.
		// Null clears the field.
		if (has('remindEvery')) {
			if (value.remindEvery === null) {
				delete timing.remindEvery;
			} else {
				const v = this._normalizeMsgNumber(value.remindEvery, 'timing.remindEvery');
				if (v !== undefined) {
					timing.remindEvery = v;
				}
			}
		}
		// Planning time budget (duration in ms). This is intentionally treated as a duration, not a timestamp.
		// Null clears the field.
		if (has('timeBudget')) {
			if (value.timeBudget === null) {
				delete timing.timeBudget;
			} else {
				const v = this._normalizeMsgNumber(value.timeBudget, 'timing.timeBudget');
				if (v !== undefined) {
					timing.timeBudget = v;
				}
			}
		}
		setTime('dueAt');
		setTime('startAt');
		setTime('endAt');

		return this._removeUndefinedKeys(timing);
	}

	/**
	 * Normalizes the lifecycle block (state + attribution).
	 *
	 * Rules:
	 * - Always returns an object with a valid `state` (fallback: 'open').
	 * - `stateChangedAt` is a core-owned timestamp and should be treated as read-only by producers.
	 * - `stateChangedBy` is optional and may be `null` to clear.
	 *
	 * @param {any} value Lifecycle input.
	 * @returns {{state: string, stateChangedAt?: number|null, stateChangedBy?: string|null}} Normalized lifecycle.
	 */
	_normalizeMsgLifecycle(value) {
		const fallbackState = this.msgConstants.lifecycle.state.open;
		const allowed = this.lifecycleStateValueSet;

		if (value === undefined || value === null) {
			return { state: fallbackState };
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new TypeError("'lifecycle' must be an object");
		}

		const out = { state: fallbackState };
		if (Object.prototype.hasOwnProperty.call(value, 'state')) {
			const s = typeof value.state === 'string' ? value.state.trim() : '';
			if (s && allowed.has(s)) {
				out.state = s;
			} else if (s) {
				this.adapter?.log?.warn?.(`MsgFactory: unsupported lifecycle.state '${s}', using '${fallbackState}'`);
			}
		}

		if (Object.prototype.hasOwnProperty.call(value, 'stateChangedAt')) {
			if (value.stateChangedAt === null) {
				out.stateChangedAt = null;
			} else {
				out.stateChangedAt = this._normalizeMsgTime(value.stateChangedAt, 'lifecycle.stateChangedAt');
			}
		}
		if (Object.prototype.hasOwnProperty.call(value, 'stateChangedBy')) {
			if (value.stateChangedBy === null) {
				out.stateChangedBy = null;
			} else {
				out.stateChangedBy = this._normalizeMsgString(value.stateChangedBy, 'lifecycle.stateChangedBy');
			}
		}

		return this._removeUndefinedKeys(out);
	}

	/**
	 * Apply a lifecycle patch (object or null).
	 *
	 * @param {any} existing Existing lifecycle (may be missing on older stored messages).
	 * @param {any} patch Patch object or null.
	 * @param {object} [options] Internal options (core only).
	 */
	_applyLifecyclePatch(existing, patch, options = {}) {
		const allowCoreLifecycleStates =
			options &&
			typeof options === 'object' &&
			!Array.isArray(options) &&
			options.allowCoreLifecycleStates === true;
		const base = this._normalizeMsgLifecycle(existing);
		if (patch === undefined) {
			return base;
		}
		if (patch === null) {
			const resetState = this.msgConstants.lifecycle.state.open;
			const merged = {
				...base,
				state: resetState,
				stateChangedBy: null,
			};
			if (merged.state !== base.state) {
				merged.stateChangedAt = Date.now();
			}
			return this._removeUndefinedKeys(merged);
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError("'lifecycle' must be an object or null");
		}
		const merged = { ...base };
		if (Object.prototype.hasOwnProperty.call(patch, 'state')) {
			const nextState = this._normalizeMsgLifecycle({ state: patch.state }).state;
			if (!allowCoreLifecycleStates) {
				const deletedState = this.msgConstants.lifecycle?.state?.deleted || 'deleted';
				const expiredState = this.msgConstants.lifecycle?.state?.expired || 'expired';
				if (nextState === deletedState || nextState === expiredState) {
					throw new TypeError(`applyPatch: lifecycle.state '${nextState}' is core-managed`);
				}
			}
			merged.state = nextState;
		}
		if (Object.prototype.hasOwnProperty.call(patch, 'stateChangedBy')) {
			merged.stateChangedBy =
				patch.stateChangedBy === null
					? null
					: this._normalizeMsgString(patch.stateChangedBy, 'lifecycle.stateChangedBy');
		}

		// Core-owned timestamp: bump only when the lifecycle state changes.
		if (merged.state !== base.state) {
			merged.stateChangedAt = Date.now();
		}
		return this._removeUndefinedKeys(merged);
	}

	/**
	 * Normalizes structured details into a compact object.
	 *
	 * `details` is intentionally free-form-ish but still normalized so UI code can
	 * rely on predictable types. All fields are optional; empty details are omitted.
	 *
	 * @param {object} value Details input.
	 * @returns {object|undefined} Normalized details or undefined when empty.
	 */
	_normalizeMsgDetails(value) {
		if (!value || typeof value !== 'object') {
			throw new TypeError(`'details' must be an object`);
		}
		const details = this._removeUndefinedKeys({
			location: value.location ? this._normalizeMsgString(value.location, 'details.location') : undefined,
			task: value.task ? this._normalizeMsgString(value.task, 'details.task') : undefined,
			reason: value.reason ? this._normalizeMsgString(value.reason, 'details.reason') : undefined,
			tools: value.tools
				? this._normalizeMsgArray(value.tools, 'details.tools', { splitString: false })
				: undefined,
			consumables: value.consumables
				? this._normalizeMsgArray(value.consumables, 'details.consumables', { splitString: false })
				: undefined,
		});
		return Object.keys(details).length > 0 ? details : undefined;
	}

	/**
	 * Normalizes audience hints into a compact object.
	 *
	 * Audience hints can be used by notification plugins to decide where a message
	 * should be delivered:
	 * - `tags` are free-form identifiers
	 * - `channels.include` / `channels.exclude` are lists of channel IDs
	 *
	 * This factory only normalizes shape/types; interpretation (like "exclude wins")
	 * is implemented in the delivery layer.
	 *
	 * @param {object|undefined|null} value Audience input.
	 * @returns {object|undefined} Normalized audience or undefined when empty.
	 */
	_normalizeMsgAudience(value) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new TypeError(`'audience' must be an object`);
		}

		const tags = value.tags ? this._normalizeMsgArray(value.tags, 'audience.tags') : undefined;

		let channels;
		if (value.channels !== undefined && value.channels !== null) {
			if (!value.channels || typeof value.channels !== 'object' || Array.isArray(value.channels)) {
				this.adapter?.log?.warn?.(`MsgFactory: 'audience.channels' must be an object`);
			} else {
				const include = value.channels.include
					? this._normalizeMsgArray(value.channels.include, 'audience.channels.include')
					: undefined;
				const exclude = value.channels.exclude
					? this._normalizeMsgArray(value.channels.exclude, 'audience.channels.exclude')
					: undefined;
				channels = this._removeUndefinedKeys({ include, exclude });
				if (Object.keys(channels).length === 0) {
					channels = undefined;
				}
			}
		}

		const audience = this._removeUndefinedKeys({ tags, channels });
		return Object.keys(audience).length > 0 ? audience : undefined;
	}

	/**
	 * Normalizes the metrics payload for a message.
	 * Expects a Map of metric entries shaped as { val, unit, ts }.
	 *
	 * Metrics are designed for machine consumption (charts, history, correlation) and are
	 * treated separately from the human-facing `text`.
	 *
	 * We keep metrics as a `Map` because:
	 * - it has explicit key semantics (no prototype keys)
	 * - it round-trips well in-memory and is efficient for patching (`set`/`delete`)
	 *
	 * @param {Map<string, {val: number|string|boolean|null, unit: string, ts: number}>|undefined|null} value Metrics map payload.
	 * @returns {Map<string, {val: number|string|boolean|null, unit: string, ts: number}>|undefined} Normalized metrics payload.
	 */
	_normalizeMsgMetrics(value) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (!(value instanceof Map)) {
			throw new TypeError(`'metrics' must be a Map`);
		}

		// We create a new map so callers can safely pass a map they still want to mutate elsewhere.
		const metrics = new Map();
		for (const [rawKey, entry] of value.entries()) {
			const key = this._normalizeMsgString(rawKey, 'metrics key', { required: true });

			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				this.adapter?.log?.warn?.(`MsgFactory: 'metrics.${key}' must be an object with { val, unit, ts }`);
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
					`MsgFactory: 'metrics.${key}.val' must be number|string|boolean|null, received ${typeof val}`,
				);
				continue;
			}
			if (typeof unit !== 'string' || !unit.trim()) {
				this.adapter?.log?.warn?.(`MsgFactory: 'metrics.${key}.unit' must be a non-empty string`);
				continue;
			}
			const tsOk =
				typeof ts === 'number' && Number.isFinite(ts) && Number.isInteger(ts) && this._isPlausibleUnixMs(ts);
			if (!tsOk) {
				this.adapter?.log?.warn?.(
					`MsgFactory: 'metrics.${key}.ts' must be a plausible Unix ms timestamp, received '${ts}'`,
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
	 * Attachments are ordered and intentionally kept as an array because the consumer
	 * may want to render them in the order they were produced.
	 *
	 * @param {Array<{type: "ssml"|"image"|"video"|"file", value: string}>|undefined|null} value Attachments input.
	 * @returns {Array<{type: "ssml"|"image"|"video"|"file", value: string}>|undefined} Normalized attachments.
	 */
	_normalizeMsgAttachments(value) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (!Array.isArray(value)) {
			throw new TypeError(`'attachments' must be an array`);
		}

		const attachments = [];
		value.forEach((entry, index) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				this.adapter?.log?.warn?.(`MsgFactory: 'attachments[${index}]' must be an object`);
				return;
			}

			if (entry.type === undefined || entry.type === null) {
				this.adapter?.log?.warn?.(`MsgFactory: 'attachments[${index}].type' is required`);
				return;
			}
			const type = this._normalizeMsgEnum(entry.type, this.attachmentsTypeValueSet, `attachments[${index}].type`);
			const val = this._normalizeMsgString(entry.value, `attachments[${index}].value`);

			if (type === undefined || val === undefined) {
				this.adapter?.log?.warn?.(
					`MsgFactory: 'attachments[${index}]' has empty type('${type}') or val('${val}')`,
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
	 * List semantics:
	 * - Each item must have a stable `id` (used for patching by id).
	 * - `checked` is always normalized to a boolean, defaulting to `false`.
	 * - `quantity` is optional and, when present, uses `{ val, unit }`.
	 * - `perUnit` is optional and, when present, uses `{ val, unit }`.
	 *
	 * @param {Array<{id: string, name: string, category?: string, quantity?: { val: number, unit: string }, perUnit?: { val: number, unit: string }, checked: boolean}>|undefined|null} value List items input.
	 * @param {string} kind Message kind.
	 * @returns {Array<{id: string, name: string, category?: string, quantity?: { val: number, unit: string }, perUnit?: { val: number, unit: string }, checked: boolean}>|undefined} Normalized list items.
	 */
	_normalizeMsgListItems(value, kind) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (kind !== this.msgConstants.kind.shoppinglist && kind !== this.msgConstants.kind.inventorylist) {
			this.adapter?.log?.warn?.(`MsgFactory: 'listItems' not available on kind == '${kind}'`);
			return undefined;
		}
		if (!Array.isArray(value)) {
			throw new TypeError(`'listItems' must be an array`);
		}

		const items = [];
		value.forEach((entry, index) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				this.adapter?.log?.warn?.(`MsgFactory: 'listItems[${index}]' must be an object`);
				return;
			}

			const id = this._normalizeMsgString(entry.id, `listItems[${index}].id`);
			const name = this._normalizeMsgString(entry.name, `listItems[${index}].name`);
			const category = entry.category
				? this._normalizeMsgString(entry.category, `listItems[${index}].category`)
				: undefined;

			if (id === undefined || name === undefined) {
				this.adapter?.log?.warn?.(`MsgFactory: 'listItems[${index}]' requires non-empty id and name`);
				return;
			}

			let quantity;
			if (entry.quantity !== undefined && entry.quantity !== null) {
				if (!entry.quantity || typeof entry.quantity !== 'object' || Array.isArray(entry.quantity)) {
					this.adapter?.log?.warn?.(
						`MsgFactory: 'listItems[${index}].quantity' must be an object with { val, unit }`,
					);
				} else {
					const val = this._normalizeMsgPositiveNumber(entry.quantity.val, `listItems[${index}].quantity.val`);
					const unit = this._normalizeMsgString(entry.quantity.unit, `listItems[${index}].quantity.unit`);
					if (val === undefined || unit === undefined) {
						this.adapter?.log?.warn?.(`MsgFactory: 'listItems[${index}].quantity' requires val and unit`);
					} else {
						quantity = { val, unit };
					}
				}
			}

			let perUnit;
			if (entry.perUnit !== undefined && entry.perUnit !== null) {
				if (!entry.perUnit || typeof entry.perUnit !== 'object' || Array.isArray(entry.perUnit)) {
					this.adapter?.log?.warn?.(
						`MsgFactory: 'listItems[${index}].perUnit' must be an object with { val, unit }`,
					);
				} else {
					const val = this._normalizeMsgPositiveNumber(entry.perUnit.val, `listItems[${index}].perUnit.val`);
					const unit = this._normalizeMsgString(entry.perUnit.unit, `listItems[${index}].perUnit.unit`);
					if (val === undefined || unit === undefined) {
						this.adapter?.log?.warn?.(`MsgFactory: 'listItems[${index}].perUnit' requires val and unit`);
					} else {
						perUnit = { val, unit };
					}
				}
			}

			let checked = false;
			if (entry.checked === undefined) {
				checked = false;
			} else if (typeof entry.checked === 'boolean') {
				checked = entry.checked;
			} else {
				this.adapter?.log?.warn?.(`MsgFactory: 'listItems[${index}].checked' must be boolean`);
			}

			const item = this._removeUndefinedKeys({ id, name, category, quantity, perUnit, checked });
			items.push(item);
		});

		return items.length > 0 ? items : undefined;
	}

	/**
	 * Applies set/delete patches to metrics.
	 *
	 * Supported patch formats:
	 * - `Map`: full replacement (after normalization)
	 * - `{ set, delete }`: partial update by key
	 * - `null`: clear the entire metrics section
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
			// Full replacement.
			return this._normalizeMsgMetrics(patch);
		}
		if (patch === undefined) {
			return existingMetrics instanceof Map ? existingMetrics : undefined;
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`'metrics' must be a Map or { set, delete }`);
		}

		const base = existingMetrics instanceof Map ? new Map(existingMetrics) : new Map();
		if ('set' in patch) {
			const setVal = patch.set;
			let setMap;
			if (setVal instanceof Map) {
				setMap = setVal;
			} else if (setVal && typeof setVal === 'object' && !Array.isArray(setVal)) {
				// Allow plain objects as a convenience format: { key: { val, unit, ts } }.
				setMap = new Map(Object.entries(setVal));
			} else if (setVal !== undefined) {
				throw new TypeError(`'metrics.set' must be a Map or object`);
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
				throw new TypeError(`'metrics.delete' must be an array`);
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
	 * This patch mode is intentionally index-based and therefore only suited for arrays
	 * where items do not have stable IDs (e.g. `attachments`). For id-based arrays use
	 * a dedicated `{ set, delete }` handler (see listItems/actions).
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
			// Full replacement.
			return normalizeFn(patch);
		}
		if (patch === undefined) {
			return Array.isArray(existingArray) ? existingArray : undefined;
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`'${field}' must be an array or { set, delete }`);
		}

		let base = Array.isArray(existingArray) ? [...existingArray] : [];
		if ('set' in patch && patch.set !== undefined) {
			if (!Array.isArray(patch.set)) {
				throw new TypeError(`'${field}.set' must be an array`);
			}
			const normalized = normalizeFn(patch.set);
			base = normalized ? [...normalized] : [];
		}
		if ('delete' in patch && patch.delete !== undefined) {
			if (!Array.isArray(patch.delete)) {
				throw new TypeError(`'${field}.delete' must be an array`);
			}
			// Delete in descending order so indices do not shift under our feet.
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
	 * The id-based patch format is designed to support common UI interactions:
	 * - toggle `checked` without sending the full list
	 * - rename an item
	 * - add/remove a single item
	 *
	 * Supported patch formats:
	 * - `Array`: full replacement (after normalization)
	 * - `{ set: Array }`: full replacement (after normalization)
	 * - `{ set: Record<string,PartialItem> }`: merge/update by id
	 * - `{ delete: string[] }`: remove by id
	 *
	 * @param {Array<{id: string, name: string, category?: string, quantity?: { val: number, unit: string }, perUnit?: { val: number, unit: string }, checked: boolean}>|undefined} existingItems Existing list items.
	 * @param {Array<{id: string, name: string, category?: string, quantity?: { val: number; unit: string }, perUnit?: { val: number; unit: string }, checked: boolean}>|{set?: Array<{id: string, name: string, category?: string, quantity?: { val: number; unit: string }, perUnit?: { val: number; unit: string }, checked: boolean}>|Record<string, {name: string, category?: string, quantity?: { val: number; unit: string }, perUnit?: { val: number; unit: string }, checked: boolean}>, delete?: string[]}|null|undefined} patch List items patch.
	 * @param {string} kind Message kind.
	 * @returns {Array<{id: string, name: string, category?: string, quantity?: { val: number, unit: string }, perUnit?: { val: number, unit: string }, checked: boolean}>|undefined} Updated list items.
	 */
	_applyListItemsPatch(existingItems, patch, kind) {
		if (patch === null) {
			return undefined;
		}
		if (Array.isArray(patch)) {
			// Full replacement.
			return this._normalizeMsgListItems(patch, kind);
		}
		if (patch === undefined) {
			return Array.isArray(existingItems) ? existingItems : undefined;
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`'listItems' must be an array or { set, delete }`);
		}

		let base = Array.isArray(existingItems) ? [...existingItems] : [];
		if ('set' in patch && patch.set !== undefined) {
			const setVal = patch.set;
			if (Array.isArray(setVal)) {
				// Full replacement.
				const normalized = this._normalizeMsgListItems(setVal, kind);
				base = normalized ? [...normalized] : [];
			} else if (setVal && typeof setVal === 'object' && !Array.isArray(setVal)) {
				// Id-addressed merge/upsert:
				// - supports partial updates like `{ set: { "<id>": { checked: true } } }`
				// - supports new items when `name` is provided
				// - preserves existing items unless overwritten by the patch
				const byId = new Map(base.map(item => [item.id, item]));
				Object.entries(setVal).forEach(([id, entry]) => {
					if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
						this.adapter?.log?.warn?.(`MsgFactory: 'listItems.set.${id}' must be an object`);
						return;
					}
					const existing = byId.get(id) || null;
					const merged = { ...(existing || {}), ...entry, id };
					const normalized = this._normalizeMsgListItems([merged], kind);
					if (!normalized || normalized.length === 0) {
						return;
					}
					byId.set(id, normalized[0]);
				});
				base = Array.from(byId.values());
			} else {
				throw new TypeError(`'listItems.set' must be an array or object`);
			}
		}
		if ('delete' in patch && patch.delete !== undefined) {
			if (!Array.isArray(patch.delete)) {
				throw new TypeError(`'listItems.delete' must be an array`);
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
	 * Dependencies are a lightweight mechanism to express relationships between messages
	 * (e.g. "this task depends on message X").
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
			// Full replacement (string is treated as CSV by `_normalizeMsgArray`).
			return this._normalizeMsgArray(patch, 'dependencies');
		}
		if (patch === undefined) {
			return Array.isArray(existingDeps) ? existingDeps : undefined;
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`'dependencies' must be string[]|string or { set, delete }`);
		}

		let base = Array.isArray(existingDeps) ? [...existingDeps] : [];
		if ('set' in patch && patch.set !== undefined) {
			base = this._normalizeMsgArray(patch.set, 'dependencies') || [];
		}
		if ('delete' in patch && patch.delete !== undefined) {
			if (!Array.isArray(patch.delete)) {
				throw new TypeError(`'dependencies.delete' must be an array`);
			}
			// Use a Set for O(1) membership checks when filtering.
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
	 * Applies partial patches to audience hints.
	 *
	 * Audience supports partial updates because callers often want to manipulate a single
	 * dimension (e.g. tags) without re-sending the whole object.
	 *
	 * @param {object|undefined} existingAudience Existing audience.
	 * @param {object|null|undefined} patch Audience patch.
	 * @returns {object|undefined} Updated audience.
	 */
	_applyAudiencePatch(existingAudience, patch) {
		if (patch === null) {
			return undefined;
		}
		if (patch === undefined) {
			return existingAudience;
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`'audience' must be an object`);
		}

		const merged = { ...(existingAudience || {}) };
		const has = key => Object.prototype.hasOwnProperty.call(patch, key);

		if (has('tags')) {
			if (patch.tags === null) {
				delete merged.tags;
			} else if (patch.tags !== undefined) {
				merged.tags = patch.tags;
			}
		}

		if (has('channels')) {
			if (patch.channels === null) {
				delete merged.channels;
			} else if (patch.channels !== undefined) {
				const channelsPatch = patch.channels;
				if (!channelsPatch || typeof channelsPatch !== 'object' || Array.isArray(channelsPatch)) {
					throw new TypeError(`'audience.channels' must be an object`);
				}
				const channels = { ...(merged.channels || {}) };
				const hasChannel = key => Object.prototype.hasOwnProperty.call(channelsPatch, key);

				if (hasChannel('include')) {
					if (channelsPatch.include === null) {
						delete channels.include;
					} else if (channelsPatch.include !== undefined) {
						channels.include = channelsPatch.include;
					}
				}
				if (hasChannel('exclude')) {
					if (channelsPatch.exclude === null) {
						delete channels.exclude;
					} else if (channelsPatch.exclude !== undefined) {
						channels.exclude = channelsPatch.exclude;
					}
				}

				if (Object.keys(channels).length === 0) {
					delete merged.channels;
				} else {
					merged.channels = channels;
				}
			}
		}

		return this._normalizeMsgAudience(merged);
	}

	/**
	 * Applies set/delete patches to progress (partial updates supported).
	 *
	 * Progress is treated as a small mutable object:
	 * - `percentage` is required and cannot be deleted
	 * - timestamps can be set or cleared
	 *
	 * @param {object|undefined} existingProgress Existing progress.
	 * @param {object|{set?: object, delete?: string[]}|null|undefined} patch Progress patch.
	 * @returns {object|undefined} Updated progress.
	 */
	_applyProgressPatch(existingProgress, patch) {
		if (patch === null) {
			// Progress is a required core object. Treat `null` as a reset of percentage (but keep first-start timestamp).
			const base = this._normalineMsgProgress(existingProgress || {});
			return this._normalineMsgProgress({
				percentage: 0,
				...(base.startedAt ? { startedAt: base.startedAt } : {}),
			});
		}
		if (patch === undefined) {
			return this._normalineMsgProgress(existingProgress || {});
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`'progress' must be an object or { set, delete }`);
		}

		let partial = patch;
		if ('set' in patch || 'delete' in patch) {
			// "Patch language" variant: { set: { ... }, delete: [ ... ] }.
			// - set merges into existing
			// - delete removes keys (except percentage)
			const setVal = patch.set;
			if (setVal !== undefined && (!setVal || typeof setVal !== 'object' || Array.isArray(setVal))) {
				throw new TypeError(`'progress.set' must be an object`);
			}
			partial = setVal || {};
		}

		const merged = { ...(existingProgress || {}) };
		Object.entries(partial).forEach(([key, val]) => {
			// Core-owned timestamps: ignore patch attempts (same principle as `timing.updatedAt`).
			if (key === 'startedAt' || key === 'finishedAt') {
				return;
			}
			if (val === null) {
				delete merged[key];
			} else {
				merged[key] = val;
			}
		});

		if ('delete' in patch && patch.delete !== undefined) {
			if (!Array.isArray(patch.delete)) {
				throw new TypeError(`'progress.delete' must be an array`);
			}
			patch.delete.forEach((key, index) => {
				const normKey = this._normalizeMsgString(key, `progress.delete[${index}]`);
				if (!normKey) {
					return;
				}
				// Core-owned timestamps: ignore patch attempts.
				if (normKey === 'startedAt' || normKey === 'finishedAt') {
					return;
				}
				if (normKey === 'percentage') {
					this.adapter?.log?.warn?.(`MsgFactory: progress.percentage cannot be deleted`);
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
	 * Actions are a list of interactive commands that a UI/consumer may present to the user.
	 * They are treated as id-addressable items to allow incremental updates.
	 *
	 * @param {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom"|"snooze", id: string, payload?: Record<string, unknown>|null, ts?: number}>|undefined} existingActions Existing actions.
	 * @param {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom"|"snooze", id: string, payload?: Record<string, unknown>|null, ts?: number}>|{set?: Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom"|"snooze", id: string, payload?: Record<string, unknown>|null, ts?: number}>|Record<string, {type: "ack"|"delete"|"close"|"open"|"link"|"custom"|"snooze", payload?: Record<string, unknown>|null, ts?: number}>, delete?: string[]}|null|undefined} patch Actions patch.
	 * @returns {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom"|"snooze", id: string, payload?: Record<string, unknown>|null, ts?: number}>|undefined} Updated actions.
	 */
	_applyActionsPatch(existingActions, patch) {
		if (patch === null) {
			return undefined;
		}
		if (Array.isArray(patch)) {
			// Full replacement.
			return this._normalizeMsgActions(patch);
		}
		if (patch === undefined) {
			return Array.isArray(existingActions) ? existingActions : undefined;
		}
		if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
			throw new TypeError(`'actions' must be an array or { set, delete }`);
		}

		let base = Array.isArray(existingActions) ? [...existingActions] : [];
		if ('set' in patch && patch.set !== undefined) {
			const setVal = patch.set;
			if (Array.isArray(setVal)) {
				// Full replacement.
				const normalized = this._normalizeMsgActions(setVal);
				base = normalized ? [...normalized] : [];
			} else if (setVal && typeof setVal === 'object' && !Array.isArray(setVal)) {
				// Id-addressed upsert: convert { [id]: partialAction } into array entries with explicit ids.
				const entries = [];
				Object.entries(setVal).forEach(([id, entry]) => {
					if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
						this.adapter?.log?.warn?.(`MsgFactory: 'actions.set.${id}' must be an object`);
						return;
					}
					entries.push({ ...entry, id });
				});
				const normalized = this._normalizeMsgActions(entries) || [];
				// Merge by id: existing actions are preserved unless overwritten by the patch.
				const byId = new Map(base.map(item => [item.id, item]));
				normalized.forEach(item => byId.set(item.id, item));
				base = Array.from(byId.values());
			} else {
				throw new TypeError(`'actions.set' must be an array or object`);
			}
		}
		if ('delete' in patch && patch.delete !== undefined) {
			if (!Array.isArray(patch.delete)) {
				throw new TypeError(`'actions.delete' must be an array`);
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
	 * An action always needs:
	 * - `id`: stable identifier used for updates/deletes (auto-generated when omitted)
	 * - `type`: validated against msgConstants.actions.type
	 *
	 * Optional:
	 * - `payload`: arbitrary object for consumers (or `null` to explicitly clear)
	 * - `ts`: positive integer timestamp (Unix ms preferred)
	 *
	 * @param {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom"|"snooze", id: string, payload?: Record<string, unknown>|null, ts?: number}>|undefined|null} value Actions input.
	 * @returns {Array<{type: "ack"|"delete"|"close"|"open"|"link"|"custom"|"snooze", id: string, payload?: Record<string, unknown>|null, ts?: number}>|undefined} Normalized actions.
	 */
	_normalizeMsgActions(value) {
		if (value === undefined || value === null) {
			return undefined;
		}
		if (!Array.isArray(value)) {
			throw new TypeError(`'actions' must be an array`);
		}

		const actions = [];
		const usedIds = new Set();
		let autoSeq = 0;
		const nextAutoId = () => {
			// Cheap, predictable ids as requested (action_0..action_n).
			// Ensure uniqueness even when some ids are already present.
			while (usedIds.has(`action_${autoSeq}`)) {
				autoSeq += 1;
			}
			const id = `action_${autoSeq}`;
			autoSeq += 1;
			return id;
		};

		value.forEach((entry, index) => {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				this.adapter?.log?.warn?.(`MsgFactory: 'actions[${index}]' must be an object`);
				return;
			}
			if (entry.type === undefined || entry.type === null) {
				this.adapter?.log?.warn?.(`MsgFactory: 'actions[${index}].type' is required`);
				return;
			}

			const type = this._normalizeMsgEnum(entry.type, this.actionsTypeValueSet, `actions[${index}].type`);
			if (type === undefined) {
				return;
			}

			// action.id is required, but we auto-generate it when omitted to keep the model consistent
			// and to avoid forcing producers to create ids for simple, ephemeral actions.
			let actionId = undefined;
			if (Object.prototype.hasOwnProperty.call(entry, 'id')) {
				actionId = this._normalizeMsgString(entry.id, `actions[${index}].id`);
			}
			if (actionId === undefined) {
				actionId = nextAutoId();
				this.adapter?.log?.warn?.(`MsgFactory: 'actions[${index}].id' missing, auto-generated '${actionId}'`);
			}
			if (usedIds.has(actionId)) {
				this.adapter?.log?.warn?.(`MsgFactory: duplicate action id '${actionId}', dropping entry`);
				return;
			}
			usedIds.add(actionId);

			const action = { type, id: actionId };

			if ('payload' in entry) {
				if (entry.payload === null) {
					action.payload = null;
				} else if (entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)) {
					action.payload = entry.payload;
				} else if (entry.payload !== undefined) {
					this.adapter?.log?.warn?.(`MsgFactory: 'actions[${index}].payload' must be an object or null`);
				}
			}

			actions.push(action);
		});

		return actions.length > 0 ? actions : undefined;
	}

	/**
	 * Normalizes progress fields including percentage and timestamps.
	 *
	 * Progress is modeled as:
	 * - `percentage` (0..100) for a simple UI progress indicator
	 * - `startedAt`/`finishedAt` for coarse lifecycle timestamps
	 *
	 * Any additional progress metadata should be added as optional fields and should be normalized here as well.
	 *
	 * @param {object} value Progress input with percentage/startedAt/finishedAt.
	 * @returns {object} Normalized progress object.
	 */
	_normalineMsgProgress(value) {
		if (!value || typeof value !== 'object') {
			throw new TypeError(`'progress' must be an object`);
		}

		let percentage = 0;
		if (Object.prototype.hasOwnProperty.call(value, 'percentage')) {
			const norm = this._normalizeMsgNumber(value.percentage, 'progress.percentage');
			if (typeof norm === 'number') {
				percentage = norm;
			}
		}

		const progress = {
			// `percentage` is the only mandatory progress field in MsgHub.
			// - It defaults to 0 (not started).
			percentage,
			startedAt: value.startedAt ? this._normalizeMsgTime(value.startedAt, 'progress.startedAt') : undefined,
			finishedAt: value.finishedAt ? this._normalizeMsgTime(value.finishedAt, 'progress.finishedAt') : undefined,
		};

		// Core-owned timestamps:
		// - startedAt is set on first start and never cleared/updated afterwards.
		// - finishedAt is set when percentage == 100 and removed when percentage < 100.
		if (progress.percentage > 0 && !Number.isFinite(progress.startedAt)) {
			progress.startedAt = Date.now();
		}
		if (progress.percentage < 100) {
			delete progress.finishedAt;
		} else if (progress.percentage === 100 && !Number.isFinite(progress.finishedAt)) {
			progress.finishedAt = Date.now();
		}

		return this._removeUndefinedKeys(progress);
	}

	// ======================================
	//       generic Helpers
	// ======================================

	/**
	 * Removes keys with undefined values from an object.
	 *
	 * This is a shallow cleanup utility: nested objects are not traversed.
	 * It is used as the final step of message creation/patching because `undefined`
	 * does not serialize in JSON and should not be persisted.
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
	 * This is a pragmatic validation step to catch common mistakes early (seconds vs ms).
	 * The default range can be overridden for special use-cases.
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
	 * This intentionally excludes:
	 * - Arrays
	 * - Class instances
	 * - Objects with custom prototypes
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
	 * Used to enforce immutability of `origin` in `applyPatch`.
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
