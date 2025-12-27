'use strict';

/**
 * Skeleton for the Freshness evaluator.
 */
class FreshnessRule {
	/** @returns {Set<string>} Set of state ids required to evaluate this rule. */
	collectRequiredStateIds() {
		return new Set();
	}

	/** @returns {void} */
	evaluate() {}
}

module.exports = { FreshnessRule };
