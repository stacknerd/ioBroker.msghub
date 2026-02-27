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
		preset.description = 'start (auto reset)';
		preset.ownedBy = 'Session';
		preset.subset = 'start';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'Session gestartet';
		preset.message.text = 'Session gestartet.\n' + 'Start: {{t.startedAt|datetime}}';
		preset.message.timing.expiresInMs = 3 * 24 * 60 * 60 * 1000;
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'session_end_resetOnNormal_true';
		preset.description = 'end (auto reset)';
		preset.ownedBy = 'Session';
		preset.subset = 'end';
		preset.message.kind = kindTask;
		preset.message.level = levelNotice;
		preset.message.title = 'Session beendet';
		preset.message.text =
			'Session beendet.\n' + 'Start: {{m.session-start.val|datetime}}.\n' + 'Ende: {{t.endAt|datetime}}';
		preset.message.timing.expiresInMs = 3 * 24 * 60 * 60 * 1000;
		preset.policy.resetOnNormal = true;
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
		preset.message.title = 'Session beendet';
		preset.message.text =
			'Session beendet.\n' +
			'Start: {{m.session-start.val|datetime}}.\n' +
			'Ende: {{t.endAt|datetime}}\n' +
			'Diese Meldung kann geschlossen werden.';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'session_end_summary_resetOnNormal_true';
		preset.description = 'end with summary (auto reset)';
		preset.ownedBy = 'Session';
		preset.subset = 'end+summary';
		preset.message.kind = kindTask;
		preset.message.level = levelNotice;
		preset.message.title = 'Session beendet';
		preset.message.text =
			'Session beendet.\n' +
			'Start: {{m.session-start.val|datetime}}.\n' +
			'Ende: {{t.endAt|datetime}}.\n' +
			'Verbrauch: {{m.session-counter}}.\n' +
			'Kosten: {{m.session-cost}}.';
		preset.message.timing.expiresInMs = 3 * 24 * 60 * 60 * 1000;
		preset.policy.resetOnNormal = true;
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
		preset.message.title = 'Session beendet';
		preset.message.text =
			'Session beendet.\n' +
			'Start: {{m.session-start.val|datetime}}.\n' +
			'Ende: {{t.endAt|datetime}}.\n' +
			'Verbrauch: {{m.session-counter}}.\n' +
			'Kosten: {{m.session-cost}}.\n' +
			'Diese Meldung kann geschlossen werden.';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	return presets;
}

module.exports = { getSessionPresets };
