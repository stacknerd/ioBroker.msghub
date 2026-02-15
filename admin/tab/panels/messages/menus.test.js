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
});
