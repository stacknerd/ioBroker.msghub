'use strict';

const { fallbackPresetId } = require('../constants');

/**
 * Session rule (start + end).
 *
 * Developer notes (mental model):
 * - We watch a primary power-like stream (targetId) and infer "session start/end".
 * - Optional gate can pause monitoring or force an end when off.
 * - Optional counter + price add summary metrics on session end.
 * - Two messages are emitted:
 *   - Start message (suffix `_start`) on session start (optional)
 *   - End message (default ref) on session end (always)
 *
 * Timers and persistence:
 * - start-hold and stop-delay debounce edges via TimerService.
 * - an "active marker" timer is used to restore session state after restart.
 */
class SessionRule {
	/**
	 * Create a new Session rule instance.
	 *
	 * @param {object} info Rule inputs.
	 * @param {object} info.ctx Plugin runtime context.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {object} info.ruleConfig Rule config (from `sess-*` keys).
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

		this._powerUnit = '';
		this._counterUnit = '';
		this._priceUnit = '';

		this._powerVal = null;
		this._gateVal = null;
		this._counterVal = null;
		this._priceVal = null;

		this._startThreshold = this._resolveNumberOrThrow('startThreshold');
		this._stopThreshold = this._resolveNumberOrThrow('stopThreshold');
		this._startHoldMs = this._resolveDurationMs('startMinHoldValue', 'startMinHoldUnit');
		this._stopDelayMs = this._resolveDurationMs('stopDelayValue', 'stopDelayUnit');
		this._cancelStopIfAbove = this.ruleConfig?.cancelStopIfAboveStopThreshold !== false;

		this._gateMode =
			typeof this.ruleConfig?.onOffActive === 'string' ? this.ruleConfig.onOffActive.trim() : 'truthy';
		this._gateEq = typeof this.ruleConfig?.onOffValue === 'string' ? this.ruleConfig.onOffValue.trim() : 'true';

		this._startHoldTimerId = `sess:startHold:${this.targetId}`;
		this._stopTimerId = `sess:stopDelay:${this.targetId}`;
		this._activeTimerId = `sess:active:${this.targetId}`;
		this._startHoldAt = null;
		this._stopAt = null;

		this._session = null; // { startedAt, counterStartVal, counterStartUnit, costUnit, startMessageDeleted? }

		this._loadObjectMeta();
		this._initFromForeignStates();
		this._restorePersistedState();

		this._trace(
			`start targetId='${this.targetId}' startThreshold=${this._startThreshold} stopThreshold=${this._stopThreshold} startHoldMs=${this._startHoldMs} stopDelayMs=${this._stopDelayMs}`,
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

		this._log.debug(`Session ${_shorten(this.targetId)}: ${msg}`);
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
		return (key && writers[key]) || writers.SessionEndId || writers.DefaultId || writers[fallbackPresetId] || null;
	}

	/**
	 * Resolve the writer for the optional start message (strict, no fallback).
	 *
	 * @returns {object|null} Writer for session start (strict; no fallback).
	 */
	_getStartWriter() {
		const writers = this.messageWriters;
		if (!writers || typeof writers !== 'object') {
			return null;
		}
		return writers.SessionStartId || null;
	}

	/**
	 * Check whether the start message is configured (preset id present).
	 *
	 * @returns {boolean} True when the session start message is configured.
	 */
	_isSessionStartEnabled() {
		const writer = this._getStartWriter();
		const presetId = typeof writer?.presetId === 'string' ? writer.presetId.trim() : '';
		return !!presetId;
	}

	/**
	 * Build the stable message ref for the target + rule.
	 *
	 * Build a stable message ref for this rule instance.
	 *
	 * @param {string} [suffix] Optional suffix for multi-message rules.
	 * @returns {string} Stable message ref.
	 */
	_getRef(suffix = '') {
		const sfx = typeof suffix === 'string' ? suffix : '';
		return `${this.ctx?.meta?.plugin?.baseOwnId}.session.${this.targetId}${sfx}`;
	}

	/**
	 * Resolve the actor label for store mutations.
	 *
	 * @returns {string} Actor label for store operations.
	 */
	_actor() {
		return this.ctx?.meta?.plugin?.regId || 'IngestStates';
	}

