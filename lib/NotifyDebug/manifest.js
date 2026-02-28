/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'NotifyDebug',
	defaultEnabled: false,
	supportsMultiple: false,
	supportsChannelRouting: true,
	title: { en: 'Debug notifier', de: 'Debug-Notifier' },
	description: {
		en: 'Logs notification dispatches (debugging / development only).',
		de: 'Loggt Notification-Dispatches (nur Debug/Entwicklung).',
	},
	options: {
		trace: {
			order: 10,
			type: 'boolean',
			label: { en: 'Trace logging', de: 'Trace-Logging' },
			help: { en: 'Enable debug logs for start/stop and dispatches.', de: 'Aktiviert Debug-Logs.' },
			default: false,
		},
		someText: {
			order: 20,
			type: 'string',
			label: { en: 'Demo text', de: 'Demo-Text' },
			help: { en: 'Optional demo value logged at startup.', de: 'Optionaler Demo-Wert beim Start.' },
			default: '',
		},
	},
});

module.exports = { manifest };
