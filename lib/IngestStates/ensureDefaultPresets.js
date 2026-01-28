'use strict';

const { presetTemplateV1 } = require('./constants');
const { getCyclePresets } = require('./rules/Cycle.presets');
const { getFreshnessPresets } = require('./rules/Freshness.presets');
const { getNonSettlingPresets } = require('./rules/NonSettling.presets');
const { getSessionPresets } = require('./rules/Session.presets');
const { getThresholdPresets } = require('./rules/Threshold.presets');
const { getTriggeredPresets } = require('./rules/Triggered.presets');

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

	const constants = ctx?.api?.constants || {};
	const kinds = constants.kind || {};
	const levels = constants.level || {};
	const kindStatus = typeof kinds.status === 'string' ? kinds.status : 'status';
	const kindTask = typeof kinds.task === 'string' ? kinds.task : 'task';
	const levelNotice = typeof levels.notice === 'number' && Number.isFinite(levels.notice) ? levels.notice : 20;

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
	presets.push(...getFreshnessPresets({ cloneTemplate, kindStatus, levelNotice }));
	presets.push(...getThresholdPresets({ cloneTemplate, kindStatus, levelNotice }));
	presets.push(...getCyclePresets({ cloneTemplate, kindTask, levelNotice }));
	presets.push(...getTriggeredPresets({ cloneTemplate, kindStatus, levelNotice }));
	presets.push(...getNonSettlingPresets({ cloneTemplate, kindStatus, levelNotice }));
	presets.push(...getSessionPresets({ cloneTemplate, kindStatus, kindTask, levelNotice }));

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
