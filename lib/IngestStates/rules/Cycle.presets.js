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
		preset.message.title = "'{{m.state-name.val}}' fällig (Zyklus)";
		preset.message.text =
			'Bitte Aufgabe erledigen und anschließend die Meldung schließen (Reset).\n\n' +
			'Seit Reset: {{m.cycle-subCounter}} / {{m.cycle-period}} {{m.cycle-subCounter.unit}}.\n' +
			'Reset zuletzt: {{m.cycle-lastResetAt|durationSince}} ({{m.cycle-lastResetAt.val|datetime}}).\n' +
			'Start: {{t.startedAt|datetime}}';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}

	return presets;
}

module.exports = { getCyclePresets };