	/**
	 * Declare which foreign state ids this rule needs.
	 *
	 * @returns {Set<string>} Required foreign state ids.
	 */
	requiredStateIds() {
		const ids = new Set([this.targetId]);

		const add = id => {
			if (typeof id === 'string' && id.trim()) {
				ids.add(id.trim());
			}
		};

		add(this.ruleConfig?.onOffId);
		add(this.ruleConfig?.energyCounterId);
		add(this.ruleConfig?.pricePerKwhId);

		return ids;
	}

	/**
	 * Route incoming state changes into the session state machine.
	 *
	 * @param {string} id State id.
	 * @param {object} state ioBroker state.
	 * @returns {void}
	 */
	onStateChange(id, state) {
		if (id === this.targetId) {
			// Primary stream: power/usage value drives start/stop.
			const value = this._parseNumber(state?.val);
			if (value !== null) {
				this._powerVal = value;
			}
		}

		if (id === this.ruleConfig?.onOffId) {
			// Gate stream: enable/disable monitoring.
			this._gateVal = state?.val;
		}

		if (id === this.ruleConfig?.energyCounterId) {
			// Optional counter stream for summary metrics.
			const value = this._parseNumber(state?.val);
			if (value !== null) {
				this._counterVal = value;
			}
		}

		if (id === this.ruleConfig?.pricePerKwhId) {
			// Optional price stream for cost calculation.
			const value = this._parseNumber(state?.val);
			if (value !== null) {
				this._priceVal = value;
			}
		}

		this._evaluate(Date.now());
	}

	/**
	 * Periodic evaluation tick (used mainly for timers and metric patching).
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	onTick(now) {
		if (!this._isActive()) {
			return;
		}

		// Keep the optional start message in sync while the session is active.
		this._markStartMessageDeletedIfNeeded();
		this._patchStartMetrics(now);

		const gate = this._isGateActive();
		if (gate === false) {
			// Gate off → end session immediately.
			this._endSession(now);
			return;
		}

		const power = this._powerVal;
		if (typeof power === 'number' && Number.isFinite(power) && power < this._stopThreshold) {
			// Track stop-delay while power is below the stop threshold.
			this._ensureStopTimer(now);
		}
	}

	/**
	 * Handle a due timer fired by `TimerService`.
	 *
	 * Handle a due timer event routed by the engine.
	 *
	 * @param {{ id: string, at: number, kind: string, data?: any }} timer Timer payload.
	 * @returns {void}
	 */
	onTimer(timer) {
		const kind = typeof timer?.kind === 'string' ? timer.kind : '';
		if (timer?.data?.targetId !== this.targetId) {
			return;
		}

		if (kind === 'session.startHold') {
			// Start-hold debounce expired → re-evaluate.
			this._startHoldAt = null;
			if (this._isActive()) {
				return;
			}

			const gate = this._isGateActive();
			if (gate !== true) {
				return;
			}

			const power = this._powerVal;
			if (typeof power !== 'number' || !Number.isFinite(power) || power <= this._startThreshold) {
				return;
			}

			this._startSession(Date.now());
			return;
		}

		if (kind === 'session.stopDelay') {
			// Stop-delay debounce expired → re-evaluate.
			this._stopAt = null;
			if (!this._isActive()) {
				return;
			}

			const gate = this._isGateActive();
			if (gate === false) {
				this._endSession(Date.now());
				return;
			}
			if (gate === null) {
				return;
			}

			const power = this._powerVal;
			if (typeof power !== 'number' || !Number.isFinite(power) || power >= this._stopThreshold) {
				return;
			}

			this._endSession(Date.now());
		}
	}

	/**
	 * Dispose and clean up pending timers.
	 *
	 * Dispose the rule instance.
	 *
	 * @returns {void}
	 */
	dispose() {
		this._cancelStartHoldTimer();
		this._cancelStopTimer();
		this._clearActiveMarker();
	}

	/**
	 * Check whether a session is currently active.
	 *
	 * @returns {boolean} True when a session is active (persisted marker exists).
	 */
	_isActive() {
		return Boolean(this._session);
	}

