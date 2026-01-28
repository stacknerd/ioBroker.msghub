'use strict';

const { fallbackPresetId } = require('../constants');

/**
 * Triggered rule (dependency window).
 *
 * Developer notes (mental model):
 * - We watch two streams: the *trigger* (trg-id) and the *target* (targetId).
 * - A rising edge on the trigger starts a "reaction window".
 * - If the target meets the configured expectation within the window: no message.
 * - If the window expires while unmet: open a message and keep patching metrics.
 * - When the expectation becomes true later (or the trigger goes inactive): close the message.
 *
 * Why persistent timers:
 * - The window must survive restarts and event-only mode (`evaluateIntervalMs=0`).
 * - TimerService keeps window state durable and re-hydrates on startup.
 *
 * Message semantics:
 * - The writer owns title/text via presets; this rule only supplies timing + metrics.
 * - `timing.startAt` is set to the window start (domain timestamp).
 */
class TriggeredRule {
	/**
	 * Create a new Triggered rule instance.
	 *
	 * @param {object} info Rule inputs.
	 * @param {object} info.ctx Plugin runtime context.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {object} info.ruleConfig Rule config (from `trg-*` keys).
	 * @param {object} info.messageWritersByPresetKey presetId -> writer map.
	 * @param {object} info.timers Timer service (shared).
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

		this._log.debug(`Triggered ${_shorten(this.targetId)}: ${msg}`);
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
		return (key && writers[key]) || writers.TriggeredId || writers.DefaultId || writers[fallbackPresetId] || null;
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
		return `${this.ctx?.meta?.plugin?.baseOwnId}.triggered.${this.targetId}`;
	}

	/**
	 * Declare which foreign state ids this rule needs.
	 *
	 * @returns {Set<string>} Required foreign state ids.
	 */
	requiredStateIds() {
		const ids = new Set([this.targetId]);
		ids.add(this._triggerId);
		return ids;
	}

