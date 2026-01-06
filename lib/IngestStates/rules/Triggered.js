'use strict';

/**
 * Triggered rule (dependency window).
 *
 * Use-case: when a trigger becomes active, the monitored datapoint must react within a time window.
 * If not, an alert message is opened.
 *
 * Window start semantics:
 * - The window starts only on trigger activation (rising edge).
 * - If the trigger goes inactive before the window ends, the timer is cancelled and no message is created.
 *
 * Recovery:
 * - If the expectation becomes true after the message exists, it is closed via `msg-resetOnNormal`/`msg-resetDelay*`.
 * - If the trigger becomes inactive while a message exists, the message is also closed (cause eliminated).
 *
 * Persistent timers (`TimerService`) are used for the window so `evaluateIntervalMs=0` (event-only) still works.
 */
class TriggeredRule {
	/**
	 * @param {object} info Rule inputs.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {object} info.ruleConfig Rule config (from `trg-*` keys).
	 * @param {object} info.message Target message writer.
	 * @param {object} info.timers Timer service (shared).
	 * @param {boolean} [info.traceEvents] Enable verbose debug logging.
	 */
	constructor({ targetId, ruleConfig = {}, message, timers = null, traceEvents = false }) {
		this.targetId = targetId;
		this.ruleConfig = ruleConfig || {};
		this.message = message;
		this.timers = timers;
		this._traceEvents = traceEvents === true;
		this._log = message?.ctx?.api?.log || null;

		if (!this.timers) {
			throw new Error('TriggeredRule: timers are required');
		}

		this._triggerId = this._requireId(this.ruleConfig?.id, 'trg-id');
		this._operator = this._resolveOperator();
		this._valueType = this._resolveValueType();
		this._cmpValue = this._resolveTriggerCompareValue();

		this._expectation = this._resolveExpectation();
		this._windowMs = this._resolveWindowMs();
		if (!this._windowMs) {
			throw new Error('TriggeredRule: invalid trg-windowValue/trg-windowUnit config');
		}

		this._name = this._fallbackName(targetId);
		this._triggerName = this._fallbackName(this._triggerId);
		this._unit = 'n/a';
		this._triggerUnit = '';

		this._targetLc = null;
		this._targetValRaw = null;
		this._targetValNum = null;

		this._triggerValRaw = null;
		this._triggerActive = false;

		this._window = null; // { startedAt, baselineLc, baselineVal }
		this._pendingTimerId = `trg:${this.targetId}`;
		this._pendingAt = null;

		this._isActive = false; // message exists (open/acked/snoozed)
		this._conditionActive = false; // violation active (window expired and unmet)
		this._closeRequested = false;

		this._loadObjectMeta();
		this._initFromForeignStates();
		this._restorePendingTimer();

		this._trace(
			`start targetId='${this.targetId}' triggerId='${this._triggerId}' operator='${this._operator}' expectation='${this._expectation}' windowMs=${this._windowMs}`,
		);
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

		const prefix = this.message?.ctx?.meta?.plugin?.baseOwnId || 'IngestStates';
		this._log.debug(`${prefix} Triggered ${_shorten(this.targetId)}: ${msg}`);
	}

	/**
	 * @returns {Set<string>} Required foreign state ids.
	 */
	requiredStateIds() {
		const ids = new Set([this.targetId]);
		ids.add(this._triggerId);
		return ids;
	}

	/**
	 * @param {string} id State id.
	 * @param {object} state ioBroker state.
	 * @returns {void}
	 */
	onStateChange(id, state) {
		if (id === this._triggerId) {
			this._triggerValRaw = state?.val;
			const nextActive = this._isTriggerActive(state?.val);
			const wasActive = this._triggerActive;
			this._triggerActive = nextActive;

			const now = Date.now();

			if (!wasActive && nextActive) {
				this._startWindow(now);
				return;
			}
			if (wasActive && !nextActive) {
				this._cancelWindow();
				this._conditionActive = false;
				this._isActive = false;
				this._closeIfRequested(now);
				return;
			}

			// Trigger still active: only update metrics when a message exists.
			if (this._conditionActive) {
				this._patchMetrics(now);
			}
			return;
		}

		if (id !== this.targetId) {
			return;
		}

		this._targetValRaw = state?.val;
		this._targetValNum = this._parseNumber(state?.val);

		const lc = state?.lc;
		if (typeof lc === 'number' && Number.isFinite(lc)) {
			this._targetLc = Math.trunc(lc);
		}

		const now = Date.now();

		if (this._window && this._triggerActive) {
			if (this._isExpectationMet()) {
				this._cancelWindow();
				this._conditionActive = false;
				this._isActive = false;
				this._closeIfRequested(now);
				return;
			}
		}

		if (this._conditionActive) {
			this._patchMetrics(now);
		}
	}

