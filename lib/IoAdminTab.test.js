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
		expect(res.ok).to.equal(true);
		expect(res.data).to.equal('pong');
	});

	it('rejects removed admin.pluginUi.icon command', async () => {
		const tab = createAdminTab();
		const res = await tab.handleCommand('admin.pluginUi.icon', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('UNKNOWN_COMMAND');
	});
});

describe('IoAdminTab admin.messages.action', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	function createMsgActionsStub({ executeResult = true, actorCapture = [] } = {}) {
		return {
			execute(opts) {
				actorCapture.push(opts?.actor);
				return executeResult;
			},
		};
	}

	it('executes action and returns ok when execute returns true', async () => {
		const actorCapture = [];
		const tab = new IoAdminTab(createAdapter(), null, {
			msgStore: { msgActions: createMsgActionsStub({ executeResult: true, actorCapture }) },
		});
		const res = await tab.handleCommand('admin.messages.action', { ref: 'r1', actionId: 'ack' });
		expect(res.ok).to.equal(true);
		expect(res.data.executed).to.equal(true);
	});

	it('passes actor "AdminTab" to execute', async () => {
		const actorCapture = [];
		const tab = new IoAdminTab(createAdapter(), null, {
			msgStore: { msgActions: createMsgActionsStub({ actorCapture }) },
		});
		await tab.handleCommand('admin.messages.action', { ref: 'r1', actionId: 'ack' });
		expect(actorCapture[0]).to.equal('AdminTab');
	});

	it('returns REJECTED when execute returns false', async () => {
		const tab = new IoAdminTab(createAdapter(), null, {
			msgStore: { msgActions: createMsgActionsStub({ executeResult: false }) },
		});
		const res = await tab.handleCommand('admin.messages.action', { ref: 'r1', actionId: 'ack' });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('REJECTED');
	});

	it('returns BAD_REQUEST when ref is missing', async () => {
		const tab = new IoAdminTab(createAdapter(), null, {
			msgStore: { msgActions: createMsgActionsStub() },
		});
		const res = await tab.handleCommand('admin.messages.action', { actionId: 'ack' });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('returns BAD_REQUEST when actionId is missing', async () => {
		const tab = new IoAdminTab(createAdapter(), null, {
			msgStore: { msgActions: createMsgActionsStub() },
		});
		const res = await tab.handleCommand('admin.messages.action', { ref: 'r1' });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('returns NOT_READY when msgStore has no msgActions', async () => {
		const tab = new IoAdminTab(createAdapter(), null, { msgStore: {} });
		const res = await tab.handleCommand('admin.messages.action', { ref: 'r1', actionId: 'ack' });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});

	it('returns NOT_READY when msgStore is null', async () => {
		const tab = new IoAdminTab(createAdapter(), null);
		const res = await tab.handleCommand('admin.messages.action', { ref: 'r1', actionId: 'ack' });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});
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

// ---------------------------------------------------------------------------
// admin.pluginUi.discover / bundle.get / rpc
// ---------------------------------------------------------------------------

describe('IoAdminTab admin.pluginUi.discover', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	function makeContribution(overrides = {}) {
		return {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
			description: 'msghub.i18n.IngestStates.ui.panels.presets.description.text',
			apiVersion: '1',
			bundle: { hash: '' },
			...overrides,
		};
	}

	it('returns contributions with computed hash from running plugins', async () => {
		const contributions = [makeContribution()];
		const ioPlugins = {
			getAdminUiContributions: () => contributions,
			computeAdminUiBundleHash: async () => 'sha256-testhash',
			readAdminUiTranslations: async () => null,
		};
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.have.length(1);
		expect(res.data[0].pluginType).to.equal('IngestStates');
		expect(res.data[0].panelId).to.equal('presets');
		expect(res.data[0].bundle.hash).to.equal('sha256-testhash');
	});

	it('returns empty array when no plugin has adminUi', async () => {
		const ioPlugins = {
			getAdminUiContributions: () => [],
			computeAdminUiBundleHash: async () => 'sha256-testhash',
			readAdminUiTranslations: async () => null,
		};
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.deep.equal([]);
	});

	it('returns contributions from multiple instances of same type', async () => {
		const contributions = [makeContribution({ instanceId: 0 }), makeContribution({ instanceId: 1 })];
		const ioPlugins = {
			getAdminUiContributions: () => contributions,
			computeAdminUiBundleHash: async () => 'sha256-testhash',
			readAdminUiTranslations: async () => null,
		};
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.have.length(2);
	});

	it('returns contribution with empty hash when computeAdminUiBundleHash throws', async () => {
		const contributions = [makeContribution()];
		const ioPlugins = {
			getAdminUiContributions: () => contributions,
			computeAdminUiBundleHash: async () => {
				throw new Error('hash failed');
			},
			readAdminUiTranslations: async () => null,
		};
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(true);
		expect(res.data).to.have.length(1);
		expect(res.data[0].bundle.hash).to.equal('');
	});

	it('returns NOT_READY when ioPlugins is null', async () => {
		const tab = new IoAdminTab(createAdapter(), null);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});

	it('returns NOT_READY when computeAdminUiBundleHash is not a function on ioPlugins', async () => {
		const ioPlugins = { getAdminUiContributions: () => [], readAdminUiTranslations: async () => null };
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_READY');
	});

	it('includes discover-time plugin admin-ui i18n and forwards lang to the plugin runtime', async () => {
		const contributions = [makeContribution()];
		const readCalls = [];
		const ioPlugins = {
			getAdminUiContributions: () => contributions,
			computeAdminUiBundleHash: async () => 'sha256-testhash',
			readAdminUiTranslations: async payload => {
				readCalls.push(payload);
				return {
					lang: 'de',
					translations: { 'msghub.i18n.IngestStates.ui.panels.presets.label': 'Vorgaben' },
				};
			},
		};
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.discover', { lang: 'de' });
		expect(res.ok).to.equal(true);
		expect(readCalls).to.deep.equal([{ type: 'IngestStates', lang: 'de' }]);
		expect(res.data[0].i18n).to.deep.equal({
			lang: 'de',
			translations: { 'msghub.i18n.IngestStates.ui.panels.presets.label': 'Vorgaben' },
		});
	});
});

describe('IoAdminTab admin.pluginUi.bundle.get', () => {
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
			bundle: { hash: '' },
			...overrides,
		};
	}

	function makeIoPlugins({
		contributions,
		jsContent = 'export function mount(){}',
		cssContent = null,
		i18nPayload = null,
		readError = null,
		hashValue = 'sha256-computedhash',
		hashError = null,
	} = {}) {
		let readCalls = 0;
		let lastReadLang;
		return {
			getAdminUiContributions: () => contributions ?? [makeContrib()],
			computeAdminUiBundleHash: async () => {
				if (hashError) {
					throw hashError;
				}
				return hashValue;
			},
			readAdminUiBundle: async ({ lang } = {}) => {
				readCalls++;
				lastReadLang = lang;
				if (readError) {
					throw readError;
				}
				return { js: jsContent, css: cssContent, i18n: i18nPayload };
			},
			_readCallCount: () => readCalls,
			_lastReadLang: () => lastReadLang,
		};
	}

	it('returns bundle on happy path', async () => {
		const ioPlugins = makeIoPlugins({ jsContent: 'export function mount(){}', cssContent: '.host{}' });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(true);
		expect(res.data.js).to.equal('export function mount(){}');
		expect(res.data.css).to.equal('.host{}');
		expect(res.data.moduleFormat).to.equal('esm');
		expect(res.data.hash).to.equal('sha256-computedhash');
		expect(res.data.i18n).to.equal(null);
	});

	it('returns bundle without css when companion CSS is absent', async () => {
		const ioPlugins = makeIoPlugins({ cssContent: null });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(true);
		expect(res.data).to.not.have.property('css');
	});

	it('serves from cache on second call (readAdminUiBundle not called again)', async () => {
		const ioPlugins = makeIoPlugins();
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const req = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		await tab.handleCommand('admin.pluginUi.bundle.get', req);
		await tab.handleCommand('admin.pluginUi.bundle.get', req);
		expect(ioPlugins._readCallCount()).to.equal(1);
	});

	it('returns NOT_FOUND when plugin is not started', async () => {
		const ioPlugins = makeIoPlugins({ contributions: [] });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_FOUND');
	});

	it('returns NOT_FOUND when readAdminUiBundle throws NOT_FOUND', async () => {
		const readError = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
		const ioPlugins = makeIoPlugins({ readError });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_FOUND');
	});

	it('returns FORBIDDEN when readAdminUiBundle throws FORBIDDEN', async () => {
		const readError = Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' });
		const ioPlugins = makeIoPlugins({ readError });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('FORBIDDEN');
	});

	it('returns INTERNAL when JS bundle exceeds 512 KB', async () => {
		const bigJs = 'x'.repeat(512 * 1024 + 1);
		const ioPlugins = makeIoPlugins({ jsContent: bigJs });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('INTERNAL');
	});

	it('returns INTERNAL when CSS exceeds 64 KB', async () => {
		const bigCss = 'x'.repeat(64 * 1024 + 1);
		const ioPlugins = makeIoPlugins({ cssContent: bigCss });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('INTERNAL');
	});

	it('returns BAD_REQUEST when pluginType is missing', async () => {
		const tab = new IoAdminTab(createAdapter(), makeIoPlugins());
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', { panelId: 'presets' });
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('BAD_REQUEST');
	});

	it('forwards lang from request to readAdminUiBundle', async () => {
		const ioPlugins = makeIoPlugins();
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			lang: 'de',
		});
		expect(ioPlugins._lastReadLang()).to.equal('de');
	});

	it('normalizes invalid lang to en before forwarding', async () => {
		const ioPlugins = makeIoPlugins();
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			lang: '../evil',
		});
		expect(ioPlugins._lastReadLang()).to.equal('en');
	});

	it('different lang produces different cache entries', async () => {
		const ioPlugins = makeIoPlugins();
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const base = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		await tab.handleCommand('admin.pluginUi.bundle.get', { ...base, lang: 'en' });
		await tab.handleCommand('admin.pluginUi.bundle.get', { ...base, lang: 'de' });
		expect(ioPlugins._readCallCount()).to.equal(2);
	});

	it('response includes i18n when bundle returns translations', async () => {
		const i18nPayload = { lang: 'de', translations: { 'msghub.i18n.IngestStates.ui.foo': 'Foo' } };
		const ioPlugins = makeIoPlugins({ i18nPayload });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
			lang: 'de',
		});
		expect(res.ok).to.equal(true);
		expect(res.data.i18n).to.deep.equal(i18nPayload);
	});

	it('returns NOT_FOUND when computeAdminUiBundleHash throws NOT_FOUND', async () => {
		const hashError = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
		const ioPlugins = makeIoPlugins({ hashError });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NOT_FOUND');
	});

	it('returns INTERNAL when computeAdminUiBundleHash throws a generic error', async () => {
		const hashError = new Error('disk read failed');
		const ioPlugins = makeIoPlugins({ hashError });
		const tab = new IoAdminTab(createAdapter(), ioPlugins);
		const res = await tab.handleCommand('admin.pluginUi.bundle.get', {
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('INTERNAL');
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
