'use strict';

/**
 * Central message rendering/writing helper for rule instances.
 *
 * This is intentionally rule-agnostic: rules provide their live data and the writer
 * is responsible for standard texts, timing mappings, and store patches.
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
	}

	/**
	 * Create a per-target writer instance.
	 *
	 * @param {object} info Target context.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {string} info.ruleType Rule type / mode (e.g. `freshness`).
	 * @param {object} [info.messageConfig] Message config (`msg.*`).
	 * @param {object} [info.startMessageConfig] Optional session start message config (`msg.sessionStart*`).
	 * @returns {TargetMessageWriter} Target writer.
	 */
	forTarget({ targetId, ruleType, messageConfig = {}, startMessageConfig = null }) {
		return new TargetMessageWriter(this.ctx, {
			targetId,
			ruleType,
			messageConfig,
			startMessageConfig,
		});
	}
}

/**
 * Per-target message writer helper.
 */
class TargetMessageWriter {
	/**
	 * @param {object} ctx Plugin runtime context.
	 * @param {object} info Target inputs.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {string} info.ruleType Rule type / mode (e.g. `freshness`).
	 * @param {object} [info.messageConfig] Message config (`msg.*`).
	 * @param {object} [info.startMessageConfig] Optional session start message config (`msg.sessionStart*`).
	 */
	constructor(ctx, { targetId, ruleType, messageConfig, startMessageConfig }) {
		this.ctx = ctx;
		this.targetId = targetId;
		this.ruleType = ruleType;
		this.messageConfig = messageConfig || {};
		this.startMessageConfig = startMessageConfig || null;
		this._pendingResetHandle = null;
		this._lastMetricsPatchAt = 0;
		this._lastStartMetricsPatchAt = 0;
	}

	/**
	 * @param {string} state Lifecycle state.
	 * @returns {boolean} True when this state is considered "active" (non-terminal).
	 */
	_isLifecycleActive(state) {
		return (
			state !== this.ctx.api.constants.lifecycle.state.closed &&
			state !== this.ctx.api.constants.lifecycle.state.expired &&
			state !== this.ctx.api.constants.lifecycle.state.deleted
		);
	}

	/**
	 * Normalize rule-provided actions and inject a `close` action when auto-close is disabled.
	 *
	 * @param {Array<object>|undefined} actions Rule-provided actions.
	 * @param {Array<object>|undefined} existingActions Existing message actions (used when `actions` is undefined).
	 * @returns {Array<object>|undefined} Normalized actions array.
	 */
	_normalizeActions(actions, existingActions) {
		const nextActions = actions !== undefined ? actions : existingActions;
		if (this.messageConfig?.resetOnNormal !== false) {
			return nextActions;
		}

		const list = Array.isArray(nextActions) ? nextActions.slice() : [];
		const closeType = this.ctx.api.constants.actions.type.close;
		const hasClose = list.some(a => a?.type === closeType);
		if (!hasClose) {
			list.push({ id: 'close', type: closeType });
		}
		return list;
	}

	/**
	 * @returns {boolean} True when session start message is enabled.
	 */
	isSessionStartEnabled() {
		return this.messageConfig?.sessionStartEnabled === true;
	}

	/**
	 * @returns {string} Internal metrics key for persisting delayed-close scheduling.
	 */
	_resetAtMetricKey() {
		return `IngestStates.${this.ctx.meta.plugin.instanceId}.${this.ruleType}.${this.targetId}.resetAt`;
	}

	/**
	 * @param {unknown} value CSV string.
	 * @returns {string[]} Unique, trimmed list.
	 */
	_parseCsvList(value) {
		if (typeof value !== 'string') {
			return [];
		}

		const items = value
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);

