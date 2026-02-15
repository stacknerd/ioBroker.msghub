/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { readRepoFile } = require('../../_test.utils');
const { loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/messages/overlay.json.js', function () {
	it('opens JSON overlay and reuses lazy body element', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		const openCalls = [];

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => openCalls.push(payload),
					isOpen: () => true,
				},
			},
			getServerTimeZone: () => 'Europe/Berlin',
			getLevelLabel: value => (Number(value) === 3 ? 'HIGH' : String(value)),
		});

		overlay.openMessageJson({
			level: 3,
			timing: { createdAt: 1700000000000, processMs: 1500 },
			nested: { n: 5 },
		});
		overlay.openMessageJson({ level: 1, text: 'hello' });

		assert.equal(openCalls.length, 2);
		assert.equal(openCalls[0].title, 'Message JSON');
		assert.equal(openCalls[0].bodyEl, openCalls[1].bodyEl, 'overlay body should be lazily cached');
	});

	it('falls back to plain stringify when renderer fails', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
		});

		const cyclic = {};
		cyclic.self = cyclic;
		overlay.openMessageJson(cyclic);
		assert.equal(openPayload.title, 'Message JSON');
		assert.ok(String(openPayload.bodyEl.textContent).length > 0);
	});

	it('does not contain hover tooltip logic anymore', async function () {
		const source = await readRepoFile('admin/tab/panels/messages/overlay.json.js');
		assert.doesNotMatch(source, /toLocaleString\(/);
		assert.doesNotMatch(source, /addEventListener\(\s*['"]mousemove['"]/);
		assert.doesNotMatch(source, /requestAnimationFrame\(/);
	});
});
