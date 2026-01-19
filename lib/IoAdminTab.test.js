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

describe('IoAdminTab IngestStates presets', () => {
	function createAdapter({ objects, states } = {}) {
		const objMap = objects || new Map();
		const stMap = states || new Map();

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

	function createAdminTab({ objects, states, enabled = true } = {}) {
		const adapter = createAdapter({ objects, states });
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
				immutable: false,
				message: { kind: 'status', level: 20, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: true },
				ui: { timingUnits: {} },
			}),
			ack: true,
		});

		const tab = createAdminTab({ objects, states });
		const res = await tab.handleCommand('admin.ingestStates.presets.list', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.deep.equal([{ value: 'p1', label: 'Preset One' }]);
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
			immutable: false,
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
			immutable: false,
			message: { kind: 'status', level: 20, title: '', text: '', timing: {}, details: {}, audience: {}, actions: [] },
			policy: { resetOnNormal: true },
			ui: { timingUnits: {} },
		};
		const up = await tab.handleCommand('admin.ingestStates.presets.upsert', { preset });
		expect(up.ok).to.equal(false);
		expect(up.error.code).to.equal('BAD_REQUEST');
	});

	it('rejects deleting immutable presets', async () => {
		const objects = new Map();
		const states = new Map();
		objects.set('msghub.0.IngestStates.0.presets.imm', {
			_id: 'msghub.0.IngestStates.0.presets.imm',
			type: 'state',
			common: { name: 'Imm', role: 'json', type: 'string' },
			native: {},
		});
		states.set('msghub.0.IngestStates.0.presets.imm', {
			val: JSON.stringify({ schema: 'msghub.IngestStatesMessagePreset.v1', presetId: 'imm', immutable: true }),
			ack: true,
		});

		const tab = createAdminTab({ objects, states });
		const del = await tab.handleCommand('admin.ingestStates.presets.delete', { presetId: 'imm' });
		expect(del.ok).to.equal(false);
		expect(del.error.code).to.equal('FORBIDDEN');
	});
});
