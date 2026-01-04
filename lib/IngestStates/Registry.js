'use strict';

class IngestStatesRegistry {
	constructor() {
		this.rulesByTargetId = new Map();
		this.requiredStateIdsByTargetId = new Map();
		this.targetsByStateId = new Map();
		this.watchedObjectIds = new Set();
	}

	clear() {
		this.rulesByTargetId.clear();
		this.requiredStateIdsByTargetId.clear();
		this.targetsByStateId.clear();
		this.watchedObjectIds.clear();
	}
}

module.exports = { IngestStatesRegistry };

