'use strict';

/**
 * Session rule (start + end).
 *
 * Detects the start and end of a process based on a monitored "power" value plus a stop delay.
 * Optionally uses:
 * - a gate on/off datapoint (`sess.onOffId`) to enable/disable monitoring; gate off ends a running session
 * - an energy counter (`sess.energyCounterId`) and a price-per-unit state (`sess.pricePerKwhId`) for summary metrics
 *
 * It emits up to two messages:
 * - Start message (ref suffix `_start`) when the session starts (optional via `msg.sessionStartEnabled`)
 * - End message (default ref) when the session ends (always)
 *
 * Persistent timers (`TimerService`) are used for:
 * - `sess.startMinHold*` (debounce start)
 * - `sess.stopDelay*` (debounce stop)
 * - a durable "session active" marker to survive restarts (stored as a far-future timer entry)
 */
class SessionRule {
	/**
	 * @param {object} info Rule inputs.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {object} info.ruleConfig Rule config (`sess.*`).
	 * @param {object} info.message Target message writer.
	 * @param {object} [info.timers] Timer service (shared).
	 */
	constructor({ targetId, ruleConfig = {}, message, timers = null }) {
		this.targetId = targetId;
		this.ruleConfig = ruleConfig || {};
		this.message = message;
		this.timers = timers;

		this._name = this._fallbackName(targetId);
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
	}

	/**
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
	 * @param {string} id State id.
	 * @param {object} state ioBroker state.
	 * @returns {void}
	 */
	onStateChange(id, state) {
		if (id === this.targetId) {
			const value = this._parseNumber(state?.val);
			if (value !== null) {
				this._powerVal = value;
			}
		}

		if (id === this.ruleConfig?.onOffId) {
			this._gateVal = state?.val;
		}

		if (id === this.ruleConfig?.energyCounterId) {
			const value = this._parseNumber(state?.val);
			if (value !== null) {
				this._counterVal = value;
			}
		}

		if (id === this.ruleConfig?.pricePerKwhId) {
			const value = this._parseNumber(state?.val);
			if (value !== null) {
				this._priceVal = value;
			}
		}

		this._evaluate(Date.now());
	}

	/**
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	onTick(now) {
		if (!this._isActive()) {
			return;
		}

		this._markStartMessageDeletedIfNeeded();
		this._patchStartMetrics(now);

		const gate = this._isGateActive();
		if (gate === false) {
			this._endSession(now);
			return;
		}

		const power = this._powerVal;
		if (typeof power === 'number' && Number.isFinite(power) && power < this._stopThreshold) {
			this._ensureStopTimer(now);
		}
	}

	/**
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
			this._cancelStartHoldTimer();
			if (this._isActive()) {
				this._endSession(now);
			}
			return;
		}
		if (gate === null) {
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
				this._ensureStopTimer(now);
			} else {
				this._endSession(now);
			}
			return;
		}

		if (this._cancelStopIfAbove) {
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
		this.message.closeEndOnStart({ finishedAt: now });

		if (this.message.isSessionStartEnabled()) {
			const t = this.message.ctx.api.i18n.t;
			const name = this._name;

			const defaultTitle = t(`'%s' started`, name);
			const defaultText = t(`'%s' started.`, name);

			const actions = [
				{ id: 'ack', type: 'ack' },
				{ id: 'snooze-4h', type: 'snooze', payload: { forMs: 4 * 60 * 60 * 1000 } },
				{ id: 'delete', type: 'delete' },
			];

			this.message.openStartActive({ defaultTitle, defaultText, now, actions });
			this._patchStartMetrics(now, true);
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

		const t = this.message.ctx.api.i18n.t;
		const name = this._name;

		const defaultTitle = t(`'%s' ended`, name);
		const defaultText = t(`'%s' ended. Consumed {{m.session-counter}} for about {{m.session-cost}}.`, name);

		const actions = [
			{ id: 'ack', type: 'ack' },
			{ id: 'snooze-4h', type: 'snooze', payload: { forMs: 4 * 60 * 60 * 1000 } },
		];

		this.message.openActive({ defaultTitle, defaultText, now, actions });
		this.message.patchMetrics({ set: this._buildSessionMetrics(now), now, force: true });

		if (this.message.isSessionStartEnabled()) {
			this.message.removeStartMessage();
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
		if (!this._isActive() || !this.message.isSessionStartEnabled()) {
			return;
		}
		if (this._session?.startMessageDeleted) {
			return;
		}
		this.message.patchStartMetrics({ set: this._buildSessionMetrics(now), now, force });
	}

	/**
	 * Mark the start message as deleted when the user deleted it (to avoid re-creating it during the same session).
	 *
	 * @returns {void}
	 */
	_markStartMessageDeletedIfNeeded() {
		if (!this._isActive() || !this.message.isSessionStartEnabled() || this._session?.startMessageDeleted) {
			return;
		}

		const ref = this.message.makeRef('_start');
		const existing = this.message.ctx.api.store.getMessageByRef(ref);
		if (existing?.lifecycle?.state === this.message.ctx.api.constants.lifecycle.state.deleted) {
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
		}

		const stop = this.timers.get(this._stopTimerId);
		if (stop?.kind === 'session.stopDelay' && stop.data?.targetId === this.targetId && Number.isFinite(stop.at)) {
			this._stopAt = Math.trunc(stop.at);
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
	 * @param {string} id Object/state id.
	 * @returns {string} Best-effort display name.
	 */
	_fallbackName(id) {
		const str = String(id || '');
		const parts = str.split('.').filter(Boolean);
		return parts.length ? parts[parts.length - 1] : str;
	}

	/**
	 * @param {string} key Config key.
	 * @returns {number} Number value (>= 0).
	 */
	_resolveNumberOrThrow(key) {
		const n = this.ruleConfig?.[key];
		if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
			throw new Error(`SessionRule: sess.${key} must be a number`);
		}
		return n;
	}

	/**
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
	 * Best-effort: fetch name/unit metadata from objects once.
	 *
	 * @returns {void}
	 */
	_loadObjectMeta() {
		const ctx = this.message?.ctx;
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
			const n = obj?.common?.name;
			if (typeof n === 'string' && n.trim()) {
				this._name = n.trim();
			}
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
		const ctx = this.message?.ctx;
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
