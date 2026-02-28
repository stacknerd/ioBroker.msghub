/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'BridgeAlexaTasks',
	defaultEnabled: false,
	supportsMultiple: true,
	supportsChannelRouting: true,
	title: {
		en: 'Alexa TODO list bridge (tasks)',
		de: 'Alexa-TODO-Listen-Bridge (Tasks)',
	},
	description: {
		en: 'Imports Alexa TODO items into Message Hub tasks and mirrors selected MsgHub tasks back to Alexa.',
		de: 'Importiert Alexa-TODO-Einträge als Message Hub Tasks und spiegelt ausgewählte MsgHub-Tasks zurück nach Alexa.',
	},
	options: {
		jsonStateId: {
			order: 10,
			type: 'string',
			holdsInstanceTitle: true,
			label: { en: 'Alexa list JSON state id', de: 'Alexa-JSON-State-ID' },
			help: {
				en: 'State id that contains the Alexa TODO list items as JSON array (e.g. alexa2.0.Lists.TODO.json).',
				de: 'State-ID, die die Alexa-TODO-List-Items als JSON-Array enthält (z.B. alexa2.0.Lists.TODO.json).',
			},
			default: 'alexa2.0.Lists.TODO.json',
		},
		_headerMessage: {
			order: 20,
			type: 'header',
			label: { en: 'Message setup', de: '"Message"-Einstellungen' },
		},
		messageIcon: {
			order: 25,
			type: 'string',
			label: { en: 'Message icon', de: 'Message-Icon' },
			help: {
				en: 'Optional icon stored on imported tasks (msg.icon). Leave empty to disable.',
				de: 'Optionales Icon, das auf importierten Tasks gespeichert wird (msg.icon). Leer lassen zum Deaktivieren.',
			},
			default: '📝',
		},
		audienceTagsCsv: {
			order: 30,
			type: 'string',
			label: { en: 'Inbound audience tags (CSV)', de: 'Inbound Audience-Tags (CSV)' },
			help: {
				en: 'Comma-separated tags copied to message audience.tags for imported tasks (Alexa → MsgHub).',
				de: 'Kommagetrennte Tags, die bei importierten Tasks nach audience.tags kopiert werden (Alexa → MsgHub).',
			},
			default: '',
		},
		audienceChannelsIncludeCsv: {
			order: 35,
			type: 'string',
			label: { en: 'Inbound audience channels include (CSV)', de: 'Inbound Audience-Channels include (CSV)' },
			help: {
				en: 'Comma-separated channels copied to message audience.channels.include for imported tasks (Alexa → MsgHub).',
				de: 'Kommagetrennte Channels, die bei importierten Tasks nach audience.channels.include kopiert werden (Alexa → MsgHub).',
			},
			default: '',
		},
		audienceChannelsExcludeCsv: {
			order: 36,
			type: 'string',
			label: { en: 'Inbound audience channels exclude (CSV)', de: 'Inbound Audience-Channels exclude (CSV)' },
			help: {
				en: 'Comma-separated channels copied to message audience.channels.exclude for imported tasks (Alexa → MsgHub).',
				de: 'Kommagetrennte Channels, die bei importierten Tasks nach audience.channels.exclude kopiert werden (Alexa → MsgHub).',
			},
			default: '',
		},
		aiEnhancedTitle: {
			order: 40,
			type: 'boolean',
			label: { en: 'AI enhanced title', de: 'AI-Title-Enhancement' },
			help: {
				en: 'When enabled, MsgHub AI can generate a concise title for imported tasks.',
				de: 'Wenn aktiviert, kann MsgHub AI für importierte Tasks einen kurzen Titel erzeugen.',
			},
			default: false,
		},
		_headerSync: {
			order: 50,
			type: 'header',
			label: { en: 'Synchronisation', de: 'Synchronisierung' },
		},
		fullSyncIntervalMs: {
			order: 60,
			type: 'number',
			label: { en: 'Full sync interval (ms)', de: 'Full-Sync Intervall (ms)' },
			help: {
				en: 'Periodic full sync interval; 0 disables.',
				de: 'Periodisches Full-Sync-Intervall; 0 deaktiviert.',
			},
			min: 0,
			max: 24 * 60 * 60 * 1000,
			step: 60 * 1000,
			default: 60 * 60 * 1000,
		},
		pendingMaxJsonMisses: {
			order: 65,
			type: 'number',
			label: { en: 'Pending create max JSON misses', de: 'Pending-Create max. JSON-Misses' },
			help: {
				en: 'How many Alexa JSON updates are allowed before a pending "create" is retried.',
				de: 'Wie viele Alexa-JSON-Änderungen erlaubt sind, bevor ein offener "Create" erneut gesendet wird.',
			},
			min: 1,
			max: 500,
			step: 1,
			default: 30,
		},
		_headerOutbound: {
			order: 70,
			type: 'header',
			label: { en: 'sync tasks to alexa (outbound)', de: 'Aufgaben mit Alexa synchronisieren (ausgehend)' },
		},
		outEnabled: {
			order: 80,
			type: 'boolean',
			label: { en: 'Mirror tasks back to Alexa', de: 'Tasks zurück nach Alexa spiegeln' },
			help: {
				en: 'When enabled, selected MsgHub messages are mirrored into the Alexa TODO list.',
				de: 'Wenn aktiviert, werden ausgewählte MsgHub-Messages in die Alexa-TODO-Liste gespiegelt.',
			},
			default: true,
		},
		outKindsCsv: {
			order: 90,
			type: 'string',
			label: { en: 'Outbound kinds (CSV)', de: 'Outbound-Kinds (CSV)' },
			help: {
				en: 'Kinds that may be mirrored to Alexa (CSV).',
				de: 'Kinds, die nach Alexa gespiegelt werden dürfen (CSV).',
			},
			multiOptions: 'MsgConstants.kind',
			default: 'task',
		},
		outLevelMin: {
			order: 100,
			type: 'number',
			label: { en: 'Outbound level min', de: 'Outbound Level min' },
			help: {
				en: 'Minimum message level for outbound mirroring (inclusive).',
				de: 'Minimales Message-Level für Outbound-Mirroring (inklusive).',
			},
			options: 'MsgConstants.level',
			default: 20,
		},
		outLevelMax: {
			order: 110,
			type: 'number',
			label: { en: 'Outbound level max', de: 'Outbound Level max' },
			help: {
				en: 'Maximum message level for outbound mirroring (inclusive).',
				de: 'Maximales Message-Level für Outbound-Mirroring (inklusive).',
			},
			options: 'MsgConstants.level',
			default: 50,
		},
		outLifecycleStatesCsv: {
			order: 120,
			type: 'string',
			label: { en: 'Outbound lifecycle states (CSV)', de: 'Outbound Lifecycle-States (CSV)' },
			help: {
				en: 'Lifecycle states that may be mirrored (CSV).',
				de: 'Lifecycle-States, die gespiegelt werden dürfen (CSV).',
			},
			multiOptions: 'MsgConstants.lifecycle.state',
			default: 'open',
		},
		outAudienceTagsAnyCsv: {
			order: 130,
			type: 'string',
			label: { en: 'Outbound audience tags (any, CSV)', de: 'Outbound Audience-Tags (any, CSV)' },
			help: {
				en: 'If set, only messages with at least one matching audience tag are mirrored.',
				de: 'Wenn gesetzt, werden nur Messages mit mindestens einem passenden Audience-Tag gespiegelt.',
			},
			default: '',
		},
	},
});

module.exports = { manifest };