	/**
	 * Evaluate start/stop conditions based on the latest known states.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_evaluate(now) {
		const gate = this._isGateActive();
		if (gate === false) {
			// Gate off → stop immediately.
			this._cancelStartHoldTimer();
			if (this._isActive()) {
				this._endSession(now);
			}
			return;
		}
		if (gate === null) {
			// Gate unknown → do not change state.
			return;
		}

		const power = this._powerVal;
		if (typeof power !== 'number' || !Number.isFinite(power)) {
			return;
		}

		// Not active: detect start.
		if (!this._isActive()) {
			if (power > this._startThreshold) {
				if (this._startHoldMs > 0) {
					if (
						typeof this._startHoldAt === 'number' &&
						Number.isFinite(this._startHoldAt) &&
						now >= this._startHoldAt
					) {
						this._cancelStartHoldTimer();
						this._startSession(now);
						return;
					}
					// Hold time required → start a debounce timer.
					this._ensureStartHoldTimer(now);
					return;
				}

				this._startSession(now);
				return;
			}

			this._cancelStartHoldTimer();
			return;
		}

		// Active: detect stop.
		this._cancelStartHoldTimer();

		if (power < this._stopThreshold) {
			if (this._stopDelayMs > 0) {
				if (typeof this._stopAt === 'number' && Number.isFinite(this._stopAt) && now >= this._stopAt) {
					this._cancelStopTimer();
					this._endSession(now);
					return;
				}
				// Stop delay required → start a debounce timer.
				this._ensureStopTimer(now);
			} else {
				this._endSession(now);
			}
			return;
		}

		if (this._cancelStopIfAbove) {
			// Value recovered → cancel pending stop.
			this._cancelStopTimer();
		}

		this._patchStartMetrics(now);
	}

	/**
	 * Start a new session and emit the optional start message.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_startSession(now) {
		this._cancelStartHoldTimer();
		this._cancelStopTimer();

		const counterStartVal =
			typeof this._counterVal === 'number' && Number.isFinite(this._counterVal) ? this._counterVal : null;
		const counterUnit = this._counterUnit || '';
		const costUnit = this._costUnitFromPriceUnit(this._priceUnit);

		this._session = {
			startedAt: now,
			counterStartVal,
			counterUnit,
			costUnit,
			startMessageDeleted: false,
		};
		this._persistActiveMarker();

		// Close end message from a previous run so it does not stay around while a new session is running.
		const endWriter = this._getMessageWriter('SessionEndId');
		if (endWriter) {
			endWriter.onClose(this._getRef());
		}

		if (this._isSessionStartEnabled()) {
			const actionTypes = this.ctx?.api?.constants?.actions?.type || {};
			const typeAck = actionTypes.ack || 'ack';
			const typeSnooze = actionTypes.snooze || 'snooze';
			const typeDelete = actionTypes.delete || 'delete';
			const actions = [
				{ id: 'ack', type: typeAck },
				{ id: 'snooze-4h', type: typeSnooze, payload: { forMs: 4 * 60 * 60 * 1000 } },
				{ id: 'delete', type: typeDelete },
			];

			const startWriter = this._getStartWriter();
			if (startWriter) {
				// Start message uses the session start timestamp as domain startAt.
				startWriter.onUpsert(this._getRef('_start'), {
					now,
					startAt: this._session?.startedAt,
					actions,
					metrics: this._buildSessionMetrics(now),
				});
			}
		}
	}

	/**
	 * End the current session, emit the end message, and remove the start message.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_endSession(now) {
		if (!this._isActive()) {
			return;
		}

		const actionTypes = this.ctx?.api?.constants?.actions?.type || {};
		const typeAck = actionTypes.ack || 'ack';
		const typeSnooze = actionTypes.snooze || 'snooze';
		const actions = [
			{ id: 'ack', type: typeAck },
			{ id: 'snooze-4h', type: typeSnooze, payload: { forMs: 4 * 60 * 60 * 1000 } },
		];

		const endWriter = this._getMessageWriter('SessionEndId');
		if (endWriter) {
			const startAt =
				typeof this._session?.startedAt === 'number' && Number.isFinite(this._session.startedAt)
					? this._session.startedAt
					: undefined;
			// End message uses session startAt + endAt (domain timestamps).
			endWriter.onUpsert(this._getRef(), {
				now,
				startAt,
				endAt: now,
				actions,
				metrics: this._buildSessionMetrics(now),
			});
		}

		if (this._isSessionStartEnabled()) {
			this._removeStartMessage();
		}

		this._cancelStopTimer();
		this._cancelStartHoldTimer();
		this._clearActiveMarker();
		this._session = null;
	}

	/**
	 * Build the session metrics payload for start/end messages.
	 *
	 * @param {number} _now Current timestamp (ms).
	 * @returns {Record<string, {val: number|string|boolean|null, unit?: string}>} Metrics set.
	 */
	_buildSessionMetrics(_now) {
		const startedAt = this._session?.startedAt;
		const counterStartVal = this._session?.counterStartVal;

		const counterNow =
			typeof this._counterVal === 'number' && Number.isFinite(this._counterVal) ? this._counterVal : null;
		const price = typeof this._priceVal === 'number' && Number.isFinite(this._priceVal) ? this._priceVal : null;

		const counterUnit = this._session?.counterUnit || this._counterUnit || '';
		const costUnit = this._session?.costUnit || this._costUnitFromPriceUnit(this._priceUnit);

		const counterDiff =
			typeof counterNow === 'number' && typeof counterStartVal === 'number' ? counterNow - counterStartVal : null;
		const cost = typeof counterDiff === 'number' && typeof price === 'number' ? counterDiff * price : null;

		return {
			'session-start': { val: typeof startedAt === 'number' ? startedAt : null, unit: 'ms' },
			'session-startval': {
				val: typeof counterStartVal === 'number' ? counterStartVal : null,
				unit: counterUnit,
			},
			'session-counter': {
				val: typeof counterDiff === 'number' && Number.isFinite(counterDiff) ? counterDiff : null,
				unit: counterUnit,
			},
			'session-cost': { val: typeof cost === 'number' && Number.isFinite(cost) ? cost : null, unit: costUnit },
		};
	}

