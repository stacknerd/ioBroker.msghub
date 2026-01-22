'use strict';

const { presetTemplateV1 } = require('./constants');

/**
 * Ensure the built-in default presets exist for this plugin instance.
 *
 * This is provisioning-only:
 * - creates missing preset state objects
 * - writes/overwrites preset JSON values (ack)
 *
 * @param {object} ctx Plugin runtime context (`ctx.api.*`, `ctx.meta.plugin.*`).
 * @returns {Promise<void>} Resolves when presets have been written (best-effort).
 */
async function ensureDefaultPresets(ctx) {
	const log = ctx?.api?.log;
	const setObjectNotExists = ctx?.api?.iobroker?.objects?.setObjectNotExists;
	const setForeignState = ctx?.api?.iobroker?.states?.setForeignState;

	if (typeof setObjectNotExists !== 'function' || typeof setForeignState !== 'function') {
		return;
	}

	const baseOwnId = typeof ctx?.meta?.plugin?.baseOwnId === 'string' ? ctx.meta.plugin.baseOwnId.trim() : '';
	const baseFullId = typeof ctx?.meta?.plugin?.baseFullId === 'string' ? ctx.meta.plugin.baseFullId.trim() : '';
	if (!baseOwnId || !baseFullId) {
		return;
	}

	async function setStateAck(id, value) {
		try {
			if (setForeignState.length >= 3) {
				await setForeignState(id, value, true);
			} else {
				await setForeignState(id, { val: value, ack: true });
			}
		} catch (e) {
			log?.warn?.(`IngestStates: failed to write preset state '${id}': ${String(e?.message || e)}`);
		}
	}

	function cloneTemplate() {
		return JSON.parse(JSON.stringify(presetTemplateV1));
	}

	const presets = [];

	// Threshold default presets (threshold modes) — direct texts (no i18n keys)

	// lt: violation when value < threshold
	{
		const preset = cloneTemplate();
		preset.presetId = 'threshold_lt_resetOnNormal_true';
		preset.description = 'lt (auto reset)';
		preset.ownedBy = 'Threshold';
		preset.subset = 'lt';
		preset.message.kind = 'status';
		preset.message.level = 20;
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
		preset.message.kind = 'status';
		preset.message.level = 20;
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
		preset.message.kind = 'status';
		preset.message.level = 20;
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
		preset.message.kind = 'status';
		preset.message.level = 20;
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
		preset.message.kind = 'status';
		preset.message.level = 20;
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
		preset.message.kind = 'status';
		preset.message.level = 20;
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
		preset.message.kind = 'status';
		preset.message.level = 20;
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
		preset.message.kind = 'status';
		preset.message.level = 20;
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
		preset.message.kind = 'status';
		preset.message.level = 20;
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
		preset.message.kind = 'status';
		preset.message.level = 20;
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
		preset.message.kind = 'status';
		preset.message.level = 20;
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
		preset.message.kind = 'status';
		preset.message.level = 20;
		preset.message.title = "'{{m.state-name.val}}' Falsch/Leer-Zustand erkannt";
		preset.message.text =
			'Aktueller Wert ist {{m.state-val|bool:EIN/AUS}}.\n' +
			'Wenn der Sollzustand (EIN) wieder eintritt, kann diese Meldung geschlossen werden.\n' +
			'Start: {{t.startedAt|datetime}}';
		preset.policy.resetOnNormal = false;
		presets.push(preset);
	}

	for (const preset of presets) {
		const presetId = typeof preset?.presetId === 'string' ? preset.presetId.trim() : '';
		if (!presetId) {
			continue;
		}

		const ownId = `${baseOwnId}.presets.${presetId}`;
		const fullId = `${baseFullId}.presets.${presetId}`;
		const name =
			typeof preset.description === 'string' && preset.description.trim() ? preset.description.trim() : presetId;

		try {
			await setObjectNotExists(ownId, {
				type: 'state',
				common: {
					name,
					type: 'string',
					role: 'json',
					read: true,
					write: false,
				},
				native: {},
			});
		} catch (e) {
			log?.warn?.(`IngestStates: failed to ensure preset object '${ownId}': ${String(e?.message || e)}`);
		}

		await setStateAck(fullId, JSON.stringify(preset));
	}
}

module.exports = { ensureDefaultPresets };
