'use strict';

/**
 * Skeleton for the Non-settling evaluator.
 */
class NonSettlingRule {
	/** @returns {Set<string>} Set of state ids required to evaluate this rule. */
	collectRequiredStateIds() {
		return new Set();
	}

	/** @returns {void} */
	evaluate() {}
}

module.exports = { NonSettlingRule };
