'use strict';

const { expect } = require('chai');

const { createPresetResolver, PRESET_SCHEMA } = require('./PresetResolver');

function makeCtx({ namespace = 'msghub.0', instanceId = 0, objects = {}, states = {}, log = null } = {}) {
	const logs = log || { errors: [], error: msg => logs.errors.push(String(msg)) };

	return {
		api: {
			log: logs,
			iobroker: {
				ids: { namespace },
				objects: {
					getForeignObject: async id => objects[id] || null,
				},
				states: {
					getForeignState: async id => states[id] || null,
				},
			},
		},
		meta: {
			plugin: {
				instanceId,
				baseFullId: `${namespace}.IngestStates.${instanceId}`,
			},
		},
	};
}

describe('IngestStates PresetResolver', () => {
	it('returns null and logs error for invalid presetId', async () => {
		const ctx = makeCtx();
		const r = createPresetResolver(ctx);
		const res = await r.resolvePreset('bad id');
		expect(res).to.equal(null);
		expect(ctx.api.log.errors.join('\n')).to.match(/invalid presetId/i);
	});

	it('returns null and logs error when object is missing', async () => {
		const ctx = makeCtx();
		const r = createPresetResolver(ctx);
		const res = await r.resolvePreset('p1');
		expect(res).to.equal(null);
		expect(ctx.api.log.errors.join('\n')).to.match(/missing preset object/i);
	});

	it('returns null and logs error when JSON is missing', async () => {
		const id = 'msghub.0.IngestStates.0.presets.p1';
		const ctx = makeCtx({
			objects: { [id]: { _id: id, type: 'state', common: { name: 'P1' }, native: {} } },
			states: { [id]: { val: '', ack: true } },
		});
		const r = createPresetResolver(ctx);
		const res = await r.resolvePreset('p1');
		expect(res).to.equal(null);
		expect(ctx.api.log.errors.join('\n')).to.match(/missing preset JSON/i);
	});

	it('returns null and logs error when JSON is invalid', async () => {
		const id = 'msghub.0.IngestStates.0.presets.p1';
		const ctx = makeCtx({
			objects: { [id]: { _id: id, type: 'state', common: { name: 'P1' }, native: {} } },
			states: { [id]: { val: '{', ack: true } },
		});
		const r = createPresetResolver(ctx);
		const res = await r.resolvePreset('p1');
		expect(res).to.equal(null);
		expect(ctx.api.log.errors.join('\n')).to.match(/invalid preset JSON/i);
	});

	it('returns null and logs error when schema is wrong', async () => {
		const id = 'msghub.0.IngestStates.0.presets.p1';
		const ctx = makeCtx({
			objects: { [id]: { _id: id, type: 'state', common: { name: 'P1' }, native: {} } },
			states: { [id]: { val: JSON.stringify({ schema: 'nope', presetId: 'p1' }), ack: true } },
		});
		const r = createPresetResolver(ctx);
		const res = await r.resolvePreset('p1');
		expect(res).to.equal(null);
		expect(ctx.api.log.errors.join('\n')).to.match(/invalid preset/i);
	});

	it('returns preset when valid', async () => {
		const id = 'msghub.0.IngestStates.0.presets.p1';
			const preset = {
				schema: PRESET_SCHEMA,
				presetId: 'p1',
				description: 'Preset One',
				ownedBy: null,
				message: { kind: 'status', level: 20, title: 'T', text: 'X', timing: {}, details: {}, audience: {}, actions: [] },
				policy: { resetOnNormal: true },
				ui: { timingUnits: {} },
			};
		const ctx = makeCtx({
			objects: { [id]: { _id: id, type: 'state', common: { name: 'Preset One' }, native: {} } },
			states: { [id]: { val: JSON.stringify(preset), ack: true } },
		});
		const r = createPresetResolver(ctx);
		const res = await r.resolvePreset('p1');
		expect(res).to.not.equal(null);
		expect(res.presetId).to.equal('p1');
		expect(res.objectId).to.equal(id);
		expect(res.preset).to.deep.equal(preset);
	});
});
