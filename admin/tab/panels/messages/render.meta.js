/* global window, document */
(function () {
	'use strict';

	const win = window;
	void win;

	/**
	 * Messages meta/layout renderer module.
	 *
	 * Contains:
	 * - Actions and paging controls.
	 * - Table shell (colgroup/thead/tbody).
	 * - Loading/error/meta/empty state rendering.
	 *
	 * Integration:
	 * - Provides DOM nodes for header/table renderers.
	 * - Receives callbacks from `index.js` for user actions.
	 */

	/**
	 * Creates the panel view/controller for non-row rendering parts.
	 *
	 * @param {object} options - Factory options.
	 * @param {Function} options.h - DOM helper.
	 * @param {Function} options.t - Translation helper.
	 * @param {object} options.state - Shared state.
	 * @param {Function} options.onRefresh - Refresh button callback.
	 * @param {Function} options.onDelete - Delete button callback.
	 * @param {Function} options.onToggleAuto - Auto toggle callback.
	 * @param {Function} options.onPrevPage - Previous page callback.
	 * @param {Function} options.onNextPage - Next page callback.
	 * @param {Function} options.onPageSizeChanged - Page size callback.
	 * @returns {object} View facade and DOM handles.
	 */
	function createMetaRenderer(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const h = opts.h;
		const t = opts.t;
		const state = opts.state;

		const onRefresh = typeof opts.onRefresh === 'function' ? opts.onRefresh : () => undefined;
		const onDelete = typeof opts.onDelete === 'function' ? opts.onDelete : () => undefined;
		const onToggleAuto = typeof opts.onToggleAuto === 'function' ? opts.onToggleAuto : () => undefined;
		const onPrevPage = typeof opts.onPrevPage === 'function' ? opts.onPrevPage : () => undefined;
		const onNextPage = typeof opts.onNextPage === 'function' ? opts.onNextPage : () => undefined;
		const onPageSizeChanged =
			typeof opts.onPageSizeChanged === 'function' ? opts.onPageSizeChanged : () => undefined;

		const actions = h('div', { class: 'msghub-toolbar__group' });
		const refreshBtn = h('button', {
			class: 'msghub-uibutton-text msghub-toolbarbutton-text',
			type: 'button',
			text: 'Refresh',
		});
		const deleteBtn = h('button', {
			class: 'msghub-uibutton-text msghub-toolbarbutton-text msghub-toolbarbutton-danger',
			type: 'button',
			text: 'Delete',
		});
		const autoBtn = h('button', {
			class: 'msghub-uibutton-text msghub-toolbarbutton-text',
			type: 'button',
			text: 'Auto: on',
		});
		actions.appendChild(refreshBtn);
		actions.appendChild(deleteBtn);
		actions.appendChild(autoBtn);

		const sizeOptions = [10, 25, 50, 100, 250];
		const prevBtn = h('button', {
			class: 'msghub-uibutton-text msghub-toolbarbutton-text',
			type: 'button',
			text: 'Prev',
		});
		const nextBtn = h('button', {
			class: 'msghub-uibutton-text msghub-toolbarbutton-text',
			type: 'button',
			text: 'Next',
		});
		const pageInfoEl = h('div', {
			class: 'msghub-muted',
			text: t('msghub.i18n.core.admin.ui.pagination.pageOf.text', 1, 1),
		});
		const pageSizeSelect = h(
			'select',
			{
				onchange: e => {
					const n = Number(e?.target?.value);
					const nextSize = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 50;
					onPageSizeChanged(nextSize);
				},
			},
			sizeOptions.map(n => h('option', { value: String(n), text: String(n) })),
		);

		const paging = h('div', { class: 'msghub-toolbar__group msghub-messages-paging' }, [
			prevBtn,
			pageInfoEl,
			nextBtn,
			h('div', { class: 'msghub-field msghub-messages-pagesize' }, [
				h('label', { class: 'msghub-muted', text: 'Items / page' }),
				pageSizeSelect,
			]),
		]);

		const countMetaEl = h('div', {
			class: 'msghub-toolbar__meta',
			text: 'messages: 0 / 0',
		});
		const head = h('div', { class: 'msghub-toolbar msghub-messages-head' }, [actions, paging, countMetaEl]);
		const progress = h(
			'div',
			{ class: 'msghub-progress is-hidden' },
			h('div', { class: 'msghub-muted', text: t('msghub.i18n.core.admin.ui.loading.text') }),
		);
		const errorEl = h('div', { class: 'msghub-error is-hidden' });
		const metaEl = h('div', { class: 'msghub-muted msghub-messages-meta' });
		const emptyEl = h('div', {
			class: 'msghub-muted is-hidden',
			text: t('msghub.i18n.core.admin.ui.messages.empty.text'),
		});

		const tableWrap = h('div', { class: 'msghub-table-wrap' });
		const tableEl = h('table', { class: 'msghub-table' });
		const colgroupEl = h('colgroup');
		const theadEl = h('thead');
		const tbodyEl = h('tbody');
		tableEl.appendChild(colgroupEl);
		tableEl.appendChild(theadEl);
		tableEl.appendChild(tbodyEl);
		tableWrap.appendChild(tableEl);

		refreshBtn.addEventListener('click', e => {
			e.preventDefault();
			onRefresh();
		});
		deleteBtn.addEventListener('click', e => {
			e.preventDefault();
			onDelete();
		});
		autoBtn.addEventListener('click', e => {
			e.preventDefault();
			onToggleAuto();
		});
		prevBtn.addEventListener('click', e => {
			e.preventDefault();
			onPrevPage();
		});
		nextBtn.addEventListener('click', e => {
			e.preventDefault();
			onNextPage();
		});

		/**
		 * Mounts static panel structure into root element.
		 *
		 * @param {HTMLElement} root - Messages root element.
		 */
		function mount(root) {
			root.replaceChildren(head, progress, errorEl, metaEl, tableWrap, emptyEl);
		}

		/**
		 * Updates delete button visibility and disabled state.
		 */
		function updateDeleteButton() {
			deleteBtn.classList.toggle('is-hidden', !state.expertMode);
			if (!state.expertMode) {
				deleteBtn.disabled = true;
				deleteBtn.textContent = 'Delete';
				return;
			}
			const count = state.selectedRefs.size;
			deleteBtn.textContent = count > 0 ? `Delete (${count})` : 'Delete';
			deleteBtn.disabled = count === 0 || (state.loading && !state.silentLoading);
		}

		/**
		 * Updates paging controls.
		 */
		function updatePaging() {
			const pages = state.pages || 1;
			const idx = Math.min(Math.max(1, state.pageIndex), pages);
			pageInfoEl.textContent = t('msghub.i18n.core.admin.ui.pagination.pageOf.text', idx, pages);
			prevBtn.disabled = idx <= 1;
			nextBtn.disabled = idx >= pages;
			pageSizeSelect.value = String(state.pageSize);
		}

		/**
		 * Updates global action buttons.
		 */
		function updateButtons() {
			refreshBtn.disabled = state.loading && !state.silentLoading;
			refreshBtn.classList.toggle('msghub-btn-loading', state.loading && state.silentLoading);
			autoBtn.textContent = state.autoRefresh ? 'Auto: on' : 'Auto: off';
			updateDeleteButton();
		}

		/**
		 * Toggles progress visibility.
		 *
		 * @param {boolean} isVisible - Whether loading indicator is visible.
		 */
		function setProgressVisible(isVisible) {
			progress.classList.toggle('is-hidden', !isVisible);
		}

		/**
		 * Renders error message state.
		 *
		 * @param {string|null} error - Error message.
		 */
		function setError(error) {
			errorEl.textContent = error ? String(error) : '';
			errorEl.classList.toggle('is-hidden', !error);
		}

		/**
		 * Renders meta information rows.
		 *
		 * @param {string} generatedAtText - Generated-at text.
		 * @param {string} tzText - Timezone text.
		 * @param {string} countText - Count text.
		 */
		function setMeta(generatedAtText, tzText, countText) {
			countMetaEl.textContent = countText;
			metaEl.replaceChildren(h('div', { text: generatedAtText }), h('div', { text: tzText }));
		}

		/**
		 * Toggles empty state visibility.
		 *
		 * @param {boolean} visible - Empty state visibility.
		 */
		function setEmptyVisible(visible) {
			emptyEl.classList.toggle('is-hidden', !visible);
		}

		/**
		 * Replaces tbody rows.
		 *
		 * @param {HTMLElement[]} rows - Rendered rows.
		 * @param {object} [optionsArg] - Rendering options.
		 * @param {boolean} [optionsArg.showLoadingRow] - Whether to render loading row.
		 */
		function updateTbody(rows, optionsArg = {}) {
			const showLoadingRow = optionsArg.showLoadingRow === true;
			const fragment = document.createDocumentFragment();
			if (showLoadingRow) {
				fragment.appendChild(
					h('tr', null, [
						h('td', {
							class: 'msghub-muted',
							text: t('msghub.i18n.core.admin.ui.loading.text'),
							colspan: String(state.tableColCount),
						}),
					]),
				);
			} else {
				for (const row of rows || []) {
					fragment.appendChild(row);
				}
			}
			tbodyEl.replaceChildren(fragment);
		}

		return Object.freeze({
			mount,
			updateDeleteButton,
			updatePaging,
			updateButtons,
			setProgressVisible,
			setError,
			setMeta,
			setEmptyVisible,
			updateTbody,
			elements: Object.freeze({
				refreshBtn,
				deleteBtn,
				autoBtn,
				prevBtn,
				nextBtn,
				pageInfoEl,
				pageSizeSelect,
				tableEl,
				colgroupEl,
				theadEl,
				tbodyEl,
			}),
		});
	}

	win.MsghubAdminTabMessagesRenderMeta = Object.freeze({
		createMetaRenderer,
	});
})();
