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
		preset.message.title = 'msghub.i18n.IngestStates.msg.freshness.lc.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.freshness.lc.text';
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
		preset.message.title = 'msghub.i18n.IngestStates.msg.freshness.lc.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.freshness.lc.text';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.freshness.lc.textRecovered';
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
		preset.message.title = 'msghub.i18n.IngestStates.msg.freshness.ts.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.freshness.ts.text';
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
		preset.message.title = 'msghub.i18n.IngestStates.msg.freshness.ts.title';
		preset.message.text = 'msghub.i18n.IngestStates.msg.freshness.ts.text';
		preset.message.textRecovered = 'msghub.i18n.IngestStates.msg.freshness.ts.textRecovered';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	return presets;
}

module.exports = { getFreshnessPresets };
