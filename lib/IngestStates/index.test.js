'use strict';

const { expect } = require('chai');

describe('IngestStates index exports', () => {
	it('exports IngestStates factory and manifest', () => {
		const mod = require('./index');
		expect(mod).to.have.property('IngestStates').that.is.a('function');
		expect(mod).to.have.property('manifest').that.is.an('object');
		expect(mod.manifest).to.have.property('type', 'IngestStates');
	});

});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for runtime-entry tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal but complete mock context that satisfies ensureCtxAvailability
 * for IngestStates.start().  All I/O is stubbed as no-ops; rescan/tick intervals
 * are suppressed by returning 0 from resolveInt.
 *
 * @returns {object} Mock plugin context.
 */
function makeMinimalCtx() {
	const noop = async () => {};
	const noopNull = async () => null;
	const noopObj = async () => ({});
	return {
		api: {
			log: { info: () => {}, warn: () => {}, debug: () => {}, silly: () => {}, error: () => {} },
			i18n: { t: key => key },
			iobroker: {
				ids: { namespace: 'msghub.0', toOwnId: id => `msghub.0.${id}` },
				objects: {
					getObjectView: async () => ({ rows: [] }),
					setObjectNotExists: noop,
					getForeignObject: noopNull,
					getForeignObjects: noopObj,
					extendForeignObject: noop,
					delObject: noop,
				},
				states: { setForeignState: noop, getForeignState: noopNull },
				subscribe: {
					subscribeForeignStates: noop,
					unsubscribeForeignStates: noop,
					subscribeForeignObjects: noop,
					unsubscribeForeignObjects: noop,
				},
			},
			store: {
				getMessageByRef: () => null,
				addMessage: noop,
				addOrUpdateMessage: noop,
				updateMessage: noop,
				completeAfterCauseEliminated: noop,
			},
			factory: { createMessage: () => ({}) },
			constants: {},
		},
		meta: {
			plugin: { baseFullId: 'msghub.0.IngestStates.0', baseOwnId: 'IngestStates.0' },
			// resolveInt returns 0 so the engine creates no rescan/tick intervals.
			options: { resolveInt: () => 0, resolveBool: () => false },
			managedObjects: { report: () => {}, applyReported: noop },
			resources: {
				setInterval: (fn, ms) => setInterval(fn, ms),
				setTimeout: (fn, ms) => setTimeout(fn, ms),
				clearTimeout: handle => clearTimeout(handle),
			},
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// getPresetSelectOptions runtime-entry tests
// ─────────────────────────────────────────────────────────────────────────────

describe('IngestStates plugin — getPresetSelectOptions runtime entry', () => {
	it('getPresetSelectOptions is a function on the plugin instance', () => {
		const { IngestStates } = require('./index');
		const plugin = IngestStates();
		expect(typeof plugin.getPresetSelectOptions).to.equal('function');
	});

	it('returns [] before start() is called (presetsService not yet set)', async () => {
		const { IngestStates } = require('./index');
		const plugin = IngestStates();
		const result = await plugin.getPresetSelectOptions({ suffix: '.cycle', payload: {} });
		expect(result).to.deep.equal([]);
	});

	it('interprets suffix as rule[.subset] — filter-sensitive result proves forwarding', async () => {
		// One preset with ownedBy='cycle', subset='period'.
		// suffix '.cycle.period' → rule='cycle' → preset matches → 1 option.
		// suffix '.threshold' → rule='threshold' → preset excluded → empty.
		const { IngestStates } = require('./index');

		const BASE = 'msghub.0.IngestStates.0';
		const PRESETS_ROOT = `${BASE}.presets`;
		const PRESET_ID = 'pCycle';
		const PRESET_FULL_ID = `${PRESETS_ROOT}.${PRESET_ID}`;
		const presetJson = JSON.stringify({
			schema: 'msghub.IngestStatesMessagePreset.v1',
			presetId: PRESET_ID,
			description: 'Cycle Preset',
			source: 'user',
			ownedBy: 'cycle',
			subset: 'period',
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
		});

		const ctx = makeMinimalCtx();
		// Fix toOwnId to strip namespace (required by ensurePresetsRoot).
		ctx.api.iobroker.ids.toOwnId = id => String(id || '').replace(/^msghub\.0\./, '');
		ctx.api.iobroker.objects.getForeignObject = async id => {
			if (id === PRESETS_ROOT) return { _id: PRESETS_ROOT, type: 'channel', common: {} };
			if (id === PRESET_FULL_ID)
				return {
					_id: PRESET_FULL_ID,
					type: 'state',
					common: { name: PRESET_ID, role: 'json', type: 'string' },
				};
			return null;
		};
		ctx.api.iobroker.objects.getForeignObjects = async pattern => {
			const prefix = typeof pattern === 'string' && pattern.endsWith('*') ? pattern.slice(0, -1) : null;
			if (prefix && PRESET_FULL_ID.startsWith(prefix)) {
				return { [PRESET_FULL_ID]: { _id: PRESET_FULL_ID, type: 'state', common: {} } };
			}
			return {};
		};
		ctx.api.iobroker.states.getForeignState = async id => {
			if (id === PRESET_FULL_ID) return { val: presetJson, ack: true };
			return null;
		};

		const plugin = IngestStates();
		plugin.start(ctx);

		// Suffix encodes rule=cycle, subset=period → preset matches.
		const withMatch = await plugin.getPresetSelectOptions({ suffix: '.cycle.period', payload: {} });
		expect(withMatch).to.have.length(1);
		expect(withMatch[0].value).to.equal(PRESET_ID);

		// Suffix encodes rule=threshold only → preset excluded.
		const withoutMatch = await plugin.getPresetSelectOptions({ suffix: '.threshold', payload: {} });
		expect(withoutMatch).to.deep.equal([]);

		// payload.rule overrides suffix-derived rule — IngestStates owns this override logic.
		const withPayloadOverride = await plugin.getPresetSelectOptions({
			suffix: '.threshold',
			payload: { rule: 'cycle' },
		});
		expect(withPayloadOverride).to.have.length(1);
		expect(withPayloadOverride[0].value).to.equal(PRESET_ID);

		plugin.stop();
	});

	it('returns [] after stop() (presetsService nulled)', async () => {
		const { IngestStates } = require('./index');
		const plugin = IngestStates();
		plugin.start(makeMinimalCtx());
		plugin.stop();
		const result = await plugin.getPresetSelectOptions({ suffix: '.cycle', payload: {} });
		expect(result).to.deep.equal([]);
	});
});
