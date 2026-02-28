'use strict';

const { expect } = require('chai');

const lib = require('./index');

describe('lib/index autodiscovery', () => {
	it('builds IoPluginsCatalog from discovered plugin manifests', () => {
		expect(lib).to.have.property('IoPluginsCategories');
		expect(lib).to.have.property('IoPluginsCatalog');

		const catalog = lib.IoPluginsCatalog;
		expect(catalog).to.be.an('object');
		expect(catalog.ingest).to.be.an('array');
		expect(catalog.notify).to.be.an('array');
		expect(catalog.bridge).to.be.an('array');
		expect(catalog.engage).to.be.an('array');

		const types = [
			...catalog.ingest.map(p => p.type),
			...catalog.notify.map(p => p.type),
			...catalog.bridge.map(p => p.type),
			...catalog.engage.map(p => p.type),
		];

		for (const category of ['ingest', 'notify', 'bridge', 'engage']) {
			for (const p of catalog[category]) {
				expect(p).to.have.property('type');
				expect(p).to.have.property('create');
				expect(p.create).to.be.a('function');
				expect(lib).to.have.property(p.type);
				expect(lib[p.type]).to.be.a('function');
			}
		}

		expect(types.every(t => typeof t === 'string' && t.trim())).to.equal(true);
	});

	it('exports discovered factories by their type name', () => {
		expect(lib).to.have.property('IoPluginsCatalog');
		const catalog = lib.IoPluginsCatalog;
		for (const category of ['ingest', 'notify', 'bridge', 'engage']) {
			for (const p of catalog[category]) {
				expect(lib[p.type]).to.be.a('function');
			}
		}
	});
});
