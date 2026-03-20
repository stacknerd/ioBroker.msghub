/**
 * presets-service.js
 * ==================
 *
 * Complete preset admin service for the IngestStates admin UI.
 *
 * createPresetsService(ctx, engine) is the single export.
 * All domain logic (id validation, normalization, validation, parsing,
 * summary building) and all I/O (ioBroker objects/states via plugin ctx)
 * are encapsulated within the factory. Nothing is exposed at module level.
 */

'use strict';

const { presetSchema, presetTemplateV1 } = require('../constants');

/**
 * Create the complete presets admin service.
 *
 * @param {object} ctx Plugin context injected by IoPlugins at plugin start.
 * @param {object|null} engine IngestStatesEngine instance (used for usage snapshot).
 * @returns {object} Presets service: { list, get, create, update, delete }.
 */
function createPresetsService(ctx, engine) {
	// ── I/O handles ───────────────────────────────────────────────────────────

	const ioObjects = ctx.api.iobroker.objects;
	const ioStates = ctx.api.iobroker.states;
	const ids = ctx.api.iobroker.ids;
	const baseFullId = ctx.meta.plugin.baseFullId;
	const presetsRootFullId = `${baseFullId}.presets`;
	const presetsRootOwnId = ids.toOwnId(presetsRootFullId);
	const presetsPrefix = `${presetsRootFullId}.`;

	// ── Generic value helpers ─────────────────────────────────────────────────

	function cloneJson(value) {
		return JSON.parse(JSON.stringify(value ?? null));
	}

	function isPlainObject(value) {
		return value !== null && typeof value === 'object' && !Array.isArray(value);
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

	// ── Preset domain logic ───────────────────────────────────────────────────

	const PRESET_ID_RE = /^[A-Za-z0-9_-]+$/;

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

	function extractPresetName({ presetId, obj, preset }) {
		const objectName = translatedName(obj?.common?.name);
		if (objectName) {
			return capitalizeFirstChar(objectName);
		}
		const description = typeof preset?.description === 'string' ? preset.description.trim() : '';
		return capitalizeFirstChar(description) || String(presetId || '').trim();
	}

	/**
	 * @param {any} candidate Raw preset payload.
	 * @param {{ presetId?: string, source?: string }} [options] Normalization overrides.
	 * @returns {object} Normalized preset object.
	 */
	function normalizePreset(candidate, { presetId = '', source } = {}) {
		const preset = isPlainObject(candidate) ? cloneJson(candidate) : {};
		const next = cloneJson(presetTemplateV1);

		Object.assign(next, preset);
		next.schema = presetSchema;
		next.presetId =
			typeof presetId === 'string' && presetId.trim() ? presetId.trim() : normalizeText(preset.presetId).trim();
		next.description = normalizeText(preset.description);
		next.source =
			source === 'builtin' || source === 'user' ? source : preset.source === 'builtin' ? 'builtin' : 'user';
		next.ownedBy = normalizeNullableText(preset.ownedBy);
		next.subset = normalizeNullableText(preset.subset);

		const message = isPlainObject(preset.message) ? preset.message : {};
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
				...(isPlainObject(message.timing) ? message.timing : {}),
				timeBudget: normalizeNumber(message?.timing?.timeBudget, presetTemplateV1.message.timing.timeBudget),
				dueInMs: normalizeNumber(message?.timing?.dueInMs, presetTemplateV1.message.timing.dueInMs),
				expiresInMs: normalizeNumber(message?.timing?.expiresInMs, presetTemplateV1.message.timing.expiresInMs),
				cooldown: normalizeNumber(message?.timing?.cooldown, presetTemplateV1.message.timing.cooldown),
				remindEvery: normalizeNumber(message?.timing?.remindEvery, presetTemplateV1.message.timing.remindEvery),
			},
			details: {
				...presetTemplateV1.message.details,
				...(isPlainObject(message.details) ? message.details : {}),
				task: normalizeText(message?.details?.task),
				reason: normalizeText(message?.details?.reason),
				tools: normalizeStringArray(message?.details?.tools),
				consumables: normalizeStringArray(message?.details?.consumables),
			},
			audience: {
				...presetTemplateV1.message.audience,
				...(isPlainObject(message.audience) ? message.audience : {}),
				tags: normalizeStringArray(message?.audience?.tags),
				channels: {
					...presetTemplateV1.message.audience.channels,
					...(isPlainObject(message?.audience?.channels) ? message.audience.channels : {}),
					include: normalizeStringArray(message?.audience?.channels?.include),
					exclude: normalizeStringArray(message?.audience?.channels?.exclude),
				},
			},
			actions: Array.isArray(message.actions) ? cloneJson(message.actions) : [],
		};

		const policy = isPlainObject(preset.policy) ? preset.policy : {};
		next.policy = {
			...presetTemplateV1.policy,
			...policy,
			resetOnNormal: normalizeBoolean(policy.resetOnNormal, presetTemplateV1.policy.resetOnNormal),
		};

		if (Object.prototype.hasOwnProperty.call(next, 'ui')) {
			delete next.ui;
		}

		return next;
	}

	function validatePreset(preset, { expectedPresetId = '' } = {}) {
		if (!isPlainObject(preset)) {
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
		if (!isPlainObject(msg)) {
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
		if (preset.policy !== undefined && preset.policy !== null && !isPlainObject(preset.policy)) {
			return 'Invalid policy object';
		}
		return null;
	}

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
	 * @param {{ presetId?: string, obj?: any, preset?: any, usageCount?: number }} [info] Summary inputs.
	 * @returns {object} Preset summary row.
	 */
	function toPresetSummary({ presetId, obj, preset, usageCount } = {}) {
		return {
			value: String(presetId || '').trim(),
			source: typeof preset?.source === 'string' ? preset.source.trim() : 'user',
			ownedBy: typeof preset?.ownedBy === 'string' && preset.ownedBy.trim() ? preset.ownedBy.trim() : null,
			subset: typeof preset?.subset === 'string' && preset.subset.trim() ? preset.subset.trim() : null,
			kind:
				typeof preset?.message?.kind === 'string' && preset.message.kind.trim()
					? preset.message.kind.trim()
					: null,
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

	// ── Id generation ─────────────────────────────────────────────────────────

	function normalizePresetIdBase(description) {
		let text = typeof description === 'string' ? description.trim().toLowerCase() : '';
		if (!text) {
			return 'preset';
		}
		text = text.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
		if (typeof text.normalize === 'function') {
			text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
		}
		text = text
			.replace(/[^a-z0-9_-]+/g, '-')
			.replace(/-{2,}/g, '-')
			.replace(/^[-_]+|[-_]+$/g, '');
		return text || 'preset';
	}

	// ── ioBroker object/state helpers ─────────────────────────────────────────

	function presetFullId(presetId) {
		return `${presetsRootFullId}.${presetId}`;
	}

	async function ensurePresetsRoot() {
		try {
			const existing = await ioObjects.getForeignObject(presetsRootFullId);
			if (existing) {
				return;
			}
			await ioObjects.setObjectNotExists(presetsRootOwnId, {
				type: 'channel',
				common: { name: 'IngestStates presets' },
				native: {},
			});
		} catch {
			// best-effort: ignore failures
		}
	}

	async function getPresetIds() {
		await ensurePresetsRoot();
		const objects = await ioObjects.getForeignObjects(`${presetsPrefix}*`);
		const result = new Set();
		for (const id of Object.keys(objects || {})) {
			if (typeof id !== 'string' || !id.startsWith(presetsPrefix)) {
				continue;
			}
			const presetId = id.slice(presetsPrefix.length);
			if (isValidPresetId(presetId)) {
				result.add(presetId);
			}
		}
		return result;
	}

	async function generatePresetId(description) {
		const base = normalizePresetIdBase(description);
		const existingIds = await getPresetIds();
		if (!existingIds.has(base)) {
			return base;
		}
		let n = 2;
		while (existingIds.has(`${base}-${n}`)) {
			n += 1;
		}
		return `${base}-${n}`;
	}

	// ── Service methods ───────────────────────────────────────────────────────

	return {
		/**
		 * List all presets. Supports optional filtering by rule and/or subset.
		 *
		 * @param {any} payload Optional filter: { rule?, subset?, includeUsage? }.
		 * @returns {Promise<{ ok: boolean, data?: Array, error?: object }>} List response.
		 */
		async list(payload) {
			const includeUsage = payload?.includeUsage === true;
			const filterRuleRaw = typeof payload?.rule === 'string' ? payload.rule.trim() : '';
			const filterRule = filterRuleRaw ? filterRuleRaw.toLowerCase() : '';
			const filterSubsetRaw = typeof payload?.subset === 'string' ? payload.subset.trim() : '';
			const filterSubset = filterSubsetRaw ? filterSubsetRaw.toLowerCase() : '';

			await ensurePresetsRoot();
			const objects = await ioObjects.getForeignObjects(`${presetsPrefix}*`);

			const candidates = [];
			for (const [id, obj] of Object.entries(objects || {})) {
				if (typeof id !== 'string' || !id.startsWith(presetsPrefix)) {
					continue;
				}
				const presetId = id.slice(presetsPrefix.length);
				if (!isValidPresetId(presetId)) {
					continue;
				}
				candidates.push({ presetId, obj });
			}

			const reads = await Promise.all(
				candidates.map(async c => {
					try {
						const fullId = presetFullId(c.presetId);
						const st = await ioStates.getForeignState(fullId);
						const raw = typeof st?.val === 'string' ? st.val.trim() : '';
						if (!raw) {
							return null;
						}
						const { preset: parsed, error: err } = parsePresetState(raw, { presetId: c.presetId });
						if (err) {
							return null;
						}
						if (filterRule) {
							const ownedBy = typeof parsed?.ownedBy === 'string' ? parsed.ownedBy.trim() : '';
							const ownerKey = ownedBy ? ownedBy.toLowerCase() : '';
							if (ownerKey && ownerKey !== filterRule) {
								return null;
							}
						}
						if (filterSubset) {
							const subset = typeof parsed?.subset === 'string' ? parsed.subset.trim() : '';
							const subsetKey = subset ? subset.toLowerCase() : '';
							if (subsetKey && subsetKey !== filterSubset) {
								return null;
							}
						}
						const summary = toPresetSummary({ presetId: c.presetId, obj: c.obj, preset: parsed });
						const ownedByRaw = typeof parsed?.ownedBy === 'string' ? parsed.ownedBy.trim() : '';
						return {
							...summary,
							hasOwner: !!ownedByRaw,
							source: typeof parsed?.source === 'string' ? parsed.source.trim() : '',
							ownedBy: ownedByRaw || null,
							subset: typeof parsed?.subset === 'string' ? parsed.subset.trim() : null,
						};
					} catch {
						return null;
					}
				}),
			);

			const out = reads.filter(x => x !== null);

			let usageByPresetId = null;
			if (includeUsage) {
				usageByPresetId = new Map();
				const snapshot = engine?.getPresetUsageSnapshot?.() || [];
				for (const item of Array.isArray(snapshot) ? snapshot : []) {
					const presetId = typeof item?.presetId === 'string' ? item.presetId.trim() : '';
					const usageCount =
						typeof item?.usageCount === 'number' && Number.isFinite(item.usageCount)
							? Math.max(0, Math.trunc(item.usageCount))
							: 0;
					if (!presetId) {
						continue;
					}
					usageByPresetId.set(presetId, usageCount);
				}
			}

			// Sort: owned-first, then alphabetically by name within each group.
			out.sort((a, b) => {
				const aHasOwner = a?.hasOwner === true;
				const bHasOwner = b?.hasOwner === true;
				if (aHasOwner !== bHasOwner) {
					return aHasOwner ? -1 : 1;
				}
				return String(a?.name || '').localeCompare(String(b?.name || ''));
			});

			const list = out.map(item => ({
				value: item.value,
				source: item.source,
				ownedBy: item.ownedBy,
				subset: item.subset,
				kind: item.kind,
				level: item.level,
				name: item.name,
				hasOwner: item.hasOwner,
				...(includeUsage ? { usageCount: usageByPresetId?.get(item.value) || 0 } : {}),
			}));
			return { ok: true, data: list };
		},

		/**
		 * Get a single preset by id.
		 *
		 * @param {any} payload { presetId: string }.
		 * @returns {Promise<{ ok: boolean, data?: object, error?: object }>} Preset wrapper.
		 */
		async get(payload) {
			const presetId = typeof payload?.presetId === 'string' ? payload.presetId.trim() : '';
			if (!isValidPresetId(presetId)) {
				return { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid presetId' } };
			}
			const fullId = presetFullId(presetId);
			const obj = await ioObjects.getForeignObject(fullId);
			if (!obj) {
				return { ok: false, error: { code: 'NOT_FOUND', message: `Preset '${presetId}' not found` } };
			}
			const state = await ioStates.getForeignState(fullId);
			const raw = typeof state?.val === 'string' ? state.val.trim() : '';
			const { preset: parsed, error: err } = parsePresetState(raw, { presetId });
			if (err) {
				return {
					ok: false,
					error: { code: 'INVALID_PRESET', message: `Preset '${presetId}' is invalid: ${err}` },
				};
			}
			return {
				ok: true,
				data: { presetId, preset: parsed, object: cloneJson(obj), state: cloneJson(state) },
			};
		},

		/**
		 * Create a new user-owned preset.
		 *
		 * @param {any} payload { preset: object } — preset.presetId must NOT be set.
		 * @returns {Promise<{ ok: boolean, data?: { presetId: string }, error?: object }>} Create response.
		 */
		async create(payload) {
			const preset = payload?.preset;
			if (!isPlainObject(preset)) {
				return { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing preset object' } };
			}
			if (Object.prototype.hasOwnProperty.call(preset, 'presetId')) {
				return {
					ok: false,
					error: { code: 'BAD_REQUEST', message: 'presetId must not be provided when creating a preset' },
				};
			}
			const source = typeof preset?.source === 'string' ? preset.source.trim() : '';
			if (source !== 'user') {
				return {
					ok: false,
					error: {
						code: 'FORBIDDEN',
						message: `Preset cannot be created with source '${source || 'missing'}' via admin`,
					},
				};
			}

			const nextPreset = normalizePreset(cloneJson(preset), { source: 'user' });
			nextPreset.presetId = await generatePresetId(nextPreset.description);

			const err = validatePreset(nextPreset, { expectedPresetId: nextPreset.presetId });
			if (err) {
				return { ok: false, error: { code: 'BAD_REQUEST', message: `Invalid preset: ${err}` } };
			}

			const presetId = nextPreset.presetId;
			const fullId = presetFullId(presetId);
			const existing = await ioObjects.getForeignObject(fullId);
			if (existing) {
				return { ok: false, error: { code: 'CONFLICT', message: `Preset '${presetId}' already exists` } };
			}

			await ensurePresetsRoot();

			const desc = typeof nextPreset.description === 'string' ? nextPreset.description.trim() : '';
			const name = desc || presetId;
			const ownId = ids.toOwnId(fullId);

			await ioObjects.setObjectNotExists(ownId, {
				_id: fullId,
				type: 'state',
				common: { name, type: 'string', role: 'json', read: true, write: false },
				native: {},
			});
			await ioStates.setForeignState(fullId, { val: JSON.stringify(nextPreset), ack: true });
			return { ok: true, data: { presetId } };
		},

		/**
		 * Update an existing user-owned preset.
		 *
		 * @param {any} payload { presetId: string, preset: object }.
		 * @returns {Promise<{ ok: boolean, data?: { presetId: string }, error?: object }>} Update response.
		 */
		async update(payload) {
			const preset = payload?.preset;
			if (!isPlainObject(preset)) {
				return { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing preset object' } };
			}
			const presetId = typeof payload?.presetId === 'string' ? payload.presetId.trim() : '';
			if (!isValidPresetId(presetId)) {
				return { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid presetId' } };
			}

			const fullId = presetFullId(presetId);
			const existing = await ioObjects.getForeignObject(fullId);
			if (!existing) {
				return { ok: false, error: { code: 'NOT_FOUND', message: `Preset '${presetId}' not found` } };
			}

			let existingPreset = null;
			try {
				const st = await ioStates.getForeignState(fullId);
				const raw = typeof st?.val === 'string' ? st.val.trim() : '';
				existingPreset = raw ? JSON.parse(raw) : null;
			} catch {
				existingPreset = null;
			}

			const existingSource = typeof existingPreset?.source === 'string' ? existingPreset.source.trim() : '';
			if (existingSource && existingSource !== 'user') {
				return {
					ok: false,
					error: { code: 'FORBIDDEN', message: `Preset source is '${existingSource}'` },
				};
			}

			const source = typeof preset?.source === 'string' ? preset.source.trim() : '';
			if (source !== 'user') {
				return {
					ok: false,
					error: {
						code: 'FORBIDDEN',
						message: `Preset cannot be updated with source '${source || 'missing'}' via admin`,
					},
				};
			}

			const nextPreset = normalizePreset(cloneJson(preset), { presetId, source: 'user' });
			const err = validatePreset(nextPreset, { expectedPresetId: presetId });
			if (err) {
				return { ok: false, error: { code: 'BAD_REQUEST', message: `Invalid preset: ${err}` } };
			}

			await ensurePresetsRoot();

			const desc = typeof nextPreset.description === 'string' ? nextPreset.description.trim() : '';
			const name = desc || presetId;
			// setForeignObject (full replace) is not in the plugin ctx API; use extendForeignObject to
			// update the label. The preset object has a flat known shape so this is equivalent.
			await ioObjects.extendForeignObject(fullId, {
				common: { name, type: 'string', role: 'json', read: true, write: false },
			});
			await ioStates.setForeignState(fullId, { val: JSON.stringify(nextPreset), ack: true });
			return { ok: true, data: { presetId } };
		},

		/**
		 * Delete a user-owned preset.
		 *
		 * @param {any} payload { presetId: string }.
		 * @returns {Promise<{ ok: boolean, data?: { deleted: boolean, presetId: string }, error?: object }>}
		 *   Delete response.
		 */
		async delete(payload) {
			const presetId = typeof payload?.presetId === 'string' ? payload.presetId.trim() : '';
			if (!isValidPresetId(presetId)) {
				return { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid presetId' } };
			}
			const fullId = presetFullId(presetId);
			const obj = await ioObjects.getForeignObject(fullId);
			if (!obj) {
				return { ok: true, data: { deleted: false, presetId } };
			}
			const st = await ioStates.getForeignState(fullId);
			const { preset: existingPreset } = parsePresetState(typeof st?.val === 'string' ? st.val : '', {
				presetId,
			});
			const existingSource = typeof existingPreset?.source === 'string' ? existingPreset.source.trim() : '';
			if (existingSource && existingSource !== 'user') {
				return {
					ok: false,
					error: { code: 'FORBIDDEN', message: `Preset source is '${existingSource}'` },
				};
			}
			const ownId = ids.toOwnId(fullId);
			await ioObjects.delObject(ownId);
			return { ok: true, data: { deleted: true, presetId } };
		},
	};
}

module.exports = { createPresetsService };
