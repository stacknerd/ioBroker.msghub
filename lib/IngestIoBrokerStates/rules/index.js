'use strict';

/**
 * Skeleton rule registry for IngestIoBrokerStates.
 */

const { ThresholdRule } = require('./Threshold');
const { FreshnessRule } = require('./Freshness');
const { TriggerRule } = require('./Trigger');
const { NonSettlingRule } = require('./NonSettling');
const { SessionRule } = require('./Session');

module.exports = {
	ThresholdRule,
	FreshnessRule,
	TriggerRule,
	NonSettlingRule,
	SessionRule,
};

