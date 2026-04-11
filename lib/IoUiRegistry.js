/**
 * IoUiRegistry
 * ============
 * Backend-owned UI registry for MsgHub shell metadata.
 *
 * Docs: ../docs/io/IoUiRegistry.md
 *
 * Responsibilities
 * - Hold the canonical native-panel metadata consumed by `web.view.get`.
 * - Hold the canonical composition metadata that defines shell layout/device defaults.
 * - Keep plugin-owned panels represented only as structured composition refs.
 *
 * Non-responsibilities
 * - No request validation or view resolution -> owned by `IoUiCatalog`.
 * - No frontend descriptor shaping -> owned by `admin/tab/layout.js`.
 * - No plugin discovery mirroring -> plugin-owned panels stay plugin-owned.
 */

'use strict';

/**
 * Build one frozen structured core-panel ref.
 *
 * @param {string} panelId Owner-local core panel id.
 * @returns {{ type: 'corePanel', panelId: string }} Frozen core-panel ref.
 */
function corePanelRef(panelId) {
	return Object.freeze({ type: 'corePanel', panelId });
}

/**
 * Canonical backend registry of native/core panels.
 *
 * Keys are owner-local panel ids.
 * Values carry the producer metadata that later becomes frontend `PanelDescriptor`s.
 */
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
	}),

	plugins: Object.freeze({
		id: 'plugins',
		label: 'msghub.i18n.core.admin.ui.tabs.plugins.label',
		category: 'admin',
	}),
});

/**
 * Canonical backend registry of shell compositions.
 *
 * Composition entries describe layout and panel membership only.
 * Materialized panel refs are structured on both sides:
 * `{ type: 'corePanel', panelId }` and `{ type: 'pluginPanel', ... }`.
 * The wildcard sentinel `'*'` remains an internal registry-only input for `full`.
 */
const compositions = Object.freeze({
	adminTab: Object.freeze({
		id: 'adminTab',
		layout: 'tabs',
		panels: Object.freeze([
			corePanelRef('messages'),
			corePanelRef('plugins'),
			Object.freeze({ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' }),
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
			corePanelRef('messages'),
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
		panels: Object.freeze([corePanelRef('messages')]),
		defaultPanel: 'messages',
		deviceMode: 'pc',
	}),
});

/**
 * Shared backend UI registry export.
 *
 * `panels` and `compositions` together form the backend-owned single source of truth
 * that `IoUiCatalog` resolves for `web.view.get`.
 */
const uiRegistry = Object.freeze({ panels, compositions });

module.exports = { uiRegistry };
