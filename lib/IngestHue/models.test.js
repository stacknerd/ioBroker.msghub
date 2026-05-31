'use strict';

const { expect } = require('chai');

const { HUE_MODELS } = require('./models');

describe('IngestHue models', () => {
	it('keeps model metadata immutable and i18n-key based', () => {
		const model = HUE_MODELS.SML001;

		expect(Object.isFrozen(model)).to.equal(true);
		expect(model.labelKey).to.equal('msghub.i18n.IngestHue.model.motionSensor.label');
		expect(model.consumableKeys).to.deep.equal([
			'msghub.i18n.IngestHue.consumable.aaa.label',
			'msghub.i18n.IngestHue.consumable.aaa.label',
		]);
		expect(model.toolKeys).to.deep.equal(['msghub.i18n.IngestHue.tool.ph2Phillips.label']);
		expect(model.estimatedTimeMs).to.equal(10 * 60 * 1000);
	});

	it('assigns an explicit task estimate to every known model', () => {
		for (const model of Object.values(HUE_MODELS)) {
			expect(model).to.have.own.property('estimatedTimeMs');
			expect(model.estimatedTimeMs).to.be.a('number');
			expect(model.estimatedTimeMs).to.be.greaterThan(0);
		}
	});

	it('does not expose hard-coded presentation text in model metadata', () => {
		for (const model of Object.values(HUE_MODELS)) {
			expect(model.labelKey).to.match(/^msghub\.i18n\.IngestHue\./u);
			for (const key of model.consumableKeys) {
				expect(key).to.match(/^msghub\.i18n\.IngestHue\./u);
			}
			for (const key of model.toolKeys) {
				expect(key).to.match(/^msghub\.i18n\.IngestHue\./u);
			}
		}
	});
});
