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

		// Regression: ensure the known built-in plugins are discovered.
		expect(types).to.include('IngestRandomChaos');
		expect(types).to.include('IngestHue');
		expect(types).to.include('NotifyStates');
		expect(types).to.include('NotifyDebug');
		expect(types).to.include('EngageSendTo');

		for (const category of ['ingest', 'notify', 'bridge', 'engage']) {
			for (const p of catalog[category]) {
				expect(p).to.have.property('type');
				expect(p).to.have.property('create');
				expect(p.create).to.be.a('function');
			}
		}
	});

	it('exports discovered factories by their type name', () => {
		expect(lib.IngestRandomChaos).to.be.a('function');
		expect(lib.IngestHue).to.be.a('function');
		expect(lib.NotifyStates).to.be.a('function');
		expect(lib.NotifyDebug).to.be.a('function');
		expect(lib.EngageSendTo).to.be.a('function');
	});
});

