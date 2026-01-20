'use strict';

const { createFallbackPreset, fallbackPresetId } = require('./constants');

/**
 * Central message rendering/writing helper for rule instances.
 *
 * This is intentionally rule-agnostic: rules provide their live data and the writer
 * is responsible for preset lookup, mapping to MsgFactory/MsgStore semantics and applying store patches.
 *
 * (Implementation is added step-by-step; this file currently provides a skeleton.)
 */
class MessageWriter {
	/**
	 * @param {object} ctx Plugin runtime context.
	 * @param {object} [options] Plugin options.
	 */
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		this.options = options || {};
		this._traceEvents =
			ctx?.meta?.options?.resolveBool?.('traceEvents', this.options.traceEvents) === true ||
			this.options.traceEvents === true;
		this._presetProvider =
			this.options?.presetProvider && typeof this.options.presetProvider.getPreset === 'function'
				? this.options.presetProvider
				: null;
		this._locationProvider =
			this.options?.locationProvider && typeof this.options.locationProvider.getLocation === 'function'
				? this.options.locationProvider
				: null;
	}

	/**
	 * Create a per-target writer instance.
	 *
	 * @param {object} info Target context.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {string} info.presetKey Key of specific Message-Preset to be used.
	 * @param {string} info.presetId ID of specific Message-Preset to be used.
	 * @returns {TargetMessageWriter} Target writer.
	 */
	forTarget({ targetId, presetKey, presetId }) {
		return new TargetMessageWriter(this.ctx, {
			targetId,
			presetKey,
			presetId,
			locationProvider: this._locationProvider,
			presetProvider: this._presetProvider,
			traceEvents: this._traceEvents,
		});
	}
}

/**
 * Per-target message writer helper.
 *
 * Note: one `TargetMessageWriter` instance is meant to represent one logical "message line"
 * (i.e. stable `ref`) for a single target + presetKey combination.
 */
class TargetMessageWriter {
	/**
	 * @param {object} ctx Plugin runtime context.
	 * @param {object} info Target inputs.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {string} info.presetKey Key of specific Message-Preset to be used.
	 * @param {string} info.presetId ID of specific Message-Preset to be used.
	 * @param {object|null} info.locationProvider Location provider (`getLocation(id)`).
	 * @param {object|null} info.presetProvider Preset provider (`getPreset(presetId)`).
	 * @param {boolean} [info.traceEvents] Enable verbose debug logging.
	 */
	constructor(
		ctx,
		{ targetId, presetKey, presetId, locationProvider = null, presetProvider = null, traceEvents = false },
	) {
		this.ctx = ctx;
		this.targetId = targetId;
		this._presetKey = presetKey;
		this.presetId = typeof presetId === 'string' ? presetId.trim() : '';
		this._locationProvider =
			locationProvider && typeof locationProvider.getLocation === 'function' ? locationProvider : null;
		this._presetProvider = presetProvider && typeof presetProvider.getPreset === 'function' ? presetProvider : null;
		this._traceEvents = traceEvents === true;
		this._log = ctx?.api?.log || null;
		this._lastMetricsPatchAt = 0;
	}

	/**
	 * Resolve the preset for this message (best-effort).
	 *
	 * @returns {any|null} Preset JSON object or null.
	 */
	_getPreset() {
		// Internal fallback: used when a rule is misconfigured or a preset is missing.
		// This is intentionally NOT a real preset state and should never be user-editable.
		if (this.presetId === fallbackPresetId) {
			return createFallbackPreset({ targetId: this.targetId });
		}

		if (!this._presetProvider || !this.presetId) {
			return null;
		}
		return this._presetProvider.getPreset(this.presetId);
	}

	/**
	 * Resolve this writer's location (room name) for templating/details (best-effort).
	 *
	 * @returns {string|null} Room name or null when unknown.
	 */
	_getLocation() {
		// Location is best-effort and may be unavailable early during startup (cache priming is async).
		if (!this._locationProvider || !this.targetId) {
			return null;
		}
		const loc = this._locationProvider.getLocation(this.targetId);
		return typeof loc === 'string' && loc.trim() ? loc : null;
	}

