'use strict';

const { expect } = require('chai');

const {
	clonePresetTemplate,
	extractPresetName,
	normalizePreset,
	parsePresetState,
	validatePreset,
} = require('./AdminPresets');

describe('IngestStates AdminPresets', () => {
	it('clones the canonical preset template for new drafts', () => {
		const preset = clonePresetTemplate();
		expect(preset).to.be.an('object');
		expect(preset.schema).to.equal('msghub.IngestStatesMessagePreset.v1');
		expect(preset.source).to.equal('user');
		expect(preset.message.kind).to.equal('status');
		expect(preset.message.level).to.equal(20);
		expect(preset).to.not.equal(clonePresetTemplate());
	});

	it('normalizes incomplete preset payloads with template defaults', () => {
		const preset = normalizePreset({
			description: '  Example  ',
			ownedBy: '',
			subset: '',
			message: {
				title: 'Title',
				text: 'Text',
				timing: { cooldown: 'invalid' },
				details: { tools: [' hammer ', '', null] },
			},
			ui: { transient: true },
		});

		expect(preset.schema).to.equal('msghub.IngestStatesMessagePreset.v1');
		expect(preset.presetId).to.equal('');
		expect(preset.description).to.equal('  Example  ');
		expect(preset.ownedBy).to.equal(null);
		expect(preset.subset).to.equal(null);
		expect(preset.message.kind).to.equal('status');
		expect(preset.message.level).to.equal(20);
		expect(preset.message.timing.cooldown).to.equal(0);
		expect(preset.message.details.tools).to.deep.equal(['hammer']);
		expect(preset).to.not.have.property('ui');
	});

	it('parses, normalizes and validates stored preset JSON in one step', () => {
		const raw = JSON.stringify({
			schema: 'msghub.IngestStatesMessagePreset.v1',
			presetId: 'p1',
			description: 'Preset',
			source: 'user',
			message: { kind: 'status', level: 20, title: 'Title', text: 'Text' },
			policy: {},
		});

		const { preset, error } = parsePresetState(raw, { presetId: 'p1' });
		expect(error).to.equal(null);
		expect(validatePreset(preset, { expectedPresetId: 'p1' })).to.equal(null);
		expect(preset.message.textRecovered).to.equal('');
	});

	it('extracts a readable preset name from ioBroker object names', () => {
		expect(
			extractPresetName({
				presetId: 'p1',
				obj: { common: { name: { en: 'english name', de: 'deutscher name' } } },
				preset: { description: 'fallback' },
			}),
		).to.equal('English name');
	});
});
