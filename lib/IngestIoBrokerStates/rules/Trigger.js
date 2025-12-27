'use strict';

/**
 * Skeleton for the Triggered dependency evaluator.
 */
class TriggerRule {
	/** @returns {Set<string>} Set of state ids required to evaluate this rule. */
	collectRequiredStateIds() {
		return new Set();
	}

	/** @returns {void} */
	evaluate() {}
}

module.exports = { TriggerRule };
