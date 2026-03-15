/* global window, document, HTMLButtonElement */
(function () {
	'use strict';

	const win = window;

	/**
	 * Messages menu module.
	 *
	 * Contains:
	 * - Header sort menu.
	 * - Header filter menu (with select-all/none/apply flow).
	 * - Row context menu actions (open JSON, archive entry, actions submenu, copy submenu).
	 *
	 * Integration:
	 * - Relies on shared state and data facade.
	 * - Uses UI primitives via `ctx.api.ui.contextMenu`.
	 *
	 * Public API:
	 * - `createMessagesMenus(options)` with header and row menu openers.
	 */

	/**
	 * Core-executable action types that are offered in the context menu.
	 * Non-core types open/custom remain intentional no-ops in core and are not shown
	 * as executable items. `link` is handled separately as navigation.
	 */
	const CORE_ACTION_TYPES = new Set(['ack', 'close', 'delete', 'snooze']);

	/**
	 * Maps action type to its common admin i18n label key.
	 * Used to translate action menu item labels in the row context menu.
	 */
	const ACTION_LABEL_KEYS = Object.freeze({
		ack: 'msghub.i18n.core.admin.common.action.ack.label',
		close: 'msghub.i18n.core.admin.common.action.close.label',
		delete: 'msghub.i18n.core.admin.common.action.delete.label',
		link: 'msghub.i18n.core.admin.common.action.link.label',
		snooze: 'msghub.i18n.core.admin.common.action.snooze.label',
	});

	/**
	 * Extracts URL from a link action payload, trying url → href → link keys in order.
	 *
	 * @param {any} payload - Action payload.
	 * @returns {string} Extracted URL or empty string.
	 */
	function extractLinkUrl(payload) {
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
			return '';
		}
		for (const key of ['url', 'href', 'link']) {
			const v = payload[key];
			if (typeof v === 'string' && v.trim()) {
				return v.trim();
			}
		}
		return '';
	}

	/**
	 * Returns true only for http:// or https:// URLs.
	 *
	 * @param {string} url - URL to check.
	 * @returns {boolean} True when url starts with http:// or https://.
	 */
	function isHttpUrl(url) {
		return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
	}

	/**
	 * Creates menu facade for one messages panel instance.
	 *
	 * @param {object} options - Factory options.
	 * @param {object} options.ui - UI API (`ctx.api.ui`).
	 * @param {Function} options.t - Translation function.
	 * @param {object} options.state - Shared state.
	 * @param {object} options.dataApi - Messages data facade.
	 * @param {Function} options.onQueryChanged - Callback after sort/filter change.
	 * @param {Function} options.openMessageJson - JSON overlay opener.
	 * @param {Function} options.openArchiveOverlay - Archive overlay opener.
	 * @param {Function} options.copyTextToClipboard - Clipboard helper.
	 * @param {Function} options.safeStr - Safe string helper.
	 * @param {Function} options.pick - Path getter.
	 * @param {Function} [options.isArchiveActionEnabled] - Archive action feature gate.
	 * @param {Function} [options.onActionExecute] - Callback invoked when a core action is selected: `(ref, actionId, actionType) => void`.
	 * @param {Function} [options.onLinkOpen] - Callback invoked when a link action is selected: `(url) => void`.
	 * @returns {{openHeaderSortMenu:Function, openHeaderFilterMenu:Function, openRowContextMenu:Function}} Menu facade.
	 */
	function createMessagesMenus(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const ui = opts.ui;
		const t = opts.t;
		const state = opts.state;
		const dataApi = opts.dataApi;
		const onQueryChanged = typeof opts.onQueryChanged === 'function' ? opts.onQueryChanged : () => undefined;
		const openMessageJson = opts.openMessageJson;
		const openArchiveOverlay = opts.openArchiveOverlay;
		const copyTextToClipboard = opts.copyTextToClipboard;
		const safeStr = opts.safeStr;
		const pick = opts.pick;
		const isArchiveActionEnabled =
			typeof opts.isArchiveActionEnabled === 'function' ? opts.isArchiveActionEnabled : () => false;
		const onActionExecute = typeof opts.onActionExecute === 'function' ? opts.onActionExecute : null;
		const onLinkOpen = typeof opts.onLinkOpen === 'function' ? opts.onLinkOpen : null;

		/**
		 * Opens sort menu for one sortable header field.
		 *
		 * @param {HTMLElement} anchor - Anchor element.
		 * @param {{field:string}} optionsArg - Sort menu options.
		 */
		function openHeaderSortMenu(anchor, optionsArg) {
			const field = optionsArg && typeof optionsArg === 'object' ? optionsArg.field : undefined;
			const sortableField = typeof field === 'string' && field.trim() ? field.trim() : '';
			if (!sortableField) {
				return;
			}
			if (!ui?.contextMenu?.open) {
				return;
			}
			const isSorted = state.sortField === sortableField;

			/**
			 * Applies new sort state and triggers reload.
			 *
			 * @param {'asc'|'desc'} dir - Sort direction.
			 */
			const applySort = dir => {
				state.sortField = sortableField;
				state.sortDir = dir === 'desc' ? 'desc' : 'asc';
				state.pageIndex = 1;
				ui?.contextMenu?.close?.();
				onQueryChanged();
			};

			ui.contextMenu.open({
				anchorEl: anchor,
				placement: 'below-start',
				ariaLabel: 'Messages sort menu',
				items: [
					{
						label: t('msghub.i18n.core.admin.ui.messages.filter.sort.asc.action'),
						icon: 'sort-asc',
						primary: isSorted && state.sortDir === 'asc',
						onSelect: () => applySort('asc'),
					},
					{
						label: t('msghub.i18n.core.admin.ui.messages.filter.sort.desc.action'),
						icon: 'sort-desc',
						primary: isSorted && state.sortDir === 'desc',
						onSelect: () => applySort('desc'),
					},
				],
			});
		}

		/**
		 * Opens filter menu for one column filter.
		 *
		 * @param {HTMLElement} anchor - Anchor element.
		 * @param {object} optionsArg - Filter menu options.
		 * @param {string} optionsArg.key - Filter key.
		 * @param {Array<string>} optionsArg.options - Filter options list.
		 * @param {Set<string>} [optionsArg.selected] - Optional external selected set.
		 * @param {boolean} [optionsArg.autoOpenSubmenu] - Whether submenu should open immediately.
		 */
		function openHeaderFilterMenu(anchor, optionsArg) {
			const menuOptions = optionsArg && typeof optionsArg === 'object' ? optionsArg : {};
			const filterKey = typeof menuOptions.key === 'string' ? menuOptions.key : '';
			if (!filterKey || !ui?.contextMenu?.open) {
				return;
			}

			const list = Array.isArray(menuOptions.options) ? menuOptions.options : [];
			const selected =
				menuOptions.selected instanceof Set
					? menuOptions.selected
					: new Set(dataApi.getFilterSet(filterKey) || []);
			const autoOpenSubmenu = menuOptions.autoOpenSubmenu === true;

			const sortableField =
				filterKey === 'kind' ||
				filterKey === 'lifecycle.state' ||
				filterKey === 'level' ||
				filterKey === 'origin.system' ||
				filterKey === 'details.location'
					? filterKey
					: null;

			/**
			 * Applies current selected filter values and reloads data.
			 */
			const applyAndReload = () => {
				dataApi.setFilterSet(filterKey, new Set(selected));
				state.pageIndex = 1;
				ui?.contextMenu?.close?.();
				onQueryChanged();
			};

			/**
			 * Applies sort from inside filter menu.
			 *
			 * @param {'asc'|'desc'} dir - Sort direction.
			 */
			const applySort = dir => {
				if (!sortableField) {
					return;
				}
				state.sortField = sortableField;
				state.sortDir = dir === 'desc' ? 'desc' : 'asc';
				state.pageIndex = 1;
				ui?.contextMenu?.close?.();
				onQueryChanged();
			};

			const submenuId = `messages-filter:${filterKey}`;

			/**
			 * Reopens same submenu to keep UX consistent after select all/none.
			 */
			const reopenSubmenu = () =>
				openHeaderFilterMenu(anchor, { key: filterKey, options: list, selected, autoOpenSubmenu: true });

			const filterItems = [];
			for (const value of list) {
				const label = dataApi.renderFilterValueLabel(filterKey, value) || String(value);
				filterItems.push({
					type: 'checkbox',
					label,
					checked: selected.has(value),
					onToggle: isChecked => {
						if (isChecked) {
							selected.add(value);
						} else {
							selected.delete(value);
						}
					},
				});
			}

			filterItems.push(
				{ type: 'separator' },
				{
					label: t('msghub.i18n.core.admin.ui.messages.filter.selectAll.action'),
					onSelect: () => {
						for (const value of list) {
							selected.add(value);
						}
						reopenSubmenu();
					},
				},
				{
					label: t('msghub.i18n.core.admin.ui.messages.filter.selectNone.action'),
					onSelect: () => {
						selected.clear();
						reopenSubmenu();
					},
				},
				{
					label: t('msghub.i18n.core.admin.ui.messages.filter.apply.action'),
					icon: 'filter',
					primary: true,
					onSelect: applyAndReload,
				},
			);

			const items = [];
			if (sortableField) {
				const isSorted = state.sortField === sortableField;
				items.push(
					{
						label: t('msghub.i18n.core.admin.ui.messages.filter.sort.asc.action'),
						icon: 'sort-asc',
						primary: isSorted && state.sortDir === 'asc',
						onSelect: () => applySort('asc'),
					},
					{
						label: t('msghub.i18n.core.admin.ui.messages.filter.sort.desc.action'),
						icon: 'sort-desc',
						primary: isSorted && state.sortDir === 'desc',
						onSelect: () => applySort('desc'),
					},
					{ type: 'separator' },
				);
			}
			items.push({
				id: submenuId,
				label: t('msghub.i18n.core.admin.ui.messages.filter.submenu.label'),
				primary: selected.size > 0,
				items: filterItems,
			});

			ui.contextMenu.open({
				anchorEl: anchor,
				placement: 'below-start',
				ariaLabel: 'Messages filter menu',
				items,
			});

			if (!autoOpenSubmenu) {
				return;
			}
			win.setTimeout(() => {
				try {
					const btn = Array.from(document.querySelectorAll('button[role="menuitem"]')).find(
						node => node instanceof HTMLButtonElement && node.dataset?.msghubContextmenuId === submenuId,
					);
					if (btn instanceof HTMLButtonElement) {
						btn.click();
					}
				} catch {
					// Ignore delayed submenu open failures.
				}
			}, 0);
		}

		/**
		 * Creates the shared copy submenu items for one message object.
		 *
		 * @param {object} msg - Message row object.
		 * @returns {Array<object>} Copy submenu items.
		 */
		function buildCopyMenuItems(msg) {
			const ref = safeStr(pick(msg, 'ref'));

			/**
			 * Serializes message to pretty JSON string.
			 *
			 * @returns {string} JSON text.
			 */
			const msgJson = () => {
				try {
					return JSON.stringify(msg, null, 2);
				} catch {
					return String(msg);
				}
			};

			return [
				{
					id: 'copyJson',
					label: t('msghub.i18n.core.admin.ui.messages.contextMenu.copyJson.action'),
					onSelect: () =>
						copyTextToClipboard(msgJson()).then(() =>
							ui?.toast?.({
								text: t('msghub.i18n.core.admin.ui.messages.contextMenu.copyJson.toast'),
								variant: 'ok',
							}),
						),
				},
				{
					id: 'copyRef',
					label: t('msghub.i18n.core.admin.ui.messages.contextMenu.copyRef.action'),
					onSelect: () =>
						copyTextToClipboard(ref).then(() =>
							ui?.toast?.({
								text: t('msghub.i18n.core.admin.ui.messages.contextMenu.copyRef.toast'),
								variant: 'ok',
							}),
						),
				},
				{
					id: 'copyTitle',
					label: t('msghub.i18n.core.admin.ui.messages.contextMenu.copyTitle.action'),
					onSelect: () =>
						copyTextToClipboard(safeStr(pick(msg, 'title'))).then(() =>
							ui?.toast?.({
								text: t('msghub.i18n.core.admin.ui.messages.contextMenu.copyTitle.toast'),
								variant: 'ok',
							}),
						),
				},
				{
					id: 'copyText',
					label: t('msghub.i18n.core.admin.ui.messages.contextMenu.copyText.action'),
					onSelect: () =>
						copyTextToClipboard(safeStr(pick(msg, 'text'))).then(() =>
							ui?.toast?.({
								text: t('msghub.i18n.core.admin.ui.messages.contextMenu.copyText.toast'),
								variant: 'ok',
							}),
						),
				},
			];
		}

		/**
		 * Opens row context menu at pointer location.
		 *
		 * @param {MouseEvent} event - Contextmenu event.
		 * @param {object} msg - Message row object.
		 */
		function openRowContextMenu(event, msg) {
			const ref = safeStr(pick(msg, 'ref'));

			const archiveEnabled = isArchiveActionEnabled(msg) === true;

			const coreActions = Array.isArray(msg?.actions)
				? msg.actions.filter(
						a => a && typeof a.id === 'string' && a.id.trim() !== '' && CORE_ACTION_TYPES.has(a.type),
					)
				: [];
			const linkActions = Array.isArray(msg?.actions)
				? msg.actions.filter(a => {
						if (!a || a.type !== 'link') {
							return false;
						}
						return isHttpUrl(extractLinkUrl(a.payload));
					})
				: [];

			const actionsSubmenuItems = [
				...coreActions.map(a => ({
					id: `action-${a.id}`,
					label: t(ACTION_LABEL_KEYS[a.type] || a.type),
					onSelect: onActionExecute ? () => onActionExecute(msg.ref, a.id, a.type) : undefined,
				})),
				...linkActions.map(a => ({
					id: `link-${a.id}`,
					// Use payload.label when present; fall back to i18n key.
					label:
						a.payload && typeof a.payload.label === 'string' && a.payload.label.trim()
							? a.payload.label.trim()
							: t(ACTION_LABEL_KEYS.link),
					icon: 'link',
					onSelect: onLinkOpen ? () => onLinkOpen(extractLinkUrl(a.payload)) : undefined,
				})),
			];

			ui?.contextMenu?.open?.({
				anchorPoint: { x: event.clientX, y: event.clientY },
				ariaLabel: 'Message actions',
				placement: 'bottom-start',
				items: [
					{
						id: 'openJson',
						label: t('msghub.i18n.core.admin.ui.messages.contextMenu.openJson.action'),
						icon: 'open-json',
						onSelect: () => openMessageJson(msg),
					},
					{
						id: 'openArchive',
						label: t('msghub.i18n.core.admin.ui.messages.contextMenu.openArchive.action'),
						disabled: !archiveEnabled,
						icon: 'open-archive',
						onSelect: archiveEnabled ? () => openArchiveOverlay(ref) : undefined,
					},
					{ type: 'separator' },
					{
						id: 'actions',
						label: t('msghub.i18n.core.admin.ui.messages.contextMenu.actions.label'),
						icon: 'action',
						disabled: actionsSubmenuItems.length === 0,
						items: actionsSubmenuItems,
					},
					{
						id: 'copy',
						label: t('msghub.i18n.core.admin.ui.messages.contextMenu.copy.submenu.label'),
						items: buildCopyMenuItems(msg),
					},
				],
			});
		}

		/**
		 * Opens the JSON overlay copy menu at pointer position.
		 *
		 * @param {MouseEvent} event - Contextmenu event.
		 * @param {object} msg - Message row object.
		 */
		function openJsonOverlayContextMenu(event, msg) {
			if (!event || typeof event !== 'object' || !msg || typeof msg !== 'object') {
				return;
			}
			if (!ui?.contextMenu?.open) {
				return;
			}
			event?.preventDefault?.();
			ui.contextMenu.open({
				anchorPoint: { x: event.clientX, y: event.clientY },
				ariaLabel: 'Message copy actions',
				placement: 'bottom-start',
				items: buildCopyMenuItems(msg),
			});
		}

		return Object.freeze({
			openHeaderSortMenu,
			openHeaderFilterMenu,
			openRowContextMenu,
			openJsonOverlayContextMenu,
		});
	}

	win.MsghubAdminTabMessagesMenus = Object.freeze({
		createMessagesMenus,
	});
})();
