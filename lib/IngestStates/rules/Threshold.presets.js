'use strict';

/**
 * Default presets for Threshold rule.
 *
 * @param {object} options Inputs.
 * @param {Function} options.cloneTemplate Deep-clone helper for presetTemplateV1.
 * @param {string} options.kindStatus Message kind for status presets.
 * @param {number} options.levelNotice Message level for notice presets.
 * @returns {Array<object>} Preset list.
 */
function getThresholdPresets({ cloneTemplate, kindStatus, levelNotice }) {
	const presets = [];

	// lt: violation when value < threshold
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_lt_resetOnNormal_true';
		preset.description = 'lt (auto reset)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'lt';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.threshold.lt.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.threshold.lt.text';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_lt_resetOnNormal_false';
		preset.description = 'lt (manual close)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'lt';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.threshold.lt.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.threshold.lt.textManualClose';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.threshold.lt.textRecovered';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	// gt: violation when value > threshold
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_gt_resetOnNormal_true';
		preset.description = 'gt (auto reset)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'gt';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.threshold.gt.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.threshold.gt.text';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_gt_resetOnNormal_false';
		preset.description = 'gt (manual close)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'gt';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.threshold.gt.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.threshold.gt.textManualClose';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.threshold.gt.textRecovered';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	// inside: violation when value is inside [min..max]
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_inside_resetOnNormal_true';
		preset.description = 'inside (auto reset)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'inside';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.threshold.inside.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.threshold.inside.text';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_inside_resetOnNormal_false';
		preset.description = 'inside (manual close)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'inside';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.threshold.inside.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.threshold.inside.textManualClose';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.threshold.inside.textRecovered';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	// outside: violation when value is outside [min..max]
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_outside_resetOnNormal_true';
		preset.description = 'outside (auto reset)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'outside';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.threshold.outside.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.threshold.outside.text';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_outside_resetOnNormal_false';
		preset.description = 'outside (manual close)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'outside';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.threshold.outside.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.threshold.outside.textManualClose';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.threshold.outside.textRecovered';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	// truesy: violation when value is truthy
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_truesy_resetOnNormal_true';
		preset.description = 'truesy (auto reset)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'truthy';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.threshold.truesy.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.threshold.truesy.text';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_truesy_resetOnNormal_false';
		preset.description = 'truesy (manual close)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'truthy';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.threshold.truesy.titleManualClose';
		preset.message.text = 'msghub.i18n.IngestStates.msg.threshold.truesy.textManualClose';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.threshold.truesy.textRecovered';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	// falsy: violation when value is falsy
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_falsy_resetOnNormal_true';
		preset.description = 'falsy (auto reset)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'falsy';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.threshold.falsy.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.threshold.falsy.text';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_falsy_resetOnNormal_false';
		preset.description = 'falsy (manual close)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'falsy';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.threshold.falsy.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.threshold.falsy.textManualClose';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.threshold.falsy.textRecovered';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	return presets;
}

module.exports = { getThresholdPresets };
