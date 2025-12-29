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
	 */
	constructor(adapter, msgConstants, msgStore) {
		if (!adapter) {
			throw new Error('MsgAction: adapter is required');
		}
		this.adapter = adapter;

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
	 * - `delete` -> lifecycle.state = "deleted" (soft), timing.notifyAt cleared
	 * - `snooze` -> lifecycle.state = "snoozed", timing.notifyAt = now + forMs
	 *
	 * @param {{ ref?: string, actionId?: string, actor?: string|null, payload?: Record<string, unknown>|null }} [options] Options (ref and actionId are required for execution).
	 * @returns {boolean} True when executed, false when rejected or patch failed.
	 */
	execute(options = {}) {
		const {
			ref,
			actionId,
			actor = undefined,
			payload = undefined,
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

			const type = action.type;
			const effectivePayload = payload !== undefined ? payload : action.payload;
			const buildLifecyclePatch = state => ({
				state,
				stateChangedAt: now,
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
					return true;
				}
				const ok = this._patchMessage(msgRef, {
					lifecycle: buildLifecyclePatch(this.msgConstants.lifecycle.state.deleted),
					timing: { notifyAt: null },
				});
				record({
					ok,
					type,
					payload: effectivePayload !== undefined ? effectivePayload : null,
					...(ok ? {} : { reason: 'patch_failed' }),
				});
				return ok;
			}

			if (type === this.msgConstants.actions.type.snooze) {
				const forMs = this._normalizeSnoozeForMs(effectivePayload);
				if (!Number.isFinite(forMs)) {
					record({
						ok: false,
						type,
						reason: 'invalid_payload',
						payload: effectivePayload !== undefined ? effectivePayload : null,
					});
					this.adapter?.log?.warn?.(`MsgAction.execute('${msgRef}'): snooze.forMs missing/invalid`);
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
					payload: effectivePayload !== undefined ? effectivePayload : null,
					forMs,
					notifyAt,
					...(ok ? {} : { reason: 'patch_failed' }),
				});
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
}

module.exports = { MsgAction };
