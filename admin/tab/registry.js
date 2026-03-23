/* global win */
'use strict';

/**
 * MsgHub Admin Tab: static registry for panels and compositions.
 *
 * Contents:
 * - `panels`: technical panel definitions (mount-id, title-key, assets, init-global).
 * - `compositions`: composed views (layout, panel order, default panel).
 *
 * Integration:
 * - Boot logic (`layout.js`, `boot.js`) reads exclusively from this structure.
 * - Minimises implicit coupling and keeps assets/view structure central.
 *
 * Interfaces:
 * - Writes `window.MsghubAdminTabRegistry` as a frozen object.
 * - Panels are not initialised here but later via `initGlobal`.
 *
 * Purpose:
 * - Single source of truth for the Admin-Tab information architecture.
 */
// IIFE prevents double-initialisation on accidental multiple loads.
(() => {
	if (win.MsghubAdminTabRegistry) {
		return;
	}

	const panels = Object.freeze({
		messages: Object.freeze({
			id: 'messages',
			mountId: 'messages-root',
			titleKey: 'msghub.i18n.core.admin.ui.tabs.messages.label',
			initGlobal: 'MsghubAdminTabMessages',
			assets: Object.freeze({
				css: Object.freeze(['tab/table.css', 'tab/panels/messages/styles.css']),
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
					'tab/panels/messages/index.js',
				]),
			}),
		}),

		plugins: Object.freeze({
			id: 'plugins',
			mountId: 'plugins-root',
			titleKey: 'msghub.i18n.core.admin.ui.tabs.plugins.label',
			initGlobal: 'MsghubAdminTabPlugins',
			assets: Object.freeze({
				css: Object.freeze(['tab/panels/plugins/styles.css']),
				js: Object.freeze([
					'tab/panels/plugins/state.js',
					'tab/panels/plugins/data.plugins.js',
					'tab/panels/plugins/render.form.js',
					'tab/panels/plugins/menus.js',
					'tab/panels/plugins/render.catalog.js',
					'tab/panels/plugins/render.instance.js',
					'tab/panels/plugins/index.js',
				]),
			}),
		}),
	});

	const compositions = Object.freeze({
		adminTab: Object.freeze({
			id: 'adminTab',
			layout: 'tabs',
			panels: Object.freeze([
				'messages',
				'plugins',
				Object.freeze({ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' }),
				Object.freeze({ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'bulkapply' }),
			]),
			defaultPanel: 'messages',
			deviceMode: 'pc',
		}),
	});

	win.MsghubAdminTabRegistry = Object.freeze({ panels, compositions });
})();
