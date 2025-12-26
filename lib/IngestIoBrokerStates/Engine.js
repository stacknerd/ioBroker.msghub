'use strict';

/**
 * ioBroker-states ingest engine.
 *
 * Infrastructure only:
 * - Periodic polling of `system/custom` view to discover newly configured customs.
 * - Subscribe to objects that have `common.custom[adapter.namespace]` to observe changes.
 * - Subscribe to required state IDs (targets + dependencies) for routing.
 * - Log when customs change (and when removed).
 */
class IngestIoBrokerStatesEngine {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance.
	 * @param {object} [options] Engine options.
	 * @param {string} [options.pluginBaseObjectId] Full id of the plugin base object (for log prefixing).
	 * @param {number} [options.rescanIntervalMs] Poll interval in ms (default: 180000, 0 = off).
	 * @param {boolean} [options.traceEvents] Verbose per-event debug logs (default: false).
	 */
	constructor(adapter, options = {}) {
		this.adapter = adapter;
		this.options = options || {};
		this._logPrefix =
			typeof this.options?.pluginBaseObjectId === 'string' && this.options.pluginBaseObjectId.trim()
				? `${this.options.pluginBaseObjectId.trim()}: `
				: '';

		const { IngestIoBrokerStatesRegistry } = require('./Registry');
		this.registry = new IngestIoBrokerStatesRegistry();

		this._subscribedStateIds = new Set();
		this._lastCustomByObjectId = new Map(); // objectId -> normalized JSON (string|null)

		const { createOpQueue } = require('../../src/MsgUtils');
		this._queue = createOpQueue();

		this._running = false;
		this._timer = null;
	}

	/** @returns {void} */
	start() {
		if (this._running) {
			return;
		}
		this._running = true;

		this._queue(() => this._rescan('start'))
			.then(() => {
				this.adapter?.log?.info?.(
					`${this._logPrefix}IngestIoBrokerStates: started targets=${this.registry.rulesByTargetId.size}, requiredStates=${this._subscribedStateIds.size}, watchedObjects=${this.registry.watchedObjectIds.size}`,
				);
			})
			.catch(e => {
				this.adapter?.log?.warn?.(
					`${this._logPrefix}IngestIoBrokerStates: initial scan failed: ${e?.message || e}`,
				);
			});

		const intervalMs = Number(this.options?.rescanIntervalMs);
		if (Number.isFinite(intervalMs) && intervalMs > 0) {
			this._timer = setInterval(() => {
				void this._queue(() => this._rescan('poll')).catch(() => undefined);
			}, intervalMs);
		}
	}

	/** @returns {void} */
	stop() {
		if (!this._running) {
			return;
		}
		this._running = false;

		if (this._timer) {
			clearInterval(this._timer);
			this._timer = null;
		}

		try {
			this._unsubscribeObjects(Array.from(this.registry.watchedObjectIds));
			this._unsubscribeStates(Array.from(this._subscribedStateIds));
		} finally {
			this.registry.clear();
			this._subscribedStateIds.clear();
			this._lastCustomByObjectId.clear();
		}
	}

	/**
	 * @param {string} id State id (full id).
	 * @param {ioBroker.State | null | undefined} _state State value (currently unused; rule evaluation is WIP).
	 * @param {object} [_ctx] Dispatch context (currently unused).
	 * @returns {void}
	 */
	onStateChange(id, _state, _ctx) {
		const targets = this.registry.targetsByStateId.get(id);
		if (!targets || targets.size === 0) {
			return;
		}
		if (this.options?.traceEvents) {
			this.adapter?.log?.debug?.(
				`${this._logPrefix}IngestIoBrokerStates: stateChange('${id}') routes to ${targets.size} target(s): ${Array.from(targets).join(', ')}`,
			);
		}
		// Rule evaluation comes later.
	}

