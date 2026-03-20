/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/* global window */
(function () {
	'use strict';

	const win = window;

	/**
	 * Plugins panel orchestrator.
	 *
	 * Contains:
	 * - Module dependency guards for all nine plugins submodules.
	 * - Wiring of all submodule factories (state, data, form, menus, catalog, instance, overlays).
	 * - refreshAll() lifecycle: show non-blocking spinner, fetch data, render, hide spinner.
	 * - Direct contextmenu listener registration on elRoot at init time.
	 *
	 * Integration:
	 * - Loaded last after all plugins submodules (registry load order).
	 * - Exposes `window.MsghubAdminTabPlugins`.
	 *
	 * Interfaces:
	 * - `init(ctx)` → `{ onConnect, refreshPlugin }` lifecycle handle.
	 */

	/**
	 * Initializes the plugins panel and wires all submodule APIs.
	 *
	 * @param {object} ctx - Panel init context (frozen, provided by boot.js).
	 * @returns {{onConnect:Function,refreshPlugin:Function}} Panel lifecycle handle.
	 */
	function initPluginConfigSection(ctx) {
		const elRoot = ctx?.elements?.pluginsRoot;
		if (!elRoot) {
			throw new Error('MsghubAdminTabPlugins: missing pluginsRoot element');
		}

		// Module dependency guards — all loaded by registry before index.js.
		if (!win.MsghubAdminTabPluginsState) {
			throw new Error('MsghubAdminTabPlugins: missing MsghubAdminTabPluginsState');
		}
		if (!win.MsghubAdminTabPluginsData) {
			throw new Error('MsghubAdminTabPlugins: missing MsghubAdminTabPluginsData');
		}
		if (!win.MsghubAdminTabPluginsIngestStatesData) {
			throw new Error('MsghubAdminTabPlugins: missing MsghubAdminTabPluginsIngestStatesData');
		}
		if (!win.MsghubAdminTabPluginsForm) {
			throw new Error('MsghubAdminTabPlugins: missing MsghubAdminTabPluginsForm');
		}
		if (!win.MsghubAdminTabPluginsMenus) {
			throw new Error('MsghubAdminTabPlugins: missing MsghubAdminTabPluginsMenus');
		}
		if (!win.MsghubAdminTabPluginsCatalog) {
			throw new Error('MsghubAdminTabPlugins: missing MsghubAdminTabPluginsCatalog');
		}
		if (!win.MsghubAdminTabPluginsInstance) {
			throw new Error('MsghubAdminTabPlugins: missing MsghubAdminTabPluginsInstance');
		}
		if (!win.MsghubAdminTabPluginsBulkApply) {
			throw new Error('MsghubAdminTabPlugins: missing MsghubAdminTabPluginsBulkApply');
		}
		if (!win.MsghubAdminTabPluginsPresets) {
			throw new Error('MsghubAdminTabPlugins: missing MsghubAdminTabPluginsPresets');
		}

		const {
			cssSafe,
			isTextEditableTarget,
			CATEGORY_ORDER,
			CATEGORY_I18N,
			createPluginsState,
			pick,
			normalizeUnit,
			isUnitless,
			pickDefaultTimeUnit,
			getTimeFactor,
			TIME_UNITS,
		} = win.MsghubAdminTabPluginsState;
		const { createPluginsDataApi } = win.MsghubAdminTabPluginsData;
		const { createIngestStatesDataApi } = win.MsghubAdminTabPluginsIngestStatesData;
		const { createPluginsFormApi } = win.MsghubAdminTabPluginsForm;
		const { createPluginsMenusApi } = win.MsghubAdminTabPluginsMenus;
		const { createPluginsCatalogApi } = win.MsghubAdminTabPluginsCatalog;
		const { createPluginsInstanceApi } = win.MsghubAdminTabPluginsInstance;
		const { createPluginsBulkApplyApi } = win.MsghubAdminTabPluginsBulkApply;
		const { createPluginsPresetsApi } = win.MsghubAdminTabPluginsPresets;
		const pluginsState = createPluginsState();

		const adapterInstance = Number.isFinite(ctx?.adapterInstance) ? Math.trunc(ctx.adapterInstance) : 0;
		const adapterNamespace =
			typeof ctx?.adapterInstance === 'string' && ctx.adapterInstance.trim()
				? ctx.adapterInstance.trim()
				: `msghub.${adapterInstance}`;

		const api = ctx.api;
		const h = ctx.h;
		const pickText = api.i18n.pickText;
		const tOr = api.i18n.tOr;
		const t = api.i18n.t;
		const ui = api?.ui || ctx.ui;

		/**
		 * Shows a non-throwing toast notification.
		 *
		 * @param {string} text - Toast message text.
		 * @param {string} [variant] - Toast variant (neutral/danger/success).
		 */
		const toast = (text, variant = 'neutral') => {
			try {
				ui?.toast?.({ text: String(text), variant });
			} catch {
				// Ignore toast failures.
			}
		};

		/**
		 * Opens a confirm dialog. Falls back to window.confirm if ui.dialog is unavailable.
		 *
		 * @param {object} opts - Dialog options (title, text, confirmText, cancelText, danger).
		 * @returns {Promise<boolean>} Resolves true if the user confirmed.
		 */
		const confirmDialog = opts => {
			if (ui?.dialog?.confirm) {
				return ui.dialog.confirm(opts);
			}
			const text = typeof opts?.text === 'string' && opts.text.trim() ? opts.text : String(opts?.title || '');
			return Promise.resolve(window.confirm(text));
		};

		// Data layer: create plugin and ingest-states data facades.
		const pluginsDataApi = createPluginsDataApi({
			state: pluginsState,
			constantsApi: api.constants,
			pluginsApi: api.plugins,
		});
		const ingestStatesDataApi = createIngestStatesDataApi({
			state: pluginsState,
			ingestStatesApi: api.ingestStates,
		});
		const formApi = createPluginsFormApi({
			h,
			pickText,
			getConstants: () => pluginsState.cachedConstants,
			pick,
			normalizeUnit,
			isUnitless,
			pickDefaultTimeUnit,
			getTimeFactor,
			TIME_UNITS,
		});
		// menusApi.onRefreshAll is a lazy reference — refreshAll() is defined later.
		const menusApi = createPluginsMenusApi({
			elRoot,
			CATEGORY_I18N,
			tOr,
			t,
			ui,
			isTextEditableTarget,
			pluginsDataApi,
			onRefreshAll: () => refreshAll(),
		});
		// catalogApi.onRefreshAll is also a lazy reference — refreshAll() is defined later.
		const catalogApi = createPluginsCatalogApi({
			h,
			t,
			tOr,
			cssSafe,
			CATEGORY_ORDER,
			CATEGORY_I18N,
			getCategoryTitle: category => menusApi.getCategoryTitle(category),
			openContextMenu: (e, scope) => menusApi.openPluginsContextMenu(e, scope),
			pluginsDataApi,
			ui,
			toast,
			onRefreshAll: () => refreshAll(),
			elRoot,
			adapterNamespace,
		});
		const bulkApplyApi = createPluginsBulkApplyApi({
			h,
			toast,
			confirmDialog,
			ingestStatesDataApi,
			adapterNamespace,
		});
		const presetsApi = createPluginsPresetsApi({
			h,
			ui,
			confirmDialog,
			formApi,
			pickText,
			ingestStatesDataApi,
			t,
			getMsgConstants: () => pluginsState.cachedConstants,
		});
		// instanceApi.onRefreshAll is also a lazy reference — refreshAll() is defined later.
		const instanceApi = createPluginsInstanceApi({
			h,
			t,
			cssSafe,
			pickText,
			formApi,
			catalogApi,
			openContextMenu: (e, scope) => menusApi.openPluginsContextMenu(e, scope),
			pluginsDataApi,
			ingestStatesDataApi,
			ui,
			toast,
			confirmDialog,
			onRefreshAll: () => refreshAll(),
			adapterInstance,
			renderBulkApply: args => bulkApplyApi.renderIngestStatesBulkApply(args),
			renderPresets: args => presetsApi.renderIngestStatesMessagePresetsTool(args),
		});

		// Register contextmenu listener directly at init time (architectural fix: previously
		// registered as a side-effect inside ensurePluginReadmesLoaded on first readme load).
		elRoot.addEventListener('contextmenu', e => {
			try {
				if (e?.defaultPrevented) {
					return;
				}
				menusApi.openPluginsContextMenu(e, { kind: 'all' });
			} catch {
				// Ignore contextmenu handler errors.
			}
		});

		let refreshAllPromise = null;
		let lastConnectRefreshAt = 0;
		const CONNECT_REFRESH_DEDUP_MS = 1500;

		/**
		 * Reloads and re-renders the full plugin catalog.
		 *
		 * Shows a non-blocking spinner for the duration of the reload. Renders an
		 * inline error element on failure; always hides the spinner in the finally block.
		 *
		 * `onConnect()` may fire multiple times during boot/reconnect. We intentionally
		 * collapse overlapping connect-triggered refreshes and suppress immediate
		 * follow-up reconnect refreshes for a short cooldown window.
		 *
		 * @param {{ source?: 'connect'|'manual' }} [options] Refresh trigger metadata.
		 * @returns {Promise<void>} Completion promise.
		 */
		async function refreshAll(options) {
			const source = options?.source === 'connect' ? 'connect' : 'manual';
			const now = Date.now();
			if (refreshAllPromise) {
				return refreshAllPromise;
			}
			if (source === 'connect' && now - lastConnectRefreshAt < CONNECT_REFRESH_DEDUP_MS) {
				return;
			}

			refreshAllPromise = Promise.resolve()
				.then(async () => {
					const spinnerId =
						ui?.spinner?.show({ message: t('msghub.i18n.core.admin.panels.plugins.loading.text') }) ?? null;
					try {
						await pluginsDataApi.ensureConstantsLoaded();
						const expandedById = catalogApi.captureAccordionState();
						const { plugins } = await pluginsDataApi.getCatalog();
						const { instances } = await pluginsDataApi.listInstances();
						const readmesByType = await pluginsDataApi.ensurePluginReadmesLoaded();
						const vm = catalogApi.buildPluginsViewModel({ plugins, instances, readmesByType });
						const fragment = catalogApi.renderCatalog({
							vm,
							expandedById,
							readmesByType,
							renderInstanceRow: instanceApi.renderInstanceRow,
						});
						elRoot.replaceChildren(fragment);
					} catch (e) {
						elRoot.replaceChildren(
							h('div', {
								class: 'msghub-error',
								text: t('msghub.i18n.core.admin.ui.plugins.loadFailed.text', String(e?.message || e)),
							}),
						);
					} finally {
						if (spinnerId != null) {
							ui?.spinner?.hide(spinnerId);
						}
					}
				})
				.finally(() => {
					if (source === 'connect') {
						lastConnectRefreshAt = Date.now();
					}
					refreshAllPromise = null;
				});

			return refreshAllPromise;
		}

		/**
		 * Triggers a full refresh for a specific plugin type.
		 *
		 * Currently delegates to refreshAll. Reserved for future scoped per-type refresh.
		 *
		 * @param {string} _type - Plugin type (currently unused).
		 * @returns {Promise<void>} Completion promise.
		 */
		async function refreshPlugin(_type) {
			return refreshAll({ source: 'manual' });
		}

		return {
			onConnect: () => refreshAll({ source: 'connect' }).catch(() => undefined),
			refreshPlugin: type => refreshPlugin(type).catch(() => undefined),
		};
	}

	win.MsghubAdminTabPlugins = Object.freeze({
		init: initPluginConfigSection,
	});
})();
