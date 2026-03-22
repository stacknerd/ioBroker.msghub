/**
 * rpc.test.js
 * ===========
 *
 * Unit tests for lib/IngestStates/admin-ui/rpc.js
 */

'use strict';

const assert = require('assert');
const { createRpcHandler } = require('./rpc');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makePresets(overrides = {}) {
	return {
		bootstrap: async () => ({ ok: true, data: { ingestConstants: {}, msgConstants: {} } }),
		list: async () => ({ ok: true, data: [] }),
		get: async () => ({ ok: true, data: { presetId: 'p1' } }),
		create: async () => ({ ok: true, data: { presetId: 'new-preset' } }),
		update: async () => ({ ok: true, data: { presetId: 'p1' } }),
		delete: async () => ({ ok: true, data: { deleted: true, presetId: 'p1' } }),
		...overrides,
	};
}

function makeHandler(presetsOverrides = {}) {
	return createRpcHandler({ presets: makePresets(presetsOverrides) });
}

// ─────────────────────────────────────────────────────────────────────────────
// BAD_REQUEST — missing panelId or command
// ─────────────────────────────────────────────────────────────────────────────

describe('rpc — BAD_REQUEST', () => {
	it('returns BAD_REQUEST when panelId is missing', async () => {
		const { handleRpc } = makeHandler();
		const res = await handleRpc({ command: 'presets.list' });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'BAD_REQUEST');
	});

	it('returns BAD_REQUEST when command is missing', async () => {
		const { handleRpc } = makeHandler();
		const res = await handleRpc({ panelId: 'presets' });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'BAD_REQUEST');
	});

	it('returns BAD_REQUEST when called with no arguments', async () => {
		const { handleRpc } = makeHandler();
		const res = await handleRpc();
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'BAD_REQUEST');
	});

	it('returns BAD_REQUEST when panelId is whitespace-only', async () => {
		const { handleRpc } = makeHandler();
		const res = await handleRpc({ panelId: '   ', command: 'presets.list' });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'BAD_REQUEST');
	});

	it('returns BAD_REQUEST when command is whitespace-only', async () => {
		const { handleRpc } = makeHandler();
		const res = await handleRpc({ panelId: 'presets', command: '  ' });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'BAD_REQUEST');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path — each presets command
// ─────────────────────────────────────────────────────────────────────────────

describe('rpc — presets panel happy paths', () => {
	it('routes presets.bootstrap and returns service result', async () => {
		let capturedPayload = 'not-set';
		const { handleRpc } = makeHandler({
			bootstrap: async payload => {
				capturedPayload = payload;
				return { ok: true, data: { ingestConstants: { presetSchema: 'x' }, msgConstants: { kind: {} } } };
			},
		});
		const res = await handleRpc({ panelId: 'presets', command: 'presets.bootstrap' });
		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(res.data, { ingestConstants: { presetSchema: 'x' }, msgConstants: { kind: {} } });
		assert.strictEqual(capturedPayload, null);
	});

	it('routes presets.list and returns service result', async () => {
		let capturedPayload;
		const { handleRpc } = makeHandler({
			list: async payload => {
				capturedPayload = payload;
				return { ok: true, data: [{ presetId: 'p1' }] };
			},
		});
		const res = await handleRpc({ panelId: 'presets', command: 'presets.list', payload: { includeUsage: true } });
		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(res.data, [{ presetId: 'p1' }]);
		assert.deepStrictEqual(capturedPayload, { includeUsage: true });
	});

	it('routes presets.get and returns service result', async () => {
		let capturedPayload;
		const { handleRpc } = makeHandler({
			get: async payload => {
				capturedPayload = payload;
				return { ok: true, data: { presetId: 'p1' } };
			},
		});
		const res = await handleRpc({ panelId: 'presets', command: 'presets.get', payload: { presetId: 'p1' } });
		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(capturedPayload, { presetId: 'p1' });
	});

	it('routes presets.create and returns service result', async () => {
		let capturedPayload;
		const { handleRpc } = makeHandler({
			create: async payload => {
				capturedPayload = payload;
				return { ok: true, data: { presetId: 'new-preset' } };
			},
		});
		const res = await handleRpc({ panelId: 'presets', command: 'presets.create', payload: { preset: {} } });
		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(capturedPayload, { preset: {} });
	});

	it('routes presets.update and returns service result', async () => {
		let capturedPayload;
		const { handleRpc } = makeHandler({
			update: async payload => {
				capturedPayload = payload;
				return { ok: true, data: { presetId: 'p1' } };
			},
		});
		const res = await handleRpc({ panelId: 'presets', command: 'presets.update', payload: { presetId: 'p1', preset: {} } });
		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(capturedPayload, { presetId: 'p1', preset: {} });
	});

	it('routes presets.delete and returns service result', async () => {
		let capturedPayload;
		const { handleRpc } = makeHandler({
			delete: async payload => {
				capturedPayload = payload;
				return { ok: true, data: { deleted: true, presetId: 'p1' } };
			},
		});
		const res = await handleRpc({ panelId: 'presets', command: 'presets.delete', payload: { presetId: 'p1' } });
		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(capturedPayload, { presetId: 'p1' });
	});

	it('passes null payload when payload is omitted', async () => {
		let capturedPayload = 'not-set';
		const { handleRpc } = makeHandler({
			list: async payload => {
				capturedPayload = payload;
				return { ok: true, data: [] };
			},
		});
		await handleRpc({ panelId: 'presets', command: 'presets.list' });
		assert.strictEqual(capturedPayload, null);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Whitespace trimming
// ─────────────────────────────────────────────────────────────────────────────

describe('rpc — panelId/command whitespace trimming', () => {
	it('trims leading/trailing whitespace from panelId and command', async () => {
		const { handleRpc } = makeHandler({
			list: async () => ({ ok: true, data: ['trimmed'] }),
		});
		const res = await handleRpc({ panelId: '  presets  ', command: '  presets.list  ' });
		assert.strictEqual(res.ok, true);
		assert.deepStrictEqual(res.data, ['trimmed']);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// UNSUPPORTED_COMMAND
// ─────────────────────────────────────────────────────────────────────────────

describe('rpc — UNSUPPORTED_COMMAND', () => {
	it('returns UNSUPPORTED_COMMAND for unknown command in presets panel', async () => {
		const { handleRpc } = makeHandler();
		const res = await handleRpc({ panelId: 'presets', command: 'presets.unknown' });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'UNSUPPORTED_COMMAND');
	});

	it('returns UNSUPPORTED_COMMAND for unknown panelId', async () => {
		const { handleRpc } = makeHandler();
		const res = await handleRpc({ panelId: 'bulkapply', command: 'bulkApply.apply' });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'UNSUPPORTED_COMMAND');
	});

	it('returns UNSUPPORTED_COMMAND for bulkapply panel (not active in pilot)', async () => {
		const { handleRpc } = makeHandler();
		const res = await handleRpc({ panelId: 'bulkapply', command: 'constants.get' });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'UNSUPPORTED_COMMAND');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Error propagation
// ─────────────────────────────────────────────────────────────────────────────

describe('rpc — error propagation', () => {
	it('passes through NOT_FOUND from service as-is', async () => {
		const { handleRpc } = makeHandler({
			get: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'Preset not found' } }),
		});
		const res = await handleRpc({ panelId: 'presets', command: 'presets.get', payload: { presetId: 'missing' } });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'NOT_FOUND');
	});

	it('catches synchronous Error throws and returns INTERNAL', async () => {
		const { handleRpc } = makeHandler({
			list: async () => {
				throw new Error('DB exploded');
			},
		});
		const res = await handleRpc({ panelId: 'presets', command: 'presets.list' });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'INTERNAL');
		assert.ok(res.error.message.includes('DB exploded'));
	});

	it('handles non-Error throws gracefully', async () => {
		const { handleRpc } = makeHandler({
			list: async () => {
				// eslint-disable-next-line no-throw-literal
				throw 'string error';
			},
		});
		const res = await handleRpc({ panelId: 'presets', command: 'presets.list' });
		assert.strictEqual(res.ok, false);
		assert.strictEqual(res.error.code, 'INTERNAL');
	});
});
