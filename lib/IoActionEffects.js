/**
 * IoActionEffects
 * ===============
 * Adapter-side action effects runner (IO layer).
 *
 * This module is intentionally best-effort and must never affect the core action flow.
 */

'use strict';

/**
 * Fire-and-forget hook that receives the raw action payload in parallel to core action execution.
 *
 * Today this is a no-op placeholder so IoPlugins can consistently tap the payload without coupling
 * any concrete side-effect implementation into the action execution path.
 *
 * @param {any} payload Raw payload passed to ctx.api.action.execute({ payload }).
 * @param {{ adapter?: import('@iobroker/adapter-core').AdapterInstance, ref?: string, actionId?: string, actor?: string|null }} [meta]
 *   Optional metadata for future dispatching/logging.
 * @returns {void}
 */
function handleActionPayload(payload, meta = {}) {
	// Explicitly async + best-effort: never throw, never block.
	Promise.resolve()
		.then(async () => {
			const adapter = meta?.adapter;
			if (!adapter) {
				return;
			}

			if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
				return;
			}

			const effects = payload.effects;
			if (!Array.isArray(effects) || effects.length === 0) {
				return;
			}

			for (const effect of effects) {
				if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
					adapter?.log?.warn?.('IoActionEffects: effect must be an object');
					continue;
				}

				const kind = typeof effect.kind === 'string' ? effect.kind.trim() : '';
				if (kind !== 'iobroker.state.set') {
					adapter?.log?.warn?.(`IoActionEffects: unsupported effect kind '${kind || '?'}'`);
					continue;
				}

				const id = typeof effect.id === 'string' ? effect.id.trim() : '';
				if (!id) {
					adapter?.log?.warn?.('IoActionEffects: effect.id is required');
					continue;
				}

				// Minimal guardrail: blacklist sensitive namespaces.
				// This is intentionally not exhaustive and is meant as a pragmatic safety belt.
				if (id === 'system' || id.startsWith('system.') || id === 'msghub' || id.startsWith('msghub.')) {
					adapter?.log?.warn?.(`IoActionEffects: blocked state write to '${id}' (blacklist)`);
					continue;
				}

				const ack = typeof effect.ack === 'boolean' ? effect.ack : true;
				const val = effect.val;

				try {
					if (typeof adapter?.setForeignStateAsync === 'function') {
						await adapter.setForeignStateAsync(id, { val, ack });
					} else if (typeof adapter?.setForeignState === 'function') {
						await new Promise((resolve, reject) => {
							adapter.setForeignState(id, { val, ack }, err => (err ? reject(err) : resolve(undefined)));
						});
					} else {
						adapter?.log?.warn?.('IoActionEffects: adapter.setForeignState is not available');
					}
				} catch (e) {
					adapter?.log?.warn?.(`IoActionEffects: setForeignState('${id}') failed (${e?.message || e})`);
				}
			}
		})
		.catch(e => {
			meta?.adapter?.log?.warn?.(`IoActionEffects: failed (${e?.message || e})`);
		});
}

/**
 * Convenience tap for ctx.api.action.execute wrappers.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance|undefined} adapter Adapter instance for logging.
 * @param {{ ref?: string, actionId?: string, actor?: string|null, payload?: any }|undefined|null} execOptions
 *   Raw options passed to ctx.api.action.execute(...).
 * @returns {void}
 */
function tapActionExecute(adapter, execOptions) {
	try {
		handleActionPayload(execOptions?.payload, {
			adapter,
			ref: execOptions?.ref,
			actionId: execOptions?.actionId,
			actor: execOptions?.actor ?? undefined,
		});
	} catch (e) {
		adapter?.log?.warn?.(`IoActionEffects.tapActionExecute: failed (${e?.message || e})`);
	}
}

module.exports = { handleActionPayload, tapActionExecute };
