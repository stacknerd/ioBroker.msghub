'use strict';

/**
 * NonSettling rule (continuous activity / trend detection).
 *
 * Profiles:
 * - `activity`: alerts when no stable phase is reached for a long time
 * - `trend`: alerts when a value keeps moving in one direction for a long time
 */
class NonSettlingRule {
	/**
	 * @param {object} info Rule inputs.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {object} info.ruleConfig Rule config (`ns.*`).
	 * @param {object} info.message Target message writer.
	 * @param {object} [info.timers] Timer service (shared).
	 */
	constructor({ targetId, ruleConfig = {}, message, timers = null }) {
		this.targetId = targetId;
		this.ruleConfig = ruleConfig || {};
		this.message = message;
		this.timers = timers;

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
	}

	/**
	 * @returns {Set<string>} Required foreign state ids.
	 */
	requiredStateIds() {
		return new Set([this.targetId]);
	}

	/**
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
			this._handleActivity(value, now);
			return;
		}
		this._handleTrend(value, now);
	}

	/**
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	onTick(now) {
		if (!this._isMessageActive()) {
			this.message.tryCloseScheduled({ now });
			return;
		}
		this._patchMetrics(now);
	}

	/**
	 * @returns {void}
	 */
	dispose() {
		this._cancelOpenTimer();
	}

	/**
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
			this._patchMetrics(now);
			return;
		}

		// trend
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
		this._patchMetrics(now);
	}

	/**
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
				throw new Error('NonSettlingRule(activity): ns.maxContinuousValue must be a positive number');
			}
			if (
				typeof cfg.maxContinuousUnit !== 'number' ||
				!Number.isFinite(cfg.maxContinuousUnit) ||
				cfg.maxContinuousUnit <= 0
			) {
				throw new Error('NonSettlingRule(activity): ns.maxContinuousUnit must be a positive number (seconds)');
			}
			if (typeof cfg.quietGapValue !== 'number' || !Number.isFinite(cfg.quietGapValue) || cfg.quietGapValue < 0) {
				throw new Error('NonSettlingRule(activity): ns.quietGapValue must be a number >= 0');
			}
			if (typeof cfg.quietGapUnit !== 'number' || !Number.isFinite(cfg.quietGapUnit) || cfg.quietGapUnit <= 0) {
				throw new Error('NonSettlingRule(activity): ns.quietGapUnit must be a positive number (seconds)');
			}
			return;
		}

		if (profile === 'trend') {
			if (
				typeof cfg.trendWindowValue !== 'number' ||
				!Number.isFinite(cfg.trendWindowValue) ||
				cfg.trendWindowValue <= 0
			) {
				throw new Error('NonSettlingRule(trend): ns.trendWindowValue must be a positive number');
			}
			if (
				typeof cfg.trendWindowUnit !== 'number' ||
				!Number.isFinite(cfg.trendWindowUnit) ||
				cfg.trendWindowUnit <= 0
			) {
				throw new Error('NonSettlingRule(trend): ns.trendWindowUnit must be a positive number (seconds)');
			}
			return;
		}
	}

	/**
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
	 * @param {number} value Current value.
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_handleActivity(value, now) {
		const minDelta = this._minDelta;

		if (!this._activity.candidateStartedAt || !Number.isFinite(this._activity.candidateMin)) {
			this._activity.candidateStartedAt = now;
			this._activity.candidateMin = value;
			this._activity.candidateMax = value;
		} else {
			this._activity.candidateMin = Math.min(this._activity.candidateMin, value);
			this._activity.candidateMax = Math.max(this._activity.candidateMax, value);
			if (this._activity.candidateMax - this._activity.candidateMin > minDelta) {
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
			this._cancelOpenTimer();
			this._closeRequested = false;
			this._open(now);
			this._patchMetrics(now);
			return;
		}

		this._ensureOpenTimer(openAt, {
			profile: 'activity',
			targetId: this.targetId,
			startedAt,
			startValue: this._activity.startValue,
			min: this._activity.min,
			max: this._activity.max,
		});

		if (this._isMessageActive()) {
			this._patchMetrics(now);
		}
	}

	/**
	 * @param {number} value Current value.
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_handleTrend(value, now) {
		const minDelta = this._minDelta;
		const fixedDir = this._direction === 'up' || this._direction === 'down' ? this._direction : null;

		if (!this._trend.startedAt) {
			this._trend.startedAt = now;
			this._trend.startValue = value;
			this._trend.min = value;
			this._trend.max = value;
			this._trend.dir = fixedDir || '';
			this._trend.lastValue = value;
		} else {
			const last = this._trend.lastValue;

			if (!fixedDir && !this._trend.dir) {
				const delta = value - this._trend.startValue;
				if (Math.abs(delta) >= minDelta) {
					this._trend.dir = delta > 0 ? 'up' : 'down';
				}
			}

			const effectiveDir = this._trend.dir || fixedDir;
			const brokeUp = effectiveDir === 'up' && Number.isFinite(last) && value < last - minDelta;
			const brokeDown = effectiveDir === 'down' && Number.isFinite(last) && value > last + minDelta;
			if (brokeUp || brokeDown) {
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
			this._cancelOpenTimer();
			this._closeRequested = false;
			this._open(now);
			this._patchMetrics(now);
			return;
		}

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
			this._patchMetrics(now);
		}
	}

	/**
	 * @returns {string} Timer id for the current profile.
	 */
	_openTimerId() {
		return `ns:${this.targetId}:open:${this._profile}`;
	}

	/**
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
			this.timers.set(id, at, `nonSettling.${this._profile}.open`, data);
			return;
		}
		this.timers.set(id, at, `nonSettling.${this._profile}.open`, data);
	}

	/**
	 * @returns {void}
	 */
	_cancelOpenTimer() {
		if (!this.timers) {
			return;
		}
		this.timers.delete(this._openTimerId());
	}