	/**
	 * @param {string} msg Debug message.
	 * @returns {void}
	 */
	_trace(msg) {
		if (!this._traceEvents || typeof this._log?.debug !== 'function') {
			return;
		}
		this._log.debug(`MessageWriter: ${msg}`);
	}

	/**
	 * @param {string} op Operation name.
	 * @param {string} ref Message ref.
	 * @param {object} [patch] Patch object.
	 * @returns {void}
	 */
	_traceStore(op, ref, patch = undefined) {
		if (!this._traceEvents || typeof this._log?.debug !== 'function') {
			return;
		}
		const keys =
			patch && typeof patch === 'object' && !Array.isArray(patch)
				? Object.keys(patch).slice(0, 12).join(',')
				: '';
		const keySuffix = keys ? ` keys=[${keys}]` : '';
		this._trace(`${op} ref='${ref}'${keySuffix}`);
	}

	/**
	 * @param {unknown} value Candidate value.
	 * @returns {boolean} True when `value` is a plain object.
	 */
	_isPlainObject(value) {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	/**
	 * Deep-equality helper for "developer objects" used in patches.
	 *
	 * Used for:
	 * - `details` (plain object)
	 * - `actions` (array of objects)
	 *
	 * Explicitly not used for `metrics`, because those are represented as `Map` in stored messages.
	 *
	 * @param {any} a Left value.
	 * @param {any} b Right value.
	 * @returns {boolean} Deep equality for arrays + plain objects.
	 */
	_isEqual(a, b) {
		if (Object.is(a, b)) {
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
			for (const k of aKeys) {
				if (!Object.prototype.hasOwnProperty.call(b, k) || !this._isEqual(a[k], b[k])) {
					return false;
				}
			}
			return true;
		}
		return false;
	}

	/**
	 * Normalize a metrics "set" record into a store patch.
	 *
	 * This does not compare against existing metrics; it only normalizes the input shape.
	 * To drop unchanged metrics, use `_buildMetricsPatch(...)`.
	 *
	 * @param {unknown} set Metrics set record: `{ key: { val, unit? } }`.
	 * @param {number} now Timestamp in ms.
	 * @returns {{ set: Record<string, {val: any, unit: string, ts: number}> }|null} Metrics patch or null when empty/invalid.
	 */
	_metricsPatchFromSet(set, now) {
		if (!set || typeof set !== 'object' || Array.isArray(set)) {
			return null;
		}

		const nextSet = Object.create(null);
		for (const [key, value] of Object.entries(set)) {
			if (typeof key !== 'string' || !key.trim()) {
				continue;
			}
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				continue;
			}
			nextSet[key] = {
				val: value.val,
				unit: typeof value.unit === 'string' ? value.unit : '',
				ts: now,
			};
		}

		return Object.keys(nextSet).length ? { set: nextSet } : null;
	}

