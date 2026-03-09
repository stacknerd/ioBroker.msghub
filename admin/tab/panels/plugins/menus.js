/// <reference lib="dom" />
/* global window */
(function () {
	'use strict';

	const win = window;

	/**
	 * Context-menu and accordion bulk-ops module for the plugins panel.
	 *
	 * Contains:
	 * - `getAllInstanceWraps` — collects all instance DOM nodes inside elRoot.
	 * - `getCategoryTitle` — resolves a category raw key to a translated label.
	 * - `setAccordionChecked` — expands or collapses a set of instance accordions.
	 * - `getEnabledStats` — counts enabled/disabled instances in a wrap list.
	 * - `setEnabledForWraps` — toggles enable state for a set of instance wraps.
	 * - `openPluginsContextMenu` — builds and opens the full plugin context menu.
	 *
	 * Integration:
	 * - Depends on `state.js` utilities injected via factory options.
	 * - Consumed by `index.js` via the menusApi instance.
	 * - Loaded before `index.js` (registry load order).
	 *
	 * Public API:
	 * - `createPluginsMenusApi(options)`
	 */

	/**
	 * Creates the plugins menus facade for one panel instance.
	 *
	 * @param {object}   options - Factory options.
	 * @param {object}   options.elRoot - Root DOM element of the plugins panel.
	 * @param {object}   options.CATEGORY_I18N - Category i18n config map from state.js.
	 * @param {Function} options.tOr - i18n tOr helper (key, fallback) => string.
	 * @param {Function} options.t - i18n t helper (key, ...args) => string.
	 * @param {object}   options.ui - Panel ui object (contextMenu, dialog, toast).
	 * @param {Function} options.isTextEditableTarget - Detects editable input targets.
	 * @param {object}   options.pluginsDataApi - Data API instance (for setEnabled).
	 * @param {Function} options.onRefreshAll - Callback invoked after bulk enable/disable.
	 * @returns {object} Frozen menus facade.
	 */
	function createPluginsMenusApi(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const elRoot = opts.elRoot;
		const CATEGORY_I18N = opts.CATEGORY_I18N && typeof opts.CATEGORY_I18N === 'object' ? opts.CATEGORY_I18N : {};
		const tOr = typeof opts.tOr === 'function' ? opts.tOr : (k, fb) => fb || k;
		const t = typeof opts.t === 'function' ? opts.t : k => k;
		const ui = opts.ui;
		const isTextEditableTarget =
			typeof opts.isTextEditableTarget === 'function' ? opts.isTextEditableTarget : () => false;
		const pluginsDataApi = opts.pluginsDataApi;
		const onRefreshAll = typeof opts.onRefreshAll === 'function' ? opts.onRefreshAll : () => Promise.resolve();

		/**
		 * Returns all instance wrap elements currently in the panel DOM.
		 *
		 * @returns {Element[]} Array of `.msghub-plugin-instance` elements.
		 */
		const getAllInstanceWraps = () =>
			elRoot ? Array.from(elRoot.querySelectorAll('.msghub-plugin-instance')).filter(Boolean) : [];

		/**
		 * Resolves a raw category key to its translated display label.
		 *
		 * @param {string} categoryRaw - Raw category identifier string.
		 * @returns {string} Translated category title.
		 */
		const getCategoryTitle = categoryRaw => {
			const raw = typeof categoryRaw === 'string' ? categoryRaw : '';
			const cfg = CATEGORY_I18N[raw] || null;
			if (cfg) {
				return tOr(cfg.titleKey, cfg.fallbackTitle || raw);
			}
			return tOr(`msghub.i18n.core.admin.ui.plugins.category.${raw}.title`, raw);
		};

		/**
		 * Expands or collapses the accordion for each wrap in the list.
		 *
		 * Uses a tagName duck-type check instead of `instanceof HTMLInputElement`
		 * for portability in test environments.
		 *
		 * @param {Element[]} wraps - Instance wrap elements.
		 * @param {boolean}   checked - Whether to expand (true) or collapse (false).
		 */
		const setAccordionChecked = (wraps, checked) => {
			const list = Array.isArray(wraps) ? wraps : [];
			for (const w of list) {
				const inputEl = w?.querySelector?.('.msghub-acc-input--instance');
				if (!inputEl || String(inputEl?.tagName || '').toUpperCase() !== 'INPUT') {
					continue;
				}
				if (Reflect.get(inputEl, 'checked') === checked) {
					continue;
				}
				Reflect.set(inputEl, 'checked', checked);
				try {
					inputEl.dispatchEvent(new Event('change', { bubbles: true }));
				} catch {
					// ignore
				}
			}
		};

		/**
		 * Counts enabled and disabled instances in a wrap list.
		 *
		 * @param {Element[]} wraps - Instance wrap elements.
		 * @returns {{enabledCount:number,disabledCount:number,total:number}} Stats.
		 */
		const getEnabledStats = wraps => {
			const list = Array.isArray(wraps) ? wraps : [];
			let enabledCount = 0;
			let disabledCount = 0;
			for (const w of list) {
				const curEnabled = w?.getAttribute?.('data-enabled') === '1';
				if (curEnabled) {
					enabledCount += 1;
				} else {
					disabledCount += 1;
				}
			}
			return { enabledCount, disabledCount, total: enabledCount + disabledCount };
		};

		/**
		 * Enables or disables each instance in the wrap list and refreshes the panel.
		 *
		 * @param {Element[]} wraps - Instance wrap elements.
		 * @param {boolean}   enabled - Target enabled state.
		 * @returns {Promise<void>}
		 */
		const setEnabledForWraps = async (wraps, enabled) => {
			const list = Array.isArray(wraps) ? wraps : [];
			const tasks = [];
			for (const w of list) {
				const type = String(w?.getAttribute?.('data-plugin-type') || '').trim();
				const iid = Number(w?.getAttribute?.('data-instance-id'));
				if (!type || !Number.isFinite(iid)) {
					continue;
				}
				const curEnabled = w?.getAttribute?.('data-enabled') === '1';
				if (curEnabled === enabled) {
					continue;
				}
				tasks.push({ type, instanceId: Math.trunc(iid) });
			}
			for (const task of tasks) {
				await pluginsDataApi.setEnabled({
					type: task.type,
					instanceId: task.instanceId,
					enabled,
				});
			}
			await onRefreshAll();
		};

		/**
		 * Opens the plugins context menu anchored to the pointer position.
		 *
		 * Respects Ctrl+RightClick bypass and text-editable target guard.
		 *
		 * @param {MouseEvent} e - The contextmenu event.
		 * @param {object}     ctx - Menu context descriptor.
		 * @param {string}     [ctx.kind] - Scope level: "all", "category", or "instance".
		 * @param {Element}    [ctx.instWrap] - The triggering instance wrap element.
		 * @param {string}     [ctx.pluginType] - Plugin type string.
		 * @param {string}     [ctx.categorySafe] - CSS-safe category identifier.
		 * @param {string}     [ctx.categoryRaw] - Raw category identifier.
		 * @param {string}     [ctx.instanceName] - Display name for the instance.
		 * @param {boolean}    [ctx.hasReadme] - Whether a readme is available.
		 * @param {boolean}    [ctx.hasToolsAvailable] - Whether tools are available.
		 * @param {Array}      [ctx.toolsItems] - Tools submenu items.
		 * @param {Function}   [ctx.openReadme] - Callback to open the readme overlay.
		 * @param {Function}   [ctx.removeInstance] - Callback to delete the instance.
		 */
		const openPluginsContextMenu = (e, ctx) => {
			if (!e || typeof e !== 'object') {
				return;
			}
			const context = ctx && typeof ctx === 'object' ? ctx : {};
			const kind = typeof context.kind === 'string' ? context.kind : 'all';

			// Secret bypass: Ctrl+RightClick opens the native browser context menu (global handler).
			if (e.ctrlKey === true) {
				return;
			}
			// Keep the global input context menu for text-like editables.
			if (isTextEditableTarget(e?.target)) {
				return;
			}
			if (!ui?.contextMenu?.open) {
				return;
			}
			if (typeof e.preventDefault === 'function') {
				e.preventDefault();
			}

			const wrapsAll = getAllInstanceWraps();
			const wrapsThis = kind === 'instance' && context.instWrap ? [context.instWrap] : [];
			const wrapsType =
				kind === 'instance' && context.pluginType
					? wrapsAll.filter(
							w => String(w.getAttribute('data-plugin-type') || '') === String(context.pluginType),
						)
					: [];
			const wrapsCategory =
				(kind === 'instance' || kind === 'category') && context.categorySafe
					? wrapsAll.filter(
							w => String(w.getAttribute('data-plugin-category') || '') === String(context.categorySafe),
						)
					: [];

			const canExpandAll = wrapsAll.some(w => w?.querySelector?.('.msghub-acc-input--instance'));
			const canExpandCategory = wrapsCategory.some(w => w?.querySelector?.('.msghub-acc-input--instance'));
			const canExpandType = wrapsType.some(w => w?.querySelector?.('.msghub-acc-input--instance'));
			const canExpandThis = wrapsThis.some(w => w?.querySelector?.('.msghub-acc-input--instance'));

			const categoryTitle = context.categoryRaw ? getCategoryTitle(context.categoryRaw) : '';
			const categoryLabel =
				kind === 'category'
					? t(
							'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.this.label',
							categoryTitle || String(context.categoryRaw),
						)
					: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.category.label', categoryTitle);

			const expandItems =
				kind === 'instance'
					? [
							{
								id: 'expand_this',
								label: t(
									'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.this.label',
									context.instanceName,
								),
								disabled: !canExpandThis,
								onSelect: () => setAccordionChecked(wrapsThis, true),
							},
							{
								id: 'expand_type',
								label: t(
									'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.type.label',
									String(context.pluginType || ''),
								),
								disabled: !canExpandType,
								onSelect: () => setAccordionChecked(wrapsType, true),
							},
							{
								id: 'expand_category',
								label: categoryLabel,
								disabled: !canExpandCategory,
								onSelect: () => setAccordionChecked(wrapsCategory, true),
							},
							{
								id: 'expand_all',
								label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
								disabled: !canExpandAll,
								onSelect: () => setAccordionChecked(wrapsAll, true),
							},
						]
					: kind === 'category'
						? [
								{
									id: 'expand_category',
									label: categoryLabel,
									disabled: !canExpandCategory,
									onSelect: () => setAccordionChecked(wrapsCategory, true),
								},
								{
									id: 'expand_all',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
									disabled: !canExpandAll,
									onSelect: () => setAccordionChecked(wrapsAll, true),
								},
							]
						: [
								{
									id: 'expand_all',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
									disabled: !canExpandAll,
									onSelect: () => setAccordionChecked(wrapsAll, true),
								},
							];

			const collapseItems =
				kind === 'instance'
					? [
							{
								id: 'collapse_this',
								label: t(
									'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.this.label',
									context.instanceName,
								),
								disabled: !canExpandThis,
								onSelect: () => setAccordionChecked(wrapsThis, false),
							},
							{
								id: 'collapse_type',
								label: t(
									'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.type.label',
									String(context.pluginType || ''),
								),
								disabled: !canExpandType,
								onSelect: () => setAccordionChecked(wrapsType, false),
							},
							{
								id: 'collapse_category',
								label: categoryLabel,
								disabled: !canExpandCategory,
								onSelect: () => setAccordionChecked(wrapsCategory, false),
							},
							{
								id: 'collapse_all',
								label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
								disabled: !canExpandAll,
								onSelect: () => setAccordionChecked(wrapsAll, false),
							},
						]
					: kind === 'category'
						? [
								{
									id: 'collapse_category',
									label: categoryLabel,
									disabled: !canExpandCategory,
									onSelect: () => setAccordionChecked(wrapsCategory, false),
								},
								{
									id: 'collapse_all',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
									disabled: !canExpandAll,
									onSelect: () => setAccordionChecked(wrapsAll, false),
								},
							]
						: [
								{
									id: 'collapse_all',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
									disabled: !canExpandAll,
									onSelect: () => setAccordionChecked(wrapsAll, false),
								},
							];

			const statsAll = getEnabledStats(wrapsAll);
			const statsCategory = getEnabledStats(wrapsCategory);
			const statsType = getEnabledStats(wrapsType);
			const statsThis = getEnabledStats(wrapsThis);

			const disableItems =
				kind === 'instance'
					? [
							{
								id: 'disable_this',
								label: t(
									'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.this.label',
									context.instanceName,
								),
								disabled: statsThis.enabledCount === 0,
								onSelect: () => setEnabledForWraps(wrapsThis, false),
							},
							{
								id: 'disable_type',
								label: t(
									'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.type.label',
									String(context.pluginType || ''),
								),
								disabled: statsType.enabledCount === 0,
								onSelect: () => setEnabledForWraps(wrapsType, false),
							},
							{
								id: 'disable_category',
								label: categoryLabel,
								disabled: statsCategory.enabledCount === 0,
								onSelect: () => setEnabledForWraps(wrapsCategory, false),
							},
							{
								id: 'disable_all',
								label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
								disabled: statsAll.enabledCount === 0,
								onSelect: () => setEnabledForWraps(wrapsAll, false),
							},
						]
					: kind === 'category'
						? [
								{
									id: 'disable_category',
									label: categoryLabel,
									disabled: statsCategory.enabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsCategory, false),
								},
								{
									id: 'disable_all',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
									disabled: statsAll.enabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsAll, false),
								},
							]
						: [
								{
									id: 'disable_all',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
									disabled: statsAll.enabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsAll, false),
								},
							];

			const enableItems =
				kind === 'instance'
					? [
							{
								id: 'enable_this',
								label: t(
									'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.this.label',
									context.instanceName,
								),
								disabled: statsThis.disabledCount === 0,
								onSelect: () => setEnabledForWraps(wrapsThis, true),
							},
							{
								id: 'enable_type',
								label: t(
									'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.type.label',
									String(context.pluginType || ''),
								),
								disabled: statsType.disabledCount === 0,
								onSelect: () => setEnabledForWraps(wrapsType, true),
							},
							{
								id: 'enable_category',
								label: categoryLabel,
								disabled: statsCategory.disabledCount === 0,
								onSelect: () => setEnabledForWraps(wrapsCategory, true),
							},
							{
								id: 'enable_all',
								label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
								disabled: statsAll.disabledCount === 0,
								onSelect: () => setEnabledForWraps(wrapsAll, true),
							},
						]
					: kind === 'category'
						? [
								{
									id: 'enable_category',
									label: categoryLabel,
									disabled: statsCategory.disabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsCategory, true),
								},
								{
									id: 'enable_all',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
									disabled: statsAll.disabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsAll, true),
								},
							]
						: [
								{
									id: 'enable_all',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
									disabled: statsAll.disabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsAll, true),
								},
							];

			const items = [];
			if (kind === 'instance') {
				items.push(
					{
						id: 'help',
						label: t(
							'msghub.i18n.core.admin.ui.plugins.contextMenu.help.label',
							String(context.pluginType || ''),
						),
						icon: 'help',
						disabled: context.hasReadme !== true,
						onSelect: () => context.openReadme?.(),
					},
					{
						id: 'tools',
						label: t(
							'msghub.i18n.core.admin.ui.plugins.contextMenu.tools.label',
							String(context.pluginType || ''),
						),
						icon: 'tools',
						disabled: context.hasToolsAvailable !== true,
						items: Array.isArray(context.toolsItems) ? context.toolsItems : [],
					},
					{ type: 'separator' },
				);
			}

			items.push(
				{
					id: 'expand',
					label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.expand.label'),
					items: expandItems,
				},
				{
					id: 'collapse',
					label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.collapse.label'),
					items: collapseItems,
				},
				{ type: 'separator' },
				{
					id: 'disable',
					label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.disable.label'),
					icon: 'pause',
					items: disableItems,
				},
				{
					id: 'enable',
					label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.enable.label'),
					icon: 'play',
					items: enableItems,
				},
			);

			if (kind === 'instance') {
				items.push(
					{ type: 'separator' },
					{
						id: 'remove',
						label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.remove.label'),
						danger: true,
						onSelect: () => context.removeInstance?.(),
					},
				);
			}

			ui.contextMenu.open({
				anchorPoint: { x: e.clientX, y: e.clientY },
				ariaLabel: 'Plugin context menu',
				placement: 'bottom-start',
				items,
			});
		};

		return Object.freeze({
			getAllInstanceWraps,
			getCategoryTitle,
			setAccordionChecked,
			getEnabledStats,
			setEnabledForWraps,
			openPluginsContextMenu,
		});
	}

	win.MsghubAdminTabPluginsMenus = Object.freeze({ createPluginsMenusApi });
})();
