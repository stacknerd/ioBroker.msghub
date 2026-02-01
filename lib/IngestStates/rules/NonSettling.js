'use strict';

const { fallbackPresetId } = require('../constants');

/**
 * NonSettling rule (continuous activity / trend detection).
 *
 * Developer notes (mental model):
 * - We watch a single numeric stream (targetId) and detect "never settles" behavior.
 * - Two profiles share the same persistence mechanism (open timer):
 *   - `activity`: "no stable phase" within a long window.
 *   - `trend`: "keeps moving in one direction" for too long.
 * - When the open timer fires we open a message; metrics keep the diagnosis visible.
 * - The open timer is persisted so alerts survive restarts.
 */
class NonSettlingRule {
	/**
	 * Create a new NonSettling rule instance.
	 *
	 * @param {object} info Rule inputs.
	 * @param {object} info.ctx Plugin runtime context.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {object} info.ruleConfig Rule config (from `nonset-*` keys).
	 * @param {object} info.messageWritersByPresetKey presetId -> writer map.
	 * @param {object} [info.timers] Timer service (shared).
	 * @param {boolean} [info.traceEvents] Enable verbose debug logging.
	 */
	constructor({ ctx, targetId, ruleConfig = {}, messageWritersByPresetKey, timers = null, traceEvents = false }) {
		this.targetId = targetId;
		this.ruleConfig = ruleConfig || {};
		this.messageWriters = messageWritersByPresetKey;
		this.timers = timers;
		this._traceEvents = traceEvents === true;
		this.ctx = ctx;
		this._log = this.ctx?.api?.log || null;

		this._profile = this._resolveProfile();
		this._minDelta = this._resolveMinDelta();
		this._maxContinuousMs =
			this._profile === 'activity' ? this._resolveDurationMs('maxContinuousValue', 'maxContinuousUnit') : 0;
		this._quietGapMs = this._profile === 'activity' ? this._resolveDurationMs('quietGapValue', 'quietGapUnit') : 0;
		this._trendWindowMs =
			this._profile === 'trend' ? this._resolveDurationMs('trendWindowValue', 'trendWindowUnit') : 0;
		this._minTotalDelta = this._profile === 'trend' ? this._resolveMinTotalDelta() : 0;
		this._direction = this._profile === 'trend' ? this._resolveDirection() : null;

		this._name = this._fallbackName(targetId);
		this._unit = 'n/a';
		this._value = null;
		this._closeRequested = false;

		this._activity = {
			candidateStartedAt: 0,
			candidateMin: NaN,
			candidateMax: NaN,
			nonStableSinceAt: 0,
			startValue: NaN,
			min: NaN,
			max: NaN,
		};

		this._trend = {
			startedAt: 0,
			startValue: NaN,
			min: NaN,
			max: NaN,
			dir: '',
			lastValue: NaN,
		};

		this._loadObjectMeta();
		this._validateConfigOrThrow();
		this._restorePendingTimerState();

		this._trace(
			`start targetId='${this.targetId}' profile='${this._profile}' minDelta=${this._minDelta} maxContinuousMs=${this._maxContinuousMs} trendWindowMs=${this._trendWindowMs}`,
		);
	}

	/**
	 * Debug logging helper (guarded by `traceEvents`).
	 *
	 * @param {string} msg Debug message.
	 * @returns {void}
	 */
	_trace(msg) {
		if (!this._traceEvents || typeof this._log?.debug !== 'function') {
			return;
		}

		const _shorten = str => {
			const s = String(str ?? '');
			return s.length > 40 ? `[...]${s.slice(-40)}` : s;
		};

		this._log.debug(`NonSettl. ${_shorten(this.targetId)}: ${msg}`);
	}

	/**
	 * Resolve the per-preset message writer for this rule instance.
	 *
	 * Resolve a message writer for the given preset id.
	 *
	 * Falls back to the engine-provided [fallbackPresetId] writer when the preset id is missing or unknown.
	 *
	 * @param {string} [presetKey] Preset key
	 * @returns {object|null} Message writer instance or null.
	 */
	_getMessageWriter(presetKey) {
		const writers = this.messageWriters;
		if (!writers || typeof writers !== 'object') {
			return null;
		}

		const key = typeof presetKey === 'string' && presetKey.trim() ? presetKey.trim() : '';
		return (key && writers[key]) || writers.NonSettlingId || writers.DefaultId || writers[fallbackPresetId] || null;
	}

