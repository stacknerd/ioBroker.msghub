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

/**
 * Create a MsgNotify plugin handler.
 *
 * @param {{ trace?: boolean, someText?: string, pluginBaseObjectId?: string }} [options] Plugin options (from ioBroker `native`).
 * @returns {{ start?: (ctx: any) => void, stop?: (ctx: any) => void, onNotifications: (event: string, notifications: any[], ctx: any) => void }} Handler object.
 */
function NotifyDebug(options = {}) {
	const trace = options?.trace === true;
	const someText = typeof options?.someText === 'string' ? options.someText : '';

	return {
		start(ctx) {
			if (!trace) {
				return;
			}

			ctx?.api?.log?.debug?.('NotifyDebug: start');
			ctx?.api?.log?.debug?.(`NotifyDebug: options=${JSON.stringify(options)}`);
			if (someText) {
				ctx?.api?.log?.debug?.(`NotifyDebug: someText='${someText}'`);
			}

			ctx?.api?.log?.debug?.(`NotifyDebug: ctx.api.constants.kind=${JSON.stringify(ctx?.api?.constants?.kind)}`);
			ctx?.api?.log?.debug?.(
				`NotifyDebug: ctx.api.constants.level=${JSON.stringify(ctx?.api?.constants?.level)}`,
			);

			const raw = 'this is translated by ctx.api.i18n.t()';
			const translated = typeof ctx?.api?.i18n?.t === 'function' ? ctx.api.i18n.t(raw) : raw;
			ctx?.api?.log?.debug?.(`NotifyDebug: i18n='${translated}'`);

			const ids = ctx?.api?.iobroker?.ids;
			const idsDump =
				ids && typeof ids === 'object'
					? Object.entries(ids)
							.map(
								([key, value]) =>
									`${key}=${typeof value === 'function' ? '[Function]' : JSON.stringify(value)}`,
							)
							.join(' ')
					: '(missing)';
			ctx?.api?.log?.debug?.(`NotifyDebug: ctx.api.iobroker.ids=${idsDump}`);

			const baseFullId = options?.pluginBaseObjectId;
			const ownId = ids?.toOwnId?.(baseFullId);
			const fullId = ids?.toFullId?.(ownId);
			ctx?.api?.log?.debug?.(
				`NotifyDebug: pluginBaseObjectId(full)='${baseFullId}' ownId='${ownId}' fullId='${fullId}'`,
			);
		},
		stop(ctx) {
			if (!trace) {
				return;
			}
			ctx?.api?.log?.debug?.('NotifyDebug: stop');
		},
		onNotifications(event, notifications, ctx) {
			if (trace) {
				const count = Array.isArray(notifications) ? notifications.length : 0;
				ctx?.api?.log?.debug?.(`NotifyDebug: event='${event}' notifications=${count}`);
			}
		},
	};
}

module.exports = { NotifyDebug };
