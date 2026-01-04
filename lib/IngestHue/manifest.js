/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'IngestHue',

	// Deprecated (for now): hidden from runtime autodiscovery so it does not show up in the plugin catalog.
	// Keeping the code around is still useful as reference while a rewrite is planned.
	discoverable: false,
	defaultEnabled: false,
	supportsMultiple: true,
	title: {
		en: 'Hue Battery & Reachability',
		de: 'Hue Batterie & Erreichbarkeit',
		ru: 'Аккумулятор Hue и доступность',
		pt: 'Bateria Hue e acessibilidade',
		nl: 'Hue Batterij & Bereikbaarheid',
		fr: 'Batterie Hue et accessibilité',
		it: 'Batteria e raggiungibilità di Hue',
		es: 'Batería y alcance de Hue',
		pl: 'Bateria i zasięg Hue',
		uk: 'Батарейка Hue та досяжність',
		'zh-cn': 'Hue Battery & Reachability',
	},
	description: {
		en: 'Monitors Hue devices’ battery levels and reachability and creates tasks accordingly.',
		de: 'Überwacht den Batteriestand und die Erreichbarkeit der Hue-Geräte und erstellt entsprechende Aufgaben.',
		ru: 'Следит за уровнем заряда батареи устройств Hue и доступностью и создает соответствующие задания.',
		pt: 'Monitoriza os níveis de bateria e a acessibilidade dos dispositivos Hue e cria tarefas em conformidade.',
		nl: 'Houdt het batterijniveau en de bereikbaarheid van Hue-apparaten in de gaten en creëert dienovereenkomstig taken.',
		fr: 'Surveille les niveaux de batterie des appareils Hue et leur accessibilité, et crée des tâches en conséquence.',
		it: 'Monitora i livelli di batteria e la raggiungibilità dei dispositivi Hue e crea le attività di conseguenza.',
		es: 'Supervisa los niveles de batería y la accesibilidad de los dispositivos Hue y crea tareas en consecuencia.',
		pl: 'Monitoruje poziom naładowania baterii urządzeń Hue i ich zasięg oraz odpowiednio tworzy zadania.',
		uk: 'Відстежує рівень заряду акумулятора пристроїв Hue та їхню досяжність і створює завдання відповідно до них.',
		'zh-cn': 'Monitors Hue devices’ battery levels and reachability and creates tasks accordingly.',
	},
	options: {
		monitorBattery: {
			order: 10,
			type: 'boolean',
			label: { en: 'Monitor battery', de: 'Batterie überwachen' },
			help: {
				en: 'Create tasks when a Hue device battery is low.',
				de: 'Erstellt Aufgaben, wenn die Batterie eines Hue-Geräts niedrig ist.',
			},
			default: true,
		},
		batteryCreateBelow: {
			order: 20,
			type: 'number',
			unit: '%',
			label: { en: 'Create below', de: 'Erstellen unter' },
			help: {
				en: 'Create/update the battery task when battery is below this value.',
				de: 'Erstellt/aktualisiert die Batterie-Aufgabe, wenn der Wert darunter liegt.',
			},
			min: 0,
			max: 100,
			step: 1,
			default: 7,
		},
		batteryRemoveAbove: {
			order: 30,
			type: 'number',
			unit: '%',
			label: { en: 'Complete at/above', de: 'Abschließen ab' },
			help: {
				en: 'Complete the battery task when battery is at/above this value.',
				de: 'Schließt die Batterie-Aufgabe ab, wenn der Wert gleich/über diesem Wert liegt.',
			},
			min: 0,
			max: 100,
			step: 1,
			default: 30,
		},
		monitorReachable: {
			order: 40,
			type: 'boolean',
			label: { en: 'Monitor reachability', de: 'Erreichbarkeit überwachen' },
			help: {
				en: 'Create status messages when a device becomes unreachable.',
				de: 'Erstellt Statusmeldungen, wenn ein Gerät nicht erreichbar ist.',
			},
			default: true,
		},
		reachableAllowRoles: {
			order: 50,
			type: 'string',
			label: { en: 'Allowed roles (reachable)', de: 'Erlaubte Rollen (reachable)' },
			help: {
				en: 'Comma-separated list of parent roles to monitor for *.reachable (empty = allow all).',
				de: 'Kommagetrennte Liste der Parent-Rollen für *.reachable (leer = alle zulassen).',
			},
			default: 'ZLLSwitch,ZLLPresence',
		},
	},
});

module.exports = { manifest };
