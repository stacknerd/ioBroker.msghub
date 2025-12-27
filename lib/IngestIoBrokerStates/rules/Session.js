'use strict';

/**
 * Skeleton for the Session evaluator.
 */
class SessionRule {
	/** @returns {Set<string>} Set of state ids required to evaluate this rule. */
	collectRequiredStateIds() {
		return new Set();
	}

	/** @returns {void} */
	evaluate() {}
}

module.exports = { SessionRule };
