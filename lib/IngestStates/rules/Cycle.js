'use strict';

const { fallbackPresetId } = require('../constants');

/**
 * Cycle rule (recurring tasks based on a counter + optional time limit).
 *
 * Problem statement (typical examples):
 * - Maintenance every 2000h (2000, 4000, 6000, ...)
 * - Refill dishwasher salt after 150 runs
 * - Replace filter after 150 mm rainfall
 *
 * Key semantics:
 * - We never trust the source counter to be monotonic (resets happen).
 * - Therefore we track an internal `subCounter` as a delta-sum:
 *   - if counter increases: add the delta
 *   - if counter decreases: ignore for subCounter, but update baseline
 *
 * Due condition (whichever happens first):
 * - `subCounter >= period` (count based)
 * - `elapsedMs >= timeMs` since last reset (optional, time based)
 *
 * Reset semantics:
 * - Official reset: close action on the message (`close` action).
 * - External reset request: write `subCounter = 0` (ack:false).
 *
 * Internal ioBroker states (owned by this plugin):
 * `msghub.<instance>.IngestStates.0.cycle.<targetId>.<state>`
 *
 * Notes:
 * - `targetId` is used verbatim in the path to keep it human-readable.
 * - This rule is resilient against adapter downtime: the subCounter is persisted.
 */
class CycleRule {
	/**
	 * @param {object} info Rule inputs.
	 * @param {object} info.ctx Plugin runtime context.
	 * @param {string} info.targetId Monitored counter id.
	 * @param {object} info.ruleConfig Rule config (from `cyc-*` keys).
	 * @param {Record<string, object>} info.messageWritersByPresetKey presetKey -> writer map.
	 * @param {boolean} [info.traceEvents] Enable verbose debug logging.
	 */
	constructor({ ctx, targetId, ruleConfig = {}, messageWritersByPresetKey, traceEvents = false }) {
		this.ctx = ctx;
		this.targetId = targetId;
		this.ruleConfig = ruleConfig || {};
		this.messageWriters = messageWritersByPresetKey;
		this._traceEvents = traceEvents === true;
		this._log = this.ctx?.api?.log || null;

		// Normalize rule config into safe internal numbers.
		this._period = this._resolvePeriod();
		this._timeMs = this._resolveTimeMs();
		if (!(this._period > 0) && !(this._timeMs > 0)) {
			throw new Error(`CycleRule: invalid config for '${targetId}': requires cyc-period > 0 or cyc-time > 0`);
		}

		// Namespace for owned states (ownId = without adapter namespace, fullId = with namespace).
		this._baseOwnId = `${this.ctx?.meta?.plugin?.baseOwnId}.cycle.${this.targetId}`;
		this._baseFullId = `${this.ctx?.meta?.plugin?.baseFullId}.cycle.${this.targetId}`;

		this._ids = Object.freeze({
			subCounter: { own: `${this._baseOwnId}.subCounter`, full: `${this._baseFullId}.subCounter` },
			lastCounter: { own: `${this._baseOwnId}.lastCounter`, full: `${this._baseFullId}.lastCounter` },
			lastResetAt: { own: `${this._baseOwnId}.lastResetAt`, full: `${this._baseFullId}.lastResetAt` },
			period: { own: `${this._baseOwnId}.period`, full: `${this._baseFullId}.period` },
			timeMs: { own: `${this._baseOwnId}.timeMs`, full: `${this._baseFullId}.timeMs` },
			due: { own: `${this._baseOwnId}.due`, full: `${this._baseFullId}.due` },
			remainingCount: { own: `${this._baseOwnId}.remainingCount`, full: `${this._baseFullId}.remainingCount` },
			remainingTimeMs: { own: `${this._baseOwnId}.remainingTimeMs`, full: `${this._baseFullId}.remainingTimeMs` },
			progressPct: { own: `${this._baseOwnId}.progressPct`, full: `${this._baseFullId}.progressPct` },
		});

		// Display helpers (best-effort; populated from object meta).
		this._name = this._fallbackName(targetId);
		this._unit = '';

		// Cached runtime state (mirrors persisted states where possible).
		this._subCounter = 0;
		this._lastCounter = NaN;
		this._lastResetAt = Date.now();
		this._due = false;
		this._isActive = false;
		this._closeRequested = false;

		// Throttle for derived-state writes (keep states stable in VIS).
		this._lastDerivedWriteAt = 0;

		this._loadObjectMeta();
		this._bootstrapInternalState();

		this._trace(`start targetId='${this.targetId}' period=${this._period} timeMs=${this._timeMs}`);
	}