	/**
	 * Build a metrics patch by normalizing `set` + removing unchanged entries.
	 *
	 * Notes:
	 * - This works with the MsgStore contract: stored metrics are a `Map`, patch payload is `{ metrics: { set, delete } }`.
	 * - When `deleteKeys` is omitted/empty, this behaves like a pure "set" upsert.
	 * - Returns `null` when there is nothing to change (no-op).
	 *
	 * @param {object} info Inputs.
	 * @param {Map<string, any>|unknown} info.existingMetrics Existing metrics Map (may be missing/invalid).
	 * @param {unknown} info.set Metrics set record.
	 * @param {unknown} [info.deleteKeys] Metric keys to delete.
	 * @param {number} info.now Timestamp in ms.
	 * @returns {{set?: Record<string, {val: any, unit: string, ts: number}>, delete?: string[]}|null} Patch or null when empty.
	 */
	_buildMetricsPatch({ existingMetrics, set, deleteKeys = undefined, now }) {
		const existing = existingMetrics instanceof Map ? existingMetrics : new Map();

		let patch = this._metricsPatchFromSet(set, now);
		if (patch?.set && existing.size) {
			for (const [key, next] of Object.entries(patch.set)) {
				const prev = existing.get(key);
				const prevVal = prev?.val;
				const prevUnit = typeof prev?.unit === 'string' ? prev.unit : '';
				if (prevVal === next?.val && prevUnit === next?.unit) {
					delete patch.set[key];
				}
			}
			if (Object.keys(patch.set).length === 0) {
				patch = null;
			}
		}

		const deleteList = Array.isArray(deleteKeys) ? deleteKeys.filter(k => typeof k === 'string' && k.trim()) : [];
		const hasSet = !!(patch?.set && Object.keys(patch.set).length);
		const hasDelete = deleteList.length > 0;
		if (!hasSet && !hasDelete) {
			return null;
		}
		const setPatch = hasSet && patch ? patch.set : undefined;
		return {
			...(setPatch ? { set: setPatch } : {}),
			...(hasDelete ? { delete: deleteList } : {}),
		};
	}

	/**
	 * Normalize a metrics "set" record into a Map suitable for `MsgFactory.createMessage({ metrics })`.
	 *
	 * @param {unknown} set Metrics set record: `{ key: { val, unit? } }`.
	 * @param {number} now Timestamp in ms.
	 * @returns {Map<string, {val: any, unit: string, ts: number}>|undefined} Metrics Map, or undefined when empty/invalid.
	 */
	_metricsMapFromSet(set, now) {
		const patch = this._metricsPatchFromSet(set, now);
		if (!patch) {
			return undefined;
		}
		return new Map(Object.entries(patch.set));
	}

	/**
	 * @returns {string} Actor label for `lifecycle.stateChangedBy`.
	 */
	_actor() {
		return this.ctx?.meta?.plugin?.regId || 'IngestStates';
	}

	/**
	 * Convert escaped newline sequences (`\\n`, `\\r\\n`) into real newlines.
	 *
	 * Note: `\\\\n` can be used to keep a literal `\\n` in the output.
	 *
	 * @param {string|undefined} text Input string.
	 * @returns {string|undefined} Output string.
	 */
	_unescapeNewlines(text) {
		if (typeof text !== 'string' || text.indexOf('\\') === -1) {
			return text;
		}

		const placeholder = '\u0000MSGHUB_LITERAL_NL\u0000';
		return text
			.replaceAll('\\\\n', placeholder)
			.replaceAll('\\r\\n', '\n')
			.replaceAll('\\n', '\n')
			.replaceAll(placeholder, '\\n');
	}

	/**
	 * @returns {string} Best-effort stable ref component for this writer.
	 */
	_makeref() {
		const key =
			typeof this._presetKey === 'string' && this._presetKey.trim() ? this._presetKey.trim() : this.presetId;
		return `${this.targetId}.${key}`;
	}

	/**
	 * Best-effort translation helper for preset strings.
	 *
	 * If the input looks like an i18n key (`msghub.i18n.*`) and `ctx.api.i18n.t` is available,
	 * the translated string is returned. Otherwise the raw input is returned unchanged.
	 *
	 * @param {any} string Candidate input value.
	 * @returns {string} Translated (when applicable) or raw string.
	 */
	_maybeT(string) {
		const raw = typeof string === 'string' ? string : '';
		if (!raw) {
			return '';
		}

		const s = raw.trim();
		if (s.startsWith('msghub.i18n.')) {
			const t = this.ctx?.api?.i18n?.t;
			if (typeof t === 'function') {
				const out = t(s);
				return typeof out === 'string' ? out : String(out ?? '');
			}
		}

		return raw;
	}

