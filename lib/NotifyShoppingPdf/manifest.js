/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'NotifyShoppingPdf',
	defaultEnabled: false,
	supportsMultiple: true,
	title: { en: 'Shopping list PDF', de: 'Einkaufsliste als PDF' },
	description: {
		en: 'Renders all allowed shopping lists into a single PDF and stores it in ioBroker file storage.',
		de: 'Rendert alle erlaubten Shoppinglisten in eine PDF und speichert sie im ioBroker-Dateisystem.',
	},
	options: {
		refsWhitelistCsv: {
			order: 10,
			type: 'string',
			label: { en: 'Whitelist (refs)', de: 'Whitelist (refs)' },
			help: {
				en: 'Comma-separated list of message refs to include. Empty = include all.',
				de: 'Komma-separierte Liste von Message-refs, die inkludiert werden. Leer = alle.',
			},
			default: '',
		},
		refsBlacklistCsv: {
			order: 20,
			type: 'string',
			label: { en: 'Blacklist (refs)', de: 'Blacklist (refs)' },
			help: {
				en: 'Comma-separated list of message refs to exclude. Blacklist wins over whitelist.',
				de: 'Komma-separierte Liste von Message-refs, die ausgeschlossen werden. Blacklist gewinnt.',
			},
			default: '',
		},
		_headerPageSetup: {
			order: 30,
			type: 'header',
			label: { en: 'page setup', de: 'Dokumenteneinstellungen' },
		},
		pdfTitle: {
			order: 40,
			type: 'string',
			holdsInstanceTitle: true,
			label: { en: 'PDF title', de: 'PDF-Titel' },
			help: {
				en: 'Title printed in the PDF header.',
				de: 'Titel im PDF-Header.',
			},
			default: 'Shoppinglist',
		},
		includeChecked: {
			order: 50,
			type: 'boolean',
			label: { en: 'Include checked items', de: 'Abgehakte anzeigen' },
			help: {
				en: 'If enabled, checked list items are included in the PDF.',
				de: 'Wenn aktiv, werden abgehakte Listeneinträge im PDF angezeigt.',
			},
			default: true,
		},
		printRoomLabelsFromItems: {
			order: 60,
			type: 'number',
			label: { en: 'Print item-category headings from', de: 'Kategorie-Überschriften ab' },
			help: {
				en: 'Only print category headings if the corresponding list contains more than the specified number of items. 0 = always.',
				de: 'Kategorieüberschriften nur ausgeben, wenn die jeweilige Liste mehr als die angegebene Anzahl von Artikeln enthält. 0 = immer.',
			},
			min: 0,
			max: 1000,
			step: 1,
			default: 6,
		},
		includeEmptyCategories: {
			order: 70,
			type: 'boolean',
			label: { en: 'Include empty lists', de: 'Leere Listen ausgeben' },
			help: {
				en: 'If disabled, shopping lists without items are excluded from output.',
				de: 'Wenn deaktiviert, werden Listen ohne Artikel nicht ausgegeben.',
			},
			default: true,
		},
		uncategorizedLabel: {
			order: 80,
			type: 'string',
			label: { en: 'Uncategorized label', de: 'Label ohne Kategorie' },
			help: {
				en: 'Label used for list items without a category.',
				de: 'Label für Listeneinträge ohne Kategorie.',
			},
			default: 'Other',
		},
		_headerRendering: {
			order: 90,
			type: 'header',
			label: { en: 'Rendering', de: 'Rendering' },
		},
		renderDebounceMs: {
			order: 100,
			type: 'number',
			unit: 'ms',
			label: { en: 'Render debounce', de: 'Render-Delay' },
			help: {
				en: 'Debounce window for regenerating the PDF on notifications.',
				de: 'Debounce-Zeitfenster für PDF-Neugenerierung bei Notifications.',
			},
			min: 0,
			max: 1000 * 60 * 10,
			step: 50,
			default: 1000,
		},
		design: {
			order: 110,
			type: 'string',
			label: { en: 'Design', de: 'Design' },
			help: {
				en: 'Design preset',
				de: 'Design-Preset',
			},
			options: [
				{ label: { en: 'screen (lighter)', de: 'screen (leichter)' }, value: 'screen' },
				{ label: { en: 'print (stronger lines)', de: 'print (kräftiger)' }, value: 'print' },
			],
			default: 'print',
		},
		notesLines: {
			order: 120,
			type: 'number',
			label: { en: 'Notes lines', de: 'Notiz-Zeilen' },
			help: {
				en: 'Number of empty note lines at the end of the PDF. 0 disables the notes box.',
				de: 'Anzahl leerer Notiz-Zeilen am Ende. 0 deaktiviert den Notiz-Block.',
			},
			min: 0,
			max: 25,
			step: 1,
			default: 5,
		},
	},
});

module.exports = { manifest };
