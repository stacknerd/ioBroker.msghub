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
