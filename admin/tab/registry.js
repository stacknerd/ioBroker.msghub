/* global win */
'use strict';

/**
 * MsgHub Admin Tab: static registry for panels and compositions.
 *
 * Docs: ../../docs/ui/tab-registry.md
 *
 * Contents:
 * - `panels`: producer-side panel definitions (`id`, `label`, `ui.kind`, `ui.loader`,
 *   `ui.initGlobal`, `ui.css`, `ui.js`). `id` is owner-local (`'messages'`, `'plugins'`), while
 *   the canonical external `tab-...` id is derived later by layout normalization.
 *   Semantic field `category` ('dashboard'|'user'|'admin'|...) is carried directly by the
 *   producer. Optional `app` data is also producer-owned:
 *   all text fields are i18n keys, `url` is the host-neutral single-panel target string
 *   (current contract: stable query params only), and `icons` contains slot -> filename
 *   mappings. Icon ownership stays panel-owned; the host resolves the final path
 *   deterministically from panel ownership + slot.
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
			label: 'msghub.i18n.core.admin.ui.tabs.messages.label',
			category: 'dashboard',
			app: Object.freeze({
				name: 'msghub.i18n.core.admin.panels.messages.app.name',
				shortName: 'msghub.i18n.core.admin.panels.messages.app.shortName',
				url: '?panel=tab-messages',
				display: 'standalone',
				themeColor: '#1f6a53',
				backgroundColor: '#ffffff',
				icons: Object.freeze({
					any192: 'messages-192.png',
					any512: 'messages-512.png',
					maskable192: 'messages-maskable-192.png',
					maskable512: 'messages-maskable-512.png',
					apple180: 'messages-apple-180.png',
				}),
			}),
			ui: Object.freeze({
				kind: 'core',
				loader: 'globals',
				initGlobal: 'MsghubAdminTabMessages',
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
					'tab/panels/messages/index.js',
				]),
			}),
		}),

		plugins: Object.freeze({
			id: 'plugins',
			label: 'msghub.i18n.core.admin.ui.tabs.plugins.label',
			category: 'admin',
			ui: Object.freeze({
				kind: 'core',
				loader: 'globals',
				initGlobal: 'MsghubAdminTabPlugins',
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
				//Object.freeze({ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'bulkapply' }),
			]),
			defaultPanel: 'messages',
			deviceMode: 'pc',
		}),
		full: Object.freeze({
			id: 'full',
			layout: 'tabs',
			panels: Object.freeze(['*']),
			defaultPanel: 'messages',
			deviceMode: 'pc',
		}),
		web: Object.freeze({
			id: 'web',
			layout: 'tabs',
			panels: Object.freeze([
				'messages',
				Object.freeze({ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' }),
			]),
			defaultPanel: 'messages',
			deviceMode: 'pc',
			app: Object.freeze({
				name: 'msghub.i18n.core.admin.webRoot.app.name',
				shortName: 'msghub.i18n.core.admin.webRoot.app.shortName',
				url: '?composition=web',
				display: 'standalone',
				themeColor: '#1f6a53',
				backgroundColor: '#ffffff',
				icons: Object.freeze({
					any192: 'web-192.png',
					any512: 'web-512.png',
					maskable192: 'web-maskable-192.png',
					maskable512: 'web-maskable-512.png',
					apple180: 'web-apple-180.png',
				}),
			}),
		}),
		messagesSingle: Object.freeze({
			id: 'messagesSingle',
			layout: 'single',
			panels: Object.freeze(['messages']),
			defaultPanel: 'messages',
			deviceMode: 'pc',
		}),
	});

	win.MsghubAdminTabRegistry = Object.freeze({ panels, compositions });
})();
