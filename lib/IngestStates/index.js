/**
 * IngestStates
 * ===========
 * Producer plugin that turns ioBroker object custom rules (Objects → Custom) into MsgHub messages.
 *
 * Docs: ../../docs/plugins/IngestStates.md
 *
 */

'use strict';

const { manifest } = require('./manifest');
const { ensureCtxAvailability } = require('../IoPluginGuards');
const { IngestStatesEngine } = require('./Engine');
const { ensureDefaultPresets } = require('./ensureDefaultPresets');
const { createAdminRpcHandler, createWebRpcHandler } = require('./admin-ui/rpc');
const { createPresetsService } = require('./admin-ui/presets-service');
const { createBulkApplyService } = require('./admin-ui/bulkapply-service');

/**
 * Create an `IngestStates` plugin instance.
 *
 * @param {object} [options] Plugin options.
 * @returns {object} Plugin instance (start/stop/onStateChange/onObjectChange/handleAdminUiRpc/handleWebUiRpc).
 */
function IngestStates(options = {}) {
	let running = false;
	let engine = null;
	let adminRpcHandler = null;
	let webRpcHandler = null;
	let presetsService = null;

	return {
		start(ctx) {
			if (running) {
				return;
			}

			ensureCtxAvailability('IngestStates.start', ctx, {
				plainObject: [
					'api',
					'meta',
					'api.log',
					'api.i18n',
					'api.iobroker',
					'api.iobroker.ids',
					'api.iobroker.objects',
					'api.iobroker.states',
					'api.iobroker.subscribe',
					'api.store',
					'api.factory',
					'api.constants',
					'meta.plugin',
					'meta.options',
					'meta.managedObjects',
					'meta.resources',
				],
				fn: [
					'api.log.info',
					'api.log.warn',
					'api.log.debug',
					'api.log.silly',
					'api.i18n.t',
					'api.iobroker.objects.getObjectView',
					'api.iobroker.objects.setObjectNotExists',
					'api.iobroker.objects.getForeignObject',
					'api.iobroker.objects.getForeignObjects',
					'api.iobroker.objects.extendForeignObject',
					'api.iobroker.objects.delObject',
					'api.iobroker.states.setForeignState',
					'api.iobroker.states.getForeignState',
					'api.iobroker.subscribe.subscribeForeignStates',
					'api.iobroker.subscribe.unsubscribeForeignStates',
					'api.iobroker.subscribe.subscribeForeignObjects',
					'api.iobroker.subscribe.unsubscribeForeignObjects',
					'api.store.getMessageByRef',
					'api.store.addMessage',
					'api.store.addOrUpdateMessage',
					'api.store.updateMessage',
					'api.store.completeAfterCauseEliminated',
					'api.factory.createMessage',
					'meta.managedObjects.report',
					'meta.managedObjects.applyReported',
					'meta.options.resolveInt',
					'meta.options.resolveBool',
					'meta.resources.setInterval',
					'meta.resources.setTimeout',
					'meta.resources.clearTimeout',
					'api.iobroker.ids.toOwnId',
				],
				stringNonEmpty: ['api.iobroker.ids.namespace', 'meta.plugin.baseFullId', 'meta.plugin.baseOwnId'],
			});

			engine = new IngestStatesEngine(ctx, options);
			ensureDefaultPresets(ctx).catch(e =>
				ctx?.api?.log?.warn?.(`ensureDefaultPresets failed: ${String(e?.message || e)}`),
			);
			engine.start();
			running = true;

			presetsService = createPresetsService(ctx, engine);
			adminRpcHandler = createAdminRpcHandler({
				presets: presetsService,
				bulkApply: createBulkApplyService(ctx),
			});
			webRpcHandler = createWebRpcHandler({
				presets: presetsService,
				bulkApply: createBulkApplyService(ctx),
			});
		},

		stop(_ctx) {
			running = false;
			adminRpcHandler = null;
			webRpcHandler = null;
			presetsService = null;
			try {
				engine?.stop?.();
			} finally {
				engine = null;
			}
		},

		onStateChange(id, state, ctx) {
			if (!running) {
				return;
			}
			engine?.onStateChange?.(id, state, ctx);
		},

		onObjectChange(id, obj, ctx) {
			if (!running) {
				return;
			}
			engine?.onObjectChange?.(id, obj, ctx);
		},

		onAction(actionInfo, ctx) {
			if (!running) {
				return;
			}
			engine?.onAction?.(actionInfo, ctx);
		},

		getPresetUsageSnapshot() {
			if (!running) {
				return [];
			}
			return engine?.getPresetUsageSnapshot?.() || [];
		},

		/**
		 * Return preset select-option pairs for a given command suffix and raw payload.
		 *
		 * Interprets the suffix as `[rule[.subset]]` and applies payload field overrides.
		 * IngestStates owns all command-specific interpretation of suffix and payload.
		 *
		 * Called by IoAdminTab via IoPlugins.callPluginRuntime.
		 *
		 * @param {{ suffix?: string, payload?: object }} [args] Raw command context from IoAdminTab.
		 * @param {object} [_ctx] Plugin context (unused; provided by IoPlugins convention).
		 * @returns {Promise<Array<{ value: string, label: string }>>} Ordered option pairs.
		 */
		async getPresetSelectOptions({ suffix = '', payload } = {}, _ctx) {
			if (!presetsService) {
				return [];
			}
			// Interpret suffix as rule[.subset] — IngestStates owns this command shape.
			const rawSuffix = typeof suffix === 'string' ? suffix : '';
			const parts = rawSuffix.replace(/^\./, '').split('.').filter(Boolean);
			const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
			// payload.rule / payload.subset win over suffix values when explicitly present.
			const rule = Object.prototype.hasOwnProperty.call(safePayload, 'rule')
				? safePayload.rule
				: parts[0] || null;
			const subset = Object.prototype.hasOwnProperty.call(safePayload, 'subset')
				? safePayload.subset
				: parts[1] || null;
			const currentValue = typeof safePayload.currentValue === 'string' ? safePayload.currentValue.trim() : '';
			return presetsService.getPresetSelectOptions({ rule, subset, currentValue });
		},

		/**
		 * Handle an RPC request from the admin panel.
		 *
		 * Dispatches to the appropriate service method via the RPC handler.
		 * Returns NOT_READY when the plugin is stopped.
		 *
		 * @param {{ panelId?: string, command?: string, payload?: any }} request RPC request.
		 * @param {object} _ctx Plugin context (unused; provided by IoPlugins convention).
		 * @returns {Promise<{ ok: boolean, data?: any, error?: { code: string, message: string } }>} Response.
		 */
		handleAdminUiRpc(request, _ctx) {
			if (!adminRpcHandler) {
				return Promise.resolve({
					ok: false,
					error: { code: 'NOT_READY', message: 'Plugin is not running' },
				});
			}
			return adminRpcHandler.handleRpc(request);
		},

		/**
		 * Handle an RPC request from the web panel.
		 *
		 * Dispatches to the appropriate service method via the RPC handler.
		 * Returns NOT_READY when the plugin is stopped.
		 *
		 * @param {{ panelId?: string, command?: string, payload?: any }} request RPC request.
		 * @param {object} _ctx Plugin context (unused; provided by IoPlugins convention).
		 * @returns {Promise<{ ok: boolean, data?: any, error?: { code: string, message: string } }>} Response.
		 */
		handleWebUiRpc(request, _ctx) {
			if (!webRpcHandler) {
				return Promise.resolve({
					ok: false,
					error: { code: 'NOT_READY', message: 'Plugin is not running' },
				});
			}
			return webRpcHandler.handleRpc(request);
		},
	};
}

module.exports = { IngestStates, manifest };