	/**
	 * Build the stable message ref for the target + rule.
	 *
	 * Build a stable message ref for this rule instance.
	 *
	 * Uses `ctx.meta.plugin.baseOwnId` so refs are unique per adapter + plugin instance.
	 *
	 * @returns {string} Stable message ref.
	 */
	_getRef() {
		return `${this.ctx?.meta?.plugin?.baseOwnId}.nonsettling.${this.targetId}`;
	}

	/**
	 * Declare which foreign state ids this rule needs.
	 *
	 * @returns {Set<string>} Required foreign state ids.
	 */
	requiredStateIds() {
		return new Set([this.targetId]);
	}

	/**
	 * Route target state changes into the profile-specific state machine.
	 *
	 * @param {string} id State id.
	 * @param {object} state ioBroker state.
	 * @returns {void}
	 */
	onStateChange(id, state) {
		if (id !== this.targetId) {
			return;
		}

		const value = this._parseValue(state?.val);
		if (value === null) {
			return;
		}

		const now = typeof state?.ts === 'number' && Number.isFinite(state.ts) ? Math.trunc(state.ts) : Date.now();
		this._value = value;

		if (this._profile === 'activity') {
			// "Activity" profile → detect lack of a stable phase.
			this._handleActivity(value, now);
			return;
		}
		// "Trend" profile → detect long monotonic movement.
		this._handleTrend(value, now);
	}

	/**
	 * Periodic evaluation tick (used mainly for metric patching).
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	onTick(now) {
		if (!this._isMessageActive()) {
			return;
		}
		this._patchMetrics(now);
	}

	/**
	 * Dispose and clean up pending timers.
	 *
	 * @returns {void}
	 */
	dispose() {
		this._cancelOpenTimer();
	}

	/**
	 * Handle a due open timer fired by `TimerService`.
	 *
	 * @param {{ id: string, at: number, kind: string, data?: any }} timer Timer payload.
	 * @returns {void}
	 */
	onTimer(timer) {
		const kind = typeof timer?.kind === 'string' ? timer.kind : '';
		const data = timer?.data && typeof timer.data === 'object' && !Array.isArray(timer.data) ? timer.data : null;
		if (!kind || !data || data.targetId !== this.targetId) {
			return;
		}

		const profile = data.profile;
		if (profile !== this._profile) {
			return;
		}

		const now = Date.now();
		this._closeRequested = false;

		if (profile === 'activity') {
			// Restore activity window state from timer payload and open.
			const startedAt =
				typeof data.startedAt === 'number' && Number.isFinite(data.startedAt) ? data.startedAt : 0;
			if (!startedAt) {
				return;
			}
			this._activity.nonStableSinceAt = startedAt;
			this._activity.startValue =
				typeof data.startValue === 'number' && Number.isFinite(data.startValue) ? data.startValue : NaN;
			this._activity.min = typeof data.min === 'number' && Number.isFinite(data.min) ? data.min : NaN;
			this._activity.max = typeof data.max === 'number' && Number.isFinite(data.max) ? data.max : NaN;
			this._open(now);
			return;
		}

		// trend: validate payload and open when the total delta is big enough.
		const startedAt = typeof data.startedAt === 'number' && Number.isFinite(data.startedAt) ? data.startedAt : 0;
		const dir = data.dir === 'up' || data.dir === 'down' ? data.dir : '';
		const min = typeof data.min === 'number' && Number.isFinite(data.min) ? data.min : NaN;
		const max = typeof data.max === 'number' && Number.isFinite(data.max) ? data.max : NaN;
		const startValue =
			typeof data.startValue === 'number' && Number.isFinite(data.startValue) ? data.startValue : NaN;
		if (!startedAt || !dir || !Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(startValue)) {
			return;
		}
		const delta = max - min;
		if (this._minTotalDelta > 0 && delta < this._minTotalDelta) {
			return;
		}

		this._trend.startedAt = startedAt;
		this._trend.startValue = startValue;
		this._trend.min = min;
		this._trend.max = max;
		this._trend.dir = dir;
		this._trend.lastValue = typeof this._value === 'number' ? this._value : NaN;
		this._open(now);
	}