	/**
	 * @param {string} id Object id (full id).
	 * @param {ioBroker.Object | null | undefined} obj Object payload (including `common.custom`).
	 * @param {object} [_ctx] Dispatch context (currently unused).
	 * @returns {void}
	 */
	onObjectChange(id, obj, _ctx) {
		const nsKey = this.adapter.namespace;
		const raw = obj?.common?.custom?.[nsKey] || null;

		const { normalizeRuleCfg } = require('./normalizeConfig');
		const next = raw ? JSON.stringify(normalizeRuleCfg(raw)) : null;
		const prev = this._lastCustomByObjectId.get(id) ?? null;

		if (prev === next) {
			return;
		}

		if (next === null) {
			this._lastCustomByObjectId.delete(id);
			this.adapter?.log?.info?.(`${this._logPrefix}IngestIoBrokerStates: custom removed on '${id}'`);
			return;
		}

		this._lastCustomByObjectId.set(id, next);
		this.adapter?.log?.info?.(
			`${this._logPrefix}IngestIoBrokerStates: custom changed on '${id}' (enabled=${raw?.enabled === true})`,
		);
		if (this.options?.traceEvents) {
			this.adapter?.log?.debug?.(`${this._logPrefix}IngestIoBrokerStates: custom now on '${id}': ${next}`);
		}
	}

	/**
	 * Return a small operational snapshot for debugging/telemetry.
	 *
	 * @returns {{ targets: number, requiredStates: number, watchedObjects: number }} Current sizes.
	 */
	getRegistrySnapshot() {
		return {
			targets: this.registry.rulesByTargetId.size,
			requiredStates: this._subscribedStateIds.size,
			watchedObjects: this.registry.watchedObjectIds.size,
		};
	}

	/**
	 * Subscribe to a list of foreign state ids (best-effort).
	 *
	 * @param {string[]} ids Full state ids to subscribe to.
	 * @returns {void}
	 */
	_subscribeStates(ids) {
		for (const id of ids) {
			try {
				this.adapter.subscribeForeignStates(id);
			} catch (e) {
				this.adapter?.log?.warn?.(
					`${this._logPrefix}IngestIoBrokerStates: subscribeForeignStates('${id}') failed: ${e?.message || e}`,
				);
			}
		}
	}

	/**
	 * Unsubscribe from a list of foreign state ids (best-effort).
	 *
	 * @param {string[]} ids Full state ids to unsubscribe from.
	 * @returns {void}
	 */
	_unsubscribeStates(ids) {
		for (const id of ids) {
			try {
				this.adapter.unsubscribeForeignStates(id);
			} catch (e) {
				this.adapter?.log?.warn?.(
					`${this._logPrefix}IngestIoBrokerStates: unsubscribeForeignStates('${id}') failed: ${e?.message || e}`,
				);
			}
		}
	}

	/**
	 * Subscribe to a list of foreign object ids (best-effort).
	 *
	 * @param {string[]} ids Full object ids to subscribe to.
	 * @returns {void}
	 */
	_subscribeObjects(ids) {
		for (const id of ids) {
			try {
				this.adapter.subscribeForeignObjects(id);
			} catch (e) {
				this.adapter?.log?.warn?.(
					`${this._logPrefix}IngestIoBrokerStates: subscribeForeignObjects('${id}') failed: ${e?.message || e}`,
				);
			}
		}
	}

	/**
	 * Unsubscribe from a list of foreign object ids (best-effort).
	 *
	 * @param {string[]} ids Full object ids to unsubscribe from.
	 * @returns {void}
	 */
	_unsubscribeObjects(ids) {
		for (const id of ids) {
			try {
				this.adapter.unsubscribeForeignObjects(id);
			} catch (e) {
				this.adapter?.log?.warn?.(
					`${this._logPrefix}IngestIoBrokerStates: unsubscribeForeignObjects('${id}') failed: ${e?.message || e}`,
				);
			}
		}
	}

