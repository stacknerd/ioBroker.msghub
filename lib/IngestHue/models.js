const LABEL_WALL_SWITCH_MODULE = 'Wall switch module';
const LABEL_TAP_DIAL_SWITCH = 'Tap dial switch';
const LABEL_SMART_BUTTON = 'Smart button';
const LABEL_DIMMER_SWITCH = 'Dimmer switch';
const LABEL_OUTDOOR_MOTION_SENSOR = 'Outdoor motion sensor';
const LABEL_MOTION_SENSOR = 'Motion sensor';
const LABEL_SECURE_CONTACT_SENSOW = 'Secure contact sensor';

const BATTERY_CR2032 = 'CR2032';
const BATTERY_CR2450 = 'CR2450';
const BATTERY_CR2 = 'CR2';
const BATTERY_AA = 'AA';
const BATTERY_AAA = 'AAA';

const TOOLS_UNKNOWN = 'unknown';
const TOOLS_NONE = '';
const TOOLS_PH1_PHILLIPS = 'PH1 Phillips screwdriver';
const TOOLS_PH2_PHILLIPS = 'PH2 Phillips screwdriver';
const TOOLS_SLOTTED_3_5MM = '3.5 mm slotted screwdriver';
const TOOLS_LADDER_IF_NEEDED = 'ladder (if needed)';

const HUE_MODELS = Object.freeze({
	RDM001: Object.freeze({
		label: LABEL_WALL_SWITCH_MODULE,
		battery: BATTERY_CR2032,
		tools: TOOLS_PH2_PHILLIPS,
	}),
	RDM002: Object.freeze({
		label: LABEL_TAP_DIAL_SWITCH,
		battery: BATTERY_CR2032,
		tools: TOOLS_UNKNOWN,
	}),
	RDM003: Object.freeze({
		label: LABEL_SMART_BUTTON,
		battery: BATTERY_CR2032,
		tools: TOOLS_UNKNOWN,
	}),
	RDM004: Object.freeze({
		label: LABEL_WALL_SWITCH_MODULE,
		battery: BATTERY_CR2032,
		tools: [TOOLS_PH2_PHILLIPS, TOOLS_SLOTTED_3_5MM],
	}),
	RDM005: Object.freeze({
		label: LABEL_SMART_BUTTON,
		battery: BATTERY_CR2032,
		tools: TOOLS_UNKNOWN,
	}),
	RDM006: Object.freeze({
		label: LABEL_TAP_DIAL_SWITCH,
		battery: BATTERY_CR2032,
		tools: TOOLS_UNKNOWN,
	}),
	ROM001: Object.freeze({
		label: LABEL_SMART_BUTTON,
		battery: BATTERY_CR2032,
		tools: TOOLS_UNKNOWN,
	}),
	RWL020: Object.freeze({
		label: LABEL_DIMMER_SWITCH,
		battery: BATTERY_CR2450,
		tools: TOOLS_PH1_PHILLIPS,
	}),
	RWL021: Object.freeze({
		label: LABEL_DIMMER_SWITCH,
		battery: BATTERY_CR2450,
		tools: TOOLS_PH1_PHILLIPS,
	}),
	RWL022: Object.freeze({
		label: LABEL_DIMMER_SWITCH,
		battery: BATTERY_CR2032,
		tools: TOOLS_NONE,
	}),
	SML001: Object.freeze({
		label: LABEL_MOTION_SENSOR,
		battery: [BATTERY_AAA, BATTERY_AAA],
		tools: TOOLS_PH2_PHILLIPS,
	}),
	SML002: Object.freeze({
		label: LABEL_OUTDOOR_MOTION_SENSOR,
		battery: [BATTERY_AA, BATTERY_AA],
		tools: [TOOLS_PH1_PHILLIPS, TOOLS_SLOTTED_3_5MM, TOOLS_LADDER_IF_NEEDED],
	}),
	SML003: Object.freeze({
		label: LABEL_MOTION_SENSOR,
		battery: [BATTERY_AAA, BATTERY_AAA],
		tools: TOOLS_UNKNOWN,
	}),
	SML004: Object.freeze({
		label: LABEL_OUTDOOR_MOTION_SENSOR,
		battery: [BATTERY_AA, BATTERY_AA],
		tools: [TOOLS_PH1_PHILLIPS, TOOLS_SLOTTED_3_5MM, TOOLS_LADDER_IF_NEEDED],
	}),
	SOC001: Object.freeze({
		label: LABEL_SECURE_CONTACT_SENSOW,
		battery: BATTERY_CR2,
		tools: TOOLS_UNKNOWN,
	}),
});

module.exports = { HUE_MODELS };