	/**
	 * Route trigger/target state changes into the rule state machine.
	 *
	 * @param {string} id State id.
	 * @param {object} state ioBroker state.
	 * @returns {void}
	 */
	onStateChange(id, state) {
		if (id === this._triggerId) {
			// Trigger stream: detect rising/falling edges and open/cancel windows.
			this._triggerValRaw = state?.val;
			const nextActive = this._isTriggerActive(state?.val);
			const wasActive = this._triggerActive;
			this._triggerActive = nextActive;

			const now = Date.now();

			if (!wasActive && nextActive) {
				// Rising edge → open a fresh window.
				this._startWindow(now);
				return;
			}
			if (wasActive && !nextActive) {
				// Falling edge → cancel any window and close an open message.
				this._cancelWindow();
				this._conditionActive = false;
				this._isActive = false;
				this._closeIfRequested();
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

		// Target stream: update baseline/value and check expectation.
		this._targetValRaw = state?.val;
		this._targetValNum = this._parseNumber(state?.val);

		const lc = state?.lc;
		if (typeof lc === 'number' && Number.isFinite(lc)) {
			this._targetLc = Math.trunc(lc);
		}

		const now = Date.now();

		if (this._window && this._triggerActive) {
			if (this._isExpectationMet()) {
				// Target reacted in time → cancel window and close (if needed).
				this._cancelWindow();
				this._conditionActive = false;
				this._isActive = false;
				this._closeIfRequested();
				return;
			}
		}

		if (this._conditionActive) {
			// Message already open → keep metrics fresh.
			this._patchMetrics(now);
		}
	}

	/**
	 * Periodic evaluation tick (used mainly for metric patching).
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	onTick(now) {
		if (!this._conditionActive) {
			return;
		}

		this._patchMetrics(now);
		if (this._triggerActive && this._isExpectationMet()) {
			this._conditionActive = false;
			this._isActive = false;
			this._closeIfRequested();
		}
	}

	/**
	 * Handle a due window timer fired by `TimerService`.
	 *
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
			// Re-hydrate window metadata from persisted timer payload.
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
					// Trigger cleared while we were waiting.
					this._cancelWindow();
					return;
				}

				if (this._isExpectationMet()) {
					// Target already reacted by the time the window expires.
					this._cancelWindow();
					return;
				}

				// Window expired and expectation not met → open the message.
				this._open(now);
			})
			.catch(() => undefined);
	}

	/**
	 * Dispose and clean up pending timers.
	 *
	 * Dispose the rule instance.
	 *
	 * @returns {void}
	 */
	dispose() {
		this._cancelWindow();
	}

	/**
	 * Start and persist the trigger reaction window.
	 *
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

		// Capture the baseline at window start to evaluate "expected reaction" later.
		this._window = { startedAt: now, baselineLc, baselineVal };

		const at = now + this._windowMs;
		this._pendingAt = at;
		this._trace(
			`start timer kind='triggered.window' id='${this._pendingTimerId}' inMs=${Math.max(0, at - now)} at=${at}`,
		);
		// Persist window state so it survives restarts.
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
	 * Cancel the current reaction window and clear timer state.
	 *
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
	 * Restore an in-flight window from a persisted timer (restart-safe).
	 *
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
	 * Open the message (once) and seed initial metrics.
	 *
	 * Open the alert message and seed metrics.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_open(now) {
		this._isActive = true;
		this._conditionActive = true;
		this._closeRequested = false;

		const actionTypes = this.ctx?.api?.constants?.actions?.type || {};
		const typeAck = actionTypes.ack || 'ack';
		const typeSnooze = actionTypes.snooze || 'snooze';
		const typeClose = actionTypes.close || 'close';
		const actions = [
			{ id: 'ack', type: typeAck },
			{ id: 'snooze-4h', type: typeSnooze, payload: { forMs: 4 * 60 * 60 * 1000 } },
			{ id: 'close', type: typeClose },
		];

		const writer = this._getMessageWriter('TriggeredId');
		if (writer) {
			const startAt =
				typeof this._window?.startedAt === 'number' && Number.isFinite(this._window.startedAt)
					? this._window.startedAt
					: undefined;
			// startAt aligns the message with the window start (domain timestamp).
			writer.onUpsert(this._getRef(), { now, startAt, actions, metrics: this._buildMetricsSet() });
		}
	}

	/**
	 * Patch live metrics for the open message.
	 *
	 * Patch message metrics (state + trigger values).
	 *
	 * @param {number} now Current timestamp (ms).
	 * @param {boolean} [force] When true, bypass throttling.
	 * @returns {void}
	 */
	_patchMetrics(now, force = false) {
		const set = this._buildMetricsSet();
		if (!set) {
			return;
		}

		const writer = this._getMessageWriter('TriggeredId');
		if (!writer) {
			return;
		}
		writer.onMetrics(this._getRef(), {
			set,
			now,
			force,
		});
	}

	/**
	 * Build the metrics payload for the current target/trigger values.
	 *
	 * @returns {Record<string, {val: any, unit?: string}>|null} Metrics set or null when unavailable.
	 */
	_buildMetricsSet() {
		const stateVal = this._normalizeMetricValue(this._targetValRaw, this._targetValNum);
		const trgVal = this._triggerValRaw;
		return {
			'state-value': { val: stateVal, unit: this._unit || 'n/a' },
			'trigger-value': { val: trgVal == null ? null : trgVal, unit: this._triggerUnit || '' },
		};
	}

	/**
	 * Close the message once when the cause is gone.
	 *
	 * Schedule closing the message (cause eliminated) if configured.
	 *
	 * @returns {void}
	 */
	_closeIfRequested() {
		if (!this._closeRequested) {
			this._closeRequested = true;
			const writer = this._getMessageWriter('TriggeredId');
			if (writer) {
				writer.onClose(this._getRef());
			}
		}
	}

	/**
	 * Evaluate if the target has met the configured expectation within the window.
	 *
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
			// Compare last-change timestamps to detect any change since baseline.
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
			// Target must increase by at least minDelta.
			const baselineVal = this._window.baselineVal;
			return (
				typeof baselineVal === 'number' &&
				Number.isFinite(baselineVal) &&
				value - baselineVal >= (this.ruleConfig?.minDelta || 0)
			);
		}
		if (expectation === 'deltaDown') {
			// Target must decrease by at least minDelta.
			const baselineVal = this._window.baselineVal;
			return (
				typeof baselineVal === 'number' &&
				Number.isFinite(baselineVal) &&
				baselineVal - value >= (this.ruleConfig?.minDelta || 0)
			);
		}
		if (expectation === 'thresholdGte') {
			// Target must reach or exceed configured threshold.
			return value >= this.ruleConfig.threshold;
		}
		if (expectation === 'thresholdLte') {
			// Target must drop to or below configured threshold.
			return value <= this.ruleConfig.threshold;
		}
		return false;
	}

	/**
	 * Resolve expectation mode from config (`trg-expectation`) and validate dependent fields.
	 *
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
	 * Resolve the trigger compare value based on operator + value type.
	 *
	 * Resolve the comparison value for the trigger, based on operator and type.
	 *
	 * @returns {string|number|boolean|undefined} Compare value.
	 */
	_resolveTriggerCompareValue() {
		if (this._operator === 'truthy' || this._operator === 'falsy') {
			// No compare value needed for boolean semantics.
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
			// Canonicalize boolean compare value from config.
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
	 * Evaluate whether the trigger is currently "active".
	 *
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
	 * Parse a raw trigger value into the configured type.
	 *
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
	 * Normalize the target value for metrics (prefer numeric when possible).
	 *
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
	 * Require a non-empty string id from config.
	 *
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
	 * Best-effort object metadata lookup (units for metrics).
	 *
	 * Load object metadata for nicer title/text and metric units (best-effort).
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
				const u = obj?.common?.unit;
				if (typeof u === 'string' && u.trim()) {
					this._unit = u.trim();
				}
			})
			.catch(() => undefined);

		Promise.resolve()
			.then(() => getObj(this._triggerId))
			.then(obj => {
				const u = obj?.common?.unit;
				if (typeof u === 'string' && u.trim()) {
					this._triggerUnit = u.trim();
				}
			})
			.catch(() => undefined);
	}

	/**
	 * Bootstrap target/trigger values once (best-effort).
	 *
	 * Load initial foreign states for baseline/metrics (best-effort).
	 *
	 * @returns {void}
	 */
	_initFromForeignStates() {
		const ctx = this.ctx;
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
	 * Refresh target/trigger values before evaluating the due window.
	 *
	 * Refresh both target and trigger foreign states (best-effort).
	 *
	 * @returns {Promise<void>|undefined} Promise when `getForeignState` is available.
	 */
	_ensureFreshStates() {
		const ctx = this.ctx;
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
	 * Apply a target state snapshot to local fields.
	 *
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
	 * Apply a trigger state snapshot to local fields.
	 *
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
	 * Ensure baseline values exist by fetching the current target state once.
	 *
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

		const ctx = this.ctx;
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