	/**
	 * Declare required state subscriptions.
	 *
	 * - `targetId` is the foreign counter
	 * - `subCounter` is the owned reset/request state
	 *
	 * @returns {Set<string>} Required state ids (foreign + owned).
	 */
	requiredStateIds() {
		return new Set([this.targetId, this._ids.subCounter.full]);
	}

	/**
	 * Handle routed state changes.
	 *
	 * Routing strategy:
	 * - Counter updates: update `subCounter` and evaluate due state.
	 * - subCounter writes: detect external resets/adjustments.
	 *
	 * @param {string} id State id.
	 * @param {object} state ioBroker state.
	 * @returns {void}
	 */
	onStateChange(id, state) {
		if (id === this.targetId) {
			this._onCounterChange(state);
			return;
		}
		if (id === this._ids.subCounter.full) {
			this._onSubCounterStateChange(state);
		}
	}

	/**
	 * Periodic evaluation tick.
	 *
	 * Needed to keep the time-based cycle accurate even without counter events.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	onTick(now) {
		this._updateDerivedStates(now, { force: false });
		this._evaluateAndSyncMessage(now);
	}

	/**
	 * Handle action events routed by MsgIngest (executed actions).
	 *
	 * Only reacts to `close` actions for *its own ref*.
	 *
	 * @param {object} actionInfo Executed action info.
	 * @returns {void}
	 */
	onAction(actionInfo) {
		const ref = typeof actionInfo?.ref === 'string' ? actionInfo.ref : '';
		if (!ref || ref !== this._getRef()) {
			return;
		}

		const closeType = this.ctx?.api?.constants?.actions?.type?.close || 'close';
		const type = typeof actionInfo?.type === 'string' ? actionInfo.type : '';
		if (type !== closeType) {
			return;
		}

		this._trace(`onAction close -> reset`);
		this._reset(Date.now(), { reason: 'action.close' });
	}

	/**
	 * Build a stable message ref for this rule instance.
	 *
	 * @returns {string} Stable message ref.
	 */
	_getRef() {
		return `${this.ctx?.meta?.plugin?.baseOwnId}.cycle.${this.targetId}`;
	}

	/**
	 * Reset cycle state (in-memory + persisted state mirror).
	 *
	 * @param {number} now Timestamp (ms).
	 * @param {{ reason?: string }} [meta] Meta.
	 * @returns {void}
	 */
	_reset(now, { reason = '' } = {}) {
		this._subCounter = 0;
		this._lastResetAt = Math.trunc(now);
		this._due = false;
		this._isActive = false;
		this._closeRequested = false;

		this._trace(`reset reason='${reason}' at=${this._lastResetAt}`);

		this._setAck(this._ids.subCounter.full, 0);
		this._setAck(this._ids.lastResetAt.full, this._lastResetAt);
		this._updateDerivedStates(now, { force: true });
		this._setAck(this._ids.due.full, false);
	}

	/**
	 * Debug logging helper (guarded by traceEvents).
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
		this._log.debug(`Cycle ${_shorten(this.targetId)}: ${msg}`);
	}

	/**
	 * Resolve the period threshold (count).
	 *
	 * @returns {number} Parsed period threshold (count).
	 */
	_resolvePeriod() {
		const raw = this.ruleConfig?.period;
		const n = this._toNumber(raw);
		return n > 0 ? n : 0;
	}

