/**
 * IngestStates
 * ===========
 *
 * Producer plugin that turns ioBroker object custom rules (Objects → Custom) into MsgHub messages.
 *
 * v0.0.2 MVP: implements Freshness rule (missing updates).
 */

'use strict';

const { manifest } = require('./manifest');
const { ensureCtxAvailability } = require('../IoPluginGuards');
const { IngestStatesEngine } = require('./Engine');
const { ensureDefaultPresets } = require('./ensureDefaultPresets');

/**
 * Create an `IngestStates` plugin instance.
 *
 * @param {object} [options] Plugin options.
 * @returns {object} Plugin instance (start/stop/onStateChange/onObjectChange).
 */
function IngestStates(options = {}) {
	let running = false;
	let engine = null;

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
					'api.i18n.t',
					'api.iobroker.objects.getObjectView',
					'api.iobroker.objects.setObjectNotExists',
					'api.iobroker.objects.getForeignObject',
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
				],
				stringNonEmpty: ['api.iobroker.ids.namespace', 'meta.plugin.baseFullId', 'meta.plugin.baseOwnId'],
			});

			engine = new IngestStatesEngine(ctx, options);
			ensureDefaultPresets(ctx).catch(e =>
				ctx?.api?.log?.warn?.(`IngestStates: ensureDefaultPresets failed: ${String(e?.message || e)}`),
			);
			engine.start();
			running = true;
		},

		stop(_ctx) {
			running = false;
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
	};
}

module.exports = { IngestStates, manifest };
