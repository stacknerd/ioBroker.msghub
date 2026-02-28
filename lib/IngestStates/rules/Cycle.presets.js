'use strict';

/**
 * Default presets for Cycle rule.
 *
 * @param {object} options Inputs.
 * @param {Function} options.cloneTemplate Deep-clone helper for presetTemplateV1.
 * @param {string} options.kindTask Message kind for task presets.
 * @param {number} options.levelNotice Message level for notice presets.
 * @returns {Array<object>} Preset list.
 */
function getCyclePresets({ cloneTemplate, kindTask, levelNotice }) {
	const presets = [];

	{
		const preset = cloneTemplate();
		preset.presetId = 'cycle_default_task';
		preset.description = 'cycle (task)';
		preset.ownedBy = 'Cycle';
		preset.subset = '';
		preset.message.kind = kindTask;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.cycle.default.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.cycle.default.text';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}

	return presets;
}

module.exports = { getCyclePresets };
