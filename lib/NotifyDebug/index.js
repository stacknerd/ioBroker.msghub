/**
 * NotifyDebug
 * ==========
 *
 * Bare-minimum skeleton for a MsgHub Notify plugin (current API: `create(options) => handler`).
 *
 * Docs: ../../docs/plugins/NotifyDebug.md
 *
 * Contract (MsgNotify)
 * - Factory is called by IoPlugins as `NotifyDebug(options)` (no adapter argument).
 * - Handler is called by MsgNotify as `onNotifications(event, notifications, ctx)`.
 *   - `event` is a value from `ctx.api.constants.notfication.events` (e.g. "due", "updated", ...).
 *   - `notifications` is always an array (currently often length 1, but treat it as a batch).
 *   - `ctx.api.log` is the logging facade.
 */

'use strict';

const { manifest } = require('./manifest');
const { ensureCtxAvailability } = require('../IoPluginGuards');

/**
 * Create a MsgNotify plugin handler.
 *
 * @param {{ trace?: boolean, someText?: string, pluginBaseObjectId?: string }} [options] Plugin options (from ioBroker `native`).
 * @returns {{ start?: (ctx: any) => void, stop?: (ctx: any) => void, onNotifications: (event: string, notifications: any[], ctx: any) => void }} Handler object.
 */
function NotifyDebug(options = {}) {
	const trace = options?.trace === true;
	const someText = typeof options?.someText === 'string' ? options.someText.trim() : '';
	let initialized = false;
	let log = null;
	let i18n = null;
	let constants = null;
	let plugin = null;

	const ensureInitialized = ctx => {
		if (initialized) {
			return;
		}
		ensureCtxAvailability('NotifyDebug', ctx, {
			plainObject: ['api', 'meta', 'meta.plugin', 'api.log', 'api.i18n', 'api.constants'],
			fn: ['api.log.debug', 'api.i18n.t'],
		});
		log = ctx.api.log;
		i18n = ctx.api.i18n;
		constants = ctx.api.constants;
		plugin = ctx.meta.plugin;
		initialized = true;
	};

	return {
		start(ctx) {
			if (!trace) {
				return;
			}

			ensureInitialized(ctx);

			log.debug('NotifyDebug: start');
			log.debug(`NotifyDebug: options=${JSON.stringify(options)}`);
			if (someText) {
				log.debug(`NotifyDebug: someText='${someText}'`);
			}

			log.debug(`NotifyDebug: ctx.api.constants.kind=${JSON.stringify(constants.kind)}`);
			log.debug(`NotifyDebug: ctx.api.constants.level=${JSON.stringify(constants.level)}`);

			const raw = 'this is translated by ctx.api.i18n.t()';
			const translated = i18n.t(raw);
			log.debug(`NotifyDebug: i18n='${translated}'`);

			log.debug(
				`NotifyDebug: plugin regId='${plugin.regId}' baseFullId='${plugin.baseFullId}' baseOwnId='${plugin.baseOwnId}'`,
			);
		},
		stop(ctx) {
			if (!trace) {
				return;
			}
			ensureInitialized(ctx);
			log.debug('NotifyDebug: stop');
		},
		onNotifications(event, notifications, ctx) {
			if (trace) {
				ensureInitialized(ctx);
				for (const msg of notifications) {
					log.debug(`NotifyDebug: '${msg.ref}' ${event}: ${msg?.title} - ${msg.text}`);
				}
			}
		},
	};
}

module.exports = { NotifyDebug, manifest };
