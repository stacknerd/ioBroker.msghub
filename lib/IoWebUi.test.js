'use strict';

const { expect } = require('chai');

const { IoAdminCapabilities } = require('./IoAdminCapabilities');
const { IoWebUi } = require('./IoWebUi');

describe('IoWebUi handleCommand', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	function createCapabilities() {
		return new IoAdminCapabilities(createAdapter());
	}

	function createWebUi(options = {}) {
		return new IoWebUi(createAdapter(), {
			adminCapabilities: createCapabilities(),
			...options,
		});
	}

	function makeResolvedPanel(overrides = {}) {
		return {
			id: 'plugin-IngestStates-0-presets',
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
			description: 'msghub.i18n.IngestStates.ui.panels.presets.description.text',
			ui: {
				kind: 'plugin',
				loader: 'esm',
				apiVersion: '1',
				bundle: { hash: 'sha256-testhash' },
			},
			...overrides,
		};
	}

	it('web.ping returns pong', async () => {
		const capabilities = createCapabilities();
		const webUi = new IoWebUi(createAdapter(), { adminCapabilities: capabilities });
		const res = await webUi.handleCommand('web.ping', {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
		});
		expect(res.ok).to.equal(true);
		expect(res.data).to.equal('pong');
	});

	it('web.stats.get normalizes include payload and returns store stats', async () => {
		const calls = [];
		const capabilities = createCapabilities();
		const webUi = new IoWebUi(createAdapter(), {
			adminCapabilities: capabilities,
			msgStore: {
				getStats: async include => {
					calls.push(include);
					return { count: 3 };
				},
			},
		});
		const res = await webUi.handleCommand('web.stats.get', {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
			include: { archiveSize: true, archiveSizeMaxAgeMs: -4 },
		});
		expect(calls).to.deep.equal([{ include: { archiveSize: true, archiveSizeMaxAgeMs: 0 } }]);
		expect(res).to.deep.equal({ ok: true, data: { count: 3 } });
	});

	it('web.constants.get returns selected constant groups only', async () => {
		const capabilities = createCapabilities();
		const webUi = new IoWebUi(createAdapter(), {
			adminCapabilities: capabilities,
			msgStore: {
				msgConstants: {
					kind: { info: 'info' },
					lifecycle: { state: { active: 'active' }, ignored: true },
					level: { high: 'high' },
					notfication: { events: { ack: 'ack' }, ignored: true },
				},
			},
		});
		const res = await webUi.handleCommand('web.constants.get', {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
		});
		expect(res).to.deep.equal({
			ok: true,
			data: {
				kind: { info: 'info' },
				lifecycle: { state: { active: 'active' } },
				level: { high: 'high' },
				notfication: { events: { ack: 'ack' } },
			},
		});
	});

	it('web.messages.query returns normalized query result', async () => {
		const capabilities = createCapabilities();
		const webUi = new IoWebUi(createAdapter(), {
			adminCapabilities: capabilities,
			msgStore: {
				queryMessages: query => ({
					items: [{ ref: 'r1', meta: new Map([['k', 'v']]) }],
					total: 1,
					pages: 1,
					query,
				}),
			},
		});
		const res = await webUi.handleCommand('web.messages.query', {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
			query: {
				where: { kind: 'alert' },
				page: { size: 10 },
				sort: [{ field: 'ts', dir: 'desc' }],
				extra: true,
			},
		});
		expect(res.ok).to.equal(true);
		expect(res.data.items).to.deep.equal([{ ref: 'r1', meta: { __msghubType: 'Map', value: [['k', 'v']] } }]);
		expect(res.data.total).to.equal(1);
		expect(res.data.pages).to.equal(1);
		expect(res.data.meta).to.have.property('generatedAt');
		expect(res.data.meta).to.have.property('tz');
	});

	it('web.messages.action executes via msgActions', async () => {
		const actors = [];
		const capabilities = createCapabilities();
		const webUi = new IoWebUi(createAdapter(), {
			adminCapabilities: capabilities,
			msgStore: {
				msgActions: {
					execute(opts) {
						actors.push(opts.actor);
						return true;
					},
				},
			},
		});
		const res = await webUi.handleCommand('web.messages.action', {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
			ref: 'r1',
			actionId: 'ack',
		});
		expect(actors).to.deep.equal(['WebUi']);
		expect(res).to.deep.equal({ ok: true, data: { executed: true } });
	});

	it('web.view.get delegates to the UI catalog and returns the normalized view payload', async () => {
		const capabilities = createCapabilities();
		const calls = [];
		const stubResult = {
			composition: {
				id: 'custom',
				layout: 'tabs',
				panels: [{ type: 'corePanel', panelId: 'messages' }],
				defaultPanel: 'messages',
				deviceMode: 'pc',
			},
			corePanels: {
				messages: {
					id: 'messages',
				},
			},
			request: {
				mode: 'composition',
				targetId: 'custom',
			},
		};
		const webUi = new IoWebUi(createAdapter(), {
			adminCapabilities: capabilities,
			uiCatalog: {
				getView(payload) {
					calls.push(payload);
					return stubResult;
				},
			},
		});
		const res = await webUi.handleCommand('web.view.get', {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
			mode: 'composition',
			targetId: 'custom',
		});
		expect(calls).to.deep.equal([{ mode: 'composition', targetId: 'custom' }]);
		expect(res).to.deep.equal({ ok: true, data: stubResult });
	});

	it('web.view.get maps catalog validation failures to BAD_REQUEST envelopes', async () => {
		const capabilities = createCapabilities();
		const webUi = new IoWebUi(createAdapter(), {
			adminCapabilities: capabilities,
			uiCatalog: {
				getView() {
					throw Object.assign(new Error("Invalid panel target 'bad-target'"), { code: 'BAD_REQUEST' });
				},
			},
		});
		const res = await webUi.handleCommand('web.view.get', {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
			mode: 'panel',
			targetId: 'bad-target',
		});
		expect(res).to.deep.equal({
			ok: false,
			error: {
				code: 'BAD_REQUEST',
				message: "Invalid panel target 'bad-target'",
			},
		});
	});

	it('web.pluginUi.bundle.get returns the shared-safe bundle payload', async () => {
		let readCalls = 0;
		const resolverCalls = [];
		const capabilities = createCapabilities();
		const webUi = new IoWebUi(createAdapter(), {
			adminCapabilities: capabilities,
			ioPlugins: {
				readAdminUiBundle: async ({ lang }) => {
					readCalls += 1;
					expect(lang).to.equal('de');
					return {
						js: 'export function mount(){}',
						css: '.host{}',
						i18n: { lang: 'de', translations: { 'msghub.i18n.IngestStates.ui.foo': 'Foo' } },
					};
				},
			},
			pluginPanelResolver: {
				getPanelByRef: async options => {
					resolverCalls.push(options);
					return makeResolvedPanel({
						ui: { kind: 'plugin', loader: 'esm', apiVersion: '1', bundle: { hash: 'sha256-computedhash' } },
					});
				},
			},
		});

		const req = {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			lang: 'DE',
		};
		const res1 = await webUi.handleCommand('web.pluginUi.bundle.get', req);
		const res2 = await webUi.handleCommand('web.pluginUi.bundle.get', {
			...req,
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
		});

		expect(readCalls).to.equal(1);
		expect(resolverCalls).to.deep.equal([
			{ pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
			{ pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
		]);
		expect(res1.ok).to.equal(true);
		expect(res1.data).to.deep.equal({
			apiVersion: '1',
			moduleFormat: 'esm',
			hash: 'sha256-computedhash',
			js: 'export function mount(){}',
			css: '.host{}',
			i18n: { lang: 'de', translations: { 'msghub.i18n.IngestStates.ui.foo': 'Foo' } },
		});
		expect(res2).to.deep.equal(res1);
	});

	it('web.pluginUi.bundle.get supports i18n-only projection on the same command path', async () => {
		const capabilities = createCapabilities();
		const readCalls = [];
		const webUi = new IoWebUi(createAdapter(), {
			adminCapabilities: capabilities,
			ioPlugins: {
				readAdminUiBundle: async options => {
					readCalls.push(options);
					return {
						i18n: { lang: 'de', translations: { 'msghub.i18n.IngestStates.ui.foo': 'Foo' } },
					};
				},
			},
			pluginPanelResolver: {
				getPanelByRef: async () =>
					makeResolvedPanel({
						ui: { kind: 'plugin', loader: 'esm', apiVersion: '1', bundle: { hash: 'sha256-projected' } },
					}),
			},
		});

		const res = await webUi.handleCommand('web.pluginUi.bundle.get', {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			lang: 'de',
			include: ['i18n'],
		});

		expect(readCalls).to.deep.equal([
			{
				type: 'IngestStates',
				instanceId: 0,
				panelId: 'presets',
				lang: 'de',
				parts: ['i18n'],
			},
		]);
		expect(res).to.deep.equal({
			ok: true,
			data: {
				apiVersion: '1',
				moduleFormat: 'esm',
				hash: 'sha256-projected',
				i18n: { lang: 'de', translations: { 'msghub.i18n.IngestStates.ui.foo': 'Foo' } },
			},
		});
	});

	it('web.pluginUi.bundle.get cache separates different bundle projections', async () => {
		let readCalls = 0;
		const capabilities = createCapabilities();
		const webUi = new IoWebUi(createAdapter(), {
			adminCapabilities: capabilities,
			ioPlugins: {
				readAdminUiBundle: async ({ parts }) => {
					readCalls += 1;
					return Array.isArray(parts) && parts.length === 1
						? { i18n: { lang: 'en', translations: {} } }
						: { js: 'export function mount(){}', css: null };
				},
			},
			pluginPanelResolver: {
				getPanelByRef: async () =>
					makeResolvedPanel({
						ui: { kind: 'plugin', loader: 'esm', apiVersion: '1', bundle: { hash: 'sha256-cacheparts' } },
					}),
			},
		});

		const token = () => capabilities.mintToken({ host: 'admin', capability: 'web' }).token;
		await webUi.handleCommand('web.pluginUi.bundle.get', {
			token: token(),
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			include: ['i18n'],
		});
		await webUi.handleCommand('web.pluginUi.bundle.get', {
			token: token(),
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			exclude: ['i18n'],
		});

		expect(readCalls).to.equal(2);
	});

	it('web.pluginUi.rpc dispatches through the web-specific plugin hook', async () => {
		const calls = [];
		const capabilities = createCapabilities();
		const webUi = new IoWebUi(createAdapter(), {
			adminCapabilities: capabilities,
			ioPlugins: {
				callPluginRuntime: opts => {
					calls.push(opts);
					return Promise.resolve({ ok: true, data: { count: 3 } });
				},
			},
			pluginPanelResolver: {
				getPanelByRef: async () => makeResolvedPanel(),
			},
		});

		const res = await webUi.handleCommand('web.pluginUi.rpc', {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			command: 'presets.list',
		});

		expect(res).to.deep.equal({ ok: true, data: { count: 3 } });
		expect(calls[0].method).to.equal('handleWebUiRpc');
	});

	it('rejects unknown web commands', async () => {
		const capabilities = createCapabilities();
		const webUi = new IoWebUi(createAdapter(), { adminCapabilities: capabilities });
		const res = await webUi.handleCommand('web.unknown', {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('UNKNOWN_COMMAND');
	});

	it('rejects ui.bootstrap because IoWebUi is web-only in AP4', async () => {
		const capabilities = createCapabilities();
		const webUi = new IoWebUi(createAdapter(), { adminCapabilities: capabilities });
		const res = await webUi.handleCommand('ui.bootstrap', {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('UNKNOWN_COMMAND');
	});

	it('rejects missing payload.token for web commands', async () => {
		const webUi = createWebUi();
		const res = await webUi.handleCommand('web.ping', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('FORBIDDEN');
		expect(res.error.message).to.match(/Missing token/);
	});

	it('strips payload.token before web command execution', async () => {
		let seenPayload = null;
		const capabilities = createCapabilities();
		const webUi = new IoWebUi(createAdapter(), {
			adminCapabilities: capabilities,
			msgStore: {
				getStats: async payload => {
					seenPayload = payload;
					return { count: 1 };
				},
			},
		});
		const res = await webUi.handleCommand('web.stats.get', {
			token: capabilities.mintToken({ host: 'admin', capability: 'web' }).token,
			include: { archiveSize: true },
		});
		expect(res.ok).to.equal(true);
		expect(seenPayload).to.deep.equal({ include: { archiveSize: true } });
	});
});
