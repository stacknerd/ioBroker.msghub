/* global window, document */
/* Docs: ../../../../docs/ui/tab-panels-messages-entry.md */
(function () {
	'use strict';

	/**
	 * Messages Panel Entry
	 * ====================
	 * Host-owned entry definition for the AdminTab core Messages panel.
	 *
	 * Docs: ../../../../docs/ui/tab-panels-messages-entry.md
	 *
	 * Responsibilities
	 * - Publish the host-owned bootstrap definition (`css`, `js`, `panelInit(ctx)`).
	 * - Build the Messages panel instance from the already-loaded submodule globals.
	 * - Keep panel-local render, selection, and connect lifecycle wiring inside the entry.
	 *
	 * Non-responsibilities
	 * - No backend view contract ownership -> owned by `IoUiRegistry` / `IoUiCatalog`.
	 * - No shell layout/bootstrap orchestration -> owned by `layout.js` / `boot.js`.
	 * - No plugin-panel hosting -> owned by `plugin-ui-host.js`.
	 */

	const win = window;
	const currentScript = document.currentScript;
	const currentScriptTagName = String(currentScript?.tagName || currentScript?.nodeName || '').toLowerCase();
	if (!currentScript || currentScriptTagName !== 'script') {
		throw new Error('MessagesPanel: missing currentScript');
	}
	const script = currentScript;

	/**
	 * Copies one text value to the clipboard, with `execCommand('copy')` fallback.
	 *
	 * @param {string} text Text to copy.
	 * @returns {Promise<void>} Resolves after the copy attempt completed.
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
	 * Initializes the Messages core panel from the shared AdminTab runtime context.
	 *
	 * The function expects all Messages submodules to have been loaded already through
	 * the `js` asset list exported by this entry.
	 *
	 * @param {object} ctx Frozen AdminTab panel runtime context.
	 * @returns {{ onConnect: Function }} Panel lifecycle handle.
	 */
	function panelInit(ctx) {
		const { api, h, elements } = ctx;
		const root = elements.messagesRoot;
		const argsExpert = ctx?.args?.expert;
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
		 * Shows a non-throwing toast message through the shared shell UI.
		 *
		 * @param {string} text Toast text.
		 * @param {string} [variant] Toast variant. Defaults to `neutral`.
		 * @returns {void}
		 */
		const toast = (text, variant = 'neutral') => {
			try {
				ui?.toast?.({ text: String(text), variant });
			} catch {
				// Ignore toast failures.
			}
		};

		/**
		 * Opens a validated action link in a separate browser tab.
		 *
		 * @param {string} url Validated target URL.
		 * @returns {void}
		 */
		const onLinkOpen = url => {
			win.open(url, '_blank', 'noopener,noreferrer');
		};

		/**
		 * Confirms and executes one core message action, then refreshes the current list.
		 *
		 * @param {string} ref Message reference.
		 * @param {string} actionId Canonical action id.
		 * @param {string} actionType Human-readable action type for UI messaging.
		 * @returns {Promise<void>} Resolves after confirmation, execution, and refresh handling completed.
		 */
		const onActionExecute = async (ref, actionId, actionType) => {
			const text = t('msghub.i18n.core.admin.ui.messages.action.confirm.text', actionType);
			const ok = ui?.dialog?.confirm
				? await ui.dialog.confirm({
						title: t('msghub.i18n.core.admin.ui.messages.action.confirm.title'),
						text,
						danger: actionType === 'delete',
						confirmText: t('msghub.i18n.core.admin.ui.action.execute'),
						cancelText: t('msghub.i18n.core.admin.ui.action.cancel'),
					})
				: win.confirm(text);
			if (!ok) {
				return;
			}
			try {
				await api.messages.executeAction({ ref, actionId });
				ui?.overlayLarge?.close?.();
				const refreshOk = await loadMessages({ silent: false });
				if (refreshOk) {
					toast(
						t('msghub.i18n.core.admin.ui.messages.action.executed.text', safeStr(actionType), safeStr(ref)),
						'ok',
					);
				}
			} catch (e) {
				const reason = safeStr(e?.message || e).trim();
				toast(
					reason
						? t(
								'msghub.i18n.core.admin.ui.messages.action.failedWithReason.text',
								safeStr(actionType),
								safeStr(ref),
								reason,
							)
						: t('msghub.i18n.core.admin.ui.messages.action.failed.text', safeStr(actionType), safeStr(ref)),
					'danger',
				);
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
		let menusApi = null;

		const jsonOverlayApi = jsonOverlayModule.createJsonOverlay({
			ui,
			t,
			getServerTimeZone: () => state.serverTz,
			formatDate: date => api?.time?.formatDate?.(date) || '',
			getLevelLabel: dataApi.getLevelLabel,
			openCopyContextMenu: (event, msg) => menusApi?.openJsonOverlayContextMenu?.(event, msg),
			onActionExecute,
			onLinkOpen,
		});

		const archiveOverlayApi = archiveOverlayModule.createArchiveOverlay({ ui, t });

		/**
		 * Mirrors the current selection state into the rendered row DOM.
		 *
		 * @returns {void}
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
		 * Recomputes the select-all checkbox state from the currently visible rows.
		 *
		 * @returns {void}
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
		 * Removes selected refs that are no longer visible in the current tbody render.
		 *
		 * @returns {void}
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
		 * Opens the archive overlay using the current archive cache snapshot for one message.
		 *
		 * @param {string} ref Message reference whose archive should be shown.
		 * @returns {void}
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
			state.archiveEdgeOldest = archiveDataApi.normalizeCursorEdge(state.archiveEdgeOldest);
			state.archiveEdgeNewest = archiveDataApi.normalizeCursorEdge(state.archiveEdgeNewest);
		}

		/**
		 * Applies query changes by refreshing header controls and reloading the current list.
		 *
		 * @returns {void}
		 */
		function onQueryChanged() {
			headerApi.updateHeaderButtons();
			loadMessages({ silent: false }).catch(() => undefined);
		}

		menusApi = menusModule.createMessagesMenus({
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
			isArchiveActionEnabled: () => false,
			onActionExecute,
			onLinkOpen,
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
			onFirstPage: () => {
				state.pageIndex = 1;
				loadMessages({ silent: false }).catch(() => undefined);
			},
			onPrevPage: () => {
				state.pageIndex = Math.max(1, state.pageIndex - 1);
				loadMessages({ silent: false }).catch(() => undefined);
			},
			onNextPage: () => {
				state.pageIndex = Math.min(state.pages || 1, state.pageIndex + 1);
				loadMessages({ silent: false }).catch(() => undefined);
			},
			onLastPage: () => {
				state.pageIndex = Math.max(1, state.pages || 1);
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
		 * Applies the current panel state to the visible Messages DOM shell.
		 *
		 * @param {{ forceRows?: boolean }} [optionsArg] Render options.
		 * @returns {void}
		 */
		function render(optionsArg = {}) {
			const forceRows = optionsArg.forceRows === true;
			metaApi.updateButtons();
			headerApi.updateHeaderButtons();
			metaApi.updatePaging();

			const meta = isObject(state.lastMeta) ? state.lastMeta : {};
			const generatedAt = formatTs(meta.generatedAt) || '';
			const tz = typeof meta.tz === 'string' && meta.tz.trim() ? meta.tz.trim() : null;
			const policy = api?.time?.getPolicy?.() || {};
			const policyTimeZone = String(policy.timeZone || '').trim();
			const policySource = String(policy.source || '').trim();
			state.serverTz = policyTimeZone || tz;
			metaApi.setMeta({
				generatedAtText: `${t('msghub.i18n.core.admin.ui.messages.meta.generatedAt.label')}: ${generatedAt}`,
				timeZone: policyTimeZone || state.serverTz || '',
				source: policySource || '',
			});

			const showEmpty = !state.loading && state.items.length === 0;
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
		 * Loads shared constants required by the Messages data facade.
		 *
		 * @returns {Promise<void>} Resolves when constants are available.
		 */
		async function loadConstants() {
			await dataApi.loadConstants();
		}

		/**
		 * Loads one messages page, updates the shared panel state, and rerenders the shell.
		 *
		 * Request ordering is guarded through `state.requestSeq`, so stale responses are ignored.
		 *
		 * @param {{ keepPopover?: boolean, silent?: boolean }} [optionsArg] Loading options.
		 * @returns {Promise<boolean|undefined>} `true` on the winning successful response, `false` on the winning failure, `undefined` for stale responses.
		 */
		async function loadMessages(optionsArg = {}) {
			void optionsArg.keepPopover;
			const silent = optionsArg.silent === true;
			const reqId = ++state.requestSeq;
			const spinnerId = silent
				? null
				: (ui?.spinner?.show({ message: t('msghub.i18n.core.admin.panels.messages.loading.text') }) ?? null);
			state.loading = true;
			state.silentLoading = silent;
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
				return true;
			} catch (e) {
				if (reqId !== state.requestSeq) {
					return false;
				}
				toast(String(e?.message || e), 'danger');
				return false;
			} finally {
				if (spinnerId != null) {
					ui?.spinner?.hide(spinnerId);
				}
				if (reqId === state.requestSeq) {
					state.loading = false;
					state.silentLoading = false;
					state.hasLoadedOnce = true;
					render({ forceRows: true });
				}
			}
		}

		/**
		 * Confirms and deletes the currently selected message refs.
		 *
		 * @returns {Promise<void>} Resolves after deletion and follow-up refresh handling completed.
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
				const refreshOk = await loadMessages({ silent: false });
				if (refreshOk) {
					toast(
						refs.length === 1
							? t('msghub.i18n.core.admin.ui.messages.delete.deleted.text', safeStr(refs[0]))
							: t('msghub.i18n.core.admin.ui.messages.delete.deletedMany.text', refs.length),
						'danger',
					);
				}
			} catch (err) {
				toast(String(err?.message || err), 'danger');
			}
		}

		/**
		 * Applies one expert-mode transition and rerenders the table-dependent UI state.
		 *
		 * @param {boolean} next Next expert-mode state.
		 * @returns {void}
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

		applyExpertMode(detectExpertMode(argsExpert));
		win.setInterval(() => applyExpertMode(detectExpertMode(argsExpert)), 1500);

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

	script.__msghubCorePanelEntry = Object.freeze({
		css: Object.freeze(['tab/panels/messages/styles.css']),
		js: Object.freeze([
			'tab/panels/messages/state.js',
			'tab/panels/messages/data.messages.js',
			'tab/panels/messages/data.archive.js',
			'tab/panels/messages/overlay.json.js',
			'tab/panels/messages/overlay.archive.js',
			'tab/panels/messages/menus.js',
			'tab/panels/messages/render.table.js',
			'tab/panels/messages/render.header.js',
			'tab/panels/messages/render.meta.js',
			'tab/panels/messages/lifecycle.js',
		]),
		panelInit,
	});
})();
