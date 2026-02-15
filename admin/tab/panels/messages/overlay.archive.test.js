/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/messages/overlay.archive.js', function () {
	it('opens overlay with default timeline shell', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.archive.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayArchive;
		const openCalls = [];
		const overlay = moduleApi.createArchiveOverlay({
			ui: {
				overlayLarge: {
					open: payload => openCalls.push(payload),
				},
			},
			t: key => `i18n:${key}`,
		});

		overlay.openArchiveOverlay('ref.abc');
		assert.equal(openCalls.length, 1);
		assert.equal(openCalls[0].title, 'Message Archive');
		assert.equal(typeof openCalls[0].bodyEl, 'object');
	});

	it('renders empty and populated archive views', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.archive.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayArchive;
		const overlay = moduleApi.createArchiveOverlay({
			ui: { overlayLarge: { open() {} } },
			t: key => `i18n:${key}`,
		});

		overlay.openArchiveOverlay('ref.x');
		overlay.renderArchiveView({
			ref: 'ref.x',
			mode: 'browse',
			pendingNewCount: 3,
			hasMoreBackward: true,
			hasMoreForward: true,
			items: [{ ts: 1700000000000, event: 'update' }],
		});

		overlay.renderArchiveView({
			ref: '',
			items: [],
		});
	});

	it('resets overlay cache safely', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.archive.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayArchive;
		const overlay = moduleApi.createArchiveOverlay({ ui: { overlayLarge: { open() {} } }, t: key => key });

		overlay.openArchiveOverlay('ref.reset');
		overlay.resetArchiveOverlay();
		overlay.resetArchiveOverlay();
	});
});
