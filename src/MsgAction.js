/**
 * MsgAction
 * ========
 * Core Action-Layer for executing message actions.
 *
 * Docs: ../docs/modules/MsgAction.md
 *
 * Purpose:
 * - Execute whitelisted actions that are explicitly present in `message.actions[]`.
 * - Translate actions into MsgStore mutations (patching `lifecycle` and `timing`).
 *
 * Non-goals (by design):
 * - No ioBroker wiring (no `sendTo`, no state objects). That belongs to adapter glue (`main.js`) or IO plugins.
 * - No user/ACL system: attribution is best-effort via `lifecycle.stateChangedBy`.
 */

'use strict';

/**
 * MsgAction
 * ========
 */
class MsgAction {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance for logging.
	 * @param {import('./MsgConstants').MsgConstants} msgConstants Constants (actions + lifecycle states).
	 * @param {import('./MsgStore').MsgStore} msgStore Store used to patch messages.
	 * @param {{ hostName?: string }} [options] Options.
	 */
	constructor(adapter, msgConstants, msgStore, { hostName = 'MsgAction' } = {}) {
		if (!adapter) {
			throw new Error('MsgAction: adapter is required');
		}
		this.adapter = adapter;
		this._hostName = typeof hostName === 'string' && hostName.trim() ? hostName.trim() : 'MsgAction';

		if (!msgConstants) {
			throw new Error('MsgAction: msgConstants is required');
		}
		this.msgConstants = msgConstants;

		if (!msgStore) {
			throw new Error('MsgAction: msgStore is required');
		}
		this.msgStore = msgStore;
	}

	/**
	 * Best-effort: broadcast an executed action to producer plugins via MsgIngest.
	 *
	 * This is intentionally fire-and-forget and must never affect action execution semantics.
	 *
	 * @param {{ ref: string, actionId: string, type: string, ts: number, actor?: string|null, payload?: any, message?: any|null }} actionInfo
	 *   Action info payload.
	 * @returns {void}
	 */
	_dispatchToIngest(actionInfo) {
		try {
			const msgIngest = this.msgStore?.msgIngest;
			if (!msgIngest || typeof msgIngest.dispatchAction !== 'function') {
				return;
			}
			const event = this.msgConstants?.action?.events?.executed || 'executed';
			msgIngest.dispatchAction(actionInfo, { event });
		} catch (e) {
			this.adapter?.log?.warn?.(`${this._hostName}: action dispatch failed (${e?.message || e})`);
		}
	}

