/**
 * MsgEngage
 * ========
 * Wiring helper for interactive, bidirectional "Engage" integrations.
 *
 * Docs: ../docs/modules/MsgEngage.md
 *
 * Engage plugins are like bridges (ingest + notify), but they are allowed to execute MsgHub actions
 * (ack/close/delete/snooze) based on inbound user intent.
 *
 * Implementation model:
 * - Reuse MsgIngest + MsgNotify as the underlying channels (no new host layer).
 * - Register as two plugins via MsgBridge (ingest-first).
 * - Decorate the ctx passed to the handler functions with `ctx.api.action`.
 *
 * Important:
 * - The action API is intentionally NOT part of MsgNotify's default ctx.api surface.
 * - Engage plugins get action capability explicitly via this wiring helper.
 */

'use strict';

const { MsgBridge } = require('./MsgBridge');
const { buildActionApi } = require('./MsgHostApi');

/**
 * Engage wiring helper.
 *
 * Registers one handler object into MsgIngest + MsgNotify (via MsgBridge) and injects `ctx.api.action`
 * so Engage integrations can execute whitelisted message actions.
 */
class MsgEngage extends MsgBridge {
	/**
	 * Register an Engage handler as ingest+notify pair (via MsgBridge), but with action capability.
	 *
	 * @param {string} id Engage base id (stable identifier; e.g. `EngageTelegram:0`).
	 * @param {object} handler Engage handler (single object).
	 * @param {Function} [handler.start] Optional start hook (recommended for polling/webhooks).
	 * @param {Function} [handler.stop] Optional stop hook.
	 * @param {Function} [handler.onStateChange] Optional ingest handler for ioBroker stateChange events.
	 * @param {Function} [handler.onObjectChange] Optional ingest handler for ioBroker objectChange events.
	 * @param {Function} handler.onNotifications Required notify handler for MsgHub notification events.
	 * @param {object} deps Dependencies (hosts + action wiring).
	 * @param {{ registerPlugin: Function, unregisterPlugin: Function }} deps.msgIngest MsgIngest-like host.
	 * @param {{ registerPlugin: Function, unregisterPlugin: Function }} deps.msgNotify MsgNotify-like host.
	 * @param {import('@iobroker/adapter-core').AdapterInstance} deps.adapter Adapter instance (for MsgAction logging).
	 * @param {import('./MsgConstants').MsgConstants} deps.msgConstants Constants for MsgAction semantics.
	 * @param {import('./MsgStore').MsgStore} deps.store MsgStore instance (actions patch messages via store).
	 * @param {{ execute: Function }|null} [deps.action] Optional injected action API (used to wrap/override execution).
	 * @param {{ warn?: (msg: string) => void }} [deps.log] Optional logger for rollback/unregister warnings.
	 * @returns {{ ingestId: string, notifyId: string, unregister: () => void }} Registration handle.
	 */
	static registerEngage(id, handler, deps) {
		const safeDeps = deps && typeof deps === 'object' && !Array.isArray(deps) ? deps : {};
		const msgIngest = safeDeps.msgIngest;
		const msgNotify = safeDeps.msgNotify;
		const adapter = safeDeps.adapter;
		const msgConstants = safeDeps.msgConstants;
		const store = safeDeps.store;
		const action = safeDeps.action;
		const log = safeDeps.log;

		if (!adapter) {
			throw new Error('MsgEngage: adapter is required');
		}
		if (!msgConstants) {
			throw new Error('MsgEngage: msgConstants is required');
		}
		if (!store) {
			throw new Error('MsgEngage: store is required');
		}

		const hostName = this?.name || 'MsgEngage';
		const resolvedAction = action || buildActionApi(adapter, msgConstants, store, { hostName }) || null;
		if (!resolvedAction || typeof resolvedAction.execute !== 'function') {
			throw new Error('MsgEngage: failed to build ctx.api.action');
		}

		const decorateCtx = ctx => {
			if (!ctx || typeof ctx !== 'object') {
				return ctx;
			}
			const api = ctx.api && typeof ctx.api === 'object' ? ctx.api : {};
			if (api.action === resolvedAction) {
				return ctx;
			}
			const nextApi = Object.freeze({ ...api, action: resolvedAction });
			return Object.freeze({ ...ctx, api: nextApi });
		};

		const start = typeof handler?.start === 'function' ? handler.start.bind(handler) : null;
		const stop = typeof handler?.stop === 'function' ? handler.stop.bind(handler) : null;
		const onStateChange = typeof handler?.onStateChange === 'function' ? handler.onStateChange.bind(handler) : null;
		const onObjectChange =
			typeof handler?.onObjectChange === 'function' ? handler.onObjectChange.bind(handler) : null;
		const onNotifications = handler.onNotifications.bind(handler);

		const decoratedHandler = Object.freeze({
			...(start ? { start: ctx => start(decorateCtx(ctx)) } : {}),
			...(stop ? { stop: ctx => stop(decorateCtx(ctx)) } : {}),
			...(onStateChange ? { onStateChange: (id, state, ctx) => onStateChange(id, state, decorateCtx(ctx)) } : {}),
			...(onObjectChange ? { onObjectChange: (id, obj, ctx) => onObjectChange(id, obj, decorateCtx(ctx)) } : {}),
			onNotifications: (event, notifications, ctx) => onNotifications(event, notifications, decorateCtx(ctx)),
		});

		return super.registerBridge(id, decoratedHandler, { msgIngest, msgNotify, log });
	}
}

module.exports = { MsgEngage };
