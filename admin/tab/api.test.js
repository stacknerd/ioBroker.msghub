/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRepoFile } = require('./_test.utils');

async function loadApiSandbox(overrides = {}) {
	const source = await readRepoFile('admin/tab/api.js');
	const expose = `
window.__apiFns = {
	createNotSupportedError,
	createAsyncCache,
	computeContextMenuPosition,
	toContextMenuIconVar,
	createAdminApi
};
`;

	const windowObject = {
		setTimeout: fn => {
			fn();
			return 1;
		},
		clearTimeout: () => {},
		...overrides.window,
	};
	const documentObject = overrides.document || {
		documentElement: {
			getAttribute: () => 'adminTab',
		},
	};
	let activeView =
		overrides.activeView || {
			composition: {
				id: 'adminTab',
				layout: 'tabs',
				panels: [
					{ type: 'corePanel', panelId: 'stats' },
					{ type: 'corePanel', panelId: 'messages' },
					{ type: 'corePanel', panelId: 'plugins' },
				],
				defaultPanel: 'plugins',
				deviceMode: 'pc',
			},
			corePanels: {},
			request: { mode: 'composition', targetId: 'adminTab' },
		};
	const defaultResolveViewRequest = () => {
		const panel = typeof overrides.args?.panel === 'string' ? overrides.args.panel.trim() : '';
		if (panel) {
			return { mode: 'panel', targetId: panel };
		}
		const composition = typeof overrides.args?.composition === 'string' ? overrides.args.composition.trim() : '';
		if (composition) {
			return { mode: 'composition', targetId: composition };
		}
		const raw = documentObject?.documentElement?.getAttribute?.('data-msghub-view') || '';
		const viewId = String(raw || '').trim();
		return viewId ? { mode: 'composition', targetId: viewId } : { mode: 'composition' };
	};
	const effectiveResolveViewRequest = overrides.resolveViewRequest || defaultResolveViewRequest;
	const defaultGetActiveView = () => activeView;
	const defaultResolveViewId = () => {
		const view = defaultGetActiveView();
		if (view?.request?.mode === 'panel') {
			return null;
		}
		return typeof view?.composition?.id === 'string' ? view.composition.id : 'adminTab';
	};
	const effectiveResolveViewId = overrides.resolveViewId || defaultResolveViewId;
	const defaultGetActiveComposition = () => {
		const composition = defaultGetActiveView()?.composition;
		return composition && typeof composition === 'object' ? composition : null;
	};

	const sandbox = {
		window: windowObject,
		document: documentObject,
		win: windowObject,
		hasAdminKey: key => key === 'known.key',
		resolveViewId: effectiveResolveViewId,
		resolveViewRequest: effectiveResolveViewRequest,
		getActiveView: overrides.getActiveView || defaultGetActiveView,
		getActiveComposition: overrides.getActiveComposition || defaultGetActiveComposition,
		console: { debug() {}, info() {}, warn() {}, error() {} },
		...overrides,
	};

	vm.runInNewContext(`${source}\n${expose}`, sandbox, { filename: 'admin/tab/api.js' });
	return sandbox;
}

