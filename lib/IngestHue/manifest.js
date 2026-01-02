/**
 * Plugin manifest metadata.
 */
const manifest = Object.freeze({
	schemaVersion: 1,
	type: 'IngestHue',

	defaultEnabled: true,
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
	options: {},
});

module.exports = { manifest };