	/**
	 * Compute a Set diff (added/removed).
	 *
	 * @param {Set<string>} prev Previous set.
	 * @param {Set<string>} next Next set.
	 * @returns {{ added: string[], removed: string[] }} Diff result.
	 */
	_setDiff(prev, next) {
		const added = [];
		const removed = [];
		for (const id of next) {
			if (!prev.has(id)) {
				added.push(id);
			}
		}
		for (const id of prev) {
			if (!next.has(id)) {
				removed.push(id);
			}
		}
		return { added, removed };
	}

	/**
	 * Rebuild registry + subscriptions by scanning `system/custom`.
	 *
	 * @param {string} reason Scan reason (e.g. "start", "poll").
	 * @returns {Promise<void>}
	 */
	async _rescan(reason) {
		if (!this._running) {
			return;
		}

		const nsKey = this.adapter.namespace;
		const res = await this.adapter.getObjectViewAsync('system', 'custom', {});

		const { normalizeRuleCfg } = require('./normalizeConfig');
		const { isOwnObjectId } = require('./ownObjectGuard');

		const nextWatched = new Set();
		const nextRequiredStateIds = new Set();

		this.registry.rulesByTargetId.clear();
		this.registry.requiredStateIdsByTargetId.clear();
		this.registry.targetsByStateId.clear();

		for (const row of res?.rows || []) {
			const targetId = row?.id;

			if (isOwnObjectId(nsKey, targetId)) {
				this.adapter?.log?.error?.(
					`${this._logPrefix}IngestIoBrokerStates: ignoring custom on own object '${targetId}' (loop protection)`,
				);
				continue;
			}

			const raw = row?.value?.[nsKey];
			if (!raw) {
				continue;
			}

			nextWatched.add(targetId);
			this._lastCustomByObjectId.set(targetId, JSON.stringify(normalizeRuleCfg(raw)));

			if (!raw.enabled) {
				continue;
			}

			const cfg = normalizeRuleCfg(raw);
			if (!cfg?.enabled) {
				continue;
			}

			this.registry.rulesByTargetId.set(targetId, cfg);

			const required = new Set();
			required.add(targetId);

			const add = val => {
				if (typeof val === 'string' && val.trim()) {
					required.add(val);
				}
			};

			add(cfg?.trg?.id);
			add(cfg?.sess?.onOffId);
			add(cfg?.sess?.energyCounterId);
			add(cfg?.sess?.pricePerKwhId);

			this.registry.requiredStateIdsByTargetId.set(targetId, required);

			for (const stateId of required) {
				nextRequiredStateIds.add(stateId);
				const targets = this.registry.targetsByStateId.get(stateId) || new Set();
				targets.add(targetId);
				this.registry.targetsByStateId.set(stateId, targets);
			}
		}

		const objDiff = this._setDiff(this.registry.watchedObjectIds, nextWatched);
		if (objDiff.added.length) {
			this._subscribeObjects(objDiff.added);
			if (reason === 'poll') {
				this.adapter?.log?.info?.(
					`${this._logPrefix}IngestIoBrokerStates: discovered ${objDiff.added.length} new custom object(s): ${objDiff.added.join(', ')}`,
				);
			}
		}
		if (objDiff.removed.length) {
			this._unsubscribeObjects(objDiff.removed);
			for (const id of objDiff.removed) {
				this._lastCustomByObjectId.delete(id);
			}
			this.adapter?.log?.info?.(
				`${this._logPrefix}IngestIoBrokerStates: custom removed for ${objDiff.removed.length} object(s): ${objDiff.removed.join(', ')}`,
			);
		}

		const stateDiff = this._setDiff(this._subscribedStateIds, nextRequiredStateIds);
		if (stateDiff.added.length) {
			this._subscribeStates(stateDiff.added);
		}
		if (stateDiff.removed.length) {
			this._unsubscribeStates(stateDiff.removed);
		}

		this.registry.watchedObjectIds = nextWatched;
		this._subscribedStateIds = nextRequiredStateIds;
	}
}

module.exports = { IngestIoBrokerStatesEngine };