	/**
	 * Upsert the message (create when missing, otherwise patch).
	 *
	 * Patch semantics (by design):
	 * - does NOT patch: `audience`, `timing.dueAt`, `timing.timeBidget`, since these might have been edited by the user.
	 * - does NOT patch: `lifecycle`, `timing.notifyAt`, `timing.startAt`, since these might have been changed by core policies.
	 * - does patch (when changed): `title`, `text`, `level`, `timing.remindEvery`, `timing.cooldown`, `details`, `actions`, `metrics`
	 *
	 * `actions` / `metrics` are only considered when they are provided by the caller (undefined => "leave unchanged").
	 *
	 * @param {string} ref Stable message ref.
	 * @param {object} [info] Inputs.
	 * @param {number} [info.now] Timestamp in ms (defaults to Date.now()).
	 * @param {number} [info.startAt] Optional domain timestamp forwarded to `timing.startAt` on create.
	 * @param {number} [info.notifyAt] Override `timing.notifyAt` (defaults to `now`).
	 * @param {Record<string, {val: any, unit?: string}>} [info.metrics] Initial metrics to set (ts is set to `now`).
	 * @param {Array<object>} [info.actions] Message actions (`message.actions[]`).
	 * @returns {boolean} True when a message exists/was updated.
	 */
	onUpsert(
		ref,
		{ now = Date.now(), startAt = undefined, notifyAt = undefined, metrics = undefined, actions = undefined } = {},
	) {
		// 1) Resolve preset and validate the minimal contract we need to create/update a message.
		const preset = this._getPreset();
		const existing = this.ctx.api.store.getMessageByRef(ref, 'quasiOpen');

		const title = this._maybeT(this._unescapeNewlines(preset.message?.title));
		const text = this._maybeT(this._unescapeNewlines(preset.message?.text));
		if (!title || !text) {
			throw new Error(`IngestStates: missing title/text for '${ref}'`);
		}

		const kind = preset.message?.kind;
		const level = preset.message?.level;
		if (!kind || !level) {
			throw new Error(`IngestStates: missing kind/level for '${ref}'`);
		}

		// 2) Build invariant core fields and one-time derived values.
		const sysString = this.targetId.split('.').slice(0, 2).join('.') || 'IngestStates';
		const origin = { type: this.ctx.api.constants.origin.type.automation, system: sysString, id: this.targetId };

		const lifecycle = {
			state: this.ctx.api.constants.lifecycle.state.open,
			stateChangedBy: this._actor(),
		};

		// 3) Timing: notifyAt/startAt are chosen by the rule event and intentionally NOT patched later.
		const nextNotifyAt = typeof notifyAt === 'number' && Number.isFinite(notifyAt) ? Math.trunc(notifyAt) : now;
		const startAtsafe = typeof startAt === 'number' && Number.isFinite(startAt) ? Math.trunc(startAt) : now;
		const remindEvery = preset.message?.timing?.remindEvery;
		const cooldown = preset.message?.timing?.cooldown;
		const timeBudget = preset.message?.timing?.timeBudget;
		const dueInMs = preset.message?.timing?.dueInMs;
		const timing = {
			notifyAt: nextNotifyAt,
			startAt: startAtsafe,
			remindEvery: remindEvery > 0 ? remindEvery : undefined,
			cooldown: cooldown > 0 ? cooldown : undefined,
			timeBudget:
				typeof timeBudget === 'number' && Number.isFinite(timeBudget) && timeBudget > 0
					? timeBudget
					: undefined,
			dueAt:
				typeof dueInMs === 'number' && Number.isFinite(dueInMs) && dueInMs > 0
					? startAtsafe + dueInMs
					: undefined,
		};

		const audience = preset.message?.audience;

		// 4) Optional blocks from the rule event (actions/metrics) and the preset (details/actions).
		const ruleActions = Array.isArray(actions) ? actions : [];
		const presetActions = Array.isArray(preset.message?.actions) ? preset.message.actions : [];
		const nextActions = ruleActions.length || presetActions.length ? [...ruleActions, ...presetActions] : undefined;
		const initialMetrics = this._metricsMapFromSet(metrics, now);

		const presetDetails = preset.message?.details;
		const loc = this._getLocation();
		const mergedDetails = {
			...(presetDetails && typeof presetDetails === 'object' && !Array.isArray(presetDetails)
				? presetDetails
				: {}),
			...(loc ? { location: loc } : {}),
		};
		const details = Object.keys(mergedDetails).length ? mergedDetails : null;

		if (!existing) {
			// Create path: use MsgFactory to validate and normalize the initial message payload.
			const created = this.ctx.api.factory.createMessage({
				ref,
				kind,
				level,
				title,
				text,
				origin,
				audience,
				...(details ? { details: details } : {}),
				...(initialMetrics ? { metrics: initialMetrics } : {}),
				...(nextActions !== undefined ? { actions: nextActions } : {}),
				lifecycle,
				timing,
			});
			if (!created) {
				return false;
			}
			this._traceStore('addMessage(openActive.create)', ref, created);

			return this.ctx.api.store.addMessage(created);
		}

		// Patch path: keep it minimal and only include fields that actually changed.
		const patch = {};

		if (existing.title !== title) {
			patch.title = title;
		}
		if (existing.text !== text) {
			patch.text = text;
		}
		if (existing.level !== level) {
			patch.level = level;
		}

		// Timing patching is limited to the preset-driven "policy" timers.
		// notifyAt/startAt are intentionally excluded (rule-controlled).
		const timingPatch = {};
		const existingRemindEvery =
			typeof existing?.timing?.remindEvery === 'number' && Number.isFinite(existing.timing.remindEvery)
				? existing.timing.remindEvery
				: null;
		const existingCooldown =
			typeof existing?.timing?.cooldown === 'number' && Number.isFinite(existing.timing.cooldown)
				? existing.timing.cooldown
				: null;
		const nextRemindEvery =
			typeof remindEvery === 'number' && Number.isFinite(remindEvery) && remindEvery > 0 ? remindEvery : null;
		const nextCooldown =
			typeof cooldown === 'number' && Number.isFinite(cooldown) && cooldown > 0 ? cooldown : null;

		if (existingRemindEvery !== nextRemindEvery) {
			timingPatch.remindEvery = nextRemindEvery;
		}
		if (existingCooldown !== nextCooldown) {
			timingPatch.cooldown = nextCooldown;
		}
		if (Object.keys(timingPatch).length) {
			patch.timing = timingPatch;
		}

		// Details are a plain object; avoid patching when there is no semantic change.
		const existingDetails = this._isPlainObject(existing?.details) ? existing.details : undefined;
		const nextDetails = details && this._isPlainObject(details) ? details : null;
		if (!this._isEqual(existingDetails, nextDetails === null ? undefined : nextDetails)) {
			patch.details = nextDetails;
		}

		// Actions are optional: patch them when the rule provided an explicit list OR the preset defines actions.
		if (actions !== undefined || presetActions.length) {
			const existingActions = Array.isArray(existing?.actions) ? existing.actions : undefined;
			if (!this._isEqual(existingActions, nextActions)) {
				patch.actions = nextActions || [];
			}
		}

		// Metrics are optional: only patch them when the rule provided a metrics set.
		if (metrics !== undefined) {
			const metricsPatch = this._buildMetricsPatch({
				existingMetrics: existing?.metrics,
				set: metrics,
				now,
			});
			if (metricsPatch) {
				patch.metrics = metricsPatch;
			}
		}

		if (Object.keys(patch).length) {
			this._traceStore('updateMessage(openActive.active)', ref, patch);
			return this.ctx.api.store.updateMessage(ref, patch);
		}

		return false;
	}

