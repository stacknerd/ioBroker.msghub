/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/messages/menus.js', function () {
	function setupMenus() {
		const openCalls = [];
		let closeCalls = 0;
		let queryChanged = 0;
		const state = {
			sortField: 'timing.createdAt',
			sortDir: 'desc',
			pageIndex: 3,
		};
		const filterStore = Object.create(null);
		const dataApi = {
			getFilterSet: key => filterStore[key] || null,
			setFilterSet: (key, set) => {
				filterStore[key] = set;
			},
			renderFilterValueLabel: (_key, value) => `label:${value}`,
		};
		const ui = {
			contextMenu: {
				open: payload => openCalls.push(payload),
				close: () => {
					closeCalls += 1;
				},
			},
		};
		const spies = {
			openCalls,
			get closeCalls() {
				return closeCalls;
			},
			get queryChanged() {
				return queryChanged;
			},
		};
		const options = {
			ui,
			t: key => key,
			state,
			dataApi,
			onQueryChanged: () => {
				queryChanged += 1;
			},
			openMessageJson() {},
			openArchiveOverlay() {},
			copyTextToClipboard() {},
			safeStr: value => (value == null ? '' : String(value)),
			pick: (obj, path) => path.split('.').reduce((cur, key) => (cur ? cur[key] : undefined), obj),
		};
		return { options, state, dataApi, spies };
	}

	it('applies sort selection and triggers reload', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, state, spies } = setupMenus();
		const menus = moduleApi.createMessagesMenus(options);

		menus.openHeaderSortMenu({}, { field: 'title' });
		assert.equal(spies.openCalls.length, 1);
		const sortItems = spies.openCalls[0].items;
		sortItems[0].onSelect();
		assert.equal(state.sortField, 'title');
		assert.equal(state.sortDir, 'asc');
		assert.equal(state.pageIndex, 1);
		assert.equal(spies.closeCalls, 1);
		assert.equal(spies.queryChanged, 1);
	});

	it('applies filter selections and supports select all/none', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, dataApi, spies } = setupMenus();
		const menus = moduleApi.createMessagesMenus(options);

		menus.openHeaderFilterMenu({}, { key: 'kind', options: ['task', 'alert'], autoOpenSubmenu: false });
		const rootItems = spies.openCalls[0].items;
		const submenu = rootItems[rootItems.length - 1];
		const checkboxItems = submenu.items.filter(item => item.type === 'checkbox');
		checkboxItems[0].onToggle(true);
		checkboxItems[1].onToggle(false);
		submenu.items.find(item => item.label === 'msghub.i18n.core.admin.ui.messages.filter.apply.action').onSelect();

		assert.deepEqual(Array.from(dataApi.getFilterSet('kind')), ['task']);
		assert.equal(spies.queryChanged, 1);
		assert.equal(spies.closeCalls, 1);
	});

	it('opens row context menu and enables archive action by feature gate', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		let openArchiveCalls = 0;
		let openJsonCalls = 0;
		let copied = '';
		options.openArchiveOverlay = () => {
			openArchiveCalls += 1;
		};
		options.openMessageJson = () => {
			openJsonCalls += 1;
		};
		options.copyTextToClipboard = text => {
			copied = text;
			return Promise.resolve();
		};
		options.isArchiveActionEnabled = () => true;
		const menus = moduleApi.createMessagesMenus(options);

		menus.openRowContextMenu({ clientX: 1, clientY: 2 }, { ref: 'r1', title: 'T', text: 'X' });
		const actions = spies.openCalls[0].items;
		const archiveItem = actions.find(item => item.id === 'openArchive');
		const jsonItem = actions.find(item => item.id === 'openJson');
		assert.equal(archiveItem.disabled, false);
		jsonItem.onSelect();
		archiveItem.onSelect();
		assert.equal(openJsonCalls, 1);
		assert.equal(openArchiveCalls, 1);

		const copySubmenu = actions.find(item => item.id === 'copy');
		copySubmenu.items.find(item => item.id === 'copyRef').onSelect();
		assert.equal(copied, 'r1');
	});

	it('opens JSON overlay context menu with the same copy actions as row copy submenu', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		const menus = moduleApi.createMessagesMenus(options);
		const msg = { ref: 'r1', title: 'T', text: 'X' };

		menus.openRowContextMenu({ clientX: 1, clientY: 2 }, msg);
		menus.openJsonOverlayContextMenu({ clientX: 3, clientY: 4, preventDefault() {} }, msg);

		const rowCopy = spies.openCalls[0].items.find(item => item.id === 'copy');
		const overlayCopy = spies.openCalls[1].items;

		assert.deepEqual(
			overlayCopy.map(item => item.id),
			rowCopy.items.map(item => item.id),
		);
		assert.equal(spies.openCalls[1].ariaLabel, 'Message copy actions');
	});

	it('shows ok toast after each copy action succeeds', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		const toasts = [];
		options.ui.toast = opts => toasts.push(opts);
		options.copyTextToClipboard = () => Promise.resolve();
		const menus = moduleApi.createMessagesMenus(options);

		menus.openRowContextMenu({ clientX: 1, clientY: 2 }, { ref: 'r1', title: 'T', text: 'X' });
		const copy = spies.openCalls[0].items.find(item => item.id === 'copy');

		await copy.items.find(item => item.id === 'copyJson').onSelect();
		await copy.items.find(item => item.id === 'copyRef').onSelect();
		await copy.items.find(item => item.id === 'copyTitle').onSelect();
		await copy.items.find(item => item.id === 'copyText').onSelect();

		assert.equal(toasts.length, 4);
		assert.ok(
			toasts.every(t => t.variant === 'ok'),
			'all toasts are ok variant',
		);
		assert.ok(toasts[0].text.includes('copyJson.toast'), 'copyJson toast key');
		assert.ok(toasts[1].text.includes('copyRef.toast'), 'copyRef toast key');
		assert.ok(toasts[2].text.includes('copyTitle.toast'), 'copyTitle toast key');
		assert.ok(toasts[3].text.includes('copyText.toast'), 'copyText toast key');
	});

	it('actions submenu is present in row context menu', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		const menus = moduleApi.createMessagesMenus(options);

		menus.openRowContextMenu({ clientX: 1, clientY: 2 }, { ref: 'r1' });

		const items = spies.openCalls[0].items;
		const actionsItem = items.find(item => item.id === 'actions');
		assert.ok(actionsItem, 'actions submenu item must be present');
		assert.ok(actionsItem.label.includes('actions.label'), 'label must use i18n key');
	});

	it('actions submenu is disabled when msg.actions has no core-type items', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		const menus = moduleApi.createMessagesMenus(options);

		menus.openRowContextMenu({ clientX: 1, clientY: 2 }, { ref: 'r1', actions: [] });
		const emptyItem = spies.openCalls[0].items.find(item => item.id === 'actions');
		assert.equal(emptyItem.disabled, true, 'disabled when actions is empty');

		spies.openCalls.length = 0;
		menus.openRowContextMenu(
			{ clientX: 1, clientY: 2 },
			{ ref: 'r1', actions: [{ id: 'open-1', type: 'open' }, { id: 'link-1', type: 'link' }] },
		);
		const nonCoreItem = spies.openCalls[0].items.find(item => item.id === 'actions');
		assert.equal(nonCoreItem.disabled, true, 'disabled when only non-core types present');
	});

	it('actions submenu is enabled when msg.actions has at least one core-type item', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		const menus = moduleApi.createMessagesMenus(options);

		menus.openRowContextMenu(
			{ clientX: 1, clientY: 2 },
			{ ref: 'r1', actions: [{ id: 'ack-1', type: 'ack' }, { id: 'open-1', type: 'open' }] },
		);

		const actionsItem = spies.openCalls[0].items.find(item => item.id === 'actions');
		assert.equal(actionsItem.disabled, false, 'enabled when at least one core-type action');
		assert.equal(actionsItem.items.length, 1, 'only the core-type item appears in submenu');
		assert.equal(actionsItem.items[0].id, 'action-ack-1');
		assert.ok(actionsItem.items[0].label.includes('action.ack.label'), 'core action label must use common action label key');
	});

	it('selecting actions submenu item calls onActionExecute with correct args', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		const executeCalls = [];
		options.onActionExecute = (ref, actionId, actionType) => executeCalls.push({ ref, actionId, actionType });
		const menus = moduleApi.createMessagesMenus(options);

		menus.openRowContextMenu(
			{ clientX: 1, clientY: 2 },
			{ ref: 'r1', actions: [{ id: 'close-1', type: 'close' }] },
		);

		const actionsItem = spies.openCalls[0].items.find(item => item.id === 'actions');
		actionsItem.items[0].onSelect();

		assert.equal(executeCalls.length, 1);
		assert.equal(executeCalls[0].ref, 'r1');
		assert.equal(executeCalls[0].actionId, 'close-1');
		assert.equal(executeCalls[0].actionType, 'close');
	});

	it('actions submenu item onSelect is undefined when onActionExecute not provided', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		// onActionExecute intentionally omitted
		const menus = moduleApi.createMessagesMenus(options);

		menus.openRowContextMenu(
			{ clientX: 1, clientY: 2 },
			{ ref: 'r1', actions: [{ id: 'snooze-1', type: 'snooze' }] },
		);

		const actionsItem = spies.openCalls[0].items.find(item => item.id === 'actions');
		assert.equal(actionsItem.items[0].onSelect, undefined, 'no-op when callback not provided');
	});

	it('link item appears in actions submenu for link action with valid https URL', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		const linkOpenCalls = [];
		options.onLinkOpen = url => linkOpenCalls.push(url);
		const menus = moduleApi.createMessagesMenus(options);

		menus.openRowContextMenu(
			{ clientX: 1, clientY: 2 },
			{ ref: 'r1', actions: [{ id: 'link-1', type: 'link', payload: { url: 'https://example.com' } }] },
		);

		const actionsItem = spies.openCalls[0].items.find(item => item.id === 'actions');
		assert.equal(actionsItem.disabled, false, 'actions submenu enabled for link action');
		assert.equal(actionsItem.items.length, 1);
		assert.equal(actionsItem.items[0].id, 'link-link-1');

		actionsItem.items[0].onSelect();
		assert.equal(linkOpenCalls.length, 1);
		assert.equal(linkOpenCalls[0], 'https://example.com');
	});

	it('actions submenu is disabled when link action has no valid URL', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		options.onLinkOpen = () => undefined;
		const menus = moduleApi.createMessagesMenus(options);

		menus.openRowContextMenu(
			{ clientX: 1, clientY: 2 },
			{
				ref: 'r1',
				actions: [
					{ id: 'link-1', type: 'link', payload: { url: 'ftp://files.example.com' } },
					{ id: 'link-2', type: 'link' },
				],
			},
		);

		const actionsItem = spies.openCalls[0].items.find(item => item.id === 'actions');
		assert.equal(actionsItem.disabled, true, 'disabled when link URL is not http/https or missing');
		assert.equal(actionsItem.items.length, 0);
	});

	it('actions submenu enabled with both core and link actions; link item uses common action link label', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		const executeCalls = [];
		const linkOpenCalls = [];
		options.onActionExecute = (ref, actionId, actionType) => executeCalls.push({ ref, actionId, actionType });
		options.onLinkOpen = url => linkOpenCalls.push(url);
		const menus = moduleApi.createMessagesMenus(options);

		menus.openRowContextMenu(
			{ clientX: 1, clientY: 2 },
			{
				ref: 'r1',
				actions: [
					{ id: 'ack-1', type: 'ack' },
					{ id: 'link-1', type: 'link', payload: { href: 'http://example.com/page' } },
				],
			},
		);

		const actionsItem = spies.openCalls[0].items.find(item => item.id === 'actions');
		assert.equal(actionsItem.disabled, false);
		assert.equal(actionsItem.items.length, 2);
		assert.equal(actionsItem.items[0].id, 'action-ack-1');
		assert.equal(actionsItem.items[1].id, 'link-link-1');
		assert.ok(
			actionsItem.items[1].label.includes('action.link.label'),
			'link item must use common action link label key',
		);

		actionsItem.items[0].onSelect();
		assert.equal(executeCalls.length, 1);
		assert.equal(executeCalls[0].actionType, 'ack');

		actionsItem.items[1].onSelect();
		assert.equal(linkOpenCalls.length, 1);
		assert.equal(linkOpenCalls[0], 'http://example.com/page');
	});

	it('link submenu item uses payload.label when present, falling back to i18n key when absent', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		options.onLinkOpen = () => undefined;
		const menus = moduleApi.createMessagesMenus(options);

		// payload.label present — must use it as menu item label.
		menus.openRowContextMenu(
			{ clientX: 1, clientY: 2 },
			{
				ref: 'r1',
				actions: [
					{ id: 'link-1', type: 'link', payload: { url: 'https://example.com', label: 'runbook #42' } },
				],
			},
		);
		let actionsItem = spies.openCalls[0].items.find(item => item.id === 'actions');
		assert.equal(actionsItem.items[0].label, 'runbook #42', 'payload.label must be used as menu item label');

		// payload.label absent — must fall back to i18n key.
		spies.openCalls.length = 0;
		menus.openRowContextMenu(
			{ clientX: 1, clientY: 2 },
			{
				ref: 'r1',
				actions: [{ id: 'link-2', type: 'link', payload: { url: 'https://example.com' } }],
			},
		);
		actionsItem = spies.openCalls[0].items.find(item => item.id === 'actions');
		assert.ok(
			actionsItem.items[0].label.includes('action.link.label'),
			'i18n fallback used when payload.label is absent',
		);
	});

	it('link action onSelect is undefined when onLinkOpen not provided', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/menus.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesMenus;
		const { options, spies } = setupMenus();
		// onLinkOpen intentionally omitted
		const menus = moduleApi.createMessagesMenus(options);

		menus.openRowContextMenu(
			{ clientX: 1, clientY: 2 },
			{ ref: 'r1', actions: [{ id: 'link-1', type: 'link', payload: { url: 'https://example.com' } }] },
		);

		const actionsItem = spies.openCalls[0].items.find(item => item.id === 'actions');
		assert.equal(actionsItem.disabled, false, 'submenu still enabled even without onLinkOpen handler');
		assert.equal(actionsItem.items.length, 1);
		assert.equal(actionsItem.items[0].onSelect, undefined, 'onSelect is undefined when onLinkOpen not provided');
	});
});
