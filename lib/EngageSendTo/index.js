/**
 * EngageSendTo
 * ============
 * Adapter-side control-plane for MsgHub via ioBroker messagebox (`sendTo`).
 *
 * Docs: ../../docs/plugins/EngageSendTo.md
 *
 * Key points
 * - Implemented as an Engage plugin (wired via `MsgEngage`), therefore it has access to `ctx.api.action`.
 * - Owns exactly one direct messagebox handler (escape hatch) via `options.__messagebox.register/unregister`.
 * - Implements a command API: create/patch(upate)/upsert/remove/get/list/action.
 */

'use strict';

const { serializeWithMaps } = require(`${__dirname}/../../src/MsgUtils`);
const { manifest } = require('./manifest');

/**
 * Engage plugin factory for MsgHub's `sendTo` control plane.
 *
 * Options are provided by `IoPlugins` from the plugin's ioBroker object `native`, plus injected runtime helpers.
 *
 * @param {object} [options] Plugin options.
 * @param {string} [options.pluginBaseObjectId] Full ioBroker id of this plugin instance base object.
 * @param {{ register?: Function, unregister?: Function }} [options.__messagebox] Internal messagebox helper (injected by `IoPlugins`).
 * @returns {{ start: Function, stop: Function, onNotifications: Function, onMessage: Function }} Engage handler.
 */
