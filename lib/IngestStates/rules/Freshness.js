'use strict';

const { fallbackPresetId } = require('../constants');

/**
 * Freshness rule (missing updates).
 *
 * Opens a message when a target state has not been updated/changed within the configured time window,
 * and closes it again when the state becomes fresh.
 *
 * Developer notes (design intent):
 * - This rule is intentionally lightweight and mostly event driven:
 *   - `onStateChange` captures the last-known timestamps/value
 *   - `onTick` decides stale/ok and opens/closes accordingly
 * - Metrics strategy:
 *   - `state-ts` and `state-lc` are published as metrics when available.
 *   - They are tracked regardless of the chosen evaluation mode (`evaluateBy`), so templates can use both.
 *   - While the message is active, we only emit `onMetrics` when something actually changed to reduce noise.
 * - Writer behavior:
 *   - The writer is expected to handle additional dedupe/noise suppression. This rule still tries to keep patches minimal.
 */
class FreshnessRule {
	/**
	 * Create a new rule instance for one target id.
	 *
	 * The rule stores a few cached pieces of state:
	 * - `_lastSeenAt`: the timestamp used to judge freshness (either `ts` or `lc` based on `evaluateBy`)
	 * - `_stateTs/_stateLc`: best-effort cached raw timestamps from state events / bootstrap reads
	 * - `_value/_unit/_name`: best-effort meta/value for templating/metrics
	 *
	 * Most initialization here is best-effort: missing IO functions must not crash the rule.
	 *
	 * @param {object} info Rule inputs.
	 * @param {object} info.ctx Plugin runtime context.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {object} info.ruleConfig Rule config (from `fresh-*` keys).
	 * @param {object} info.messageWritersByPresetKey presetId -> writer map.
	 * @param {boolean} [info.traceEvents] Enable verbose debug logging.
	 */
	constructor({ ctx, targetId, ruleConfig = {}, messageWritersByPresetKey, traceEvents = false }) {
		this.targetId = targetId;
		this.ruleConfig = ruleConfig || {};
		this.messageWriters = messageWritersByPresetKey;
		this._traceEvents = traceEvents === true;
		this.ctx = ctx;
		this._log = this.ctx?.api?.log || null;

		this._evaluateBy = this.ruleConfig.evaluateBy === 'lc' ? 'lc' : 'ts';
		this._thresholdMs = this._resolveThresholdMs();
		if (!this._thresholdMs) {
			throw new Error(`FreshnessRule: invalid threshold config for '${targetId}'`);
		}

		// Display / meta information (best-effort; can be refined asynchronously).
		this._name = this._fallbackName(targetId);
		this._unit = '';
		this._value = null;

		// Cached timestamps from state events (independent of `evaluateBy`).
		// We use NaN as "unknown" sentinel because checkJs often infers `null` too narrowly.
		this._stateTs = NaN;
		this._stateLc = NaN;

		// The timestamp that drives freshness decisions; set by `onStateChange` and bootstrap.
		this._lastSeenAt = null;
		this._isActive = false;
		this._badStateActive = false;
		this._recoveredAtPatched = false;
		this._closeRequested = false;
		this._stateFetchInFlight = false;

		// Track last-emitted metric values so `onMetrics` can avoid no-op patches.
		this._lastMetrics = {
			value: undefined,
			ts: NaN,
			lc: NaN,
		};

		this._loadObjectMeta();
		this._trace(
			`start targetId='${this.targetId}' evaluateBy='${this._evaluateBy}' thresholdMs=${this._thresholdMs}`,
		);
	}

	/**
	 * Resolve a message writer for the given preset id.
	 *
	 * Falls back to the engine-provided `$fallback` writer when the preset id is missing or unknown.
	 *
	 * The engine injects a map of writers keyed by presetKey (e.g. `FreshnessId`, `DefaultId`),
	 * plus an internal `$fallback` writer.
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
		return (key && writers[key]) || writers.FreshnessId || writers.DefaultId || writers[fallbackPresetId] || null;
	}

	/**
	 * Build a stable message ref for this rule instance.
	 *
	 * Uses `ctx.meta.plugin.baseOwnId` so refs are unique per adapter + plugin instance
	 * (e.g. `msghub.0.IngestStates.0`) and therefore safe for dedupe/update/delete by `ref`.
	 *
	 * Note: `targetId` is embedded verbatim so the same datapoint always maps to the same message "line".
	 *
	 * @returns {string} Stable message ref.
	 */
	_getRef() {
		return `${this.ctx?.meta?.plugin?.baseOwnId}.freshness.${this.targetId}`;
	}