	/**
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	onTick(now) {
		if (!this._conditionActive) {
			this.message.tryCloseScheduled({ now });
			return;
		}

		this._patchMetrics(now);
		if (this._triggerActive && this._isExpectationMet()) {
			this._conditionActive = false;
			this._isActive = false;
			this._closeIfRequested(now);
		}
	}

	/**
	 * Handle a due timer event routed by the engine.
	 *
	 * @param {{ id: string, at: number, kind: string, data?: any }} timer Timer payload.
	 * @returns {void}
	 */
	onTimer(timer) {
		if (!timer || timer.kind !== 'triggered.window' || timer.data?.targetId !== this.targetId) {
			return;
		}

		this._trace(`timer due id='${timer.id}' at=${timer.at} pendingAt=${this._pendingAt}`);
		this._pendingAt = null;
		if (!this._window && timer.data && typeof timer.data === 'object') {
			this._window = {
				startedAt: timer.data.startedAt,
				baselineLc: timer.data.baselineLc,
				baselineVal: timer.data.baselineVal,
			};
		}

		Promise.resolve()
			.then(() => this._ensureFreshStates())
			.then(() => {
				const now = Date.now();

				if (!this._triggerActive) {
					this._cancelWindow();
					return;
				}

				if (this._isExpectationMet()) {
					this._cancelWindow();
					return;
				}

				this._open(now);
			})
			.catch(() => undefined);
	}

	/**
	 * Dispose the rule instance.
	 *
	 * @returns {void}
	 */
	dispose() {
		this._cancelWindow();
	}

	/**
	 * Start a new trigger window and persist it via `TimerService`.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_startWindow(now) {
		this._closeRequested = false;

		const baselineLc =
			typeof this._targetLc === 'number' && Number.isFinite(this._targetLc) ? this._targetLc : null;
		const baselineVal =
			typeof this._targetValNum === 'number' && Number.isFinite(this._targetValNum) ? this._targetValNum : null;

		this._window = { startedAt: now, baselineLc, baselineVal };

		const at = now + this._windowMs;
		this._pendingAt = at;
		this._trace(
			`start timer kind='triggered.window' id='${this._pendingTimerId}' inMs=${Math.max(0, at - now)} at=${at}`,
		);
		this.timers.set(this._pendingTimerId, at, 'triggered.window', {
			targetId: this.targetId,
			startedAt: now,
			baselineLc,
			baselineVal,
		});

		// If we don't have the baseline yet (e.g. missing lc/value), try to fetch it once.
		this._ensureBaselineFromForeignState();
	}

	/**
	 * Cancel the pending trigger window (if any).
	 *
	 * @returns {void}
	 */
	_cancelWindow() {
		this._window = null;
		this._pendingAt = null;
		this._trace(`cancel timer id='${this._pendingTimerId}' (trigger window)`);
		this.timers.delete(this._pendingTimerId);
	}

