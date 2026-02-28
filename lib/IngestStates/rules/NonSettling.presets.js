'use strict';

/**
 * Default presets for NonSettling rule.
 *
 * @param {object} options Inputs.
 * @param {Function} options.cloneTemplate Deep-clone helper for presetTemplateV1.
 * @param {string} options.kindStatus Message kind for status presets.
 * @param {number} options.levelNotice Message level for notice presets.
 * @returns {Array<object>} Preset list.
 */
function getNonSettlingPresets({ cloneTemplate, kindStatus, levelNotice }) {
	const presets = [];

	{
		const preset = cloneTemplate();
		preset.presetId = 'nonsettling_activity_resetOnNormal_true';
		preset.description = 'activity (auto reset)';
		preset.ownedBy = 'NonSettling';
		preset.subset = 'activity';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.nonSettling.activity.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.nonSettling.activity.text';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'nonsettling_activity_resetOnNormal_false';
		preset.description = 'activity (manual close)';
		preset.ownedBy = 'NonSettling';
		preset.subset = 'activity';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.nonSettling.activity.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.nonSettling.activity.textManualClose';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.nonSettling.activity.textRecovered';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'nonsettling_trend_resetOnNormal_true';
		preset.description = 'trend (auto reset)';
		preset.ownedBy = 'NonSettling';
		preset.subset = 'trend';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.nonSettling.trend.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.nonSettling.trend.text';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'nonsettling_trend_resetOnNormal_false';
		preset.description = 'trend (manual close)';
		preset.ownedBy = 'NonSettling';
		preset.subset = 'trend';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.nonSettling.trend.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.nonSettling.trend.textManualClose';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.nonSettling.trend.textRecovered';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	return presets;
}

module.exports = { getNonSettlingPresets };