	/**
	 * Patch start message metrics while the session is active (best-effort).
	 *
	 * @param {number} now Current timestamp (ms).
	 * @param {boolean} [force] When true, bypass throttling.
	 * @returns {void}
	 */
	_patchStartMetrics(now, force = false) {
		if (!this._isActive() || !this._isSessionStartEnabled()) {
			return;
		}
		if (this._session?.startMessageDeleted) {
			return;
		}
		const startWriter = this._getStartWriter();
		if (!startWriter) {
			return;
		}
		startWriter.onMetrics(this._getRef('_start'), { set: this._buildSessionMetrics(now), now, force });
	}

	/**
	 * Remove the start message (best-effort).
	 *
	 * @returns {void}
	 */
	_removeStartMessage() {
		const store = this.ctx?.api?.store;
		if (!store || typeof store.removeMessage !== 'function') {
			return;
		}
		store.removeMessage(this._getRef('_start'), { actor: this._actor() });
	}

	/**
	 * Mark the start message as deleted when the user deleted it (to avoid re-creating it during the same session).
	 *
	 * @returns {void}
	 */
	_markStartMessageDeletedIfNeeded() {
		if (!this._isActive() || !this._isSessionStartEnabled() || this._session?.startMessageDeleted) {
			return;
		}

		const ref = this._getRef('_start');
		const existing = this.ctx.api.store.getMessageByRef(ref, [this.ctx.api.constants.lifecycle.state.deleted]);
		if (existing) {
			if (!this._session) {
				return;
			}
			this._session.startMessageDeleted = true;
			this._persistActiveMarker();
		}
	}

	/**
	 * Ensure the start-hold timer exists and is due in the future (best-effort).
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_ensureStartHoldTimer(now) {
		if (!this.timers || this._startHoldMs <= 0) {
			return;
		}
		if (typeof this._startHoldAt === 'number' && Number.isFinite(this._startHoldAt) && this._startHoldAt > now) {
			return;
		}

		const at = now + this._startHoldMs;
		this._startHoldAt = at;
		this._trace(
			`start timer kind='session.startHold' id='${this._startHoldTimerId}' inMs=${Math.max(0, at - now)} at=${at}`,
		);
		// Persist debounce timer so start decisions survive restarts.
		this.timers.set(this._startHoldTimerId, at, 'session.startHold', { targetId: this.targetId });
	}

	/**
	 * Cancel the pending start-hold timer (if any).
	 *
	 * @returns {void}
	 */
	_cancelStartHoldTimer() {
		if (!this.timers) {
			return;
		}
		this._startHoldAt = null;
		this._trace(`cancel timer id='${this._startHoldTimerId}' kind='session.startHold'`);
		this.timers.delete(this._startHoldTimerId);
	}

