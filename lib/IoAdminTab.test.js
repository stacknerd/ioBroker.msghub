'use strict';

const { expect } = require('chai');
const { IoAdminTab } = require('./IoAdminTab');

function makeAdapter({ namespace = 'msghub.0' } = {}) {
	const logs = { warn: [], error: [], info: [], debug: [] };
	const adapter = {
		namespace,
		log: {
			warn: msg => logs.warn.push(String(msg)),
			error: msg => logs.error.push(String(msg)),
			info: msg => logs.info.push(String(msg)),
			debug: msg => logs.debug.push(String(msg)),
		},
	};
	return { adapter, logs };
}

describe('IoAdminTab', () => {
	it('returns BAD_REQUEST when command is missing', async () => {
		const { adapter } = makeAdapter();
		const ioPlugins = { getCatalog: () => [], listInstances: async () => [] };
		const admin = new IoAdminTab(adapter, ioPlugins);

		const res = await admin.handleCommand('', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('returns UNKNOWN_COMMAND for unknown admin commands', async () => {
		const { adapter } = makeAdapter();
		const ioPlugins = { getCatalog: () => [], listInstances: async () => [] };
		const admin = new IoAdminTab(adapter, ioPlugins);

		const res = await admin.handleCommand('admin.nope', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('UNKNOWN_COMMAND');
	});

	it('routes admin.plugins.getCatalog to ioPlugins.getCatalog', async () => {
		const { adapter } = makeAdapter();
		const catalog = [{ type: 'IngestRandomChaos', options: {} }];
		const ioPlugins = { getCatalog: () => catalog, listInstances: async () => [] };
		const admin = new IoAdminTab(adapter, ioPlugins);

		const res = await admin.handleCommand('admin.plugins.getCatalog', {});
		expect(res.ok).to.equal(true);
		expect(res.data.plugins).to.deep.equal(catalog);
	});

	it('routes admin.plugins.* instance commands to IoPlugins methods', async () => {
		const { adapter } = makeAdapter();
		const calls = { create: [], del: [], update: [], setEnabled: [] };
		const ioPlugins = {
			getCatalog: () => [{ type: 'Demo', options: {} }],
			listInstances: async () => [],
			createInstance: async payload => {
				calls.create.push(payload);
				return { created: true };
			},
			deleteInstance: async payload => calls.del.push(payload),
			updateInstanceNative: async payload => calls.update.push(payload),
			setInstanceEnabled: async payload => calls.setEnabled.push(payload),
		};
		const admin = new IoAdminTab(adapter, ioPlugins);

		const created = await admin.handleCommand('admin.plugins.createInstance', { type: 'Demo' });
		expect(created.ok).to.equal(true);
		expect(created.data).to.deep.equal({ created: true });
		expect(calls.create).to.deep.equal([{ type: 'Demo' }]);

		const del = await admin.handleCommand('admin.plugins.deleteInstance', { type: 'Demo', instanceId: 0 });
		expect(del.ok).to.equal(true);
		expect(calls.del).to.deep.equal([{ type: 'Demo', instanceId: 0 }]);

		const upd = await admin.handleCommand('admin.plugins.updateInstance', { type: 'Demo', instanceId: 0, nativePatch: { x: 1 } });
		expect(upd.ok).to.equal(true);
		expect(calls.update).to.deep.equal([{ type: 'Demo', instanceId: 0, nativePatch: { x: 1 } }]);

		const en = await admin.handleCommand('admin.plugins.setEnabled', { type: 'Demo', instanceId: 0, enabled: true });
		expect(en.ok).to.equal(true);
		expect(calls.setEnabled).to.deep.equal([{ type: 'Demo', instanceId: 0, enabled: true }]);
	});

	it('warns once per instance for unknown native keys (best-effort)', async () => {
		const { adapter, logs } = makeAdapter();

		const catalog = [
			{
				type: 'Demo',
				options: { a: { type: 'number' } },
				defaultOptions: { a: 1 },
			},
		];

		let instances = [
			{ type: 'Demo', instanceId: 0, native: { a: 1, extra: 2 } },
		];

		const ioPlugins = {
			getCatalog: () => catalog,
			listInstances: async () => instances,
		};

		const admin = new IoAdminTab(adapter, ioPlugins);

		const res1 = await admin.handleCommand('admin.plugins.listInstances', {});
		expect(res1.ok).to.equal(true);
		expect(logs.warn).to.have.length(1);
		expect(logs.warn[0]).to.contain('unknown native keys');
		expect(logs.warn[0]).to.contain('msghub.0.Demo.0');

		const res2 = await admin.handleCommand('admin.plugins.listInstances', {});
		expect(res2.ok).to.equal(true);
		expect(logs.warn).to.have.length(1);

		instances = [{ type: 'Demo', instanceId: 0, native: { a: 1 } }];
		const res3 = await admin.handleCommand('admin.plugins.listInstances', {});
		expect(res3.ok).to.equal(true);
		expect(logs.warn).to.have.length(1);

		instances = [{ type: 'Demo', instanceId: 0, native: { a: 1, extra: 2 } }];
		const res4 = await admin.handleCommand('admin.plugins.listInstances', {});
		expect(res4.ok).to.equal(true);
		expect(logs.warn).to.have.length(2);
	});
});

