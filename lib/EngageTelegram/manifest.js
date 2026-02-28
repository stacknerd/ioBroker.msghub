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
			options: 'MsgConstants.level',
			default: 10,
		},
		_headerMenu: {
			order: 67,
			type: 'header',
			label: { en: 'Menu actions', de: 'Menü-Aktionen' },
		},
		enableAck: {
			order: 68,
			type: 'boolean',
			label: { en: 'Enable Ack', de: 'Ack aktivieren' },
			help: {
				en: 'Show "Ack" in the Telegram menu when the message offers an ack action.',
				de: 'Zeigt "Ack" im Telegram-Menü an, wenn die Message eine Ack-Aktion anbietet.',
			},
			default: true,
		},
		enableClose: {
			order: 69,
			type: 'boolean',
			label: { en: 'Enable Close', de: 'Close aktivieren' },
			help: {
				en: 'Show "Close" in the Telegram menu when the message offers a close action.',
				de: 'Zeigt "Close" im Telegram-Menü an, wenn die Message eine Close-Aktion anbietet.',
			},
			default: true,
		},
		enableSnooze: {
			order: 70,
			type: 'boolean',
			label: { en: 'Enable Snooze', de: 'Snooze aktivieren' },
			help: {
				en: 'Show the snooze submenu when the message offers a snooze action.',
				de: 'Zeigt das Snooze-Untermenü an, wenn die Message eine Snooze-Aktion anbietet.',
			},
			default: true,
		},
		enableOpen: {
			order: 71,
			type: 'boolean',
			label: { en: 'Enable Open', de: 'Open aktivieren' },
			help: {
				en: 'Show "Open" (navigation-only) when the message offers an open action.',
				de: 'Zeigt "Open" (nur Navigation) an, wenn die Message eine Open-Aktion anbietet.',
			},
			default: true,
		},
		enableLink: {
			order: 72,
			type: 'boolean',
			label: { en: 'Enable Link', de: 'Link aktivieren' },
			help: {
				en: 'Show "Open" for link actions (navigation-only) when present.',
				de: 'Zeigt "Open" für Link-Aktionen (nur Navigation) an, wenn vorhanden.',
			},
			default: true,
		},
		_headerGate: {
			order: 200,
			type: 'header',
			label: { en: 'Global send gate (optional)', de: 'Globales Sende-Gate (optional)' },
		},
		gateStateId: {
			order: 210,
			type: 'string',
			label: { en: 'Gate state id (global)', de: 'Gate State-ID (global)' },
			help: {
				en: 'Optional ioBroker state id used as a global send/mute gate for Telegram (empty = no gate). This is not user-specific.',
				de: 'Optionale ioBroker State-ID als globales Sende-/Mute-Gate für Telegram (leer = kein Gate). Das ist nicht benutzerspezifisch.',
			},
			default: '',
		},
		gateOp: {
			order: 220,
			type: 'string',
			label: { en: 'Gate operator', de: 'Gate-Operator' },
			help: {
				en: 'Comparison operator for the global send gate.',
				de: 'Vergleichsoperator für das globale Sende-Gate.',
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
			label: { en: 'Gate compare value', de: 'Gate Vergleichswert' },
			help: {
				en: 'Value used for =, >, < comparisons (global send gate).',
				de: 'Wert für Vergleiche =, >, < (globales Sende-Gate).',
			},
			default: '',
		},
		gateBypassFromLevel: {
			order: 240,
			type: 'number',
			label: { en: 'Gate bypass from level', de: 'Gate-Bypass ab Level' },
			help: {
				en: 'From this level (inclusive), the global send gate is bypassed.',
				de: 'Ab diesem Level (inklusive) wird das globale Sende-Gate ignoriert.',
			},
			options: 'MsgConstants.level',
			default: 50,
		},
		gateCheckinText: {
			order: 250,
			type: 'string',
			label: { en: 'Gate check-in text', de: 'Gate-Check-in-Text' },
			help: {
				en: 'Optional text sent when the gate opens (supports {id} templates).',
				de: 'Optionaler Text beim Oeffnen des Gates (unterstuetzt {id}-Templates).',
			},
			default: 'Gate is closed — notifications are enabled again.',
		},
		gateCheckoutText: {
			order: 260,
			type: 'string',
			label: { en: 'Gate check-out text', de: 'Gate-Check-out-Text' },
			help: {
				en: 'Optional text sent when the gate closes (supports {id} templates).',
				de: 'Optionaler Text beim Schliessen des Gates (unterstuetzt {id}-Templates).',
			},
			default: 'Gate opened. Notifications are blocked until the gate closes.',
		},
	},
});

module.exports = { manifest };
