/**
 * IngestStates engine.
 *
 * v0.0.2 MVP:
 * - Scan `system/custom` for msghub custom configs.
 * - Subscribe to configured foreign objects and foreign states.
 * - Implement Freshness rule (detect missing updates) and emit MsgHub messages.
 */

'use strict';

const { IngestStatesRegistry } = require('./Registry');
const { normalizeRuleCfg } = require('./normalizeConfig');
const { isOwnObjectId } = require('./ownObjectGuard');
const { FreshnessRule } = require('./rules/Freshness');

const DEFAULT_KIND = 'status';
const DEFAULT_LEVEL = 20; // warning

class IngestStatesEngine {
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		this.options = options || {};

		this.registry = new IngestStatesRegistry();

		this._running = false;
		this._queue = null;
		this._rescanTimer = null;
		this._evalTimer = null;
		this._pendingRescanHandle = null;

		this._subscribedStateIds = new Set();
		this._lastCustomByObjectId = new Map(); // id -> normalized json|null

		this._freshLastSeenByTargetId = new Map(); // targetId -> { ts, lc }
		this._freshActiveByTargetId = new Map(); // targetId -> boolean (active violation)
		this._freshLastCreatedAtByTargetId = new Map(); // targetId -> number
		this._freshPendingResetTimers = new Map(); // targetId -> timeoutHandle
	}

	start() {
		if (this._running) {
			return;
		}
		this._running = true;

		const { createOpQueue } = require(`${__dirname}/../../src/MsgUtils`);
		this._queue = createOpQueue();

		// Initial scan (async best-effort).
		this._queue(() => this._rescan('start'))
			.then(() => {
				this.ctx.api.log.info(
					`${this._prefix()}started targets=${this.registry.rulesByTargetId.size}, requiredStates=${this._subscribedStateIds.size}, watchedObjects=${this.registry.watchedObjectIds.size}`,
				);
			})
			.catch(e => {
				this.ctx.api.log.warn(`${this._prefix()}initial scan failed: ${e?.message || e}`);
			});

		// Periodic rescan (new customs).
		const rescanIntervalMs = Number(this.ctx.meta.options.resolveInt('rescanIntervalMs', this.options.rescanIntervalMs));
		if (Number.isFinite(rescanIntervalMs) && rescanIntervalMs > 0) {
			this._rescanTimer = this.ctx.meta.resources.setInterval(() => {
				void this._queue(() => this._rescan('poll')).catch(() => undefined);
			}, rescanIntervalMs);
		}

		// Evaluation tick (freshness needs timers to detect missing events).
		const evaluateIntervalMs = Number(
			this.ctx.meta.options.resolveInt('evaluateIntervalMs', this.options.evaluateIntervalMs),
		);
		if (Number.isFinite(evaluateIntervalMs) && evaluateIntervalMs > 0) {
			this._evalTimer = this.ctx.meta.resources.setInterval(() => {
				void this._queue(() => this._evaluateTick()).catch(() => undefined);
			}, evaluateIntervalMs);
		}
	}

	stop() {
		if (!this._running) {
			return;
		}
		this._running = false;

		if (this._pendingRescanHandle) {
			try {
				this.ctx.meta.resources.clearTimeout(this._pendingRescanHandle);
			} catch {
				// ignore
			}
			this._pendingRescanHandle = null;
		}

		// Best-effort cleanup: subscriptions are also tracked by IoPluginResources,
		// but we explicitly unsubscribe to keep the engine state accurate during runtime.
		try {
			this._unsubscribeObjects(Array.from(this.registry.watchedObjectIds));
			this._unsubscribeStates(Array.from(this._subscribedStateIds));
		} finally {
			this.registry.clear();
			this._subscribedStateIds.clear();
			this._lastCustomByObjectId.clear();
			this._freshLastSeenByTargetId.clear();
			this._freshActiveByTargetId.clear();
			this._freshLastCreatedAtByTargetId.clear();
			this._clearAllPendingResetTimers();
			this._pendingRescanHandle = null;
			this._queue = null;
			this._rescanTimer = null;
			this._evalTimer = null;
		}
	}

	onStateChange(id, state, _ctx) {
		if (!this._running) {
			return;
		}

		const targets = this.registry.targetsByStateId.get(id);
		if (!targets || targets.size === 0) {
			return;
		}

		const trace = this.ctx.meta.options.resolveBool('traceEvents', this.options.traceEvents);
		if (trace) {
			this.ctx.api.log.debug(
				`${this._prefix()}stateChange('${id}') routes to ${targets.size} target(s): ${Array.from(targets).join(', ')}`,
			);
		}

		if (!state || typeof state !== 'object') {
			return;
		}

		const ts = typeof state.ts === 'number' && Number.isFinite(state.ts) ? Math.trunc(state.ts) : null;
		const lc = typeof state.lc === 'number' && Number.isFinite(state.lc) ? Math.trunc(state.lc) : null;
		if (ts === null && lc === null) {
			return;
		}

		for (const targetId of targets) {
			const cfg = this.registry.rulesByTargetId.get(targetId);
			if (!cfg || cfg.mode !== 'freshness') {
				continue;
			}
			const prev = this._freshLastSeenByTargetId.get(targetId) || { ts: null, lc: null };
			this._freshLastSeenByTargetId.set(targetId, {
				ts: ts ?? prev.ts,
				lc: lc ?? prev.lc,
			});
		}
	}

	onObjectChange(id, obj, _ctx) {
		if (!this._running) {
			return;
		}

		const nsKey = this.ctx.api.iobroker.ids.namespace;
		const raw = obj?.common?.custom?.[nsKey] || null;
		const next = raw ? JSON.stringify(normalizeRuleCfg(raw)) : null;
		const prev = this._lastCustomByObjectId.get(id) ?? null;

		if (prev === next) {
			return;
		}

		if (next === null) {
			this._lastCustomByObjectId.delete(id);
			this.ctx.api.log.info(`${this._prefix()}custom removed on '${id}'`);
		} else {
			this._lastCustomByObjectId.set(id, next);
			this.ctx.api.log.info(`${this._prefix()}custom changed on '${id}' (enabled=${raw?.enabled === true})`);
			const trace = this.ctx.meta.options.resolveBool('traceEvents', this.options.traceEvents);
			if (trace) {
				this.ctx.api.log.debug(`${this._prefix()}custom now on '${id}': ${next}`);
			}
		}

		// Debounce a rescan so changes take effect quickly without thrashing.
		if (this._rescanTimer) {
			// periodic rescan exists; still do a short debounce for faster feedback.
		}

		if (!this._queue) {
			return;
		}

		// Debounce per engine (single timer).
		if (this._pendingRescanHandle) {
			this.ctx.meta.resources.clearTimeout(this._pendingRescanHandle);
		}
		this._pendingRescanHandle = this.ctx.meta.resources.setTimeout(() => {
			this._pendingRescanHandle = null;
			void this._queue(() => this._rescan('objectChange')).catch(() => undefined);
		}, 1500);
	}

	_prefix() {
		const baseFullId =
			typeof this.ctx?.meta?.plugin?.baseFullId === 'string' && this.ctx.meta.plugin.baseFullId.trim()
				? this.ctx.meta.plugin.baseFullId.trim()
				: '';
		return baseFullId ? `${baseFullId}: IngestStates: ` : 'IngestStates: ';
	}

	_subscribeStates(ids) {
		for (const id of ids) {
			try {
				this.ctx.api.iobroker.subscribe.subscribeForeignStates(id);
			} catch (e) {
				this.ctx.api.log.warn(`${this._prefix()}subscribeForeignStates('${id}') failed: ${e?.message || e}`);
			}
		}
	}

	_unsubscribeStates(ids) {
		for (const id of ids) {
			try {
				this.ctx.api.iobroker.subscribe.unsubscribeForeignStates(id);
			} catch (e) {
				this.ctx.api.log.warn(`${this._prefix()}unsubscribeForeignStates('${id}') failed: ${e?.message || e}`);
			}
		}
	}

	_subscribeObjects(ids) {
		for (const id of ids) {
			try {
				this.ctx.api.iobroker.subscribe.subscribeForeignObjects(id);
			} catch (e) {
				this.ctx.api.log.warn(`${this._prefix()}subscribeForeignObjects('${id}') failed: ${e?.message || e}`);
			}
		}
	}

	_unsubscribeObjects(ids) {
		for (const id of ids) {
			try {
				this.ctx.api.iobroker.subscribe.unsubscribeForeignObjects(id);
			} catch (e) {
				this.ctx.api.log.warn(`${this._prefix()}unsubscribeForeignObjects('${id}') failed: ${e?.message || e}`);
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

		const nsKey = this.ctx.api.iobroker.ids.namespace;
		const res = await this.ctx.api.iobroker.objects.getObjectView('system', 'custom', {});

		const nextWatched = new Set();
		const nextRequiredStateIds = new Set();

		this.registry.rulesByTargetId.clear();
		this.registry.requiredStateIdsByTargetId.clear();
		this.registry.targetsByStateId.clear();

		for (const row of res?.rows || []) {
			const targetId = row?.id;
			if (typeof targetId !== 'string' || !targetId.trim()) {
				continue;
			}

			if (isOwnObjectId(nsKey, targetId)) {
				this.ctx.api.log.warn(`${this._prefix()}ignoring custom on own object '${targetId}' (loop protection)`);
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

			const mode = typeof cfg.mode === 'string' ? cfg.mode.trim() : '';
			if (!mode) {
				continue;
			}
			cfg.mode = mode;

			this.registry.rulesByTargetId.set(targetId, cfg);

			const required = new Set();
			required.add(targetId);

			const add = val => {
				if (typeof val === 'string' && val.trim()) {
					required.add(val.trim());
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
				this.ctx.api.log.info(
					`${this._prefix()}discovered ${objDiff.added.length} new custom object(s): ${objDiff.added.join(', ')}`,
				);
			}
		}
		if (objDiff.removed.length) {
			this._unsubscribeObjects(objDiff.removed);
			for (const id of objDiff.removed) {
				this._lastCustomByObjectId.delete(id);
				this._forgetTarget(id);
			}
			this.ctx.api.log.info(
				`${this._prefix()}custom removed for ${objDiff.removed.length} object(s): ${objDiff.removed.join(', ')}`,
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

		await this._seedFreshnessLastSeen();

		const trace = this.ctx.meta.options.resolveBool('traceEvents', this.options.traceEvents);
		if (trace) {
			this.ctx.api.log.debug(
				`${this._prefix()}rescan(${reason}) targets=${this.registry.rulesByTargetId.size}, requiredStates=${this._subscribedStateIds.size}, watchedObjects=${this.registry.watchedObjectIds.size}`,
			);
		}
	}

	_forgetTarget(targetId) {
		this._freshLastSeenByTargetId.delete(targetId);
		this._freshActiveByTargetId.delete(targetId);
		this._freshLastCreatedAtByTargetId.delete(targetId);
		this._clearPendingResetTimer(targetId);
	}

	async _seedFreshnessLastSeen() {
		const broker = this.ctx.api.iobroker;

		const targets = [];
		for (const [targetId, cfg] of this.registry.rulesByTargetId.entries()) {
			if (cfg?.mode !== 'freshness') {
				continue;
			}
			const everyMs = FreshnessRule.computeEveryMs(cfg);
			if (!everyMs) {
				continue;
			}
			targets.push(targetId);
		}

		for (const id of targets) {
			if (this._freshLastSeenByTargetId.has(id)) {
				continue;
			}

			let st;
			try {
				st = await broker.states.getForeignState(id);
			} catch (e) {
				this.ctx.api.log.warn(`${this._prefix()}getForeignState('${id}') failed: ${e?.message || e}`);
				continue;
			}
			if (!st || typeof st !== 'object') {
				continue;
			}

			const ts = typeof st.ts === 'number' && Number.isFinite(st.ts) ? Math.trunc(st.ts) : null;
			const lc = typeof st.lc === 'number' && Number.isFinite(st.lc) ? Math.trunc(st.lc) : null;
			this._freshLastSeenByTargetId.set(id, { ts, lc });
		}
	}

	async _evaluateTick() {
		if (!this._running) {
			return;
		}

		for (const [targetId, cfg] of this.registry.rulesByTargetId.entries()) {
			if (!cfg || cfg.mode !== 'freshness') {
				continue;
			}
			await this._evaluateFreshness(targetId, cfg);
		}
	}

	async _evaluateFreshness(targetId, cfg) {
		const everyMs = FreshnessRule.computeEveryMs(cfg);
		if (!everyMs) {
			return;
		}

		const evaluateBy = FreshnessRule.computeEvaluateBy(cfg);
		const last = this._freshLastSeenByTargetId.get(targetId) || { ts: null, lc: null };
		const lastSeen = evaluateBy === 'lc' ? last.lc : last.ts;
		const now = Date.now();

		// Without a lastSeen (e.g. missing state), we cannot evaluate reliably.
		if (typeof lastSeen !== 'number' || !Number.isFinite(lastSeen)) {
			return;
		}

		const ageMs = now - lastSeen;
		const isViolation = ageMs > everyMs;

		const wasActive = this._freshActiveByTargetId.get(targetId) === true;

		if (isViolation) {
			this._clearPendingResetTimer(targetId);
			this._freshActiveByTargetId.set(targetId, true);
			if (!wasActive) {
				await this._raiseFreshness(targetId, cfg, { now, lastSeen, ageMs, everyMs, evaluateBy });
			}
			return;
		}

		// back to normal
		this._freshActiveByTargetId.set(targetId, false);
		if (wasActive) {
			await this._resolveFreshness(targetId, cfg);
		}
	}

	_makeRef(targetId, ctx) {
		const instanceId =
			typeof ctx?.meta?.plugin?.instanceId === 'number' && Number.isFinite(ctx.meta.plugin.instanceId)
				? Math.trunc(ctx.meta.plugin.instanceId)
				: 0;
		const token = Buffer.from(String(targetId), 'utf8').toString('base64url');
		return `IngestStates.${instanceId}.fresh.${token}`;
	}

	_pickKind(cfg) {
		const v = typeof cfg?.msg?.kind === 'string' ? cfg.msg.kind.trim() : '';
		return v || DEFAULT_KIND;
	}

	_pickLevel(cfg) {
		const level = cfg?.msg?.level;
		if (typeof level === 'number' && Number.isFinite(level)) {
			return Math.trunc(level);
		}
		if (typeof level === 'string' && level.trim() !== '') {
			const n = Number(level);
			return Number.isFinite(n) ? Math.trunc(n) : DEFAULT_LEVEL;
		}
		return DEFAULT_LEVEL;
	}

	_makeTitle(cfg, targetId) {
		const v = typeof cfg?.msg?.title === 'string' ? cfg.msg.title.trim() : '';
		return v || `Freshness: ${targetId}`;
	}

	_makeText(cfg, info) {
		const custom = typeof cfg?.msg?.text === 'string' ? cfg.msg.text.trim() : '';
		if (custom) {
			return custom;
		}
		const everyMin = Math.max(1, Math.round(info.everyMs / 60000));
		const ageMin = Math.max(0, Math.round(info.ageMs / 60000));
		return `No ${info.evaluateBy} update for ~${ageMin} min (expected <= ${everyMin} min).`;
	}

	_extractCooldownMs(cfg) {
		const value = cfg?.msg?.cooldownValue;
		const unit = cfg?.msg?.cooldownUnit;
		const v = typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Number(value) : null;
		const u = typeof unit === 'number' && Number.isFinite(unit) ? unit : typeof unit === 'string' ? Number(unit) : null;
		if (!v || !u || v <= 0 || u <= 0) {
			return 0;
		}
		return Math.trunc(v * u * 1000);
	}

	async _raiseFreshness(targetId, cfg, info) {
		const store = this.ctx.api.store;
		const factory = this.ctx.api.factory;
		const constants = this.ctx.api.constants;

		const ref = this._makeRef(targetId, this.ctx);

		// Cooldown on re-create (best-effort; primarily relevant for auto-close + persistent violations).
		const cooldownMs = this._extractCooldownMs(cfg);
		if (cooldownMs > 0) {
			const lastCreatedAt = this._freshLastCreatedAtByTargetId.get(targetId) || 0;
			if (lastCreatedAt && lastCreatedAt + cooldownMs > Date.now()) {
				return;
			}
		}

		const existing = store.getMessageByRef(ref);
		const state = existing?.lifecycle?.state;
		const closedStates = new Set([
			constants.lifecycle.state.closed,
			constants.lifecycle.state.deleted,
			constants.lifecycle.state.expired,
		]);
		const isActive = !state || !closedStates.has(state);

		// If a message already exists and is still open, keep it (avoid update spam).
		if (existing && isActive) {
			return;
		}

		const remindEveryMs = FreshnessRule.computeRemindEveryMs(cfg);

		const created = factory.createMessage({
			ref,
			kind: this._pickKind(cfg),
			level: this._pickLevel(cfg),
			title: this._makeTitle(cfg, targetId),
			text: this._makeText(cfg, info),
			origin: { type: constants.origin.type.automation, system: 'IngestStates', id: targetId },
			timing: {
				notifyAt: info.now,
				...(remindEveryMs ? { remindEvery: remindEveryMs } : {}),
			},
			details: {
				targetId,
				mode: 'freshness',
				evaluateBy: info.evaluateBy,
				everyMs: info.everyMs,
				lastSeen: info.lastSeen,
			},
		});

		if (!created) {
			return;
		}

		store.addOrUpdateMessage(created);
		this._freshLastCreatedAtByTargetId.set(targetId, Date.now());
	}

	async _resolveFreshness(targetId, cfg) {
		const store = this.ctx.api.store;
		const ref = this._makeRef(targetId, this.ctx);
		const existing = store.getMessageByRef(ref);
		if (!existing) {
			return;
		}

		const resetOnNormal = cfg?.msg?.resetOnNormal !== false;
		if (!resetOnNormal) {
			// Keep the message, but stop reminders.
			store.updateMessage(ref, { timing: { notifyAt: null, remindEvery: null } });
			return;
		}

		const delayMs = FreshnessRule.computeResetDelayMs(cfg);
		if (!delayMs) {
			store.completeAfterCauseEliminated(ref, { actor: 'IngestStates', finishedAt: Date.now() });
			return;
		}

		if (this._freshPendingResetTimers.has(targetId)) {
			return;
		}

		const handle = this.ctx.meta.resources.setTimeout(() => {
			this._freshPendingResetTimers.delete(targetId);
			store.completeAfterCauseEliminated(ref, { actor: 'IngestStates', finishedAt: Date.now() });
		}, delayMs);
		this._freshPendingResetTimers.set(targetId, handle);
	}

	_clearPendingResetTimer(targetId) {
		const handle = this._freshPendingResetTimers.get(targetId);
		if (!handle) {
			return;
		}
		this._freshPendingResetTimers.delete(targetId);
		try {
			this.ctx.meta.resources.clearTimeout(handle);
		} catch {
			// ignore
		}
	}

	_clearAllPendingResetTimers() {
		for (const targetId of Array.from(this._freshPendingResetTimers.keys())) {
			this._clearPendingResetTimer(targetId);
		}
	}
}

module.exports = { IngestStatesEngine };
