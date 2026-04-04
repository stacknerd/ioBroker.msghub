'use strict';

const { expect } = require('chai');

describe('IngestStates manifest producer contract', () => {
	it('ships adminUi panels on the hard-migrated producer contract without legacy aliases', () => {
		const { manifest } = require('./index');
		expect(manifest.adminUi).to.be.an('object');
		expect(manifest.adminUi.panels).to.be.an('array').that.is.not.empty;

		for (const panel of manifest.adminUi.panels) {
			expect(panel.id).to.be.a('string').and.not.match(/^tab-/);
			expect(panel.label).to.be.a('string');
			expect(panel.description).to.be.a('string');
			expect(panel.surface).to.be.a('string');
			expect(panel.category).to.be.a('string');
			expect(panel).to.not.have.property('title');
		}

		const presets = manifest.adminUi.panels.find(panel => panel.id === 'presets');
		expect(presets?.app?.url).to.equal('?panel=tab-plugin-IngestStates-0-presets');
	});
});
