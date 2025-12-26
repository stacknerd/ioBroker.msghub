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
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter
	 * @param {object} [options]
	 * @param {number} [options.rescanIntervalMs=180000] Poll interval (0 = off).
	 * @param {boolean} [options.traceEvents=false] Verbose per-event debug logs.
	 */
	constructor(adapter, options = {}) {
		this.adapter = adapter;
		this.options = options || {};

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
					`IngestIoBrokerStates: started targets=${this.registry.rulesByTargetId.size}, requiredStates=${this._subscribedStateIds.size}, watchedObjects=${this.registry.watchedObjectIds.size}`,
				);
			})
			.catch(e => {
				this.adapter?.log?.warn?.(`IngestIoBrokerStates: initial scan failed: ${e?.message || e}`);
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
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 * @param {object} [ctx]
	 * @returns {void}
	 */
	onStateChange(id, state, ctx) {
		const targets = this.registry.targetsByStateId.get(id);
		if (!targets || targets.size === 0) {
			return;
		}
		if (this.options?.traceEvents) {
			this.adapter?.log?.debug?.(
				`IngestIoBrokerStates: stateChange('${id}') routes to ${targets.size} target(s): ${Array.from(targets).join(', ')}`,
			);
		}
		// Rule evaluation comes later.
	}

	/**
	 * @param {string} id
	 * @param {ioBroker.Object | null | undefined} obj
	 * @param {object} [ctx]
	 * @returns {void}
	 */
	onObjectChange(id, obj, ctx) {
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
			this.adapter?.log?.info?.(`IngestIoBrokerStates: custom removed on '${id}'`);
			return;
		}

		this._lastCustomByObjectId.set(id, next);
		this.adapter?.log?.info?.(`IngestIoBrokerStates: custom changed on '${id}' (enabled=${raw?.enabled === true})`);
		if (this.options?.traceEvents) {
			this.adapter?.log?.debug?.(`IngestIoBrokerStates: custom now on '${id}': ${next}`);
		}
	}

	getRegistrySnapshot() {
		return {
			targets: this.registry.rulesByTargetId.size,
			requiredStates: this._subscribedStateIds.size,
			watchedObjects: this.registry.watchedObjectIds.size,
		};
	}

	_subscribeStates(ids) {
		for (const id of ids) {
			try {
				this.adapter.subscribeForeignStates(id);
			} catch (e) {
				this.adapter?.log?.warn?.(`IngestIoBrokerStates: subscribeForeignStates('${id}') failed: ${e?.message || e}`);
			}
		}
	}

	_unsubscribeStates(ids) {
		for (const id of ids) {
			try {
				this.adapter.unsubscribeForeignStates(id);
			} catch (e) {
				this.adapter?.log?.warn?.(
					`IngestIoBrokerStates: unsubscribeForeignStates('${id}') failed: ${e?.message || e}`,
				);
			}
		}
	}

	_subscribeObjects(ids) {
		for (const id of ids) {
			try {
				this.adapter.subscribeForeignObjects(id);
			} catch (e) {
				this.adapter?.log?.warn?.(`IngestIoBrokerStates: subscribeForeignObjects('${id}') failed: ${e?.message || e}`);
			}
		}
	}

	_unsubscribeObjects(ids) {
		for (const id of ids) {
			try {
				this.adapter.unsubscribeForeignObjects(id);
			} catch (e) {
				this.adapter?.log?.warn?.(
					`IngestIoBrokerStates: unsubscribeForeignObjects('${id}') failed: ${e?.message || e}`,
				);
			}
		}
	}

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
					`IngestIoBrokerStates: ignoring custom on own object '${targetId}' (loop protection)`,
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
					`IngestIoBrokerStates: discovered ${objDiff.added.length} new custom object(s): ${objDiff.added.join(', ')}`,
				);
			}
		}
		if (objDiff.removed.length) {
			this._unsubscribeObjects(objDiff.removed);
			for (const id of objDiff.removed) {
				this._lastCustomByObjectId.delete(id);
			}
			this.adapter?.log?.info?.(
				`IngestIoBrokerStates: custom removed for ${objDiff.removed.length} object(s): ${objDiff.removed.join(', ')}`,
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