	/**
	 * Restore an existing window from persisted timers (best-effort).
	 *
	 * @returns {void}
	 */
	_restorePendingTimer() {
		const existing = this.timers.get(this._pendingTimerId);
		if (!existing || existing.kind !== 'triggered.window' || existing.data?.targetId !== this.targetId) {
			return;
		}
		const at = existing?.at;
		if (typeof at === 'number' && Number.isFinite(at)) {
			this._pendingAt = Math.trunc(at);
		}

		const startedAt = existing?.data?.startedAt;
		this._window = {
			startedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) ? Math.trunc(startedAt) : Date.now(),
			baselineLc: existing?.data?.baselineLc,
			baselineVal: existing?.data?.baselineVal,
		};
	}

	/**
	 * Open the alert message and seed metrics.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_open(now) {
		this._isActive = true;
		this._conditionActive = true;
		this._closeRequested = false;

		const t = this.message.ctx.api.i18n.t;
		const name = this._name;
		const trgName = this._triggerName;

		const windowText = this._formatDuration(this._windowMs);
		const expectedText = this._describeExpectation();

		const defaultTitle = t(`'%s' did not react`, name);
		const defaultText = t(
			`Trigger '%s' is active, but '%s' did not react within %s (expected: %s). Current value: {{m.state-value}}.`,
			trgName,
			name,
			windowText,
			expectedText,
		);

		const actions = [
			{ id: 'ack', type: 'ack' },
			{ id: 'snooze-4h', type: 'snooze', payload: { forMs: 4 * 60 * 60 * 1000 } },
			{ id: 'close', type: 'close' },
		];

		this.message.openActive({ defaultTitle, defaultText, now, actions });
		this._patchMetrics(now, true);
	}

	/**
	 * Patch message metrics (state + trigger values).
	 *
	 * @param {number} now Current timestamp (ms).
	 * @param {boolean} [force] When true, bypass throttling.
	 * @returns {void}
	 */
	_patchMetrics(now, force = false) {
		const stateVal = this._normalizeMetricValue(this._targetValRaw, this._targetValNum);
		const trgVal = this._triggerValRaw;

		this.message.patchMetrics({
			set: {
				'state-value': { val: stateVal, unit: this._unit || 'n/a' },
				'trigger-value': { val: trgVal == null ? null : trgVal, unit: this._triggerUnit || '' },
			},
			now,
			force,
		});
	}

	/**
	 * Schedule closing the message (cause eliminated) if configured.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_closeIfRequested(now) {
		this.message.tryCloseScheduled({ now });
		if (!this._closeRequested) {
			this._closeRequested = true;
			this.message.closeOnNormal();
		}
	}

	/**
	 * Evaluate if the expectation condition is met (based on the baseline captured at window start).
	 *
	 * @returns {boolean} True when expectation is met.
	 */
	_isExpectationMet() {
		if (!this._window) {
			return false;
		}

		const expectation = this._expectation;
		if (expectation === 'changed') {
			const baselineLc = this._window.baselineLc;
			if (typeof baselineLc !== 'number' || !Number.isFinite(baselineLc)) {
				return false;
			}
			const lc = this._targetLc;
			return typeof lc === 'number' && Number.isFinite(lc) && lc !== baselineLc;
		}

		const value = this._targetValNum;
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			return false;
		}

		if (expectation === 'deltaUp') {
			const baselineVal = this._window.baselineVal;
			return (
				typeof baselineVal === 'number' &&
				Number.isFinite(baselineVal) &&
				value - baselineVal >= (this.ruleConfig?.minDelta || 0)
			);
		}
		if (expectation === 'deltaDown') {
			const baselineVal = this._window.baselineVal;
			return (
				typeof baselineVal === 'number' &&
				Number.isFinite(baselineVal) &&
				baselineVal - value >= (this.ruleConfig?.minDelta || 0)
			);
		}
		if (expectation === 'thresholdGte') {
			return value >= this.ruleConfig.threshold;
		}
		if (expectation === 'thresholdLte') {
			return value <= this.ruleConfig.threshold;
		}
		return false;
	}

	/**
	 * Render a human-readable description of the expected reaction.
	 *
	 * @returns {string} Expectation description.
	 */
	_describeExpectation() {
		const t = this.message.ctx.api.i18n.t;
		const e = this._expectation;
		if (e === 'changed') {
			return t('a value change');
		}
		if (e === 'deltaUp') {
			return t('an increase by at least %s', this._formatNumber(this.ruleConfig.minDelta));
		}
		if (e === 'deltaDown') {
			return t('a decrease by at least %s', this._formatNumber(this.ruleConfig.minDelta));
		}
		if (e === 'thresholdGte') {
			return t('to become >= %s', this._formatNumber(this.ruleConfig.threshold));
		}
		if (e === 'thresholdLte') {
			return t('to become <= %s', this._formatNumber(this.ruleConfig.threshold));
		}
		return t('a reaction');
	}

	/**
	 * Resolve expectation mode from config (`trg-expectation`) and validate dependent fields.
	 *
	 * @returns {string} Resolved expectation key.
	 */
	_resolveExpectation() {
		const exp = typeof this.ruleConfig?.expectation === 'string' ? this.ruleConfig.expectation.trim() : '';
		if (
			exp === 'changed' ||
			exp === 'deltaUp' ||
			exp === 'deltaDown' ||
			exp === 'thresholdGte' ||
			exp === 'thresholdLte'
		) {
			if (
				(exp === 'deltaUp' || exp === 'deltaDown') &&
				!(typeof this.ruleConfig?.minDelta === 'number' && Number.isFinite(this.ruleConfig.minDelta))
			) {
				throw new Error(`TriggeredRule: trg-minDelta must be a number for expectation='${exp}'`);
			}
			if (
				(exp === 'thresholdGte' || exp === 'thresholdLte') &&
				!(typeof this.ruleConfig?.threshold === 'number' && Number.isFinite(this.ruleConfig.threshold))
			) {
				throw new Error(`TriggeredRule: trg-threshold must be a number for expectation='${exp}'`);
			}
			return exp;
		}
		return 'changed';
	}

	/**
	 * Resolve trigger window duration in milliseconds.
	 *
	 * @returns {number} Window duration in ms, or 0 when invalid.
	 */
	_resolveWindowMs() {
		const value = this.ruleConfig?.windowValue;
		const unitSeconds = this.ruleConfig?.windowUnit;
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
	 * Resolve comparison operator used for the trigger (`trg-operator`).
	 *
	 * @returns {string} Operator key.
	 */
	_resolveOperator() {
		const op = typeof this.ruleConfig?.operator === 'string' ? this.ruleConfig.operator.trim() : '';
		if (op === 'eq' || op === 'neq' || op === 'gt' || op === 'lt' || op === 'truthy' || op === 'falsy') {
			return op;
		}
		return 'eq';
	}

	/**
	 * Resolve trigger value type (`trg-valueType`).
	 *
	 * @returns {string} Value type (`boolean|number|string`).
	 */
	_resolveValueType() {
		const type = typeof this.ruleConfig?.valueType === 'string' ? this.ruleConfig.valueType.trim() : '';
		if (type === 'boolean' || type === 'number' || type === 'string') {
			return type;
		}
		return 'boolean';
	}

	/**
	 * Resolve the comparison value for the trigger, based on operator and type.
	 *
	 * @returns {string|number|boolean|undefined} Compare value.
	 */
	_resolveTriggerCompareValue() {
		if (this._operator === 'truthy' || this._operator === 'falsy') {
			return undefined;
		}
		if (this._operator === 'gt' || this._operator === 'lt') {
			if (this._valueType !== 'number') {
				throw new Error(`TriggeredRule: trg-valueType must be 'number' for operator='${this._operator}'`);
			}
			const n = this.ruleConfig?.valueNumber;
			if (typeof n !== 'number' || !Number.isFinite(n)) {
				throw new Error(`TriggeredRule: trg-valueNumber must be a number for operator='${this._operator}'`);
			}
			return n;
		}
		if (this._valueType === 'boolean') {
			return this.ruleConfig?.valueBool === true;
		}
		if (this._valueType === 'number') {
			const n = this.ruleConfig?.valueNumber;
			if (typeof n !== 'number' || !Number.isFinite(n)) {
				throw new Error(`TriggeredRule: trg-valueNumber must be a number for valueType='number'`);
			}
			return n;
		}
		const s = this.ruleConfig?.valueString;
		if (typeof s !== 'string') {
			throw new Error(`TriggeredRule: trg-valueString must be a string for valueType='string'`);
		}
		return s;
	}

	/**
	 * Check whether the current trigger state is considered active.
	 *
	 * @param {any} val Trigger raw value.
	 * @returns {boolean} True when active.
	 */
	_isTriggerActive(val) {
		const op = this._operator;
		if (op === 'truthy') {
			return Boolean(val);
		}
		if (op === 'falsy') {
			return !val;
		}

		const parsed = this._parseByType(val, this._valueType);
		const cmp = this._cmpValue;

		if (op === 'eq') {
			return parsed === cmp;
		}
		if (op === 'neq') {
			return parsed !== cmp;
		}
		if (op === 'gt') {
			if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
				return false;
			}
			if (typeof cmp !== 'number' || !Number.isFinite(cmp)) {
				return false;
			}
			return parsed > cmp;
		}
		if (op === 'lt') {
			if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
				return false;
			}
			if (typeof cmp !== 'number' || !Number.isFinite(cmp)) {
				return false;
			}
			return parsed < cmp;
		}
		return false;
	}

	/**
	 * Parse a raw value into the configured value type.
	 *
	 * @param {any} val Raw value.
	 * @param {string} type Desired type.
	 * @returns {string|number|boolean|null} Parsed value.
	 */
	_parseByType(val, type) {
		if (type === 'number') {
			return this._parseNumber(val);
		}
		if (type === 'string') {
			return typeof val === 'string' ? val : val == null ? '' : String(val);
		}
		// boolean
		if (typeof val === 'boolean') {
			return val;
		}
		if (typeof val === 'number' && Number.isFinite(val)) {
			return Boolean(val);
		}
		if (typeof val === 'string') {
			const s = val.trim().toLowerCase();
			if (s === 'true') {
				return true;
			}
			if (s === 'false') {
				return false;
			}
			return Boolean(s);
		}
		return Boolean(val);
	}

	/**
	 * Parse a numeric value (number or numeric string).
	 *
	 * @param {any} val Raw value.
	 * @returns {number|null} Parsed number or null.
	 */
	_parseNumber(val) {
		if (typeof val === 'number' && Number.isFinite(val)) {
			return val;
		}
		if (typeof val === 'string') {
			const n = Number(val.trim());
			return Number.isFinite(n) ? n : null;
		}
		return null;
	}

	/**
	 * Normalize value for metrics: prefer numeric when available, otherwise fall back to raw.
	 *
	 * @param {any} raw Raw value.
	 * @param {number|null} num Parsed numeric value.
	 * @returns {number|string|boolean|null} Normalized metric value.
	 */
	_normalizeMetricValue(raw, num) {
		if (typeof num === 'number' && Number.isFinite(num)) {
			return num;
		}
		if (typeof raw === 'boolean') {
			return raw;
		}
		if (raw == null) {
			return null;
		}
		return typeof raw === 'string' ? raw : String(raw);
	}

	/**
	 * Format a number for user-visible text.
	 *
	 * @param {number} n Number.
	 * @returns {string} Formatted value.
	 */
	_formatNumber(n) {
		if (typeof n === 'number' && Number.isFinite(n)) {
			return String(n);
		}
		return 'n/a';
	}

	/**
	 * Format a duration in a compact way (best-effort).
	 *
	 * @param {number} ms Duration in ms.
	 * @returns {string} Formatted duration.
	 */
	_formatDuration(ms) {
		const s = Math.trunc(ms / 1000);
		if (s < 60) {
			return `${s}s`;
		}
		const m = Math.trunc(s / 60);
		if (m < 60) {
			return `${m}m`;
		}
		const h = Math.trunc(m / 60);
		if (h < 24) {
			return `${h}h`;
		}
		const d = Math.trunc(h / 24);
		return `${d}d`;
	}

	/**
	 * Fallback name for an id (last segment of dot-separated id).
	 *
	 * @param {string} id Object/state id.
	 * @returns {string} Name.
	 */
	_fallbackName(id) {
		const str = String(id || '');
		const parts = str.split('.').filter(Boolean);
		return parts.length ? parts[parts.length - 1] : str;
	}

	/**
	 * Require a non-empty string id.
	 *
	 * @param {any} id Candidate id.
	 * @param {string} label Human-readable config key.
	 * @returns {string} Normalized id.
	 */
	_requireId(id, label) {
		const str = typeof id === 'string' ? id.trim() : '';
		if (!str) {
			throw new Error(`TriggeredRule: ${label} must be set`);
		}
		return str;
	}

	/**
	 * Load object metadata for nicer title/text and metric units (best-effort).
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

		Promise.resolve()
			.then(() => getObj(this._triggerId))
			.then(obj => {
				const n = obj?.common?.name;
				if (typeof n === 'string' && n.trim()) {
					this._triggerName = n.trim();
				}
				const u = obj?.common?.unit;
				if (typeof u === 'string' && u.trim()) {
					this._triggerUnit = u.trim();
				}
			})
			.catch(() => undefined);
	}

	/**
	 * Load initial foreign states for baseline/metrics (best-effort).
	 *
	 * @returns {void}
	 */
	_initFromForeignStates() {
		const ctx = this.message?.ctx;
		const getState = ctx?.api?.iobroker?.states?.getForeignState;
		if (typeof getState !== 'function') {
			return;
		}

		Promise.resolve()
			.then(async () => {
				const [target, trigger] = await Promise.all([getState(this.targetId), getState(this._triggerId)]);
				if (this._traceEvents) {
					let tVal = '[unavailable]';
					let trgVal = '[unavailable]';
					try {
						tVal = JSON.stringify(target?.val);
					} catch {
						tVal = '[unstringifiable]';
					}
					try {
						trgVal = JSON.stringify(trigger?.val);
					} catch {
						trgVal = '[unstringifiable]';
					}
					this._trace(`bootstrap states target.val=${tVal} trigger.val=${trgVal}`);
				}
				this._applyTargetState(target);
				this._applyTriggerState(trigger);
			})
			.catch(() => undefined);
	}

	/**
	 * Refresh both target and trigger foreign states (best-effort).
	 *
	 * @returns {Promise<void>|undefined} Promise when `getForeignState` is available.
	 */
	_ensureFreshStates() {
		const ctx = this.message?.ctx;
		const getState = ctx?.api?.iobroker?.states?.getForeignState;
		if (typeof getState !== 'function') {
			return;
		}

		return Promise.resolve()
			.then(async () => {
				const [target, trigger] = await Promise.all([getState(this.targetId), getState(this._triggerId)]);
				if (this._traceEvents) {
					let tVal = '[unavailable]';
					let trgVal = '[unavailable]';
					try {
						tVal = JSON.stringify(target?.val);
					} catch {
						tVal = '[unstringifiable]';
					}
					try {
						trgVal = JSON.stringify(trigger?.val);
					} catch {
						trgVal = '[unstringifiable]';
					}
					this._trace(`refresh states target.val=${tVal} trigger.val=${trgVal}`);
				}
				this._applyTargetState(target);
				this._applyTriggerState(trigger);
			})
			.catch(() => undefined);
	}

	/**
	 * Apply a foreign state update for the monitored target.
	 *
	 * @param {object|null|undefined} st Foreign state.
	 * @returns {void}
	 */
	_applyTargetState(st) {
		if (!st) {
			return;
		}
		this._targetValRaw = st?.val;
		this._targetValNum = this._parseNumber(st?.val);
		const lc = st?.lc;
		if (typeof lc === 'number' && Number.isFinite(lc)) {
			this._targetLc = Math.trunc(lc);
		}
	}

	/**
	 * Apply a foreign state update for the trigger.
	 *
	 * @param {object|null|undefined} st Foreign state.
	 * @returns {void}
	 */
	_applyTriggerState(st) {
		if (!st) {
			return;
		}
		this._triggerValRaw = st?.val;
		this._triggerActive = this._isTriggerActive(st?.val);
	}

	/**
	 * Ensure the baseline values are populated by fetching the current target state once (best-effort).
	 *
	 * @returns {void}
	 */
	_ensureBaselineFromForeignState() {
		if (!this._window) {
			return;
		}
		if (this._window.baselineLc != null && this._window.baselineVal != null) {
			return;
		}

		const ctx = this.message?.ctx;
		const getState = ctx?.api?.iobroker?.states?.getForeignState;
		if (typeof getState !== 'function') {
			return;
		}

		Promise.resolve()
			.then(() => getState(this.targetId))
			.then(st => {
				if (!this._window) {
					return;
				}
				const lc = st?.lc;
				if (this._window.baselineLc == null && typeof lc === 'number' && Number.isFinite(lc)) {
					this._window.baselineLc = Math.trunc(lc);
				}
				const n = this._parseNumber(st?.val);
				if (this._window.baselineVal == null && typeof n === 'number' && Number.isFinite(n)) {
					this._window.baselineVal = n;
				}

				if (this._pendingAt) {
					this._trace(
						`update timer id='${this._pendingTimerId}' at=${this._pendingAt} baselineLc=${this._window.baselineLc} baselineVal=${this._window.baselineVal}`,
					);
					this.timers.set(this._pendingTimerId, this._pendingAt, 'triggered.window', {
						targetId: this.targetId,
						startedAt: this._window.startedAt,
						baselineLc: this._window.baselineLc,
						baselineVal: this._window.baselineVal,
					});
				}
			})
			.catch(() => undefined);
	}
}

module.exports = { TriggeredRule };