function EngageSendTo(options = {}) {
	const messagebox = options?.__messagebox || null;
	let ctxRef = null;

	const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
	const toJsonSafe = value => JSON.parse(serializeWithMaps(value));

	const summarize = value => {
		if (value === null) {
			return 'null';
		}
		if (value === undefined) {
			return 'undefined';
		}
		if (typeof value !== 'object') {
			return typeof value;
		}
		if (Array.isArray(value)) {
			return `array(len=${value.length})`;
		}
		const keys = Object.keys(value);
		const ref = typeof value.ref === 'string' && value.ref.trim() ? value.ref.trim() : '';
		return ref ? `ref=${ref} keys=${keys.join(',')}` : `keys=${keys.join(',')}`;
	};

	const ok = data => {
		ctxRef?.api?.log?.debug?.(`EngageSendTo: ok (${summarize(data)})`);
		return { ok: true, data };
	};
	const err = (code, message, details = undefined) => {
		ctxRef?.api?.log?.warn?.(
			`EngageSendTo: err ${String(code)}: ${String(message)}${
				details !== undefined ? ` (${summarize(details)})` : ''
			}`,
		);
		return {
			ok: false,
			error: {
				code,
				message,
				...(details !== undefined ? { details } : {}),
			},
		};
	};

	const getRef = payload => {
		if (typeof payload === 'string' && payload.trim()) {
			return payload.trim();
		}
		if (isObject(payload) && typeof payload.ref === 'string' && payload.ref.trim()) {
			return payload.ref.trim();
		}
		return '';
	};

	const stripControlKeys = obj => {
		if (!isObject(obj)) {
			return obj;
		}
		const out = { ...obj };
		delete out.command;
		delete out.callback;
		delete out.from;
		delete out.message;
		delete out.silent;
		delete out.patch;
		delete out.actor;
		delete out.source;
		return out;
	};

	const requireApi = () => {
		const api = ctxRef?.api;
		return api && typeof api === 'object' ? api : null;
	};

	async function onMessage(obj) {
		const api = requireApi();
		if (!api) {
			return err('NOT_READY', 'EngageSendTo not started');
		}

		ctxRef?.api?.log?.silly?.(`EngageSendTo: onMessage ${summarize(obj)})`);

		const factory = api.factory;
		const store = api.store;
		const action = api.action;

		const cmd = typeof obj?.command === 'string' ? obj.command.trim() : '';
		if (!cmd) {
			return err('BAD_REQUEST', 'command is required');
		}

		const payload = obj?.message;
		const command = cmd;

		if (command === 'create') {
			if (!isObject(payload)) {
				return err('BAD_REQUEST', 'create: payload must be an object');
			}
			if (!factory || typeof factory.createMessage !== 'function') {
				return err('NOT_READY', 'create: ctx.api.factory.createMessage is not available');
			}
			if (!store || typeof store.addMessage !== 'function') {
				return err('NOT_READY', 'create: ctx.api.store.addMessage is not available');
			}
			const msg = factory.createMessage(payload);
			if (!msg) {
				return err('VALIDATION_FAILED', 'create: invalid message payload');
			}
			const added = store.addMessage(msg);
			if (!added) {
				return err('CONFLICT', `create: message '${msg.ref}' could not be added`);
			}
			const created = typeof store.getMessageByRef === 'function' ? store.getMessageByRef(msg.ref) : null;
			return ok({ ref: msg.ref, message: toJsonSafe(created || msg) });
		}

		if (command === 'patch') {
			if (!isObject(payload)) {
				return err('BAD_REQUEST', 'patch: payload must be an object');
			}
			const ref = getRef(payload);
			if (!ref) {
				return err('BAD_REQUEST', 'patch: ref is required');
			}
			if (!store || typeof store.getMessageByRef !== 'function') {
				return err('NOT_READY', 'patch: ctx.api.store.getMessageByRef is not available');
			}
			if (typeof store.updateMessage !== 'function') {
				return err('NOT_READY', 'patch: ctx.api.store.updateMessage is not available');
			}
			const existing = store.getMessageByRef(ref);
			if (!existing) {
				return err('NOT_FOUND', `patch: message '${ref}' not found`);
			}

			const patch = isObject(payload.patch) ? payload.patch : stripControlKeys(payload);
			const okUpdate = store.updateMessage(ref, patch);
			if (!okUpdate) {
				return err('VALIDATION_FAILED', `patch: message '${ref}' could not be updated`);
			}

			const updated = store.getMessageByRef(ref);
			return ok({ ref, message: toJsonSafe(updated) });
		}

		if (command === 'upsert') {
			if (!isObject(payload)) {
				return err('BAD_REQUEST', 'upsert: payload must be an object');
			}

			const ref = getRef(payload);
			if (!store || typeof store.getMessageByRef !== 'function') {
				return err('NOT_READY', 'upsert: ctx.api.store.getMessageByRef is not available');
			}
			const exists = ref ? store.getMessageByRef(ref) != null : false;
			if (exists) {
				if (typeof store.updateMessage !== 'function') {
					return err('NOT_READY', 'upsert: ctx.api.store.updateMessage is not available');
				}
				const okUpdate = store.updateMessage(ref, stripControlKeys(payload), false);
				if (!okUpdate) {
					return err('VALIDATION_FAILED', `upsert: message '${ref}' could not be updated`);
				}
				const updated = store.getMessageByRef(ref);
				return ok({ ref, message: toJsonSafe(updated) });
			}

			if (!factory || typeof factory.createMessage !== 'function') {
				return err('NOT_READY', 'upsert: ctx.api.factory.createMessage is not available');
			}
			if (typeof store.addMessage !== 'function') {
				return err('NOT_READY', 'upsert: ctx.api.store.addMessage is not available');
			}
			const msg = factory.createMessage(payload);
			if (!msg) {
				return err('VALIDATION_FAILED', 'upsert: invalid message payload');
			}
			const added = store.addMessage(msg);
			if (!added) {
				return err('CONFLICT', `upsert: message '${msg.ref}' could not be added`);
			}
			const created = store.getMessageByRef(msg.ref);
			return ok({ ref: msg.ref, message: toJsonSafe(created || msg) });
		}

		if (command === 'remove') {
			const ref = getRef(payload);
			if (!ref) {
				return err('BAD_REQUEST', 'remove: ref is required');
			}
			if (!store || typeof store.getMessageByRef !== 'function') {
				return err('NOT_READY', 'remove: ctx.api.store.getMessageByRef is not available');
			}
			if (typeof store.removeMessage !== 'function') {
				return err('NOT_READY', 'remove: ctx.api.store.removeMessage is not available');
			}
			const existing = store.getMessageByRef(ref);
			if (!existing) {
				return ok({ ref, removed: false });
			}
			store.removeMessage(ref);
			const removed = store.getMessageByRef(ref);
			return ok({ ref, removed: true, message: removed ? toJsonSafe(removed) : null });
		}

		if (command === 'get') {
			const ref = getRef(payload);
			if (!ref) {
				return err('BAD_REQUEST', 'get: ref is required');
			}
			if (!store || typeof store.getMessageByRef !== 'function') {
				return err('NOT_READY', 'get: ctx.api.store.getMessageByRef is not available');
			}
			const msg = store.getMessageByRef(ref);
			if (!msg) {
				return err('NOT_FOUND', `get: message '${ref}' not found`);
			}
			return ok({ ref, message: toJsonSafe(msg) });
		}

		if (command === 'list') {
			const opts = isObject(payload) ? payload : {};

			if (!store) {
				return err('NOT_READY', 'list: ctx.api.store is not available');
			}

			if (typeof store.queryMessages === 'function') {
				const where = isObject(opts.where) ? { ...opts.where } : {};
				const page = isObject(opts.page) ? { ...opts.page } : undefined;
				const sort = Array.isArray(opts.sort) ? opts.sort : undefined;

				try {
					const result = store.queryMessages({ where, page, sort });
					return ok(toJsonSafe(result));
				} catch (e) {
					return err('BAD_REQUEST', `list: invalid query (${e?.message || e})`);
				}
			}

			if (typeof store.getMessages !== 'function') {
				return err('NOT_READY', 'list: ctx.api.store.getMessages is not available');
			}
			const list = store.getMessages();
			return ok({ items: toJsonSafe(list) });
		}

		if (command === 'action') {
			if (!isObject(payload)) {
				return err('BAD_REQUEST', 'action: payload must be an object');
			}
			const ref = getRef(payload);
			if (!ref) {
				return err('BAD_REQUEST', 'action: ref is required');
			}
			const actionId = typeof payload.actionId === 'string' ? payload.actionId.trim() : '';
			if (!actionId) {
				return err('BAD_REQUEST', 'action: actionId is required');
			}
			if (!action || typeof action.execute !== 'function') {
				return err('NOT_READY', 'action: ctx.api.action.execute is not available');
			}
			const actor = typeof payload.actor === 'string' ? payload.actor.trim() : undefined;
			const actionPayload = payload.payload;
			const okAction = action.execute({ ref, actionId, actor, payload: actionPayload });
			if (!okAction) {
				return err('VALIDATION_FAILED', `action: '${actionId}' failed for '${ref}'`);
			}
			const updated = store && typeof store.getMessageByRef === 'function' ? store.getMessageByRef(ref) : null;
			return ok({ ref, message: updated ? toJsonSafe(updated) : null });
		}

		return err('UNKNOWN_COMMAND', `unknown command '${command}'`);
	}

	function start(ctx) {
		ctxRef = ctx;
		try {
			messagebox?.register?.(onMessage);
		} catch (e) {
			ctx?.api?.log?.warn?.(`EngageSendTo: messagebox.register failed: ${e?.message || e}`);
		}
	}

	function stop(ctx) {
		try {
			messagebox?.unregister?.();
		} catch (e) {
			ctx?.api?.log?.warn?.(`EngageSendTo: messagebox.unregister failed: ${e?.message || e}`);
		} finally {
			ctxRef = null;
		}
	}

	function onNotifications(_event, _notifications, _ctx) {
		// Intentionally a no-op: EngageSendTo is a control-plane endpoint.
	}

	return Object.freeze({ start, stop, onNotifications, onMessage });
}

module.exports = { EngageSendTo, manifest };