		return Array.from(new Set(items));
	}

	/**
	 * @param {object} info Audience inputs.
	 * @param {string} [info.tagsCsv] Comma-separated tag list.
	 * @param {string} [info.channelsCsv] Comma-separated channel list.
	 * @returns {object|undefined} Normalized `message.audience` object.
	 */
	_buildAudience({ tagsCsv, channelsCsv }) {
		const tags = this._parseCsvList(tagsCsv);
		const channels = this._parseCsvList(channelsCsv);

		if (tags.length === 0 && channels.length === 0) {
			return undefined;
		}

		const audience = {};
		if (tags.length) {
			audience.tags = tags;
		}
		if (channels.length) {
			audience.channels = { include: channels };
		}
		return audience;
	}

	/**
	 * @param {string} [suffix] Optional suffix (e.g. `_start`).
	 * @returns {string} Stable message ref.
	 */
	makeRef(suffix = '') {
		const { instanceId } = this.ctx.meta.plugin;
		return `IngestStates.${instanceId}.${this.ruleType}.${this.targetId}${suffix}`;
	}

	/**
	 * @returns {object|undefined} Normalized message audience.
	 */
	getAudience() {
		return this._buildAudience({
			tagsCsv: this.messageConfig?.audienceTags,
			channelsCsv: this.messageConfig?.audienceChannels,
		});
	}

	/**
	 * @returns {object|undefined} Normalized session start message audience.
	 */
	getStartAudience() {
		const cfg = this.startMessageConfig || this.messageConfig;
		return this._buildAudience({
			tagsCsv: cfg?.sessionStartAudienceTags,
			channelsCsv: cfg?.sessionStartAudienceChannels,
		});
	}

	/**
	 * @param {string} valueKey E.g. `remindValue`.
	 * @param {string} unitKey E.g. `remindUnit`.
	 * @returns {number} Duration in ms (0 when disabled/invalid).
	 */
	_getDurationMs(valueKey, unitKey) {
		const value = this.messageConfig?.[valueKey];
		const unitSeconds = this.messageConfig?.[unitKey];

		if (
			typeof value !== 'number' ||
			!Number.isFinite(value) ||
			value <= 0 ||
			typeof unitSeconds !== 'number' ||
			!Number.isFinite(unitSeconds) ||
			unitSeconds <= 0
		) {
			return 0;
		}

		return Math.trunc(value * unitSeconds * 1000);
	}

	/**
	 * @param {number} [now] Current timestamp in ms.
	 * @returns {number} A timestamp far enough in the future to avoid "due now" behavior.
	 */
	_farFutureNotifyAt(now = Date.now()) {
		return now + 10 * 365 * 24 * 60 * 60 * 1000;
	}

	/**
	 * @returns {string} Actor label for `lifecycle.stateChangedBy`.
	 */
	_actor() {
		return this.ctx?.meta?.plugin?.regId || 'IngestStates';
	}

	/**
	 * Cancel a pending delayed-close timer (in-memory only).
	 *
	 * Note: the delayed-close schedule itself is persisted via `metrics` so restarts are restart-safe.
	 *
	 * @returns {void}
	 */
	_cancelPendingReset() {
		if (!this._pendingResetHandle) {
			return;
		}
		this.ctx.meta.resources.clearTimeout(this._pendingResetHandle);
		this._pendingResetHandle = null;
	}

	/**
	 * Clear any persisted delayed-close schedule for this message.
	 *
	 * @param {string} ref Message ref.
	 * @returns {void}
	 */
	_clearScheduledReset(ref) {
		const key = this._resetAtMetricKey();
		try {
			this.ctx.api.store.updateMessage(ref, { metrics: { delete: [key] } });
		} catch {
			// ignore
		}
	}

	/**
	 * Resolve title/text for a message, preferring explicit config over rule defaults.
	 *
	 * @param {object} info Message inputs.
	 * @param {object} [info.config] Message config (e.g. `msg.*`).
	 * @param {string} [info.defaultTitle] Rule-provided default title.
	 * @param {string} [info.defaultText] Rule-provided default text.
	 * @returns {{ title: string|undefined, text: string|undefined }} Resolved content.
	 */
	resolveTitleText({ config = this.messageConfig, defaultTitle, defaultText }) {
		const title = typeof config?.title === 'string' && config.title.trim() ? config.title.trim() : defaultTitle;
		const text = typeof config?.text === 'string' && config.text.trim() ? config.text.trim() : defaultText;

		return {
			title: typeof title === 'string' && title.trim() ? title.trim() : undefined,
			text: typeof text === 'string' && text.trim() ? text.trim() : undefined,
		};
	}

	/**
	 * Ensure the message is open/active. Applies cooldown semantics:
	 * when reopened shortly after a close, suppress notifications but keep the store truthful.
	 *
	 * @param {object} [info] Message inputs.
	 * @param {string} [info.defaultTitle] Rule-provided default title when config is empty.
	 * @param {string} [info.defaultText] Rule-provided default text when config is empty.
	 * @param {number} [info.now] Timestamp in ms (defaults to Date.now()).
	 * @param {number} [info.notifyAt] Override `timing.notifyAt` (defaults to `now`).
	 * @param {object} [info.details] Message details payload.
	 * @param {Array<object>} [info.actions] Message actions (`message.actions[]`).
	 * @returns {boolean} True when a message exists/was updated.
	 */
	openActive({
		defaultTitle,
		defaultText,
		now = Date.now(),
		notifyAt = undefined,
		details = undefined,
		actions = undefined,
	} = {}) {
		this._cancelPendingReset();

		const ref = this.makeRef();
		this._clearScheduledReset(ref);
		const existing = this.ctx.api.store.getMessageByRef(ref);

		// "Active" means: the message exists and is not in a terminal/non-active lifecycle state.
		// This intentionally treats `acked` and `snoozed` as active (do not override user intent).
		const state = existing?.lifecycle?.state || this.ctx.api.constants.lifecycle.state.open;
		const isActive = this._isLifecycleActive(state);
		if (existing && isActive) {
			if (this.messageConfig?.resetOnNormal === false) {
				const closeType = this.ctx.api.constants.actions.type.close;
				const hasClose = Array.isArray(existing.actions) && existing.actions.some(a => a?.type === closeType);
				if (!hasClose) {
					const patchedActions = this._normalizeActions(undefined, existing.actions);
					this.ctx.api.store.updateMessage(ref, { actions: patchedActions });
				}
			}
			return true;
		}

		const { title, text } = this.resolveTitleText({ defaultTitle, defaultText });
		if (!title || !text) {
			throw new Error(`IngestStates: missing title/text defaults for '${ref}'`);
		}

		const kind = this.messageConfig?.kind || this.ctx.api.constants.kind.status;
		const level =
			typeof this.messageConfig?.level === 'number'
				? this.messageConfig.level
				: this.ctx.api.constants.level.notice;

		const remindEvery = this._getDurationMs('remindValue', 'remindUnit');
		const cooldownMs = this._getDurationMs('cooldownValue', 'cooldownUnit');

		let isSilent = false;
		let nextNotifyAt = typeof notifyAt === 'number' && Number.isFinite(notifyAt) ? Math.trunc(notifyAt) : now;
		if (cooldownMs > 0 && existing?.lifecycle?.state === this.ctx.api.constants.lifecycle.state.closed) {
			const closedAt =
				typeof existing?.lifecycle?.stateChangedAt === 'number' ? existing.lifecycle.stateChangedAt : 0;
			if (closedAt && now - closedAt < cooldownMs) {
				isSilent = true;
				nextNotifyAt = Math.max(nextNotifyAt, closedAt + cooldownMs);
			}
		}

		if (isSilent && remindEvery <= 0) {
			nextNotifyAt = this._farFutureNotifyAt(now);
		}

		const audience = this.getAudience();
		const actor = this._actor();
		const origin = { type: this.ctx.api.constants.origin.type.automation, system: 'ioBroker', id: this.targetId };
		const lifecycle = {
			state: this.ctx.api.constants.lifecycle.state.open,
			stateChangedAt: now,
			stateChangedBy: actor,
		};
		const timing = {
			notifyAt: nextNotifyAt,
			remindEvery: remindEvery > 0 ? remindEvery : undefined,
		};
		const nextActions = this._normalizeActions(actions, existing?.actions);

		if (!existing) {
			const created = this.ctx.api.factory.createMessage({
				ref,
				kind,
				level,
				title,
				text,
				origin,
				audience,
				...(details ? { details } : {}),
				...(nextActions !== undefined ? { actions: nextActions } : {}),
				lifecycle,
				timing,
				progress: { percentage: 0 },
			});
			if (!created) {
				return false;
			}
			return this.ctx.api.store.addOrUpdateMessage(created);
		}

		if (existing?.lifecycle?.state === this.ctx.api.constants.lifecycle.state.open) {
			return true;
		}

		return this.ctx.api.store.updateMessage(ref, {
			kind,
			level,
			title,
			text,
			origin,
			audience: audience || null,
			...(details ? { details } : {}),
			...(nextActions !== undefined ? { actions: nextActions } : {}),
			lifecycle,
			timing: {
				notifyAt: nextNotifyAt,
				remindEvery: remindEvery > 0 ? remindEvery : null,
			},
			progress: { set: { percentage: 0 }, delete: ['finishedAt'] },
		});
	}

	/**
	 * Update an already-open message (no state transition, no explicit re-notification).
	 *
	 * Note: if the message has `notifyAt` unset (one-shot already dispatched), this method forces
	 * `notifyAt` to a far-future timestamp to avoid immediate-due-on-update.
	 *
	 * @param {object} [info] Message inputs.
	 * @param {string} [info.defaultTitle] Rule-provided default title when config is empty.
	 * @param {string} [info.defaultText] Rule-provided default text when config is empty.
	 * @param {number} [info.now] Timestamp in ms (defaults to Date.now()).
	 * @param {object} [info.details] Message details patch.
	 * @param {Array<object>} [info.actions] Message actions (`message.actions[]`).
	 * @returns {boolean} True when updated.
	 */
	updateActive({ defaultTitle, defaultText, now = Date.now(), details = undefined, actions = undefined } = {}) {
		this._cancelPendingReset();

		const ref = this.makeRef();
		this._clearScheduledReset(ref);
		const existing = this.ctx.api.store.getMessageByRef(ref);
		if (!existing || existing?.lifecycle?.state !== this.ctx.api.constants.lifecycle.state.open) {
			return false;
		}

		const { title, text } = this.resolveTitleText({ defaultTitle, defaultText });
		if (!title || !text) {
			throw new Error(`IngestStates: missing title/text defaults for '${ref}'`);
		}

		const audience = this.getAudience();
		const remindEvery = this._getDurationMs('remindValue', 'remindUnit');

		const timing = {
			remindEvery: remindEvery > 0 ? remindEvery : null,
		};

		if (!Number.isFinite(existing?.timing?.notifyAt)) {
			timing.notifyAt = remindEvery > 0 ? now + remindEvery : this._farFutureNotifyAt(now);
		}

		const closeType = this.ctx.api.constants.actions.type.close;
		const hasClose = Array.isArray(existing.actions) && existing.actions.some(a => a?.type === closeType);
		const shouldPatchActions = actions !== undefined || (this.messageConfig?.resetOnNormal === false && !hasClose);
		const nextActions = shouldPatchActions ? this._normalizeActions(actions, existing.actions) : undefined;

		return this.ctx.api.store.updateMessage(ref, {
			title,
			text,
			audience: audience || null,
			...(details ? { details } : {}),
			...(shouldPatchActions ? { actions: nextActions } : {}),
			timing,
		});
	}

	/**
	 * Resolve title/text for the session start message.
	 *
	 * @param {object} [info] Start message inputs.
	 * @param {string} [info.defaultTitle] Rule-provided default title.
	 * @param {string} [info.defaultText] Rule-provided default text.
	 * @returns {{ title: string|undefined, text: string|undefined }} Resolved content.
	 */
	resolveStartTitleText({ defaultTitle, defaultText } = {}) {
		const cfg = this.startMessageConfig || this.messageConfig || {};
		const title =
			typeof cfg?.sessionStartTitle === 'string' && cfg.sessionStartTitle.trim()
				? cfg.sessionStartTitle.trim()
				: defaultTitle;
		const text =
			typeof cfg?.sessionStartText === 'string' && cfg.sessionStartText.trim()
				? cfg.sessionStartText.trim()
				: defaultText;

		return {
			title: typeof title === 'string' && title.trim() ? title.trim() : undefined,
			text: typeof text === 'string' && text.trim() ? text.trim() : undefined,
		};
	}

	/**
	 * Ensure the session start message exists and is active.
	 *
	 * Note: this intentionally does not apply auto-close/close-action policies; the start message is removed
	 * by the session rule when the end message is created.
	 *
	 * @param {object} [info] Message inputs.
	 * @param {string} [info.defaultTitle] Rule-provided default title when config is empty.
	 * @param {string} [info.defaultText] Rule-provided default text when config is empty.
	 * @param {number} [info.now] Timestamp in ms (defaults to Date.now()).
	 * @param {Array<object>} [info.actions] Message actions (`message.actions[]`).
	 * @returns {boolean} True when a message exists/was updated.
	 */
	openStartActive({ defaultTitle, defaultText, now = Date.now(), actions = undefined } = {}) {
		const ref = this.makeRef('_start');
		const existing = this.ctx.api.store.getMessageByRef(ref);
		const state = existing?.lifecycle?.state || this.ctx.api.constants.lifecycle.state.open;
		if (existing && this._isLifecycleActive(state)) {
			return true;
		}

		const { title, text } = this.resolveStartTitleText({ defaultTitle, defaultText });
		if (!title || !text) {
			throw new Error(`IngestStates: missing session start title/text defaults for '${ref}'`);
		}

		const cfg = this.startMessageConfig || this.messageConfig || {};
		const kind = cfg?.sessionStartKind || this.messageConfig?.kind || this.ctx.api.constants.kind.status;
		const level =
			typeof cfg?.sessionStartLevel === 'number'
				? cfg.sessionStartLevel
				: typeof this.messageConfig?.level === 'number'
					? this.messageConfig.level
					: this.ctx.api.constants.level.notice;
		const audience = this.getStartAudience();

		const origin = { type: this.ctx.api.constants.origin.type.automation, system: 'ioBroker', id: this.targetId };
		const lifecycle = {
			state: this.ctx.api.constants.lifecycle.state.open,
			stateChangedAt: now,
			stateChangedBy: this._actor(),
		};
		const remindEvery = this._getDurationMs('remindValue', 'remindUnit');
		const timing = {
			notifyAt: now,
			remindEvery: remindEvery > 0 ? remindEvery : undefined,
		};

		if (!existing) {
			const created = this.ctx.api.factory.createMessage({
				ref,
				kind,
				level,
				title,
				text,
				origin,
				audience,
				...(actions !== undefined ? { actions } : {}),
				lifecycle,
				timing,
				progress: { percentage: 0 },
			});
			if (!created) {
				return false;
			}
			return this.ctx.api.store.addOrUpdateMessage(created);
		}

		return this.ctx.api.store.updateMessage(ref, {
			kind,
			level,
			title,
			text,
			origin,
			audience: audience || null,
			...(actions !== undefined ? { actions } : {}),
			lifecycle,
			timing: {
				notifyAt: now,
				remindEvery: remindEvery > 0 ? remindEvery : null,
			},
			progress: { set: { percentage: 0 }, delete: ['finishedAt'] },
		});
	}

	/**
	 * Patch session start message metrics with change detection + throttling.
	 *
	 * @param {object} [info] Metrics patch inputs.
	 * @param {Record<string, {val: number|string|boolean|null, unit?: string, ts?: number}>} [info.set] Metrics to set/update.
	 * @param {string[]} [info.delete] Metric keys to delete.
	 * @param {number} [info.now] Timestamp in ms (defaults to Date.now()).
	 * @param {boolean} [info.force] When true, bypass in-memory throttling.
	 * @returns {boolean} True when a patch was applied.
	 */
	patchStartMetrics({ set = {}, delete: deleteKeys = [], now = Date.now(), force = false } = {}) {
		const maxIntervalMs = this.ctx.meta.options.resolveInt('metricsMaxIntervalMs', 60000);
		if (!Number.isFinite(maxIntervalMs) || maxIntervalMs <= 0) {
			return false;
		}

		const intervalMs = Math.min(Math.max(Math.trunc(maxIntervalMs), 5000), 1000 * 60 * 60 * 3);
		if (!force && this._lastStartMetricsPatchAt && now - this._lastStartMetricsPatchAt < intervalMs) {
			return false;
		}

		const ref = this.makeRef('_start');
		const existing = this.ctx.api.store.getMessageByRef(ref);
		const state = existing?.lifecycle?.state || this.ctx.api.constants.lifecycle.state.open;
		if (!existing || !this._isLifecycleActive(state)) {
			return false;
		}

		const existingMetrics = existing?.metrics instanceof Map ? existing.metrics : new Map();
		const nextSet = {};
		for (const [key, value] of Object.entries(set || {})) {
			if (!key || typeof key !== 'string') {
				continue;
			}

			const nextVal = value?.val;
			const nextUnit = typeof value?.unit === 'string' ? value.unit : '';

			const prev = existingMetrics.get(key);
			const prevVal = prev?.val;
			const prevUnit = typeof prev?.unit === 'string' ? prev.unit : '';

			if (prevVal === nextVal && prevUnit === nextUnit) {
				continue;
			}

			nextSet[key] = { val: nextVal, unit: nextUnit, ts: now };
		}

		const deleteList = Array.isArray(deleteKeys) ? deleteKeys.filter(k => typeof k === 'string' && k.trim()) : [];
		if (Object.keys(nextSet).length === 0 && deleteList.length === 0) {
			return false;
		}

		const ok = this.ctx.api.store.updateMessage(ref, {
			metrics: {
				set: nextSet,
				...(deleteList.length ? { delete: deleteList } : {}),
			},
		});
		if (ok) {
			this._lastStartMetricsPatchAt = now;
		}
		return ok;
	}

	/**
	 * Soft-delete the session start message (best-effort).
	 *
	 * @returns {void}
	 */
	removeStartMessage() {
		const ref = this.makeRef('_start');
		try {
			this.ctx.api.store.removeMessage(ref);
		} catch {
			// ignore
		}
	}

	/**
	 * Close the end message when a new session starts (best-effort).
	 *
	 * @param {object} [info] Close inputs.
	 * @param {number} [info.finishedAt] Optional finishedAt timestamp.
	 * @returns {boolean} True when a close patch was applied.
	 */
	closeEndOnStart({ finishedAt = Date.now() } = {}) {
		const ref = this.makeRef();
		return this.ctx.api.store.completeAfterCauseEliminated(ref, { actor: this._actor(), finishedAt });
	}

	/**
	 * Close the message when the rule returns to normal (best-effort).
	 *
	 * @param {object} [info] Close inputs.
	 * @param {number} [info.finishedAt] Optional finishedAt timestamp.
	 * @returns {boolean} True when a close was triggered or scheduled.
	 */
	closeOnNormal({ finishedAt = Date.now() } = {}) {
		this._cancelPendingReset();

		if (this.messageConfig?.resetOnNormal === false) {
			return false;
		}

		const ref = this.makeRef();
		const existing = this.ctx.api.store.getMessageByRef(ref);
		if (!existing) {
			return false;
		}

		const delayMs = this._getDurationMs('resetDelayValue', 'resetDelayUnit');
		const actor = this._actor();

		if (delayMs <= 0) {
			this._clearScheduledReset(ref);
			return this.ctx.api.store.completeAfterCauseEliminated(ref, { actor, finishedAt });
		}

		const metricKey = this._resetAtMetricKey();
		const existingResetAt = existing?.metrics instanceof Map ? existing.metrics.get(metricKey)?.val : undefined;
		const resetAt =
			typeof existingResetAt === 'number' && Number.isFinite(existingResetAt)
				? existingResetAt
				: Date.now() + delayMs;

		this.ctx.api.store.updateMessage(ref, {
			metrics: { set: { [metricKey]: { val: resetAt, unit: 'ms', ts: Date.now() } } },
		});

		const ms = Math.max(0, resetAt - Date.now());
		this._pendingResetHandle = this.ctx.meta.resources.setTimeout(() => {
			this._pendingResetHandle = null;
			try {
				this._clearScheduledReset(ref);
				this.ctx.api.store.completeAfterCauseEliminated(ref, { actor, finishedAt });
			} catch (e) {
				this.ctx.api.log.warn(`IngestStates: closeOnNormal failed for '${ref}': ${e?.message || e}`);
			}
		}, ms);

		return true;
	}

	/**
	 * Close a message when a previously scheduled `resetDelay` has elapsed.
	 *
	 * This is the persistent alternative to in-memory timers: the schedule is stored in `metrics`.
	 * Rules should call this periodically (tick) while they are in a "normal" state.
	 *
	 * @param {object} [info] Close inputs.
	 * @param {number} [info.now] Timestamp in ms (defaults to Date.now()).
	 * @returns {boolean} True when a close happened.
	 */
	tryCloseScheduled({ now = Date.now() } = {}) {
		const ref = this.makeRef();
		const existing = this.ctx.api.store.getMessageByRef(ref);
		const state = existing?.lifecycle?.state || this.ctx.api.constants.lifecycle.state.open;
		if (!existing || !this._isLifecycleActive(state)) {
			return false;
		}

		const metricKey = this._resetAtMetricKey();
		const resetAt = existing?.metrics instanceof Map ? existing.metrics.get(metricKey)?.val : undefined;
		if (typeof resetAt !== 'number' || !Number.isFinite(resetAt) || resetAt > now) {
			return false;
		}

		this._cancelPendingReset();
		this._clearScheduledReset(ref);
		return this.ctx.api.store.completeAfterCauseEliminated(ref, { actor: this._actor(), finishedAt: now });
	}

	/**
	 * Patch message metrics with change detection + throttling.
	 *
	 * Throttling is in-memory (restart resets the timer); patches are silent by design (metrics don't bump `updatedAt`).
	 *
	 * @param {object} [info] Metrics patch inputs.
	 * @param {Record<string, {val: number|string|boolean|null, unit?: string, ts?: number}>} [info.set] Metrics to set/update.
	 * @param {string[]} [info.delete] Metric keys to delete.
	 * @param {number} [info.now] Timestamp in ms (defaults to Date.now()).
	 * @param {boolean} [info.force] When true, bypass in-memory throttling.
	 * @returns {boolean} True when a patch was applied.
	 */
	patchMetrics({ set = {}, delete: deleteKeys = [], now = Date.now(), force = false } = {}) {
		const maxIntervalMs = this.ctx.meta.options.resolveInt('metricsMaxIntervalMs', 60000);
		if (!Number.isFinite(maxIntervalMs) || maxIntervalMs <= 0) {
			return false;
		}

		const intervalMs = Math.min(Math.max(Math.trunc(maxIntervalMs), 5000), 1000 * 60 * 60 * 3);
		if (!force && this._lastMetricsPatchAt && now - this._lastMetricsPatchAt < intervalMs) {
			return false;
		}

		const ref = this.makeRef();
		const existing = this.ctx.api.store.getMessageByRef(ref);
		const state = existing?.lifecycle?.state || this.ctx.api.constants.lifecycle.state.open;
		if (!existing || !this._isLifecycleActive(state)) {
			return false;
		}

		const nextSet = {};
		const existingMetrics = existing?.metrics instanceof Map ? existing.metrics : new Map();

		for (const [key, value] of Object.entries(set || {})) {
			if (typeof key !== 'string' || !key.trim() || !value || typeof value !== 'object') {
				continue;
			}

			const nextVal = value.val;
			const nextUnit = typeof value.unit === 'string' ? value.unit : '';

			const prev = existingMetrics.get(key);
			const prevVal = prev?.val;
			const prevUnit = typeof prev?.unit === 'string' ? prev.unit : '';

			if (prevVal === nextVal && prevUnit === nextUnit) {
				continue;
			}

			nextSet[key] = { val: nextVal, unit: nextUnit, ts: now };
		}

		const deleteList = Array.isArray(deleteKeys) ? deleteKeys.filter(k => typeof k === 'string' && k.trim()) : [];

		if (Object.keys(nextSet).length === 0 && deleteList.length === 0) {
			return false;
		}

		const ok = this.ctx.api.store.updateMessage(ref, {
			metrics: {
				set: nextSet,
				...(deleteList.length ? { delete: deleteList } : {}),
			},
		});
		if (ok) {
			this._lastMetricsPatchAt = now;
		}
		return ok;
	}

	/**
	 * @returns {void}
	 */
	dispose() {
		this._cancelPendingReset();
	}
}

module.exports = { MessageWriter, TargetMessageWriter };
