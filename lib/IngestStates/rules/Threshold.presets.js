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
		preset.message.title = "'{{m.state-name.val}}' Schwellwert unterschritten";
		preset.message.text =
			'Aktueller Wert {{m.state-value}} ist zu klein.\n' +
			'Wenn der Wert über {{m.state-max}} steigt, wird diese Meldung automatisch gelöscht.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = "'{{m.state-name.val}}' Schwellwert unterschritten";
		preset.message.text =
			'Aktueller Wert {{m.state-value}} ist zu klein.\n' +
			'Wenn der Wert über {{m.state-max}} steigt, kann diese Meldung geschlossen werden.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = "'{{m.state-name.val}}' Schwellwert überschritten";
		preset.message.text =
			'Aktueller Wert {{m.state-value}} ist zu groß.\n' +
			'Wenn der Wert unter {{m.state-min}} fällt, wird diese Meldung automatisch gelöscht.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = "'{{m.state-name.val}}' Schwellwert überschritten";
		preset.message.text =
			'Aktueller Wert {{m.state-value}} ist zu groß.\n' +
			'Wenn der Wert unter {{m.state-min}} fällt, kann diese Meldung geschlossen werden.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = "'{{m.state-name.val}}' Wert im kritischen Bereich";
		preset.message.text =
			'Aktueller Wert {{m.state-value}} liegt innerhalb des unerwünschten Bereichs.\n' +
			'Wenn der Wert wieder außerhlab von {{m.state-min}} bis {{m.state-max}} liegt, wird diese Meldung automatisch gelöscht.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = "'{{m.state-name.val}}' Wert im kritischen Bereich";
		preset.message.text =
			'Aktueller Wert {{m.state-value}} liegt innerhalb des unerwünschten Bereichs.\n' +
			'Wenn der Wert wieder außerhlab von {{m.state-min}} bis {{m.state-max}} liegt, kann diese Meldung geschlossen werden.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = "'{{m.state-name.val}}' Wert außerhalb des Sollbereichs";
		preset.message.text =
			'Aktueller Wert {{m.state-value}} liegt außerhalb des Sollbereichs.\n' +
			'Wenn der Wert wieder innerhalb von {{m.state-min}} bis {{m.state-max}} liegt, wird diese Meldung automatisch gelöscht.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = "'{{m.state-name.val}}' Wert außerhalb des Sollbereichs";
		preset.message.text =
			'Aktueller Wert {{m.state-value}} liegt außerhalb des Sollbereichs.\n' +
			'Wenn der Wert wieder innerhalb von {{m.state-min}} bis {{m.state-max}} liegt, kann diese Meldung geschlossen werden.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = "'{{m.state-name.val}}' Ein-Zustand erkannt";
		preset.message.text =
			'Aktueller Wert ist {{m.state-val|bool:EIN/AUS}}.\n' +
			'Wenn der Sollzustand (AUS) wieder eintritt, wird diese Meldung automatisch gelöscht.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = "'{{m.state-name.val}}' Wahr-Zustand erkannt";
		preset.message.text =
			'Aktueller Wert ist {{m.state-val|bool:EIN/AUS}}.\n' +
			'Wenn der Sollzustand (AUS) wieder eintritt, kann diese Meldung geschlossen werden.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = "'{{m.state-name.val}}' Falsch/Leer-Zustand erkannt";
		preset.message.text =
			'Aktueller Wert ist {{m.state-val|bool:EIN/AUS}}.\n' +
			'Wenn der Sollzustand (EIN) wieder eintritt, wird diese Meldung automatisch gelöscht.\n' +
			'Start: {{t.startedAt|datetime}}';
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
		preset.message.title = "'{{m.state-name.val}}' Falsch/Leer-Zustand erkannt";
		preset.message.text =
			'Aktueller Wert ist {{m.state-val|bool:EIN/AUS}}.\n' +
			'Wenn der Sollzustand (EIN) wieder eintritt, kann diese Meldung geschlossen werden.\n' +
			'Start: {{t.startedAt|datetime}}';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	return presets;
}

module.exports = { getThresholdPresets };