	/**
	 * Debug logging helper (guarded by `traceEvents`).
	 *
	 * Keep log payload compact: ids can be long, so we shorten them to the tail segment.
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

		this._log.debug(`Freshness ${_shorten(this.targetId)}: ${msg}`);
	}

	/**
	 * Declare required foreign state ids for this rule.
	 *
	 * The engine uses this to subscribe to state changes and to build reverse routing maps.
	 *
	 * @returns {Set<string>} Required foreign state ids.
	 */
	requiredStateIds() {
		return new Set([this.targetId]);
	}

	/**
	 * Handle a state change event routed by the engine.
	 *
	 * Responsibilities:
	 * - Cache `ts` and `lc` (independent of evaluation mode)
	 * - Cache `val` (raw, without parsing; freshness is about "when", not "what")
	 * - Update `_lastSeenAt` based on `evaluateBy` (`ts` or `lc`)
	 * - While active: patch changed metrics while keeping `state-name` present in each patch
	 *
	 * @param {string} id State id.
	 * @param {object} state ioBroker state.
	 * @returns {void}
	 */
	onStateChange(id, state) {
		if (id !== this.targetId) {
			return;
		}

		// Cache both timestamps regardless of `evaluateBy`, so templates can freely reference them.
		if (state && typeof state === 'object') {
			const ts = typeof state.ts === 'number' && Number.isFinite(state.ts) ? Math.trunc(state.ts) : NaN;
			if (Number.isFinite(ts)) {
				this._stateTs = ts;
			}
			const lc = typeof state.lc === 'number' && Number.isFinite(state.lc) ? Math.trunc(state.lc) : NaN;
			if (Number.isFinite(lc)) {
				this._stateLc = lc;
			}
		}

		// Cache raw value (can be any JSON-ish type). Do not coerce; rules/presets decide how to render.
		if (state && typeof state === 'object' && 'val' in state) {
			this._value = state.val;
		}

		// The "freshness clock": read whichever timestamp is configured (`ts` or `lc`).
		const seenAt = this._readSeenAt(state);
		if (seenAt === null) {
			return;
		}

		this._lastSeenAt = seenAt;

		if (this._isActive) {
			const now = Date.now();
			const isGoodState = now - seenAt <= this._thresholdMs;
			if (isGoodState) {
				this._badStateActive = false;
				this._patchRecoveredAt(seenAt);
				return;
			}

			this._badStateActive = true;
			this._recoveredAtPatched = false;

			// Only patch what changed to avoid noisy "updated" events downstream.
			const set = {};
			const stateName = this._stateNameMetricValue();

			const nextTs = this._evaluateBy === 'ts' ? seenAt : this._stateTs;
			const nextLc = this._evaluateBy === 'lc' ? seenAt : this._stateLc;

			if (Number.isFinite(nextTs) && nextTs !== this._lastMetrics.ts) {
				set['state-ts'] = { val: nextTs, unit: 'ms' };
				this._lastMetrics.ts = nextTs;
			}
			if (Number.isFinite(nextLc) && nextLc !== this._lastMetrics.lc) {
				set['state-lc'] = { val: nextLc, unit: 'ms' };
				this._lastMetrics.lc = nextLc;
			}

			if (this._value !== null && !Object.is(this._value, this._lastMetrics.value)) {
				set['state-value'] = { val: this._value, unit: this._unit || '' };
				this._lastMetrics.value = this._value;
			}
			// Keep `state-name` as a stable metric contract while active.
			set['state-name'] = { val: stateName, unit: '' };

			if (Object.keys(set).length) {
				this._getMessageWriter().onMetrics(this._getRef(), { set });
			}
		}
	}

