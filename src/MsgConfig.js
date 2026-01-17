/**
 * MsgConfig
 * =========
 *
 * Centralized configuration normalization for MsgHub.
 *
 * Why this exists
 * ---------------
 * `main.js` (ioBroker adapter wiring) consumes raw `adapter.config` and currently performs some
 * normalization inline (e.g. quiet hours). Over time, this tends to scatter parsing/validation logic
 * and makes it harder to:
 * - reuse the *effective* configuration in plugins (diagnostics like EngageTelegram `/config`)
 * - keep a single source of truth for config rules
 * - document the effective config model
 *
 * Design goals
 * ------------
 * - Normalize once, then pass normalized config to core constructors (core-private view).
 * - Expose a whitelisted, read-only snapshot for plugins (plugin-public view).
 * - Keep this module pure: no ioBroker access, no file I/O, no timers.
 *
 * Notes
 * -----
 * The repo is shipped as a whole, but we still keep an explicit schema version for the normalized
 * config model so plugins can reason about shape changes intentionally.
 */

'use strict';

const MsgConfig = Object.freeze({
	/**
	 * Normalized config schema version.
	 *
	 * This is intentionally separate from the adapter/package version:
	 * - it documents the shape of the normalized config model
	 * - it allows deliberate, explicit evolution of the plugin-facing config snapshot
	 */
	schemaVersion: 1,

	/**
	 * Normalize the raw adapter configuration into a stable, internal config model.
	 *
	 * Contract
	 * --------
	 * - Returns both a core-private and a plugin-public view.
	 * - Both views are deep-frozen at the top-level (and on nested objects created here).
	 * - `pluginPublic` must not be the same object reference as `corePrivate` (separate copies),
	 *   even if the current field set matches.
	 *
	 * @param {object} params Params.
	 * @param {object} [params.adapterConfig] Raw ioBroker adapter config (`this.config` in `main.js`).
	 * @param {object} [params.msgConstants] MsgConstants (levels/kinds); used for normalization later.
	 * @param {number} [params.notifierIntervalMs] Effective notifier interval (used for quiet hours validation later).
	 * @param {object} [params.log] Optional logger facade (supports `error|warn|info|debug`).
	 * @returns {{ corePrivate: { quietHours: object|null }, pluginPublic: { quietHours: object|null }, errors: ReadonlyArray<string> }} Normalized config bundle.
	 */
	normalize({ adapterConfig: _adapterConfig, msgConstants: _msgConstants, notifierIntervalMs: _ms, log: _log } = {}) {
		const errors = [];
		const adapterConfig = _adapterConfig && typeof _adapterConfig === 'object' ? _adapterConfig : {};
		const notifierIntervalMs = typeof _ms === 'number' ? _ms : Number(_ms);
		const log = _log && typeof _log === 'object' ? _log : null;

		/**
		 * Record a normalization issue.
		 *
		 * We keep these as stable "codes" (plain strings) so callers/tests can reason about outcomes
		 * without parsing log messages.
		 *
		 * @param {string} code Stable error code.
		 * @param {string} [message] Optional human hint (best-effort logged).
		 * @returns {void}
		 */
		const pushError = (code, message) => {
			const c = typeof code === 'string' ? code.trim() : '';
			if (!c) {
				return;
			}
			errors.push(c);
			if (message && typeof log?.error === 'function') {
				log.error(String(message));
			}
		};

		/**
		 * Parse "HH:MM" into minutes since midnight.
		 *
		 * This intentionally mirrors `main.js` behavior: strict and predictable.
		 *
		 * @param {any} value Raw input.
		 * @param {string} label Field label (for error codes).
		 * @returns {number|null} Minutes since midnight or null on invalid.
		 */
		const parseTimeStringToMinutesStrict = (value, label) => {
			const raw = typeof value === 'string' ? value.trim() : '';
			const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
			if (!m) {
				pushError(
					`quietHours.disabled.invalidTime.${label}`,
					`MsgConfig: invalid ${label} time '${raw || String(value)}' (expected HH:MM)`,
				);
				return null;
			}
			return Number(m[1]) * 60 + Number(m[2]);
		};

		/**
		 * Normalize quiet hours configuration (effective config).
		 *
		 * Rules are mirrored from `main.js`:
		 * - Feature is disabled when notifier polling is disabled (`notifierIntervalMs <= 0`).
		 * - Times must be strict "HH:MM", start != end.
		 * - `maxLevel` and `spreadMin` must be numeric.
		 * - Quiet window must leave >= 4h outside, spread must fit the outside window.
		 *
		 * @returns {{ enabled: true, startMin: number, endMin: number, maxLevel: number, spreadMs: number }|null} Quiet-hours config or null when disabled.
		 */
		const normalizeQuietHours = () => {
			const enabled = adapterConfig?.quietHoursEnabled !== false;
			if (!enabled) {
				return null;
			}
			if (!Number.isFinite(notifierIntervalMs) || notifierIntervalMs <= 0) {
				pushError(
					'quietHours.disabled.notifierIntervalMs',
					'MsgConfig: quiet hours require notifierIntervalMs > 0 (feature disabled)',
				);
				return null;
			}

			const startMin = parseTimeStringToMinutesStrict(adapterConfig?.quietHoursStart, 'quietHoursStart');
			const endMin = parseTimeStringToMinutesStrict(adapterConfig?.quietHoursEnd, 'quietHoursEnd');
			if (startMin == null || endMin == null) {
				return null;
			}
			if (startMin === endMin) {
				pushError(
					'quietHours.disabled.startEqualsEnd',
					'MsgConfig: quiet hours start == end is not allowed (feature disabled)',
				);
				return null;
			}

			const maxLevelRaw = adapterConfig?.quietHoursMaxLevel;
			const maxLevelParsed = typeof maxLevelRaw === 'number' ? maxLevelRaw : Number(maxLevelRaw);
			const spreadMinRaw = adapterConfig?.quietHoursSpreadMin;
			const spreadMinParsed = typeof spreadMinRaw === 'number' ? spreadMinRaw : Number(spreadMinRaw);

			if (!Number.isFinite(maxLevelParsed) || !Number.isFinite(spreadMinParsed)) {
				pushError(
					'quietHours.disabled.invalidMaxLevelOrSpreadMin',
					'MsgConfig: quiet hours require numeric maxLevel and spreadMin (feature disabled)',
				);
				return null;
			}

			const maxLevel = Math.trunc(maxLevelParsed);
			const spreadMin = Math.max(0, Math.trunc(spreadMinParsed));

			const quietDurationMin = startMin < endMin ? endMin - startMin : 24 * 60 - startMin + endMin;
			const freeMin = 24 * 60 - quietDurationMin;
			if (freeMin < 240) {
				pushError(
					'quietHours.disabled.tooLittleFreeTime',
					'MsgConfig: quiet hours must leave at least 4 hours outside the quiet window (feature disabled)',
				);
				return null;
			}
			if (spreadMin > freeMin) {
				pushError(
					'quietHours.disabled.spreadDoesNotFit',
					'MsgConfig: quiet hours spread window must fit into non-quiet time (feature disabled)',
				);
				return null;
			}

			return Object.freeze({
				enabled: true,
				startMin,
				endMin,
				maxLevel,
				spreadMs: spreadMin * 60 * 1000,
			});
		};

		const quietHours = normalizeQuietHours();

		const corePrivate = Object.freeze({
			quietHours,
		});

		// Separate copy to keep the plugin-facing snapshot isolated from core-private objects.
		const pluginPublic = Object.freeze({
			quietHours: quietHours ? Object.freeze({ ...quietHours }) : null,
		});

		return Object.freeze({ corePrivate, pluginPublic, errors: Object.freeze(errors) });
	},
});

module.exports = { MsgConfig };
