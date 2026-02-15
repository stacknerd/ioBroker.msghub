/* global win */
'use strict';

/**
 * MsgHub Admin Tab: statische Registry für Panels und Compositions.
 *
 * Inhalt:
 * - `panels`: technische Panel-Definitionen (Mount-ID, Titel-Key, Assets, Init-Global).
 * - `compositions`: zusammengesetzte Views (Layout, Panel-Reihenfolge, Default-Panel).
 *
 * Systemeinbindung:
 * - Die Boot-Logik (`layout.js`, `boot.js`) liest ausschließlich diese Struktur.
 * - Das minimiert implizite Kopplungen und hält Assets/View-Struktur zentral.
 *
 * Schnittstellen:
 * - Schreibt `window.MsghubAdminTabRegistry` als gefrorenes Objekt.
 * - Panels selbst werden nicht hier initialisiert, sondern später über `initGlobal`.
 *
 * Aufgabe:
 * - Single Source of Truth für die Admin-Tab-Informationsarchitektur.
 */
// IIFE verhindert doppelte Initialisierung beim versehentlichen Mehrfach-Load.
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
			mountId: 'plugins-root',
			titleKey: 'msghub.i18n.core.admin.ui.tabs.plugins.label',
			initGlobal: 'MsghubAdminTabPlugins',
			assets: Object.freeze({
				css: Object.freeze(['tab/panels/plugins/styles.css', 'tab/panels/plugins/ingeststates.css']),
				js: Object.freeze(['tab/panels/plugins/index.js']),
			}),
		}),
	});

	const compositions = Object.freeze({
		adminTab: Object.freeze({
			id: 'adminTab',
			layout: 'tabs',
			panels: Object.freeze(['messages', 'plugins']),
			defaultPanel: 'messages',
			deviceMode: 'pc',
		}),
	});

	win.MsghubAdminTabRegistry = Object.freeze({ panels, compositions });
})();
