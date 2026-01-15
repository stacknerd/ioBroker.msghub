'use strict';

/**
 * Threshold rule (boundaries, ranges, booleans).
 *
 * Opens a message when the configured condition is true and keeps updating the current value as a metric.
 * Closing uses the shared message config (`msg-resetOnNormal`) once the value is ok again.
 */
class ThresholdRule {
	/**
	 * @param {object} info Rule inputs.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {object} info.ruleConfig Rule config (from `thr-*` keys).
	 * @param {object} info.message Target message writer.
	 * @param {object} [info.timers] Timer service (shared).
	 * @param {boolean} [info.traceEvents] Enable verbose debug logging.
	 */
	constructor({ targetId, ruleConfig = {}, message, timers = null, traceEvents = false }) {
		this.targetId = targetId;
		this.ruleConfig = ruleConfig || {};
		this.message = message;
		this.timers = timers;
		this._traceEvents = traceEvents === true;
		this._log = message?.ctx?.api?.log || null;

		this._mode = this._resolveMode();
		this._minDurationMs = this._resolveMinDurationMs();
		this._hysteresis = this._resolveHysteresis();

		this._name = this._fallbackName(targetId);
		this._unit = '';
		this._value = null;

		this._isActive = false; // message exists (open/acked/snoozed)
		this._conditionActive = false; // current condition is violated
		this._closeRequested = false;
		this._pendingTimerId = this._minDurationMs > 0 ? `thr:${this.targetId}` : null;
		this._pendingAt = null;
		this._activeSinceAt = null;

		this._loadObjectMeta();
		this._initValueFromForeignState();
		this._validateConfigOrThrow();

		this._trace(
			`start targetId='${this.targetId}' mode='${this._mode}' minDurationMs=${this._minDurationMs} hysteresis=${this._hysteresis}`,
		);

		if (this._pendingTimerId && this.timers?.get?.(this._pendingTimerId)) {
			const existing = this.timers.get(this._pendingTimerId);
			const at = existing?.at;
			if (typeof at === 'number' && Number.isFinite(at)) {
				this._pendingAt = Math.trunc(at);
			}
			const startedAt = existing?.data?.startedAt;
			if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
				this._activeSinceAt = Math.trunc(startedAt);
			} else if (this._pendingAt && this._minDurationMs > 0) {
				this._activeSinceAt = Math.trunc(this._pendingAt - this._minDurationMs);
			}
		}
	}

	/**
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

		this._log.debug(`Threshold ${_shorten(this.targetId)}: ${msg}`);
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

		this._value = value;

		const { active, ok } = this._evaluate(value);
		const now = Date.now();

		if (active) {
			if (!this._conditionActive) {
				this._activeSinceAt = now;
			}
			this._conditionActive = true;
			this._closeRequested = false;
			if (this._minDurationMs > 0 && !this._isActive) {
				if (typeof this._pendingAt === 'number' && Number.isFinite(this._pendingAt) && now >= this._pendingAt) {
					const startAt =
						typeof this._activeSinceAt === 'number' && Number.isFinite(this._activeSinceAt)
							? this._activeSinceAt
							: Math.trunc(this._pendingAt - this._minDurationMs);
					this._cancelPendingTimer();
					this._isActive = true;
					this._open(now, startAt);
					this._patchCurrentValue(now);
				} else {
					this._ensurePendingTimer(now);
				}
			} else {
				this._cancelPendingTimer();
				this._isActive = true;
				const startAt =
					typeof this._activeSinceAt === 'number' && Number.isFinite(this._activeSinceAt)
						? this._activeSinceAt
						: now;
				this._open(now, startAt);
				this._patchCurrentValue(now);
			}
			return;
		}

		if (ok) {
			this._conditionActive = false;
			this._activeSinceAt = null;
			this._cancelPendingTimer();
			if (this._isActive) {
				this._patchCurrentValue(now);
			}
			this._isActive = false;
			this._close(now);
		}
	}

	/**
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	onTick(now) {
		if (this._isActive) {
			this._patchCurrentValue(now);
		}
	}

	/**
	 * Handle a due timer event routed by the engine.
	 *
	 * @param {{ id: string, at: number, kind: string, data?: any }} timer Timer payload.
	 * @returns {void}
	 */
	onTimer(timer) {
		if (!timer || timer.kind !== 'threshold.minDuration' || timer.data?.targetId !== this.targetId) {
			return;
		}

		this._trace(`timer due id='${timer.id}' kind='${timer.kind}' at=${timer.at}`);
		this._pendingAt = null;

		const value = this._value;
		if (value === null) {
			return;
		}

		const { active } = this._evaluate(value);
		if (!active) {
			this._conditionActive = false;
			return;
		}

		this._conditionActive = true;
		this._isActive = true;

		const now = Date.now();
		const startedAt = timer?.data?.startedAt;
		const startAt =
			typeof startedAt === 'number' && Number.isFinite(startedAt)
				? Math.trunc(startedAt)
				: typeof timer?.at === 'number' && Number.isFinite(timer.at)
					? Math.trunc(timer.at - this._minDurationMs)
					: now;
		this._activeSinceAt = startAt;
		this._trace(`open after minDuration now=${now} value=${value}`);
		this._open(now, startAt);
		this._patchCurrentValue(now);
	}

	/**
	 * Dispose the rule instance.
	 *
	 * @returns {void}
	 */
	dispose() {
		this._cancelPendingTimer();
	}

	/**
	 * Validate `thr-*` config for the selected mode and throw on invalid configuration.
	 *
	 * @returns {void}
	 */
	_validateConfigOrThrow() {
		const cfg = this.ruleConfig;
		if (this._mode === 'lt' || this._mode === 'gt') {
			if (typeof cfg.value !== 'number' || !Number.isFinite(cfg.value)) {
				throw new Error(`ThresholdRule: thr-value must be a number for mode='${this._mode}'`);
			}
			return;
		}
		if (this._mode === 'outside' || this._mode === 'inside') {
			if (
				typeof cfg.min !== 'number' ||
				!Number.isFinite(cfg.min) ||
				typeof cfg.max !== 'number' ||
				!Number.isFinite(cfg.max)
			) {
				throw new Error(`ThresholdRule: thr-min/thr-max must be numbers for mode='${this._mode}'`);
			}
			return;
		}
	}

	/**
	 * @returns {string} Threshold mode identifier.
	 */
	_resolveMode() {
		const mode = typeof this.ruleConfig?.mode === 'string' ? this.ruleConfig.mode.trim() : '';
		if (
			mode === 'lt' ||
			mode === 'gt' ||
			mode === 'outside' ||
			mode === 'inside' ||
			mode === 'truthy' ||
			mode === 'falsy'
		) {
			return mode;
		}
		return 'lt';
	}

	/**
	 * @returns {number} Hysteresis (>= 0).
	 */
	_resolveHysteresis() {
		const h = this.ruleConfig?.hysteresis;
		if (typeof h === 'number' && Number.isFinite(h) && h > 0) {
			return h;
		}
		return 0;
	}

	/**
	 * @returns {number} `thr-minDuration*` in ms (0 when disabled/invalid).
	 */
	_resolveMinDurationMs() {
		const value = this.ruleConfig?.minDurationValue;
		const unitSeconds = this.ruleConfig?.minDurationUnit;
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
	 * @returns {number|boolean|null} Parsed value or null when invalid.
	 */
	_parseValue(val) {
		if (this._mode === 'truthy' || this._mode === 'falsy') {
			if (typeof val === 'boolean') {
				this._unit = 'bool';
				return val;
			}
			if (typeof val === 'number' && Number.isFinite(val)) {
				this._unit = 'bool';
				return Boolean(val);
			}
			if (typeof val === 'string') {
				const s = val.trim().toLowerCase();
				if (s === 'true') {
					this._unit = 'bool';
					return true;
				}
				if (s === 'false') {
					this._unit = 'bool';
					return false;
				}
				this._unit = 'bool';
				return Boolean(s);
			}
			return null;
		}

		const n = typeof val === 'number' ? val : typeof val === 'string' ? Number(val.trim()) : NaN;
		if (!Number.isFinite(n)) {
			return null;
		}
		return n;
	}

	/**
	 * @param {number|boolean} value Parsed value.
	 * @returns {{ active: boolean, ok: boolean }} Condition state.
	 */
	_evaluate(value) {
		const cfg = this.ruleConfig;
		const h = this._hysteresis;

		if (this._mode === 'truthy') {
			const v = Boolean(value);
			return { active: v === true, ok: v === false };
		}
		if (this._mode === 'falsy') {
			const v = Boolean(value);
			return { active: v === false, ok: v === true };
		}

		const v = value;
		if (typeof v !== 'number') {
			return { active: false, ok: false };
		}

		if (this._mode === 'lt') {
			const limit = cfg.value;
			return { active: v < limit, ok: v >= limit + h };
		}
		if (this._mode === 'gt') {
			const limit = cfg.value;
			return { active: v > limit, ok: v <= limit - h };
		}
		if (this._mode === 'outside') {
			const min = cfg.min;
			const max = cfg.max;
			const okMin = min + h;
			const okMax = max - h;
			return { active: v < min || v > max, ok: okMin <= okMax && v >= okMin && v <= okMax };
		}
		if (this._mode === 'inside') {
			const min = cfg.min;
			const max = cfg.max;
			const okMin = min - h;
			const okMax = max + h;
			return { active: v >= min && v <= max, ok: v < okMin || v > okMax };
		}

		return { active: false, ok: true };
	}

	/**
	 * Resolve the numeric "recovery bounds" derived from the configured threshold/range and hysteresis.
	 *
	 * These bounds are intended for rendering guidance text via metrics (`m.state-min`/`m.state-max`).
	 *
	 * @returns {{ min: number|null, max: number|null }} Bounds (missing entries are null).
	 */
	_resolveRecoveryBounds() {
		const cfg = this.ruleConfig;
		const h = this._hysteresis;

		if (this._mode === 'lt') {
			const min = typeof cfg.value === 'number' && Number.isFinite(cfg.value) ? cfg.value + h : null;
			return { min: typeof min === 'number' && Number.isFinite(min) ? min : null, max: null };
		}
		if (this._mode === 'gt') {
			const max = typeof cfg.value === 'number' && Number.isFinite(cfg.value) ? cfg.value - h : null;
			return { min: null, max: typeof max === 'number' && Number.isFinite(max) ? max : null };
		}
		if (this._mode === 'outside') {
			const min = typeof cfg.min === 'number' && Number.isFinite(cfg.min) ? cfg.min + h : null;
			const max = typeof cfg.max === 'number' && Number.isFinite(cfg.max) ? cfg.max - h : null;
			if (
				typeof min !== 'number' ||
				typeof max !== 'number' ||
				!Number.isFinite(min) ||
				!Number.isFinite(max) ||
				min > max
			) {
				return { min: null, max: null };
			}
			return { min, max };
		}
		if (this._mode === 'inside') {
			const min = typeof cfg.min === 'number' && Number.isFinite(cfg.min) ? cfg.min - h : null;
			const max = typeof cfg.max === 'number' && Number.isFinite(cfg.max) ? cfg.max + h : null;
			if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max)) {
				return { min: null, max: null };
			}
			return { min, max };
		}

		return { min: null, max: null };
	}

	/**
	 * Open (or reopen) the message and apply default title/text/actions.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @param {number} startAt first occurance of the causing state (for timing.startAt)
	 * @returns {void}
	 */
	_open(now, startAt) {
		const t = this.message.ctx.api.i18n.t;

		const actions = [
			{ id: 'ack', type: 'ack' },
			{ id: 'snooze-4h', type: 'snooze', payload: { forMs: 4 * 60 * 60 * 1000 } },
		];

		const { defaultTitle, defaultText } = this._buildDefaultText(t);
		const unit = this._unit || '';
		const metrics = {};
		if (this._value !== null) {
			metrics['state-value'] = { val: this._value, unit };
		}
		const { min, max } = this._resolveRecoveryBounds();
		if (typeof min === 'number' && Number.isFinite(min)) {
			metrics['state-min'] = { val: min, unit };
		}
		if (typeof max === 'number' && Number.isFinite(max)) {
			metrics['state-max'] = { val: max, unit };
		}

		this.message.openActive({ defaultTitle, defaultText, now, startAt, actions, metrics });
	}

	/**
	 * Schedule closing the message when the condition returns to normal.
	 *
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
	 * Patch the current value into message metrics as `state-value`.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_patchCurrentValue(now) {
		if (this._value === null) {
			return;
		}

		this.message.patchMetrics({
			set: {
				'state-value': { val: this._value, unit: this._unit || '' },
			},
			now,
		});
	}

	/**
	 * Ensure the `minDuration` timer exists and is due in the future (best-effort).
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_ensurePendingTimer(now) {
		if (!this._pendingTimerId || !this.timers) {
			return;
		}
		if (typeof this._pendingAt === 'number' && Number.isFinite(this._pendingAt) && this._pendingAt > now) {
			return;
		}

		const at = now + this._minDurationMs;
		this._pendingAt = at;
		this._trace(
			`start timer kind='threshold.minDuration' id='${this._pendingTimerId}' inMs=${Math.max(0, at - now)} at=${at}`,
		);
		this.timers.set(this._pendingTimerId, at, 'threshold.minDuration', {
			targetId: this.targetId,
			startedAt:
				typeof this._activeSinceAt === 'number' && Number.isFinite(this._activeSinceAt)
					? Math.trunc(this._activeSinceAt)
					: now,
		});
	}

	/**
	 * Cancel the pending `minDuration` timer (if any).
	 *
	 * @returns {void}
	 */
	_cancelPendingTimer() {
		if (!this._pendingTimerId || !this.timers) {
			return;
		}
		this._pendingAt = null;
		this._activeSinceAt = null;
		this._trace(`cancel timer id='${this._pendingTimerId}'`);
		this.timers.delete(this._pendingTimerId);
	}

	/**
	 * Bootstrap the current value from ioBroker state once (best-effort).
	 *
	 * @returns {void}
	 */
	_initValueFromForeignState() {
		const ctx = this.message?.ctx;
		const getState = ctx?.api?.iobroker?.states?.getForeignState;
		if (typeof getState !== 'function') {
			return;
		}

		Promise.resolve()
			.then(() => getState(this.targetId))
			.then(st => {
				if (this._traceEvents) {
					let v = '<missing>';
					if (st) {
						try {
							v = JSON.stringify(st.val);
						} catch {
							v = '[unstringifiable]';
						}
					}
					const ts = typeof st?.ts === 'number' && Number.isFinite(st.ts) ? Math.trunc(st.ts) : null;
					const lc = typeof st?.lc === 'number' && Number.isFinite(st.lc) ? Math.trunc(st.lc) : null;
					this._trace(`bootstrap state val=${v} ts=${ts} lc=${lc}`);
				}
				const value = this._parseValue(st?.val);
				if (value === null) {
					return;
				}

				this._value = value;
				const { active, ok } = this._evaluate(value);
				if (active) {
					this._conditionActive = true;
					const now = Date.now();
					this._activeSinceAt = now;
					this._trace(`bootstrap evaluate active=true now=${now} value=${value}`);
					if (this._minDurationMs > 0 && !this._isActive) {
						this._ensurePendingTimer(now);
						return;
					}
					this._cancelPendingTimer();
					this._isActive = true;
					this._open(now, now);
					this._patchCurrentValue(now);
					return;
				}
				if (ok) {
					this._trace(`bootstrap evaluate ok=true (no open)`);
					this._conditionActive = false;
				}
			})
			.catch(() => undefined);
	}

	/**
	 * @param {(key: string, ...args: any[]) => string} t Translator.
	 * @returns {{ defaultTitle: string, defaultText: string }} Default text blocks.
	 */
	_buildDefaultText(t) {
		const name = this._name;

		const startedAtVariants = [
			`\nThis started on {{t.startAt|datetime}}.`,
			`\nThis first happened on {{t.startAt|datetime}}.`,
			`\nFirst noticed on {{t.startAt|datetime}}.`,
			`\nIt’s been like this since {{t.startAt|datetime}}.`,
			`\nThis has been going on since {{t.startAt|datetime}}.`,
			`\nThis began on {{t.startAt|datetime}}.`,
		];
		const startedAtLine = t(startedAtVariants[Math.floor(Math.random() * startedAtVariants.length)]);

		const pick = variants => variants[Math.floor(Math.random() * variants.length)];

		let defaultTitle = name;
		let defaultText;

		if (this._mode === 'truthy') {
			defaultTitle = t(`'%s' boolean condition`, name);
			defaultText = t(
				pick([
					`For '%s', it’s currently {{m.state-value|bool:TRUE/FALSE}}.\nI’ll clear this message once it switches to FALSE.`,
					`Quick heads-up: '%s' is {{m.state-value|bool:TRUE/FALSE}} right now.\nI’ll clear this as soon as it flips to FALSE.`,
					`Just so you know, '%s' is currently {{m.state-value|bool:TRUE/FALSE}}.\nOnce it turns FALSE again, this message goes away.`,
				]),
				name,
			);
		} else if (this._mode === 'falsy') {
			defaultTitle = t(`'%s' boolean condition`, name);
			defaultText = t(
				pick([
					`For '%s', it’s currently {{m.state-value|bool:TRUE/FALSE}}.\nI’ll clear this message once it switches to TRUE.`,
					`FYI: '%s' reads {{m.state-value|bool:TRUE/FALSE}} right now.\nI’ll clear this once it becomes TRUE.`,
					`Right now '%s' is {{m.state-value|bool:TRUE/FALSE}}.\nAs soon as it flips to TRUE, I’ll drop this message.`,
				]),
				name,
			);
		} else if (this._mode === 'lt') {
			defaultTitle = t(`'%s' outside the limit`, name);
			defaultText = t(
				pick([
					`For '%s', the value is {{m.state-value}} — that’s too low.\nOnce it’s back to at least {{m.state-min}}, everything is fine again.`,
					`'%s' is currently at {{m.state-value}}, which is below the limit.\nWhen it reaches {{m.state-min}} or more, we’re good again.`,
					`Heads-up: '%s' dropped to {{m.state-value}}.\nI’ll clear this once it climbs back to {{m.state-min}} or higher.`,
				]),
				name,
			);
		} else if (this._mode === 'gt') {
			defaultTitle = t(`'%s' outside the limit`, name);
			defaultText = t(
				pick([
					`For '%s', the value is {{m.state-value}} — that’s too high.\nOnce it’s back to at most {{m.state-max}}, everything is fine again.`,
					`'%s' is currently at {{m.state-value}}, which is above the limit.\nWhen it drops back to {{m.state-max}} or less, things are fine again.`,
					`Quick heads-up: '%s' is at {{m.state-value}} — that’s higher than it should be.\nI’ll clear this once it’s back down to {{m.state-max}} or below.`,
				]),
				name,
			);
		} else if (this._mode === 'outside') {
			defaultTitle = t(`'%s' outside the range`, name);
			defaultText = t(
				pick([
					`For '%s', the value is {{m.state-value}} — it’s outside the desired range.\nOnce it’s back between {{m.state-min}} and {{m.state-max}}, everything is fine again.`,
					`'%s' is at {{m.state-value}}, which is outside the target range.\nWhen it’s between {{m.state-min}} and {{m.state-max}} again, we’re all good.`,
					`FYI: '%s' is currently {{m.state-value}} and out of range.\nI’ll clear this once it’s back in the {{m.state-min}}…{{m.state-max}} window.`,
				]),
				name,
			);
		} else if (this._mode === 'inside') {
			defaultTitle = t(`'%s' inside the range`, name);
			defaultText = t(
				pick([
					`For '%s', the value is {{m.state-value}} — it’s in the desired range (and right now it shouldn’t be).\nOnce it drops below {{m.state-min}} or rises above {{m.state-max}}, everything is fine again.`,
					`'%s' is currently at {{m.state-value}} — it’s inside the range (and that’s not what we want right now).\nI’ll clear this once it goes below {{m.state-min}} or above {{m.state-max}}.`,
					`Heads-up: '%s' is sitting at {{m.state-value}} within the range.\nThis message clears when it leaves the range (below {{m.state-min}} or above {{m.state-max}}).`,
				]),
				name,
			);
		}

		return { defaultTitle, defaultText: `${defaultText}${startedAtLine}` };
	}

	/**
	 * @param {number} n Numeric value.
	 * @returns {string} Short string.
	 */
	_formatNumber(n) {
		if (typeof n !== 'number' || !Number.isFinite(n)) {
			return '';
		}
		return String(n);
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

module.exports = { ThresholdRule };
