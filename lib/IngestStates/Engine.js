'use strict';

const { createOpQueue, isObject } = require(`${__dirname}/../../src/MsgUtils`);
const { MessageWriter } = require('./MessageWriter');
const { TimerService } = require('./TimerService');
const { FreshnessRule } = require('./rules/Freshness');
const { ThresholdRule } = require('./rules/Threshold');
const { TriggeredRule } = require('./rules/Triggered');
const { NonSettlingRule } = require('./rules/NonSettling');
const { SessionRule } = require('./rules/Session');

/**
 * IngestStates engine (RuleHost).
 *
 * Responsibilities:
 * - scan `system/custom` for `common.custom.<namespace>` configs
 * - build rule instances per target id
 * - subscribe to union of required foreign state ids + foreign objects
 * - route events to rule instances
 * - report managed objects via `ctx.meta.managedObjects`
 */
class IngestStatesEngine {
	/**
	 * @param {object} ctx Plugin runtime context.
	 * @param {object} [options] Plugin options.
	 */
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		this.options = options || {};

		this._queue = null;
		this._running = false;
		this._timers = new TimerService(ctx, { onDue: timer => this._onTimer(timer) });
		this._pendingRescanHandle = null;
		this._rescanTimer = null;
		this._tickTimer = null;

		this._messageWriter = new MessageWriter(ctx, options);

