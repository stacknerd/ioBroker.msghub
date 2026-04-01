/* global win */
'use strict';

/**
 * MsgHub Admin Tab: static registry for panels and compositions.
 *
 * Docs: ../../docs/ui/tab-registry.md
 *
 * Contents:
 * - `panels`: canonical PanelDescriptor definitions (`id`, `label`, `ui.kind`, `ui.loader`,
 *   `ui.initGlobal`, `ui.css`, `ui.js`). Optional semantic fields: `surface` ('admin'|'web'|'both'
 *   — eligibility gate, not a security concept) and `category` ('dashboard'|'user'|'admin'|...
 *   — semantic group, basis for future accent coding; not a styling field). Both fields are
 *   optional and without default; absence means unrestricted / unclassified.
 *   Optional `app` block for panels that are installable as a PWA or surfaced in a standalone
 *   web context. Required within `app`: `name` (i18n key string), `url` (canonical URL string).
 *   Optional within `app`: `shortName` (falls back to `name` when absent), `themeColor` (CSS
 *   color string for the theme-color meta tag), `icons` (array; paths are package-root-relative
 *   per RFC-0012 — no host-side path assumptions). No existing core panel carries an `app`
 *   block; the field is reserved for future installable app panels. Object keys remain the
 *   short names used for composition references and asset loading (e.g. `'messages'`, `'plugins'`).
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
			id: 'tab-messages',
			label: 'msghub.i18n.core.admin.ui.tabs.messages.label',
			ui: Object.freeze({
				kind: 'core',
				loader: 'globals',
				initGlobal: 'MsghubAdminTabMessages',
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
			id: 'tab-plugins',
			label: 'msghub.i18n.core.admin.ui.tabs.plugins.label',
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
