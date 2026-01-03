/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'BridgeAlexaTasks',
	defaultEnabled: false,
	supportsMultiple: true,
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
			label: { en: 'Alexa list JSON state id', de: 'Alexa-JSON-State-ID' },
			help: {
				en: 'State id that contains the Alexa TODO list items as JSON array (e.g. alexa2.0.Lists.TODO.json).',
				de: 'State-ID, die die Alexa-TODO-List-Items als JSON-Array enthält (z.B. alexa2.0.Lists.TODO.json).',
			},
			default: 'alexa2.0.Lists.TODO.json',
		},
		audienceTagsCsv: {
			order: 20,
			type: 'string',
			label: { en: 'Audience tags (CSV)', de: 'Audience-Tags (CSV)' },
			help: {
				en: 'Comma-separated tags copied to message audience.tags for imported tasks.',
				de: 'Kommagetrennte Tags, die bei importierten Tasks nach audience.tags kopiert werden.',
			},
			default: '',
		},
		fullSyncIntervalMs: {
			order: 30,
			type: 'number',
			holdsInstanceTitle: true,
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
		outEnabled: {
			order: 50,
			type: 'boolean',
			label: { en: 'Mirror tasks back to Alexa', de: 'Tasks zurück nach Alexa spiegeln' },
			help: {
				en: 'When enabled, selected MsgHub messages are mirrored into the Alexa TODO list.',
				de: 'Wenn aktiviert, werden ausgewählte MsgHub-Messages in die Alexa-TODO-Liste gespiegelt.',
			},
			default: true,
		},
		outKindsCsv: {
			order: 60,
			type: 'string',
			label: { en: 'Outbound kinds (CSV)', de: 'Outbound-Kinds (CSV)' },
			help: {
				en: 'Kinds that may be mirrored to Alexa (CSV).',
				de: 'Kinds, die nach Alexa gespiegelt werden dürfen (CSV).',
			},
			default: 'task',
		},
		outLevelMin: {
			order: 70,
			type: 'number',
			label: { en: 'Outbound level min', de: 'Outbound Level min' },
			help: {
				en: 'Minimum message level for outbound mirroring (inclusive).',
				de: 'Minimales Message-Level für Outbound-Mirroring (inklusive).',
			},
			min: 0,
			max: 30,
			step: 10,
			default: 10,
		},
		outLevelMax: {
			order: 80,
			type: 'number',
			label: { en: 'Outbound level max', de: 'Outbound Level max' },
			help: {
				en: 'Maximum message level for outbound mirroring (inclusive).',
				de: 'Maximales Message-Level für Outbound-Mirroring (inklusive).',
			},
			min: 0,
			max: 30,
			step: 10,
			default: 30,
		},
		outLifecycleStatesCsv: {
			order: 90,
			type: 'string',
			label: { en: 'Outbound lifecycle states (CSV)', de: 'Outbound Lifecycle-States (CSV)' },
			help: {
				en: 'Lifecycle states that may be mirrored (CSV).',
				de: 'Lifecycle-States, die gespiegelt werden dürfen (CSV).',
			},
			default: 'open',
		},
		outAudienceTagsAnyCsv: {
			order: 100,
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
