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
});

describe('IoAdminTab archive strategy commands', () => {
	function createAdminTabWithArchive({ probeResult } = {}) {
		let probeCalls = 0;
		const adapter = {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
		const archive = {
			getStatus() {
				return {
					configuredStrategyLock: 'native',
					effectiveStrategy: 'native',
					effectiveStrategyReason: 'auto-initial',
					baseDir: 'data/archive',
					fileExtension: 'jsonl',
					nativeRootDir: '/tmp/msghub.0',
					runtimeRoot: '/tmp/msghub.0/data/archive',
					nativeProbeError: '',
				};
			},
		};
		const msgStore = { msgArchive: archive };
		const archiveProbeNative = async () => {
			probeCalls += 1;
			return probeResult || { ok: true, reason: 'ok' };
		};
		return { tab: new IoAdminTab(adapter, null, { msgStore, archiveProbeNative }), getProbeCalls: () => probeCalls };
	}

	it('returns native patch for retryNative on successful probe', async () => {
		const { tab, getProbeCalls } = createAdminTabWithArchive({ probeResult: { ok: true, reason: 'ok' } });
		const res = await tab.handleCommand('admin.archive.retryNative', {});
		expect(getProbeCalls()).to.equal(1);
		expect(res.ok).to.equal(true);
		expect(res.native).to.be.an('object');
		expect(res.native.archiveEffectiveStrategyLock).to.equal('native');
		expect(res.native.archiveLockReason).to.equal('manual-upgrade');
		expect(res.native.archiveLockedAt).to.be.a('number');
	});

	it('returns error without native patch when retryNative probe fails', async () => {
		const { tab, getProbeCalls } = createAdminTabWithArchive({
			probeResult: { ok: false, reason: 'missing-instance-data-dir' },
		});
		const res = await tab.handleCommand('admin.archive.retryNative', {});
		expect(getProbeCalls()).to.equal(1);
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NATIVE_PROBE_FAILED');
		expect(res).to.not.have.property('native');
	});

	it('returns native patch for forceIobroker', async () => {
		const { tab } = createAdminTabWithArchive({ probeResult: { ok: true, reason: 'ok' } });
		const res = await tab.handleCommand('admin.archive.forceIobroker', {});
		expect(res.ok).to.equal(true);
		expect(res.native).to.be.an('object');
		expect(res.native.archiveEffectiveStrategyLock).to.equal('iobroker');
		expect(res.native.archiveLockReason).to.equal('manual-downgrade');
		expect(res.native.archiveLockedAt).to.be.a('number');
	});

	it('returns runtime transparency snapshot for archive.status', async () => {
		const { tab } = createAdminTabWithArchive({ probeResult: { ok: true, reason: 'ok' } });
		const res = await tab.handleCommand('admin.archive.status', {});
		expect(res.ok).to.equal(true);
		expect(res.data.archive.effectiveStrategy).to.equal('native');
		expect(res.data.archive.effectiveStrategyReason).to.equal('auto-initial');
		expect(res.native.archiveRuntimeStrategy).to.equal('native');
		expect(res.native.archiveRuntimeReason).to.equal('auto-initial');
		expect(res.native.archiveRuntimeRoot).to.equal('/tmp/msghub.0/data/archive');
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
			i18n: {
				t: key => i18nMap[key] || String(key),
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

	function createAdminTab({ objects, states, translations, enabled = true } = {}) {
		const adapter = createAdapter({ objects, states, translations });
		const ioPlugins = {
			listInstances: async () =>
				enabled ? [{ type: 'IngestStates', instanceId: 0, enabled: true }] : [{ type: 'IngestStates', instanceId: 0, enabled: false }],
		};
		return new IoAdminTab(adapter, ioPlugins);
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
				val: JSON.stringify({
					schema: 'msghub.IngestStatesMessagePreset.v1',
					presetId: 'p1',
					description: 'Preset One',
					ownedBy: null,
					message: { kind: 'status', level: 20, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
					policy: { resetOnNormal: true },
					ui: { timingUnits: {} },
				}),
			ack: true,
		});

			const tab = createAdminTab({ objects, states });
			const res = await tab.handleCommand('admin.ingestStates.presets.list', {});
			expect(res.ok).to.equal(true);
			expect(res.data).to.deep.equal([
				{
					value: 'p1',
					label: 'msghub.i18n.IngestStates.admin.jsonCustom.preset.custom.label msghub.i18n.core.admin.common.MsgConstants.kind.status.label (msghub.i18n.core.admin.common.MsgConstants.level.notice.label): Preset One',
				},
			]);
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
			val: JSON.stringify({
				schema: 'msghub.IngestStatesMessagePreset.v1',
				presetId: 'pOwned',
				description: 'Owned Preset',
				ownedBy: 'session',
				subset: 'start',
				message: { kind: 'status', level: 20, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: true },
				ui: { timingUnits: {} },
			}),
			ack: true,
		});

		objects.set('msghub.0.IngestStates.0.presets.pFree', {
			_id: 'msghub.0.IngestStates.0.presets.pFree',
			type: 'state',
			common: { name: 'Free Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pFree', {
			val: JSON.stringify({
				schema: 'msghub.IngestStatesMessagePreset.v1',
				presetId: 'pFree',
				description: 'Free Preset',
				ownedBy: '',
				subset: '',
				message: { kind: 'status', level: 20, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: true },
				ui: { timingUnits: {} },
			}),
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
			val: JSON.stringify({
				schema: 'msghub.IngestStatesMessagePreset.v1',
				presetId: 'pStart',
				description: 'Start Preset',
				ownedBy: 'session',
				subset: 'start',
				message: { kind: 'status', level: 20, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: true },
				ui: { timingUnits: {} },
			}),
			ack: true,
		});

		objects.set('msghub.0.IngestStates.0.presets.pEnd', {
			_id: 'msghub.0.IngestStates.0.presets.pEnd',
			type: 'state',
			common: { name: 'End Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pEnd', {
			val: JSON.stringify({
				schema: 'msghub.IngestStatesMessagePreset.v1',
				presetId: 'pEnd',
				description: 'End Preset',
				ownedBy: 'session',
				subset: 'end',
				message: { kind: 'status', level: 20, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: true },
				ui: { timingUnits: {} },
			}),
			ack: true,
		});

		objects.set('msghub.0.IngestStates.0.presets.pFree', {
			_id: 'msghub.0.IngestStates.0.presets.pFree',
			type: 'state',
			common: { name: 'Free Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pFree', {
			val: JSON.stringify({
				schema: 'msghub.IngestStatesMessagePreset.v1',
				presetId: 'pFree',
				description: 'Free Preset',
				ownedBy: '',
				subset: '',
				message: { kind: 'status', level: 20, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: true },
				ui: { timingUnits: {} },
			}),
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
			val: JSON.stringify({
				schema: 'msghub.IngestStatesMessagePreset.v1',
				presetId: 'pOwned',
				description: 'Owned Preset',
				ownedBy: 'session',
				message: { kind: 'status', level: 20, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: true },
				ui: { timingUnits: {} },
			}),
			ack: true,
		});

		objects.set('msghub.0.IngestStates.0.presets.pFree', {
			_id: 'msghub.0.IngestStates.0.presets.pFree',
			type: 'state',
			common: { name: 'AAA Free Preset', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.pFree', {
			val: JSON.stringify({
				schema: 'msghub.IngestStatesMessagePreset.v1',
				presetId: 'pFree',
				description: 'Free Preset',
				ownedBy: null,
				message: { kind: 'status', level: 20, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: true },
				ui: { timingUnits: {} },
			}),
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
			val: JSON.stringify({
				schema: 'msghub.IngestStatesMessagePreset.v1',
				presetId: 'pOwned',
				description: 'falsy (manual close)',
				ownedBy: 'Threshold',
				message: { kind: 'status', level: 50, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: false },
				ui: { timingUnits: {} },
			}),
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
			expect(res.data).to.deep.equal([{ value: 'pOwned', label: 'Threshold Status (Critical): Falsy (manual close)' }]);
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

	it('creates and reads a preset', async () => {
		const tab = createAdminTab();
			const preset = {
				schema: 'msghub.IngestStatesMessagePreset.v1',
				presetId: 'sensorRepair',
				description: 'Sensor repair',
				ownedBy: null,
				message: { kind: 'task', level: 30, title: 'Fix sensor', text: 'Do it', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: true },
				ui: { timingUnits: {} },
			};
		const up = await tab.handleCommand('admin.ingestStates.presets.upsert', { preset });
		expect(up.ok).to.equal(true);

		const get = await tab.handleCommand('admin.ingestStates.presets.get', { presetId: 'sensorRepair' });
		expect(get.ok).to.equal(true);
		expect(get.data.preset.presetId).to.equal('sensorRepair');
	});

	it('rejects invalid presets on upsert', async () => {
		const tab = createAdminTab();
			const preset = {
				schema: 'msghub.IngestStatesMessagePreset.v1',
				presetId: 'x1',
				description: 'x',
				ownedBy: null,
				message: { kind: 'status', level: 20, title: '', text: '', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: true },
				ui: { timingUnits: {} },
			};
		const up = await tab.handleCommand('admin.ingestStates.presets.upsert', { preset });
		expect(up.ok).to.equal(false);
		expect(up.error.code).to.equal('BAD_REQUEST');
	});

		it('rejects deleting owned presets', async () => {
			const objects = new Map();
			const states = new Map();
			objects.set('msghub.0.IngestStates.0.presets.imm', {
				_id: 'msghub.0.IngestStates.0.presets.imm',
				type: 'state',
				common: { name: 'Imm', role: 'json', type: 'string' },
				native: {},
			});
			states.set('msghub.0.IngestStates.0.presets.imm', {
				val: JSON.stringify({ schema: 'msghub.IngestStatesMessagePreset.v1', presetId: 'imm', ownedBy: 'Threshold' }),
				ack: true,
			});

		const tab = createAdminTab({ objects, states });
		const del = await tab.handleCommand('admin.ingestStates.presets.delete', { presetId: 'imm' });
		expect(del.ok).to.equal(false);
		expect(del.error.code).to.equal('FORBIDDEN');
	});
});
