/**
 * bulkapply-service.test.js
 * =========================
 *
 * Unit tests for lib/IngestStates/admin-ui/bulkapply-service.js
 */

'use strict';

const assert = require('assert');
const { jsonCustomDefaults } = require('../constants');
const { createBulkApplyService } = require('./bulkapply-service');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(opts = {}) {
	const namespace = opts.namespace || 'msghub.0';
	return {
		api: {
			iobroker: {
				objects: {
					getForeignObject: opts.getForeignObject || (async () => null),
					getForeignObjects: opts.getForeignObjects || (async () => ({})),
					extendForeignObject: opts.extendForeignObject || (async () => {}),
				},
				ids: { namespace },
			},
		},
		meta: {
			plugin: {
				baseFullId: opts.baseFullId || `${namespace}.IngestStates.0`,
			},
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// bootstrap
// ─────────────────────────────────────────────────────────────────────────────

describe('bulkapply-service — bootstrap', () => {
	it('returns ok: true with namespace and jsonCustomDefaults', async () => {
		const svc = createBulkApplyService(makeCtx());
		const res = await svc.bootstrap();
		assert.strictEqual(res.ok, true);
		assert.strictEqual(typeof res.data, 'object');
	});

	it('returns namespace equal to ctx.meta.plugin.baseFullId', async () => {
		const svc = createBulkApplyService(makeCtx({ baseFullId: 'msghub.0.IngestStates.0' }));
		const res = await svc.bootstrap();
		assert.strictEqual(res.data.namespace, 'msghub.0.IngestStates.0');
	});

	it('returns jsonCustomDefaults', async () => {
		const svc = createBulkApplyService(makeCtx());
		const res = await svc.bootstrap();
		assert.deepStrictEqual(res.data.jsonCustomDefaults, jsonCustomDefaults);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// configRead
// ─────────────────────────────────────────────────────────────────────────────

describe('bulkapply-service — configRead', () => {
	it('returns custom config when present on the object', async () => {
		const svc = createBulkApplyService(makeCtx({
			getForeignObject: async () => ({
				common: { custom: { 'msghub.0': { mode: 'thr', enabled: true } } },
			}),
		}));
		const res = await svc.configRead({ id: 'dev.0.temp' });
		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(res.data.custom, { mode: 'thr', enabled: true });
	});

	it('returns custom: null when no IngestStates config on object', async () => {
		const svc = createBulkApplyService(makeCtx({
			getForeignObject: async () => ({ common: { custom: {} } }),
		}));
		const res = await svc.configRead({ id: 'dev.0.temp' });
		assert.strictEqual(res.ok, true);
		assert.strictEqual(res.data.custom, null);
	});

	it('strips managedMeta keys from returned custom', async () => {
		const svc = createBulkApplyService(makeCtx({
			getForeignObject: async () => ({
				common: {
					custom: {
						'msghub.0': {
							mode: 'thr',
							'managedMeta-presetKey': 'some-preset',
						},
					},
				},
			}),
		}));
		const res = await svc.configRead({ id: 'dev.0.temp' });
		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(res.data.custom, { mode: 'thr' });
	});

	it('returns BAD_REQUEST when id is missing', async () => {
		const svc = createBulkApplyService(makeCtx());
		const res = await svc.configRead({});
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'BAD_REQUEST');
	});

	it('returns NOT_FOUND when object does not exist', async () => {
		const svc = createBulkApplyService(makeCtx({ getForeignObject: async () => null }));
		const res = await svc.configRead({ id: 'does.not.exist' });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'NOT_FOUND');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// preview
// ─────────────────────────────────────────────────────────────────────────────

describe('bulkapply-service — preview', () => {
	it('counts matchedStates, willChange, unchanged correctly', async () => {
		// s1: existing mode='thr', patch mode='fresh' → changed
		// s2: no existing custom → changed (null → {mode:'fresh'})
		// msghub.0.own: starts with ownPrefix → skipped
		const svc = createBulkApplyService(makeCtx({
			getForeignObjects: async () => ({
				'dev.0.s1': { type: 'state', common: { custom: { 'msghub.0': { mode: 'thr' } } } },
				'dev.0.s2': { type: 'state', common: { custom: {} } },
				'msghub.0.own': { type: 'state', common: {} },
			}),
		}));
		const res = await svc.preview({ pattern: 'dev.0.*', custom: { mode: 'fresh' } });
		assert.strictEqual(res.ok, true);
		assert.strictEqual(res.data.totalObjects, 3);
		assert.strictEqual(res.data.matchedStates, 2);
		assert.strictEqual(res.data.willChange, 2);
		assert.strictEqual(res.data.unchanged, 0);
	});

	it('counts unchanged when result equals existing', async () => {
		// replace=true, existing mode='fresh', patch mode='fresh' → unchanged
		const svc = createBulkApplyService(makeCtx({
			getForeignObjects: async () => ({
				'dev.0.s1': { type: 'state', common: { custom: { 'msghub.0': { mode: 'fresh' } } } },
			}),
		}));
		const res = await svc.preview({ pattern: 'dev.0.*', custom: { mode: 'fresh' }, replace: true });
		assert.strictEqual(res.ok, true);
		assert.strictEqual(res.data.willChange, 0);
		assert.strictEqual(res.data.unchanged, 1);
	});

	it('returns zero counts when no matching state objects', async () => {
		const svc = createBulkApplyService(makeCtx({
			getForeignObjects: async () => ({
				'dev.0.chan': { type: 'channel', common: {} },
			}),
		}));
		const res = await svc.preview({ pattern: 'dev.0.*', custom: { mode: 'fresh' } });
		assert.strictEqual(res.ok, true);
		assert.strictEqual(res.data.matchedStates, 0);
		assert.strictEqual(res.data.willChange, 0);
	});

	it('clamps sample to the specified limit', async () => {
		const objects = {};
		for (let i = 0; i < 10; i++) {
			objects[`dev.0.s${i}`] = { type: 'state', common: {} };
		}
		const svc = createBulkApplyService(makeCtx({ getForeignObjects: async () => objects }));
		const res = await svc.preview({ pattern: 'dev.0.*', custom: { mode: 'fresh' }, limit: 3 });
		assert.strictEqual(res.ok, true);
		assert.strictEqual(res.data.sample.length, 3);
	});

	it('returns BAD_REQUEST when pattern is missing', async () => {
		const svc = createBulkApplyService(makeCtx());
		const res = await svc.preview({ custom: { mode: 'thr' } });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'BAD_REQUEST');
	});

	it('returns BAD_REQUEST when custom is not an object', async () => {
		const svc = createBulkApplyService(makeCtx());
		const res = await svc.preview({ pattern: 'dev.*', custom: 'invalid' });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'BAD_REQUEST');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// apply
// ─────────────────────────────────────────────────────────────────────────────

describe('bulkapply-service — apply', () => {
	it('calls extendForeignObject only for changed objects', async () => {
		const calls = [];
		// replace=true: s1 mode='thr' → 'fresh' (changed), s2 mode='fresh' → 'fresh' (unchanged)
		const svc = createBulkApplyService(makeCtx({
			getForeignObjects: async () => ({
				'dev.0.s1': { type: 'state', common: { custom: { 'msghub.0': { mode: 'thr' } } } },
				'dev.0.s2': { type: 'state', common: { custom: { 'msghub.0': { mode: 'fresh' } } } },
			}),
			extendForeignObject: async id => { calls.push(id); },
		}));
		const res = await svc.apply({ pattern: 'dev.0.*', custom: { mode: 'fresh' }, replace: true });
		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(calls, ['dev.0.s1']);
		assert.deepStrictEqual(res.data.errors, []);
	});

	it('continues writing remaining objects when one throws and reports errors', async () => {
		const calls = [];
		const svc = createBulkApplyService(makeCtx({
			getForeignObjects: async () => ({
				'dev.0.s1': { type: 'state', common: {} },
				'dev.0.s2': { type: 'state', common: {} },
			}),
			extendForeignObject: async id => {
				calls.push(id);
				if (id === 'dev.0.s1') {
					throw new Error('write failed');
				}
			},
		}));
		const res = await svc.apply({ pattern: 'dev.0.*', custom: { mode: 'fresh' } });
		assert.strictEqual(res.ok, true);
		assert.ok(calls.includes('dev.0.s2'), 's2 must still be written when s1 throws');
		assert.strictEqual(res.data.errors.length, 1);
		assert.strictEqual(res.data.errors[0].id, 'dev.0.s1');
		assert.ok(typeof res.data.errors[0].message === 'string');
	});

	it('returns BAD_REQUEST when pattern is missing', async () => {
		const svc = createBulkApplyService(makeCtx());
		const res = await svc.apply({ custom: { mode: 'thr' } });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'BAD_REQUEST');
	});

	it('returns BAD_REQUEST when custom is not an object', async () => {
		const svc = createBulkApplyService(makeCtx());
		const res = await svc.apply({ pattern: 'dev.*', custom: null });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'BAD_REQUEST');
	});
});
