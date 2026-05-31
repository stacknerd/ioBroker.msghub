/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'IngestHue',
	defaultEnabled: false,
	supportsMultiple: true,
	supportsChannelRouting: false,
	title: {
		en: 'Hue battery and reachability',
		de: 'Hue Batterie und Erreichbarkeit',
	},
	description: {
		en: 'Monitors Hue device battery levels and reachability states from a configured ioBroker Hue instance.',
		de: 'Überwacht Batteriestände und Erreichbarkeit von Hue-Geräten aus einer konfigurierten ioBroker-Hue-Instanz.',
	},
	options: {
		hueInstance: {
			order: 10,
			type: 'string',
			label: { en: 'Hue instance', de: 'Hue-Instanz' },
			help: {
				en: 'Source adapter instance (example: "hue.0").',
				de: 'Quell-Adapterinstanz (Beispiel: "hue.0").',
			},
			default: 'hue.0',
		},
		monitorBattery: {
			order: 20,
			type: 'boolean',
			label: { en: 'Report battery levels', de: 'Batteriezustände melden' },
			help: {
				en: 'Create tasks when Hue device batteries drop below the configured threshold.',
				de: 'Erstellt Aufgaben, wenn Hue-Gerätebatterien unter den konfigurierten Schwellwert fallen.',
			},
			default: true,
		},
		batteryCreateBelow: {
			order: 30,
			type: 'number',
			unit: '%',
			label: { en: 'Create below', de: 'Erstellen unter' },
			help: {
				en: 'Create or update the battery task when the battery level is below this value.',
				de: 'Erstellt oder aktualisiert die Batterie-Aufgabe, wenn der Batteriestand unter diesem Wert liegt.',
			},
			min: 0,
			max: 100,
			step: 1,
			default: 7,
		},
		batteryRemoveAbove: {
			order: 40,
			type: 'number',
			unit: '%',
			label: { en: 'Close at or above', de: 'Schließen ab' },
			help: {
				en: 'Close the battery task as cause-eliminated when the battery level reaches this value.',
				de: 'Schließt die Batterie-Aufgabe als Ursache-behoben, wenn der Batteriestand diesen Wert erreicht.',
			},
			min: 0,
			max: 100,
			step: 1,
			default: 30,
		},
		monitorReachable: {
			order: 50,
			type: 'boolean',
			label: { en: 'Report reachability problems', de: 'Erreichbarkeitsprobleme melden' },
			help: {
				en: 'Create status messages when selected Hue devices become unreachable.',
				de: 'Erstellt Statusmeldungen, wenn ausgewählte Hue-Geräte nicht erreichbar sind.',
			},
			default: true,
		},
		reachableAllowRolesCsv: {
			order: 60,
			type: 'string',
			label: { en: 'Reachability roles (CSV)', de: 'Erreichbarkeits-Rollen (CSV)' },
			help: {
				en: 'Comma-separated parent roles for reachable states. Empty means all roles.',
				de: 'Kommagetrennte Parent-Rollen für reachable-States. Leer bedeutet alle Rollen.',
			},
			default: 'ZLLSwitch, ZLLPresence',
		},
		rescanIntervalMs: {
			order: 70,
			type: 'number',
			unit: 'ms',
			label: { en: 'Rescan interval', de: 'Rescan-Intervall' },
			help: {
				en: 'Interval for rediscovering Hue devices. Use 0 to disable periodic rescans.',
				de: 'Intervall zum erneuten Erkennen von Hue-Geräten. 0 deaktiviert zyklische Rescans.',
			},
			min: 0,
			max: 24 * 60 * 60 * 1000,
			step: 1000,
			default: 60 * 60 * 1000,
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
	},
});

module.exports = { manifest };
