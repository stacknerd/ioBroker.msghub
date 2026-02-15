/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { createElement, createH, loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/messages/index.js', function () {
	async function loadIndexModule() {
		return loadPanelModule('admin/tab/panels/messages/index.js');
	}

	function createState() {
		return {
			autoRefreshMs: 15000,
			loading: false,
			silentLoading: false,
			autoRefresh: true,
			autoTimer: null,
			requestSeq: 0,
			hasLoadedOnce: false,
			lastError: null,
			constants: null,
			items: [],
			total: 0,
			pages: 1,
			lastMeta: null,
			serverTz: null,
			pageIndex: 1,
			pageSize: 50,
			sortField: 'timing.createdAt',
			sortDir: 'desc',
			expertMode: false,
			selectedRefs: new Set(),
			syncSelectionUI: () => undefined,
			suppressRowClickUntil: 0,
			headerSelectAllInput: null,
			tableColCount: 11,
			columnFilters: Object.create(null),
			archiveMode: 'follow',
			archiveEdgeOldest: null,
			archiveEdgeNewest: null,
			archiveHasMoreBackward: false,
			archiveHasMoreForward: false,
			archivePendingNewCount: 0,
			archiveActiveRef: '',
			archiveItemsByRef: new Map(),
		};
	}

	it('throws when messages root is missing', async function () {
		const sandbox = await loadIndexModule();
		assert.throws(
			() =>
				sandbox.window.MsghubAdminTabMessages.init({
					api: { i18n: { t: key => key } },
					h: createH(),
					elements: {},
				}),
			/missing messagesRoot element/,
		);
	});

	it('throws when required submodule is missing', async function () {
		const sandbox = await loadIndexModule();
		const root = createElement('div');
		sandbox.window.MsghubAdminTabMessagesState = { createMessagesState: () => createState() };

		assert.throws(
			() =>
				sandbox.window.MsghubAdminTabMessages.init({
					api: { i18n: { t: key => key } },
					h: createH(),
					elements: { messagesRoot: root },
				}),
			/data\.messages module is missing/,
		);
	});

	it('initializes orchestrator and runs onConnect lifecycle', async function () {
		const sandbox = await loadIndexModule();
		const root = createElement('div');
		root.closest = () => ({ classList: { toggle() {} } });
		const calls = {
			loadConstants: 0,
			queryMessagesPage: 0,
			scheduleAuto: 0,
			renderThead: 0,
			mount: 0,
			updateHeaderButtons: 0,
			updateButtons: 0,
			updatePaging: 0,
			updateTbody: 0,
		};
		const metaElements = {
			tbodyEl: createElement('tbody'),
			theadEl: createElement('thead'),
			colgroupEl: createElement('colgroup'),
			tableEl: createElement('table'),
		};
		sandbox.window.MsghubAdminTabMessagesState = {
			createMessagesState: () => createState(),
			detectExpertMode: () => false,
			isObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
			safeStr: value => (value == null ? '' : String(value)),
			pick: (obj, path) => path.split('.').reduce((cur, key) => (cur ? cur[key] : undefined), obj),
			formatTs: value => `ts:${value}`,
		};
		sandbox.window.MsghubAdminTabMessagesDataMessages = {
			createMessagesDataApi: () => ({
				loadConstants: async () => {
					calls.loadConstants += 1;
				},
				queryMessagesPage: async () => {
					calls.queryMessagesPage += 1;
					return {
						items: [{ ref: 'ref.1' }],
						total: 1,
						pages: 1,
						meta: { generatedAt: 1700000000000, tz: 'UTC' },
					};
				},
				deleteMessages: async () => undefined,
				getLevelLabel: value => String(value),
				getFilterSet: () => new Set(),
			}),
		};
		sandbox.window.MsghubAdminTabMessagesDataArchive = {
			createArchiveDataApi: () => ({
				normalizeCursorEdge: value => value,
			}),
		};
		sandbox.window.MsghubAdminTabMessagesOverlayJson = {
			createJsonOverlay: () => ({
				openMessageJson() {},
			}),
		};
		sandbox.window.MsghubAdminTabMessagesOverlayArchive = {
			createArchiveOverlay: () => ({
				openArchiveOverlay() {},
				renderArchiveView() {},
			}),
		};
		sandbox.window.MsghubAdminTabMessagesMenus = {
			createMessagesMenus: () => ({
				openRowContextMenu() {},
			}),
		};
		sandbox.window.MsghubAdminTabMessagesRenderMeta = {
			createMetaRenderer: () => ({
				mount() {
					calls.mount += 1;
				},
				updateDeleteButton() {},
				updateButtons() {
					calls.updateButtons += 1;
				},
				updatePaging() {
					calls.updatePaging += 1;
				},
				setProgressVisible() {},
				setError() {},
				setMeta() {},
				setEmptyVisible() {},
				updateTbody() {
					calls.updateTbody += 1;
				},
				elements: metaElements,
			}),
		};
		sandbox.window.MsghubAdminTabMessagesRenderHeader = {
			createHeaderRenderer: () => ({
				renderThead() {
					calls.renderThead += 1;
				},
				updateHeaderButtons() {
					calls.updateHeaderButtons += 1;
				},
			}),
		};
		sandbox.window.MsghubAdminTabMessagesRenderTable = {
			createTableRenderer: () => ({
				renderRows: () => [],
			}),
		};
		sandbox.window.MsghubAdminTabMessagesLifecycle = {
			createLifecycle: () => ({
				scheduleAuto() {
					calls.scheduleAuto += 1;
				},
				stopAuto() {},
				bindEvents() {},
				unbindEvents() {},
				canAutoRefresh: () => true,
			}),
		};

		const panel = sandbox.window.MsghubAdminTabMessages.init({
			api: {
				i18n: { t: key => key },
				ui: {
					toast() {},
					dialog: { confirm: async () => true },
				},
			},
			ui: {},
			h: createH(),
			elements: { messagesRoot: root },
		});

		assert.equal(typeof panel.onConnect, 'function');
		assert.equal(calls.mount, 1);
		assert.equal(calls.renderThead, 1);
		assert.ok(calls.updateButtons >= 1);
		assert.ok(calls.updatePaging >= 1);

		await panel.onConnect();
		assert.equal(calls.loadConstants, 1);
		assert.equal(calls.queryMessagesPage, 1);
		assert.equal(calls.scheduleAuto, 1);
		assert.ok(calls.updateTbody >= 1);
	});
});
