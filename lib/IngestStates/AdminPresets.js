/**
 * AdminPresets
 * ============
 *
 * Plugin-owned preset normalization and validation for IngestStates.
 *
 * Why this exists
 * ---------------
 * Admin-side preset CRUD should not teach `IoAdminTab` the canonical shape of
 * IngestStates presets. The frontend may build drafts from the published
 * constants, but persisted presets still need one authoritative backend pass for:
 * - canonical default filling from `presetTemplateV1`
 * - validation of the minimal persisted preset contract
 * - stable parsing of stored preset JSON
 * - shaping lightweight summary DTOs for admin list views
 *
 * Design goals
 * ------------
 * - Keep preset domain knowledge inside `lib/IngestStates/`.
 * - Keep this module pure: no ioBroker access, no runtime bridge, no I/O.
 * - Let `IoAdminTab` remain an orchestrator/passthrough around persistence.
 *
 * Notes
 * -----
 * This module intentionally does not own preset id generation or storage. It
 * operates on payload shape only and leaves persistence orchestration to
 * `IoAdminTab`.
 */
'use strict';

const { isObject } = require('../../src/MsgUtils');
const { presetSchema, presetTemplateV1 } = require('./constants');

const PRESET_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Deep-clone JSON-safe data.
 *
 * @param {any} value Input.
 * @returns {any} Cloned value.
 */
