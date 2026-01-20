'use strict';

const { createOpQueue, isObject } = require(`${__dirname}/../../src/MsgUtils`);
const { MessageWriter } = require('./MessageWriter');
const { createPresetResolver } = require('./PresetResolver');
const { LocationResolver } = require('./LocationResolver');
const { TimerService } = require('./TimerService');
const { fallbackPresetId } = require('./constants');

const { FreshnessRule } = require('./rules/Freshness');
const { ThresholdRule } = require('./rules/Threshold');

// TODO: reactivate rules after refactoring them
//const { TriggeredRule } = require('./rules/Triggered');
//const { NonSettlingRule } = require('./rules/NonSettling');
//const { SessionRule } = require('./rules/Session');

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
	 * Best-effort JSON stringify for debug logs.
	 *
	 * @param {any} value Value to stringify.
	 * @returns {string} JSON or a placeholder.
	 */
	static _safeJson(value) {
		try {
			return JSON.stringify(value);
		} catch {
			return '[unstringifiable]';
		}
	}

	/**
	 * @param {any} val ioBroker state value.
	 * @returns {string} Short debug string.
	 */
	static _formatStateVal(val) {
		if (val === null) {
			return 'null';
		}
		if (val === undefined) {
			return 'undefined';
		}
		if (typeof val === 'string') {
			const s = val.trim();
			const shown = s.length > 120 ? `${s.slice(0, 120)}…` : s;
			return JSON.stringify(shown);
		}
		if (typeof val === 'number' || typeof val === 'boolean') {
			return String(val);
		}
		return `[${typeof val}]`;
	}

	/**
	 * @param {string} namespace Adapter namespace, e.g. `msghub.0`.
	 * @param {string} id Candidate object id.
	 * @returns {boolean} True when the id belongs to this adapter instance.
	 */
	static _isOwnObjectId(namespace, id) {
		return id === namespace || String(id).startsWith(`${namespace}.`);
	}

	/**
	 * Normalize flat custom config keys into grouped config blocks.
	 *
	 * Example: `{ 'thr-mode': 'lt', 'msg-title': '...' }` -> `{ thr: { mode: 'lt' }, msg: { title: '...' } }`
	 *
	 * @param {any} input Input value.
	 * @returns {object|null} Normalized value.
	 */
	static _normalizeFlatKeys(input) {
		if (!isObject(input)) {
			return null;
		}

		const out = {};
		const groupedPrefixes = new Set(['thr', 'fresh', 'trg', 'nonset', 'sess', 'msg', 'managedMeta']);

		for (const [rawKey, rawVal] of Object.entries(input)) {
			const key = typeof rawKey === 'string' ? rawKey : String(rawKey);
			if (!key || key.includes('.')) {
				continue;
			}

			// Custom configs are intentionally flat: nested objects are ignored.
			if (isObject(rawVal)) {
				continue;
			}

			const idx = key.indexOf('-');
			if (idx <= 0) {
				out[key] = rawVal;
				continue;
			}

			const prefix = key.slice(0, idx);
			const prop = key.slice(idx + 1);
			if (!prop) {
				continue;
			}

			if (!groupedPrefixes.has(prefix)) {
				out[key] = rawVal;
				continue;
			}

			if (!isObject(out[prefix])) {
				out[prefix] = {};
			}
			out[prefix][prop] = rawVal;
		}

		return out;
	}

	/**
	 * Normalize a raw ioBroker Custom config payload.
	 *
	 * @param {any} cfg Custom config.
	 * @returns {object|null} Normalized object or null when invalid.
	 */
	static _normalizeRuleCfg(cfg) {
		const cloned = JSON.parse(JSON.stringify(cfg ?? null));
		return IngestStatesEngine._normalizeFlatKeys(cloned);
	}

	/**
	 * Compute set additions/removals.
	 *
	 * @param {Set<string>} prev Previous set.
	 * @param {Set<string>} next Next set.
	 * @returns {{ added: string[], removed: string[] }} Diff.
	 */
	static _setDiff(prev, next) {
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
	 * @param {object} ctx Plugin runtime context.
	 * @param {object} [options] Plugin options.
	 */
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		this.options = options || {};

		this._presetResolver = createPresetResolver(ctx);
		this._presetCache = new Map(); // presetId -> preset object (or null)
		this._presetSubscribedStateIds = new Set(); // state ids under `.presets.*` we subscribed to

		this._queue = null;
		this._running = false;
		this._timers = new TimerService(ctx, {
			onDue: timer => this._onTimer(timer),
			traceEvents: ctx?.meta?.options?.resolveBool?.('traceEvents', options.traceEvents) === true,
		});
		this._pendingRescanHandle = null;
		this._rescanTimer = null;
		this._tickTimer = null;

		this._presetProvider = Object.freeze({
			getPreset: presetId => this._getPresetFromCache(presetId),
		});

		this._locationResolver = new LocationResolver(ctx);
		this._locationProvider = Object.freeze({
			getLocation: id => this._locationResolver.resolve(id),
		});

		this._messageWriter = new MessageWriter(
			ctx,
			Object.assign({}, options, {
				presetProvider: this._presetProvider,
				locationProvider: this._locationProvider,
			}),
		);

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
	 * @param {string} managedBy `managedMeta-managedBy` value.
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
			this.ctx.api.log.warn(`timers init failed: ${e?.message || e}`);
		});

		void this._queue(() => this._rescan('start')).catch(e => {
			this.ctx.api.log.warn(`initial scan failed: ${e?.message || e}`);
		});

		void this._queue(() => this._locationResolver.buildCache()).catch(() => undefined);

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

		this._unsubscribeStates(Array.from(this._presetSubscribedStateIds));
		this._presetSubscribedStateIds.clear();
		this._presetCache.clear();

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

		this._handlePresetStateChange(id);

		const rules = this._rulesByStateId.get(id);
		if (!rules || rules.size === 0) {
			return;
		}

		if (this._traceEnabled()) {
			const v = IngestStatesEngine._formatStateVal(state?.val);
			const ts = typeof state?.ts === 'number' && Number.isFinite(state.ts) ? Math.trunc(state.ts) : null;
			const lc = typeof state?.lc === 'number' && Number.isFinite(state.lc) ? Math.trunc(state.lc) : null;
			this.ctx.api.log.debug(
				`${this._prefix()}stateChange('${id}' val=${v} ts=${ts} lc=${lc}) routes to ${rules.size} rule(s): ${Array.from(
					rules,
				)
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

		const objectId = typeof _id === 'string' ? _id : '';

		if (this._pendingRescanHandle) {
			this.ctx.meta.resources.clearTimeout(this._pendingRescanHandle);
		}
		this._pendingRescanHandle = this.ctx.meta.resources.setTimeout(() => {
			this._pendingRescanHandle = null;
			void this._queue(() => this._rescan('objectChange')).catch(() => undefined);

			// Refresh room cache when enums changed
			if (objectId === 'enum.rooms' || objectId.startsWith('enum.rooms.')) {
				void this._queue(() => this._locationResolver.updateCache()).catch(() => undefined);
			}
		}, 1500);
	}

	/**
	 * @returns {string} Log prefix for this plugin instance.
	 */
	_prefix() {
		return `${this.ctx.meta.plugin.baseFullId}: IngestStates: `;
	}

	/**
	 * @returns {boolean} True when verbose debug logging is enabled.
	 */
	_traceEnabled() {
		return this.ctx.meta.options.resolveBool('traceEvents', this.options.traceEvents) === true;
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

		const traceEvents = this._traceEnabled();
		const nsKey = this.ctx.api.iobroker.ids.namespace;
		const res = await this.ctx.api.iobroker.objects.getObjectView('system', 'custom', {});

		const nextRulesByTargetId = new Map();
		const nextRulesByStateId = new Map();
		const nextWatchedObjectIds = new Set();
		const nextSubscribedStateIds = new Set();
		const nextPresetIds = new Set();

		for (const row of res?.rows || []) {
			const targetId = row?.id;
			if (typeof targetId !== 'string' || !targetId.trim()) {
				continue;
			}

			if (IngestStatesEngine._isOwnObjectId(nsKey, targetId)) {
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
				cfg = IngestStatesEngine._normalizeRuleCfg(raw);
			} catch (e) {
				this.ctx.api.log.warn(`invalid custom config on '${targetId}': ${e?.message || e}`);
				continue;
			}
			if (!cfg || cfg.enabled !== true) {
				continue;
			}

			const mode = typeof cfg.mode === 'string' ? cfg.mode.trim() : '';
			if (!mode) {
				continue;
			}

			// Field-neutral: collect all message preset ids from `msg.*Id` keys.
			for (const presetId of this._extractPresetIds(cfg.msg)) {
				nextPresetIds.add(presetId);
			}

			const managedBy = typeof cfg.managedMeta?.managedBy === 'string' ? cfg.managedMeta.managedBy.trim() : '';
			if (this._isValidMode(mode) && managedBy && !this._isManagedByUs(managedBy)) {
				this.ctx.api.log.warn(
					`${this._prefix()}skipping '${targetId}' because it is managed by '${managedBy}' (mode='${mode}')`,
				);
				continue;
			}

			try {
				if (traceEvents) {
					this.ctx.api.log.debug(
						`${this._prefix()}rule detected: targetId='${targetId}' mode='${mode}' cfg=${IngestStatesEngine._safeJson(cfg)}`,
					);
				}

				const presetRefs = this._extractPresetRefs(cfg.msg); // [{ presetKey: 'DefaultId', presetId: 'truesy_special' }, ...]

				// Map: presetKey -> writer (jede Linie bekommt eigenen Writer, auch wenn presetId identisch ist)
				const messageWritersByPresetKey = Object.fromEntries(
					presetRefs.map(({ presetKey, presetId }) => [
						presetKey,
						this._messageWriter.forTarget({ targetId, presetKey, presetId }),
					]),
				);

				// Optional: global fallback (wenn Key fehlt/unknown)
				messageWritersByPresetKey[fallbackPresetId] = this._messageWriter.forTarget({
					targetId,
					presetKey: fallbackPresetId,
					presetId: fallbackPresetId,
				});

				const ctx = this.ctx;

				const rule = this._createRule({ ctx, targetId, cfg, messageWritersByPresetKey });
				const required = rule.requiredStateIds();
				const requiredList = Array.from(required);

				nextRulesByTargetId.set(targetId, rule);

				if (traceEvents) {
					this.ctx.api.log.debug(
						`${this._prefix()}rule started: targetId='${targetId}' mode='${mode}' class='${rule?.constructor?.name || 'unknown'}' required=[${requiredList.join(', ')}]`,
					);

					const getState = this.ctx?.api?.iobroker?.states?.getForeignState;
					if (typeof getState === 'function' && requiredList.length) {
						const snapshots = await Promise.all(
							requiredList.map(async id => {
								try {
									const st = await getState(id);
									if (!st || typeof st !== 'object') {
										return `${id}: <missing>`;
									}
									const v = IngestStatesEngine._formatStateVal(st.val);
									const ts =
										typeof st.ts === 'number' && Number.isFinite(st.ts) ? Math.trunc(st.ts) : null;
									const lc =
										typeof st.lc === 'number' && Number.isFinite(st.lc) ? Math.trunc(st.lc) : null;
									return `${id}: val=${v} ts=${ts} lc=${lc}`;
								} catch {
									return `${id}: <read failed>`;
								}
							}),
						);
						this.ctx.api.log.debug(`rule bootstrap states: ${snapshots.join(' | ')}`);
					}
				}

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
				this.ctx.api.log.warn(`rule init failed for '${targetId}': ${e?.message || e}`);
			}
		}

		await this.ctx.meta.managedObjects.applyReported();

		await this._syncPresetSubscriptions(nextPresetIds);

		const objDiff = IngestStatesEngine._setDiff(this._watchedObjectIds, nextWatchedObjectIds);
		if (objDiff.added.length) {
			this._subscribeObjects(objDiff.added);
		}
		if (objDiff.removed.length) {
			this._unsubscribeObjects(objDiff.removed);
		}

		const stateDiff = IngestStatesEngine._setDiff(this._subscribedStateIds, nextSubscribedStateIds);
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
				`${this._prefix()}rescan(${reason}) targets=${this._rulesByTargetId.size}, requiredStates=${this._subscribedStateIds.size}, watchedObjects=${this._watchedObjectIds.size}, presets=${this._presetSubscribedStateIds.size}`,
			);
		}
	}

	/**
	 * Extract preset ids from a normalized `cfg.msg` block.
	 *
	 * This is intentionally field-neutral: every `msg.<Something>Id` key is treated as a potential preset selector.
	 *
	 * @param {any} msgCfg Normalized message config (`cfg.msg`).
	 * @returns {string[]} Preset ids.
	 */
	_extractPresetIds(msgCfg) {
		if (!msgCfg || typeof msgCfg !== 'object' || Array.isArray(msgCfg)) {
			return [];
		}

		const out = [];
		for (const [k, v] of Object.entries(msgCfg)) {
			const key = typeof k === 'string' ? k.trim() : '';
			if (!key || !key.endsWith('Id')) {
				continue;
			}
			const id = typeof v === 'string' ? v.trim() : '';
			if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
				continue;
			}
			out.push(id);
		}
		return out;
	}

	/**
	 * Extract preset key -> preset id references from a normalized `cfg.msg` block.
	 *
	 * Unlike `_extractPresetIds`, this keeps the *key* information so the caller can create
	 * per-message-line writers even when multiple keys point to the same preset id (e.g. session start/end).
	 *
	 * Semantics:
	 * - Only considers keys that end with `Id` (field-neutral).
	 * - Returns `presetId: ''` when the value is missing or not a valid preset id token.
	 *
	 * @param {any} msgCfg Normalized message config (`cfg.msg`).
	 * @returns {Array<{ presetKey: string, presetId: string }>} List of references.
	 */
	_extractPresetRefs(msgCfg) {
		if (!msgCfg || typeof msgCfg !== 'object' || Array.isArray(msgCfg)) {
			return [];
		}

		const out = [];
		for (const [k, v] of Object.entries(msgCfg)) {
			const presetKey = typeof k === 'string' ? k.trim() : '';
			if (!presetKey || !presetKey.endsWith('Id')) {
				continue;
			}

			const raw = typeof v === 'string' ? v.trim() : '';
			const presetId = raw && /^[A-Za-z0-9_-]+$/.test(raw) ? raw : '';
			out.push({ presetKey, presetId });
		}
		return out;
	}

	/**
	 * @returns {string} Preset state id prefix for this adapter instance.
	 */
	_presetStatePrefix() {
		const nsKey = this.ctx.api.iobroker.ids.namespace;
		return `${nsKey}.IngestStates.0.presets.`;
	}

	/**
	 * @param {string} presetId Preset id token.
	 * @returns {string} Full state id.
	 */
	_presetStateId(presetId) {
		return `${this._presetStatePrefix()}${presetId}`;
	}

	/**
	 * Read-only preset provider for MessageWriter.
	 *
	 * @param {any} presetId Preset id token.
	 * @returns {any|null} Preset object or null when not loaded/invalid/missing.
	 */
	_getPresetFromCache(presetId) {
		const id = typeof presetId === 'string' ? presetId.trim() : '';
		if (!id) {
			return null;
		}
		return this._presetCache.has(id) ? this._presetCache.get(id) : null;
	}

	/**
	 * Keep preset state subscriptions + cache in sync with the current custom configs.
	 *
	 * @param {Set<string>} nextPresetIds Preset ids referenced by any enabled rule.
	 * @returns {Promise<void>} Resolves after best-effort sync.
	 */
	async _syncPresetSubscriptions(nextPresetIds) {
		if (!this._running) {
			return;
		}

		const nextStateIds = new Set();
		for (const presetId of nextPresetIds) {
			nextStateIds.add(this._presetStateId(presetId));
		}

		const diff = IngestStatesEngine._setDiff(this._presetSubscribedStateIds, nextStateIds);
		if (diff.added.length) {
			this._subscribeStates(diff.added);
		}
		if (diff.removed.length) {
			this._unsubscribeStates(diff.removed);
		}

		// Drop removed presets from cache to keep memory bounded.
		for (const stateId of diff.removed) {
			if (typeof stateId !== 'string') {
				continue;
			}
			const prefix = this._presetStatePrefix();
			if (!stateId.startsWith(prefix)) {
				continue;
			}
			const presetId = stateId.slice(prefix.length);
			this._presetCache.delete(presetId);
		}

		this._presetSubscribedStateIds = nextStateIds;

		// Load newly referenced presets right away (best-effort), so they are available in the cache
		// before the next event.
		const toLoad = [];
		for (const presetId of nextPresetIds) {
			if (!this._presetCache.has(presetId)) {
				toLoad.push(presetId);
			}
		}
		if (toLoad.length === 0) {
			return;
		}

		await Promise.all(
			toLoad.map(async presetId => {
				const resolved = await this._presetResolver.resolvePreset(presetId);
				const had = this._presetCache.has(presetId);
				this._presetCache.set(presetId, resolved ? resolved.preset : null);
				this._tracePresetCacheEvent({
					event: had ? 'update' : 'add',
					presetId,
					reason: 'rescan',
					preset: resolved ? resolved.preset : null,
					objectId: resolved ? resolved.objectId : null,
				});
			}),
		);
	}

	/**
	 * Detect preset state updates and refresh the cache.
	 *
	 * @param {string} id State id.
	 * @returns {void}
	 */
	_handlePresetStateChange(id) {
		const stateId = typeof id === 'string' ? id : '';
		if (!stateId || !this._presetSubscribedStateIds.has(stateId) || !this._queue) {
			return;
		}

		const prefix = this._presetStatePrefix();
		if (!stateId.startsWith(prefix)) {
			return;
		}
		const presetId = stateId.slice(prefix.length);
		if (!presetId) {
			return;
		}

		void this._queue(() => this._reloadPreset(presetId, 'stateChange')).catch(() => undefined);
	}

	/**
	 * Reload a preset into the cache (best-effort).
	 *
	 * @param {string} presetId Preset id token.
	 * @param {string} reason Trigger reason (debug).
	 * @returns {Promise<void>} Resolves after reload attempt.
	 */
	async _reloadPreset(presetId, reason) {
		const id = typeof presetId === 'string' ? presetId.trim() : '';
		if (!id) {
			return;
		}
		const resolved = await this._presetResolver.resolvePreset(id);
		const had = this._presetCache.has(id);
		this._presetCache.set(id, resolved ? resolved.preset : null);
		this._tracePresetCacheEvent({
			event: had ? 'update' : 'add',
			presetId: id,
			reason,
			preset: resolved ? resolved.preset : null,
			objectId: resolved ? resolved.objectId : null,
		});
	}

	/**
	 * Trace preset cache changes for diagnosis (best-effort).
	 *
	 * Note: This is intentionally gated behind `traceEvents` because preset JSON can be large.
	 *
	 * @param {object} info Info.
	 * @param {'add'|'update'} info.event Event type.
	 * @param {string} info.presetId Preset id token.
	 * @param {string} info.reason Trigger reason (debug).
	 * @param {any|null} info.preset Preset JSON object (parsed) or null.
	 * @param {string|null} info.objectId Full ioBroker state id (when known).
	 * @returns {void}
	 */
	_tracePresetCacheEvent({ event, presetId, reason, preset, objectId = null }) {
		if (!this._traceEnabled() || typeof this.ctx?.api?.log?.debug !== 'function') {
			return;
		}
		const ev = event === 'add' ? 'added' : 'updated';
		const oid = typeof objectId === 'string' && objectId.trim() ? objectId.trim() : null;
		const src = oid ? ` objectId='${oid}'` : '';
		const payload = IngestStatesEngine._safeJson(preset);
		this.ctx.api.log.debug(
			`${this._prefix()}preset cache ${ev}: presetId='${presetId}' reason='${reason}'${src} preset=${payload}`,
		);
	}

	/**
	 * Create a rule instance for the selected mode.
	 *
	 * @param {object} info Rule inputs.
	 * @param {object} info.ctx Plugin runtime context.
	 * @param {string} info.targetId Target object/state id.
	 * @param {object} info.cfg Normalized custom config.
	 * @param {Record<string, object>} [info.messageWritersByPresetKey]  presetId -> writer map.
	 * @returns {object} Rule instance.
	 */
	_createRule({ ctx, targetId, cfg, messageWritersByPresetKey }) {
		const traceEvents = this._traceEnabled();
		const mode = typeof cfg.mode === 'string' ? cfg.mode.trim() : '';

		if (mode === 'freshness') {
			return new FreshnessRule({
				ctx,
				targetId,
				ruleConfig: cfg.fresh,
				messageWritersByPresetKey,
				traceEvents,
			});
		}

		if (mode === 'threshold') {
			return new ThresholdRule({
				ctx,
				targetId,
				ruleConfig: cfg.thr,
				messageWritersByPresetKey,
				timers: this._timers,
				traceEvents,
			});
		} /*
			if (mode === 'triggered') {
				return new TriggeredRule({
					targetId,
					ruleConfig: cfg.trg,
					message,
					messageWritersByPresetKey,
					timers: this._timers,
					traceEvents,
				});
			}
			if (mode === 'nonSettling') {
				return new NonSettlingRule({
					targetId,
					ruleConfig: cfg.nonset,
					message,
					messageWritersByPresetKey,
					timers: this._timers,
					traceEvents,
				});
			}
			if (mode === 'session') {
				return new SessionRule({
					targetId,
					ruleConfig: cfg.sess,
					message,
					messageWritersByPresetKey,
					timers: this._timers,
					traceEvents,
				});
			} */

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
			this.ctx.api.log.warn(`timer handling failed: ${e?.message || e}`);
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
				this.ctx.api.log.warn(`subscribeForeignStates('${id}') failed: ${e?.message || e}`);
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
				this.ctx.api.log.warn(`unsubscribeForeignStates('${id}') failed: ${e?.message || e}`);
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
				this.ctx.api.log.warn(`subscribeForeignObjects('${id}') failed: ${e?.message || e}`);
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
				this.ctx.api.log.warn(`unsubscribeForeignObjects('${id}') failed: ${e?.message || e}`);
			}
		}
	}
}

module.exports = { IngestStatesEngine };