	/**
	 * Periodic evaluation tick.
	 *
	 * This is where the rule decides:
	 * - "stale": open/upsert the message
	 * - "fresh": close the message (once)
	 *
	 * Bootstrap behavior:
	 * - If we have not seen any suitable timestamp yet, we asynchronously fetch the current foreign state once.
	 *   The next tick will then have `_lastSeenAt` and can evaluate normally.
	 *
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	onTick(now) {
		if (!this._thresholdMs) {
			return;
		}

		const lastSeenAt = this._lastSeenAt;
		if (lastSeenAt === null) {
			// We have no timestamp yet (e.g. just started, or state has never been observed).
			this._initLastSeenFromForeignState();
			return;
		}

		const ageMs = now - lastSeenAt;
		const isStale = ageMs > this._thresholdMs;

		if (isStale) {
			this._closeRequested = false;
			this._isActive = true;
			this._badStateActive = true;
			this._recoveredAtPatched = false;
			this._trace(`stale ageMs=${ageMs} thresholdMs=${this._thresholdMs} lastSeenAt=${lastSeenAt}`);

			const stateName = this._stateNameMetricValue();

			// Minimal default action set: ack + snooze.
			const actionTypes = this.ctx?.api?.constants?.actions?.type || {};
			const typeAck = actionTypes.ack || 'ack';
			const typeSnooze = actionTypes.snooze || 'snooze';
			const actions = [
				{ id: 'ack', type: typeAck },
				{ id: 'snooze-4h', type: typeSnooze, payload: { forMs: 4 * 60 * 60 * 1000 } },
			];

			// Build initial metrics for the message. Writer will convert to Map and handle dedupe/patching.
			const unit = this._unit || '';
			const metrics = {};
			metrics['state-name'] = { val: stateName, unit: '' };
			if (this._value !== null) {
				metrics['state-value'] = { val: this._value, unit };
			}
			const ts = this._evaluateBy === 'ts' ? lastSeenAt : this._stateTs;
			const lc = this._evaluateBy === 'lc' ? lastSeenAt : this._stateLc;
			if (Number.isFinite(ts)) {
				metrics['state-ts'] = { val: ts, unit: 'ms' };
			}
			if (Number.isFinite(lc)) {
				metrics['state-lc'] = { val: lc, unit: 'ms' };
			}

			// Seed the local "last emitted" cache so the next `onStateChange` does not re-patch unchanged values.
			if (this._value !== null) {
				this._lastMetrics.value = this._value;
			}
			if (Number.isFinite(ts)) {
				this._lastMetrics.ts = ts;
			}
			if (Number.isFinite(lc)) {
				this._lastMetrics.lc = lc;
			}

			// `startAt` is set to the last-seen timestamp so timing-related views can use it as domain start.
			this._getMessageWriter().onUpsert(this._getRef(), { now, startAt: lastSeenAt, actions, metrics });

			return;
		}

		if (this._isActive && this._badStateActive) {
			this._patchRecoveredAt(lastSeenAt);
		}
		this._badStateActive = false;
		this._isActive = false;

		// Close only once per recovery phase to avoid repeated close requests on subsequent ticks.
		if (!this._closeRequested) {
			this._closeRequested = true;
			this._trace(`recovered ageMs=${ageMs} lastSeenAt=${lastSeenAt}`);
			this._getMessageWriter().onClose(this._getRef());
		}
	}

	/**
	 * Dispose the rule instance.
	 *
	 * Intentionally empty: the rule uses no timers/subscriptions on its own.
	 * The engine owns subscriptions and will discard the instance on rescan/stop.
	 *
	 * @returns {void}
	 */
	dispose() {}

	/**
	 * Convert the configured threshold (`everyValue` + `everyUnit` seconds) into milliseconds.
	 *
	 * Returns `null` when the config is missing or invalid so the constructor can fail fast.
	 *
	 * @returns {number|null} Threshold ms or null when invalid.
	 */
	_resolveThresholdMs() {
		const value = this.ruleConfig.everyValue;
		const unitSeconds = this.ruleConfig.everyUnit;
		if (
			typeof value !== 'number' ||
			!Number.isFinite(value) ||
			value <= 0 ||
			typeof unitSeconds !== 'number' ||
			!Number.isFinite(unitSeconds) ||
			unitSeconds <= 0
		) {
			return null;
		}
		return Math.trunc(value * unitSeconds * 1000);
	}

