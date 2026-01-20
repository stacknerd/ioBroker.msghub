'use strict';

const { fallbackPresetId } = require('../constants');

/**
 * Freshness rule (missing updates).
 *
 * Opens a message when a target state has not been updated/changed within the configured time window,
 * and closes it again when the state becomes fresh.
 */
class FreshnessRule {
	/**
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

		this._name = this._fallbackName(targetId);
		this._lastSeenAt = null;
		this._isActive = false;
		this._closeRequested = false;
		this._stateFetchInFlight = false;

		this._loadObjectName();
		this._trace(
			`start targetId='${this.targetId}' evaluateBy='${this._evaluateBy}' thresholdMs=${this._thresholdMs}`,
		);
	}

	/**
	 * Resolve a message writer for the given preset id.
	 *
	 * Falls back to the engine-provided `$fallback` writer when the preset id is missing or unknown.
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
		return (key && writers[key]) || writers.ThresholdId || writers.DefaultId || writers[fallbackPresetId] || null;
	}

	/**
	 * Build a stable message ref for this rule instance.
	 *
	 * Uses `ctx.meta.plugin.baseOwnId` so refs are unique per adapter + plugin instance
	 * (e.g. `msghub.0.IngestStates.0`) and therefore safe for dedupe/update/delete by `ref`.
	 *
	 * @returns {string} Stable message ref.
	 */
	_getRef() {
		return `${this.ctx?.meta?.plugin?.baseOwnId}.freshness.${this.targetId}`;
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

		this._log.debug(`Freshnes ${_shorten(this.targetId)}: ${msg}`);
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

		const seenAt = this._readSeenAt(state);
		if (!seenAt) {
			return;
		}

		this._lastSeenAt = seenAt;

		if (this._isActive) {
			this._getMessageWriter().onMetrics(this._getRef(), {
				set: { lastSeenAt: { val: seenAt, unit: 'ms' } },
			});
		}
	}

	/**
	 * @param {number} now Current timestamp (ms).
	 * @returns {void}
	 */
	onTick(now) {
		if (!this._thresholdMs) {
			return;
		}

		const lastSeenAt = this._lastSeenAt;
		if (!lastSeenAt) {
			this._initLastSeenFromForeignState();
			return;
		}

		const ageMs = now - lastSeenAt;
		const isStale = ageMs > this._thresholdMs;

		if (isStale) {
			this._closeRequested = false;
			this._isActive = true;
			this._trace(`stale ageMs=${ageMs} thresholdMs=${this._thresholdMs} lastSeenAt=${lastSeenAt}`);

			const thresholdText = this._formatDuration(this._thresholdMs);
			const name = this._name;

			const t = this.ctx.api.i18n.t;

			const defaultTitle =
				this._evaluateBy === 'lc' ? t(`'%s' unchanged`, name) : t(`'%s' without updates`, name);
			const defaultText =
				this._evaluateBy === 'lc'
					? t(
							`%s has not changed for {{m.lastSeenAt|durationSince}} (last change: {{m.lastSeenAt|datetime}}). You asked to be notified if it does not change within %s.`,
							name,
							thresholdText,
						)
					: t(
							`%s has not been updated for {{m.lastSeenAt|durationSince}} (last update: {{m.lastSeenAt|datetime}}). You asked to be notified if it is not updated within %s.`,
							name,
							thresholdText,
						);
			const actions = [
				{ id: 'ack', type: 'ack' },
				{ id: 'snooze-4h', type: 'snooze', payload: { forMs: 4 * 60 * 60 * 1000 } },
			];

			const metrics = { lastSeenAt: { val: lastSeenAt, unit: 'ms' } };
			this._getMessageWriter().onUpsert(this._getRef(), { defaultTitle, defaultText, now, actions, metrics });
			return;
		}

		this._isActive = false;

		if (!this._closeRequested) {
			this._closeRequested = true;
			this._trace(`recovered ageMs=${ageMs} lastSeenAt=${lastSeenAt}`);
			this._getMessageWriter().onClose(this._getRef());
		}
	}

	/**
	 * Dispose the rule instance.
	 *
	 * @returns {void}
	 */
	dispose() {}

	/**
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
	 * @param {string} id Object/state id.
	 * @returns {string} Best-effort display name.
	 */
	_fallbackName(id) {
		const str = String(id || '');
		const parts = str.split('.').filter(Boolean);
		return parts.length ? parts[parts.length - 1] : str;
	}

	/**
	 * Best-effort: fetch `object.common.name` once and use it for wording.
	 *
	 * @returns {void}
	 */
	_loadObjectName() {
		const getObj = this.ctx?.api?.iobroker?.objects?.getForeignObject;
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
			})
			.catch(() => undefined);
	}

	/**
	 * Initialize `lastSeenAt` from the current foreign state (once; async).
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
				const seenAt = this._readSeenAt(st);
				if (seenAt) {
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