	/**
	 * Determine whether an action is currently allowed for a given message.
	 *
	 * This is a pure policy helper that is used in two places:
	 * - Inbound: `execute()` uses it as an execution gate.
	 * - Outbound: view/notify code may use it to hide actions that would be rejected anyway.
	 *
	 * Notes:
	 * - This does not validate whether the action exists in `message.actions[]` (whitelisting);
	 *   callers are expected to resolve the stored action first.
	 *
	 * @param {object} msg Message object.
	 * @param {{ type?: string, id?: string }} action Action descriptor.
	 * @returns {boolean} True if the action is allowed in the current message state.
	 */
	isActionAllowed(msg, action) {
		if (!this.msgConstants || !msg || typeof msg !== 'object' || !action || typeof action !== 'object') {
			return false;
		}

		const lifecycle = this.msgConstants.lifecycle || {};
		const stateFallback = lifecycle?.state?.open || 'open';
		const stateRaw = msg?.lifecycle?.state;
		const state = typeof stateRaw === 'string' && stateRaw.trim() ? stateRaw.trim() : stateFallback;

		const isQuasiDeletedState = lifecycle.isQuasiDeletedState;
		if (typeof isQuasiDeletedState === 'function' && isQuasiDeletedState(state)) {
			return false;
		}

		const type = typeof action.type === 'string' ? action.type.trim() : '';
		if (!type) {
			return false;
		}

		// Semantics:
		// - ack    -> "mark as seen / stop nagging" (clears notifyAt)
		// - snooze -> postpone remind/notify (updates notifyAt)
		//
		// Action matrix (core policy, lifecycle-sensitive):
		//
		// - open:    ack/close/delete/snooze allowed
		// - acked:   close/delete allowed; ack + snooze blocked
		// - snoozed: ack/close/delete allowed; snooze blocked
		// - quasiDeleted (closed/deleted/expired): nothing allowed
		//
		// Rationale:
		// - `ack` means "don't remind me anymore", therefore snooze is incompatible afterwards.
		// - "First come, first serve": once snoozed, we don't offer/accept snooze again.
		// - Rejected actions should be hidden from UI/notifiers (view filtering) and rejected on execution (inbound gate).

		// Once a message is acked, "ack again" no longer makes sense and is blocked.
		if (type === this.msgConstants?.actions?.type?.ack) {
			if (state === lifecycle?.state?.acked) {
				return false;
			}
		}

		// Once a message is acked, snooze no longer makes sense and is blocked.
		if (type === this.msgConstants?.actions?.type?.snooze) {
			if (state === lifecycle?.state?.acked) {
				return false;
			}
			// "First come, first serve": once snoozed, do not offer/accept snooze again.
			if (state === lifecycle?.state?.snoozed) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Build a view-only message object with an "effective actions" list.
	 *
	 * Output contract:
	 * - `actions` contains only currently allowed actions.
	 * - `actionsInactive` (optional) contains remaining valid actions that are currently blocked.
	 *
	 * Important:
	 * - This does not mutate the input message.
	 * - Invalid actions (missing type/id) are dropped from both lists.
	 *
	 * @param {object} msg Message object (raw or rendered).
	 * @returns {object} View-only clone when changes are needed, else original `msg`.
	 */
	buildActions(msg) {
		if (!msg || typeof msg !== 'object') {
			return msg;
		}

		const input = Array.isArray(msg.actions) ? msg.actions : [];
		if (input.length === 0) {
			return msg;
		}

		const active = [];
		const inactive = [];
		let hadInvalid = false;

		for (const action of input) {
			if (!action || typeof action !== 'object') {
				hadInvalid = true;
				continue;
			}
			const type = typeof action.type === 'string' ? action.type.trim() : '';
			const id = typeof action.id === 'string' ? action.id.trim() : '';
			if (!type || !id) {
				hadInvalid = true;
				continue;
			}

			const allow = this.isActionAllowed(msg, action);
			(allow ? active : inactive).push(action);
		}

		// Fast-path: keep identity stable when no filtering occurred.
		if (!hadInvalid && inactive.length === 0 && active.length === input.length) {
			return msg;
		}

		const out = { ...msg, actions: active };
		if (inactive.length > 0) {
			out.actionsInactive = inactive;
		} else if (Object.prototype.hasOwnProperty.call(out, 'actionsInactive')) {
			delete out.actionsInactive;
		}
		return out;
	}

	/**
	 * Best-effort action audit hook (append to MsgArchive when available).
	 *
	 * @param {string} ref Message ref.
	 * @param {Record<string, unknown>} payload Audit payload to append.
	 * @returns {void}
	 */
	_recordAction(ref, payload) {
		try {
			this.msgStore?.msgArchive?.appendAction?.(ref, payload);
		} catch {
			// best-effort only (must never break action execution)
		}
	}

	/**
	 * Normalize the optional `actor` attribution used for lifecycle state changes.
	 *
	 * @param {unknown} actor Actor value (string or null).
	 * @returns {string|null} Trimmed string, or null.
	 */
	_normalizeActor(actor) {
		if (actor === null) {
			return null;
		}
		if (typeof actor === 'string') {
			const trimmed = actor.trim();
			return trimmed ? trimmed : null;
		}
		return null;
	}

	/**
	 * Execute one action by id for a given message ref.
	 *
	 * Contract:
	 * - `actionId` is required and must match an entry in `message.actions[]` (capability/whitelist).
	 * - The action `type` is inferred from the stored action; callers do not pass a type.
	 * - Returns a single success flag (`true/false`) and never throws (best-effort).
	 *   Note: some action types are legitimate but intentionally no-ops in core (`open/link/custom`).
	 *
	 * Supported types in core:
	 * - `ack`    -> lifecycle.state = "acked", timing.notifyAt cleared
	 * - `close`  -> lifecycle.state = "closed", timing.notifyAt cleared
	 * - `delete` -> soft delete via `MsgStore.removeMessage()` (lifecycle.state="deleted", timing.notifyAt cleared)
	 * - `snooze` -> lifecycle.state = "snoozed", timing.notifyAt = now + forMs
	 *
	 * @param {{ ref?: string, actionId?: string, actor?: string|null, payload?: Record<string, unknown>|null, snoozeForMs?: number }} [options] Options (ref and actionId are required for execution).
	 * @returns {boolean} True when executed, false when rejected or patch failed.
	 */
	execute(options = {}) {
		const {
			ref,
			actionId,
			actor = undefined,
			payload = undefined,
			snoozeForMs = undefined,
		} = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
		try {
			const msgRef = typeof ref === 'string' ? ref.trim() : '';
			const id = typeof actionId === 'string' ? actionId.trim() : '';
			const actorProvided = actor !== undefined;
			const normalizedActor = this._normalizeActor(actor);
			const now = Date.now();
			const auditBase = {
				ts: now,
				actionId: id,
				actor: normalizedActor,
			};
			const record = data => this._recordAction(msgRef, { ...auditBase, ...(data || {}) });

			if (!msgRef) {
				this.adapter?.log?.warn?.('MsgAction.execute: ref is required');
				return false;
			}
			if (!id) {
				this.adapter?.log?.warn?.(`MsgAction.execute('${msgRef}'): actionId is required`);
				return false;
			}

			const message = this.msgStore?.getMessageByRef?.(msgRef);
			if (!message) {
				record({
					ok: false,
					reason: 'message_not_found',
					type: null,
					payload: payload !== undefined ? payload : null,
				});
				this.adapter?.log?.warn?.(`MsgAction.execute('${msgRef}'): message not found`);
				return false;
			}

			const actions = Array.isArray(message.actions) ? message.actions : [];
			const action = actions.find(a => a && typeof a === 'object' && a.id === id);

			if (!action) {
				record({
					ok: false,
					reason: 'not_allowed',
					type: null,
					payload: payload !== undefined ? payload : null,
				});
				this.adapter?.log?.warn?.(`MsgAction.execute('${msgRef}'): actionId '${id}' not allowed/not found`);
				return false;
			}

			if (!this.isActionAllowed(message, action)) {
				record({
					ok: false,
					reason: 'blocked_by_policy',
					type: action?.type || null,
					payload: payload !== undefined ? payload : null,
				});
				this.adapter?.log?.warn?.(
					`MsgAction.execute('${msgRef}'): actionId '${id}' blocked by policy (state='${String(
						message?.lifecycle?.state || '',
					)}')`,
				);
				return false;
			}

			const type = action.type;
			const effectivePayload = payload !== undefined ? payload : action.payload;
			const emitExecuted = () => {
				const message = this.msgStore?.getMessageByRef?.(msgRef, 'all') || null;
				this._dispatchToIngest({
					ref: msgRef,
					actionId: id,
					type,
					ts: now,
					...(actorProvided ? { actor: normalizedActor } : {}),
					payload: effectivePayload !== undefined ? effectivePayload : null,
					message,
				});
			};
			const buildLifecyclePatch = state => ({
				state,
				...(actorProvided ? { stateChangedBy: normalizedActor } : {}),
			});

			const currentState = message?.lifecycle?.state || this.msgConstants.lifecycle.state.open;
			const hasNotifyAt = Number.isFinite(message?.timing?.notifyAt);

			if (type === this.msgConstants.actions.type.ack) {
				if (currentState === this.msgConstants.lifecycle.state.acked && !hasNotifyAt) {
					record({
						ok: true,
						type,
						noop: true,
						payload: effectivePayload !== undefined ? effectivePayload : null,
					});
					emitExecuted();
					return true;
				}
				const ok = this._patchMessage(msgRef, {
					lifecycle: buildLifecyclePatch(this.msgConstants.lifecycle.state.acked),
					timing: { notifyAt: null },
				});
				record({
					ok,
					type,
					payload: effectivePayload !== undefined ? effectivePayload : null,
					...(ok ? {} : { reason: 'patch_failed' }),
				});
				if (ok) {
					emitExecuted();
				}
				return ok;
			}

			if (type === this.msgConstants.actions.type.close) {
				if (currentState === this.msgConstants.lifecycle.state.closed && !hasNotifyAt) {
					record({
						ok: true,
						type,
						noop: true,
						payload: effectivePayload !== undefined ? effectivePayload : null,
					});
					emitExecuted();
					return true;
				}
				const ok = this._patchMessage(msgRef, {
					lifecycle: buildLifecyclePatch(this.msgConstants.lifecycle.state.closed),
					timing: { notifyAt: null },
				});
				record({
					ok,
					type,
					payload: effectivePayload !== undefined ? effectivePayload : null,
					...(ok ? {} : { reason: 'patch_failed' }),
				});
				if (ok) {
					emitExecuted();
				}
				return ok;
			}

			if (type === this.msgConstants.actions.type.delete) {
				if (currentState === this.msgConstants.lifecycle.state.deleted && !hasNotifyAt) {
					record({
						ok: true,
						type,
						noop: true,
						payload: effectivePayload !== undefined ? effectivePayload : null,
					});
					emitExecuted();
					return true;
				}
				const ok = this.msgStore?.removeMessage?.(
					msgRef,
					actorProvided ? { actor: normalizedActor } : undefined,
				);
				record({
					ok,
					type,
					payload: effectivePayload !== undefined ? effectivePayload : null,
					...(ok ? {} : { reason: 'patch_failed' }),
				});
				if (ok) {
					emitExecuted();
				}
				return ok;
			}

			if (type === this.msgConstants.actions.type.snooze) {
				const snoozeOverrideProvided = snoozeForMs !== undefined;
				const overrideForMs = snoozeOverrideProvided ? this._normalizeSnoozeForMsValue(snoozeForMs) : NaN;

				const forMs = snoozeOverrideProvided ? overrideForMs : this._normalizeSnoozeForMs(effectivePayload);
				const payloadForAudit = snoozeOverrideProvided
					? Object.freeze({
							...(effectivePayload &&
							typeof effectivePayload === 'object' &&
							!Array.isArray(effectivePayload)
								? effectivePayload
								: {}),
							forMs,
						})
					: effectivePayload;

				if (!Number.isFinite(forMs)) {
					record({
						ok: false,
						type,
						reason: 'invalid_payload',
						payload: payloadForAudit !== undefined ? payloadForAudit : null,
					});
					this.adapter?.log?.warn?.(
						`MsgAction.execute('${msgRef}'): snooze.forMs missing/invalid${snoozeOverrideProvided ? ' (snoozeForMs override)' : ''}`,
					);
					return false;
				}
				const notifyAt = now + forMs;
				const ok = this._patchMessage(msgRef, {
					lifecycle: buildLifecyclePatch(this.msgConstants.lifecycle.state.snoozed),
					timing: { notifyAt },
				});
				record({
					ok,
					type,
					payload: payloadForAudit !== undefined ? payloadForAudit : null,
					forMs,
					notifyAt,
					...(ok ? {} : { reason: 'patch_failed' }),
				});
				if (ok) {
					emitExecuted();
				}
				return ok;
			}

			// Legitimate action types that are intentionally not executed by the core action layer.
			// They may still carry payloads for IO-side dispatchers and should not be treated as errors.
			const nonCoreTypes = new Set([
				this.msgConstants.actions.type.open,
				this.msgConstants.actions.type.link,
				this.msgConstants.actions.type.custom,
			]);
			if (nonCoreTypes.has(type)) {
				record({
					ok: true,
					type,
					noop: true,
					reason: 'non_core',
					payload: effectivePayload !== undefined ? effectivePayload : null,
				});
				this.adapter?.log?.debug?.(
					`MsgAction.execute('${msgRef}'): non-core action.type '${type}' (noop in core)`,
				);
				emitExecuted();
				return true;
			}

			record({
				ok: false,
				type,
				reason: 'unsupported_type',
				payload: effectivePayload !== undefined ? effectivePayload : null,
			});
			this.adapter?.log?.warn?.(`MsgAction.execute('${msgRef}'): unsupported action.type '${type}'`);
			return false;
		} catch (e) {
			this.adapter?.log?.warn?.(`MsgAction.execute: failed (${e?.message || e})`);
			return false;
		}
	}

	/**
	 * Apply a store patch and return a boolean success flag.
	 *
	 * @param {string} ref Message ref.
	 * @param {object} patch Store patch.
	 * @returns {boolean} True when the patch was applied.
	 */
	_patchMessage(ref, patch) {
		const ok = this.msgStore?.updateMessage?.(ref, patch);
		if (!ok) {
			this.adapter?.log?.warn?.(`MsgAction: patch failed for '${ref}'`);
		}
		return Boolean(ok);
	}

	/**
	 * Read and validate a snooze duration payload.
	 *
	 * Expected input: `{ forMs: number }` with `forMs > 0`.
	 *
	 * @param {unknown} payload Action payload.
	 * @returns {number} Duration in ms, or `NaN` when invalid.
	 */
	_normalizeSnoozeForMs(payload) {
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
			return NaN;
		}
		const v = Reflect.get(payload, 'forMs');
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			return NaN;
		}
		const ms = Math.trunc(v);
		return ms > 0 ? ms : NaN;
	}

	/**
	 * Normalize a snooze duration from a raw numeric value.
	 *
	 * @param {unknown} value Raw input value.
	 * @returns {number} Duration in ms, or `NaN` when invalid.
	 */
	_normalizeSnoozeForMsValue(value) {
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			return NaN;
		}
		const ms = Math.trunc(value);
		return ms > 0 ? ms : NaN;
	}
}

module.exports = { MsgAction };