	/**
	 * Ensure the stop-delay timer exists and is due in the future (best-effort).
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_ensureStopTimer(now) {
		if (!this.timers || this._stopDelayMs <= 0) {
			return;
		}
		if (typeof this._stopAt === 'number' && Number.isFinite(this._stopAt) && this._stopAt > now) {
			return;
		}

		const at = now + this._stopDelayMs;
		this._stopAt = at;
		this._trace(
			`start timer kind='session.stopDelay' id='${this._stopTimerId}' inMs=${Math.max(0, at - now)} at=${at}`,
		);
		// Persist debounce timer so stop decisions survive restarts.
		this.timers.set(this._stopTimerId, at, 'session.stopDelay', { targetId: this.targetId });
	}

	/**
	 * Cancel the pending stop-delay timer (if any).
	 *
	 * @returns {void}
	 */
	_cancelStopTimer() {
		if (!this.timers) {
			return;
		}
		this._stopAt = null;
		this._trace(`cancel timer id='${this._stopTimerId}' kind='session.stopDelay'`);
		this.timers.delete(this._stopTimerId);
	}

	/**
	 * Restore persisted timer state (best-effort).
	 *
	 * @returns {void}
	 */
	_restorePersistedState() {
		if (!this.timers) {
			return;
		}

		const hold = this.timers.get(this._startHoldTimerId);
		if (hold?.kind === 'session.startHold' && hold.data?.targetId === this.targetId && Number.isFinite(hold.at)) {
			this._startHoldAt = Math.trunc(hold.at);
			this._trace(
				`restore timer id='${this._startHoldTimerId}' kind='session.startHold' at=${this._startHoldAt}`,
			);
		}

		const stop = this.timers.get(this._stopTimerId);
		if (stop?.kind === 'session.stopDelay' && stop.data?.targetId === this.targetId && Number.isFinite(stop.at)) {
			this._stopAt = Math.trunc(stop.at);
			this._trace(`restore timer id='${this._stopTimerId}' kind='session.stopDelay' at=${this._stopAt}`);
		}

		const active = this.timers.get(this._activeTimerId);
		if (active?.kind === 'session.active' && active.data?.targetId === this.targetId) {
			const startedAt = active.data?.startedAt;
			this._session = {
				startedAt:
					typeof startedAt === 'number' && Number.isFinite(startedAt) ? Math.trunc(startedAt) : Date.now(),
				counterStartVal:
					typeof active.data?.counterStartVal === 'number' && Number.isFinite(active.data.counterStartVal)
						? active.data.counterStartVal
						: null,
				counterUnit:
					typeof active.data?.counterUnit === 'string' ? active.data.counterUnit : this._counterUnit || '',
				costUnit:
					typeof active.data?.costUnit === 'string'
						? active.data.costUnit
						: this._costUnitFromPriceUnit(this._priceUnit),
				startMessageDeleted: active.data?.startMessageDeleted === true,
			};
			this._trace(`restore active marker startedAt=${this._session.startedAt}`);
		}
	}

	/**
	 * Persist the active session marker as a far-future timer entry (best-effort).
	 *
	 * @returns {void}
	 */
	_persistActiveMarker() {
		if (!this.timers || !this._session) {
			return;
		}
		const farFutureAt = this._session.startedAt + 10 * 365 * 24 * 60 * 60 * 1000;
		this._trace(`persist active marker id='${this._activeTimerId}' startedAt=${this._session.startedAt}`);
		this.timers.set(this._activeTimerId, farFutureAt, 'session.active', {
			targetId: this.targetId,
			startedAt: this._session.startedAt,
			counterStartVal: this._session.counterStartVal,
			counterUnit: this._session.counterUnit,
			costUnit: this._session.costUnit,
			startMessageDeleted: this._session.startMessageDeleted === true,
		});
	}

	/**
	 * Clear the persisted active session marker (best-effort).
	 *
	 * @returns {void}
	 */
	_clearActiveMarker() {
		if (!this.timers) {
			return;
		}
		this._trace(`clear active marker id='${this._activeTimerId}'`);
		this.timers.delete(this._activeTimerId);
	}

	/**
	 * Determine whether the gate is currently active.
	 *
	 * @returns {boolean|null} True/false when known; null when gate is configured but state is unknown.
	 */
	_isGateActive() {
		const gateId = typeof this.ruleConfig?.onOffId === 'string' ? this.ruleConfig.onOffId.trim() : '';
		if (!gateId) {
			return true;
		}

		const raw = this._gateVal;
		if (raw === null || raw === undefined) {
			return null;
		}

		if (this._gateMode === 'falsy') {
			return !raw;
		}
		if (this._gateMode === 'eq') {
			return String(raw) === this._gateEq;
		}
		return Boolean(raw);
	}

