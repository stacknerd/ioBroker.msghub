'use strict';

/**
 * Skeleton for the Threshold evaluator.
 */
class ThresholdRule {
	/** @returns {Set<string>} Set of state ids required to evaluate this rule. */
	collectRequiredStateIds() {
		return new Set();
	}

	/** @returns {void} */
	evaluate() {}
}

module.exports = { ThresholdRule };
