/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'NotifyPushover',
	defaultEnabled: false,
	supportsMultiple: true,
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
		kindsCsv: {
			order: 20,
			type: 'string',
			label: { en: 'Kinds (CSV)', de: 'Kinds (CSV)' },
			help: {
				en: 'Filter by message.kind (CSV). Empty = allow all.',
				de: 'Filter nach message.kind (CSV). Leer = alle zulassen.',
			},
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
			min: 0,
			max: 30,
			step: 10,
			default: 0,
		},
		levelMax: {
			order: 40,
			type: 'number',
			label: { en: 'Level max', de: 'Level max' },
			help: {
				en: 'Maximum message level (inclusive).',
				de: 'Maximales Message-Level (inklusive).',
			},
			min: 0,
			max: 30,
			step: 10,
			default: 30,
		},
		lifecycleStatesCsv: {
			order: 50,
			type: 'string',
			label: { en: 'Lifecycle states (CSV)', de: 'Lifecycle-States (CSV)' },
			help: {
				en: 'Filter by message.lifecycle.state (CSV). Empty = allow all.',
				de: 'Filter nach message.lifecycle.state (CSV). Leer = alle zulassen.',
			},
			default: '',
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
		priorityNone: {
			order: 70,
			type: 'number',
			label: { en: 'Priority (none)', de: 'Priorität (none)' },
			help: {
				en: 'Pushover priority for level 0: -1 low, 0 normal, 1 high.',
				de: 'Pushover-Priorität für Level 0: -1 low, 0 normal, 1 high.',
			},
			min: -1,
			max: 1,
			step: 1,
			default: -1,
		},
		priorityNotice: {
			order: 80,
			type: 'number',
			label: { en: 'Priority (notice)', de: 'Priorität (notice)' },
			help: {
				en: 'Pushover priority for level 10: -1 low, 0 normal, 1 high.',
				de: 'Pushover-Priorität für Level 10: -1 low, 0 normal, 1 high.',
			},
			min: -1,
			max: 1,
			step: 1,
			default: -1,
		},
		priorityWarning: {
			order: 90,
			type: 'number',
			label: { en: 'Priority (warning)', de: 'Priorität (warning)' },
			help: {
				en: 'Pushover priority for level 20: -1 low, 0 normal, 1 high.',
				de: 'Pushover-Priorität für Level 20: -1 low, 0 normal, 1 high.',
			},
			min: -1,
			max: 1,
			step: 1,
			default: 0,
		},
		priorityError: {
			order: 100,
			type: 'number',
			label: { en: 'Priority (error)', de: 'Priorität (error)' },
			help: {
				en: 'Pushover priority for level 30: -1 low, 0 normal, 1 high.',
				de: 'Pushover-Priorität für Level 30: -1 low, 0 normal, 1 high.',
			},
			min: -1,
			max: 1,
			step: 1,
			default: 0,
		},
		iconNone: {
			order: 110,
			type: 'string',
			label: { en: 'Icon (none)', de: 'Icon (none)' },
			help: { en: 'Title prefix icon for level 0.', de: 'Titel-Präfix-Icon für Level 0.' },
			default: '❔',
		},
		iconNotice: {
			order: 120,
			type: 'string',
			label: { en: 'Icon (notice)', de: 'Icon (notice)' },
			help: { en: 'Title prefix icon for level 10.', de: 'Titel-Präfix-Icon für Level 10.' },
			default: 'ℹ️',
		},
		iconWarning: {
			order: 130,
			type: 'string',
			label: { en: 'Icon (warning)', de: 'Icon (warning)' },
			help: { en: 'Title prefix icon for level 20.', de: 'Titel-Präfix-Icon für Level 20.' },
			default: '⚠️',
		},
		iconError: {
			order: 140,
			type: 'string',
			label: { en: 'Icon (error)', de: 'Icon (error)' },
			help: { en: 'Title prefix icon for level 30.', de: 'Titel-Präfix-Icon für Level 30.' },
			default: '🛑',
		},
		gateStateId: {
			order: 150,
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
			label: { en: 'Gate operator', de: 'Gate-Operator' },
			help: {
				en: 'One of: >, <, =, true, false. Empty = gate disabled.',
				de: 'Einer von: >, <, =, true, false. Leer = Gate deaktiviert.',
			},
			default: '',
		},
		gateValue: {
			order: 170,
			type: 'string',
			label: { en: 'Gate value', de: 'Gate-Wert' },
			help: {
				en: 'Comparison value for >, <, =. Can be numeric or string. Ignored for true/false.',
				de: 'Vergleichswert für >, <, =. Kann numerisch oder String sein. Ignoriert für true/false.',
			},
			default: '',
		},
	},
});

module.exports = { manifest };
