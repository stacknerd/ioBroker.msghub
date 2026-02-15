/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { createElement, createH, loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/messages/render.meta.js', function () {
	function createFixture() {
		let refreshCalls = 0;
		let deleteCalls = 0;
		let toggleCalls = 0;
		let firstCalls = 0;
		let prevCalls = 0;
		let nextCalls = 0;
		let lastCalls = 0;
		const pageSizes = [];
		const state = {
			expertMode: false,
			selectedRefs: new Set(),
			loading: false,
			silentLoading: false,
			autoRefresh: true,
			pages: 12,
			pageIndex: 2,
			pageSize: 50,
			tableColCount: 11,
		};
		return {
			state,
			options: {
				h: createH(),
				t: (key, ...args) => `${key}:${args.join('/')}`,
				state,
				onRefresh() {
					refreshCalls += 1;
				},
				onDelete() {
					deleteCalls += 1;
				},
					onToggleAuto() {
						toggleCalls += 1;
					},
					onFirstPage() {
						firstCalls += 1;
					},
					onPrevPage() {
						prevCalls += 1;
					},
					onNextPage() {
						nextCalls += 1;
					},
					onLastPage() {
						lastCalls += 1;
					},
					onPageSizeChanged(size) {
						pageSizes.push(size);
					},
			},
			get refreshCalls() {
				return refreshCalls;
			},
			get deleteCalls() {
				return deleteCalls;
			},
			get toggleCalls() {
				return toggleCalls;
			},
				get prevCalls() {
					return prevCalls;
				},
				get nextCalls() {
					return nextCalls;
				},
				get firstCalls() {
					return firstCalls;
				},
				get lastCalls() {
					return lastCalls;
				},
				pageSizes,
			};
		}

	it('mounts panel skeleton and wires action handlers', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/render.meta.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesRenderMeta;
		const fixture = createFixture();
		const renderer = moduleApi.createMetaRenderer(fixture.options);
		const root = createElement('div');

		renderer.mount(root);
		assert.equal(root.children.length, 6);
		assert.equal(root.children[0].classList.contains('msghub-toolbar'), true);
			assert.equal(renderer.elements.refreshBtn.classList.contains('msghub-uibutton-icon'), true);
			assert.equal(renderer.elements.refreshBtn.classList.contains('msghub-toolbarbutton-icon'), true);
			assert.equal(renderer.elements.firstBtn.classList.contains('msghub-uibutton-icon'), true);
			assert.equal(renderer.elements.prevBtn.classList.contains('msghub-uibutton-icon'), true);
			assert.equal(renderer.elements.nextBtn.classList.contains('msghub-uibutton-icon'), true);
			assert.equal(renderer.elements.lastBtn.classList.contains('msghub-uibutton-icon'), true);

			renderer.elements.refreshBtn.click();
			renderer.elements.deleteBtn.click();
			renderer.elements.autoBtn.click();
			renderer.elements.firstBtn.click();
			renderer.elements.prevBtn.click();
			renderer.elements.nextBtn.click();
			renderer.elements.lastBtn.click();
			renderer.elements.pageSizeSelect.dispatchEvent({
				type: 'change',
				target: { value: '25' },
		});

		assert.equal(fixture.refreshCalls, 1);
			assert.equal(fixture.deleteCalls, 1);
			assert.equal(fixture.toggleCalls, 1);
			assert.equal(fixture.firstCalls, 1);
			assert.equal(fixture.prevCalls, 1);
			assert.equal(fixture.nextCalls, 1);
			assert.equal(fixture.lastCalls, 1);
			assert.deepEqual(fixture.pageSizes, [25]);
	});

	it('updates paging, buttons, and delete state in normal and expert mode', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/render.meta.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesRenderMeta;
		const fixture = createFixture();
		const renderer = moduleApi.createMetaRenderer(fixture.options);

		renderer.updateDeleteButton();
		assert.equal(renderer.elements.deleteBtn.disabled, true);
		assert.equal(renderer.elements.deleteBtn.classList.contains('is-hidden'), true);

		fixture.state.expertMode = true;
		fixture.state.selectedRefs = new Set(['a', 'b']);
		fixture.state.loading = true;
		fixture.state.silentLoading = true;
		fixture.state.autoRefresh = false;
		renderer.updateButtons();
		assert.equal(renderer.elements.deleteBtn.disabled, false);
		assert.equal(
			renderer.elements.deleteBtn.textContent,
			'msghub.i18n.core.admin.ui.messages.toolbar.delete.action: (2)',
		);
		assert.equal(renderer.elements.refreshBtn.classList.contains('msghub-btn-loading'), true);
		assert.equal(renderer.elements.autoBtn.getAttribute('aria-checked'), 'false');

		fixture.state.pages = 3;
		fixture.state.pageIndex = 10;
		renderer.updatePaging();
		assert.equal(renderer.elements.firstBtn.classList.contains('is-hidden'), true);
		assert.equal(renderer.elements.firstBtn.disabled, true);
		assert.equal(renderer.elements.prevBtn.disabled, false);
		assert.equal(renderer.elements.nextBtn.disabled, true);
		assert.equal(renderer.elements.lastBtn.classList.contains('is-hidden'), true);
		assert.equal(renderer.elements.lastBtn.disabled, true);
		assert.equal(renderer.elements.pageSizeSelect.value, '50');
	});

	it('renders progress/error/meta/empty and tbody loading row', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/render.meta.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesRenderMeta;
		const fixture = createFixture();
		const renderer = moduleApi.createMetaRenderer(fixture.options);

		renderer.setProgressVisible(true);
		renderer.setError('boom');
		const mountedRoot = createElement('div');
		renderer.mount(mountedRoot);
		renderer.setMeta({
			generatedAtText: 'generatedAt: x',
			timeZone: 'Europe/Berlin',
			source: 'server',
		});
		renderer.setEmptyVisible(true);
		renderer.updateTbody([], { showLoadingRow: true });
		assert.equal(renderer.elements.tbodyEl.children.length, 1);
		assert.equal(mountedRoot.children[3].children.length, 1);
		assert.equal(mountedRoot.children[3].children[0].textContent, 'generatedAt: x');
		assert.equal(
			mountedRoot.children[3].title,
			'msghub.i18n.core.admin.ui.messages.meta.timeZone.label:: Europe/Berlin\n' +
				'msghub.i18n.core.admin.ui.messages.meta.source.label:: server',
		);

		const loadingRow = renderer.elements.tbodyEl.children[0].children[0];
		const loadingCell = loadingRow.children[0];
		assert.equal(loadingCell.getAttribute('colspan'), String(fixture.state.tableColCount));

		const row = createElement('tr');
		renderer.updateTbody([row], { showLoadingRow: false });
		assert.equal(renderer.elements.tbodyEl.children.length, 1);
		assert.equal(renderer.elements.tbodyEl.children[0].children[0], row);
	});
});