	/**
	 * Parse a numeric value (number or numeric string).
	 *
	 * @param {any} val Raw state value.
	 * @returns {number|null} Parsed number or null when invalid.
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
	 * Resolve a required numeric config value (>= 0) or throw.
	 *
	 * @param {string} key Config key.
	 * @returns {number} Number value (>= 0).
	 */
	_resolveNumberOrThrow(key) {
		const n = this.ruleConfig?.[key];
		if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
			throw new Error(`SessionRule: sess-${key} must be a number`);
		}
		return n;
	}

	/**
	 * Resolve a duration from value + unit keys.
	 *
	 * @param {string} valueKey E.g. `stopDelayValue`.
	 * @param {string} unitKey E.g. `stopDelayUnit`.
	 * @returns {number} Duration in ms (0 when disabled/invalid).
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
	 * Extract a cost unit from a "price per unit" unit string.
	 *
	 * @param {string} unit Price unit (e.g. "€/kWh").
	 * @returns {string} Cost unit (e.g. "€").
	 */
	_costUnitFromPriceUnit(unit) {
		const u = typeof unit === 'string' ? unit.trim() : '';
		if (!u) {
			return '';
		}
		const idx = u.indexOf('/');
		return idx >= 0 ? u.slice(0, idx).trim() : u;
	}

	/**
	 * Best-effort: fetch unit metadata from objects once.
	 *
	 * @returns {void}
	 */
	_loadObjectMeta() {
		const ctx = this.ctx;
		const getObj = ctx?.api?.iobroker?.objects?.getForeignObject;
		if (typeof getObj !== 'function') {
			return;
		}

		const tryLoad = (id, cb) => {
			if (typeof id !== 'string' || !id.trim()) {
				return;
			}
			Promise.resolve()
				.then(() => getObj(id))
				.then(obj => cb(obj))
				.catch(() => undefined);
		};

		tryLoad(this.targetId, obj => {
			const u = obj?.common?.unit;
			if (typeof u === 'string' && u.trim()) {
				this._powerUnit = u.trim();
			}
		});

		tryLoad(this.ruleConfig?.energyCounterId, obj => {
			const u = obj?.common?.unit;
			if (typeof u === 'string' && u.trim()) {
				this._counterUnit = u.trim();
			}
		});

		tryLoad(this.ruleConfig?.pricePerKwhId, obj => {
			const u = obj?.common?.unit;
			if (typeof u === 'string' && u.trim()) {
				this._priceUnit = u.trim();
			}
		});
	}

	/**
	 * Bootstrap current values from ioBroker states once (best-effort).
	 *
	 * @returns {void}
	 */
	_initFromForeignStates() {
		const ctx = this.ctx;
		const getState = ctx?.api?.iobroker?.states?.getForeignState;
		if (typeof getState !== 'function') {
			return;
		}

		const tryLoad = id => {
			if (typeof id !== 'string' || !id.trim()) {
				return Promise.resolve(null);
			}
			return Promise.resolve()
				.then(() => getState(id))
				.catch(() => null);
		};

		Promise.resolve()
			.then(async () => {
				const [power, gate, counter, price] = await Promise.all([
					tryLoad(this.targetId),
					tryLoad(this.ruleConfig?.onOffId),
					tryLoad(this.ruleConfig?.energyCounterId),
					tryLoad(this.ruleConfig?.pricePerKwhId),
				]);

				if (this._traceEvents) {
					let pVal = '[unavailable]';
					let gVal = '[unavailable]';
					let cVal = '[unavailable]';
					let prVal = '[unavailable]';
					try {
						pVal = JSON.stringify(power?.val);
					} catch {
						pVal = '[unstringifiable]';
					}
					try {
						gVal = JSON.stringify(gate?.val);
					} catch {
						gVal = '[unstringifiable]';
					}
					try {
						cVal = JSON.stringify(counter?.val);
					} catch {
						cVal = '[unstringifiable]';
					}
					try {
						prVal = JSON.stringify(price?.val);
					} catch {
						prVal = '[unstringifiable]';
					}
					this._trace(`bootstrap states power=${pVal} gate=${gVal} counter=${cVal} price=${prVal}`);
				}

				const p = this._parseNumber(power?.val);
				if (p !== null) {
					this._powerVal = p;
				}
				if (gate) {
					this._gateVal = gate.val;
				}
				const c = this._parseNumber(counter?.val);
				if (c !== null) {
					this._counterVal = c;
				}
				const pr = this._parseNumber(price?.val);
				if (pr !== null) {
					this._priceVal = pr;
				}

				this._evaluate(Date.now());
			})
			.catch(() => undefined);
	}
}

module.exports = { SessionRule };
