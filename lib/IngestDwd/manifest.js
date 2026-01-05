/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'IngestDwd',
	defaultEnabled: false,
	supportsMultiple: true,
	supportsChannelRouting: false,
	title: { en: 'DWD warnings', de: 'DWD Warnungen' },
	description: {
		en: 'Imports weather warnings from the ioBroker dwd adapter (dwd.X.warning*.object) into Message Hub.',
		de: 'Importiert Wetterwarnungen aus dem ioBroker dwd Adapter (dwd.X.warning*.object) in den Message Hub.',
	},
	options: {
		dwdInstance: {
			order: 10,
			type: 'string',
			label: { en: 'DWD instance', de: 'DWD Instanz' },
			help: {
				en: 'Source adapter instance (example: "dwd.0").',
				de: 'Quell-Adapterinstanz (Beispiel: "dwd.0").',
			},
			default: 'dwd.0',
		},
		useAltitudeFilter: {
			order: 20,
			type: 'boolean',
			label: { en: 'Filter by altitude', de: 'Nach Höhenlage filtern' },
			help: {
				en: 'When enabled, only warnings whose altitudeStart/altitudeEnd include your altitude are imported.',
				de: 'Wenn aktiviert, werden nur Warnungen importiert, deren altitudeStart/altitudeEnd deine Höhenlage einschließen.',
			},
			default: false,
		},
		altitudeM: {
			order: 30,
			type: 'number',
			unit: 'm',
			label: { en: 'Your altitude (m)', de: 'Deine Höhenlage (m)' },
			help: {
				en: 'Used only when "Filter by altitude" is enabled.',
				de: 'Wird nur verwendet, wenn "Nach Höhenlage filtern" aktiviert ist.',
			},
			min: 0,
			max: 10000,
			step: 1,
			default: 0,
		},
		audienceTagsCsv: {
			order: 100,
			type: 'string',
			label: { en: 'Audience tags (CSV)', de: 'Audience Tags (CSV)' },
			help: {
				en: 'Comma-separated tags copied to message audience.tags.',
				de: 'Kommagetrennte Tags, die nach audience.tags kopiert werden.',
			},
			default: '',
		},
		audienceChannelsIncludeCsv: {
			order: 110,
			type: 'string',
			label: { en: 'Audience channels include (CSV)', de: 'Audience Channels include (CSV)' },
			help: {
				en: 'Comma-separated channels copied to message audience.channels.include.',
				de: 'Kommagetrennte Channels, die nach audience.channels.include kopiert werden.',
			},
			default: '',
		},
		audienceChannelsExcludeCsv: {
			order: 120,
			type: 'string',
			label: { en: 'Audience channels exclude (CSV)', de: 'Audience Channels exclude (CSV)' },
			help: {
				en: 'Comma-separated channels copied to message audience.channels.exclude.',
				de: 'Kommagetrennte Channels, die nach audience.channels.exclude kopiert werden.',
			},
			default: '',
		},
		aiEnhancement: {
			order: 200,
			type: 'boolean',
			label: { en: 'AI enhancement', de: 'AI Enhancement' },
			help: {
				en: 'Optionally summarizes description/instruction via MsgHub AI (cached).',
				de: 'Optional: fasst Beschreibung/Anweisung via MsgHub AI zusammen (gecached).',
			},
			default: false,
		},
		syncDebounceMs: {
			order: 300,
			type: 'number',
			unit: 'ms',
			label: { en: 'Sync debounce', de: 'Sync-Debounce' },
			help: {
				en: 'Debounce window for reading warning objects after state changes.',
				de: 'Debounce-Zeitfenster zum Einlesen der Warning-Objekte nach State-Änderungen.',
			},
			min: 0,
			max: 60_000,
			step: 10,
			default: 200,
		},
	},
});

module.exports = { manifest };

