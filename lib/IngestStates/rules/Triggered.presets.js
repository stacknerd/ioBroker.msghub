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
		preset.message.title = 'msghub.i18n.IngestStates.msg.triggered.changed.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.triggered.changed.text';
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
		preset.message.title = 'msghub.i18n.IngestStates.msg.triggered.changed.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.triggered.changed.text';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.triggered.changed.textRecovered';
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
		preset.message.title = 'msghub.i18n.IngestStates.msg.triggered.deltaUp.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.triggered.deltaUp.text';
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
		preset.message.title = 'msghub.i18n.IngestStates.msg.triggered.deltaUp.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.triggered.deltaUp.text';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.triggered.deltaUp.textRecovered';
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
		preset.message.title = 'msghub.i18n.IngestStates.msg.triggered.deltaDown.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.triggered.deltaDown.text';
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
		preset.message.title = 'msghub.i18n.IngestStates.msg.triggered.deltaDown.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.triggered.deltaDown.text';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.triggered.deltaDown.textRecovered';
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
		preset.message.title = 'msghub.i18n.IngestStates.msg.triggered.thresholdGte.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.triggered.thresholdGte.text';
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
		preset.message.title = 'msghub.i18n.IngestStates.msg.triggered.thresholdGte.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.triggered.thresholdGte.text';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.triggered.thresholdGte.textRecovered';
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
		preset.message.title = 'msghub.i18n.IngestStates.msg.triggered.thresholdLte.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.triggered.thresholdLte.text';
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
		preset.message.title = 'msghub.i18n.IngestStates.msg.triggered.thresholdLte.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.triggered.thresholdLte.text';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.triggered.thresholdLte.textRecovered';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	return presets;
}

module.exports = { getTriggeredPresets };
