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

	/**
	 * Creates a minimal full panel setup and captures the onActionExecute callback.
	 *
	 * @param {object} [opts] - Override options.
	 * @param {boolean} [opts.failExecuteAction] - Whether executeAction should reject.
	 * @returns {Promise<object>} Captured context.
	 */
	async function setupPanelWithActionCapture(opts = {}) {
		const { failExecuteAction = false } = opts;
		const sandbox = await loadIndexModule();
		const root = createElement('div');
		root.closest = () => ({ classList: { toggle() {} } });

		let capturedOnActionExecute = null;
		let capturedOnLinkOpen = null;
		const executeActionCalls = [];
		const toasts = [];
		const overlayCloseCalls = [];
		const confirmCalls = [];
		let queryMessagesPageCalls = 0;
		let dialogConfirmResult = true;

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
				loadConstants: async () => undefined,
				queryMessagesPage: async () => {
					queryMessagesPageCalls += 1;
					return { items: [], total: 0, pages: 1, meta: {} };
				},
				deleteMessages: async () => undefined,
				getLevelLabel: value => String(value),
				getFilterSet: () => new Set(),
			}),
		};
		sandbox.window.MsghubAdminTabMessagesDataArchive = {
			createArchiveDataApi: () => ({ normalizeCursorEdge: value => value }),
		};
		sandbox.window.MsghubAdminTabMessagesOverlayJson = {
			createJsonOverlay: () => ({ openMessageJson() {} }),
		};
		sandbox.window.MsghubAdminTabMessagesOverlayArchive = {
			createArchiveOverlay: () => ({ openArchiveOverlay() {}, renderArchiveView() {} }),
		};
		sandbox.window.MsghubAdminTabMessagesMenus = {
			createMessagesMenus: menuOpts => {
				capturedOnActionExecute = menuOpts.onActionExecute;
				capturedOnLinkOpen = menuOpts.onLinkOpen;
				return { openRowContextMenu() {} };
			},
		};
		sandbox.window.MsghubAdminTabMessagesRenderMeta = {
			createMetaRenderer: () => ({
				mount() {},
				updateDeleteButton() {},
				updateButtons() {},
				updatePaging() {},
				setError() {},
				setMeta() {},
				setEmptyVisible() {},
				updateTbody() {},
				elements: metaElements,
			}),
		};
		sandbox.window.MsghubAdminTabMessagesRenderHeader = {
			createHeaderRenderer: () => ({
				renderThead() {},
				updateHeaderButtons() {},
			}),
		};
		sandbox.window.MsghubAdminTabMessagesRenderTable = {
			createTableRenderer: () => ({ renderRows: () => [] }),
		};
		sandbox.window.MsghubAdminTabMessagesLifecycle = {
			createLifecycle: () => ({
				scheduleAuto() {},
				stopAuto() {},
				bindEvents() {},
				unbindEvents() {},
				canAutoRefresh: () => true,
			}),
		};

		sandbox.window.MsghubAdminTabMessages.init({
				api: {
					i18n: {
						t: (key, ...args) =>
							args.reduce((out, arg) => out.replace('%s', String(arg)), String(key)),
					},
					ui: {
						toast: toastOpts => toasts.push(toastOpts),
						dialog: {
							confirm: async optsArg => {
								confirmCalls.push(optsArg);
								return dialogConfirmResult;
							},
						},
						overlayLarge: { close: () => overlayCloseCalls.push(1) },
						spinner: { show: () => 'sid', hide: () => undefined },
					},
				messages: {
					executeAction: async params => {
						executeActionCalls.push(params);
						if (failExecuteAction) {
							throw new Error('execute_failed');
						}
						return { ok: true };
					},
				},
				time: {
					formatTs: () => '',
					formatDate: () => '',
					getPolicy: () => ({ timeZone: 'UTC', source: 'server' }),
				},
			},
			ui: {},
			h: createH(),
			elements: { messagesRoot: root },
		});

		return {
			capturedOnActionExecute: () => capturedOnActionExecute,
			capturedOnLinkOpen: () => capturedOnLinkOpen,
			executeActionCalls,
			toasts,
			overlayCloseCalls,
			confirmCalls,
			get queryMessagesPageCalls() {
				return queryMessagesPageCalls;
			},
			setDialogConfirmResult: val => {
				dialogConfirmResult = val;
			},
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

		it('onActionExecute: confirm accepted fires executeAction, closes overlay, refreshes list, and shows success toast', async function () {
			const ctx = await setupPanelWithActionCapture();
			const onActionExecute = ctx.capturedOnActionExecute();
			assert.equal(typeof onActionExecute, 'function', 'onActionExecute must be wired through createMessagesMenus');

		const queryBefore = ctx.queryMessagesPageCalls;
		await onActionExecute('r1', 'ack-1', 'ack');

		assert.equal(ctx.executeActionCalls.length, 1);
			assert.equal(ctx.executeActionCalls[0].ref, 'r1');
			assert.equal(ctx.executeActionCalls[0].actionId, 'ack-1');
			assert.equal(ctx.overlayCloseCalls.length, 1, 'overlay must be closed after execute');
			assert.ok(ctx.queryMessagesPageCalls > queryBefore, 'list must be refreshed after execute');
			assert.equal(ctx.toasts.length, 1, 'success toast must be shown after execute');
			assert.equal(ctx.toasts[0].variant, 'ok');
			assert.equal(
				ctx.toasts[0].text,
				"msghub.i18n.core.admin.ui.messages.action.executed.text".replace('%s', 'ack').replace('%s', 'r1'),
			);
		});

		it('onActionExecute: confirm cancelled → executeAction not called and no toast shown', async function () {
			const ctx = await setupPanelWithActionCapture();
			ctx.setDialogConfirmResult(false);
			const onActionExecute = ctx.capturedOnActionExecute();

		await onActionExecute('r1', 'ack-1', 'ack');

			assert.equal(ctx.executeActionCalls.length, 0, 'executeAction must not be called when confirm is cancelled');
			assert.equal(ctx.overlayCloseCalls.length, 0, 'overlay must not be closed when confirm is cancelled');
			assert.equal(ctx.toasts.length, 0, 'cancel must not show any toast');
		});

		it('onActionExecute: execute throws → error toast shown with reason, overlay not closed', async function () {
			const ctx = await setupPanelWithActionCapture({ failExecuteAction: true });
			const onActionExecute = ctx.capturedOnActionExecute();

		await onActionExecute('r1', 'ack-1', 'ack');

			assert.equal(ctx.executeActionCalls.length, 1, 'executeAction must have been attempted');
			assert.equal(ctx.overlayCloseCalls.length, 0, 'overlay must not be closed on execute error');
			assert.equal(ctx.toasts.length, 1, 'error toast must be shown');
			assert.equal(ctx.toasts[0].variant, 'danger');
			assert.equal(
				ctx.toasts[0].text,
				'msghub.i18n.core.admin.ui.messages.action.failedWithReason.text'
					.replace('%s', 'ack')
					.replace('%s', 'r1')
					.replace('%s', 'execute_failed'),
			);
		});

	it('onActionExecute: delete marks confirm dialog as danger', async function () {
		const ctx = await setupPanelWithActionCapture();
		const onActionExecute = ctx.capturedOnActionExecute();

		await onActionExecute('r1', 'delete-1', 'delete');

		assert.equal(ctx.confirmCalls.length, 1);
		assert.equal(ctx.confirmCalls[0].danger, true);
	});

	it('onLinkOpen is wired to createMessagesMenus; calling it calls window.open with correct args', async function () {
		const sandbox = await loadIndexModule();
		const root = createElement('div');
		root.closest = () => ({ classList: { toggle() {} } });

		const openCalls = [];
		let capturedOnLinkOpen = null;

		sandbox.window.open = (url, target, features) => openCalls.push({ url, target, features });

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
				loadConstants: async () => undefined,
				queryMessagesPage: async () => ({ items: [], total: 0, pages: 1, meta: {} }),
				deleteMessages: async () => undefined,
				getLevelLabel: value => String(value),
				getFilterSet: () => new Set(),
			}),
		};
		sandbox.window.MsghubAdminTabMessagesDataArchive = {
			createArchiveDataApi: () => ({ normalizeCursorEdge: value => value }),
		};
		sandbox.window.MsghubAdminTabMessagesOverlayJson = {
			createJsonOverlay: () => ({ openMessageJson() {} }),
		};
		sandbox.window.MsghubAdminTabMessagesOverlayArchive = {
			createArchiveOverlay: () => ({ openArchiveOverlay() {}, renderArchiveView() {} }),
		};
		sandbox.window.MsghubAdminTabMessagesMenus = {
			createMessagesMenus: menuOpts => {
				capturedOnLinkOpen = menuOpts.onLinkOpen;
				return { openRowContextMenu() {} };
			},
		};
		sandbox.window.MsghubAdminTabMessagesRenderMeta = {
			createMetaRenderer: () => ({
				mount() {},
				updateDeleteButton() {},
				updateButtons() {},
				updatePaging() {},
				setError() {},
				setMeta() {},
				setEmptyVisible() {},
				updateTbody() {},
				elements: {
					tbodyEl: createElement('tbody'),
					theadEl: createElement('thead'),
					colgroupEl: createElement('colgroup'),
					tableEl: createElement('table'),
				},
			}),
		};
		sandbox.window.MsghubAdminTabMessagesRenderHeader = {
			createHeaderRenderer: () => ({ renderThead() {}, updateHeaderButtons() {} }),
		};
		sandbox.window.MsghubAdminTabMessagesRenderTable = {
			createTableRenderer: () => ({ renderRows: () => [] }),
		};
		sandbox.window.MsghubAdminTabMessagesLifecycle = {
			createLifecycle: () => ({
				scheduleAuto() {},
				stopAuto() {},
				bindEvents() {},
				unbindEvents() {},
				canAutoRefresh: () => true,
			}),
		};

		sandbox.window.MsghubAdminTabMessages.init({
			api: {
				i18n: { t: key => key },
				ui: {
					toast() {},
					dialog: { confirm: async () => true },
				},
				messages: { executeAction: async () => ({ ok: true }) },
				time: {
					formatTs: () => '',
					formatDate: () => '',
					getPolicy: () => ({ timeZone: 'UTC', source: 'server' }),
				},
			},
			ui: {},
			h: createH(),
			elements: { messagesRoot: root },
		});

		assert.equal(typeof capturedOnLinkOpen, 'function', 'onLinkOpen must be wired through createMessagesMenus');
		capturedOnLinkOpen('https://example.com/test');
		assert.equal(openCalls.length, 1);
		assert.equal(openCalls[0].url, 'https://example.com/test');
		assert.equal(openCalls[0].target, '_blank');
		assert.equal(openCalls[0].features, 'noopener,noreferrer');
	});
});