function cloneJson(value) {
	return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * Clone the canonical preset template for new drafts.
 *
 * @returns {object} Fresh preset template clone.
 */
function clonePresetTemplate() {
	return cloneJson(presetTemplateV1);
}

function normalizeText(value, fallback = '') {
	return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

function normalizeNullableText(value) {
	const text = normalizeText(value).trim();
	return text || null;
}

function normalizeStringArray(value) {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map(entry => normalizeText(entry).trim()).filter(Boolean);
}

function normalizeNumber(value, fallback = 0) {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeBoolean(value, fallback = false) {
	return typeof value === 'boolean' ? value : fallback;
}

/**
 * Validate the persisted preset id token.
 *
 * @param {any} presetId Candidate preset id.
 * @returns {boolean} True when the token is valid.
 */
function isValidPresetId(presetId) {
	const id = typeof presetId === 'string' ? presetId.trim() : '';
	return !!id && PRESET_ID_RE.test(id);
}

function translatedName(value) {
	if (typeof value === 'string') {
		return value.trim();
	}
	if (!value || typeof value !== 'object') {
		return '';
	}
	const preferred = value.en || value.de;
	return typeof preferred === 'string' ? preferred.trim() : '';
}

function capitalizeFirstChar(value) {
	const text = normalizeText(value).trim();
	if (!text) {
		return '';
	}
	return text.length === 1 ? text.toUpperCase() : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * Extract a human-friendly preset name from object metadata or preset description.
 *
 * @param {{ presetId?: string, obj?: any, preset?: any }} info Name inputs.
 * @returns {string} Readable preset name.
 */
function extractPresetName({ presetId, obj, preset }) {
	const objectName = translatedName(obj?.common?.name);
	if (objectName) {
		return capitalizeFirstChar(objectName);
	}
	const description = typeof preset?.description === 'string' ? preset.description.trim() : '';
	return capitalizeFirstChar(description) || String(presetId || '').trim();
}

/**
 * Normalize a preset payload into the canonical persisted shape.
 *
 * @param {any} candidate Raw preset payload.
 * @param {{ presetId?: string, source?: 'user'|'builtin' }} [options] Normalization overrides.
 * @returns {object} Normalized preset object.
 */
function normalizePreset(candidate, { presetId = '', source } = {}) {
	const preset = isObject(candidate) ? cloneJson(candidate) : {};
	const next = clonePresetTemplate();

	Object.assign(next, preset);
	next.schema = presetSchema;
	next.presetId =
		typeof presetId === 'string' && presetId.trim() ? presetId.trim() : normalizeText(preset.presetId).trim();
	next.description = normalizeText(preset.description);
	next.source = source === 'builtin' || source === 'user' ? source : preset.source === 'builtin' ? 'builtin' : 'user';
	next.ownedBy = normalizeNullableText(preset.ownedBy);
	next.subset = normalizeNullableText(preset.subset);

	const message = isObject(preset.message) ? preset.message : {};
	next.message = {
		...next.message,
		...message,
		kind: normalizeText(message.kind, presetTemplateV1.message.kind).trim() || presetTemplateV1.message.kind,
		level: normalizeNumber(message.level, presetTemplateV1.message.level),
		icon: normalizeText(message.icon),
		title: normalizeText(message.title),
		text: normalizeText(message.text),
		textRecovered: normalizeText(message.textRecovered),
		timing: {
			...presetTemplateV1.message.timing,
			...(isObject(message.timing) ? message.timing : {}),
			timeBudget: normalizeNumber(message?.timing?.timeBudget, presetTemplateV1.message.timing.timeBudget),
			dueInMs: normalizeNumber(message?.timing?.dueInMs, presetTemplateV1.message.timing.dueInMs),
			expiresInMs: normalizeNumber(message?.timing?.expiresInMs, presetTemplateV1.message.timing.expiresInMs),
			cooldown: normalizeNumber(message?.timing?.cooldown, presetTemplateV1.message.timing.cooldown),
			remindEvery: normalizeNumber(message?.timing?.remindEvery, presetTemplateV1.message.timing.remindEvery),
		},
		details: {
			...presetTemplateV1.message.details,
			...(isObject(message.details) ? message.details : {}),
			task: normalizeText(message?.details?.task),
			reason: normalizeText(message?.details?.reason),
			tools: normalizeStringArray(message?.details?.tools),
			consumables: normalizeStringArray(message?.details?.consumables),
		},
		audience: {
			...presetTemplateV1.message.audience,
			...(isObject(message.audience) ? message.audience : {}),
			tags: normalizeStringArray(message?.audience?.tags),
			channels: {
				...presetTemplateV1.message.audience.channels,
				...(isObject(message?.audience?.channels) ? message.audience.channels : {}),
				include: normalizeStringArray(message?.audience?.channels?.include),
				exclude: normalizeStringArray(message?.audience?.channels?.exclude),
			},
		},
		actions: Array.isArray(message.actions) ? cloneJson(message.actions) : [],
	};

	const policy = isObject(preset.policy) ? preset.policy : {};
	next.policy = {
		...presetTemplateV1.policy,
		...policy,
		resetOnNormal: normalizeBoolean(policy.resetOnNormal, presetTemplateV1.policy.resetOnNormal),
	};

	// UI-only helper state must never leak into persisted preset payloads.
	if (Object.prototype.hasOwnProperty.call(next, 'ui')) {
		delete next.ui;
	}

	return next;
}

/**
 * Validate the minimal persisted preset shape.
 *
 * @param {any} preset Candidate preset.
 * @param {{ expectedPresetId?: string }} [options] Validation options.
 * @returns {string|null} Error message or null.
 */
function validatePreset(preset, { expectedPresetId = '' } = {}) {
	if (!isObject(preset)) {
		return 'Missing preset object';
	}
	const schema = typeof preset.schema === 'string' ? preset.schema.trim() : '';
	if (schema !== presetSchema) {
		return `Invalid schema (expected '${presetSchema}')`;
	}
	const presetId = typeof preset.presetId === 'string' ? preset.presetId.trim() : '';
	if (!isValidPresetId(presetId)) {
		return 'Invalid presetId';
	}
	if (expectedPresetId && presetId !== expectedPresetId) {
		return `presetId mismatch (expected '${expectedPresetId}')`;
	}
	const source = typeof preset.source === 'string' ? preset.source.trim() : '';
	if (source !== 'user' && source !== 'builtin') {
		return "Invalid source (expected 'user' or 'builtin')";
	}

	const msg = preset.message;
	if (!isObject(msg)) {
		return 'Missing message object';
	}
	const kind = typeof msg.kind === 'string' ? msg.kind.trim() : '';
	if (!kind) {
		return 'Missing message.kind';
	}
	if (typeof msg.level !== 'number' || !Number.isFinite(msg.level)) {
		return 'Missing/invalid message.level';
	}
	const title = typeof msg.title === 'string' ? msg.title.trim() : '';
	if (!title) {
		return 'Missing message.title';
	}
	const text = typeof msg.text === 'string' ? msg.text.trim() : '';
	if (!text) {
		return 'Missing message.text';
	}
	if (preset.policy !== undefined && preset.policy !== null && !isObject(preset.policy)) {
		return 'Invalid policy object';
	}
	return null;
}

/**
 * Parse and validate a stored preset JSON string.
 *
 * @param {any} raw State value.
 * @param {{ presetId?: string }} [options] Expected preset id.
 * @returns {{ preset: object|null, error: string|null }} Parsed preset or error.
 */
function parsePresetState(raw, { presetId = '' } = {}) {
	const text = typeof raw === 'string' ? raw.trim() : '';
	if (!text) {
		return { preset: null, error: 'missing JSON value' };
	}
	let parsed = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { preset: null, error: 'invalid JSON' };
	}
	const preset = normalizePreset(parsed, { presetId });
	const error = validatePreset(preset, { expectedPresetId: presetId });
	if (error) {
		return { preset: null, error };
	}
	return { preset, error: null };
}

/**
 * Build a list-row DTO for the admin preset list.
 *
 * @param {{ presetId?: string, obj?: any, preset?: any, usageCount?: number }} [info] Summary inputs.
 * @returns {{ value: string, source: string, ownedBy: string|null, subset: string|null, kind: string|null, level: number|null, name: string, usageCount?: number }}
 *   Preset summary row.
 */
function toPresetSummary({ presetId, obj, preset, usageCount } = {}) {
	return {
		value: String(presetId || '').trim(),
		source: typeof preset?.source === 'string' ? preset.source.trim() : 'user',
		ownedBy: typeof preset?.ownedBy === 'string' && preset.ownedBy.trim() ? preset.ownedBy.trim() : null,
		subset: typeof preset?.subset === 'string' && preset.subset.trim() ? preset.subset.trim() : null,
		kind:
			typeof preset?.message?.kind === 'string' && preset.message.kind.trim() ? preset.message.kind.trim() : null,
		level:
			typeof preset?.message?.level === 'number' && Number.isFinite(preset.message.level)
				? preset.message.level
				: null,
		name: extractPresetName({ presetId, obj, preset }),
		...(usageCount === undefined
			? {}
			: {
					usageCount:
						typeof usageCount === 'number' && Number.isFinite(usageCount)
							? Math.max(0, Math.trunc(usageCount))
							: 0,
				}),
	};
}

module.exports = {
	clonePresetTemplate,
	extractPresetName,
	isValidPresetId,
	normalizePreset,
	parsePresetState,
	toPresetSummary,
	validatePreset,
};