	/**
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
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_open(now) {
		const t = this.message.ctx.api.i18n.t;

		const actions = [
			{ id: 'ack', type: 'ack' },
			{ id: 'snooze-4h', type: 'snooze', payload: { forMs: 4 * 60 * 60 * 1000 } },
		];

		const { defaultTitle, defaultText } = this._buildDefaultText(t);
		this.message.openActive({ defaultTitle, defaultText, now, actions });
	}

	/**
	 * @param {number} _now Current timestamp (ms).
	 * @returns {void}
	 */
	_close(_now) {
		if (!this._closeRequested) {
			this._closeRequested = true;
			this.message.closeOnNormal();
		}
	}

	/**
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_patchMetrics(now) {
		if (this._value === null) {
			return;
		}

		const set = {
			'state-value': { val: this._value, unit: this._unit || 'n/a' },
		};

		const m = this._profile === 'trend' && this._trend.startedAt ? this._trend : null;
		if (m) {
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
			set.trendStartedAt = { val: this._activity.nonStableSinceAt, unit: 'ms' };
			set.trendStartValue = { val: this._activity.startValue, unit: this._unit || 'n/a' };
			set.trendMin = { val: this._activity.min, unit: this._unit || 'n/a' };
			set.trendMax = { val: this._activity.max, unit: this._unit || 'n/a' };
			set.trendMinToMax = { val: this._activity.max - this._activity.min, unit: this._unit || 'n/a' };
			set.trendDir = { val: '', unit: '' };
		}

		this.message.patchMetrics({ set, now });
	}

	/**
	 * @param {(key: string, ...args: any[]) => string} t Translator.
	 * @returns {{ defaultTitle: string, defaultText: string }} Default text blocks.
	 */
	_buildDefaultText(t) {
		const name = this._name;
		const unit = this._unit || 'n/a';

		if (this._profile === 'trend') {
			const dir = this._trend?.dir === 'down' ? 'down' : 'up';
			const dirText = dir === 'down' ? t('falling') : t('rising');
			const durationText = this._formatDuration(this._trendWindowMs);
			const title = t(`'%s' unexpected trend`, name);
			const text = t(
				`'%s' has been %s for {{m.trendStartedAt|durationSince}} unexpectedly. It changed by {{m.trendMinToMax}} %s. You asked to be notified if this trend persists for %s.`,
				name,
				dirText,
				unit,
				durationText,
			);
			return { defaultTitle: title, defaultText: text };
		}

		const durationText = this._formatDuration(this._maxContinuousMs);
		const title = t(`'%s' not stable`, name);
		const text = t(
			`'%s' has not been stable for {{m.trendStartedAt|durationSince}} (fluctuation: {{m.trendMinToMax}} %s). You asked to be notified if this persists for %s.`,
			name,
			unit,
			durationText,
		);
		return { defaultTitle: title, defaultText: text };
	}

	/**
	 * Formats a duration (ms) using the same buckets as `MsgRender`.
	 *
	 * @param {number} ms Duration in ms.
	 * @returns {string} Formatted duration.
	 */
	_formatDuration(ms) {
		if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
			return '';
		}

		if (ms < 60000) {
			return `${Math.max(0, Math.round(ms / 1000))}s`;
		}
		if (ms < 60 * 60000) {
			return `${Math.max(0, Math.round(ms / 60000))}m`;
		}
		if (ms < 24 * 60 * 60000) {
			const totalMinutes = Math.max(0, Math.round(ms / 60000));
			const hours = Math.floor(totalMinutes / 60);
			const minutes = totalMinutes % 60;
			return `${hours}:${String(minutes).padStart(2, '0')}h`;
		}

		const totalHours = Math.max(0, Math.round(ms / 3600000));
		const days = Math.floor(totalHours / 24);
		const hours = totalHours % 24;
		return hours ? `${days}d ${hours}h` : `${days}d`;
	}

	/**
	 * @returns {boolean} True when a message exists and is non-terminal.
	 */
	_isMessageActive() {
		const ref = this.message.makeRef();
		const existing = this.message.ctx.api.store.getMessageByRef(ref);
		const state = existing?.lifecycle?.state || this.message.ctx.api.constants.lifecycle.state.open;
		return (
			!!existing &&
			state !== this.message.ctx.api.constants.lifecycle.state.closed &&
			state !== this.message.ctx.api.constants.lifecycle.state.expired &&
			state !== this.message.ctx.api.constants.lifecycle.state.deleted
		);
	}

	/**
	 * @param {string} id Object/state id.
	 * @returns {string} Best-effort display name.
	 */
	_fallbackName(id) {
		const str = String(id || '');
		const parts = str.split('.').filter(Boolean);
		return parts.length ? parts[parts.length - 1] : str;
	}

	/**
	 * Best-effort lookup of object meta (name/unit) for nicer defaults.
	 *
	 * @returns {void}
	 */
	_loadObjectMeta() {
		const ctx = this.message?.ctx;
		const getObj = ctx?.api?.iobroker?.objects?.getForeignObject;
		if (typeof getObj !== 'function') {
			return;
		}
		Promise.resolve()
			.then(() => getObj(this.targetId))
			.then(obj => {
				const n = obj?.common?.name;
				if (typeof n === 'string' && n.trim()) {
					this._name = n.trim();
				}
				const u = obj?.common?.unit;
				if (typeof u === 'string' && u.trim()) {
					this._unit = u.trim();
				}
			})
			.catch(() => undefined);
	}
}

module.exports = { NonSettlingRule };
