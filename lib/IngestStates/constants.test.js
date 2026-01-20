'use strict';

const { expect } = require('chai');
const { jsonCustomDefaults, presetSchema, presetTemplateV1, fallbackPresetId, createFallbackPreset } = require('./constants');

describe('IngestStates constants', () => {
	function collectJsonCustomFields({ ignoreManagedMeta = true } = {}) {
		const jsonCustom = require('../../admin/jsonCustom.json');
		const items = jsonCustom?.items || {};

		const fields = new Map();

		for (const tab of Object.values(items)) {
			const tabItems = tab?.items || {};
			for (const [key, field] of Object.entries(tabItems)) {
				if (key.startsWith('_')) {
					continue;
				}
				if (ignoreManagedMeta && key.startsWith('managedMeta-')) {
					continue;
				}
				fields.set(key, field);
			}
		}

		return fields;
	}

	it('exports stable schema identifiers', () => {
		expect(presetSchema).to.equal('msghub.IngestStatesMessagePreset.v1');
		expect(fallbackPresetId).to.equal('$fallback');
	});

	it('provides a frozen preset template', () => {
		expect(presetTemplateV1).to.be.an('object');
		expect(Object.isFrozen(presetTemplateV1)).to.equal(true);
		expect(presetTemplateV1.schema).to.equal(presetSchema);
	});

		it('creates an internal fallback preset (no iobroker state)', () => {
			const p = createFallbackPreset({ targetId: 'dev.0.x' });
			expect(p).to.be.an('object');
			expect(p.schema).to.equal(presetSchema);
			expect(p.presetId).to.equal(fallbackPresetId);
			expect(p.ownedBy).to.equal('internal');
			expect(p.message).to.be.an('object');
			expect(p.message.title).to.equal('Missing message preset');
			expect(p.message.text).to.include('dev.0.x');
		});

	it('jsonCustomDefaults matches admin/jsonCustom.json fields (ignoring managedMeta-*)', () => {
		const fields = collectJsonCustomFields({ ignoreManagedMeta: true });
		const uiKeys = Array.from(fields.keys()).sort();

		const defaults = jsonCustomDefaults;
		expect(defaults).to.be.an('object');
		expect(Object.isFrozen(defaults)).to.equal(true);

		const defaultKeys = Object.keys(defaults).sort();
		expect(defaultKeys).to.deep.equal(uiKeys);
	});

	it('jsonCustomDefaults matches jsonCustom default values where defined', () => {
		const fields = collectJsonCustomFields({ ignoreManagedMeta: true });

		for (const [key, field] of fields.entries()) {
			if (!Object.prototype.hasOwnProperty.call(field, 'default')) {
				continue;
			}

			expect(
				jsonCustomDefaults[key],
				`default mismatch for '${key}'`,
			).to.deep.equal(field.default);
		}
	});
});