	/**
	 * Resolve the time limit (ms).
	 *
	 * @returns {number} Time limit in ms (0 = off).
	 */
	_resolveTimeMs() {
		const time = this._toNumber(this.ruleConfig?.time);
		const unit = this._toNumber(this.ruleConfig?.timeUnit);
		if (!(time > 0) || !(unit > 0)) {
			return 0;
		}
		const ms = Math.trunc(time * unit * 1000);
		return ms > 0 ? ms : 0;
	}

	/**
	 * Normalize a number-ish input into a finite number.
	 *
	 * @param {any} value Input.
	 * @returns {number} Finite number or NaN.
	 */
	_toNumber(value) {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'string') {
			const s = value.trim();
			if (!s) {
				return NaN;
			}
			const n = Number(s);
			return Number.isFinite(n) ? n : NaN;
		}
		return NaN;
	}

	/**
	 * Derive a short name from an object id (fallback for UI).
	 *
	 * @param {string} id Object/state id.
	 * @returns {string} Best-effort display name.
	 */
	_fallbackName(id) {
		const str = String(id || '');
		const parts = str.split('.').filter(Boolean);
		return parts.length ? parts[parts.length - 1] : str;
	}

	/**
	 * Resolve the best-available state label for metrics.
	 *
	 * Guarantees a stable metric key (`state-name`) even when object metadata is unavailable.
	 *
	 * @returns {string|null} State label or null when no fallback can be derived.
	 */
	_stateNameMetricValue() {
		const name = typeof this._name === 'string' ? this._name.trim() : '';
		if (name) {
			return name;
		}
		const fallback = this._fallbackName(this.targetId);
		const fallbackName = typeof fallback === 'string' ? fallback.trim() : '';
		return fallbackName || null;
	}

	/**
	 * Best-effort object meta lookup (name/unit).
	 *
	 * @returns {void}
	 */
	_loadObjectMeta() {
		const getObject = this.ctx?.api?.iobroker?.objects?.getForeignObject;
		if (typeof getObject !== 'function') {
			return;
		}
		Promise.resolve()
			.then(() => getObject(this.targetId))
			.then(obj => {
				let patchName = false;
				const name = typeof obj?.common?.name === 'string' ? obj.common.name.trim() : '';
				if (name && name !== this._name) {
					this._name = name;
					patchName = true;
				}
				const unit = typeof obj?.common?.unit === 'string' ? obj.common.unit.trim() : '';
				if (unit) {
					this._unit = unit;
				}

				if (patchName && this._isActive) {
					const writer = this._getMessageWriter();
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
	 * Ensure internal states exist and bootstrap cached values from ioBroker.
	 *
	 * Goals:
	 * - Restore persisted subCounter/lastCounter/lastResetAt after restart.
	 * - Mirror config values to states (for VIS).
	 *
	 * @returns {void}
	 */
	_bootstrapInternalState() {
		const objects = this.ctx?.api?.iobroker?.objects;
		const states = this.ctx?.api?.iobroker?.states;
		if (typeof objects?.setObjectNotExists !== 'function' || typeof states?.getForeignState !== 'function') {
			return;
		}

		Promise.resolve()
			.then(async () => {
				await this._ensureInternalStateObjects();

				// Mirror config for VIS / debugging.
				this._setAck(this._ids.period.full, this._period);
				this._setAck(this._ids.timeMs.full, this._timeMs);

				const sub = await states.getForeignState(this._ids.subCounter.full).catch(() => null);
				const last = await states.getForeignState(this._ids.lastCounter.full).catch(() => null);
				const reset = await states.getForeignState(this._ids.lastResetAt.full).catch(() => null);

				const subN = this._toNumber(sub?.val);
				if (Number.isFinite(subN) && subN >= 0) {
					this._subCounter = subN;
				}

				const lastN = this._toNumber(last?.val);
				if (Number.isFinite(lastN)) {
					this._lastCounter = lastN;
				}

				const resetN = this._toNumber(reset?.val);
				if (Number.isFinite(resetN) && resetN > 0) {
					this._lastResetAt = Math.trunc(resetN);
				} else {
					this._lastResetAt = Date.now();
					this._setAck(this._ids.lastResetAt.full, this._lastResetAt);
				}

				// If we have no lastCounter yet, initialize from current foreign counter to set a baseline.
				if (!Number.isFinite(this._lastCounter)) {
					const st = await states.getForeignState(this.targetId).catch(() => null);
					const current = this._toNumber(st?.val);
					if (Number.isFinite(current)) {
						this._lastCounter = current;
						this._setAck(this._ids.lastCounter.full, current);
					}
				}

				const now = Date.now();
				this._updateDerivedStates(now, { force: true });
				this._evaluateAndSyncMessage(now);
			})
			.catch(() => undefined);
	}

	/**
	 * Create internal ioBroker state objects (best-effort).
	 *
	 * @returns {Promise<void>} Resolves after creation attempt.
	 */
	async _ensureInternalStateObjects() {
		const setObjectNotExists = this.ctx?.api?.iobroker?.objects?.setObjectNotExists;
		if (typeof setObjectNotExists !== 'function') {
			return;
		}

		const defs = [
			{
				id: this._ids.subCounter.own,
				common: {
					name: 'Cycle subCounter (since last reset)',
					type: 'number',
					role: 'value',
					read: true,
					write: true,
				},
			},
			{
				id: this._ids.lastCounter.own,
				common: {
					name: 'Cycle lastCounter (internal)',
					type: 'number',
					role: 'value',
					read: true,
					write: false,
				},
			},
			{
				id: this._ids.lastResetAt.own,
				common: {
					name: 'Cycle lastResetAt (ms)',
					type: 'number',
					role: 'value.time',
					read: true,
					write: false,
				},
			},
			{
				id: this._ids.period.own,
				common: { name: 'Cycle period (config)', type: 'number', role: 'value', read: true, write: false },
			},
			{
				id: this._ids.timeMs.own,
				common: {
					name: 'Cycle timeMs (config)',
					type: 'number',
					role: 'value.interval',
					read: true,
					write: false,
				},
			},
			{
				id: this._ids.due.own,
				common: { name: 'Cycle due', type: 'boolean', role: 'indicator', read: true, write: false },
			},
			{
				id: this._ids.remainingCount.own,
				common: { name: 'Cycle remainingCount', type: 'number', role: 'value', read: true, write: false },
			},
			{
				id: this._ids.remainingTimeMs.own,
				common: {
					name: 'Cycle remainingTimeMs',
					type: 'number',
					role: 'value.interval',
					read: true,
					write: false,
				},
			},
			{
				id: this._ids.progressPct.own,
				common: { name: 'Cycle progressPct', type: 'number', role: 'value', read: true, write: false },
			},
		];

		await Promise.all(
			defs.map(async d => {
				try {
					await setObjectNotExists(d.id, {
						type: 'state',
						common: d.common,
						native: {},
					});
				} catch {
					// ignore (best-effort)
				}
			}),
		);
	}

	/**
	 * Handle changes on the foreign counter.
	 *
	 * - Adds deltas to `subCounter` on increases.
	 * - Ignores decreases for `subCounter` but still updates the baseline.
	 *
	 * @param {object} state ioBroker state.
	 * @returns {void}
	 */
	_onCounterChange(state) {
		const current = this._toNumber(state?.val);
		if (!Number.isFinite(current)) {
			return;
		}

		const prev = this._lastCounter;
		if (!Number.isFinite(prev)) {
			this._lastCounter = current;
			this._setAck(this._ids.lastCounter.full, current);
			return;
		}

		if (current > prev) {
			const delta = current - prev;
			this._subCounter += delta;
			this._setAck(this._ids.subCounter.full, this._subCounter);
		} else if (current < prev) {
			// Counter reset/decrease: ignore for subCounter, but keep lastCounter in sync.
		}

		this._lastCounter = current;
		this._setAck(this._ids.lastCounter.full, current);

		const now = Date.now();
		this._updateDerivedStates(now, { force: true });
		this._evaluateAndSyncMessage(now);
	}

	/**
	 * Detect external reset requests by writing `subCounter = 0` (ack:false).
	 *
	 * Also allows external adjustments to `subCounter` (best-effort).
	 *
	 * @param {object} state ioBroker state.
	 * @returns {void}
	 */
	_onSubCounterStateChange(state) {
		if (state?.ack === true) {
			return;
		}

		const next = this._toNumber(state?.val);
		if (!Number.isFinite(next) || next < 0) {
			return;
		}

		if (next === 0) {
			this._trace(`external reset request (subCounter=0)`);
			this._reset(Date.now(), { reason: 'external.subCounter' });

			// Complete the message in the store (task close or status delete).
			const actor = typeof state?.from === 'string' && state.from.trim() ? state.from.trim() : 'external';
			this.ctx?.api?.store?.completeAfterCauseEliminated?.(this._getRef(), { actor });
			return;
		}

		// External adjustments are allowed (best-effort), but always ack them back.
		this._subCounter = next;
		this._setAck(this._ids.subCounter.full, next);

		const now = Date.now();
		this._updateDerivedStates(now, { force: true });
		this._evaluateAndSyncMessage(now);
	}

	/**
	 * Update derived internal states (best-effort).
	 *
	 * The derived states are intended for VIS and quick debugging.
	 * We throttle writes to avoid excessive state churn.
	 *
	 * @param {number} now Timestamp (ms).
	 * @param {{ force?: boolean }} [options] Options.
	 * @returns {void}
	 */
	_updateDerivedStates(now, { force = false } = {}) {
		const minIntervalMs = 60000;
		if (!force && this._lastDerivedWriteAt && now - this._lastDerivedWriteAt < minIntervalMs) {
			return;
		}
		this._lastDerivedWriteAt = Math.trunc(now);

		const remainingCount = this._period > 0 ? Math.max(0, Math.trunc(this._period - this._subCounter)) : null;
		const elapsedMs = Math.max(0, Math.trunc(now - this._lastResetAt));
		const remainingTimeMs = this._timeMs > 0 ? Math.max(0, Math.trunc(this._timeMs - elapsedMs)) : null;

		const countPct = this._period > 0 ? Math.min(1, Math.max(0, this._subCounter / this._period)) : 0;
		const timePct = this._timeMs > 0 ? Math.min(1, Math.max(0, elapsedMs / this._timeMs)) : 0;
		const progressPct = Math.trunc(Math.max(countPct, timePct) * 100);

		if (remainingCount !== null) {
			this._setAck(this._ids.remainingCount.full, remainingCount);
		}
		if (remainingTimeMs !== null) {
			this._setAck(this._ids.remainingTimeMs.full, remainingTimeMs);
		}
		this._setAck(this._ids.progressPct.full, progressPct);
	}

	/**
	 * Evaluate due state and open/close message accordingly (best-effort).
	 *
	 * @param {number} now Timestamp (ms).
	 * @returns {void}
	 */
	_evaluateAndSyncMessage(now) {
		const dueByCount = this._period > 0 && this._subCounter >= this._period;
		const dueByTime = this._timeMs > 0 && now - this._lastResetAt >= this._timeMs;
		const due = dueByCount || dueByTime;

		if (due !== this._due) {
			this._due = due;
			this._setAck(this._ids.due.full, due);
		}

		if (due) {
			if (!this._isActive) {
				this._isActive = true;
				this._closeRequested = false;
				this._open(now);
			}
			this._patchMetrics(now);
			return;
		}

		if (!due && this._isActive) {
			this._isActive = false;
			this._close(now);
		}
	}

	/**
	 * Resolve message writer (CycleId / DefaultId / fallback).
	 *
	 * @returns {object|null} Writer.
	 */
	_getMessageWriter() {
		const writers = this.messageWriters;
		if (!writers || typeof writers !== 'object') {
			return null;
		}
		return writers.CycleId || writers.DefaultId || writers[fallbackPresetId] || null;
	}

	/**
	 * Open (upsert) the message.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_open(now) {
		const actionTypes = this.ctx?.api?.constants?.actions?.type || {};
		const typeAck = actionTypes.ack || 'ack';
		const typeSnooze = actionTypes.snooze || 'snooze';
		const typeClose = actionTypes.close || 'close';
		const actions = [
			{ id: 'ack', type: typeAck },
			{ id: 'snooze-4h', type: typeSnooze, payload: { forMs: 4 * 60 * 60 * 1000 } },
			{ id: 'close', type: typeClose },
		];

		const metrics = {};
		metrics['state-name'] = { val: this._stateNameMetricValue(), unit: '' };

		// Core cycle metrics (used by default presets and UI).
		metrics['cycle-lastResetAt'] = { val: this._lastResetAt, unit: 'ms' };
		metrics['cycle-subCounter'] = { val: this._subCounter, unit: this._unit || '' };
		if (this._period > 0) {
			metrics['cycle-period'] = { val: this._period, unit: this._unit || '' };
			metrics['cycle-remaining'] = {
				val: Math.max(0, Math.trunc(this._period - this._subCounter)),
				unit: this._unit || '',
			};
		}
		if (this._timeMs > 0) {
			metrics['cycle-timeMs'] = { val: this._timeMs, unit: 'ms' };
			metrics['cycle-timeBasedDueAt'] = { val: this._lastResetAt + this._timeMs, unit: 'ms' };
		}

		this._getMessageWriter()?.onUpsert?.(this._getRef(), { now, startAt: this._lastResetAt, actions, metrics });
	}

	/**
	 * Request closing the message once.
	 *
	 * @param {number} _now Timestamp (ms).
	 * @returns {void}
	 */
	_close(_now) {
		if (!this._closeRequested) {
			this._closeRequested = true;
			this._getMessageWriter()?.onClose?.(this._getRef());
		}
	}

	/**
	 * Patch message metrics while active.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	_patchMetrics(now) {
		const set = {
			'state-name': { val: this._stateNameMetricValue(), unit: '' },
			'cycle-lastResetAt': { val: this._lastResetAt, unit: 'ms' },
			'cycle-subCounter': { val: this._subCounter, unit: this._unit || '' },
		};
		if (this._period > 0) {
			set['cycle-period'] = { val: this._period, unit: this._unit || '' };
			set['cycle-remaining'] = {
				val: Math.max(0, Math.trunc(this._period - this._subCounter)),
				unit: this._unit || '',
			};
		}
		if (this._timeMs > 0) {
			set['cycle-timeMs'] = { val: this._timeMs, unit: 'ms' };
			set['cycle-timeBasedDueAt'] = { val: this._lastResetAt + this._timeMs, unit: 'ms' };
		}

		this._getMessageWriter()?.onMetrics?.(this._getRef(), { set, now });
	}

	/**
	 * Dispose rule instance.
	 *
	 * @returns {void}
	 */
	dispose() {
		// no-op
	}

	/**
	 * Set an ioBroker state with ack=true (best-effort).
	 *
	 * @param {string} id Full state id.
	 * @param {any} val Value.
	 * @returns {void}
	 */
	_setAck(id, val) {
		const set = this.ctx?.api?.iobroker?.states?.setForeignState;
		if (typeof set !== 'function') {
			return;
		}
		Promise.resolve()
			.then(() => set(id, { val, ack: true }))
			.catch(() => undefined);
	}
}

module.exports = { CycleRule };