		this._rulesByTargetId = new Map(); // targetId -> rule instance
		this._rulesByStateId = new Map(); // stateId -> Set<rule>
		this._watchedObjectIds = new Set(); // objects to watch for custom changes
		this._subscribedStateIds = new Set(); // union of required state ids
	}

	/**
	 * @param {string} mode Rule mode.
	 * @returns {boolean} True when mode is supported (matches jsonCustom UI options).
	 */
	_isValidMode(mode) {
		return (
			mode === 'threshold' ||
			mode === 'freshness' ||
			mode === 'triggered' ||
			mode === 'nonSettling' ||
			mode === 'session'
		);
	}

	/**
	 * @param {string} managedBy `managedMeta.managedBy` value.
	 * @returns {boolean} True when this managedBy belongs to this plugin instance.
	 */
	_isManagedByUs(managedBy) {
		const raw = typeof managedBy === 'string' ? managedBy.trim() : '';
		if (!raw) {
			return false;
		}

		const own = this.ctx?.meta?.plugin?.baseOwnId;
		if (typeof own !== 'string' || !own.trim()) {
			return false;
		}

		return raw === own || raw.endsWith(`.${own}`);
	}

	/**
	 * Start the engine (initial scan + timers).
	 *
	 * @returns {void}
	 */
	start() {
		if (this._running) {
			return;
		}
		this._running = true;
		this._queue = createOpQueue();

		void this._queue(() => this._timers.start()).catch(e => {
			this.ctx.api.log.warn(`${this._prefix()}timers init failed: ${e?.message || e}`);
		});

		void this._queue(() => this._rescan('start')).catch(e => {
			this.ctx.api.log.warn(`${this._prefix()}initial scan failed: ${e?.message || e}`);
		});

		const rescanIntervalMs = this.ctx.meta.options.resolveInt('rescanIntervalMs', this.options.rescanIntervalMs);
		if (rescanIntervalMs > 0) {
			this._rescanTimer = this.ctx.meta.resources.setInterval(() => {
				void this._queue(() => this._rescan('poll')).catch(() => undefined);
			}, rescanIntervalMs);
		}

		const tickIntervalMs = this.ctx.meta.options.resolveInt('evaluateIntervalMs', this.options.evaluateIntervalMs);
		if (tickIntervalMs > 0) {
			this._tickTimer = this.ctx.meta.resources.setInterval(() => {
				void this._queue(() => this._tick()).catch(() => undefined);
			}, tickIntervalMs);
		}
	}

	/**
	 * Stop the engine and dispose subscriptions + rules.
	 *
	 * @returns {void}
	 */
	stop() {
		if (!this._running) {
			return;
		}
		this._running = false;

		try {
			this._timers.stop();
		} catch {
			// ignore (best-effort)
		}

		if (this._pendingRescanHandle) {
			this.ctx.meta.resources.clearTimeout(this._pendingRescanHandle);
			this._pendingRescanHandle = null;
		}

		this._unsubscribeObjects(Array.from(this._watchedObjectIds));
		this._unsubscribeStates(Array.from(this._subscribedStateIds));

		for (const rule of this._rulesByTargetId.values()) {
			rule?.dispose?.();
		}

		this._rulesByTargetId.clear();
		this._rulesByStateId.clear();
		this._watchedObjectIds.clear();
		this._subscribedStateIds.clear();

		this._queue = null;
		this._rescanTimer = null;
		this._tickTimer = null;
	}

	/**
	 * Route an incoming state change to interested rule instances.
	 *
	 * @param {string} id State id.
	 * @param {object} state ioBroker state.
	 * @param {object} _ctx Host ctx (unused; engine keeps its own ctx reference).
	 * @returns {void}
	 */
	onStateChange(id, state, _ctx) {
		if (!this._running) {
			return;
		}

		const rules = this._rulesByStateId.get(id);
		if (!rules || rules.size === 0) {
			return;
		}

		if (this.ctx.meta.options.resolveBool('traceEvents', this.options.traceEvents)) {
			this.ctx.api.log.debug(
				`${this._prefix()}stateChange('${id}') routes to ${rules.size} rule(s): ${Array.from(rules)
					.map(r => r?.targetId)
					.filter(Boolean)
					.join(', ')}`,
			);
		}

		for (const rule of rules) {
			rule?.onStateChange?.(id, state);
		}
	}

	/**
	 * Debounced rescan trigger on object changes (Custom edits, rename, etc.).
	 *
	 * @param {string} _id Object id (unused).
	 * @param {object} _obj Object payload (unused).
	 * @param {object} _ctx Host ctx (unused).
	 * @returns {void}
	 */
	onObjectChange(_id, _obj, _ctx) {
		if (!this._running || !this._queue) {
			return;
		}

		if (this._pendingRescanHandle) {
			this.ctx.meta.resources.clearTimeout(this._pendingRescanHandle);
		}
		this._pendingRescanHandle = this.ctx.meta.resources.setTimeout(() => {
			this._pendingRescanHandle = null;
			void this._queue(() => this._rescan('objectChange')).catch(() => undefined);
		}, 1500);
	}

	/**
	 * @returns {string} Log prefix for this plugin instance.
	 */
	_prefix() {
		return `${this.ctx.meta.plugin.baseFullId}: IngestStates: `;
	}

	/**
	 * Periodic evaluation tick routed to rules.
	 *
	 * @returns {void}
	 */
	_tick() {
		if (!this._running) {
			return;
		}
		const now = Date.now();
		for (const rule of this._rulesByTargetId.values()) {
			rule?.onTick?.(now);
		}
	}

	/**
	 * Rescan ioBroker `system/custom` view and rebuild rule instances/subscriptions.
	 *
	 * @param {string} reason Scan trigger reason (debug).
	 * @returns {Promise<void>} Resolves when scan finished.
	 */
	async _rescan(reason) {
		if (!this._running) {
			return;
		}

		const nsKey = this.ctx.api.iobroker.ids.namespace;
		const res = await this.ctx.api.iobroker.objects.getObjectView('system', 'custom', {});

		const nextRulesByTargetId = new Map();
		const nextRulesByStateId = new Map();
		const nextWatchedObjectIds = new Set();
		const nextSubscribedStateIds = new Set();

		for (const row of res?.rows || []) {
			const targetId = row?.id;
			if (typeof targetId !== 'string' || !targetId.trim()) {
				continue;
			}

			if (isOwnObjectId(nsKey, targetId)) {
				continue;
			}

			const raw = row?.value?.[nsKey];
			if (!raw) {
				continue;
			}

			nextWatchedObjectIds.add(targetId);

			if (raw.enabled !== true) {
				continue;
			}

			let cfg;
			try {
				cfg = normalizeRuleCfg(raw);
			} catch (e) {
				this.ctx.api.log.warn(`${this._prefix()}invalid custom config on '${targetId}': ${e?.message || e}`);
				continue;
			}
			if (!cfg || cfg.enabled !== true) {
				continue;
			}

			const mode = typeof cfg.mode === 'string' ? cfg.mode.trim() : '';
			if (!mode) {
				continue;
			}

			const managedBy = typeof cfg.managedMeta?.managedBy === 'string' ? cfg.managedMeta.managedBy.trim() : '';
			if (this._isValidMode(mode) && managedBy && !this._isManagedByUs(managedBy)) {
				this.ctx.api.log.warn(
					`${this._prefix()}skipping '${targetId}' because it is managed by '${managedBy}' (mode='${mode}')`,
				);
				continue;
			}

			try {
				const message = this._messageWriter.forTarget({
					targetId,
					ruleType: mode,
					messageConfig: cfg.msg,
					startMessageConfig: cfg.msg,
				});

				const rule = this._createRule({ targetId, mode, cfg, message });
				const required = rule.requiredStateIds();

				nextRulesByTargetId.set(targetId, rule);

				for (const stateId of required) {
					nextSubscribedStateIds.add(stateId);
					const set = nextRulesByStateId.get(stateId) || new Set();
					set.add(rule);
					nextRulesByStateId.set(stateId, set);
				}

				await this.ctx.meta.managedObjects.report(targetId, {
					managedText: `IngestStates (${mode})`,
				});
			} catch (e) {
				this.ctx.api.log.warn(`${this._prefix()}rule init failed for '${targetId}': ${e?.message || e}`);
			}
		}

		await this.ctx.meta.managedObjects.applyReported();

		const objDiff = setDiff(this._watchedObjectIds, nextWatchedObjectIds);
		if (objDiff.added.length) {
			this._subscribeObjects(objDiff.added);
		}
		if (objDiff.removed.length) {
			this._unsubscribeObjects(objDiff.removed);
		}

		const stateDiff = setDiff(this._subscribedStateIds, nextSubscribedStateIds);
		if (stateDiff.added.length) {
			this._subscribeStates(stateDiff.added);
		}
		if (stateDiff.removed.length) {
			this._unsubscribeStates(stateDiff.removed);
		}

		// Dispose rules that are no longer present (or were replaced).
		for (const [id, rule] of this._rulesByTargetId.entries()) {
			if (!nextRulesByTargetId.has(id)) {
				rule?.dispose?.();
			}
		}

		this._rulesByTargetId = nextRulesByTargetId;
		this._rulesByStateId = nextRulesByStateId;
		this._watchedObjectIds = nextWatchedObjectIds;
		this._subscribedStateIds = nextSubscribedStateIds;

		if (this.ctx.meta.options.resolveBool('traceEvents', this.options.traceEvents)) {
			this.ctx.api.log.debug(
				`${this._prefix()}rescan(${reason}) targets=${this._rulesByTargetId.size}, requiredStates=${this._subscribedStateIds.size}, watchedObjects=${this._watchedObjectIds.size}`,
			);
		}
	}

	/**
	 * Create a rule instance for the selected mode.
	 *
	 * @param {object} info Rule inputs.
	 * @param {string} info.targetId Target object/state id.
	 * @param {string} info.mode Rule mode.
	 * @param {object} info.cfg Normalized custom config.
	 * @param {object} info.message Target message writer.
	 * @returns {object} Rule instance.
	 */
	_createRule({ targetId, mode, cfg, message }) {
		if (mode === 'freshness') {
			return new FreshnessRule({ targetId, ruleConfig: cfg.fresh, message });
		}
		if (mode === 'threshold') {
			return new ThresholdRule({ targetId, ruleConfig: cfg.thr, message, timers: this._timers });
		}
		if (mode === 'triggered') {
			return new TriggeredRule({ targetId, ruleConfig: cfg.trg, message, timers: this._timers });
		}
		if (mode === 'nonSettling') {
			return new NonSettlingRule({ targetId, ruleConfig: cfg.ns, message, timers: this._timers });
		}
		if (mode === 'session') {
			return new SessionRule({ targetId, ruleConfig: cfg.sess, message, timers: this._timers });
		}

		throw new Error(`unsupported mode '${mode}'`);
	}

	/**
	 * Route a due timer to the matching rule instance (best-effort).
	 *
	 * @param {{ id: string, at: number, kind: string, data?: any }} timer Timer payload.
	 * @returns {void}
	 */
	_onTimer(timer) {
		if (!this._running || !this._queue) {
			return;
		}
		void this._queue(() => this._handleTimer(timer)).catch(e => {
			this.ctx.api.log.warn(`${this._prefix()}timer handling failed: ${e?.message || e}`);
		});
	}

	/**
	 * Handle a due timer routed by `TimerService` (best-effort).
	 *
	 * @param {{ id: string, at: number, kind: string, data?: any }} timer Timer payload.
	 * @returns {void}
	 */
	_handleTimer(timer) {
		const tid = typeof timer?.id === 'string' ? timer.id : '';
		const kind = typeof timer?.kind === 'string' ? timer.kind : '';
		const targetId = typeof timer?.data?.targetId === 'string' ? timer.data.targetId : '';
		if (!tid || !kind || !targetId) {
			return;
		}

		const rule = this._rulesByTargetId.get(targetId);
		rule?.onTimer?.(timer);
	}

	/**
	 * Subscribe to all given foreign state ids (best-effort).
	 *
	 * @param {string[]} ids State ids.
	 * @returns {void}
	 */
	_subscribeStates(ids) {
		for (const id of ids) {
			try {
				this.ctx.api.iobroker.subscribe.subscribeForeignStates(id);
			} catch (e) {
				this.ctx.api.log.warn(`${this._prefix()}subscribeForeignStates('${id}') failed: ${e?.message || e}`);
			}
		}
	}

	/**
	 * Unsubscribe from all given foreign state ids (best-effort).
	 *
	 * @param {string[]} ids State ids.
	 * @returns {void}
	 */
	_unsubscribeStates(ids) {
		for (const id of ids) {
			try {
				this.ctx.api.iobroker.subscribe.unsubscribeForeignStates(id);
			} catch (e) {
				this.ctx.api.log.warn(`${this._prefix()}unsubscribeForeignStates('${id}') failed: ${e?.message || e}`);
			}
		}
	}

	/**
	 * Subscribe to all given foreign object ids (best-effort).
	 *
	 * @param {string[]} ids Object ids.
	 * @returns {void}
	 */
	_subscribeObjects(ids) {
		for (const id of ids) {
			try {
				this.ctx.api.iobroker.subscribe.subscribeForeignObjects(id);
			} catch (e) {
				this.ctx.api.log.warn(`${this._prefix()}subscribeForeignObjects('${id}') failed: ${e?.message || e}`);
			}
		}
	}

	/**
	 * Unsubscribe from all given foreign object ids (best-effort).
	 *
	 * @param {string[]} ids Object ids.
	 * @returns {void}
	 */
	_unsubscribeObjects(ids) {
		for (const id of ids) {
			try {
				this.ctx.api.iobroker.subscribe.unsubscribeForeignObjects(id);
			} catch (e) {
				this.ctx.api.log.warn(`${this._prefix()}unsubscribeForeignObjects('${id}') failed: ${e?.message || e}`);
			}
		}
	}
}

