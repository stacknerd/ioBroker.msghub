'use strict';

const { expect } = require('chai');

const { IoAdminTab } = require('./IoAdminTab');

describe('IoAdminTab IngestStates bulk apply sanitization', () => {
	function createAdminTab() {
		const adapter = {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
		return new IoAdminTab(adapter, null);
	}

	it('drops dot keys and nested objects', () => {
		const tab = createAdminTab();

		const out = tab._sanitizeIngestStatesCustom({
			enabled: true,
			mode: 'threshold',
			'thr-mode': 'gt',
			'thr-value': 10,
			'thr.mode': 'lt',
			thr: { mode: 'outside' },
			'foo.bar': 1,
		});

		expect(out).to.deep.equal({
			enabled: true,
			mode: 'threshold',
			'thr-mode': 'gt',
			'thr-value': 10,
		});
	});

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

	it('lists presets as selectSendTo options', async () => {
		const objects = new Map();
		const states = new Map();
		objects.set('msghub.0.IngestStates.0.presets.p1', {
			_id: 'msghub.0.IngestStates.0.presets.p1',
			type: 'state',
			common: { name: 'Preset One', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.p1', {
			val: JSON.stringify(makePresetValue({ presetId: 'p1', description: 'Preset One' })),
			ack: true,
		});

			const tab = createAdminTab({ objects, states });
			const res = await tab.handleCommand('admin.ingestStates.presets.list', {});
			expect(res.ok).to.equal(true);
			expect(res.data).to.deep.equal([
				{
					value: 'p1',
					label: 'msghub.i18n.IngestStates.admin.jsonCustom.preset.global.label msghub.i18n.core.admin.common.MsgConstants.kind.status.label (msghub.i18n.core.admin.common.MsgConstants.level.notice.label): Preset One',
					source: 'user',
					ownedBy: null,
					subset: null,
					kind: 'status',
					level: 20,
					name: 'Preset One',
				},
			]);
		});

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

	it('filters presets by ownedBy when rule is set', async () => {
		const objects = new Map();
		const states = new Map();

		objects.set('msghub.0.IngestStates.0.presets.pOwned', {
			_id: 'msghub.0.IngestStates.0.presets.pOwned',
			type: 'state',
			common: { name: 'Owned Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pOwned', {
			val: JSON.stringify(makePresetValue({
				presetId: 'pOwned',
				description: 'Owned Preset',
				ownedBy: 'session',
				subset: 'start',
			})),
			ack: true,
		});

		objects.set('msghub.0.IngestStates.0.presets.pFree', {
			_id: 'msghub.0.IngestStates.0.presets.pFree',
			type: 'state',
			common: { name: 'Free Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pFree', {
			val: JSON.stringify(makePresetValue({
				presetId: 'pFree',
				description: 'Free Preset',
				ownedBy: '',
				subset: '',
			})),
			ack: true,
		});

		const tab = createAdminTab({ objects, states });
		const res = await tab.handleCommand('admin.ingestStates.presets.list', { rule: 'session' });
		expect(res.ok).to.equal(true);
		expect(res.data.map(x => x.value).sort()).to.deep.equal(['pFree', 'pOwned']);

		const res2 = await tab.handleCommand('admin.ingestStates.presets.list', { rule: 'freshness' });
		expect(res2.ok).to.equal(true);
		expect(res2.data.map(x => x.value)).to.deep.equal(['pFree']);
	});

	it('filters presets by subset when subset is set', async () => {
		const objects = new Map();
		const states = new Map();

		objects.set('msghub.0.IngestStates.0.presets.pStart', {
			_id: 'msghub.0.IngestStates.0.presets.pStart',
			type: 'state',
			common: { name: 'Start Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pStart', {
			val: JSON.stringify(makePresetValue({
				presetId: 'pStart',
				description: 'Start Preset',
				ownedBy: 'session',
				subset: 'start',
			})),
			ack: true,
		});

		objects.set('msghub.0.IngestStates.0.presets.pEnd', {
			_id: 'msghub.0.IngestStates.0.presets.pEnd',
			type: 'state',
			common: { name: 'End Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pEnd', {
			val: JSON.stringify(makePresetValue({
				presetId: 'pEnd',
				description: 'End Preset',
				ownedBy: 'session',
				subset: 'end',
			})),
			ack: true,
		});

		objects.set('msghub.0.IngestStates.0.presets.pFree', {
			_id: 'msghub.0.IngestStates.0.presets.pFree',
			type: 'state',
			common: { name: 'Free Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pFree', {
			val: JSON.stringify(makePresetValue({
				presetId: 'pFree',
				description: 'Free Preset',
				ownedBy: '',
				subset: '',
			})),
			ack: true,
		});

		const tab = createAdminTab({ objects, states });

		const res = await tab.handleCommand('admin.ingestStates.presets.list', { rule: 'session', subset: 'start' });
		expect(res.ok).to.equal(true);
		expect(res.data.map(x => x.value).sort()).to.deep.equal(['pFree', 'pStart']);

		const res2 = await tab.handleCommand('admin.ingestStates.presets.list', { rule: 'session', subset: 'end' });
		expect(res2.ok).to.equal(true);
		expect(res2.data.map(x => x.value).sort()).to.deep.equal(['pEnd', 'pFree']);
	});

	it('orders owned presets before global presets', async () => {
		const objects = new Map();
		const states = new Map();

		objects.set('msghub.0.IngestStates.0.presets.pOwned', {
			_id: 'msghub.0.IngestStates.0.presets.pOwned',
			type: 'state',
			common: { name: 'Owned Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pOwned', {
			val: JSON.stringify(makePresetValue({ presetId: 'pOwned', description: 'Owned Preset', ownedBy: 'session' })),
			ack: true,
		});

		objects.set('msghub.0.IngestStates.0.presets.pFree', {
			_id: 'msghub.0.IngestStates.0.presets.pFree',
			type: 'state',
			common: { name: 'AAA Free Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pFree', {
			val: JSON.stringify(makePresetValue({ presetId: 'pFree', description: 'Free Preset', ownedBy: null })),
			ack: true,
		});

		const tab = createAdminTab({ objects, states });
		const res = await tab.handleCommand('admin.ingestStates.presets.list', {});
		expect(res.ok).to.equal(true);
		expect(res.data.map(x => x.value)).to.deep.equal(['pOwned', 'pFree']);
	});

	it('builds a composed label for owned presets', async () => {
		const objects = new Map();
		const states = new Map();

		objects.set('msghub.0.IngestStates.0.presets.pOwned', {
			_id: 'msghub.0.IngestStates.0.presets.pOwned',
			type: 'state',
			common: { name: 'falsy (manual close)', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pOwned', {
			val: JSON.stringify(makePresetValue({
				presetId: 'pOwned',
				description: 'falsy (manual close)',
				ownedBy: 'Threshold',
				message: { kind: 'status', level: 50, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: false },
			})),
			ack: true,
		});

		const translations = {
			'msghub.i18n.IngestStates.admin.jsonCustom.rules.threshold.header.text': 'Threshold',
			'msghub.i18n.core.common.MsgConstants.kind.status.label': 'Status',
			'msghub.i18n.core.common.MsgConstants.level.critical.label': 'Critical',
			'msghub.i18n.core.admin.common.MsgConstants.kind.status.label': 'Status',
			'msghub.i18n.core.admin.common.MsgConstants.level.critical.label': 'Critical',
		};

			const tab = createAdminTab({ objects, states, translations });
			const res = await tab.handleCommand('admin.ingestStates.presets.list', {});
			expect(res.ok).to.equal(true);
			expect(res.data).to.deep.equal([{
				value: 'pOwned',
				label: 'Threshold Status (Critical): Falsy (manual close)',
				source: 'user',
				ownedBy: 'Threshold',
				subset: null,
				kind: 'status',
				level: 50,
				name: 'Falsy (manual close)',
			}]);
		});

	it('filters invalid presets from list', async () => {
		const objects = new Map();
		const states = new Map();
		objects.set('msghub.0.IngestStates.0.presets.bad', {
			_id: 'msghub.0.IngestStates.0.presets.bad',
			type: 'state',
			common: { name: 'Bad', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.bad', { val: 'not json', ack: true });

		const tab = createAdminTab({ objects, states });
		const res = await tab.handleCommand('admin.ingestStates.presets.list', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.deep.equal([]);
	});

	it('list response includes ownedBy, subset, kind, level, name fields', async () => {
		const objects = new Map();
		const states = new Map();
		objects.set('msghub.0.IngestStates.0.presets.pFull', {
			_id: 'msghub.0.IngestStates.0.presets.pFull',
			type: 'state',
			common: { name: 'Full Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pFull', {
			val: JSON.stringify(makePresetValue({ presetId: 'pFull', ownedBy: 'Session', subset: 'start' })),
			ack: true,
		});

		const tab = createAdminTab({ objects, states });
		const res = await tab.handleCommand('admin.ingestStates.presets.list', {});
		expect(res.ok).to.equal(true);
		const item = res.data[0];
		expect(item.value).to.equal('pFull');
		expect(item.source).to.equal('user');
		expect(item.ownedBy).to.equal('Session');
		expect(item.subset).to.equal('start');
		expect(item.kind).to.equal('status');
		expect(item.level).to.equal(20);
		expect(item.name).to.equal('Full Preset');
	});

	it('list response nulls ownedBy and subset when absent or empty', async () => {
		const objects = new Map();
		const states = new Map();
		objects.set('msghub.0.IngestStates.0.presets.pNull', {
			_id: 'msghub.0.IngestStates.0.presets.pNull',
			type: 'state',
			common: { name: 'Null Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pNull', {
			val: JSON.stringify(makePresetValue({ presetId: 'pNull', ownedBy: null, subset: '' })),
			ack: true,
		});

		const tab = createAdminTab({ objects, states });
		const res = await tab.handleCommand('admin.ingestStates.presets.list', {});
		expect(res.ok).to.equal(true);
		const item = res.data[0];
		expect(item.ownedBy).to.equal(null);
		expect(item.subset).to.equal(null);
	});


	it('list response normalizes name from i18n object fallback', async () => {
		const objects = new Map();
		const states = new Map();
		objects.set('msghub.0.IngestStates.0.presets.pI18n', {
			_id: 'msghub.0.IngestStates.0.presets.pI18n',
			type: 'state',
			common: { name: { en: 'english name', de: 'german name' }, role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pI18n', {
			val: JSON.stringify(makePresetValue({ presetId: 'pI18n', ownedBy: null })),
			ack: true,
		});

		const tab = createAdminTab({ objects, states });
		const res = await tab.handleCommand('admin.ingestStates.presets.list', {});
		expect(res.ok).to.equal(true);
		expect(res.data[0].name).to.equal('English name');
	});

	it('keeps list responses unchanged when includeUsage is not requested', async () => {
		const objects = new Map();
		const states = new Map();
		objects.set('msghub.0.IngestStates.0.presets.pUsed', {
			_id: 'msghub.0.IngestStates.0.presets.pUsed',
			type: 'state',
			common: { name: 'Used Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pUsed', {
			val: JSON.stringify(makePresetValue({ presetId: 'pUsed', description: 'Used Preset' })),
			ack: true,
		});

		const tab = createAdminTab({ objects, states, presetUsage: [{ presetId: 'pUsed', usageCount: 4 }] });
		const res = await tab.handleCommand('admin.ingestStates.presets.list', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.have.length(1);
		expect(res.data[0]).to.not.have.property('usageCount');
	});

	it('adds usageCount from ioPlugins runtime usage when includeUsage is requested', async () => {
		const objects = new Map();
		const states = new Map();

		for (const name of ['Used Preset', 'Other Preset', 'Unused Preset']) {
			const presetId = name === 'Used Preset' ? 'pUsed' : name === 'Other Preset' ? 'pOther' : 'pUnused';
			objects.set(`msghub.0.IngestStates.0.presets.${presetId}`, {
				_id: `msghub.0.IngestStates.0.presets.${presetId}`,
				type: 'state',
				common: { name, role: 'json', type: 'string' },
				native: {},
			});
			states.set(`msghub.0.IngestStates.0.presets.${presetId}`, {
				val: JSON.stringify(makePresetValue({ presetId, description: name })),
				ack: true,
			});
		}

		const tab = createAdminTab({
			objects,
			states,
			presetUsage: [
				{ presetId: 'pUsed', usageCount: 2 },
				{ presetId: 'pOther', usageCount: 1 },
			],
		});
		const res = await tab.handleCommand('admin.ingestStates.presets.list', { includeUsage: true });
		expect(res.ok).to.equal(true);
		expect(res.data.map(item => item.value)).to.deep.equal(['pOther', 'pUnused', 'pUsed']);
		expect(res.data.find(item => item.value === 'pUsed').usageCount).to.equal(2);
		expect(res.data.find(item => item.value === 'pOther').usageCount).to.equal(1);
		expect(res.data.find(item => item.value === 'pUnused').usageCount).to.equal(0);
	});

	it('creates and reads a preset with backend-generated id', async () => {
		const tab = createAdminTab();
		const preset = makePresetValue({
			description: 'Sensor repair',
			message: { kind: 'task', level: 30, title: 'Fix sensor', text: 'Do it', timing: {}, details: {}, audience: {}, actions: [] },
		});
		delete preset.presetId;
		const create = await tab.handleCommand('admin.ingestStates.presets.create', { preset });
		expect(create.ok).to.equal(true);
		expect(create.data.presetId).to.equal('sensor-repair');

		const get = await tab.handleCommand('admin.ingestStates.presets.get', { presetId: 'sensor-repair' });
		expect(get.ok).to.equal(true);
		expect(get.data.preset.presetId).to.equal('sensor-repair');
	});

	it('creates unique numeric suffixes for duplicate preset descriptions', async () => {
		const tab = createAdminTab();
		const presetA = makePresetValue({
			description: 'Sensor repair',
			message: { kind: 'status', level: 20, title: 'Fix sensor', text: 'Do it', timing: {}, details: {}, audience: {}, actions: [] },
		});
		const presetB = makePresetValue({
			description: 'Sensor repair',
			message: { kind: 'status', level: 20, title: 'Fix sensor again', text: 'Do it', timing: {}, details: {}, audience: {}, actions: [] },
		});
		delete presetA.presetId;
		delete presetB.presetId;

		const createA = await tab.handleCommand('admin.ingestStates.presets.create', { preset: presetA });
		const createB = await tab.handleCommand('admin.ingestStates.presets.create', { preset: presetB });

		expect(createA.ok).to.equal(true);
		expect(createA.data.presetId).to.equal('sensor-repair');
		expect(createB.ok).to.equal(true);
		expect(createB.data.presetId).to.equal('sensor-repair-2');
	});

	it('rejects presetId in create payload', async () => {
		const tab = createAdminTab();
		const preset = makePresetValue({
			presetId: 'manual-id',
			description: 'Manual id',
		});
		const create = await tab.handleCommand('admin.ingestStates.presets.create', { preset });
		expect(create.ok).to.equal(false);
		expect(create.error.code).to.equal('BAD_REQUEST');
	});

	it('rejects invalid presets on create', async () => {
		const tab = createAdminTab();
		const preset = makePresetValue({
			description: 'x',
			message: { kind: 'status', level: 20, title: '', text: '', timing: {}, details: {}, audience: {}, actions: [] },
		});
		delete preset.presetId;
		const create = await tab.handleCommand('admin.ingestStates.presets.create', { preset });
		expect(create.ok).to.equal(false);
		expect(create.error.code).to.equal('BAD_REQUEST');
	});

	it('allows user presets with ownedBy to be created via admin', async () => {
		const tab = createAdminTab();
		const preset = makePresetValue({
			description: 'Session start custom',
			ownedBy: 'Session',
			subset: 'start',
		});
		delete preset.presetId;
		const create = await tab.handleCommand('admin.ingestStates.presets.create', { preset });
		expect(create.ok).to.equal(true);
		expect(create.data.presetId).to.equal('session-start-custom');

		const get = await tab.handleCommand('admin.ingestStates.presets.get', { presetId: 'session-start-custom' });
		expect(get.ok).to.equal(true);
		expect(get.data.preset.source).to.equal('user');
		expect(get.data.preset.ownedBy).to.equal('Session');
		expect(get.data.preset.subset).to.equal('start');
	});

	it('updates an existing user preset by payload presetId', async () => {
		const objects = new Map();
		const states = new Map();
		objects.set('msghub.0.IngestStates.0.presets.p1', {
			_id: 'msghub.0.IngestStates.0.presets.p1',
			type: 'state',
			common: { name: 'Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.p1', {
			val: JSON.stringify(makePresetValue({ presetId: 'p1', description: 'Preset' })),
			ack: true,
		});

		const tab = createAdminTab({ objects, states });
		const preset = makePresetValue({
			description: 'Renamed preset',
			message: { kind: 'status', level: 30, title: 'Renamed', text: 'Updated', timing: {}, details: {}, audience: {}, actions: [] },
		});
		delete preset.presetId;

		const update = await tab.handleCommand('admin.ingestStates.presets.update', { presetId: 'p1', preset });
		expect(update.ok).to.equal(true);
		expect(update.data.presetId).to.equal('p1');

		const get = await tab.handleCommand('admin.ingestStates.presets.get', { presetId: 'p1' });
		expect(get.ok).to.equal(true);
		expect(get.data.preset.presetId).to.equal('p1');
		expect(get.data.preset.description).to.equal('Renamed preset');
		expect(get.data.preset.message.level).to.equal(30);
	});

	it('rejects builtin presets on create', async () => {
		const tab = createAdminTab();
		const preset = makePresetValue({
			description: 'Builtin clone',
			source: 'builtin',
			ownedBy: 'Threshold',
		});
		delete preset.presetId;
		const create = await tab.handleCommand('admin.ingestStates.presets.create', { preset });
		expect(create.ok).to.equal(false);
		expect(create.error.code).to.equal('FORBIDDEN');
	});

	it('rejects deleting builtin presets', async () => {
		const objects = new Map();
		const states = new Map();
		objects.set('msghub.0.IngestStates.0.presets.imm', {
			_id: 'msghub.0.IngestStates.0.presets.imm',
			type: 'state',
			common: { name: 'Imm', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.imm', {
			val: JSON.stringify(makePresetValue({ presetId: 'imm', source: 'builtin', ownedBy: 'Threshold' })),
			ack: true,
		});

		const tab = createAdminTab({ objects, states });
		const del = await tab.handleCommand('admin.ingestStates.presets.delete', { presetId: 'imm' });
		expect(del.ok).to.equal(false);
		expect(del.error.code).to.equal('FORBIDDEN');
	});

	it('exposes presetBindingCatalog via admin.ingestStates.constants.get', async () => {
		const tab = createAdminTab();
		const res = await tab.handleCommand('admin.ingestStates.constants.get', {});
		expect(res.ok).to.equal(true);
		expect(res.data.presetBindingCatalog).to.be.an('object');
		expect(res.data.presetBindingCatalog.threshold.ownedBy).to.equal('Threshold');
		expect(res.data.presetBindingCatalog.threshold.subsets.map(item => item.value)).to.deep.equal([
			'lt',
			'gt',
			'inside',
			'outside',
			'truthy',
			'falsy',
		]);
		expect(res.data.presetBindingCatalog.cycle.subsets).to.deep.equal([]);
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
			bundle: { hash: 'abc123' },
			...overrides,
		};
	}

	it('returns contributions from running plugins', async () => {
		const contributions = [makeContribution()];
		const ioPlugins = { getAdminUiContributions: () => contributions };
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.deep.equal(contributions);
	});

	it('returns empty array when no plugin has adminUi', async () => {
		const ioPlugins = { getAdminUiContributions: () => [] };
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.deep.equal([]);
	});

	it('returns contributions from multiple instances of same type', async () => {
		const contributions = [makeContribution({ instanceId: 0 }), makeContribution({ instanceId: 1 })];
		const ioPlugins = { getAdminUiContributions: () => contributions };
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.have.length(2);
	});

	it('returns NOT_READY when ioPlugins is null', async () => {
		const tab = new IoAdminTab(createAdapter(), null);
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
			bundle: { hash: 'abc123' },
			...overrides,
		};
	}

	function makeIoPlugins({ contributions, jsContent = 'export function mount(){}', cssContent = null, readError = null } = {}) {
		let readCalls = 0;
		return {
			getAdminUiContributions: () => contributions ?? [makeContrib()],
			readAdminUiBundle: async () => {
				readCalls++;
				if (readError) {
					throw readError;
				}
				return { js: jsContent, css: cssContent };
			},
			_readCallCount: () => readCalls,
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
		expect(res.data.hash).to.equal('abc123');
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
