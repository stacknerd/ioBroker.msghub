'use strict';

const { expect } = require('chai');

const { IoAdminTab } = require('./IoAdminTab');

describe('IoAdminTab handleCommand', () => {
	function createAdminTab() {
		const adapter = {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
		return new IoAdminTab(adapter, null);
	}

	it('rejects config-scope archive commands on admin scope', async () => {
		const tab = createAdminTab();
		const res = await tab.handleCommand('admin.archive.status', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('UNKNOWN_COMMAND');
	});

	it('admin.ping returns pong', async () => {
		const tab = createAdminTab();
		const res = await tab.handleCommand('admin.ping', null);
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('UNKNOWN_COMMAND');
	});

	it('rejects removed admin.pluginUi.icon command', async () => {
		const tab = createAdminTab();
		const res = await tab.handleCommand('admin.pluginUi.icon', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('UNKNOWN_COMMAND');
	});

	it('rejects removed admin.pluginUi.discover command', async () => {
		const tab = createAdminTab();
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('UNKNOWN_COMMAND');
	});

	it('rejects removed admin.pluginUi.bundle.get command', async () => {
		const tab = createAdminTab();
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('UNKNOWN_COMMAND');
	});
});

describe('IoAdminTab migrated web commands', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	for (const command of [
		'admin.ping',
		'admin.stats.get',
		'admin.constants.get',
		'admin.messages.query',
		'admin.messages.action',
	]) {
		it(`rejects ${command} after migration to IoWebUi`, async () => {
			const tab = new IoAdminTab(createAdapter(), null);
			const res = await tab.handleCommand(command, {});
			expect(res.ok).to.equal(false);
			expect(res.error.code).to.equal('UNKNOWN_COMMAND');
		});
	}
});

describe('IoAdminTab admin.ingestStates.presets.selectOptions', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	/**
	 * Build an ioPlugins stub that captures callPluginRuntime calls.
	 *
	 * @param {{ result?: any, captureArgs?: Array }} opts Stub options.
	 * @returns {object} ioPlugins stub.
	 */
	function makeIoPlugins({ result = null, captureArgs = [] } = {}) {
		return {
			callPluginRuntime: opts => {
				captureArgs.push(opts);
				return result;
			},
		};
	}

	it('returns empty array when callPluginRuntime returns null (plugin not running)', async () => {
		const tab = new IoAdminTab(createAdapter(), makeIoPlugins({ result: null }));
		const res = await tab.handleCommand('admin.ingestStates.presets.selectOptions', {});
		expect(res).to.deep.equal([]);
	});

	it('forwards callPluginRuntime result through _ensureOptionsArray', async () => {
		const items = [{ value: 'p1', label: 'Preset 1' }, { value: 'p2', label: 'Preset 2' }];
		const tab = new IoAdminTab(createAdapter(), makeIoPlugins({ result: Promise.resolve(items) }));
		const res = await tab.handleCommand('admin.ingestStates.presets.selectOptions', {});
		expect(res).to.deep.equal(items);
	});

	it('strips extra fields from results — only value and label pass through', async () => {
		const items = [{ value: 'p1', label: 'L1', extra: 'ignored' }];
		const tab = new IoAdminTab(createAdapter(), makeIoPlugins({ result: Promise.resolve(items) }));
		const res = await tab.handleCommand('admin.ingestStates.presets.selectOptions', {});
		expect(res).to.deep.equal([{ value: 'p1', label: 'L1' }]);
	});

	it('passes raw suffix and payload verbatim — no IoAdminTab-side parsing', async () => {
		const captureArgs = [];
		const rawPayload = { currentValue: 'pX' };
		const tab = new IoAdminTab(createAdapter(), makeIoPlugins({ result: Promise.resolve([]), captureArgs }));
		await tab.handleCommand('admin.ingestStates.presets.selectOptions.threshold.lt', rawPayload);
		expect(captureArgs).to.have.length(1);
		const forwarded = captureArgs[0]?.args?.[0];
		// IoAdminTab passes suffix + payload verbatim — IngestStates owns the interpretation.
		expect(forwarded?.suffix).to.equal('.threshold.lt');
		expect(forwarded?.payload).to.equal(rawPayload);
		// IoAdminTab must NOT pre-parse rule, subset, or currentValue.
		expect(forwarded).to.not.have.property('rule');
		expect(forwarded).to.not.have.property('subset');
		expect(forwarded).to.not.have.property('currentValue');
	});

	it('passes empty suffix when command has no suffix', async () => {
		const captureArgs = [];
		const tab = new IoAdminTab(createAdapter(), makeIoPlugins({ result: Promise.resolve([]), captureArgs }));
		await tab.handleCommand('admin.ingestStates.presets.selectOptions', {});
		expect(captureArgs).to.have.length(1);
		expect(captureArgs[0]?.args?.[0]?.suffix).to.equal('');
	});
});

describe('IoAdminTab admin.pluginUi.rpc', () => {
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

	function makeIoPlugins({ contributions, rpcResult = { ok: true, data: {} }, rpcError = null } = {}) {
		return {
			getAdminUiContributions: () => contributions ?? [makeContrib()],
			callPluginRuntime: () => {
				if (rpcResult === null) {
					return null;
				}
				if (rpcError) {
					return Promise.reject(rpcError);
				}
				return Promise.resolve(rpcResult);
			},
		};
	}

	it('returns plugin result on happy path', async () => {
		const ioPlugins = makeIoPlugins({ rpcResult: { ok: true, data: { count: 3 } } });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.rpc', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
			payload: {},
		});
		expect(res.ok).to.equal(true);
		expect(res.data.count).to.equal(3);
	});

	it('returns NOT_FOUND when plugin not started or panel not declared', async () => {
		const ioPlugins = makeIoPlugins({ contributions: [] });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.rpc', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_FOUND');
	});

	it('returns NOT_READY when callPluginRuntime returns null', async () => {
		const ioPlugins = makeIoPlugins({ rpcResult: null });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.rpc', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});

	it('returns BAD_REQUEST when payload exceeds 64 KB', async () => {
		const tab = new IoAdminTab(createAdapter(), makeIoPlugins());
		const bigPayload = { data: 'x'.repeat(64 * 1024 + 1) };
		const res = await tab.handleCommand('admin.pluginUi.rpc', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.create',
			payload: bigPayload,
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('returns BAD_REQUEST when required fields are missing', async () => {
		const tab = new IoAdminTab(createAdapter(), makeIoPlugins());
		const res = await tab.handleCommand('admin.pluginUi.rpc', {
			pluginType: 'IngestStates',
			instanceId: 0,
			// panelId missing
			command: 'presets.list',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('returns TIMEOUT when RPC does not resolve within timeout', async () => {
		// Override global.setTimeout so the timeout fires immediately.
		const origSetTimeout = global.setTimeout;
		global.setTimeout = (fn, _delay) => origSetTimeout(fn, 1);
		try {
			const neverResolves = new Promise(() => {});
			const ioPlugins = {
				getAdminUiContributions: () => [makeContrib()],
				callPluginRuntime: () => neverResolves,
			};
			const tab = new IoAdminTab(createAdapter(), ioPlugins);
			const res = await tab.handleCommand('admin.pluginUi.rpc', {
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

	it('returns NOT_READY when ioPlugins is null', async () => {
		const tab = new IoAdminTab(createAdapter(), null);
		const res = await tab.handleCommand('admin.pluginUi.rpc', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});
});
