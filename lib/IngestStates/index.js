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
					'meta.resources',
				],
				fn: [
					'api.log.info',
					'api.log.warn',
					'api.log.debug',
					'api.iobroker.objects.getObjectView',
					'api.iobroker.states.getForeignState',
					'api.iobroker.subscribe.subscribeForeignStates',
					'api.iobroker.subscribe.unsubscribeForeignStates',
					'api.iobroker.subscribe.subscribeForeignObjects',
					'api.iobroker.subscribe.unsubscribeForeignObjects',
					'api.store.getMessageByRef',
					'api.store.addOrUpdateMessage',
					'api.store.updateMessage',
					'api.store.completeAfterCauseEliminated',
					'api.factory.createMessage',
					'meta.options.resolveInt',
					'meta.options.resolveBool',
					'meta.resources.setInterval',
					'meta.resources.setTimeout',
				],
				stringNonEmpty: ['api.iobroker.ids.namespace'],
			});

			engine = new IngestStatesEngine(ctx, options);
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