	/**
	 * Close the message when the rule returns to normal (best-effort).
	 *
	 * Behavior:
	 * - when `preset.policy.resetOnNormal === false`:
	 *   - keep the message open
	 *   - ensure a manual `close` action exists (so the user can dismiss it)
	 *   - prevent re-notifications by clearing `timing.remindEvery` and pushing `timing.notifyAt` far into the future
	 * - otherwise:
	 *   - close via `completeAfterCauseEliminated(...)`
	 *
	 * @param {string} ref Stable message ref.
	 * @returns {boolean} True when a close was triggered.
	 */
	onClose(ref) {
		const existing = this.ctx.api.store.getMessageByRef(ref, 'all');
		if (!existing) {
			return false;
		}

		const preset = this._getPreset();
		if (preset?.policy?.resetOnNormal === false) {
			// "No auto-close": keep the message visible but make it user-dismissable.
			const closeType = this.ctx.api.constants.actions.type.close;
			const hasClose = Array.isArray(existing.actions) && existing.actions.some(a => a?.type === closeType);
			if (hasClose) {
				return true;
			}

			const nextActions = Array.isArray(existing.actions) ? existing.actions.slice() : [];
			nextActions.push({ id: 'close', type: closeType });

			const timingPatch = {};
			if (!Number.isFinite(existing?.timing?.notifyAt)) {
				// If notifyAt is missing, make sure it does not immediately become "due" again.
				timingPatch.notifyAt = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
			}
			if (Number.isFinite(existing?.timing?.remindEvery)) {
				timingPatch.remindEvery = null;
			}

			const patch = {
				actions: nextActions,
				...(Object.keys(timingPatch).length ? { timing: timingPatch } : {}),
			};

			this._traceStore('updateMessage(closeOnNormal.addCloseAction)', ref, patch);
			return this.ctx.api.store.updateMessage(ref, patch);
		}

		const actor = this._actor();
		this._traceStore('completeAfterCauseEliminated(closeOnNormal)', ref);
		return this.ctx.api.store.completeAfterCauseEliminated(ref, { actor });
	}

