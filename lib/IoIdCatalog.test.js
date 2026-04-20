'use strict';

const { expect } = require('chai');

const { IoIdCatalog } = require('./IoIdCatalog');

describe('IoIdCatalog', () => {
	function createCatalogHarness({ objects, ttlMs = 1000 } = {}) {
		let now = 1000;
		let perf = 0;
		let reads = 0;
		let currentObjects = objects || {};
		const adapter = {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
			async getForeignObjectsAsync(pattern, type) {
				reads += 1;
				expect(pattern).to.equal('*');
				expect(type).to.equal('state');
				return currentObjects;
			},
		};
		const catalog = new IoIdCatalog(adapter, {
			ttlMs,
			now: () => now,
			performanceNow: () => {
				const value = perf;
				perf += 5;
				return value;
			},
		});
		return {
			catalog,
			getReadCount: () => reads,
			setObjects(nextObjects) {
				currentObjects = nextObjects;
			},
			advanceNow(ms) {
				now += ms;
			},
		};
	}

	function createDeferred() {
		let resolve;
		let reject;
		const promise = new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		});
		return { promise, resolve, reject };
	}

	it('builds one reduced full-cache and serves get(filter) from it', async () => {
		const { catalog, getReadCount } = createCatalogHarness({
			objects: {
				'zigbee.0.sensor.temperature': {
					_id: 'zigbee.0.sensor.temperature',
					type: 'state',
					common: {
						name: 'Temperature',
						type: 'number',
						role: 'value.temperature',
						unit: 'C',
						read: true,
						write: false,
						custom: { ignored: true },
					},
					native: { ignored: true },
					acl: { object: 1 },
				},
				'zigbee.0.device': {
					_id: 'zigbee.0.device',
					type: 'channel',
					common: { name: 'Ignore me' },
				},
				'javascript.0.foo': {
					_id: 'javascript.0.foo',
					type: 'state',
					common: { name: 'Foo', type: 'boolean' },
				},
			},
		});

		const res = await catalog.get({ filter: 'zigbee.0.*' });

		expect(getReadCount()).to.equal(1);
		expect(res).to.deep.equal({
			ok: true,
			data: {
				objects: {
					'zigbee.0.sensor.temperature': {
						_id: 'zigbee.0.sensor.temperature',
						common: {
							name: 'Temperature',
							type: 'number',
							role: 'value.temperature',
							unit: 'C',
						},
					},
				},
				meta: {
					backendDurationMs: 5,
					createdAt: 1000,
					ttlMs: 1000,
				},
			},
		});
	});

	it('reuses one shared cache and returns the same cache meta for get and openTree', async () => {
		const { catalog, getReadCount } = createCatalogHarness({
			objects: {
				'javascript.0.foo.bar': {
					_id: 'javascript.0.foo.bar',
					type: 'state',
					common: { name: 'Bar', type: 'number' },
				},
			},
		});

		const getRes = await catalog.get({ filter: '*' });
		const treeRes = await catalog.openTree({ entry: 'javascript.0', depth: 2 });

		expect(getReadCount()).to.equal(1);
		expect(getRes.data.meta).to.deep.equal({
			backendDurationMs: 5,
			createdAt: 1000,
			ttlMs: 1000,
		});
		expect(treeRes.data.meta).to.deep.equal({
			backendDurationMs: 5,
			createdAt: 1000,
			ttlMs: 1000,
		});
	});

	it('returns root-tree nodes from the shared cache without another backend read', async () => {
		const { catalog, getReadCount } = createCatalogHarness({
			objects: {
				'javascript.0.a.b': {
					_id: 'javascript.0.a.b',
					type: 'state',
					common: { name: 'AB', type: 'boolean', role: 'switch' },
				},
				'system.adapter.web.1.memRss': {
					_id: 'system.adapter.web.1.memRss',
					type: 'state',
					common: { name: 'RSS', type: 'number', unit: 'MB' },
				},
			},
		});

		const res = await catalog.openTree({ depth: 1 });

		expect(getReadCount()).to.equal(1);
		expect(res.ok).to.equal(true);
		expect(res.data.entry).to.equal('');
		expect(res.data.depth).to.equal(1);
		expect(res.data.nodes).to.deep.equal([
			{
				entry: 'javascript.0',
				parent: '',
				level: 1,
				label: 'javascript.0',
				expandable: true,
			},
			{
				entry: 'system.adapter.web.1',
				parent: '',
				level: 1,
				label: 'system.adapter.web.1',
				expandable: true,
			},
		]);
	});

	it('returns subtree nodes and exact state projections from the shared cache', async () => {
		const { catalog } = createCatalogHarness({
			objects: {
				'javascript.0.foo.bar': {
					_id: 'javascript.0.foo.bar',
					type: 'state',
					common: { name: 'Bar', type: 'number', role: 'value', unit: 'W' },
				},
				'javascript.0.foo.baz.qux': {
					_id: 'javascript.0.foo.baz.qux',
					type: 'state',
					common: { name: 'Qux', type: 'string' },
				},
			},
		});

		const res = await catalog.openTree({ entry: 'javascript.0', depth: 3 });

		expect(res.ok).to.equal(true);
		expect(res.data.ancestors).to.deep.equal([
			{
				entry: 'javascript.0',
				parent: '',
				level: 1,
				label: 'javascript.0',
				expandable: true,
			},
		]);
		expect(res.data.nodes).to.deep.equal([
			{
				entry: 'javascript.0.foo',
				parent: 'javascript.0',
				level: 1,
				label: 'foo',
				expandable: true,
			},
			{
				entry: 'javascript.0.foo.bar',
				parent: 'javascript.0.foo',
				level: 2,
				label: 'bar',
				expandable: false,
				_id: 'javascript.0.foo.bar',
				common: { name: 'Bar', type: 'number', role: 'value', unit: 'W' },
			},
			{
				entry: 'javascript.0.foo.baz',
				parent: 'javascript.0.foo',
				level: 2,
				label: 'baz',
				expandable: true,
			},
			{
				entry: 'javascript.0.foo.baz.qux',
				parent: 'javascript.0.foo.baz',
				level: 3,
				label: 'qux',
				expandable: false,
				_id: 'javascript.0.foo.baz.qux',
				common: { name: 'Qux', type: 'string' },
			},
		]);
	});

	it('returns an ancestor path for a concrete entry without loading ancestor siblings', async () => {
		const { catalog } = createCatalogHarness({
			objects: {
				'javascript.0.meineDaten.Beispiel.meinState': {
					_id: 'javascript.0.meineDaten.Beispiel.meinState',
					type: 'state',
					common: { name: 'Mein State', type: 'boolean', role: 'switch' },
				},
				'javascript.0.meineDaten.Beispiel.andererState': {
					_id: 'javascript.0.meineDaten.Beispiel.andererState',
					type: 'state',
					common: { name: 'Anderer State', type: 'number' },
				},
				'javascript.0.meineDaten.andereGruppe.irgendwas': {
					_id: 'javascript.0.meineDaten.andereGruppe.irgendwas',
					type: 'state',
					common: { name: 'Nicht im Ahnenpfad', type: 'string' },
				},
				'javascript.0.andereWurzel.foo': {
					_id: 'javascript.0.andereWurzel.foo',
					type: 'state',
					common: { name: 'Noch ein Nachbar', type: 'string' },
				},
			},
		});

		const res = await catalog.openTree({
			entry: 'javascript.0.meineDaten.Beispiel.meinState',
			depth: 2,
		});

		expect(res.ok).to.equal(true);
		expect(res.data.depth).to.equal(2);
		expect(res.data.ancestors).to.deep.equal([
			{
				entry: 'javascript.0',
				parent: '',
				level: 1,
				label: 'javascript.0',
				expandable: true,
			},
			{
				entry: 'javascript.0.meineDaten',
				parent: 'javascript.0',
				level: 2,
				label: 'meineDaten',
				expandable: true,
			},
			{
				entry: 'javascript.0.meineDaten.Beispiel',
				parent: 'javascript.0.meineDaten',
				level: 3,
				label: 'Beispiel',
				expandable: true,
			},
			{
				entry: 'javascript.0.meineDaten.Beispiel.meinState',
				parent: 'javascript.0.meineDaten.Beispiel',
				level: 4,
				label: 'meinState',
				expandable: false,
				_id: 'javascript.0.meineDaten.Beispiel.meinState',
				common: { name: 'Mein State', type: 'boolean', role: 'switch' },
			},
		]);
		expect(res.data.nodes).to.deep.equal([]);
		const entries = JSON.stringify(res.data);
		expect(entries).to.not.include('javascript.0.meineDaten.andereGruppe');
		expect(entries).to.not.include('javascript.0.andereWurzel');
	});

	it('rebuilds the shared full-cache after TTL expiry', async () => {
		const { catalog, getReadCount, setObjects, advanceNow } = createCatalogHarness({
			objects: {
				'javascript.0.foo': {
					_id: 'javascript.0.foo',
					type: 'state',
					common: { name: 'Foo', type: 'boolean' },
				},
			},
			ttlMs: 100,
		});

		const first = await catalog.get({ filter: '*' });
		advanceNow(99);
		await catalog.get({ filter: '*' });
		setObjects({
			'javascript.0.bar': {
				_id: 'javascript.0.bar',
				type: 'state',
				common: { name: 'Bar', type: 'number' },
			},
		});
		advanceNow(2);
		const third = await catalog.get({ filter: '*' });

		expect(getReadCount()).to.equal(2);
		expect(first.data.meta.createdAt).to.equal(1000);
		expect(third.data.meta.createdAt).to.equal(1101);
		expect(third.data.objects).to.deep.equal({
			'javascript.0.bar': {
				_id: 'javascript.0.bar',
				common: { name: 'Bar', type: 'number' },
			},
		});
	});

	it('resets the shared full-cache explicitly', async () => {
		const { catalog, getReadCount } = createCatalogHarness({
			objects: {
				'javascript.0.foo': {
					_id: 'javascript.0.foo',
					type: 'state',
					common: { name: 'Foo', type: 'boolean' },
				},
			},
		});

		await catalog.get({ filter: '*' });
		const resetRes = catalog.reset();
		await catalog.openTree({ depth: 1 });

		expect(resetRes).to.deep.equal({
			ok: true,
			data: {
				reset: true,
				hadCache: true,
			},
		});
		expect(getReadCount()).to.equal(2);
	});

	it('does not restore an invalidated cache when reset races with an in-flight build', async () => {
		const deferred = createDeferred();
		let reads = 0;
		const adapter = {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
			getForeignObjectsAsync(pattern, type) {
				reads += 1;
				expect(pattern).to.equal('*');
				expect(type).to.equal('state');
				if (reads === 1) {
					return deferred.promise;
				}
				return Promise.resolve({
					'javascript.0.afterReset': {
						_id: 'javascript.0.afterReset',
						type: 'state',
						common: { name: 'After reset', type: 'number' },
					},
				});
			},
		};
		const catalog = new IoIdCatalog(adapter);

		const firstRequest = catalog.get({ filter: '*' });
		const resetRes = catalog.reset();
		deferred.resolve({
			'javascript.0.beforeReset': {
				_id: 'javascript.0.beforeReset',
				type: 'state',
				common: { name: 'Before reset', type: 'boolean' },
			},
		});

		const firstResult = await firstRequest;
		const secondResult = await catalog.get({ filter: '*' });

		expect(resetRes).to.deep.equal({
			ok: true,
			data: {
				reset: true,
				hadCache: true,
			},
		});
		expect(firstResult.ok).to.equal(true);
		expect(firstResult.data.objects).to.have.property('javascript.0.beforeReset');
		expect(secondResult.data.objects).to.deep.equal({
			'javascript.0.afterReset': {
				_id: 'javascript.0.afterReset',
				common: { name: 'After reset', type: 'number' },
			},
		});
		expect(reads).to.equal(2);
	});

	it('returns defensive copies so response mutation cannot contaminate the shared cache', async () => {
		const { catalog } = createCatalogHarness({
			objects: {
				'javascript.0.foo.bar': {
					_id: 'javascript.0.foo.bar',
					type: 'state',
					common: { name: 'Bar', type: 'number', role: 'value' },
				},
			},
		});

		const firstGet = await catalog.get({ filter: '*' });
		firstGet.data.objects['javascript.0.foo.bar'].common.name = 'Mutated';
		const secondGet = await catalog.get({ filter: '*' });

		const firstTree = await catalog.openTree({ entry: 'javascript.0', depth: 2 });
		firstTree.data.nodes[1].common.name = 'Tree mutation';
		const secondTree = await catalog.openTree({ entry: 'javascript.0', depth: 2 });

		expect(secondGet.data.objects['javascript.0.foo.bar'].common.name).to.equal('Bar');
		expect(secondTree.data.nodes[1].common.name).to.equal('Bar');
	});
});
