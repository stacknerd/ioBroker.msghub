/* global window */
(function () {
	'use strict';

	const win = window;
	void win;

	/**
	 * Messages table header renderer module.
	 *
	 * Contains:
	 * - Colgroup and table header rendering.
	 * - Sort/filter button construction.
	 * - Header state refresh for active sort/filter badges.
	 *
	 * Integration:
	 * - Uses shared state and data/menu facades.
	 * - Works with existing tbody selection to power select-all behavior.
	 */

	/**
	 * Creates header renderer for one messages panel instance.
	 *
	 * @param {object} options - Factory options.
	 * @param {Function} options.h - DOM helper.
	 * @param {Function} options.t - Translation helper.
	 * @param {object} options.state - Shared state.
	 * @param {object} options.dataApi - Messages data facade.
	 * @param {object} options.menusApi - Menu facade.
	 * @param {HTMLElement} options.colgroupEl - Table colgroup element.
	 * @param {HTMLElement} options.theadEl - Table thead element.
	 * @param {HTMLElement} options.tbodyEl - Table tbody element.
	 * @param {Function} options.onSelectionChanged - Selection callback.
	 * @returns {{renderThead:Function, updateHeaderButtons:Function}} Header facade.
	 */
	function createHeaderRenderer(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const h = opts.h;
		const t = opts.t;
		const state = opts.state;
		const dataApi = opts.dataApi;
		const menusApi = opts.menusApi;
		const colgroupEl = opts.colgroupEl;
		const theadEl = opts.theadEl;
		const tbodyEl = opts.tbodyEl;
		const onSelectionChanged =
			typeof opts.onSelectionChanged === 'function' ? opts.onSelectionChanged : () => undefined;

		const headerBtns = Object.create(null);

		/**
		 * Clears header button registry.
		 */
		function clearHeaderBtns() {
			for (const key of Object.keys(headerBtns)) {
				delete headerBtns[key];
			}
		}

		/**
		 * Updates table column count according to expert mode.
		 */
		function updateTableColCount() {
			state.tableColCount = state.expertMode ? 12 : 11;
		}

		/**
		 * Creates one sort header button.
		 *
		 * @param {string} field - Sort field path.
		 * @param {string} title - Column title.
		 * @param {string} label - Button label.
		 * @returns {HTMLButtonElement} Sort button.
		 */
		function makeSortBtn(field, title, label) {
			const btn = h('button', {
				class: 'msghub-th-sort msghub-thBtn msghub-thBtn--sort',
				type: 'button',
				onclick: e => {
					e.preventDefault();
					const anchor = e?.currentTarget?.closest?.('th') || e?.currentTarget || e?.target;
					menusApi.openHeaderSortMenu(anchor, { field, title });
				},
			});
			btn.appendChild(
				h('span', {
					class: 'msghub-th-icon msghub-th-icon-sort msghub-thIcon msghub-thIcon--sort',
					'aria-hidden': 'true',
				}),
			);
			btn.appendChild(h('span', { class: 'msghub-th-label', text: label }));
			headerBtns[`sort:${field}`] = btn;
			return btn;
		}

		/**
		 * Creates one filter header button.
		 *
		 * @param {string} key - Filter key.
		 * @param {string} title - Column title.
		 * @param {string} label - Button label.
		 * @param {Function} getOptions - Options provider callback.
		 * @returns {HTMLButtonElement} Filter button.
		 */
		function makeFilterBtn(key, title, label, getOptions) {
			const btn = h('button', {
				class: 'msghub-th-filter msghub-thBtn msghub-thBtn--filter',
				type: 'button',
				onclick: e => {
					e.preventDefault();
					const optionsList = typeof getOptions === 'function' ? getOptions() : [];
					const anchor = e?.currentTarget?.closest?.('th') || e?.currentTarget || e?.target;
					menusApi.openHeaderFilterMenu(anchor, { key, title, options: optionsList });
				},
			});
			btn.appendChild(
				h('span', {
					class: 'msghub-th-icon msghub-th-icon-sort msghub-thIcon msghub-thIcon--sort',
					'aria-hidden': 'true',
				}),
			);
			btn.appendChild(
				h('span', {
					class: 'msghub-th-icon msghub-th-icon-filter msghub-thIcon msghub-thIcon--filter',
					'aria-hidden': 'true',
				}),
			);
			btn.appendChild(h('span', { class: 'msghub-th-label', text: label }));
			btn.appendChild(h('span', { class: 'msghub-th-badge', text: '' }));
			headerBtns[`filter:${key}`] = btn;
			return btn;
		}

		/**
		 * Creates clickable table header wrapper.
		 *
		 * @param {HTMLElement} btn - Header button.
		 * @param {string} colKey - Column key.
		 * @returns {HTMLTableCellElement} Header cell.
		 */
		function makeThClickTarget(btn, colKey) {
			return h(
				'th',
				{
					class: `msghub-th msghub-colCell msghub-colCell--${colKey}`,
					onclick: e => {
						const target = e?.target;
						if (target && btn && typeof btn.contains === 'function' && btn.contains(target)) {
							return;
						}
						btn?.click?.();
					},
				},
				[btn],
			);
		}

		/**
		 * Creates select-all column header for expert mode.
		 *
		 * @returns {HTMLTableCellElement} Select-all header cell.
		 */
		function makeSelectAllTh() {
			if (!state.expertMode) {
				return h('th', { class: 'msghub-th msghub-messages-select msghub-colCell msghub-colCell--select' }, []);
			}
			const input = h('input', {
				type: 'checkbox',
				checked: null,
				onchange: e => {
					e?.preventDefault?.();
					const refs = Array.from(tbodyEl.querySelectorAll('tr[data-ref]'))
						.map(tr => String(tr.getAttribute('data-ref') || '').trim())
						.filter(Boolean);
					const allSelected = refs.length > 0 && refs.every(ref => state.selectedRefs.has(ref));
					if (allSelected) {
						for (const ref of refs) {
							state.selectedRefs.delete(ref);
						}
					} else {
						for (const ref of refs) {
							state.selectedRefs.add(ref);
						}
					}
					onSelectionChanged();
				},
			});
			state.headerSelectAllInput = input;
			return h('th', { class: 'msghub-th msghub-messages-select msghub-colCell msghub-colCell--select' }, [
				input,
			]);
		}

		/**
		 * Renders colgroup and thead according to current mode.
		 */
		function renderThead() {
			clearHeaderBtns();
			updateTableColCount();
			state.headerSelectAllInput = null;

			const cols = [
				...(state.expertMode ? [{ key: 'select', cls: 'msghub-col--select' }] : []),
				{ key: 'icon', cls: 'msghub-col--icon' },
				{ key: 'title', cls: 'msghub-col--title' },
				{ key: 'text', cls: 'msghub-col--text' },
				{ key: 'location', cls: 'msghub-col--location' },
				{ key: 'kind', cls: 'msghub-col--kind' },
				{ key: 'level', cls: 'msghub-col--level' },
				{ key: 'lifecycle', cls: 'msghub-col--lifecycle' },
				{ key: 'created', cls: 'msghub-col--created' },
				{ key: 'updated', cls: 'msghub-col--updated' },
				{ key: 'origin', cls: 'msghub-col--origin' },
				{ key: 'progress', cls: 'msghub-col--progress' },
			];
			colgroupEl.replaceChildren(
				...cols.map(c => h('col', { class: `msghub-col ${c.cls}`, 'data-msghub-col': c.key })),
			);

			const labelKind = t('msghub.i18n.core.admin.common.MsgConstants.field.kind.label');
			const labelLevel = t('msghub.i18n.core.admin.common.MsgConstants.field.level.label');
			const labelLifecycle = t('msghub.i18n.core.admin.common.MsgConstants.field.lifecycle.state.label');
			const labelIcon = t('msghub.i18n.core.admin.common.MsgConstants.field.icon.label');
			const labelTitle = t('msghub.i18n.core.admin.common.MsgConstants.field.title.label');
			const labelText = t('msghub.i18n.core.admin.common.MsgConstants.field.text.label');
			const labelLocation = t('msghub.i18n.core.admin.common.MsgConstants.field.details.location.label');
			const labelCreated = t('msghub.i18n.core.admin.common.MsgConstants.field.timing.createdAt.label');
			const labelUpdated = t('msghub.i18n.core.admin.common.MsgConstants.field.timing.updatedAt.label');
			const labelOrigin = t('msghub.i18n.core.admin.common.MsgConstants.field.origin.system.label');
			const labelProgress = t('msghub.i18n.core.admin.common.MsgConstants.field.progress.percentage.label');

			theadEl.replaceChildren(
				h('tr', null, [
					...(state.expertMode ? [makeSelectAllTh()] : []),
					makeThClickTarget(makeSortBtn('icon', labelIcon, labelIcon), 'icon'),
					makeThClickTarget(makeSortBtn('title', labelTitle, labelTitle), 'title'),
					makeThClickTarget(makeSortBtn('text', labelText, labelText), 'text'),
					makeThClickTarget(
						makeFilterBtn('details.location', labelLocation, labelLocation, () =>
							dataApi.listDistinctFromItems('details.location'),
						),
						'location',
					),
					makeThClickTarget(
						makeFilterBtn('kind', labelKind, labelKind, () =>
							dataApi.listEnumValues(dataApi.getConstantsEnum('kind')),
						),
						'kind',
					),
					makeThClickTarget(
						makeFilterBtn('level', labelLevel, labelLevel, () =>
							dataApi.listEnumKeys(dataApi.getConstantsEnum('level')),
						),
						'level',
					),
					makeThClickTarget(
						makeFilterBtn('lifecycle.state', labelLifecycle, labelLifecycle, () =>
							dataApi.listEnumValues(dataApi.getConstantsEnum('lifecycle.state')),
						),
						'lifecycle',
					),
					makeThClickTarget(makeSortBtn('timing.createdAt', labelCreated, labelCreated), 'created'),
					makeThClickTarget(makeSortBtn('timing.updatedAt', labelUpdated, labelUpdated), 'updated'),
					makeThClickTarget(
						makeFilterBtn('origin.system', labelOrigin, labelOrigin, () =>
							dataApi.listDistinctFromItems('origin.system'),
						),
						'origin',
					),
					makeThClickTarget(makeSortBtn('progress.percentage', labelProgress, labelProgress), 'progress'),
				]),
			);
		}

		/**
		 * Updates dynamic header button states and badges.
		 */
		function updateHeaderButtons() {
			const labelLocation = t('msghub.i18n.core.admin.common.MsgConstants.field.details.location.label');
			const labelKind = t('msghub.i18n.core.admin.common.MsgConstants.field.kind.label');
			const labelLifecycle = t('msghub.i18n.core.admin.common.MsgConstants.field.lifecycle.state.label');
			const labelLevel = t('msghub.i18n.core.admin.common.MsgConstants.field.level.label');
			const labelOrigin = t('msghub.i18n.core.admin.common.MsgConstants.field.origin.system.label');

			const locationCount = dataApi.getFilterSet('details.location')?.size || 0;
			const kindCount = dataApi.getFilterSet('kind')?.size || 0;
			const lifecycleCount = dataApi.getFilterSet('lifecycle.state')?.size || 0;
			const levelCount = dataApi.getFilterSet('level')?.size || 0;
			const originCount = dataApi.getFilterSet('origin.system')?.size || 0;

			/**
			 * Updates one filter button badge/state.
			 *
			 * @param {string} field - Filter field key.
			 * @param {string} label - Button label.
			 * @param {number} count - Active filter count.
			 */
			const updateFilterBtn = (field, label, count) => {
				const btn = headerBtns[`filter:${field}`];
				if (!btn) {
					return;
				}
				btn.classList.toggle('is-active', count > 0);
				const labelEl = btn.querySelector('.msghub-th-label');
				if (labelEl) {
					labelEl.textContent = label;
				}
				const badgeEl = btn.querySelector('.msghub-th-badge');
				if (badgeEl) {
					badgeEl.textContent = count > 0 ? String(count) : '';
				}
				if (count > 0) {
					btn.setAttribute('data-filter-count', String(count));
				} else {
					btn.removeAttribute('data-filter-count');
				}
			};

			updateFilterBtn('details.location', labelLocation, locationCount);
			updateFilterBtn('kind', labelKind, kindCount);
			updateFilterBtn('lifecycle.state', labelLifecycle, lifecycleCount);
			updateFilterBtn('level', labelLevel, levelCount);
			updateFilterBtn('origin.system', labelOrigin, originCount);

			/**
			 * Applies active sort direction attribute to one button.
			 *
			 * @param {HTMLElement|null} btn - Target button.
			 * @param {boolean} active - Whether sorting is active on this field.
			 */
			const setSortDirAttr = (btn, active) => {
				if (!btn) {
					return;
				}
				if (active) {
					btn.setAttribute('data-sort-dir', state.sortDir);
				} else {
					btn.removeAttribute('data-sort-dir');
				}
			};

			/**
			 * Updates one sort-only button state.
			 *
			 * @param {string} field - Sort field.
			 */
			const updateSortBtn = field => {
				const btn = headerBtns[`sort:${field}`];
				if (!btn) {
					return;
				}
				const active = state.sortField === field;
				btn.classList.toggle('is-active', active);
				setSortDirAttr(btn, active);
			};

			/**
			 * Updates sort direction marker on filter buttons that also support sorting.
			 *
			 * @param {string} field - Filter/sort field.
			 */
			const updateFilterSortDir = field => {
				const btn = headerBtns[`filter:${field}`];
				setSortDirAttr(btn, state.sortField === field);
			};

			for (const field of ['kind', 'level', 'lifecycle.state', 'origin.system', 'details.location']) {
				updateFilterSortDir(field);
			}

			for (const field of [
				'icon',
				'title',
				'text',
				'timing.createdAt',
				'timing.updatedAt',
				'progress.percentage',
			]) {
				updateSortBtn(field);
			}
		}

		return Object.freeze({
			renderThead,
			updateHeaderButtons,
		});
	}

	win.MsghubAdminTabMessagesRenderHeader = Object.freeze({
		createHeaderRenderer,
	});
})();
