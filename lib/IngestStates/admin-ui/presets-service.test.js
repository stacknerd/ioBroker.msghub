/**
 * presets-service.test.js
 * =======================
 *
 * Unit tests for the preset editor bootstrap DTO in presets-service.js
 */

'use strict';

const assert = require('assert');

const { presetBindingCatalog, presetSchema, presetTemplateV1, ruleTemplateCatalog } = require('../constants');
const { createPresetsService } = require('./presets-service');

function makeCtx(constantsOverrides = {}) {
	return {
		api: {
			constants: {
				kind: {
					status: 'status',
					task: 'task',
				},
				level: {
					notice: 20,
					warning: 30,
				},
				...constantsOverrides,
			},
			iobroker: {
				objects: {},
				states: {},
				ids: {
					toOwnId(fullId) {
						return String(fullId || '').replace(/^msghub\.0\./, '');
					},
				},
			},
		},
		meta: {
			plugin: {
				baseFullId: 'msghub.0.IngestStates.0',
			},
		},
	};
}

describe('presets-service bootstrap DTO', () => {
	it('returns the static ingest constants plus kind/level msg constants', async () => {
		const service = createPresetsService(makeCtx(), null);
		const res = await service.bootstrap();

		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(res.data.ingestConstants, {
			presetSchema,
			presetTemplate: presetTemplateV1,
			presetBindingCatalog,
			ruleTemplateCatalog,
		});
		assert.deepStrictEqual(res.data.msgConstants, {
			kind: {
				status: 'status',
				task: 'task',
			},
			level: {
				notice: 20,
				warning: 30,
			},
		});
	});

	it('clones the bootstrap payload instead of exposing shared mutable objects', async () => {
		const service = createPresetsService(makeCtx(), null);

		const first = await service.bootstrap();
		first.data.ingestConstants.presetTemplate.description = 'mutated';
		first.data.ingestConstants.presetBindingCatalog.threshold.ownedBy = 'changed';
		first.data.msgConstants.level.notice = 999;

		const second = await service.bootstrap();
		assert.strictEqual(second.data.ingestConstants.presetTemplate.description, presetTemplateV1.description);
		assert.strictEqual(second.data.ingestConstants.presetBindingCatalog.threshold.ownedBy, 'Threshold');
		assert.strictEqual(second.data.msgConstants.level.notice, 20);
	});

	it('falls back to empty kind/level maps when ctx.api.constants is absent', async () => {
		const ctx = makeCtx();
		ctx.api.constants = null;

		const service = createPresetsService(ctx, null);
		const res = await service.bootstrap();

		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(res.data.msgConstants, {
			kind: {},
			level: {},
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// getPresetSelectOptions
// ─────────────────────────────────────────────────────────────────────────────

describe('presets-service getPresetSelectOptions', () => {
	const BASE = 'msghub.0.IngestStates.0';
	const PRESETS_ROOT = `${BASE}.presets`;

	/**
	 * Build a minimal valid preset value object.
	 *
	 * @param {object} overrides Field overrides.
	 * @returns {object} Preset value.
	 */
	function makePresetVal(overrides = {}) {
		return {
			schema: 'msghub.IngestStatesMessagePreset.v1',
			presetId: 'p1',
			description: 'Test',
			source: 'user',
			ownedBy: null,
			subset: null,
			message: {
				kind: 'status',
				level: 20,
				title: 'T',
				text: 'X',
				textRecovered: '',
				timing: {},
				details: {},
				audience: {},
				actions: [],
			},
			policy: { resetOnNormal: true },
			...overrides,
		};
	}

	/**
	 * Build a full ctx with in-memory objects + states for preset tests.
	 *
	 * Each entry in `presets` is `{ presetId, preset, stateNull?, rawStateVal? }`.
	 * - stateNull: true → state entry omitted, getForeignState returns null.
	 * - rawStateVal: string → stored as-is instead of JSON.stringify(preset),
	 *   allowing invalid JSON to be injected for lenient-fallback tests.
	 *
	 * @param {{ presets?: Array, i18nMap?: object }} opts Test options.
	 * @returns {object} Plugin ctx.
	 */
	function makeCtxWithPresets({ presets = [], i18nMap = {} } = {}) {
		const objStore = new Map();
		const stStore = new Map();

		// Root channel — ensures ensurePresetsRoot() returns immediately.
		objStore.set(PRESETS_ROOT, {
			_id: PRESETS_ROOT,
			type: 'channel',
			common: { name: 'IngestStates presets' },
		});

		for (const entry of presets) {
			const { presetId, preset, stateNull } = entry;
			const fullId = `${PRESETS_ROOT}.${presetId}`;
			const desc = typeof preset.description === 'string' ? preset.description.trim() : '';
			objStore.set(fullId, {
				_id: fullId,
				type: 'state',
				common: { name: desc || presetId, role: 'json', type: 'string' },
			});
			if (!stateNull) {
				const rawVal = Object.prototype.hasOwnProperty.call(entry, 'rawStateVal')
					? entry.rawStateVal
					: JSON.stringify(preset);
				stStore.set(fullId, { val: rawVal, ack: true, ts: Date.now() });
			}
		}

		const i18n = {
			t: (key, ...args) => {
				const tpl = i18nMap[key] ?? key;
				if (!args.length) {
					return String(tpl);
				}
				let i = 0;
				return String(tpl).replace(/%s/g, () => String(args[i++] ?? ''));
			},
		};

		return {
			api: {
				constants: { kind: { status: 'status' }, level: { notice: 20 } },
				i18n,
				iobroker: {
					objects: {
						getForeignObject: async id => objStore.get(id) ?? null,
						getForeignObjects: async pattern => {
							const out = {};
							const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : null;
							for (const [id, obj] of objStore) {
								if (prefix ? id.startsWith(prefix) : id === pattern) {
									out[id] = obj;
								}
							}
							return out;
						},
						setObjectNotExists: async () => {},
					},
					states: {
						getForeignState: async id => stStore.get(id) ?? null,
					},
					ids: {
						toOwnId: fullId => String(fullId).replace(/^msghub\.0\./, ''),
					},
				},
			},
			meta: {
				plugin: { baseFullId: BASE },
			},
		};
	}

	it('returns options for presets matching the rule filter', async () => {
		const ctx = makeCtxWithPresets({
			presets: [
				{ presetId: 'pSession', preset: makePresetVal({ presetId: 'pSession', ownedBy: 'session', subset: 'start' }) },
				{ presetId: 'pThreshold', preset: makePresetVal({ presetId: 'pThreshold', ownedBy: 'threshold', subset: 'lt' }) },
			],
		});
		const service = createPresetsService(ctx, null);
		const result = await service.getPresetSelectOptions({ rule: 'session' });
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].value, 'pSession');
	});

	it('sorts owned presets before global (no ownedBy) presets', async () => {
		const ctx = makeCtxWithPresets({
			presets: [
				{ presetId: 'pGlobal', preset: makePresetVal({ presetId: 'pGlobal', ownedBy: null, subset: null }) },
				{ presetId: 'pOwned', preset: makePresetVal({ presetId: 'pOwned', ownedBy: 'session', subset: 'start' }) },
			],
		});
		const service = createPresetsService(ctx, null);
		const result = await service.getPresetSelectOptions({});
		assert.strictEqual(result[0].value, 'pOwned');
		assert.strictEqual(result[1].value, 'pGlobal');
	});

	it('injects currentValue at index 0 when it was filtered out', async () => {
		const ctx = makeCtxWithPresets({
			presets: [
				{ presetId: 'pStart', preset: makePresetVal({ presetId: 'pStart', ownedBy: 'session', subset: 'start' }) },
				{ presetId: 'pEnd', preset: makePresetVal({ presetId: 'pEnd', ownedBy: 'session', subset: 'end' }) },
			],
		});
		const service = createPresetsService(ctx, null);
		// Filter to subset=start; pEnd is excluded but injected via currentValue.
		const result = await service.getPresetSelectOptions({ subset: 'start', currentValue: 'pEnd' });
		assert.strictEqual(result[0].value, 'pEnd');
		assert.strictEqual(result[1].value, 'pStart');
	});

	it('returns empty array when no presets exist', async () => {
		const ctx = makeCtxWithPresets({ presets: [] });
		const service = createPresetsService(ctx, null);
		const result = await service.getPresetSelectOptions({});
		assert.deepStrictEqual(result, []);
	});

	it('injects filtered-out currentValue with incompatible label marker', async () => {
		const ctx = makeCtxWithPresets({
			presets: [
				{ presetId: 'pStart', preset: makePresetVal({ presetId: 'pStart', ownedBy: 'session', subset: 'start' }) },
				{ presetId: 'pEnd', preset: makePresetVal({ presetId: 'pEnd', ownedBy: 'session', subset: 'end' }) },
			],
			i18nMap: {
				'msghub.i18n.IngestStates.admin.jsonCustom.preset.incompatible.label': 'INCOMPATIBLE: %s',
			},
		});
		const service = createPresetsService(ctx, null);
		// pEnd is excluded by subset filter; it should be injected with INCOMPATIBLE label.
		const result = await service.getPresetSelectOptions({ rule: 'session', subset: 'start', currentValue: 'pEnd' });
		assert.strictEqual(result[0].value, 'pEnd');
		assert.ok(
			result[0].label.includes('INCOMPATIBLE'),
			`expected "INCOMPATIBLE" in label, got: ${result[0].label}`,
		);
		assert.strictEqual(result[1].value, 'pStart');
	});

	it('does not inject currentValue when it is not a valid presetId', async () => {
		const ctx = makeCtxWithPresets({ presets: [] });
		const service = createPresetsService(ctx, null);
		const result = await service.getPresetSelectOptions({ currentValue: 'not valid!' });
		assert.deepStrictEqual(result, []);
	});

	it('injects currentValue at index 0 with fallback label when state has invalid JSON', async () => {
		const ctx = makeCtxWithPresets({
			presets: [
				{
					presetId: 'pBadJson',
					preset: makePresetVal({ presetId: 'pBadJson' }),
					rawStateVal: '{{invalid json not parseable}}',
				},
			],
		});
		const service = createPresetsService(ctx, null);
		// pBadJson is excluded from the main list (state unparseable → skipped),
		// but injected via currentValue with the raw presetId as fallback label.
		const result = await service.getPresetSelectOptions({ currentValue: 'pBadJson' });
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].value, 'pBadJson');
		assert.ok(
			result[0].label.includes('pBadJson'),
			`expected fallback label to contain "pBadJson", got: ${result[0].label}`,
		);
	});

	it('skips presets whose state is missing and returns the remaining ones', async () => {
		const ctx = makeCtxWithPresets({
			presets: [
				{ presetId: 'pOk', preset: makePresetVal({ presetId: 'pOk', ownedBy: null, subset: null }) },
				{ presetId: 'pNoState', preset: makePresetVal({ presetId: 'pNoState' }), stateNull: true },
			],
		});
		const service = createPresetsService(ctx, null);
		const result = await service.getPresetSelectOptions({});
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].value, 'pOk');
	});
});