	/**
	 * Read the timestamp used for freshness evaluation from an ioBroker state payload.
	 *
	 * The chosen field depends on `evaluateBy`:
	 * - `'ts'`: last update timestamp
	 * - `'lc'`: last change timestamp
	 *
	 * @param {object} state ioBroker state.
	 * @returns {number|null} Timestamp in ms.
	 */
	_readSeenAt(state) {
		const raw = state?.[this._evaluateBy];
		if (typeof raw !== 'number' || !Number.isFinite(raw)) {
			return null;
		}
		return Math.trunc(raw);
	}

	/**
	 * Derive a best-effort name from an object id (last path segment).
	 *
	 * Used as a fallback until object meta is fetched from ioBroker.
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
	 * Best-effort: fetch `object.common.name` once and use it for wording.
	 *
	 * Also tries to read `object.common.unit` for better metric rendering.
	 *
	 * If the message is already active and we learn a better name, we patch `state-name` once.
	 * (This keeps the message text stable while still improving context.)
	 *
	 * @returns {void}
	 */
	_loadObjectMeta() {
		const getObj = this.ctx?.api?.iobroker?.objects?.getForeignObject;
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

				if (patchName && this._isActive && this._badStateActive) {
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
	 * Patch recovery timestamp once per bad->good transition.
	 *
	 * @param {number} recoveredAt Transition timestamp (ms).
	 * @returns {void}
	 */
	_patchRecoveredAt(recoveredAt) {
		if (!this._isActive || this._recoveredAtPatched) {
			return;
		}
		if (typeof recoveredAt !== 'number' || !Number.isFinite(recoveredAt)) {
			return;
		}
		this._recoveredAtPatched = true;
		this._getMessageWriter().onMetrics(this._getRef(), {
			set: {
				'state-recovered-at': { val: Math.trunc(recoveredAt), unit: 'ms' },
			},
			now: Date.now(),
			force: true,
		});
	}

	/**
	 * Initialize `lastSeenAt` from the current foreign state (once; async).
	 *
	 * This is a bootstrap mechanism for "cold start" scenarios where:
	 * - the adapter starts up and we have not yet observed state changes, but
	 * - the state exists and has usable timestamps.
	 *
	 * The result is best-effort: failures are swallowed, and we only run one in-flight request at a time.
	 *
	 * @returns {void}
	 */
	_initLastSeenFromForeignState() {
		if (this._stateFetchInFlight) {
			return;
		}

		const getState = this.ctx?.api?.iobroker?.states?.getForeignState;
		if (typeof getState !== 'function') {
			return;
		}

		this._stateFetchInFlight = true;
		Promise.resolve()
			.then(() => getState(this.targetId))
			.then(st => {
				this._stateFetchInFlight = false;
				if (this._traceEvents) {
					let v = '[unavailable]';
					try {
						v = JSON.stringify(st?.val);
					} catch {
						v = '[unstringifiable]';
					}
					const ts = typeof st?.ts === 'number' && Number.isFinite(st.ts) ? Math.trunc(st.ts) : null;
					const lc = typeof st?.lc === 'number' && Number.isFinite(st.lc) ? Math.trunc(st.lc) : null;
					this._trace(`bootstrap state val=${v} ts=${ts} lc=${lc}`);
				}
				if (st && typeof st === 'object' && 'val' in st) {
					this._value = st.val;
				}
				// Cache both timestamps so we can expose both metrics when opening.
				const ts = typeof st?.ts === 'number' && Number.isFinite(st.ts) ? Math.trunc(st.ts) : NaN;
				if (Number.isFinite(ts)) {
					this._stateTs = ts;
				}
				const lc = typeof st?.lc === 'number' && Number.isFinite(st.lc) ? Math.trunc(st.lc) : NaN;
				if (Number.isFinite(lc)) {
					this._stateLc = lc;
				}
				const seenAt = this._readSeenAt(st);
				if (seenAt !== null) {
					this._lastSeenAt = seenAt;
				}
			})
			.catch(() => {
				this._stateFetchInFlight = false;
			});
	}

	/**
	 * Formats a duration (ms) using the same buckets as `MsgRender`:
	 * - < 1min: "56s"
	 * - < 1h: "34m"
	 * - < 1 day: "3:45h"
	 * - >= 1 day: "1d 4h"
	 *
	 * This is used only for debug/text formatting within the rule (not for template rendering).
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
}

module.exports = { FreshnessRule };
