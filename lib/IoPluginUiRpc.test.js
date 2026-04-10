'use strict';

const { expect } = require('chai');

const { IoPluginUiRpc } = require('./IoPluginUiRpc');

describe('IoPluginUiRpc', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	function makeContrib(overrides = {}) {
		return {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			apiVersion: '1',
			bundle: { hash: 'abc123' },
			...overrides,
		};
	}

	function createResolver(result = makeContrib()) {
		return {
			getPanelByRef: async () => result,
		};
	}

	it('dispatches admin RPC to handleAdminUiRpc', async () => {
		const calls = [];
		const rpc = new IoPluginUiRpc(
			createAdapter(),
			{
			callPluginRuntime: opts => {
				calls.push(opts);
				return Promise.resolve({ ok: true, data: { scope: 'admin' } });
			},
			},
			{ pluginPanelResolver: createResolver() },
		);

		const res = await rpc.handleAdminRpc({
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
			payload: { foo: 'bar' },
		});

		expect(res).to.deep.equal({ ok: true, data: { scope: 'admin' } });
		expect(calls[0].method).to.equal('handleAdminUiRpc');
		expect(calls[0].args[0]).to.deep.equal({
			panelId: 'presets',
			command: 'presets.list',
			payload: { foo: 'bar' },
		});
	});

	it('dispatches web RPC to handleWebUiRpc', async () => {
		const calls = [];
		const rpc = new IoPluginUiRpc(
			createAdapter(),
			{
			callPluginRuntime: opts => {
				calls.push(opts);
				return Promise.resolve({ ok: true, data: { scope: 'web' } });
			},
			},
			{ pluginPanelResolver: createResolver() },
		);

		const res = await rpc.handleWebRpc({
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
		});

		expect(res).to.deep.equal({ ok: true, data: { scope: 'web' } });
		expect(calls[0].method).to.equal('handleWebUiRpc');
	});

	it('returns NOT_READY when runtime or host-specific hook is unavailable', async () => {
		const rpc = new IoPluginUiRpc(
			createAdapter(),
			{
			callPluginRuntime: () => null,
			},
			{ pluginPanelResolver: createResolver() },
		);

		const res = await rpc.handleWebRpc({
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
		});

		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});

	it('returns NOT_FOUND when the panel contribution is not active', async () => {
		const rpc = new IoPluginUiRpc(
			createAdapter(),
			{
			callPluginRuntime: () => Promise.resolve({ ok: true, data: {} }),
			},
			{ pluginPanelResolver: { getPanelByRef: async () => null } },
		);

		const res = await rpc.handleAdminRpc({
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
		});

		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_FOUND');
	});

	it('returns BAD_REQUEST when required fields are missing', async () => {
		const rpc = new IoPluginUiRpc(
			createAdapter(),
			{
			callPluginRuntime: () => Promise.resolve({ ok: true, data: {} }),
			},
			{ pluginPanelResolver: createResolver() },
		);

		const res = await rpc.handleAdminRpc({
			pluginType: 'IngestStates',
			instanceId: 0,
			command: 'presets.list',
		});

		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('returns BAD_REQUEST when payload exceeds 64 KB', async () => {
		const rpc = new IoPluginUiRpc(
			createAdapter(),
			{
			callPluginRuntime: () => Promise.resolve({ ok: true, data: {} }),
			},
			{ pluginPanelResolver: createResolver() },
		);

		const res = await rpc.handleAdminRpc({
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.create',
			payload: { data: 'x'.repeat(64 * 1024 + 1) },
		});

		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('returns TIMEOUT when RPC does not resolve within timeout', async () => {
		const origSetTimeout = global.setTimeout;
		global.setTimeout = (fn, _delay) => origSetTimeout(fn, 1);
		try {
			const rpc = new IoPluginUiRpc(
				createAdapter(),
				{
				callPluginRuntime: () => new Promise(() => {}),
				},
				{ pluginPanelResolver: createResolver() },
			);

			const res = await rpc.handleWebRpc({
				pluginType: 'IngestStates',
				instanceId: 0,
				panelId: 'presets',
				command: 'presets.list',
			});

			expect(res.ok).to.equal(false);
			expect(res.error.code).to.equal('TIMEOUT');
		} finally {
			global.setTimeout = origSetTimeout;
		}
	});

	it('returns INTERNAL when the plugin response does not contain an ok boolean', async () => {
		const rpc = new IoPluginUiRpc(
			createAdapter(),
			{
			callPluginRuntime: () => Promise.resolve({ data: true }),
			},
			{ pluginPanelResolver: createResolver() },
		);

		const res = await rpc.handleWebRpc({
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
		});

		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('INTERNAL');
	});
});
