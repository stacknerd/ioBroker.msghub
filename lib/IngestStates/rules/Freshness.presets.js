'use strict';

/**
 * Default presets for Freshness rule.
 *
 * @param {object} options Inputs.
 * @param {Function} options.cloneTemplate Deep-clone helper for presetTemplateV1.
 * @param {string} options.kindStatus Message kind for status presets.
 * @param {number} options.levelNotice Message level for notice presets.
 * @returns {Array<object>} Preset list.
 */
function getFreshnessPresets({ cloneTemplate, kindStatus, levelNotice }) {
	const presets = [];

	// lc:
	{
		const preset = cloneTemplate();
		preset.presetId = 'freshness_lc_resetOnNormal_true';
		preset.description = 'lc (auto reset)';
		preset.ownedBy = 'Freshness';
		preset.subset = 'lc';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = "'{{m.state-name.val}}' unverändert.";
		preset.message.text =
			'{{m.state-name.val}} hat sich seit {{m.state-lc|durationSince}} nicht mehr verändert.\n' +
			'Der letzte erhaltene Wert am {{m.state-lc.val|datetime}} war {{m.state-value}}.';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'freshness_lc_resetOnNormal_false';
		preset.description = 'lc (manual close)';
		preset.ownedBy = 'Freshness';
		preset.subset = 'lc';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = "'{{m.state-name.val}}' unverändert.";
		preset.message.text =
			'{{m.state-name.val}} hat sich seit {{m.state-lc|durationSince}} nicht mehr verändert.\n' +
			'Der letzte erhaltene Wert am {{m.state-lc.val|datetime}} war {{m.state-value}}.';
		preset.message.textRecovered =
			'{{m.state-name.val}} hatte sich ab {{m.state-lc.val|datetime}} zunächst nicht mehr verändert.\n' +
			'Dieser Zustand wurde durch eine Änderung am {{m.state-recovered-at.val|datetime}} behoben.\n' +
			'Diese Nachricht kann jetzt geschlossen werden.';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	// ts:
	{
		const preset = cloneTemplate();
		preset.presetId = 'freshness_ts_resetOnNormal_true';
		preset.description = 'ts (auto reset)';
		preset.ownedBy = 'Freshness';
		preset.subset = 'ts';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = "'{{m.state-name.val}}' ohne update.";
		preset.message.text =
			'{{m.state-name.val}} wurde seit {{m.state-ts|durationSince}} nicht mehr aktualisiert.\n' +
			'Der letzte erhaltene Wert am {{m.state-ts.val|datetime}} war {{m.state-value}}.';
		preset.policy.resetOnNormal = true;
		presets.push(preset);
	}
	{
		const preset = cloneTemplate();
		preset.presetId = 'freshness_ts_resetOnNormal_false';
		preset.description = 'ts (manual close)';
		preset.ownedBy = 'Freshness';
		preset.subset = 'ts';
		preset.message.kind = kindStatus;
		preset.message.level = levelNotice;
		preset.message.title = "'{{m.state-name.val}}' ohne update.";
		preset.message.text =
			'{{m.state-name.val}} wurde seit {{m.state-ts|durationSince}} nicht mehr aktualisiert.\n' +
			'Der letzte erhaltene Wert am {{m.state-ts.val|datetime}} war {{m.state-value}}.';
		preset.message.textRecovered =
			'{{m.state-name.val}} wurde nach {{m.state-ts.val|datetime}} zunächst nicht mehr aktualisiert.\n' +
			'Dieser Zustand wurde durch eine Aktualisierung am {{m.state-recovered-at.val|datetime}} wieder behoben.\n' +
			'Diese Nachricht kann jetzt geschlossen werden.';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	return presets;
}

module.exports = { getFreshnessPresets };