	/**
	 * Validate config values for the chosen profile.
	 *
	 * @returns {void}
	 */
	_validateConfigOrThrow() {
		const cfg = this.ruleConfig;
		const profile = this._profile;
		if (profile === 'activity') {
			if (
				typeof cfg.maxContinuousValue !== 'number' ||
				!Number.isFinite(cfg.maxContinuousValue) ||
				cfg.maxContinuousValue <= 0
			) {
				throw new Error('NonSettlingRule(activity): nonset-maxContinuousValue must be a positive number');
			}
			if (
				typeof cfg.maxContinuousUnit !== 'number' ||
				!Number.isFinite(cfg.maxContinuousUnit) ||
				cfg.maxContinuousUnit <= 0
			) {
				throw new Error(
					'NonSettlingRule(activity): nonset-maxContinuousUnit must be a positive number (seconds)',
				);
			}
			if (typeof cfg.quietGapValue !== 'number' || !Number.isFinite(cfg.quietGapValue) || cfg.quietGapValue < 0) {
				throw new Error('NonSettlingRule(activity): nonset-quietGapValue must be a number >= 0');
			}
			if (typeof cfg.quietGapUnit !== 'number' || !Number.isFinite(cfg.quietGapUnit) || cfg.quietGapUnit <= 0) {
				throw new Error('NonSettlingRule(activity): nonset-quietGapUnit must be a positive number (seconds)');
			}
			return;
		}

		if (profile === 'trend') {
			if (
				typeof cfg.trendWindowValue !== 'number' ||
				!Number.isFinite(cfg.trendWindowValue) ||
				cfg.trendWindowValue <= 0
			) {
				throw new Error('NonSettlingRule(trend): nonset-trendWindowValue must be a positive number');
			}
			if (
				typeof cfg.trendWindowUnit !== 'number' ||
				!Number.isFinite(cfg.trendWindowUnit) ||
				cfg.trendWindowUnit <= 0
			) {
				throw new Error('NonSettlingRule(trend): nonset-trendWindowUnit must be a positive number (seconds)');
			}
			return;
		}
	}

	/**
	 * Resolve which profile to run (`activity` is default).
	 *
	 * @returns {'activity'|'trend'} Selected profile.
	 */
	_resolveProfile() {
		const p = typeof this.ruleConfig?.profile === 'string' ? this.ruleConfig.profile.trim() : '';
		if (p === 'trend') {
			return 'trend';
		}
		return 'activity';
	}

	/**
	 * Resolve minimum delta used for stability/trend detection.
	 *
	 * @returns {number} Minimum delta (>= 0).
	 */
	_resolveMinDelta() {
		const d = this.ruleConfig?.minDelta;
		if (typeof d === 'number' && Number.isFinite(d) && d >= 0) {
			return d;
		}
		return 0;
	}

	/**
	 * Resolve minimum total delta used to suppress weak trends.
	 *
	 * @returns {number} Minimum total delta for trend alerts (>= 0).
	 */
	_resolveMinTotalDelta() {
		const d = this.ruleConfig?.minTotalDelta;
		if (typeof d === 'number' && Number.isFinite(d) && d >= 0) {
			return d;
		}
		return 0;
	}

	/**
	 * Resolve trend direction (up/down/any).
	 *
	 * @returns {'up'|'down'|'any'} Trend direction.
	 */
	_resolveDirection() {
		const d = typeof this.ruleConfig?.direction === 'string' ? this.ruleConfig.direction.trim() : '';
		if (d === 'down' || d === 'any') {
			return d;
		}
		return 'up';
	}

