/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'NotifyPushover',
	defaultEnabled: false,
	supportsMultiple: true,
	supportsChannelRouting: true,
	title: { en: 'Pushover notifier', de: 'Pushover-Notifier' },
	description: {
		en: 'Sends MsgHub due notifications to a Pushover adapter instance via sendTo().',
		de: 'Sendet MsgHub-Due-Notifications per sendTo() an eine Pushover-Adapter-Instanz.',
	},
	options: {
		pushoverInstance: {
			order: 10,
			type: 'string',
			holdsInstanceTitle: true,
			label: { en: 'Pushover adapter instance', de: 'Pushover-Adapter-Instanz' },
			help: {
				en: 'Target adapter instance (e.g. pushover.0).',
				de: 'Ziel-Adapter-Instanz (z.B. pushover.0).',
			},
			default: 'pushover.0',
		},
		_headerFilter: {
			order: 20,
			type: 'header',
			label: { en: 'Filter setting', de: 'Filtereinstellungen' },
		},
		kindsCsv: {
			order: 21,
			type: 'string',
			label: { en: 'Kinds (CSV)', de: 'Kinds (CSV)' },
			help: {
				en: 'Filter by message.kind (CSV). Empty = allow all.',
				de: 'Filter nach message.kind (CSV). Leer = alle zulassen.',
			},
			multiOptions: 'MsgConstants.kind',
			default: '',
		},
		levelMin: {
			order: 30,
			type: 'number',
			label: { en: 'Level min', de: 'Level min' },
			help: {
				en: 'Minimum message level (inclusive).',
				de: 'Minimales Message-Level (inklusive).',
			},
			options: 'MsgConstants.level',
			default: 10,
		},
		levelMax: {
			order: 40,
			type: 'number',
			label: { en: 'Level max', de: 'Level max' },
			help: {
				en: 'Maximum message level (inclusive).',
				de: 'Maximales Message-Level (inklusive).',
			},
			options: 'MsgConstants.level',
			default: 50,
		},
		audienceTagsAnyCsv: {
			order: 60,
			type: 'string',
			label: { en: 'Audience tags (any, CSV)', de: 'Audience-Tags (any, CSV)' },
			help: {
				en: 'If set, only messages with at least one matching audience tag are sent.',
				de: 'Wenn gesetzt, werden nur Messages mit mindestens einem passenden Audience-Tag gesendet.',
			},
			default: '',
		},
		_headerGate: {
			order: 150,
			type: 'header',
			label: { en: 'Notification Gate', de: 'Benachrichtigungs-Gate' },
		},
		gateStateId: {
			order: 151,
			type: 'string',
			label: { en: 'Gate state id', de: 'Gate-State-ID' },
			help: {
				en: 'Optional: only send when this foreign state passes the gate evaluation.',
				de: 'Optional: sendet nur, wenn dieser Foreign-State die Gate-Auswertung besteht.',
			},
			default: '',
		},
		gateOp: {
			order: 160,
			type: 'string',
			label: { en: 'Gate op', de: 'Gate Operator' },
			help: {
				en: 'Gate comparison operator.',
				de: 'Gate-Vergleichsoperator.',
			},
			options: [
				{ label: { en: '(disabled)', de: '(deaktiviert)' }, value: '' },
				{ label: { en: 'is true', de: 'ist true' }, value: 'true' },
				{ label: { en: 'is false', de: 'ist false' }, value: 'false' },
				{ label: { en: '=', de: '=' }, value: '=' },
				{ label: { en: '>', de: '>' }, value: '>' },
				{ label: { en: '<', de: '<' }, value: '<' },
			],
			default: '',
		},
		gateValue: {
			order: 170,
			type: 'string',
			label: { en: 'Gate value', de: 'Gate-Wert' },
			help: {
				en: 'Value used for =, >, < comparisons.',
				de: 'Wert für Vergleiche =, >, <.',
			},
			default: '',
		},
		gateBypassFromLevel: {
			order: 180,
			type: 'number',
			label: { en: 'Gate bypass from level', de: 'Gate-Bypass ab Level' },
			help: {
				en: 'From this level (inclusive), the gate is bypassed.',
				de: 'Ab diesem Level (inklusive) wird das Gate ignoriert.',
			},
			options: 'MsgConstants.level',
			default: 50,
		},
		gateCheckinText: {
			order: 190,
			type: 'string',
			label: { en: 'Gate check-in text', de: 'Gate-Check-in-Text' },
			help: {
				en: 'Optional text sent when the gate opens (supports {id} templates).',
				de: 'Optionaler Text beim Oeffnen des Gates (unterstuetzt {id}-Templates).',
			},
			default: '',
		},
		gateCheckoutText: {
			order: 200,
			type: 'string',
			label: { en: 'Gate check-out text', de: 'Gate-Check-out-Text' },
			help: {
				en: 'Optional text sent when the gate closes (supports {id} templates).',
				de: 'Optionaler Text beim Schliessen des Gates (unterstuetzt {id}-Templates).',
			},
			default: '',
		},
	},
});

module.exports = { manifest };