	/**
	 * Patch message metrics with change detection + throttling.
	 *
	 * Notes:
	 * - Throttling is in-memory (restart resets the timer).
	 * - Metrics patches are "silent" by design: the factory does not bump `timing.updatedAt` when only metrics change.
	 *
	 * @param {string} ref Stable message ref.
	 * @param {object} [root0] Metrics patch inputs.
	 * @param {Record<string, {val: number|string|boolean|null, unit?: string, ts?: number}>} [root0.set] Metrics to set/update.
	 * @param {string[]} [root0.delete] Metric keys to delete.
	 * @param {number} [root0.now] Timestamp in ms (defaults to Date.now()).
	 * @param {boolean} [root0.force] When true, bypass in-memory throttling.
	 * @returns {boolean} True when a patch was applied.
	 */
	onMetrics(ref, { set = {}, delete: deleteKeys = [], now = Date.now(), force = false } = {}) {
		// Guard against overly chatty rules: metrics are high frequency, but store updates are not.
		const maxIntervalMs = this.ctx.meta.options.resolveInt('metricsMaxIntervalMs', 60000);
		if (!Number.isFinite(maxIntervalMs) || maxIntervalMs <= 0) {
			return false;
		}

		const intervalMs = Math.min(Math.max(Math.trunc(maxIntervalMs), 5000), 1000 * 60 * 60 * 3);
		if (!force && this._lastMetricsPatchAt && now - this._lastMetricsPatchAt < intervalMs) {
			return false;
		}

		// Only patch quasi-open messages; metrics are irrelevant for closed/expired entries.
		const existing = this.ctx.api.store.getMessageByRef(ref, 'quasiOpen');
		if (!existing) {
			return false;
		}

		// Build a minimal patch (drop unchanged values + normalize delete list).
		const metricsPatch = this._buildMetricsPatch({
			existingMetrics: existing?.metrics,
			set,
			deleteKeys,
			now,
		});
		if (!metricsPatch) {
			return false;
		}

		const patch = { metrics: metricsPatch };
		this._traceStore('updateMessage(patchMetrics)', ref, patch);
		const ok = this.ctx.api.store.updateMessage(ref, patch);
		if (ok) {
			this._lastMetricsPatchAt = now;
		}
		return ok;
	}

	/**
	 * @returns {void}
	 */
	dispose() {}
}

module.exports = { MessageWriter, TargetMessageWriter };
