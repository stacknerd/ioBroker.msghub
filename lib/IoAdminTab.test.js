'use strict';

const { expect } = require('chai');

const { IoAdminTab } = require('./IoAdminTab');

describe('IoAdminTab handleCommand', () => {
	function createAdminTab() {
		const adapter = {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
		return new IoAdminTab(adapter, null);
	}

	it('rejects config-scope archive commands on admin scope', async () => {
		const tab = createAdminTab();
		const res = await tab.handleCommand('admin.archive.status', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('UNKNOWN_COMMAND');
	});

	it('admin.ping returns pong', async () => {
		const tab = createAdminTab();
		const res = await tab.handleCommand('admin.ping', null);
		expect(res.ok).to.equal(true);
		expect(res.data).to.equal('pong');
	});
});

describe('IoAdminTab admin.messages.action', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	function createMsgActionsStub({ executeResult = true, actorCapture = [] } = {}) {
		return {
			execute(opts) {
				actorCapture.push(opts?.actor);
				return executeResult;
			},
		};
	}

	it('executes action and returns ok when execute returns true', async () => {
		const actorCapture = [];
		const tab = new IoAdminTab(createAdapter(), null, {
			msgStore: { msgActions: createMsgActionsStub({ executeResult: true, actorCapture }) },
		});
		const res = await tab.handleCommand('admin.messages.action', { ref: 'r1', actionId: 'ack' });
		expect(res.ok).to.equal(true);
		expect(res.data.executed).to.equal(true);
	});

	it('passes actor "AdminTab" to execute', async () => {
		const actorCapture = [];
		const tab = new IoAdminTab(createAdapter(), null, {
			msgStore: { msgActions: createMsgActionsStub({ actorCapture }) },
		});
		await tab.handleCommand('admin.messages.action', { ref: 'r1', actionId: 'ack' });
		expect(actorCapture[0]).to.equal('AdminTab');
	});

	it('returns REJECTED when execute returns false', async () => {
		const tab = new IoAdminTab(createAdapter(), null, {
			msgStore: { msgActions: createMsgActionsStub({ executeResult: false }) },
		});
		const res = await tab.handleCommand('admin.messages.action', { ref: 'r1', actionId: 'ack' });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('REJECTED');
	});

	it('returns BAD_REQUEST when ref is missing', async () => {
		const tab = new IoAdminTab(createAdapter(), null, {
			msgStore: { msgActions: createMsgActionsStub() },
		});
		const res = await tab.handleCommand('admin.messages.action', { actionId: 'ack' });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('returns BAD_REQUEST when actionId is missing', async () => {
		const tab = new IoAdminTab(createAdapter(), null, {
			msgStore: { msgActions: createMsgActionsStub() },
		});
		const res = await tab.handleCommand('admin.messages.action', { ref: 'r1' });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('returns NOT_READY when msgStore has no msgActions', async () => {
		const tab = new IoAdminTab(createAdapter(), null, { msgStore: {} });
		const res = await tab.handleCommand('admin.messages.action', { ref: 'r1', actionId: 'ack' });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});

	it('returns NOT_READY when msgStore is null', async () => {
		const tab = new IoAdminTab(createAdapter(), null);
		const res = await tab.handleCommand('admin.messages.action', { ref: 'r1', actionId: 'ack' });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});
});

describe('IoAdminTab IngestStates presets', () => {
	function createAdapter({ objects, states, translations } = {}) {
		const objMap = objects || new Map();
		const stMap = states || new Map();
		const i18nMap = translations && typeof translations === 'object' ? translations : {};

		const matchPattern = (pattern, id) => {
			const p = String(pattern || '');
			if (!p.includes('*')) {
				return p === id;
			}
			const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const re = new RegExp(`^${p.split('*').map(esc).join('.*')}$`, 'u');
			return re.test(id);
		};

		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
			i18nBackend: {
				t: (key, ...args) => {
					const tpl = i18nMap[key] || String(key);
					if (!args.length) {
						return tpl;
					}
					let i = 0;
					return String(tpl).replace(/%s/g, () => String(args[i++] ?? ''));
				},
			},
			getForeignObjectsAsync: async pattern => {
				const out = {};
				for (const [id, obj] of objMap.entries()) {
					if (matchPattern(pattern, id)) {
						out[id] = obj;
					}
				}
				return out;
			},
			getForeignObjectAsync: async id => objMap.get(id) || null,
			setForeignObjectAsync: async (id, obj) => {
				objMap.set(id, { ...(obj || {}), _id: id });
			},
			delForeignObjectAsync: async id => {
				objMap.delete(id);
				stMap.delete(id);
			},
			getForeignStateAsync: async id => stMap.get(id) || null,
			setForeignStateAsync: async (id, val, ack) => {
				stMap.set(id, { val, ack: ack === true, ts: Date.now() });
			},
		};
	}

	function createAdminTab({ objects, states, translations, enabled = true, presetUsage = [] } = {}) {
		const adapter = createAdapter({ objects, states, translations });
		const ioPlugins = {
			listInstances: async () =>
				enabled ? [{ type: 'IngestStates', instanceId: 0, enabled: true }] : [{ type: 'IngestStates', instanceId: 0, enabled: false }],
			callPluginRuntime: options => {
				if (options?.type === 'IngestStates' && options?.instanceId === 0 && options?.method === 'getPresetUsageSnapshot') {
					return presetUsage;
				}
				return null;
			},
		};
		return new IoAdminTab(adapter, ioPlugins);
	}

	function makePresetValue(overrides = {}) {
		return {
			schema: 'msghub.IngestStatesMessagePreset.v1',
			presetId: 'p1',
			description: '',
			source: 'user',
			ownedBy: null,
			subset: null,
			message: { kind: 'status', level: 20, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
			policy: { resetOnNormal: true },
			...overrides,
		};
	}

	it('returns selectSendTo options via admin preset selectOptions command', async () => {
		const objects = new Map();
		const states = new Map();
		objects.set('msghub.0.IngestStates.0.presets.pStart', {
			_id: 'msghub.0.IngestStates.0.presets.pStart',
			type: 'state',
			common: { name: 'Session Start', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pStart', {
			val: JSON.stringify(makePresetValue({ presetId: 'pStart', ownedBy: 'session', subset: 'start' })),
			ack: true,
		});

		const tab = createAdminTab({ objects, states });
		const res = await tab.handleCommand('admin.ingestStates.presets.selectOptions.session.start', {});
		expect(res).to.have.length(1);
		expect(res[0].value).to.equal('pStart');
	});

	it('injects incompatible current preset with warning label when filtered out', async () => {
		const objects = new Map();
		const states = new Map();

		objects.set('msghub.0.IngestStates.0.presets.pStart', {
			_id: 'msghub.0.IngestStates.0.presets.pStart',
			type: 'state',
			common: { name: 'Session Start', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pStart', {
			val: JSON.stringify(makePresetValue({ presetId: 'pStart', ownedBy: 'session', subset: 'start' })),
			ack: true,
		});

		objects.set('msghub.0.IngestStates.0.presets.pEnd', {
			_id: 'msghub.0.IngestStates.0.presets.pEnd',
			type: 'state',
			common: { name: 'Session End', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pEnd', {
			val: JSON.stringify(makePresetValue({ presetId: 'pEnd', ownedBy: 'session', subset: 'end' })),
			ack: true,
		});

		const translations = {
			'msghub.i18n.IngestStates.admin.jsonCustom.rules.session.header.text': 'Session',
			'msghub.i18n.core.admin.common.MsgConstants.kind.status.label': 'Status',
			'msghub.i18n.core.admin.common.MsgConstants.level.notice.label': 'Notice',
			'msghub.i18n.IngestStates.admin.jsonCustom.preset.incompatible.label': 'INCOMPATIBLE: %s',
		};

		const tab = createAdminTab({ objects, states, translations });
		const res = await tab.handleCommand('admin.ingestStates.presets.selectOptions.session.start', { currentValue: 'pEnd' });
		expect(res).to.have.length(2);
		expect(res[0].value).to.equal('pEnd');
		expect(res[0].label.startsWith('INCOMPATIBLE: ')).to.equal(true);
		expect(res[1].value).to.equal('pStart');
	});

	it('does not duplicate current preset when already in filtered options', async () => {
		const objects = new Map();
		const states = new Map();
		objects.set('msghub.0.IngestStates.0.presets.pStart', {
			_id: 'msghub.0.IngestStates.0.presets.pStart',
			type: 'state',
			common: { name: 'Session Start', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pStart', {
			val: JSON.stringify(makePresetValue({ presetId: 'pStart', ownedBy: 'session', subset: 'start' })),
			ack: true,
		});

		const tab = createAdminTab({ objects, states });
		const res = await tab.handleCommand('admin.ingestStates.presets.selectOptions.session.start', { currentValue: 'pStart' });
		expect(res.filter(x => x.value === 'pStart')).to.have.length(1);
	});

});

describe('IoAdminTab._extractMetricKeys', () => {
	it('returns an empty set for a non-string input', () => {
		expect(IoAdminTab._extractMetricKeys(null).size).to.equal(0);
		expect(IoAdminTab._extractMetricKeys(undefined).size).to.equal(0);
		expect(IoAdminTab._extractMetricKeys(42).size).to.equal(0);
	});

	it('returns an empty set for a string with no template variables', () => {
		expect(IoAdminTab._extractMetricKeys('').size).to.equal(0);
		expect(IoAdminTab._extractMetricKeys('Hello world').size).to.equal(0);
	});

	it('returns an empty set for non-m.* variables', () => {
		expect(IoAdminTab._extractMetricKeys('{{x.state-name}}').size).to.equal(0);
		expect(IoAdminTab._extractMetricKeys('{{state-name}}').size).to.equal(0);
	});

	it('extracts a bare m.* key', () => {
		const keys = IoAdminTab._extractMetricKeys('Value: {{m.state-name}}');
		expect([...keys]).to.deep.equal(['state-name']);
	});

	it('extracts key from m.* with a filter', () => {
		const keys = IoAdminTab._extractMetricKeys('{{m.cycle-period|num:0}} left');
		expect([...keys]).to.deep.equal(['cycle-period']);
	});

	it('extracts key from m.* with a property accessor', () => {
		const keys = IoAdminTab._extractMetricKeys('Peak: {{m.trendMax.val}}');
		expect([...keys]).to.deep.equal(['trendMax']);
	});

	it('extracts multiple distinct keys from a template', () => {
		const keys = IoAdminTab._extractMetricKeys('{{m.state-name}} exceeded {{m.state-value|num:1}}');
		expect([...keys].sort()).to.deep.equal(['state-name', 'state-value']);
	});

	it('deduplicates repeated references to the same key', () => {
		const keys = IoAdminTab._extractMetricKeys('{{m.state-value}} and again {{m.state-value}}');
		expect([...keys]).to.deep.equal(['state-value']);
	});
});

describe('IoAdminTab._hasUnavailableMetrics', () => {
	function makePreset(title = '', text = '', textRecovered = '') {
		return {
			schema: 'msghub.IngestStatesMessagePreset.v1',
			presetId: 'test',
			source: 'user',
			ownedBy: '',
			subset: '',
			message: {
				kind: 'status',
				level: 20,
				icon: '',
				title,
				text,
				textRecovered,
				timing: {},
				details: {},
				audience: {},
				actions: [],
			},
			policy: {},
		};
	}

	function createAdminTab() {
		const adapter = {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
		return new IoAdminTab(adapter, null);
	}

	it('returns false when rule is empty', () => {
		const tab = createAdminTab();
		const preset = makePreset('{{m.cycle-period}}', 'text');
		expect(tab._hasUnavailableMetrics(preset, '', 'lt')).to.equal(false);
	});

	it('returns false when rule is unknown in the catalog', () => {
		const tab = createAdminTab();
		const preset = makePreset('{{m.cycle-period}}', 'text');
		expect(tab._hasUnavailableMetrics(preset, 'UnknownRule', '')).to.equal(false);
	});

	it('returns false when preset has no m.* variables', () => {
		const tab = createAdminTab();
		const preset = makePreset('Alert', 'Something went wrong');
		expect(tab._hasUnavailableMetrics(preset, 'Threshold', 'lt')).to.equal(false);
	});

	it('returns false when all referenced metrics are available (null-subset)', () => {
		const tab = createAdminTab();
		// state-name and state-value have subset: null in threshold — always available
		const preset = makePreset('{{m.state-name}} alert', 'Value: {{m.state-value}}');
		expect(tab._hasUnavailableMetrics(preset, 'Threshold', 'lt')).to.equal(false);
	});

	it('returns false for state-min in threshold/lt (subset matches)', () => {
		const tab = createAdminTab();
		// state-min has subset: ['lt', 'inside', 'outside'] — available in lt
		const preset = makePreset('Min: {{m.state-min}}', 'text');
		expect(tab._hasUnavailableMetrics(preset, 'Threshold', 'lt')).to.equal(false);
	});

	it('returns true for state-max in threshold/lt (subset mismatch)', () => {
		const tab = createAdminTab();
		// state-max has subset: ['gt', 'inside', 'outside'] — NOT available in lt
		const preset = makePreset('Max: {{m.state-max}}', 'text');
		expect(tab._hasUnavailableMetrics(preset, 'Threshold', 'lt')).to.equal(true);
	});

	it('returns true when a cycle metric is referenced in a freshness context', () => {
		const tab = createAdminTab();
		// cycle-period does not exist in the freshness catalog at all
		const preset = makePreset('{{m.cycle-period}} cycles', 'text');
		expect(tab._hasUnavailableMetrics(preset, 'Freshness', '')).to.equal(true);
	});

	it('returns false for state-name in any known rule (universal metric)', () => {
		const tab = createAdminTab();
		const preset = makePreset('{{m.state-name}}', 'text');
		for (const rule of ['Threshold', 'Freshness', 'Cycle', 'Triggered', 'NonSettling', 'Session']) {
			expect(tab._hasUnavailableMetrics(preset, rule, ''), `${rule}`).to.equal(false);
		}
	});

	it('handles case-insensitive rule lookup (nonSettling vs nonsettling)', () => {
		const tab = createAdminTab();
		// trendMin is a valid nonSettling metric
		const preset = makePreset('{{m.trendMin}}', 'text');
		expect(tab._hasUnavailableMetrics(preset, 'nonsettling', '')).to.equal(false);
		expect(tab._hasUnavailableMetrics(preset, 'NONSETTLING', '')).to.equal(false);
		expect(tab._hasUnavailableMetrics(preset, 'nonSettling', '')).to.equal(false);
	});

	it('checks textRecovered field as well', () => {
		const tab = createAdminTab();
		// state-max is not available in threshold/lt, placed in textRecovered
		const preset = makePreset('{{m.state-name}}', '{{m.state-value}}', '{{m.state-max}} recovered');
		expect(tab._hasUnavailableMetrics(preset, 'Threshold', 'lt')).to.equal(true);
	});

	it('returns false when subset is empty (all catalog keys treated as available)', () => {
		const tab = createAdminTab();
		// state-max has subset: ['gt', 'inside', 'outside'] — when subset is '' we treat all keys as available
		const preset = makePreset('Max: {{m.state-max}}', 'text');
		expect(tab._hasUnavailableMetrics(preset, 'Threshold', '')).to.equal(false);
	});
});

// ---------------------------------------------------------------------------
// admin.pluginUi.discover / bundle.get / rpc
// ---------------------------------------------------------------------------

describe('IoAdminTab admin.pluginUi.discover', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	function makeContribution(overrides = {}) {
		return {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			title: { en: 'Presets' },
			apiVersion: '1',
			bundle: { hash: '' },
			...overrides,
		};
	}

	it('returns contributions with computed hash from running plugins', async () => {
		const contributions = [makeContribution()];
		const ioPlugins = {
			getAdminUiContributions: () => contributions,
			computeAdminUiBundleHash: async () => 'sha256-testhash',
		};
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.have.length(1);
		expect(res.data[0].pluginType).to.equal('IngestStates');
		expect(res.data[0].panelId).to.equal('presets');
		expect(res.data[0].bundle.hash).to.equal('sha256-testhash');
	});

	it('returns empty array when no plugin has adminUi', async () => {
		const ioPlugins = {
			getAdminUiContributions: () => [],
			computeAdminUiBundleHash: async () => 'sha256-testhash',
		};
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.deep.equal([]);
	});

	it('returns contributions from multiple instances of same type', async () => {
		const contributions = [makeContribution({ instanceId: 0 }), makeContribution({ instanceId: 1 })];
		const ioPlugins = {
			getAdminUiContributions: () => contributions,
			computeAdminUiBundleHash: async () => 'sha256-testhash',
		};
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.have.length(2);
	});

	it('returns contribution with empty hash when computeAdminUiBundleHash throws', async () => {
		const contributions = [makeContribution()];
		const ioPlugins = {
			getAdminUiContributions: () => contributions,
			computeAdminUiBundleHash: async () => {
				throw new Error('hash failed');
			},
		};
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.have.length(1);
		expect(res.data[0].bundle.hash).to.equal('');
	});

	it('returns NOT_READY when ioPlugins is null', async () => {
		const tab = new IoAdminTab(createAdapter(), null);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});

	it('returns NOT_READY when computeAdminUiBundleHash is not a function on ioPlugins', async () => {
		const ioPlugins = { getAdminUiContributions: () => [] };
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});
});

describe('IoAdminTab admin.pluginUi.bundle.get', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	function makeContrib(overrides = {}) {
		return {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			apiVersion: '1',
			bundle: { hash: '' },
			...overrides,
		};
	}

	function makeIoPlugins({
		contributions,
		jsContent = 'export function mount(){}',
		cssContent = null,
		i18nPayload = null,
		readError = null,
		hashValue = 'sha256-computedhash',
		hashError = null,
	} = {}) {
		let readCalls = 0;
		let lastReadLang;
		return {
			getAdminUiContributions: () => contributions ?? [makeContrib()],
			computeAdminUiBundleHash: async () => {
				if (hashError) {
					throw hashError;
				}
				return hashValue;
			},
			readAdminUiBundle: async ({ lang } = {}) => {
				readCalls++;
				lastReadLang = lang;
				if (readError) {
					throw readError;
				}
				return { js: jsContent, css: cssContent, i18n: i18nPayload };
			},
			_readCallCount: () => readCalls,
			_lastReadLang: () => lastReadLang,
		};
	}

	it('returns bundle on happy path', async () => {
		const ioPlugins = makeIoPlugins({ jsContent: 'export function mount(){}', cssContent: '.host{}' });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(true);
		expect(res.data.js).to.equal('export function mount(){}');
		expect(res.data.css).to.equal('.host{}');
		expect(res.data.moduleFormat).to.equal('esm');
		expect(res.data.hash).to.equal('sha256-computedhash');
		expect(res.data.i18n).to.equal(null);
	});

	it('returns bundle without css when companion CSS is absent', async () => {
		const ioPlugins = makeIoPlugins({ cssContent: null });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(true);
		expect(res.data).to.not.have.property('css');
	});

	it('serves from cache on second call (readAdminUiBundle not called again)', async () => {
		const ioPlugins = makeIoPlugins();
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const req = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		await tab.handleCommand('admin.pluginUi.bundle.get', req);
		await tab.handleCommand('admin.pluginUi.bundle.get', req);
		expect(ioPlugins._readCallCount()).to.equal(1);
	});

	it('returns NOT_FOUND when plugin is not started', async () => {
		const ioPlugins = makeIoPlugins({ contributions: [] });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_FOUND');
	});

	it('returns NOT_FOUND when readAdminUiBundle throws NOT_FOUND', async () => {
		const readError = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
		const ioPlugins = makeIoPlugins({ readError });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_FOUND');
	});

	it('returns FORBIDDEN when readAdminUiBundle throws FORBIDDEN', async () => {
		const readError = Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' });
		const ioPlugins = makeIoPlugins({ readError });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('FORBIDDEN');
	});

	it('returns INTERNAL when JS bundle exceeds 512 KB', async () => {
		const bigJs = 'x'.repeat(512 * 1024 + 1);
		const ioPlugins = makeIoPlugins({ jsContent: bigJs });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('INTERNAL');
	});

	it('returns INTERNAL when CSS exceeds 64 KB', async () => {
		const bigCss = 'x'.repeat(64 * 1024 + 1);
		const ioPlugins = makeIoPlugins({ cssContent: bigCss });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('INTERNAL');
	});

	it('returns BAD_REQUEST when pluginType is missing', async () => {
		const tab = new IoAdminTab(createAdapter(), makeIoPlugins());
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', { panelId: 'presets' });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('forwards lang from request to readAdminUiBundle', async () => {
		const ioPlugins = makeIoPlugins();
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			lang: 'de',
		});
		expect(ioPlugins._lastReadLang()).to.equal('de');
	});

	it('normalizes invalid lang to en before forwarding', async () => {
		const ioPlugins = makeIoPlugins();
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			lang: '../evil',
		});
		expect(ioPlugins._lastReadLang()).to.equal('en');
	});

	it('different lang produces different cache entries', async () => {
		const ioPlugins = makeIoPlugins();
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const base = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		await tab.handleCommand('admin.pluginUi.bundle.get', { ...base, lang: 'en' });
		await tab.handleCommand('admin.pluginUi.bundle.get', { ...base, lang: 'de' });
		expect(ioPlugins._readCallCount()).to.equal(2);
	});

	it('response includes i18n when bundle returns translations', async () => {
		const i18nPayload = { lang: 'de', translations: { 'msghub.i18n.IngestStates.ui.foo': 'Foo' } };
		const ioPlugins = makeIoPlugins({ i18nPayload });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			lang: 'de',
		});
		expect(res.ok).to.equal(true);
		expect(res.data.i18n).to.deep.equal(i18nPayload);
	});

	it('returns NOT_FOUND when computeAdminUiBundleHash throws NOT_FOUND', async () => {
		const hashError = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
		const ioPlugins = makeIoPlugins({ hashError });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_FOUND');
	});

	it('returns INTERNAL when computeAdminUiBundleHash throws a generic error', async () => {
		const hashError = new Error('disk read failed');
		const ioPlugins = makeIoPlugins({ hashError });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('INTERNAL');
	});
});

describe('IoAdminTab admin.pluginUi.rpc', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	function makeContrib(overrides = {}) {
		return {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			apiVersion: '1',
			bundle: { hash: 'abc123' },
			...overrides,
		};
	}

	function makeIoPlugins({ contributions, rpcResult = { ok: true, data: {} }, rpcError = null } = {}) {
		return {
			getAdminUiContributions: () => contributions ?? [makeContrib()],
			callPluginRuntime: () => {
				if (rpcResult === null) {
					return null;
				}
				if (rpcError) {
					return Promise.reject(rpcError);
				}
				return Promise.resolve(rpcResult);
			},
		};
	}

	it('returns plugin result on happy path', async () => {
		const ioPlugins = makeIoPlugins({ rpcResult: { ok: true, data: { count: 3 } } });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.rpc', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
			payload: {},
		});
		expect(res.ok).to.equal(true);
		expect(res.data.count).to.equal(3);
	});

	it('returns NOT_FOUND when plugin not started or panel not declared', async () => {
		const ioPlugins = makeIoPlugins({ contributions: [] });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.rpc', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_FOUND');
	});

	it('returns NOT_READY when callPluginRuntime returns null', async () => {
		const ioPlugins = makeIoPlugins({ rpcResult: null });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.rpc', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});

	it('returns BAD_REQUEST when payload exceeds 64 KB', async () => {
		const tab = new IoAdminTab(createAdapter(), makeIoPlugins());
		const bigPayload = { data: 'x'.repeat(64 * 1024 + 1) };
		const res = await tab.handleCommand('admin.pluginUi.rpc', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.create',
			payload: bigPayload,
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('returns BAD_REQUEST when required fields are missing', async () => {
		const tab = new IoAdminTab(createAdapter(), makeIoPlugins());
		const res = await tab.handleCommand('admin.pluginUi.rpc', {
			pluginType: 'IngestStates',
			instanceId: 0,
			// panelId missing
			command: 'presets.list',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('returns TIMEOUT when RPC does not resolve within timeout', async () => {
		// Override global.setTimeout so the timeout fires immediately.
		const origSetTimeout = global.setTimeout;
		global.setTimeout = (fn, _delay) => origSetTimeout(fn, 1);
		try {
			const neverResolves = new Promise(() => {});
			const ioPlugins = {
				getAdminUiContributions: () => [makeContrib()],
				callPluginRuntime: () => neverResolves,
			};
			const tab = new IoAdminTab(createAdapter(), ioPlugins);
			const res = await tab.handleCommand('admin.pluginUi.rpc', {
				pluginType: 'IngestStates',
				instanceId: 0,
				panelId: 'presets',
				command: 'presets.list',
			});
			expect(res.ok).to.equal(false);
			expect(res.error.code).to.equal('TIMEOUT');
		} finally {
			global.setTimeout = origSetTimeout;
		}
	});

	it('returns NOT_READY when ioPlugins is null', async () => {
		const tab = new IoAdminTab(createAdapter(), null);
		const res = await tab.handleCommand('admin.pluginUi.rpc', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});
});
