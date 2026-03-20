/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'IngestStates',
	defaultEnabled: true,
	supportsMultiple: false,
	title: { en: 'ioBroker States (Custom rules)', de: 'ioBroker States (Custom-Regeln)' },
	description: {
		en: 'Generates MsgHub messages from ioBroker objects configured via “Custom” (Objects → Custom).',
		de: 'Erzeugt MsgHub-Messages aus ioBroker-Objekten, die über „Custom“ (Objekte → Custom) konfiguriert sind.',
	},
	adminUi: Object.freeze({
		apiVersion: '1',
		panels: Object.freeze([
			Object.freeze({
				id: 'presets',
				title: Object.freeze({ en: 'Presets', de: 'Vorlagen' }),
				description: Object.freeze({ en: 'Manage message presets', de: 'Nachrichten-Vorlagen verwalten' }),
				bundle: Object.freeze({ entry: 'admin-ui/dist/presets.esm.js', hash: '<sha256-placeholder>' }),
			}),
		]),
	}),
	options: {
		rescanIntervalMs: {
			order: 10,
			type: 'number',
			unit: 'ms',
			label: { en: 'Rescan interval', de: 'Rescan-Intervall' },
			help: {
				en: 'Polling interval to discover newly added Custom configs (0 = off).',
				de: 'Polling-Intervall um neue Custom-Konfigurationen zu entdecken (0 = aus).',
			},
			min: 0,
			max: 1000 * 60 * 60,
			step: 1000,
			default: 180000,
		},
		evaluateIntervalMs: {
			order: 20,
			type: 'number',
			unit: 'ms',
			label: { en: 'Evaluate interval', de: 'Evaluate-Intervall' },
			help: {
				en: 'Evaluation tick interval for rule checks (0 = only on events, where possible).',
				de: 'Evaluate-Tick-Intervall für Regel-Checks (0 = nur auf Events, wenn möglich).',
			},
			min: 0,
			max: 1000 * 60 * 60,
			step: 1000,
			default: 15000,
		},
		metricsMaxIntervalMs: {
			order: 30,
			type: 'number',
			unit: 'ms',
			label: { en: 'Metrics max interval', de: 'Metrics max. Intervall' },
			help: {
				en: 'Maximum interval for metrics updates while a message is active (0 = off).',
				de: 'Maximales Intervall für Metrics-Updates während eine Message aktiv ist (0 = aus).',
			},
			min: 0,
			max: 1000 * 60 * 60 * 3,
			step: 1000,
			default: 60000,
		},
		traceEvents: {
			order: 40,
			type: 'boolean',
			label: { en: 'Trace events (debug)', de: 'Events tracen (Debug)' },
			help: {
				en: 'Enable verbose debug logging for routing, state changes, and config diffs.',
				de: 'Aktiviert ausführliches Debug-Logging für Routing, State-Changes und Config-Diffs.',
			},
			default: false,
		},
	},
});

module.exports = { manifest };
