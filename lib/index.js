'use strict';

const { NotifyStates } = require('./NotifyStates');
const { NotifyDebug } = require('./NotifyDebug');
const { EngageSendTo } = require('./EngageSendTo');

const IoPluginsCategories = Object.freeze({
	ingest: 'ingest',
	notify: 'notify',
	bridge: 'bridge',
	engage: 'engage',
});

/**
 * IoPlugins catalog
 * -------------
 * This is intentionally "hard-coded": it defines which plugin TYPES exist and how they are instantiated.
 *
 * Catalog entry shape
 * - `type`: stable string identifier used in config and in registration IDs.
 *   Convention: `type` is the literal factory/implementation name and therefore starts with `Ingest`, `Notify` or `Bridge`
 *   (e.g. `IngestIoBrokerStates`, `NotifyStates`).
 * - `label`: dev-facing label (informational only; no admin UI wiring).
 * - `defaultEnabled`: whether a new adapter instance enables the type by default.
 * - `supportsMultiple`: future flag to allow more than one instanceId per type.
 * - `defaultOptions`: fallback options used to seed per-plugin config objects (`obj.native`).
 * - `create(options)`: factory that returns a plugin handler instance.
 */
const IoPluginsCatalog = Object.freeze({
	// Note: use `new Array()` for empty lists so TS does not infer `never[]` in checkJs mode.
	// eslint-disable-next-line @typescript-eslint/no-array-constructor
	ingest: new Array(),
	notify: [
		{
			type: 'NotifyStates',
			label: 'Writes all notifications to ioBroker states (Latest / byKind / byLevel)',
			defaultEnabled: true,
			supportsMultiple: false, // supported on Plugin itself, but not on MsgHub
			defaultOptions: { statsMinIntervalMs: 1000, statsMaxIntervalMs: 1000 * 60 * 5 },
			create: NotifyStates,
		},
		{
			type: 'NotifyDebug',
			label: 'Debug notifier (logs notification dispatches)',
			defaultEnabled: false,
			supportsMultiple: false,
			defaultOptions: { trace: true, someText: 'this is a text within the pluign options' },
			create: NotifyDebug,
		},
	],
	// eslint-disable-next-line @typescript-eslint/no-array-constructor
	bridge: new Array(),
	engage: [
		{
			type: 'EngageSendTo',
			label: 'MsgHub control plane via ioBroker sendTo/messagebox',
			defaultEnabled: true,
			supportsMultiple: false,
			defaultOptions: {},
			create: EngageSendTo,
		},
	],
});

module.exports = {
	IoPluginsCategories,
	IoPluginsCatalog,
	NotifyStates,
	NotifyDebug,
	EngageSendTo,
};
