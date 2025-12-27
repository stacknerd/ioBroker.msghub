'use strict';

/**
 * Skeleton for a polling helper that periodically rescans customs.
 *
 * This is a placeholder; the current implementation lives in `lib/IngestIoBrokerStates/Engine.js`.
 */
class IngestIoBrokerStatesPoller {
	/**
	 * @param {object} [options] Poller options.
	 * @param {number} [options.intervalMs] Tick interval in milliseconds.
	 * @param {() => Promise<void>} [options.onTick] Callback invoked on each tick.
	 */
	constructor({ intervalMs = 180000, onTick } = {}) {
		this.intervalMs = intervalMs;
		this.onTick = onTick;
		this._timer = null;
	}

	/** @returns {void} */
	start() {}

	/** @returns {void} */
	stop() {}
}

module.exports = { IngestIoBrokerStatesPoller };