describe('admin/tab/api.js', function () {
	it('creates explicit NotSupported errors', async function () {
		const sandbox = await loadApiSandbox();
		const err = sandbox.window.__apiFns.createNotSupportedError('not here');
		assert.equal(err.name, 'NotSupportedError');
		assert.equal(err.code, 'NOT_SUPPORTED');
		assert.match(err.message, /not here/);
	});

	it('caches async values and supports invalidation', async function () {
		const sandbox = await loadApiSandbox();
		let calls = 0;
		const cache = sandbox.window.__apiFns.createAsyncCache(async () => {
			calls++;
			return { calls };
		});

		const first = await cache.get();
		const second = await cache.get();
		assert.deepEqual(first, { calls: 1 });
		assert.equal(second, first, 'second call should return cached reference');
		assert.equal(calls, 1);

		cache.invalidate();
		const third = await cache.get();
		assert.deepEqual(third, { calls: 2 });
		assert.equal(calls, 2);
	});

	it('computes deterministic context menu positions with clamping/flipping', async function () {
		const sandbox = await loadApiSandbox();
		const computePosition = sandbox.window.__apiFns.computeContextMenuPosition;

		const nearOrigin = computePosition({
			anchorX: 100,
			anchorY: 100,
			menuWidth: 240,
			menuHeight: 160,
			viewportWidth: 1200,
			viewportHeight: 900,
			mode: 'cursor',
			alignHeight: 0,
			viewportPadding: 8,
			cursorOffset: 2,
		});
		assert.deepEqual(JSON.parse(JSON.stringify(nearOrigin)), { x: 102, y: 102 });

		const nearBottomRight = computePosition({
			anchorX: 1190,
			anchorY: 890,
			menuWidth: 260,
			menuHeight: 180,
			viewportWidth: 1200,
			viewportHeight: 900,
			mode: 'cursor',
			alignHeight: 0,
			viewportPadding: 8,
			cursorOffset: 2,
		});
		assert.ok(nearBottomRight.x < 1190);
		assert.ok(nearBottomRight.y < 890);
		assert.ok(nearBottomRight.x >= 8);
		assert.ok(nearBottomRight.y >= 8);
	});

	it('normalizes context menu icons safely', async function () {
		const sandbox = await loadApiSandbox();
		const iconVar = sandbox.window.__apiFns.toContextMenuIconVar;
		assert.equal(iconVar('sort-asc'), 'var(--msghub-icon-sort-asc)');
		assert.equal(iconVar(' Sort-Asc '), '');
		assert.equal(iconVar('drop table;'), '');
		assert.equal(iconVar(null), '');
	});

	it('builds stable admin API contracts and routes backend calls', async function () {
		const sentCommands = [];
		let closeCalls = 0;
		let openPayload = null;
		const toastCalls = [];
		const uiStub = {
			toast: payload => toastCalls.push(payload),
			contextMenu: {
				open(payload) {
					openPayload = payload;
					return undefined;
				},
				close() {
					closeCalls++;
				},
				isOpen() {
					return false;
				},
			},
		};

		const sandbox = await loadApiSandbox();

		const createAdminApi = sandbox.window.__apiFns.createAdminApi;
		const api = createAdminApi({
			msghubRequest: async (command, payload) => {
				sentCommands.push({ command, payload });
				return { command, payload };
			},
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'de',
			t: (key, arg) => {
				const normalized = String(key);
				if (normalized === 'known.key') {
					return 'KNOWN';
				}
				if (arg == null) {
					return normalized;
				}
				return `${normalized}:${arg}`;
			},
			pickText: value => (typeof value === 'string' ? value : 'picked'),
			ui: uiStub,
		});

		assert.ok(Object.isFrozen(api));
		assert.equal(api.host.viewId, 'adminTab');
		assert.equal(api.host.layout, 'tabs');
		assert.deepEqual(JSON.parse(JSON.stringify(api.host.panels)), [
			{ type: 'corePanel', panelId: 'stats' },
			{ type: 'corePanel', panelId: 'messages' },
			{ type: 'corePanel', panelId: 'plugins' },
		]);
		assert.equal(api.host.isConnected(), true);
		assert.equal(api.i18n.lang(), 'de');
		assert.equal(api.i18n.has('known.key'), true);
		assert.equal(api.i18n.tOr('missing.key', 'fallback'), 'fallback');
		assert.equal(typeof api.time.getPolicy, 'function');
		assert.equal(typeof api.time.formatTs, 'function');

		await api.constants.get();
		await api.stats.get({ fast: true });
		await api.messages.query({ page: 1 });
		await api.messages.delete(['ref-1']);
		await api.messages.executeAction({ ref: 'r1', actionId: 'ack' });
		await api.plugins.listInstances();
		await api.bootstrap.get();

		const commands = sentCommands.map(entry => entry.command);
		assert.ok(commands.includes('web.constants.get'));
		assert.ok(commands.includes('web.stats.get'));
		assert.ok(commands.includes('web.messages.query'));
		assert.ok(commands.includes('admin.messages.delete'));
		assert.ok(commands.includes('web.messages.action'));
		assert.ok(commands.includes('admin.plugins.listInstances'));
		assert.ok(commands.includes('ui.bootstrap'));

		api.ui.contextMenu.open({
			items: [
				{
					label: 'Do thing',
					onSelect: () => Promise.resolve('done'),
				},
			],
		});
		assert.ok(openPayload && Array.isArray(openPayload.items));
		await openPayload.items[0].onSelect();
		assert.equal(closeCalls > 0, true, 'context menu should close before action execution');
		assert.equal(toastCalls.length, 0, 'context menu wrapper must not emit generic toasts');

		assert.throws(() => api.notSupported('x'), err => err && err.code === 'NOT_SUPPORTED');
	});

	it('api.host.panels exposes the active structured composition refs unchanged', async function () {
		const sandbox = await loadApiSandbox({
			activeView: {
				composition: {
					id: 'adminTab',
					layout: 'tabs',
					panels: [
						{ type: 'corePanel', panelId: 'messages' },
						{ type: 'corePanel', panelId: 'plugins' },
						{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
					],
					defaultPanel: 'messages',
					deviceMode: 'pc',
				},
				corePanels: {},
				request: { mode: 'composition', targetId: 'adminTab' },
			},
		});
		const createAdminApi = sandbox.window.__apiFns.createAdminApi;
		const api = createAdminApi({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: v => String(v || ''),
			ui: {},
		});

		const panels = JSON.parse(JSON.stringify(api.host.panels));
		assert.deepEqual(panels, [
			{ type: 'corePanel', panelId: 'messages' },
			{ type: 'corePanel', panelId: 'plugins' },
			{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
		]);
	});

	it('uses the shared view resolver and active composition globals for host metadata', async function () {
		const sandbox = await loadApiSandbox({
			resolveViewId: () => 'customView',
			getActiveComposition: () => ({
				layout: 'single',
				panels: [
					{ type: 'corePanel', panelId: 'messages' },
					{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
				],
				defaultPanel: 'messages',
				deviceMode: 'screenOnly',
			}),
			document: {
				documentElement: {
					getAttribute: () => 'adminTab',
				},
			},
		});
		const createAdminApi = sandbox.window.__apiFns.createAdminApi;
		const api = createAdminApi({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: value => String(value || ''),
			ui: {},
		});

		assert.equal(api.host.viewId, 'customView');
		assert.equal(api.host.layout, 'single');
		assert.equal(api.host.deviceMode, 'screenOnly');
		assert.equal(api.host.defaultPanel, 'messages');
		assert.deepEqual(JSON.parse(JSON.stringify(api.host.panels)), [
			{ type: 'corePanel', panelId: 'messages' },
			{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
		]);
	});

	it('handles missing active composition defensively while still using the shared resolved view id', async function () {
		const sandbox = await loadApiSandbox({
			resolveViewId: () => 'adminTab',
			getActiveComposition: () => null,
		});
		const createAdminApi = sandbox.window.__apiFns.createAdminApi;
		const api = createAdminApi({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: false },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: value => String(value || ''),
			ui: {},
		});

		assert.equal(api.host.viewId, 'adminTab');
		assert.equal(api.host.layout, 'tabs');
		assert.equal(api.host.deviceMode, 'pc');
		assert.deepEqual(JSON.parse(JSON.stringify(api.host.panels)), []);
		assert.equal(api.host.defaultPanel, '');
	});

	it('api.host.isExpertMode treats the URL flag as additive over session and host state', async function () {
		const urlEnabled = await loadApiSandbox({
			args: { expert: true },
			window: {
				sessionStorage: { getItem: () => 'false' },
				top: { _system: { expertMode: false } },
			},
		});
		const createAdminApiA = urlEnabled.window.__apiFns.createAdminApi;
		const apiA = createAdminApiA({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: value => String(value || ''),
			ui: {},
		});
		assert.equal(apiA.host.isExpertMode(), true);

		const hostFallback = await loadApiSandbox({
			args: { expert: false },
			window: {
				sessionStorage: { getItem: key => (String(key) === 'App.expertMode' ? 'true' : null) },
				top: { _system: { expertMode: false } },
			},
		});
		const createAdminApiB = hostFallback.window.__apiFns.createAdminApi;
		const apiB = createAdminApiB({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: value => String(value || ''),
			ui: {},
		});
		assert.equal(apiB.host.isExpertMode(), true);
	});

	it('api.host.isExpertMode tolerates host access errors and returns false when nothing enables it', async function () {
		const sandbox = await loadApiSandbox({
			args: { expert: false },
			window: {
				top: {},
			},
		});
		Object.defineProperty(sandbox.window, 'sessionStorage', {
			get() {
				throw new Error('blocked');
			},
		});

		const createAdminApi = sandbox.window.__apiFns.createAdminApi;
		const api = createAdminApi({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: value => String(value || ''),
			ui: {},
		});

		assert.equal(api.host.isExpertMode(), false);
	});

	it('context menu wrapper does not emit generic error toasts when handlers reject', async function () {
		let openPayload = null;
		const toastCalls = [];
		const sandbox = await loadApiSandbox();
		const createAdminApi = sandbox.window.__apiFns.createAdminApi;
		const api = createAdminApi({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: value => String(value || ''),
			ui: {
				toast: payload => toastCalls.push(payload),
				contextMenu: {
					open(payload) {
						openPayload = payload;
					},
					close() {},
					isOpen() {
						return false;
					},
				},
			},
		});

		api.ui.contextMenu.open({
			items: [
				{
					label: 'Explode',
					onSelect: async () => {
						throw new Error('boom');
					},
				},
			],
		});

		await assert.rejects(() => openPayload.items[0].onSelect(), /boom/);
		assert.equal(toastCalls.length, 0, 'rejected handlers must not trigger generic error toasts');
	});

	it('normalizes timezone policy and formats timestamps with UTC fallback', async function () {
		const sandbox = await loadApiSandbox();
		const createAdminApi = sandbox.window.__apiFns.createAdminApi;
		const api = createAdminApi({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: value => String(value || ''),
			ui: {},
		});

		const initial = api.time.getPolicy();
		assert.equal(initial.timeZone, 'UTC');
		assert.equal(initial.isFallbackUtc, true);

		const policy = api.time.setPolicy({ timeZone: 'Europe/Berlin', source: 'server' });
		assert.equal(policy.timeZone, 'Europe/Berlin');
		assert.equal(policy.isFallbackUtc, false);
		assert.notEqual(api.time.formatTs(1700000000000), '');

		const invalid = api.time.setPolicy({ timeZone: 'Invalid/Zone', source: 'server' });
		assert.equal(invalid.timeZone, 'UTC');
		assert.equal(invalid.isFallbackUtc, true);
		assert.match(invalid.warning, /timezone_fallback_utc/);
		assert.equal(api.time.formatTs(NaN), '');
	});

	it('uses args.locale as the default frontend format locale when no explicit locale is provided', async function () {
		const sandbox = await loadApiSandbox({
			args: { locale: 'de-DE' },
		});
		const createAdminApi = sandbox.window.__apiFns.createAdminApi;
		const api = createAdminApi({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: value => String(value || ''),
			ui: {},
		});

		api.time.setPolicy({ timeZone: 'UTC', source: 'server' });
		const rendered = api.time.formatTs(Date.UTC(2024, 0, 2, 3, 4, 5));
		assert.match(rendered, /\b02\/01\/2024\b|\b02\.01\.2024\b/);
	});

	it('keeps explicit format locale precedence over args.locale and ignores invalid args.locale', async function () {
		const urlOverride = await loadApiSandbox({
			args: { locale: 'de-DE' },
		});
		const createAdminApiA = urlOverride.window.__apiFns.createAdminApi;
		const apiA = createAdminApiA({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: value => String(value || ''),
			ui: {},
		});
		apiA.time.setPolicy({ timeZone: 'UTC', source: 'server' });
		const explicit = apiA.time.formatTs(Date.UTC(2024, 0, 2, 3, 4, 5), { locale: 'en-US' });
		assert.match(explicit, /\b01\/02\/2024\b/);

		const invalidOverride = await loadApiSandbox({
			args: { locale: 'bad-locale-@@@' },
		});
		const createAdminApiB = invalidOverride.window.__apiFns.createAdminApi;
		const apiB = createAdminApiB({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: value => String(value || ''),
			ui: {},
		});
		apiB.time.setPolicy({ timeZone: 'UTC', source: 'server' });
		assert.notEqual(apiB.time.formatTs(Date.UTC(2024, 0, 2, 3, 4, 5)), '');
	});

	it('panel mode: args.panel sets host.viewId=null, layout=single, panels=[corePanelRef], defaultPanel=panelId', async function () {
		const sandbox = await loadApiSandbox({
			args: { panel: 'tab-messages' },
			activeView: {
				composition: {
					id: 'comp-tab-messages',
					layout: 'single',
					panels: [{ type: 'corePanel', panelId: 'messages' }],
					defaultPanel: 'messages',
					deviceMode: 'pc',
				},
				corePanels: {},
				request: { mode: 'panel', targetId: 'tab-messages' },
			},
		});
		const api = sandbox.window.__apiFns.createAdminApi({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: value => String(value || ''),
			ui: {},
		});
		assert.equal(api.host.viewId, null, 'panel mode must set viewId to null');
		assert.equal(api.host.layout, 'single');
		assert.equal(api.host.deviceMode, 'pc');
		assert.deepEqual(JSON.parse(JSON.stringify(api.host.panels)), [{ type: 'corePanel', panelId: 'messages' }]);
		assert.equal(api.host.defaultPanel, 'messages');
	});

	it('panel mode wins over args.composition when both are present', async function () {
		const sandbox = await loadApiSandbox({ args: { composition: 'adminTab', panel: 'tab-messages' } });
		const api = sandbox.window.__apiFns.createAdminApi({
			msghubRequest: async () => ({}),
			msghubSocket: { connected: true },
			adapterInstance: 'msghub.0',
			lang: 'en',
			t: key => String(key),
			pickText: value => String(value || ''),
			ui: {},
		});
		assert.equal(api.host.viewId, null, 'panel mode must win over composition — viewId must be null');
		assert.equal(api.host.layout, 'single');
	});
});
