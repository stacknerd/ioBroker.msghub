'use strict';

/**
 * Skeleton for the registry built from ioBroker customs.
 *
 * Intended contents:
 * - rulesByTargetId: Map<targetId, normalizedRuleCfg>
 * - requiredStateIdsByTargetId: Map<targetId, Set<stateId>>
 * - targetsByStateId: Map<stateId, Set<targetId>>
 * - watchedObjectIds: Set<objectId> (to observe future changes)
 */
class IngestIoBrokerStatesRegistry {
	/** Create an empty registry. */
	constructor() {
		this.rulesByTargetId = new Map();
		this.requiredStateIdsByTargetId = new Map();
		this.targetsByStateId = new Map();
		this.watchedObjectIds = new Set();
	}

	/** @returns {void} */
	clear() {
		this.rulesByTargetId.clear();
		this.requiredStateIdsByTargetId.clear();
		this.targetsByStateId.clear();
		this.watchedObjectIds.clear();
	}
}

module.exports = { IngestIoBrokerStatesRegistry };
