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
	 * @param {Function} options.onFirstPage - First page callback.
	 * @param {Function} options.onPrevPage - Previous page callback.
	 * @param {Function} options.onNextPage - Next page callback.
	 * @param {Function} options.onLastPage - Last page callback.
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
		const onFirstPage = typeof opts.onFirstPage === 'function' ? opts.onFirstPage : () => undefined;
		const onPrevPage = typeof opts.onPrevPage === 'function' ? opts.onPrevPage : () => undefined;
		const onNextPage = typeof opts.onNextPage === 'function' ? opts.onNextPage : () => undefined;
		const onLastPage = typeof opts.onLastPage === 'function' ? opts.onLastPage : () => undefined;
		const onPageSizeChanged =
			typeof opts.onPageSizeChanged === 'function' ? opts.onPageSizeChanged : () => undefined;

		const actions = h('div', { class: 'msghub-toolbar__group' });
		const refreshBtn = h('button', {
			class: 'msghub-uibutton-icon msghub-toolbarbutton-icon msghub-messages-toolbar-refresh',
			type: 'button',
			'aria-label': 'Refresh',
		});
		const deleteLabel = t('msghub.i18n.core.admin.ui.messages.toolbar.delete.action');
		const deleteBtn = h('button', {
			class: 'msghub-uibutton-iconandtext msghub-toolbarbutton-iconandtext msghub-messages-toolbar-delete is-danger',
			type: 'button',
			text: deleteLabel,
		});
		const autoRefreshLabel = t('msghub.i18n.core.admin.ui.messages.toolbar.autoRefresh.label');
		const autoBtn = h(
			'button',
			{
				class: 'msghub-uibutton-selectandtext msghub-toolbarbutton-selectandtext',
				type: 'button',
				role: 'switch',
				'aria-checked': 'true',
				title: autoRefreshLabel,
				'aria-label': autoRefreshLabel,
			},
			[
				h('span', { class: 'msghub-uibutton-selectandtext__box', 'aria-hidden': 'true' }, [
					h('span', { class: 'msghub-uibutton-selectandtext__check' }),
				]),
				h('span', { class: 'msghub-uibutton-selectandtext__label', text: autoRefreshLabel }),
			],
		);
		const deleteSeparator = h('span', { class: 'msghub-toolbar__separator', 'aria-hidden': 'true' });
		actions.appendChild(refreshBtn);
		actions.appendChild(autoBtn);
		actions.appendChild(deleteSeparator);
		actions.appendChild(deleteBtn);

		const sizeOptions = [10, 25, 50, 100, 250];
		const firstBtn = h('button', {
			class: 'msghub-uibutton-icon msghub-toolbarbutton-icon msghub-messages-toolbar-first',
			type: 'button',
			'aria-label': 'First page',
		});
		const prevBtn = h('button', {
			class: 'msghub-uibutton-icon msghub-toolbarbutton-icon msghub-messages-toolbar-prev',
			type: 'button',
			'aria-label': 'Previous page',
		});
		const nextBtn = h('button', {
			class: 'msghub-uibutton-icon msghub-toolbarbutton-icon msghub-messages-toolbar-next',
			type: 'button',
			'aria-label': 'Next page',
		});
		const lastBtn = h('button', {
			class: 'msghub-uibutton-icon msghub-toolbarbutton-icon msghub-messages-toolbar-last',
			type: 'button',
			'aria-label': 'Last page',
		});
		const pageInfoEl = h('div', {
			class: 'msghub-muted',
			text: t('msghub.i18n.core.admin.ui.pagination.pageOf.text', 1, 1),
		});
		const pageSizeLabel = t('msghub.i18n.core.admin.ui.messages.toolbar.itemsPerPage.label');
		const pageSizeSelect = h(
			'select',
			{
				class: 'msghub-uiselect',
				onchange: e => {
					const n = Number(e?.target?.value);
					const nextSize = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 50;
					onPageSizeChanged(nextSize);
				},
			},
			sizeOptions.map(n => h('option', { value: String(n), text: String(n) })),
		);

		const paging = h('div', { class: 'msghub-toolbar__group msghub-messages-paging' }, [
			firstBtn,
			prevBtn,
			pageInfoEl,
			nextBtn,
			lastBtn,
		]);
		const pageSizeControl = h('div', { class: 'msghub-toolbar__group msghub-messages-pagesize' }, [
			h('label', { class: 'msghub-muted', text: pageSizeLabel }),
			pageSizeSelect,
		]);
		const head = h('div', { class: 'msghub-toolbar msghub-toolbar--tripartite msghub-messages-head' }, [
			h('div', { class: 'msghub-toolbar__left' }, [actions]),
			h('div', { class: 'msghub-toolbar__center' }, [paging]),
			h('div', { class: 'msghub-toolbar__right' }, [pageSizeControl]),
		]);
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
		firstBtn.addEventListener('click', e => {
			e.preventDefault();
			onFirstPage();
		});
		prevBtn.addEventListener('click', e => {
			e.preventDefault();
			onPrevPage();
		});
		nextBtn.addEventListener('click', e => {
			e.preventDefault();
			onNextPage();
		});
		lastBtn.addEventListener('click', e => {
			e.preventDefault();
			onLastPage();
		});

		/**
		 * Mounts static panel structure into root element.
		 *
		 * @param {HTMLElement} root - Messages root element.
		 */
		function mount(root) {
			root.replaceChildren(head, progress, errorEl, metaEl, tableWrap, emptyEl);
			updatePaging();
		}

		/**
		 * Updates delete button visibility and disabled state.
		 */
		function updateDeleteButton() {
			deleteBtn.classList.toggle('is-hidden', !state.expertMode);
			deleteSeparator.classList.toggle('is-hidden', !state.expertMode);
			if (!state.expertMode) {
				deleteBtn.disabled = true;
				deleteBtn.textContent = deleteLabel;
				return;
			}
			const count = state.selectedRefs.size;
			deleteBtn.textContent = count > 0 ? `${deleteLabel} (${count})` : deleteLabel;
			deleteBtn.disabled = count === 0 || (state.loading && !state.silentLoading);
		}

		/**
		 * Updates paging controls.
		 */
		function updatePaging() {
			const pages = state.pages || 1;
			const idx = Math.min(Math.max(1, state.pageIndex), pages);
			const hasExtendedPaging = pages >= 10;
			pageInfoEl.textContent = t('msghub.i18n.core.admin.ui.pagination.pageOf.text', idx, pages);
			firstBtn.classList.toggle('is-hidden', !hasExtendedPaging);
			lastBtn.classList.toggle('is-hidden', !hasExtendedPaging);
			firstBtn.setAttribute('aria-hidden', hasExtendedPaging ? 'false' : 'true');
			lastBtn.setAttribute('aria-hidden', hasExtendedPaging ? 'false' : 'true');
			firstBtn.disabled = !hasExtendedPaging || idx <= 1;
			prevBtn.disabled = idx <= 1;
			nextBtn.disabled = idx >= pages;
			lastBtn.disabled = !hasExtendedPaging || idx >= pages;
			pageSizeSelect.value = String(state.pageSize);
		}

		/**
		 * Updates global action buttons.
		 */
		function updateButtons() {
			refreshBtn.disabled = state.loading && !state.silentLoading;
			refreshBtn.classList.toggle('msghub-btn-loading', state.loading && state.silentLoading);
			autoBtn.setAttribute('aria-checked', state.autoRefresh ? 'true' : 'false');
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
		 * Renders one-line meta text and tooltip details.
		 *
		 * @param {object} meta - Meta payload.
		 * @param {string} meta.generatedAtText - Visible one-line generatedAt text.
		 * @param {string} meta.timeZone - Raw timezone string.
		 * @param {string} meta.source - Raw source string.
		 */
		function setMeta(meta) {
			const generatedAtText =
				typeof meta?.generatedAtText === 'string' && meta.generatedAtText.trim()
					? meta.generatedAtText.trim()
					: 'n/a';
			const timeZone = typeof meta?.timeZone === 'string' && meta.timeZone.trim() ? meta.timeZone.trim() : 'n/a';
			const source = typeof meta?.source === 'string' && meta.source.trim() ? meta.source.trim() : 'n/a';
			const tooltip = [
				`${t('msghub.i18n.core.admin.ui.messages.meta.timeZone.label')}: ${timeZone}`,
				`${t('msghub.i18n.core.admin.ui.messages.meta.source.label')}: ${source}`,
			].join('\n');
			metaEl.title = tooltip;
			metaEl.setAttribute('aria-label', tooltip);
			metaEl.replaceChildren(h('div', { text: generatedAtText }));
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
				firstBtn,
				prevBtn,
				nextBtn,
				lastBtn,
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
