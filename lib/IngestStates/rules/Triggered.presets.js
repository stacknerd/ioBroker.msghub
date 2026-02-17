'use strict';

/**
 * Default presets for Triggered rule.
 *
 * @param {object} options Inputs.
 * @param {Function} options.cloneTemplate Deep-clone helper for presetTemplateV1.
 * @param {string} options.kindStatus Message kind for status presets.
 * @param {number} options.levelNotice Message level for notice presets.
 * @returns {Array<object>} Preset list.
 */
function getTriggeredPresets({ cloneTemplate, kindStatus, levelNotice }) {
	const presets = [];

	{
		const preset = cloneTemplate();
		preset.presetId = 'triggered_changed_resetOnNormal_true';
		preset.description = 'changed (auto reset)';
		preset.ownedBy = 'Triggered';
		preset.subset = 'changed';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'Reaktion ausgeblieben';
		preset.message.text =
			'Trigger ist aktiv, aber der Wert hat sich im Zeitfenster nicht geändert.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Trigger-Wert: {{m.trigger-value}}.\n' +
			'Start: {{t.startedAt.val|datetime}}';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'triggered_changed_resetOnNormal_false';
		preset.description = 'changed (manual close)';
		preset.ownedBy = 'Triggered';
		preset.subset = 'changed';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'Reaktion ausgeblieben';
		preset.message.text =
			'Trigger ist aktiv, aber der Wert hat sich im Zeitfenster nicht geändert.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Trigger-Wert: {{m.trigger-value}}.\n' +
			'Start: {{t.startedAt.val|datetime}}';
		preset.message.textRecovered =
			'Trigger war/ist aktiv, aber der Wert hatte sich im Zeitfenster nicht geändert.\n' +
			'Start: {{t.startedAt.val|datetime}}\n' +
			'OK seit: {{m.state-recovered-at.val|datetime}}\n' +
			'Diese Meldung kann geschlossen werden.';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'triggered_deltaUp_resetOnNormal_true';
		preset.description = 'deltaUp (auto reset)';
		preset.ownedBy = 'Triggered';
		preset.subset = 'deltaUp';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'Reaktion ausgeblieben';
		preset.message.text =
			'Trigger ist aktiv, aber der Wert hat sich nicht ausreichend erhöht.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Trigger-Wert: {{m.trigger-value}}.\n' +
			'Start: {{t.startedAt.val|datetime}}';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'triggered_deltaUp_resetOnNormal_false';
		preset.description = 'deltaUp (manual close)';
		preset.ownedBy = 'Triggered';
		preset.subset = 'deltaUp';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'Reaktion ausgeblieben';
		preset.message.text =
			'Trigger ist aktiv, aber der Wert hat sich nicht ausreichend erhöht.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Trigger-Wert: {{m.trigger-value}}.\n' +
			'Start: {{t.startedAt.val|datetime}}';
		preset.message.textRecovered =
			'Trigger war/ist aktiv, aber der Wert hatte sich nicht ausreichend erhöht.\n' +
			'Start: {{t.startedAt.val|datetime}}\n' +
			'OK seit: {{m.state-recovered-at.val|datetime}}\n' +
			'Diese Meldung kann geschlossen werden.';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'triggered_deltaDown_resetOnNormal_true';
		preset.description = 'deltaDown (auto reset)';
		preset.ownedBy = 'Triggered';
		preset.subset = 'deltaDown';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'Reaktion ausgeblieben';
		preset.message.text =
			'Trigger ist aktiv, aber der Wert hat sich nicht ausreichend verringert.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Trigger-Wert: {{m.trigger-value}}.\n' +
			'Start: {{t.startedAt.val|datetime}}';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'triggered_deltaDown_resetOnNormal_false';
		preset.description = 'deltaDown (manual close)';
		preset.ownedBy = 'Triggered';
		preset.subset = 'deltaDown';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'Reaktion ausgeblieben';
		preset.message.text =
			'Trigger ist aktiv, aber der Wert hat sich nicht ausreichend verringert.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Trigger-Wert: {{m.trigger-value}}.\n' +
			'Start: {{t.startedAt.val|datetime}}';
		preset.message.textRecovered =
			'Trigger war/ist aktiv, aber der Wert hatte sich nicht ausreichend verringert.\n' +
			'Start: {{t.startedAt.val|datetime}}\n' +
			'OK seit: {{m.state-recovered-at.val|datetime}}\n' +
			'Diese Meldung kann geschlossen werden.';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'triggered_thresholdGte_resetOnNormal_true';
		preset.description = 'thresholdGte (auto reset)';
		preset.ownedBy = 'Triggered';
		preset.subset = 'thresholdGte';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'Reaktion ausgeblieben';
		preset.message.text =
			'Trigger ist aktiv, aber der Wert hat den Schwellwert nicht erreicht.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Trigger-Wert: {{m.trigger-value}}.\n' +
			'Start: {{t.startedAt.val|datetime}}';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'triggered_thresholdGte_resetOnNormal_false';
		preset.description = 'thresholdGte (manual close)';
		preset.ownedBy = 'Triggered';
		preset.subset = 'thresholdGte';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'Reaktion ausgeblieben';
		preset.message.text =
			'Trigger ist aktiv, aber der Wert hat den Schwellwert nicht erreicht.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Trigger-Wert: {{m.trigger-value}}.\n' +
			'Start: {{t.startedAt.val|datetime}}';
		preset.message.textRecovered =
			'Trigger war/ist aktiv, aber der Wert hat den Schwellwert nicht erreicht.\n' +
			'Start: {{t.startedAt.val|datetime}}\n' +
			'OK seit: {{m.state-recovered-at.val|datetime}}\n' +
			'Diese Meldung kann geschlossen werden.';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'triggered_thresholdLte_resetOnNormal_true';
		preset.description = 'thresholdLte (auto reset)';
		preset.ownedBy = 'Triggered';
		preset.subset = 'thresholdLte';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'Reaktion ausgeblieben';
		preset.message.text =
			'Trigger ist aktiv, aber der Wert hat den Schwellwert nicht unterschritten.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Trigger-Wert: {{m.trigger-value}}.\n' +
			'Start: {{t.startedAt.val|datetime}}';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'triggered_thresholdLte_resetOnNormal_false';
		preset.description = 'thresholdLte (manual close)';
		preset.ownedBy = 'Triggered';
		preset.subset = 'thresholdLte';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = 'Reaktion ausgeblieben';
		preset.message.text =
			'Trigger ist aktiv, aber der Wert hat den Schwellwert nicht unterschritten.\n' +
			'Aktueller Wert: {{m.state-value}}.\n' +
			'Trigger-Wert: {{m.trigger-value}}.\n' +
			'Start: {{t.startedAt.val|datetime}}';
		preset.message.textRecovered =
			'Trigger war/ist aktiv, aber der Wert hat den Schwellwert nicht unterschritten.\n' +
			'Start: {{t.startedAt.val|datetime}}\n' +
			'OK seit: {{m.state-recovered-at.val|datetime}}\n' +
			'Diese Meldung kann geschlossen werden.';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	return presets;
}

module.exports = { getTriggeredPresets };
