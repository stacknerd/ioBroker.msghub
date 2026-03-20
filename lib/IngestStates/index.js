/**
 * IngestStates
 * ===========
 *
 * Producer plugin that turns ioBroker object custom rules (Objects → Custom) into MsgHub messages.
 *
 */

'use strict';

const { manifest } = require('./manifest');
const { ensureCtxAvailability } = require('../IoPluginGuards');
const { IngestStatesEngine } = require('./Engine');
const { ensureDefaultPresets } = require('./ensureDefaultPresets');
const { createRpcHandler } = require('./admin-ui/rpc');
const { createPresetsService } = require('./admin-ui/presets-service');

/**
 * Create an `IngestStates` plugin instance.
 *
 * @param {object} [options] Plugin options.
 * @returns {object} Plugin instance (start/stop/onStateChange/onObjectChange/handleAdminUiRpc).
 */
function IngestStates(options = {}) {
	let running = false;
	let engine = null;
	let rpcHandler = null;

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

			rpcHandler = createRpcHandler({
				presets: createPresetsService(ctx, engine),
			});
		},

		stop(_ctx) {
			running = false;
			rpcHandler = null;
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
			if (!rpcHandler) {
				return Promise.resolve({
					ok: false,
					error: { code: 'NOT_READY', message: 'Plugin is not running' },
				});
			}
			return rpcHandler.handleRpc(request);
		},
	};
}

module.exports = { IngestStates, manifest };
