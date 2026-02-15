/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { createElement, createH, loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/messages/render.header.js', function () {
	function findAll(node, predicate, out = []) {
		if (!node || typeof node !== 'object') {
			return out;
		}
		if (predicate(node)) {
			out.push(node);
		}
		for (const child of node.children || []) {
			findAll(child, predicate, out);
		}
		return out;
	}

	function setup({ expertMode = false } = {}) {
		const colgroupEl = createElement('colgroup');
		const theadEl = createElement('thead');
		const tbodyEl = createElement('tbody');
		const state = {
			expertMode,
			tableColCount: 0,
			sortField: 'timing.createdAt',
			sortDir: 'desc',
			selectedRefs: new Set(),
			headerSelectAllInput: null,
		};
		const filterStore = Object.create(null);
		const dataApi = {
			listDistinctFromItems: () => ['a', 'b'],
			listEnumValues: () => ['x', 'y'],
			listEnumKeys: () => ['LOW', 'HIGH'],
			getConstantsEnum: () => ({}),
			getFilterSet: key => filterStore[key] || null,
		};
		const sortCalls = [];
		const filterCalls = [];
		let selectionChangedCalls = 0;
		const menusApi = {
			openHeaderSortMenu(anchor, payload) {
				sortCalls.push({ anchor, payload });
			},
			openHeaderFilterMenu(anchor, payload) {
				filterCalls.push({ anchor, payload });
			},
		};
		const rendererOptions = {
			h: createH(),
			t: key => key,
			state,
			dataApi,
			menusApi,
			colgroupEl,
			theadEl,
			tbodyEl,
			onSelectionChanged() {
				selectionChangedCalls += 1;
			},
		};
		return {
			rendererOptions,
			state,
			dataApi,
			colgroupEl,
			theadEl,
			tbodyEl,
			sortCalls,
			filterCalls,
			get selectionChangedCalls() {
				return selectionChangedCalls;
			},
			filterStore,
		};
	}

	it('renders header layout and opens sort/filter menus', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/render.header.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesRenderHeader;
		const fixture = setup();
		const renderer = moduleApi.createHeaderRenderer(fixture.rendererOptions);

		renderer.renderThead();
		assert.equal(fixture.state.tableColCount, 11);
		assert.equal(fixture.colgroupEl.children.length, 11);

		const buttons = findAll(
			fixture.theadEl,
			node => node.tagName === 'BUTTON' && String(node.className).includes('msghub-thBtn'),
		);
		buttons[0].dispatchEvent({ type: 'click', preventDefault() {} });
		assert.equal(fixture.sortCalls.length, 1);
		assert.equal(fixture.sortCalls[0].payload.field, 'icon');

		const filterBtn = buttons.find(btn => String(btn.className).includes('msghub-thBtn--filter'));
		filterBtn.dispatchEvent({ type: 'click', preventDefault() {} });
		assert.equal(fixture.filterCalls.length, 1);
		assert.equal(fixture.filterCalls[0].payload.key, 'details.location');
	});

	it('updates filter badges and sort direction markers', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/render.header.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesRenderHeader;
		const fixture = setup();
		const renderer = moduleApi.createHeaderRenderer(fixture.rendererOptions);

		fixture.filterStore.kind = new Set(['task']);
		fixture.filterStore['origin.system'] = new Set(['sys.a', 'sys.b']);
		fixture.filterStore.level = new Set();
		fixture.state.sortField = 'origin.system';
		fixture.state.sortDir = 'asc';

		renderer.renderThead();
		renderer.updateHeaderButtons();

		const filterButtons = findAll(
			fixture.theadEl,
			node => node.tagName === 'BUTTON' && String(node.className).includes('msghub-thBtn--filter'),
		);
		const activeWithCount = filterButtons.filter(btn => !!btn.getAttribute('data-filter-count'));
		assert.equal(activeWithCount.length, 2);
		assert.equal(activeWithCount.some(btn => btn.getAttribute('data-sort-dir') === 'asc'), true);
	});

	it('supports expert select-all toggle', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/render.header.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesRenderHeader;
		const fixture = setup({ expertMode: true });
		const rowA = createElement('tr');
		rowA.setAttribute('data-ref', 'a');
		const rowB = createElement('tr');
		rowB.setAttribute('data-ref', 'b');
		fixture.tbodyEl.querySelectorAll = () => [rowA, rowB];
		fixture.state.selectedRefs = new Set(['a']);
		const renderer = moduleApi.createHeaderRenderer(fixture.rendererOptions);

		renderer.renderThead();
		assert.equal(fixture.state.tableColCount, 12);
		assert.equal(fixture.colgroupEl.children.length, 12);
		assert.equal(typeof fixture.state.headerSelectAllInput.dispatchEvent, 'function');

		fixture.state.headerSelectAllInput.dispatchEvent({ type: 'change', preventDefault() {} });
		assert.deepEqual(Array.from(fixture.state.selectedRefs).sort(), ['a', 'b']);
		assert.equal(fixture.selectionChangedCalls, 1);
	});
});
