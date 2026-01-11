'use strict';

/**
 * MsgNotificationPolicy
 *
 * Docs: ../docs/modules/MsgNotificationPolicy.md
 *
 * Stateless policy helpers used by `MsgStore` for notification behavior.
 *
 * Core responsibilities
 * - Implement quiet-hours window checks based on normalized configuration.
 * - Provide deterministic calculations for "quiet hours end" and reschedule timestamps.
 * - Decide whether a scheduled `due` notification should be suppressed (repeat-only semantics).
 *
 * Design guidelines / invariants
 * - Pure logic only: this module does not access the store, does not dispatch notifications, and does not mutate messages.
 * - Inputs are expected to be normalized by the caller (e.g. `main.js` for configuration; `MsgFactory`/`MsgStore` for message shape).
 * - Local time: quiet-hours calculations are based on the local wall clock (Date.getHours/getMinutes).
 * - Half-open interval: start is inclusive, end is exclusive (`start <= t < end`).
 * - Cross-midnight is supported: e.g. 22:00..06:00 suppresses at night and ends next morning.
 */
class MsgNotificationPolicy {
	/**
	 * @param {number} ts Timestamp (ms).
	 * @returns {number} Minutes since local midnight.
	 */
	static _getMinutesSinceLocalMidnight(ts) {
		const d = new Date(ts);
		return d.getHours() * 60 + d.getMinutes();
	}

	/**
	 * @param {number} ts Timestamp (ms).
	 * @returns {number} Local midnight timestamp (ms).
	 */
	static _getLocalMidnightTs(ts) {
		const d = new Date(ts);
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	}

	/**
	 * Determine whether `now` is inside the configured quiet-hours window.
	 *
	 * Semantics:
	 * - Requires `quietHours.enabled === true`.
	 * - Window is defined as minutes since midnight (`startMin`, `endMin`), evaluated in local time.
	 * - Non-cross-midnight window (`startMin < endMin`): `startMin <= m < endMin`
	 * - Cross-midnight window (`startMin > endMin`): `m >= startMin || m < endMin`
	 *
	 * @param {number} now Timestamp (ms).
	 * @param {{ enabled: boolean, startMin: number, endMin: number }} quietHours Normalized quiet-hours config.
	 * @returns {boolean} True when `now` is inside the quiet-hours window.
	 */
	static isInQuietHours(now, quietHours) {
		if (!quietHours || quietHours.enabled !== true) {
			return false;
		}
		const startMin = quietHours.startMin;
		const endMin = quietHours.endMin;
		if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) {
			return false;
		}

		const m = MsgNotificationPolicy._getMinutesSinceLocalMidnight(now);
		if (startMin < endMin) {
			return m >= startMin && m < endMin;
		}
		// Cross-midnight window: e.g. 22:00..06:00
		return m >= startMin || m < endMin;
	}

	/**
	 * Compute the timestamp when quiet hours end.
	 *
	 * Notes:
	 * - Returns `null` when `now` is outside quiet hours (callers typically treat that as "no reschedule needed").
	 * - For non-cross-midnight windows, the end is always "today" at `endMin`.
	 * - For cross-midnight windows:
	 *   - When `now` is after the start time (late evening), the end is tomorrow morning at `endMin`.
	 *   - When `now` is before the end time (early morning), the end is today at `endMin`.
	 *
	 * @param {number} now Timestamp (ms).
	 * @param {{ enabled: boolean, startMin: number, endMin: number }} quietHours Normalized quiet-hours config.
	 * @returns {number|null} Timestamp (ms) when quiet hours end (from the perspective of `now`), or null if not in quiet hours.
	 */
	static getQuietHoursEndTs(now, quietHours) {
		if (!MsgNotificationPolicy.isInQuietHours(now, quietHours)) {
			return null;
		}

		const startMin = quietHours.startMin;
		const endMin = quietHours.endMin;
		const midnight = MsgNotificationPolicy._getLocalMidnightTs(now);

		const endToday = midnight + endMin * 60_000;
		if (startMin < endMin) {
			return endToday;
		}

		// Cross-midnight window: decide whether it ends today (morning) or tomorrow (after start).
		const startToday = midnight + startMin * 60_000;
		if (now >= startToday) {
			return midnight + 24 * 60 * 60_000 + endMin * 60_000;
		}
		return endToday;
	}

	/**
	 * Decide whether a scheduled `due` notification should be suppressed due to quiet hours.
	 *
	 * Semantics (current design):
	 * - Applies only when `quietHours.enabled === true` and `now` is within the quiet window.
	 * - Applies only for messages with `level <= quietHours.maxLevel` ("important" messages above that threshold always dispatch).
	 * - Suppresses repeats only:
	 *   - A "repeat" is detected by `msg.timing.notifiedAt.due` being a finite timestamp (> 0).
	 *   - The first `due` notification is still dispatched, even during quiet hours.
	 *
	 * @param {object} root0 Options.
	 * @param {object} root0.msg Message.
	 * @param {number} root0.now Timestamp (ms).
	 * @param {{ enabled: boolean, startMin: number, endMin: number, maxLevel: number }} root0.quietHours Normalized quiet-hours config.
	 * @returns {boolean} True when a scheduled `due` should be suppressed.
	 */
	static shouldSuppressDue({ msg, now, quietHours }) {
		if (!quietHours || quietHours.enabled !== true) {
			return false;
		}
		if (!MsgNotificationPolicy.isInQuietHours(now, quietHours)) {
			return false;
		}
		const level = msg?.level;
		if (!Number.isFinite(level) || level > quietHours.maxLevel) {
			return false;
		}
		// Suppress only repeats; first notification is delivered even during quiet hours.
		const lastDue = msg?.timing?.notifiedAt?.due;
		return Number.isFinite(lastDue) && lastDue > 0;
	}

	/**
	 * Compute a reschedule timestamp for a suppressed scheduled `due`.
	 *
	 * Behavior:
	 * - Returns `null` when `now` is not inside quiet hours (no suppression window).
	 * - Returns quiet-hours end timestamp if `spreadMs` is missing/<=0.
	 * - Otherwise: `quietEnd + jitter`, where jitter is uniformly distributed in `[0..spreadMs]`.
	 *
	 * Notes:
	 * - The returned timestamp is intended to become `timing.notifyAt` (store-owned scheduling marker).
	 * - `randomFn` is injectable for deterministic tests.
	 *
	 * @param {object} root0 Options.
	 * @param {number} root0.now Timestamp (ms).
	 * @param {{ enabled: boolean, startMin: number, endMin: number, spreadMs: number }} root0.quietHours Normalized quiet-hours config.
	 * @param {() => number} [root0.randomFn] Random function injection (tests).
	 * @returns {number|null} Rescheduled notifyAt timestamp (ms) or null.
	 */
	static computeQuietRescheduleTs({ now, quietHours, randomFn = Math.random }) {
		const endTs = MsgNotificationPolicy.getQuietHoursEndTs(now, quietHours);
		if (endTs === null) {
			return null;
		}
		if (!Number.isFinite(endTs)) {
			return null;
		}
		const spreadMs = quietHours?.spreadMs;
		if (!Number.isFinite(spreadMs) || spreadMs <= 0) {
			return endTs;
		}
		const r = typeof randomFn === 'function' ? randomFn() : Math.random();
		const fraction = typeof r === 'number' && Number.isFinite(r) ? Math.max(0, Math.min(1, r)) : 0;
		return endTs + Math.trunc(fraction * spreadMs);
	}
}

module.exports = { MsgNotificationPolicy };
