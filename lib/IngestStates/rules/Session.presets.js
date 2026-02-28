'use strict';

/**
 * Default presets for Session rule.
 *
 * @param {object} options Inputs.
 * @param {Function} options.cloneTemplate Deep-clone helper for presetTemplateV1.
 * @param {string} options.kindStatus Message kind for status presets.
 * @param {string} options.kindTask Message kind for task presets.
 * @param {number} options.levelNotice Message level for notice presets.
 * @returns {Array<object>} Preset list.
 */
function getSessionPresets({ cloneTemplate, kindStatus, kindTask, levelNotice }) {
	const presets = [];

	{
		const preset = cloneTemplate();
		preset.presetId = 'session_start_default';
		preset.description = 'start';
		preset.ownedBy = 'Session';
		preset.subset = 'start';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.session.start.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.session.start.text';
		preset.message.timing.expiresInMs = 3 * 24 * 60 * 60 * 1000;
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'session_end_resetOnNormal_true';
		preset.description = 'end (auto expire in 3 days)';
		preset.ownedBy = 'Session';
		preset.subset = 'end';
		preset.message.kind = kindTask;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.session.end.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.session.end.text';
		preset.message.timing.expiresInMs = 3 * 24 * 60 * 60 * 1000;
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'session_end_resetOnNormal_false';
		preset.description = 'end (manual close)';
		preset.ownedBy = 'Session';
		preset.subset = 'end';
		preset.message.kind = kindTask;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.session.end.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.session.end.textManualClose';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'session_end_summary_resetOnNormal_true';
		preset.description = 'end with summary (auto expire in 3 days)';
		preset.ownedBy = 'Session';
		preset.subset = 'end+summary';
		preset.message.kind = kindTask;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.session.end.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.session.endSummary.text';
		preset.message.timing.expiresInMs = 3 * 24 * 60 * 60 * 1000;
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'session_end_summary_resetOnNormal_false';
		preset.description = 'end with summary (manual close)';
		preset.ownedBy = 'Session';
		preset.subset = 'end+summary';
		preset.message.kind = kindTask;
		preset.message.level = levelNotice;
		preset.message.title = 'msghub.i18n.IngestStates.msg.session.end.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.session.endSummary.textManualClose';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	return presets;
}

module.exports = { getSessionPresets };
