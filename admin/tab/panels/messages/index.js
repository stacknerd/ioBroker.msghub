/* global window, document */
(function () {
	'use strict';

	const win = window;

	/**
	 * Messages panel entry/orchestrator.
	 *
	 * Contains:
	 * - Module wiring for state/data/render/lifecycle overlays.
	 * - Action handlers (refresh, delete, paging, auto mode).
	 * - Panel lifecycle contract (`init(ctx)` -> optional `onConnect()`).
	 *
	 * Integration:
	 * - Loaded last after all messages submodules.
	 * - Exposes `window.MsghubAdminTabMessages`.
	 */

	/**
	 * Copies text to clipboard with browser API + execCommand fallback.
	 *
	 * @param {string} text - Text to copy.
	 */
	async function copyTextToClipboard(text) {
		const value = typeof text === 'string' ? text : text == null ? '' : String(text);
		if (!value) {
			return;
		}
		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			await navigator.clipboard.writeText(value);
			return;
		}

		const ta = document.createElement('textarea');
		ta.value = value;
		ta.setAttribute('readonly', 'true');
		ta.setAttribute('aria-hidden', 'true');
		ta.style.position = 'fixed';
		ta.style.left = '-9999px';
		ta.style.top = '0';
		document.body.appendChild(ta);
		try {
			ta.focus();
			ta.select();
			const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
			if (!ok) {
				throw new Error('Copy not supported');
			}
		} finally {
			try {
				ta.remove();
			} catch {
				// Ignore textarea remove failures.
			}
		}
	}

	/**
	 * Initializes the messages panel.
	 *
	 * @param {object} ctx - Panel init context.
	 * @returns {{onConnect:Function}} Panel lifecycle handle.
	 */
	function initMessagesSection(ctx) {
		const { api, h, elements } = ctx;
		const root = elements.messagesRoot;
		if (!root) {
			throw new Error('MsghubAdminTabMessages: missing messagesRoot element');
		}

		const stateModule = win.MsghubAdminTabMessagesState;
		const dataModule = win.MsghubAdminTabMessagesDataMessages;
		const archiveDataModule = win.MsghubAdminTabMessagesDataArchive;
		const jsonOverlayModule = win.MsghubAdminTabMessagesOverlayJson;
		const archiveOverlayModule = win.MsghubAdminTabMessagesOverlayArchive;
		const menusModule = win.MsghubAdminTabMessagesMenus;
		const tableRenderModule = win.MsghubAdminTabMessagesRenderTable;
		const headerRenderModule = win.MsghubAdminTabMessagesRenderHeader;
		const metaRenderModule = win.MsghubAdminTabMessagesRenderMeta;
		const lifecycleModule = win.MsghubAdminTabMessagesLifecycle;

		if (!stateModule?.createMessagesState) {
			throw new Error('MsghubAdminTabMessages: state module is missing');
		}
		if (!dataModule?.createMessagesDataApi) {
			throw new Error('MsghubAdminTabMessages: data.messages module is missing');
		}
		if (!archiveDataModule?.createArchiveDataApi) {
			throw new Error('MsghubAdminTabMessages: data.archive module is missing');
		}
		if (!jsonOverlayModule?.createJsonOverlay) {
			throw new Error('MsghubAdminTabMessages: overlay.json module is missing');
		}
		if (!archiveOverlayModule?.createArchiveOverlay) {
			throw new Error('MsghubAdminTabMessages: overlay.archive module is missing');
		}
		if (!menusModule?.createMessagesMenus) {
			throw new Error('MsghubAdminTabMessages: menus module is missing');
		}
		if (!tableRenderModule?.createTableRenderer) {
			throw new Error('MsghubAdminTabMessages: render.table module is missing');
		}
		if (!headerRenderModule?.createHeaderRenderer) {
			throw new Error('MsghubAdminTabMessages: render.header module is missing');
		}
		if (!metaRenderModule?.createMetaRenderer) {
			throw new Error('MsghubAdminTabMessages: render.meta module is missing');
		}
		if (!lifecycleModule?.createLifecycle) {
			throw new Error('MsghubAdminTabMessages: lifecycle module is missing');
		}

		const state = stateModule.createMessagesState();
		const detectExpertMode = stateModule.detectExpertMode;
		const isObject = stateModule.isObject;
		const safeStr = stateModule.safeStr;
		const pick = stateModule.pick;
		const policyFormatTs = ts => api?.time?.formatTs?.(ts) || '';
		stateModule.setFormatTsFormatter?.(policyFormatTs);
		const formatTs = stateModule.formatTs;
		const ui = api?.ui || ctx.ui;
		const t = api.i18n.t;

		/**
		 * Shows a non-throwing toast message.
		 *
		 * @param {string} message - Toast message.
		 */
		const toast = message => {
			try {
				ui?.toast?.(String(message));
			} catch {
				// Ignore toast failures.
			}
		};

		const dataApi = dataModule.createMessagesDataApi({
			api,
			state,
			pick,
			safeStr,
			isObject,
		});

		const archiveDataApi = archiveDataModule.createArchiveDataApi({ api });

		const jsonOverlayApi = jsonOverlayModule.createJsonOverlay({
			ui,
			getServerTimeZone: () => state.serverTz,
			formatDate: date => api?.time?.formatDate?.(date) || '',
			getLevelLabel: dataApi.getLevelLabel,
		});

		const archiveOverlayApi = archiveOverlayModule.createArchiveOverlay({ ui, t });

		/**
		 * Applies row selection state to DOM rows and checkboxes.
		 */
		function syncSelectionUi() {
			try {
				const rows = Array.from(metaApi.elements.tbodyEl.querySelectorAll('tr'));
				for (const tr of rows) {
					const rowRef = String(tr.getAttribute('data-ref') || '');
					const selected = !!rowRef && state.selectedRefs.has(rowRef);
					tr.classList.toggle('is-selected', selected);
					try {
						const input = tr.querySelector('input[type="checkbox"]');
						if (input) {
							input.checked = selected;
						}
					} catch {
						// Ignore per-row checkbox access errors.
					}
				}
			} catch {
				// Ignore table traversal errors.
			}
			updateSelectAllCheckboxState();
		}
		state.syncSelectionUI = syncSelectionUi;

		/**
		 * Updates select-all checkbox from current table selection.
		 */
		function updateSelectAllCheckboxState() {
			if (!state.expertMode || !state.headerSelectAllInput) {
				return;
			}
			try {
				const refs = Array.from(metaApi.elements.tbodyEl.querySelectorAll('tr[data-ref]'))
					.map(tr => String(tr.getAttribute('data-ref') || '').trim())
					.filter(Boolean);
				const selectedCount = refs.reduce((sum, ref) => sum + (state.selectedRefs.has(ref) ? 1 : 0), 0);
				state.headerSelectAllInput.indeterminate = selectedCount > 0 && selectedCount < refs.length;
				state.headerSelectAllInput.checked = refs.length > 0 && selectedCount === refs.length;
			} catch {
				// Ignore select-all state calculation errors.
			}
		}

		/**
		 * Removes selection references that are not visible in current tbody.
		 */
		function pruneSelectionToVisibleRows() {
			if (!state.expertMode) {
				return;
			}
			try {
				const visible = new Set(
					Array.from(metaApi.elements.tbodyEl.querySelectorAll('tr[data-ref]'))
						.map(tr => String(tr.getAttribute('data-ref') || '').trim())
						.filter(Boolean),
				);
				let changed = false;
				for (const ref of Array.from(state.selectedRefs)) {
					if (!visible.has(ref)) {
						state.selectedRefs.delete(ref);
						changed = true;
					}
				}
				if (changed) {
					metaApi.updateDeleteButton();
				}
			} catch {
				// Ignore prune errors.
			}
		}

		/**
		 * Opens archive overlay with current cached archive state.
		 *
		 * @param {string} ref - Message ref.
		 */
		function openArchiveOverlay(ref) {
			state.archiveActiveRef = ref;
			state.archiveMode = 'follow';
			state.archivePendingNewCount = 0;
			const cachedItems = state.archiveItemsByRef.get(ref) || [];
			archiveOverlayApi.openArchiveOverlay(ref);
			archiveOverlayApi.renderArchiveView({
				ref,
				mode: state.archiveMode,
				pendingNewCount: state.archivePendingNewCount,
				hasMoreBackward: state.archiveHasMoreBackward,
				hasMoreForward: state.archiveHasMoreForward,
				items: cachedItems,
			});
			// Keep cursor contracts normalized even before backend integration is enabled.
			state.archiveEdgeOldest = archiveDataApi.normalizeCursorEdge(state.archiveEdgeOldest);
			state.archiveEdgeNewest = archiveDataApi.normalizeCursorEdge(state.archiveEdgeNewest);
		}

		/**
		 * Triggers list reload after sort/filter changes.
		 */
		function onQueryChanged() {
			headerApi.updateHeaderButtons();
			loadMessages({ silent: false }).catch(() => undefined);
		}

		const menusApi = menusModule.createMessagesMenus({
			ui,
			t,
			state,
			dataApi,
			onQueryChanged,
			openMessageJson: jsonOverlayApi.openMessageJson,
			openArchiveOverlay,
			copyTextToClipboard,
			safeStr,
			pick,
			// Archive action remains visible but disabled in this refactor step.
			isArchiveActionEnabled: () => false,
		});

		const metaApi = metaRenderModule.createMetaRenderer({
			h,
			t,
			state,
			onRefresh: () => loadMessages({ silent: false }).catch(() => undefined),
			onDelete: () => {
				handleDeleteSelection().catch(() => undefined);
			},
			onToggleAuto: () => {
				state.autoRefresh = !state.autoRefresh;
				metaApi.updateButtons();
				lifecycleApi.scheduleAuto();
			},
			onPrevPage: () => {
				state.pageIndex = Math.max(1, state.pageIndex - 1);
				loadMessages({ silent: false }).catch(() => undefined);
			},
			onNextPage: () => {
				state.pageIndex = Math.min(state.pages || 1, state.pageIndex + 1);
				loadMessages({ silent: false }).catch(() => undefined);
			},
			onPageSizeChanged: nextSize => {
				state.pageSize = nextSize;
				state.pageIndex = 1;
				loadMessages({ silent: false }).catch(() => undefined);
			},
		});

		const headerApi = headerRenderModule.createHeaderRenderer({
			h,
			t,
			state,
			dataApi,
			menusApi,
			colgroupEl: metaApi.elements.colgroupEl,
			theadEl: metaApi.elements.theadEl,
			tbodyEl: metaApi.elements.tbodyEl,
			onSelectionChanged: () => {
				syncSelectionUi();
				metaApi.updateDeleteButton();
			},
		});

		const tableApi = tableRenderModule.createTableRenderer({
			h,
			api,
			state,
			safeStr,
			pick,
			formatTs,
			getLevelLabel: dataApi.getLevelLabel,
			openMessageJson: jsonOverlayApi.openMessageJson,
			openRowContextMenu: menusApi.openRowContextMenu,
			onSelectionChanged: () => {
				syncSelectionUi();
				metaApi.updateDeleteButton();
			},
		});

		const lifecycleApi = lifecycleModule.createLifecycle({
			state,
			root,
			ui,
			onRefreshFollow: () => loadMessages({ keepPopover: true, silent: true }),
			onRefreshBrowsePending: () => Promise.resolve(undefined),
		});

		metaApi.mount(root);
		headerApi.renderThead();

		/**
		 * Applies full panel render pass.
		 *
		 * @param {object} [optionsArg] - Render options.
		 * @param {boolean} [optionsArg.forceRows] - Force row redraw while loading.
		 */
		function render(optionsArg = {}) {
			const forceRows = optionsArg.forceRows === true;
			metaApi.updateButtons();
			headerApi.updateHeaderButtons();
			metaApi.updatePaging();

			metaApi.setProgressVisible(state.loading && !state.silentLoading);
			metaApi.setError(state.lastError ? String(state.lastError) : null);

			const meta = isObject(state.lastMeta) ? state.lastMeta : {};
			const generatedAt = formatTs(meta.generatedAt) || 'n/a';
			const tz = typeof meta.tz === 'string' && meta.tz.trim() ? meta.tz.trim() : null;
			const policyTimeZone = String(api?.time?.getPolicy?.()?.timeZone || '').trim();
			state.serverTz = policyTimeZone || tz;
			metaApi.setMeta(
				`generatedAt: ${generatedAt}`,
				tz ? `tz: ${tz}` : policyTimeZone ? `tz: ${policyTimeZone}` : 'tz: n/a',
				`messages: ${state.items.length} / ${state.total}`,
			);

			const showEmpty = !state.loading && !state.lastError && state.items.length === 0;
			metaApi.setEmptyVisible(showEmpty);

			if (!state.hasLoadedOnce && state.loading) {
				metaApi.updateTbody([], { showLoadingRow: true });
				return;
			}
			if (state.loading && !forceRows) {
				return;
			}

			metaApi.updateTbody(tableApi.renderRows(state.items));
			pruneSelectionToVisibleRows();
			syncSelectionUi();
		}

		/**
		 * Loads constants for enum mappings.
		 */
		async function loadConstants() {
			await dataApi.loadConstants();
		}

		/**
		 * Loads one messages page from backend and updates shared state.
		 *
		 * @param {object} [optionsArg] - Loading options.
		 * @param {boolean} [optionsArg.keepPopover] - Reserved compatibility option.
		 * @param {boolean} [optionsArg.silent] - Silent loading mode.
		 */
		async function loadMessages(optionsArg = {}) {
			void optionsArg.keepPopover;
			const silent = optionsArg.silent === true;
			const reqId = ++state.requestSeq;
			state.loading = true;
			state.silentLoading = silent;
			state.lastError = null;
			render({ forceRows: !state.hasLoadedOnce });

			try {
				const res = await dataApi.queryMessagesPage();
				if (reqId !== state.requestSeq) {
					return;
				}
				state.lastMeta = isObject(res?.meta) ? res.meta : null;
				state.items = Array.isArray(res?.items) ? res.items : [];
				state.total =
					typeof res?.total === 'number' && Number.isFinite(res.total)
						? Math.max(0, Math.trunc(res.total))
						: state.items.length;
				state.pages =
					typeof res?.pages === 'number' && Number.isFinite(res.pages)
						? Math.max(1, Math.trunc(res.pages))
						: 1;
				state.pageIndex = Math.min(Math.max(1, state.pageIndex), state.pages);
			} catch (e) {
				if (reqId !== state.requestSeq) {
					return;
				}
				state.lastError = String(e?.message || e);
				if (!state.silentLoading) {
					toast(state.lastError);
				}
			} finally {
				if (reqId === state.requestSeq) {
					state.loading = false;
					state.silentLoading = false;
					state.hasLoadedOnce = true;
					render({ forceRows: true });
				}
			}
		}

		/**
		 * Handles bulk deletion for current selection.
		 */
		async function handleDeleteSelection() {
			if (!state.expertMode) {
				return;
			}
			const refs = Array.from(state.selectedRefs);
			if (refs.length === 0) {
				return;
			}
			const text = t('msghub.i18n.core.admin.ui.messages.delete.confirm.text', refs.length);
			const ok = ui?.dialog?.confirm
				? await ui.dialog.confirm({
						title: t('msghub.i18n.core.admin.ui.messages.delete.confirm.title'),
						text,
						danger: true,
						confirmText: t('msghub.i18n.core.admin.ui.action.delete'),
						cancelText: t('msghub.i18n.core.admin.ui.action.cancel'),
					})
				: win.confirm(text);
			if (!ok) {
				return;
			}
			try {
				await dataApi.deleteMessages(refs);
				state.selectedRefs.clear();
				metaApi.updateDeleteButton();
				await loadMessages({ silent: false });
			} catch (err) {
				toast(String(err?.message || err));
			}
		}

		/**
		 * Applies expert mode and rebuilds dependent table UI state.
		 *
		 * @param {boolean} next - New expert mode flag.
		 */
		function applyExpertMode(next) {
			const on = next === true;
			if (state.expertMode === on) {
				return;
			}
			state.expertMode = on;
			const tab = root.closest('#tab-messages');
			tab?.classList?.toggle?.('is-expert', state.expertMode);
			if (!state.expertMode) {
				state.selectedRefs.clear();
			}
			headerApi.renderThead();
			metaApi.updateDeleteButton();
			render({ forceRows: true });
		}

		applyExpertMode(detectExpertMode());
		win.setInterval(() => applyExpertMode(detectExpertMode()), 1500);

		lifecycleApi.bindEvents();
		metaApi.updateDeleteButton();
		render();

		return {
			onConnect: async () => {
				await loadConstants();
				await loadMessages({ silent: false });
				lifecycleApi.scheduleAuto();
				return undefined;
			},
		};
	}

	win.MsghubAdminTabMessages = Object.freeze({
		init: initMessagesSection,
	});
})();
