'use strict';

const { expect } = require('chai');

describe('IngestStates index exports', () => {
	it('exports IngestStates factory and manifest', () => {
		const mod = require('./index');
		expect(mod).to.have.property('IngestStates').that.is.a('function');
		expect(mod).to.have.property('manifest').that.is.an('object');
		expect(mod.manifest).to.have.property('type', 'IngestStates');
	});
});

