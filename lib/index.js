'use strict';

const { NotifyIoBrokerStates } = require('./NotifyIoBrokerStates');
const { IngestRandomDemo } = require('./IngestRandomDemo');
const { IngestIoBrokerStates } = require('./IngestIoBrokerStates');
const { BridgeRandomDemo } = require('./BridgeRandomDemo');

const MsgPluginsCategories = Object.freeze({
	ingest: 'ingest',
	notify: 'notify',
	bridge: 'bridge',
});

/**
 * MsgPlugins catalog
 * -------------
 * This is intentionally "hard-coded": it defines which plugin TYPES exist and how they are instantiated.
 *
 * Catalog entry shape
 * - `type`: stable string identifier used in config and in registration IDs.
 *   Convention: `type` is the literal factory/implementation name and therefore starts with `Ingest`, `Notify` or `Bridge`
 *   (e.g. `IngestIoBrokerStates`, `NotifyIoBrokerStates`).
 * - `label`: dev-facing label (informational only; no admin UI wiring).
 * - `defaultEnabled`: whether a new adapter instance enables the type by default.
 * - `supportsMultiple`: future flag to allow more than one instanceId per type.
 * - `defaultOptions`: fallback options used to seed per-plugin config objects (`obj.native`).
 * - `create(adapter, options)`: factory that returns a plugin handler instance.
 */
const MsgPluginsCatalog = Object.freeze({
	[MsgPluginsCategories.ingest]: [
		{
			type: 'IngestIoBrokerStates',
			label: 'Generates MsgHub messages from ioBroker objects configured via "Custom" (Objects → Custom)',
			defaultEnabled: true,
			supportsMultiple: false,
			defaultOptions: { traceEvents: true, rescanIntervalMs: 180000 },
			create: IngestIoBrokerStates,
		},
		{
			type: 'IngestRandomDemo',
			label: 'Demo producer that periodically generates random messages (development/testing)',
			defaultEnabled: false,
			supportsMultiple: false, // supported on Plugin itself, but not on MsgHub
			defaultOptions: { intervalMs: 15000, ttlMs: 120000, ttlJitter: 0.5, refPoolSize: 15 },
			create: IngestRandomDemo,
		},
	],
	[MsgPluginsCategories.notify]: [
		{
			type: 'NotifyIoBrokerStates',
			label: 'Writes all notifications to ioBroker states (Latest / byKind / byLevel)',
			defaultEnabled: true,
			supportsMultiple: false, // supported on Plugin itself, but not on MsgHub
			defaultOptions: {},
			create: NotifyIoBrokerStates,
		},
	],
	[MsgPluginsCategories.bridge]: [
		{
			type: 'BridgeRandomDemo',
			label: 'Demo bidirectional bridge: sync a MsgHub list message with ioBroker states (full sync template)',
			defaultEnabled: false,
			supportsMultiple: false,
			defaultOptions: {
				itemsChannel: 'Items',
				listKind: 'shoppinglist',
				resyncIntervalMs: 60000,
				cycleIntervalMs: 15000,
			},
			create: BridgeRandomDemo,
		},
	],
});

module.exports = {
	MsgPluginsCategories,
	MsgPluginsCatalog,
	NotifyIoBrokerStates,
	IngestRandomDemo,
	IngestIoBrokerStates,
	BridgeRandomDemo,
};
