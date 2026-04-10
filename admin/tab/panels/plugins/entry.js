/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/* global window, document */
/* Docs: ../../../../docs/ui/tab-panels-plugins-entry.md */
(function () {
	'use strict';

	/**
	 * Plugins Panel Entry
	 * ===================
	 * Host-owned entry definition for the AdminTab core Plugins panel.
	 *
	 * Docs: ../../../../docs/ui/tab-panels-plugins-entry.md
	 *
	 * Responsibilities
	 * - Publish the host-owned bootstrap definition (`css`, `js`, `panelInit(ctx)`).
	 * - Build the Plugins panel instance from the already-loaded submodule globals.
	 * - Keep the connect-refresh lifecycle and immediate contextmenu wiring local to the panel.
	 *
	 * Non-responsibilities
	 * - No backend contract ownership -> owned by `IoUiRegistry` / `IoUiCatalog`.
	 * - No shell/layout orchestration -> owned by `layout.js` / `boot.js`.
	 * - No plugin bundle host path -> owned by `plugin-ui-host.js`.
	 */

	const win = window;
	const currentScript = document.currentScript;
	const currentScriptTagName = String(currentScript?.tagName || currentScript?.nodeName || '').toLowerCase();
	if (!currentScript || currentScriptTagName !== 'script') {
		throw new Error('PluginsPanel: missing currentScript');
	}
	const script = currentScript;

	/**
	 * Initializes the Plugins core panel from the shared AdminTab runtime context.
	 *
	 * The function expects all Plugins submodules to have been loaded already through
	 * the `js` asset list exported by this entry.
	 *
	 * @param {object} ctx Frozen AdminTab panel runtime context.
	 * @returns {{ onConnect: Function, refreshPlugin: Function }} Panel lifecycle handle.
	 */
	function panelInit(ctx) {
		const elRoot = ctx?.elements?.pluginsRoot;
		if (!elRoot) {
			throw new Error('MsghubAdminTabPlugins: missing pluginsRoot element');
		}

		if (!win.MsghubAdminTabPluginsState) {
			throw new Error('MsghubAdminTabPlugins: missing MsghubAdminTabPluginsState');
		}
		if (!win.MsghubAdminTabPluginsData) {
			throw new Error('MsghubAdminTabPlugins: missing MsghubAdminTabPluginsData');
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
		const { createPluginsFormApi } = win.MsghubAdminTabPluginsForm;
		const { createPluginsMenusApi } = win.MsghubAdminTabPluginsMenus;
		const { createPluginsCatalogApi } = win.MsghubAdminTabPluginsCatalog;
		const { createPluginsInstanceApi } = win.MsghubAdminTabPluginsInstance;
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
		 * Shows a non-throwing toast notification through the shared shell UI.
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
		 * Opens the shared confirm dialog, with `window.confirm(...)` as a defensive fallback.
		 *
		 * @param {object} opts Confirm dialog options.
		 * @returns {Promise<boolean>} Resolves `true` only when the user confirmed.
		 */
		const confirmDialog = opts => {
			if (ui?.dialog?.confirm) {
				return ui.dialog.confirm(opts);
			}
			const text = typeof opts?.text === 'string' && opts.text.trim() ? opts.text : String(opts?.title || '');
			return Promise.resolve(window.confirm(text));
		};

		const pluginsDataApi = createPluginsDataApi({
			state: pluginsState,
			constantsApi: api.constants,
			pluginsApi: api.plugins,
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
		const instanceApi = createPluginsInstanceApi({
			h,
			t,
			cssSafe,
			pickText,
			formApi,
			catalogApi,
			openContextMenu: (e, scope) => menusApi.openPluginsContextMenu(e, scope),
			pluginsDataApi,
			ui,
			toast,
			confirmDialog,
			onRefreshAll: () => refreshAll(),
			adapterInstance,
		});

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
		 * Reloads the full plugin catalog and rerenders the panel shell.
		 *
		 * Connect-triggered refreshes are deduplicated for a short cooldown window.
		 * Overlapping refresh requests share one promise so the panel stays single-flight.
		 *
		 * @param {{ source?: 'connect'|'manual' }} [options] Refresh trigger metadata.
		 * @returns {Promise<void>} Completion promise for the active refresh.
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
		 * Triggers a manual refresh for one plugin type.
		 *
		 * The current core Plugins panel still refreshes the whole catalog, so `_type`
		 * is intentionally ignored at this layer.
		 *
		 * @param {string} _type Plugin type hint from callers.
		 * @returns {Promise<void>} Completion promise for the delegated refresh.
		 */
		async function refreshPlugin(_type) {
			return refreshAll({ source: 'manual' });
		}

		return {
			onConnect: () => refreshAll({ source: 'connect' }).catch(() => undefined),
			refreshPlugin: type => refreshPlugin(type).catch(() => undefined),
		};
	}

	script.__msghubCorePanelEntry = Object.freeze({
		css: Object.freeze(['tab/panels/plugins/styles.css']),
		js: Object.freeze([
			'tab/panels/plugins/state.js',
			'tab/panels/plugins/data.plugins.js',
			'tab/panels/plugins/render.form.js',
			'tab/panels/plugins/menus.js',
			'tab/panels/plugins/render.catalog.js',
			'tab/panels/plugins/render.instance.js',
		]),
		panelInit,
	});
})();
