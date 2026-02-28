/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'NotifyStates',
	defaultEnabled: true,
	supportsMultiple: false,
	supportsChannelRouting: true,
	title: { en: 'State notifier', de: 'State-Notifier' },
	description: {
		en: 'Writes notification events into ioBroker states (Latest / byKind / byLevel / Stats).',
		de: 'Schreibt Notification-Events in ioBroker-States (Latest / byKind / byLevel / Stats).',
	},
	options: {
		blobIntervalMs: {
			order: 10,
			type: 'number',
			unit: 'ms',
			label: { en: 'Full JSON interval', de: 'Full-JSON-Intervall' },
			help: {
				en: 'Interval for writing *.fullJson snapshots. 0 = disabled.',
				de: 'Intervall für *.fullJson Snapshots. 0 deaktiviert.',
			},
			min: 0,
			max: 1000 * 60 * 60 * 24,
			step: 1000,
			default: 1000 * 60 * 5,
		},
		statsMinIntervalMs: {
			order: 20,
			type: 'number',
			unit: 'ms',
			label: { en: 'Stats min interval', de: 'Stats Min-Intervall' },
			help: {
				en: 'Throttle statistics-updates triggered by notifications. 0 = disabled throttling.',
				de: 'Drosselt Stats-Updates bei Notifications. 0 deaktiviert Drosselung.',
			},
			min: 0,
			max: 1000 * 60 * 10,
			step: 50,
			default: 1000,
		},
		statsMaxIntervalMs: {
			order: 30,
			type: 'number',
			unit: 'ms',
			label: { en: 'Stats max interval', de: 'Stats Max-Intervall' },
			help: {
				en: 'Force periodic stats refresh even without notifications. 0 = disabled.',
				de: 'Erzwingt periodisches Stats-Refresh auch ohne Notifications. 0 deaktiviert.',
			},
			min: 0,
			max: 1000 * 60 * 60 * 24,
			step: 1000,
			default: 1000 * 60 * 5,
		},
		mapTypeMarker: {
			order: 90,
			type: 'string',
			label: { en: 'Map type marker', de: 'Map-Type-Marker' },
			help: {
				en: 'Overrides the marker used by serializeWithMaps (advanced).',
				de: 'Überschreibt den Marker von serializeWithMaps (advanced).',
			},
			default: '__msghubType',
		},
	},
});

module.exports = { manifest };
