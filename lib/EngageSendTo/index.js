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
const { ensureCtxAvailability } = require('../IoPluginGuards');

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
	if (!messagebox || typeof messagebox.register !== 'function' || typeof messagebox.unregister !== 'function') {
		throw new Error(
			'EngageSendTo: options.__messagebox.register/unregister are required (IoPlugins wiring required)',
		);
	}

	let log = null;
	let store = null;
	let factory = null;
	let action = null;

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
		log.debug(`EngageSendTo: ok (${summarize(data)})`);
		return { ok: true, data };
	};
	const err = (code, message, details = undefined) => {
		log.warn(
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

	async function onMessage(obj) {
		log.silly(`EngageSendTo: onMessage ${summarize(obj)})`);

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
			const msg = factory.createMessage(payload);
			if (!msg) {
				return err('VALIDATION_FAILED', 'create: invalid message payload');
			}
			const added = store.addMessage(msg);
			if (!added) {
				return err('CONFLICT', `create: message '${msg.ref}' could not be added`);
			}
			const created = store.getMessageByRef(msg.ref);
			return ok({ ref: msg.ref, message: toJsonSafe(created) });
		}

		if (command === 'patch') {
			if (!isObject(payload)) {
				return err('BAD_REQUEST', 'patch: payload must be an object');
			}
			const ref = getRef(payload);
			if (!ref) {
				return err('BAD_REQUEST', 'patch: ref is required');
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
			const exists = ref ? store.getMessageByRef(ref) != null : false;
			if (exists) {
				const okUpdate = store.updateMessage(ref, stripControlKeys(payload));
				if (!okUpdate) {
					return err('VALIDATION_FAILED', `upsert: message '${ref}' could not be updated`);
				}
				const updated = store.getMessageByRef(ref);
				return ok({ ref, message: toJsonSafe(updated) });
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
			return ok({ ref: msg.ref, message: toJsonSafe(created) });
		}

		if (command === 'remove') {
			const ref = getRef(payload);
			if (!ref) {
				return err('BAD_REQUEST', 'remove: ref is required');
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
			const msg = store.getMessageByRef(ref);
			if (!msg) {
				return err('NOT_FOUND', `get: message '${ref}' not found`);
			}
			return ok({ ref, message: toJsonSafe(msg) });
		}

		if (command === 'list') {
			const opts = isObject(payload) ? payload : {};

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
			const actor = typeof payload.actor === 'string' ? payload.actor.trim() : undefined;
			const actionPayload = payload.payload;
			const okAction = action.execute({ ref, actionId, actor, payload: actionPayload });
			if (!okAction) {
				return err('VALIDATION_FAILED', `action: '${actionId}' failed for '${ref}'`);
			}
			const updated = store.getMessageByRef(ref);
			return ok({ ref, message: toJsonSafe(updated) });
		}

		return err('UNKNOWN_COMMAND', `unknown command '${command}'`);
	}

	function start(ctx) {
		ensureCtxAvailability('EngageSendTo.start', ctx, {
			plainObject: [
				'api',
				'meta',
				'api.log',
				'api.store',
				'api.factory',
				'api.action',
				'meta.plugin',
				'meta.resources',
			],
			fn: [
				'api.log.debug',
				'api.log.warn',
				'api.log.silly',
				'api.store.queryMessages',
				'api.store.addMessage',
				'api.store.updateMessage',
				'api.store.getMessageByRef',
				'api.store.removeMessage',
				'api.factory.createMessage',
				'api.action.execute',
			],
		});

		log = ctx.api.log;
		store = ctx.api.store;
		factory = ctx.api.factory;
		action = ctx.api.action;
		messagebox?.register?.(onMessage);
	}

	function stop(_ctx) {
		messagebox?.unregister?.();
		log = null;
		store = null;
		factory = null;
		action = null;
	}

	function onNotifications(_event, _notifications, _ctx) {
		// Intentionally a no-op: EngageSendTo is a control-plane endpoint.
	}

	return Object.freeze({ start, stop, onNotifications, onMessage });
}

module.exports = { EngageSendTo, manifest };
