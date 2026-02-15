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

	const sandbox = {
		window: windowObject,
		document: documentObject,
		win: windowObject,
		hasAdminKey: key => key === 'known.key',
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
		const uiStub = {
			toast: () => {},
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

		const sandbox = await loadApiSandbox({
			window: {
				MsghubAdminTabRegistry: {
					compositions: {
						adminTab: {
							layout: 'tabs',
							panels: ['stats', 'messages', 'plugins'],
							defaultPanel: 'plugins',
							deviceMode: 'pc',
						},
					},
				},
			},
		});

		const createAdminApi = sandbox.window.__apiFns.createAdminApi;
		const api = createAdminApi({
			sendTo: async (command, payload) => {
				sentCommands.push({ command, payload });
				return { command, payload };
			},
			socket: { connected: true },
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
		assert.deepEqual(JSON.parse(JSON.stringify(api.host.panels)), ['stats', 'messages', 'plugins']);
		assert.equal(api.host.isConnected(), true);
		assert.equal(api.i18n.lang(), 'de');
		assert.equal(api.i18n.has('known.key'), true);
		assert.equal(api.i18n.tOr('missing.key', 'fallback'), 'fallback');

		await api.constants.get();
		await api.stats.get({ fast: true });
		await api.messages.query({ page: 1 });
		await api.messages.delete(['ref-1']);
		await api.plugins.listInstances();
		await api.ingestStates.constants.get();
		await api.runtime.about();

		const commands = sentCommands.map(entry => entry.command);
		assert.ok(commands.includes('admin.constants.get'));
		assert.ok(commands.includes('admin.stats.get'));
		assert.ok(commands.includes('admin.messages.query'));
		assert.ok(commands.includes('admin.messages.delete'));
		assert.ok(commands.includes('admin.plugins.listInstances'));
		assert.ok(commands.includes('admin.ingestStates.constants.get'));
		assert.ok(commands.includes('runtime.about'));

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

		assert.throws(() => api.notSupported('x'), err => err && err.code === 'NOT_SUPPORTED');
	});
});
