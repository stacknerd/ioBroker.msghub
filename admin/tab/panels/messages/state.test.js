/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/messages/state.js', function () {
	it('exposes state factory and utility helpers', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/state.js');
		const api = sandbox.window.MsghubAdminTabMessagesState;

		assert.equal(typeof api.createMessagesState, 'function');
		assert.equal(api.isObject({ a: 1 }), true);
		assert.equal(api.isObject([]), false);
		assert.equal(api.safeStr(null), '');
		assert.equal(api.safeStr(7), '7');
		assert.equal(api.pick({ a: { b: 2 } }, 'a.b'), 2);
		assert.equal(api.pick({ a: 1 }, 'a.b'), undefined);
		assert.equal(api.formatTs(NaN), '');
		assert.notEqual(api.formatTs(1700000000000), '');
	});

	it('initializes canonical defaults including archive-ready state', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/state.js');
		const api = sandbox.window.MsghubAdminTabMessagesState;
		const state = api.createMessagesState();

		assert.equal(state.autoRefreshMs, 15000);
		assert.equal(state.sortField, 'timing.createdAt');
		assert.equal(state.sortDir, 'desc');
		assert.equal(state.archiveMode, 'follow');
		assert.equal(state.archivePendingNewCount, 0);
		assert.equal(Object.prototype.toString.call(state.archiveItemsByRef), '[object Map]');
		assert.deepEqual(Array.from(state.columnFilters['lifecycle.state']), ['acked', 'closed', 'open', 'snoozed']);
	});

	it('detects expert mode from sessionStorage and system fallback', async function () {
		const storage = {
			getItem: key => (String(key) === 'App.expertMode' ? 'true' : null),
		};
		const sandboxA = await loadPanelModule('admin/tab/panels/messages/state.js', {
			window: { window: null, sessionStorage: storage, top: {}, setTimeout() {}, setInterval() {} },
		});
		sandboxA.window.window = sandboxA.window;
		assert.equal(sandboxA.window.MsghubAdminTabMessagesState.detectExpertMode(), true);

		const sandboxB = await loadPanelModule('admin/tab/panels/messages/state.js', {
			window: { window: null, top: { _system: { expertMode: true } }, setTimeout() {}, setInterval() {} },
		});
		sandboxB.window.window = sandboxB.window;
		assert.equal(sandboxB.window.MsghubAdminTabMessagesState.detectExpertMode(), true);
	});
});
