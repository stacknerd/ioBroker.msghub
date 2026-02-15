/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/messages/data.archive.js', function () {
	it('normalizes cursor edges and response payload', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/data.archive.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesDataArchive;

		assert.deepEqual(
			JSON.parse(JSON.stringify(moduleApi.normalizeCursorEdge({ ts: '1700000000001', tie: 5 }))),
			{ ts: 1700000000001, tie: '5' },
		);
		assert.equal(moduleApi.normalizeCursorEdge({ ts: 'nope', tie: 'x' }), null);
		assert.equal(moduleApi.normalizeCursorEdge(null), null);
	});

	it('uses archive.page when available and normalizes items', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/data.archive.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesDataArchive;
		let payloadSeen = null;
		const api = {
			archive: {
				page: async payload => {
					payloadSeen = payload;
					return {
						ok: true,
						data: {
							items: [{ ts: '1700000000001', event: 'create', __cursor: { ts: '1700000000001', tie: 7 } }],
							hasMoreBackward: true,
							hasMoreForward: false,
							edgeOldest: { ts: '1700000000000', tie: 'a' },
							edgeNewest: { ts: 1700000000001, tie: 'b' },
						},
					};
				},
			},
		};
		const dataApi = moduleApi.createArchiveDataApi({ api });
		const res = await dataApi.pageArchive({
			ref: 'ref.1',
			direction: 'forward',
			before: { ts: '1700000000000', tie: 1 },
			after: { ts: 1700000000001, tie: 'b' },
			limit: 200.9,
			includeRaw: true,
		});

		assert.equal(payloadSeen.ref, 'ref.1');
		assert.equal(payloadSeen.direction, 'forward');
		assert.deepEqual(JSON.parse(JSON.stringify(payloadSeen.before)), { ts: 1700000000000, tie: '1' });
		assert.deepEqual(JSON.parse(JSON.stringify(payloadSeen.after)), { ts: 1700000000001, tie: 'b' });
		assert.equal(payloadSeen.limit, 200);
		assert.equal(payloadSeen.includeRaw, true);
		assert.equal(res.ok, true);
		assert.equal(res.data.items[0].ts, 1700000000001);
		assert.deepEqual(JSON.parse(JSON.stringify(res.data.items[0].__cursor)), { ts: 1700000000001, tie: '7' });
		assert.deepEqual(JSON.parse(JSON.stringify(res.data.edgeOldest)), { ts: 1700000000000, tie: 'a' });
	});

	it('falls back to messages.archivePage and throws when unsupported', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/data.archive.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesDataArchive;

		let called = false;
		const fallbackApi = moduleApi.createArchiveDataApi({
			api: {
				messages: {
					archivePage: async () => {
						called = true;
						return { ok: false, error: { code: 'E', message: 'x' } };
					},
				},
			},
		});
		const res = await fallbackApi.pageArchive({ ref: 'r' });
		assert.equal(called, true);
		assert.equal(res.ok, false);
		assert.deepEqual(res.error, { code: 'E', message: 'x' });

		let notSupportedMethod = '';
		const unsupportedApi = moduleApi.createArchiveDataApi({
			api: {
				notSupported(method) {
					notSupportedMethod = method;
				},
			},
		});
		await assert.rejects(() => unsupportedApi.pageArchive({ ref: 'r' }), /Archive paging API is not available/);
		assert.equal(notSupportedMethod, 'messages.archive.page');
	});
});
