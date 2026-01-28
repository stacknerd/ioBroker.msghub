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
		preset.message.title = 'Wert nicht stabil';
		preset.message.text =
			'Der Wert ist seit {{m.trendStartedAt|durationSince}} nicht stabil.\n' +
			'Schwankung: {{m.trendMinToMax}}.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = 'Wert nicht stabil';
		preset.message.text =
			'Der Wert ist seit {{m.trendStartedAt|durationSince}} nicht stabil.\n' +
			'Schwankung: {{m.trendMinToMax}}.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Diese Meldung kann geschlossen werden.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = 'Unerwarteter Trend';
		preset.message.text =
			'Der Wert trendet seit {{m.trendStartedAt|durationSince}} in Richtung {{m.trendDir}}.\n' +
			'Änderung: {{m.trendMinToMax}}.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = 'Unerwarteter Trend';
		preset.message.text =
			'Der Wert trendet seit {{m.trendStartedAt|durationSince}} in Richtung {{m.trendDir}}.\n' +
			'Änderung: {{m.trendMinToMax}}.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Diese Meldung kann geschlossen werden.\n' +
			'Start: {{t.startedAt|datetime}}';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	return presets;
}

module.exports = { getNonSettlingPresets };