	/**
	 * Resolve a duration value in ms from config value + unit keys.
	 *
	 * @param {string} valueKey Config value key.
	 * @param {string} unitKey Config unit key (seconds).
	 * @returns {number} Duration in ms.
	 */
	_resolveDurationMs(valueKey, unitKey) {
		const value = this.ruleConfig?.[valueKey];
		const unitSeconds = this.ruleConfig?.[unitKey];
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
	 * Parse raw state value into a number (or null when invalid).
	 *
	 * @param {any} val Raw state value.
	 * @returns {number|null} Parsed number or null.
	 */
	_parseValue(val) {
		const n = typeof val === 'number' ? val : typeof val === 'string' ? Number(val.trim()) : NaN;
		if (!Number.isFinite(n)) {
			return null;
		}
		return n;
	}

	/**
	 * Activity profile: detect extended non-stable periods.
	 *
	 * @param {number} value Current value.
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_handleActivity(value, now) {
		const minDelta = this._minDelta;

		if (!this._activity.candidateStartedAt || !Number.isFinite(this._activity.candidateMin)) {
			// Start a new "candidate stable" window.
			this._activity.candidateStartedAt = now;
			this._activity.candidateMin = value;
			this._activity.candidateMax = value;
		} else {
			this._activity.candidateMin = Math.min(this._activity.candidateMin, value);
			this._activity.candidateMax = Math.max(this._activity.candidateMax, value);
			if (this._activity.candidateMax - this._activity.candidateMin > minDelta) {
				// Too much movement → reset the stability candidate window.
				this._activity.candidateStartedAt = now;
				this._activity.candidateMin = value;
				this._activity.candidateMax = value;
			}
		}

		const stable =
			this._quietGapMs > 0 &&
			!!this._activity.candidateStartedAt &&
			now - this._activity.candidateStartedAt >= this._quietGapMs;

		if (stable) {
			// Found a stable phase → close any open alert and reset activity tracking.
			this._cancelOpenTimer();
			this._activity.nonStableSinceAt = 0;
			this._activity.startValue = NaN;
			this._activity.min = NaN;
			this._activity.max = NaN;
			this._closeRequested = false;
			this._close(now);
			return;
		}

		if (!this._activity.nonStableSinceAt) {
			// First non-stable moment.
			this._activity.nonStableSinceAt = now;
			this._activity.startValue = value;
			this._activity.min = value;
			this._activity.max = value;
		} else {
			this._activity.min = Math.min(this._activity.min, value);
			this._activity.max = Math.max(this._activity.max, value);
		}

		const startedAt = this._activity.nonStableSinceAt;
		const openAt = startedAt + this._maxContinuousMs;
		if (openAt <= now) {
			// Threshold exceeded → open immediately.
			this._cancelOpenTimer();
			this._closeRequested = false;
			this._open(now);
			return;
		}

		// Otherwise, keep (or refresh) the persisted open timer.
		this._ensureOpenTimer(openAt, {
			profile: 'activity',
			targetId: this.targetId,
			startedAt,
			startValue: this._activity.startValue,
			min: this._activity.min,
			max: this._activity.max,
		});

		if (this._isMessageActive()) {
			// Message already open → keep metrics fresh.
			this._patchMetrics(now);
		}
	}

	/**
	 * Trend profile: detect long monotonic movement in one direction.
	 *
	 * @param {number} value Current value.
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_handleTrend(value, now) {
		const minDelta = this._minDelta;
		const fixedDir = this._direction === 'up' || this._direction === 'down' ? this._direction : null;

		if (!this._trend.startedAt) {
			// First sample in a new trend window.
			this._trend.startedAt = now;
			this._trend.startValue = value;
			this._trend.min = value;
			this._trend.max = value;
			this._trend.dir = fixedDir || '';
			this._trend.lastValue = value;
		} else {
			const last = this._trend.lastValue;

			if (!fixedDir && !this._trend.dir) {
				// Direction is unknown until minDelta is exceeded.
				const delta = value - this._trend.startValue;
				if (Math.abs(delta) >= minDelta) {
					this._trend.dir = delta > 0 ? 'up' : 'down';
				}
			}

			const effectiveDir = this._trend.dir || fixedDir;
			const brokeUp = effectiveDir === 'up' && Number.isFinite(last) && value < last - minDelta;
			const brokeDown = effectiveDir === 'down' && Number.isFinite(last) && value > last + minDelta;
			if (brokeUp || brokeDown) {
				// Direction broke → close and restart the trend window.
				this._cancelOpenTimer();
				this._closeRequested = false;
				this._close(now);
				this._trend.startedAt = now;
				this._trend.startValue = value;
				this._trend.min = value;
				this._trend.max = value;
				this._trend.dir = fixedDir || '';
				this._trend.lastValue = value;
			} else {
				this._trend.lastValue = value;
				this._trend.dir = effectiveDir || this._trend.dir;
				this._trend.min = Math.min(this._trend.min, value);
				this._trend.max = Math.max(this._trend.max, value);
			}
		}

		const openAt = this._trend.startedAt + this._trendWindowMs;
		const dir = this._trend.dir;
		const delta = this._trend.max - this._trend.min;

		if (openAt <= now && (dir === 'up' || dir === 'down') && delta >= this._minTotalDelta) {
			// Trend persisted long enough → open immediately.
			this._cancelOpenTimer();
			this._closeRequested = false;
			this._open(now);
			return;
		}

		// Otherwise, keep (or refresh) the persisted open timer.
		this._ensureOpenTimer(openAt, {
			profile: 'trend',
			targetId: this.targetId,
			startedAt: this._trend.startedAt,
			startValue: this._trend.startValue,
			min: this._trend.min,
			max: this._trend.max,
			dir: dir || '',
		});

		if (this._isMessageActive()) {
			// Message already open → keep metrics fresh.
			this._patchMetrics(now);
		}
	}

	/**
	 * Build the open-timer id for the active profile.
	 *
	 * @returns {string} Timer id for the current profile.
	 */
	_openTimerId() {
		return `ns:${this.targetId}:open:${this._profile}`;
	}

	/**
	 * Ensure the persisted open timer is scheduled at the requested timestamp.
	 *
	 * @param {number} at Due timestamp (ms).
	 * @param {object} data Timer payload.
	 * @returns {void}
	 */
	_ensureOpenTimer(at, data) {
		if (!this.timers) {
			return;
		}
		const id = this._openTimerId();
		const existing = this.timers.get(id);
		if (existing && existing.at === at) {
			this._trace(
				`update timer kind='nonSettling.${this._profile}.open' id='${id}' inMs=${Math.max(0, at - Date.now())} at=${at}`,
			);
			this.timers.set(id, at, `nonSettling.${this._profile}.open`, data);
			return;
		}
		this._trace(
			`start timer kind='nonSettling.${this._profile}.open' id='${id}' inMs=${Math.max(0, at - Date.now())} at=${at}`,
		);
		this.timers.set(id, at, `nonSettling.${this._profile}.open`, data);
	}

	/**
	 * Cancel any pending open timer (best-effort).
	 *
	 * @returns {void}
	 */
	_cancelOpenTimer() {
		if (!this.timers) {
			return;
		}
		this._trace(`cancel timer id='${this._openTimerId()}'`);
		this.timers.delete(this._openTimerId());
	}

	/**
	 * Restore internal trend/activity state from a persisted open timer.
	 *
	 * Restore internal state from an existing persisted open timer (best-effort).
	 *
	 * @returns {void}
	 */
	_restorePendingTimerState() {
		if (!this.timers) {
			return;
		}
		const existing = this.timers.get(this._openTimerId());
		const data = existing?.data;
		if (!data || typeof data !== 'object' || Array.isArray(data)) {
			return;
		}
		if (data.profile === 'activity') {
			this._activity.nonStableSinceAt =
				typeof data.startedAt === 'number' && Number.isFinite(data.startedAt) ? data.startedAt : 0;
			this._activity.startValue =
				typeof data.startValue === 'number' && Number.isFinite(data.startValue) ? data.startValue : NaN;
			this._activity.min = typeof data.min === 'number' && Number.isFinite(data.min) ? data.min : NaN;
			this._activity.max = typeof data.max === 'number' && Number.isFinite(data.max) ? data.max : NaN;
			return;
		}
		if (data.profile === 'trend') {
			if (
				typeof data.startedAt !== 'number' ||
				!Number.isFinite(data.startedAt) ||
				typeof data.startValue !== 'number' ||
				!Number.isFinite(data.startValue) ||
				typeof data.min !== 'number' ||
				!Number.isFinite(data.min) ||
				typeof data.max !== 'number' ||
				!Number.isFinite(data.max)
			) {
				return;
			}
			this._trend.startedAt = data.startedAt;
			this._trend.startValue = data.startValue;
			this._trend.min = data.min;
			this._trend.max = data.max;
			this._trend.dir = data.dir === 'up' || data.dir === 'down' ? data.dir : '';
			this._trend.lastValue = typeof this._value === 'number' ? this._value : NaN;
		}
	}

	/**
	 * Open the alert message and seed its actions.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_open(now) {
		const actionTypes = this.ctx?.api?.constants?.actions?.type || {};
		const typeAck = actionTypes.ack || 'ack';
		const typeSnooze = actionTypes.snooze || 'snooze';
		const actions = [
			{ id: 'ack', type: typeAck },
			{ id: 'snooze-4h', type: typeSnooze, payload: { forMs: 4 * 60 * 60 * 1000 } },
		];

		const writer = this._getMessageWriter('NonSettlingId');
		if (writer) {
			const startAt = this._getStartAtForOpen();
			const metrics = this._buildMetricsSet();
			writer.onUpsert(this._getRef(), { now, startAt, actions, metrics });
		}
	}

	/**
	 * Close the alert message once (cause eliminated).
	 *
	 * @param {number} _now Current timestamp (ms).
	 * @returns {void}
	 */
	_close(_now) {
		if (!this._closeRequested) {
			this._closeRequested = true;
			const writer = this._getMessageWriter('NonSettlingId');
			if (writer) {
				writer.onClose(this._getRef());
			}
		}
	}

	/**
	 * Patch live metrics for the open message.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_patchMetrics(now) {
		const set = this._buildMetricsSet();
		if (!set) {
			return;
		}

		const writer = this._getMessageWriter('NonSettlingId');
		if (!writer) {
			return;
		}
		writer.onMetrics(this._getRef(), { set, now });
	}

	/**
	 * Derive the startAt domain timestamp for the message open.
	 *
	 * @returns {number|undefined} startAt in ms, or undefined when unknown.
	 */
	_getStartAtForOpen() {
		if (this._profile === 'activity') {
			const startedAt = this._activity.nonStableSinceAt;
			return typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0 ? startedAt : undefined;
		}
		const startedAt = this._trend.startedAt;
		return typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0 ? startedAt : undefined;
	}

	/**
	 * Build the metrics payload for the current profile and state.
	 *
	 * @returns {Record<string, {val: any, unit?: string}>|null} Metrics set or null when unavailable.
	 */
	_buildMetricsSet() {
		if (this._value === null) {
			return null;
		}

		const name = typeof this._name === 'string' ? this._name.trim() : '';
		const set = {
			'state-value': { val: this._value, unit: this._unit || 'n/a' },
		};
		if (name) {
			set['state-name'] = { val: name, unit: '' };
		}

		const m = this._profile === 'trend' && this._trend.startedAt ? this._trend : null;
		if (m) {
			// Trend metrics: direction + min/max span.
			set.trendStartedAt = { val: m.startedAt, unit: 'ms' };
			set.trendStartValue = { val: m.startValue, unit: this._unit || 'n/a' };
			set.trendMin = { val: m.min, unit: this._unit || 'n/a' };
			set.trendMax = { val: m.max, unit: this._unit || 'n/a' };
			set.trendMinToMax = { val: m.max - m.min, unit: this._unit || 'n/a' };
			set.trendDir = { val: m.dir, unit: '' };
		} else if (
			this._profile === 'activity' &&
			this._activity.nonStableSinceAt &&
			Number.isFinite(this._activity.min) &&
			Number.isFinite(this._activity.max)
		) {
			// Activity metrics: window from first non-stable point.
			set.trendStartedAt = { val: this._activity.nonStableSinceAt, unit: 'ms' };
			set.trendStartValue = { val: this._activity.startValue, unit: this._unit || 'n/a' };
			set.trendMin = { val: this._activity.min, unit: this._unit || 'n/a' };
			set.trendMax = { val: this._activity.max, unit: this._unit || 'n/a' };
			set.trendMinToMax = { val: this._activity.max - this._activity.min, unit: this._unit || 'n/a' };
			set.trendDir = { val: '', unit: '' };
		}

		return set;
	}

	/**
	 * Check whether a quasi-open message exists for this rule.
	 *
	 * @returns {boolean} True when a message exists and is non-terminal.
	 */
	_isMessageActive() {
		const ref = this._getRef();
		const existing = this.ctx.api.store.getMessageByRef(ref, 'quasiOpen');
		return !!existing;
	}

	/**
	 * Best-effort lookup of object meta (unit) for metrics.
	 *
	 * Best-effort lookup of object meta (name/unit) for nicer defaults.
	 *
	 * @returns {void}
	 */
	_loadObjectMeta() {
		const ctx = this.ctx;
		const getObj = ctx?.api?.iobroker?.objects?.getForeignObject;
		if (typeof getObj !== 'function') {
			return;
		}
		Promise.resolve()
			.then(() => getObj(this.targetId))
			.then(obj => {
				let patchName = false;
				const n = obj?.common?.name;
				if (typeof n === 'string' && n.trim()) {
					const next = n.trim();
					if (next !== this._name) {
						this._name = next;
						patchName = true;
					}
				}

				const u = obj?.common?.unit;
				if (typeof u === 'string' && u.trim()) {
					this._unit = u.trim();
				}

				if (patchName && this._isMessageActive()) {
					const writer = this._getMessageWriter('NonSettlingId');
					if (writer && typeof writer.onMetrics === 'function') {
						writer.onMetrics(this._getRef(), {
							set: { 'state-name': { val: this._name, unit: '' } },
							now: Date.now(),
							force: true,
						});
					}
				}
			})
			.catch(() => undefined);
	}

	/**
	 * Fallback name derived from a state id.
	 *
	 * @param {string} id state id.
	 * @returns {string} best-effort short name.
	 */
	_fallbackName(id) {
		const str = String(id || '');
		const parts = str.split('.').filter(Boolean);
		return parts.length ? parts[parts.length - 1] : str;
	}
}

module.exports = { NonSettlingRule };
