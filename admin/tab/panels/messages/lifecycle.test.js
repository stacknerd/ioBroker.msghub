/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/messages/lifecycle.js', function () {
	async function loadLifecycleWithTimers() {
		const timers = [];
		const cleared = [];
		const windowObject = {
			window: null,
			top: {},
			setTimeout(fn, delay) {
				timers.push({ fn, delay });
				return timers.length;
			},
			clearTimeout(id) {
				cleared.push(id);
			},
			setInterval() {
				return 1;
			},
			clearInterval() {},
		};
		windowObject.window = windowObject;
		const CustomEvent = class {
			constructor(type, init = {}) {
				this.type = type;
				this.detail = init.detail || {};
			}
		};
		const sandbox = await loadPanelModule('admin/tab/panels/messages/lifecycle.js', {
			window: windowObject,
			setTimeout: windowObject.setTimeout,
			clearTimeout: windowObject.clearTimeout,
			CustomEvent,
		});
		return { sandbox, timers, cleared, CustomEvent };
	}

	it('schedules and executes auto cycle in follow and browse mode', async function () {
		const { sandbox, timers } = await loadLifecycleWithTimers();
		const moduleApi = sandbox.window.MsghubAdminTabMessagesLifecycle;
		let followCalls = 0;
		let browseCalls = 0;
		const root = {
			closest() {
				return { offsetParent: {} };
			},
		};
		const state = {
			autoRefresh: true,
			autoRefreshMs: 1000,
			autoTimer: null,
			archiveMode: 'follow',
		};
		const lifecycle = moduleApi.createLifecycle({
			state,
			root,
			ui: {
				contextMenu: { isOpen: () => false },
				overlayLarge: { isOpen: () => false },
			},
			onRefreshFollow: async () => {
				followCalls += 1;
			},
			onRefreshBrowsePending: async () => {
				browseCalls += 1;
			},
		});

		lifecycle.scheduleAuto();
		assert.equal(timers.length, 1);
		assert.ok(timers[0].delay >= 1000);

		timers[0].fn();
		assert.equal(followCalls, 1);

		state.archiveMode = 'browse';
		timers[1].fn();
		assert.equal(browseCalls, 1);
	});

	it('blocks auto refresh when tab hidden or overlays are open', async function () {
		const { sandbox } = await loadLifecycleWithTimers();
		const moduleApi = sandbox.window.MsghubAdminTabMessagesLifecycle;
		const state = {
			autoRefresh: true,
			autoRefreshMs: 1000,
			autoTimer: null,
			archiveMode: 'follow',
		};
		const root = {
			closest() {
				return { offsetParent: null };
			},
		};
		const lifecycle = moduleApi.createLifecycle({
			state,
			root,
			ui: {
				contextMenu: { isOpen: () => true },
				overlayLarge: { isOpen: () => false },
			},
		});

		assert.equal(lifecycle.canAutoRefresh(), false);
	});

	it('binds visibility/tab-switch handlers and unbinds safely', async function () {
		const { sandbox, cleared, CustomEvent } = await loadLifecycleWithTimers();
		const moduleApi = sandbox.window.MsghubAdminTabMessagesLifecycle;
		let followCalls = 0;
		const root = {
			closest() {
				return { offsetParent: {} };
			},
		};
		const state = {
			autoRefresh: true,
			autoRefreshMs: 1000,
			autoTimer: 99,
			archiveMode: 'follow',
		};
		const lifecycle = moduleApi.createLifecycle({
			state,
			root,
			ui: {
				contextMenu: { isOpen: () => false },
				overlayLarge: { isOpen: () => false },
			},
			onRefreshFollow: async () => {
				followCalls += 1;
			},
		});

		lifecycle.bindEvents();
		sandbox.document.dispatchEvent({ type: 'visibilitychange' });
		sandbox.document.dispatchEvent(
			new CustomEvent('msghub:tabSwitch', { detail: { from: 'x', to: 'tab-messages' } }),
		);
		assert.ok(followCalls >= 2);

		lifecycle.unbindEvents();
		assert.equal(cleared.includes(99), true);
		lifecycle.unbindEvents();
	});
});
