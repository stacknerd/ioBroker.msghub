/**
 * IngestHue model catalog.
 * ========================
 * Hue model metadata used to enrich battery replacement tasks with device
 * labels, consumables, tools, and estimated completion time.
 *
 * Docs: ../../docs/plugins/IngestHue.md
 */

'use strict';

const MODEL_LABEL = Object.freeze({
	wallSwitchModule: 'msghub.i18n.IngestHue.model.wallSwitchModule.label',
	tapDialSwitch: 'msghub.i18n.IngestHue.model.tapDialSwitch.label',
	smartButton: 'msghub.i18n.IngestHue.model.smartButton.label',
	dimmerSwitch: 'msghub.i18n.IngestHue.model.dimmerSwitch.label',
	outdoorMotionSensor: 'msghub.i18n.IngestHue.model.outdoorMotionSensor.label',
	motionSensor: 'msghub.i18n.IngestHue.model.motionSensor.label',
	secureContactSensor: 'msghub.i18n.IngestHue.model.secureContactSensor.label',
});

const BATTERY = Object.freeze({
	cr2032: 'msghub.i18n.core.common.consumables.battery.cr2032.label',
	cr2450: 'msghub.i18n.core.common.consumables.battery.cr2450.label',
	cr2: 'msghub.i18n.core.common.consumables.battery.cr2.label',
	aa: 'msghub.i18n.core.common.consumables.battery.aa.label',
	aaa: 'msghub.i18n.core.common.consumables.battery.aaa.label',
});

const TOOL = Object.freeze({
	unknown: 'msghub.i18n.core.common.tools.unknown.label',
	ph1Phillips: 'msghub.i18n.core.common.tools.screwdriver.ph1.label',
	ph2Phillips: 'msghub.i18n.core.common.tools.screwdriver.ph2.label',
	slotted35mm: 'msghub.i18n.core.common.tools.screwdriver.slotted35mm.label',
	ladder: 'msghub.i18n.core.common.tools.ladder.label',
});

/**
 * Create an immutable model metadata entry.
 *
 * @param {object} info Model metadata.
 * @param {string} info.labelKey Translation key for the device label.
 * @param {string|string[]} [info.consumableKeys] Translation key(s) for consumables.
 * @param {string|string[]} [info.toolKeys] Translation key(s) for required tools.
 * @param {number} [info.estimatedTimeMs] Estimated task time in milliseconds.
 * @returns {object} Frozen model metadata.
 */
function model(info) {
	const consumableKeys = Array.isArray(info.consumableKeys)
		? info.consumableKeys
		: typeof info.consumableKeys === 'string' && info.consumableKeys
			? [info.consumableKeys]
			: [];
	const toolKeys = Array.isArray(info.toolKeys)
		? info.toolKeys
		: typeof info.toolKeys === 'string' && info.toolKeys
			? [info.toolKeys]
			: [];

	const result = {
		labelKey: info.labelKey,
		consumableKeys: Object.freeze(consumableKeys.slice()),
		toolKeys: Object.freeze(toolKeys.slice()),
	};
	if (typeof info.estimatedTimeMs === 'number' && Number.isFinite(info.estimatedTimeMs)) {
		result.estimatedTimeMs = Math.max(0, Math.trunc(info.estimatedTimeMs));
	}
	return Object.freeze(result);
}

const HUE_MODELS = Object.freeze({
	RDM001: model({
		labelKey: MODEL_LABEL.wallSwitchModule,
		consumableKeys: BATTERY.cr2032,
		toolKeys: TOOL.ph2Phillips,
		estimatedTimeMs: 15 * 60 * 1000,
	}),
	RDM002: model({
		labelKey: MODEL_LABEL.tapDialSwitch,
		consumableKeys: BATTERY.cr2032,
		toolKeys: TOOL.unknown,
		estimatedTimeMs: 10 * 60 * 1000,
	}),
	RDM003: model({
		labelKey: MODEL_LABEL.smartButton,
		consumableKeys: BATTERY.cr2032,
		toolKeys: TOOL.unknown,
		estimatedTimeMs: 10 * 60 * 1000,
	}),
	RDM004: model({
		labelKey: MODEL_LABEL.wallSwitchModule,
		consumableKeys: BATTERY.cr2032,
		toolKeys: [TOOL.ph2Phillips, TOOL.slotted35mm],
		estimatedTimeMs: 15 * 60 * 1000,
	}),
	RDM005: model({
		labelKey: MODEL_LABEL.smartButton,
		consumableKeys: BATTERY.cr2032,
		toolKeys: TOOL.unknown,
		estimatedTimeMs: 10 * 60 * 1000,
	}),
	RDM006: model({
		labelKey: MODEL_LABEL.tapDialSwitch,
		consumableKeys: BATTERY.cr2032,
		toolKeys: TOOL.unknown,
		estimatedTimeMs: 10 * 60 * 1000,
	}),
	ROM001: model({
		labelKey: MODEL_LABEL.smartButton,
		consumableKeys: BATTERY.cr2032,
		toolKeys: TOOL.unknown,
		estimatedTimeMs: 10 * 60 * 1000,
	}),
	RWL020: model({
		labelKey: MODEL_LABEL.dimmerSwitch,
		consumableKeys: BATTERY.cr2450,
		toolKeys: TOOL.ph1Phillips,
		estimatedTimeMs: 10 * 60 * 1000,
	}),
	RWL021: model({
		labelKey: MODEL_LABEL.dimmerSwitch,
		consumableKeys: BATTERY.cr2450,
		toolKeys: TOOL.ph1Phillips,
		estimatedTimeMs: 10 * 60 * 1000,
	}),
	RWL022: model({
		labelKey: MODEL_LABEL.dimmerSwitch,
		consumableKeys: BATTERY.cr2032,
		estimatedTimeMs: 10 * 60 * 1000,
	}),
	SML001: model({
		labelKey: MODEL_LABEL.motionSensor,
		consumableKeys: [BATTERY.aaa, BATTERY.aaa],
		toolKeys: TOOL.ph2Phillips,
		estimatedTimeMs: 10 * 60 * 1000,
	}),
	SML002: model({
		labelKey: MODEL_LABEL.outdoorMotionSensor,
		consumableKeys: [BATTERY.aa, BATTERY.aa],
		toolKeys: [TOOL.ph1Phillips, TOOL.slotted35mm, TOOL.ladder],
		estimatedTimeMs: 20 * 60 * 1000,
	}),
	SML003: model({
		labelKey: MODEL_LABEL.motionSensor,
		consumableKeys: [BATTERY.aaa, BATTERY.aaa],
		toolKeys: TOOL.unknown,
		estimatedTimeMs: 10 * 60 * 1000,
	}),
	SML004: model({
		labelKey: MODEL_LABEL.outdoorMotionSensor,
		consumableKeys: [BATTERY.aa, BATTERY.aa],
		toolKeys: [TOOL.ph1Phillips, TOOL.slotted35mm, TOOL.ladder],
		estimatedTimeMs: 20 * 60 * 1000,
	}),
	SOC001: model({
		labelKey: MODEL_LABEL.secureContactSensor,
		consumableKeys: BATTERY.cr2,
		toolKeys: TOOL.unknown,
		estimatedTimeMs: 10 * 60 * 1000,
	}),
});

module.exports = { HUE_MODELS, MODEL_LABEL, BATTERY, TOOL };