/**
 * @param {string} namespace Adapter namespace, e.g. `msghub.0`.
 * @param {string} id Candidate object id.
 * @returns {boolean} True when the id belongs to this adapter instance.
 */
function isOwnObjectId(namespace, id) {
	return id === namespace || String(id).startsWith(`${namespace}.`);
}

/**
 * Convert dotted keys (e.g. `msg.title`) to nested objects (`{ msg: { title } }`).
 *
 * @param {any} input Input value.
 * @returns {any} Normalized value.
 */
function normalizeDotKeys(input) {
	if (!isObject(input)) {
		return input;
	}

	const out = {};

	for (const [key, value] of Object.entries(input)) {
		if (key.includes('.')) {
			continue;
		}
		out[key] = isObject(value) ? normalizeDotKeys(value) : value;
	}

	for (const [key, value] of Object.entries(input)) {
		if (!key.includes('.')) {
			continue;
		}
		const parts = key.split('.').filter(Boolean);
		if (parts.length === 0) {
			continue;
		}

		let cur = out;
		for (let i = 0; i < parts.length - 1; i += 1) {
			const p = parts[i];
			if (!isObject(cur[p])) {
				cur[p] = {};
			}
			cur = cur[p];
		}
		cur[parts[parts.length - 1]] = isObject(value) ? normalizeDotKeys(value) : value;
	}

	return out;
}

/**
 * Normalize a raw ioBroker Custom config payload.
 *
 * @param {any} cfg Custom config.
 * @returns {object|null} Normalized object or null when invalid.
 */
function normalizeRuleCfg(cfg) {
	if (!isObject(cfg)) {
		return null;
	}
	return normalizeDotKeys(JSON.parse(JSON.stringify(cfg)));
}

/**
 * Compute set additions/removals.
 *
 * @param {Set<string>} prev Previous set.
 * @param {Set<string>} next Next set.
 * @returns {{ added: string[], removed: string[] }} Diff.
 */
function setDiff(prev, next) {
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

module.exports = { IngestStatesEngine };
