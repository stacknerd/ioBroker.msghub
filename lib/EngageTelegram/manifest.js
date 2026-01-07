/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'EngageTelegram',
	defaultEnabled: false,
	supportsMultiple: true,
	supportsChannelRouting: true,
	title: { en: 'Telegram engagement', de: 'Telegram-Interaktion' },
	description: {
		en: 'Sends MsgHub notifications to Telegram via sendTo() and executes actions from inline button clicks.',
		de: 'Sendet MsgHub-Benachrichtigungen per sendTo() an Telegram und führt Aktionen per Inline-Buttons aus.',
	},
	options: {
		telegramInstance: {
			order: 10,
			type: 'string',
			holdsInstanceTitle: true,
			label: { en: 'Telegram adapter instance', de: 'Telegram-Adapter-Instanz' },
			help: {
				en: 'Target adapter instance (e.g. telegram.0).',
				de: 'Ziel-Adapter-Instanz (z.B. telegram.0).',
			},
			default: 'telegram.0',
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
			min: 0,
			max: 30,
			step: 10,
			default: 99,
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
		_headerPriorities: {
			order: 65,
			type: 'header',
			label: { en: 'Telegram priority-setting', de: 'Telegram Prioritätseinstellungen' },
		},
		disableNotificationUpToLevel: {
			order: 66,
			type: 'number',
			label: { en: 'Silent notifications up to level', de: 'Stille Benachrichtigungen bis Level' },
			help: {
				en: 'For message.level <= this value, disable_notification=true is used (silent). Above: false.',
				de: 'Für message.level <= diesem Wert wird disable_notification=true verwendet (still). Darüber: false.',
			},
			min: 0,
			max: 30,
			step: 10,
			default: 0,
		},
		deleteOldNotificationOnResend: {
			order: 67,
			type: 'boolean',
			label: {
				en: 'Delete old notifications on resend',
				de: 'Alte Benachrichtigungen beim erneuten Senden löschen',
			},
			help: {
				en: 'When a new notification for the same message.ref is sent, delete the previous Telegram message (instead of only removing buttons).',
				de: 'Wenn eine neue Benachrichtigung für dieselbe message.ref gesendet wird, wird die vorherige Telegram-Nachricht gelöscht (statt nur die Buttons zu entfernen).',
			},
			default: true,
		},
		deleteOldNotificationOnEnd: {
			order: 68,
			type: 'boolean',
			label: {
				en: 'Delete notifications when message ends',
				de: 'Benachrichtigungen löschen, wenn die Message endet',
			},
			help: {
				en: 'When a Message Hub message is deleted or expired, delete the corresponding Telegram message (instead of only removing buttons).',
				de: 'Wenn eine Message Hub Message gelöscht oder abgelaufen ist, wird die entsprechende Telegram-Nachricht gelöscht (statt nur die Buttons zu entfernen).',
			},
			default: false,
		},
		_headerIconsKind: {
			order: 70,
			type: 'header',
			label: { en: 'icons (by message kind)', de: 'Icons (nach Typ der Meldung)' },
		},
		iconTask: {
			order: 80,
			type: 'string',
			label: { en: 'Icon (task)', de: 'Icon (task)' },
			help: { en: "Title prefix icon for kind 'task'.", de: "Titel-Präfix-Icon für Typ 'task'." },
			default: '📋',
		},
		iconStatus: {
			order: 90,
			type: 'string',
			label: { en: 'Icon (status)', de: 'Icon (status)' },
			help: { en: "Title prefix icon for kind 'status'.", de: "Titel-Präfix-Icon für Typ 'status'." },
			default: '📣',
		},
		iconAppointment: {
			order: 100,
			type: 'string',
			label: { en: 'Icon (appointment)', de: 'Icon (appointment)' },
			help: { en: "Title prefix icon for kind 'appointment'.", de: "Titel-Präfix-Icon für Typ 'appointment'." },
			default: '📅',
		},
		iconShoppinglist: {
			order: 110,
			type: 'string',
			label: { en: 'Icon (shoppinglist)', de: 'Icon (shoppinglist)' },
			help: { en: "Title prefix icon for kind 'shoppinglist'.", de: "Titel-Präfix-Icon für Typ 'shoppinglist'." },
			default: '🛒',
		},
		iconInventorylist: {
			order: 120,
			type: 'string',
			label: { en: 'Icon (inventorylist)', de: 'Icon (inventorylist)' },
			help: {
				en: "Title prefix icon for kind 'inventorylist'.",
				de: "Titel-Präfix-Icon für Typ 'inventorylist'.",
			},
			default: '📦',
		},
		_headerIconsLevel: {
			order: 130,
			type: 'header',
			label: { en: 'icons (by message level)', de: 'Icons (nach Schweregrad der Meldung)' },
		},
		iconNone: {
			order: 140,
			type: 'string',
			label: { en: 'Icon (none)', de: 'Icon (none)' },
			help: { en: 'Title prefix icon for level 0.', de: 'Titel-Präfix-Icon für Level 0.' },
			default: '',
		},
		iconNotice: {
			order: 141,
			type: 'string',
			label: { en: 'Icon (notice)', de: 'Icon (notice)' },
			help: { en: 'Title prefix icon for level 10.', de: 'Titel-Präfix-Icon für Level 10.' },
			default: 'ℹ️',
		},
		iconWarning: {
			order: 142,
			type: 'string',
			label: { en: 'Icon (warning)', de: 'Icon (warning)' },
			help: { en: 'Title prefix icon for level 20.', de: 'Titel-Präfix-Icon für Level 20.' },
			default: '⚠️',
		},
		iconError: {
			order: 143,
			type: 'string',
			label: { en: 'Icon (error)', de: 'Icon (error)' },
			help: { en: 'Title prefix icon for level 30.', de: 'Titel-Präfix-Icon für Level 30.' },
			default: '🛑',
		},
		_headerGate: {
			order: 200,
			type: 'header',
			label: { en: 'Gate (optional)', de: 'Gate (optional)' },
		},
		gateStateId: {
			order: 210,
			type: 'string',
			label: { en: 'Gate state id', de: 'Gate State-ID' },
			help: {
				en: 'Optional ioBroker state id to gate sending (empty = no gate).',
				de: 'Optionale ioBroker State-ID als Gate (leer = kein Gate).',
			},
			default: '',
		},
		gateOp: {
			order: 220,
			type: 'select',
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
			order: 230,
			type: 'string',
			label: { en: 'Gate value', de: 'Gate Wert' },
			help: {
				en: 'Value used for =, >, < comparisons.',
				de: 'Wert für Vergleiche =, >, <.',
			},
			default: '',
		},
		gateBypassFromLevel: {
			order: 240,
			type: 'number',
			label: { en: 'Gate bypass from level', de: 'Gate-Bypass ab Level' },
			help: {
				en: 'From this level (inclusive), the gate is bypassed.',
				de: 'Ab diesem Level (inklusive) wird das Gate ignoriert.',
			},
			min: 0,
			max: 30,
			step: 10,
			default: 99,
		},
	},
});

module.exports = { manifest };
