'use strict';

const ROOMS_CACHE_BY_META = new WeakMap();

/**
 * Central message rendering/writing helper for rule instances.
 *
 * This is intentionally rule-agnostic: rules provide their live data and the writer
 * is responsible for standard texts, timing mappings, and store patches.
 *
 * (Implementation is added step-by-step; this file currently provides a skeleton.)
 */
class MessageWriter {
	/**
	 * @param {object} ctx Plugin runtime context.
	 * @param {object} [options] Plugin options.
	 */
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		this.options = options || {};
		this._traceEvents =
			ctx?.meta?.options?.resolveBool?.('traceEvents', this.options.traceEvents) === true ||
			this.options.traceEvents === true;
	}

	/**
	 * Create a per-target writer instance.
	 *
	 * @param {object} info Target context.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {string} info.ruleType Rule type / mode (e.g. `freshness`).
	 * @param {object} [info.messageConfig] Message config (from `msg-*` keys).
	 * @param {object} [info.startMessageConfig] Optional session start message config (from `msg-sessionStart*` keys).
	 * @returns {TargetMessageWriter} Target writer.
	 */
	forTarget({ targetId, ruleType, messageConfig = {}, startMessageConfig = null }) {
		return new TargetMessageWriter(this.ctx, {
			targetId,
			ruleType,
			messageConfig,
			startMessageConfig,
			traceEvents: this._traceEvents,
		});
	}
}

/**
 * Per-target message writer helper.
 */
class TargetMessageWriter {
	/**
	 * @param {object} ctx Plugin runtime context.
	 * @param {object} info Target inputs.
	 * @param {string} info.targetId Monitored object/state id.
	 * @param {string} info.ruleType Rule type / mode (e.g. `freshness`).
	 * @param {object} [info.messageConfig] Message config (from `msg-*` keys).
	 * @param {object} [info.startMessageConfig] Optional session start message config (from `msg-sessionStart*` keys).
	 * @param {boolean} [info.traceEvents] Enable verbose debug logging.
	 */
	constructor(ctx, { targetId, ruleType, messageConfig, startMessageConfig, traceEvents = false }) {
		this.ctx = ctx;
		this.targetId = targetId;
		this.ruleType = ruleType;
		this.messageConfig = messageConfig || {};
		this.startMessageConfig = startMessageConfig || null;
		this._traceEvents = traceEvents === true;
		this._log = ctx?.api?.log || null;
		this._lastMetricsPatchAt = 0;
		this._lastStartMetricsPatchAt = 0;
		this._locationPatchScheduled = false;
	}

	/**
	 * @param {string} msg Debug message.
	 * @returns {void}
	 */
	_trace(msg) {
		if (!this._traceEvents || typeof this._log?.debug !== 'function') {
			return;
		}
		this._log.debug(`MessageWriter: ${msg}`);
	}

	/**
	 * @param {string} op Operation name.
	 * @param {string} ref Message ref.
	 * @param {object} [patch] Patch object.
	 * @returns {void}
	 */
	_traceStore(op, ref, patch = undefined) {
		if (!this._traceEvents || typeof this._log?.debug !== 'function') {
			return;
		}
		const keys =
			patch && typeof patch === 'object' && !Array.isArray(patch)
				? Object.keys(patch).slice(0, 12).join(',')
				: '';
		const keySuffix = keys ? ` keys=[${keys}]` : '';
		this._trace(`${op} ref='${ref}'${keySuffix}`);
	}

	/**
	 * @param {string} kind Message kind.
	 * @returns {boolean} True when kind is `task`.
	 */
	_isTaskKind(kind) {
		const task = this.ctx?.api?.constants?.kind?.task || 'task';
		return kind === task || kind === 'task';
	}

	/**
	 * Resolve task-only timing fields from config.
	 *
	 * @param {object} info Timing inputs.
	 * @param {string} info.kind Message kind.
	 * @param {number} info.now Current timestamp in ms.
	 * @returns {{ dueAt: number|null, timeBudget: number|null }|null} Timing patch.
	 */
	_taskTimingForOpen({ kind, now }) {
		if (!this._isTaskKind(kind)) {
			return null;
		}

		const timeBudgetMs = this._getDurationMs('taskTimeBudget', 'taskTimeBudgetUnit');
		const dueInMs = this._getDurationMs('taskDueIn', 'taskDueInUnit');

		const patch = {};
		if (timeBudgetMs > 0) {
			patch.timeBudget = timeBudgetMs;
		}
		if (dueInMs > 0) {
			patch.dueAt = now + dueInMs;
		}

		return patch;
	}

	/**
	 * Resolve task-only timing fields for updates without shifting the due date.
	 *
	 * @param {object} info Timing inputs.
	 * @param {string} info.kind Message kind.
	 * @param {number} info.now Current timestamp in ms.
	 * @param {object} [info.existingTiming] Existing timing object.
	 * @returns {{ dueAt?: number|null, timeBudget: number|null }|null} Timing patch.
	 */
	_taskTimingForUpdate({ kind, now, existingTiming = null }) {
		if (!this._isTaskKind(kind)) {
			return null;
		}

		const timeBudgetMs = this._getDurationMs('taskTimeBudget', 'taskTimeBudgetUnit');
		const dueInMs = this._getDurationMs('taskDueIn', 'taskDueInUnit');
		const existingDueAt = existingTiming && typeof existingTiming === 'object' ? existingTiming.dueAt : undefined;
		const existingTimeBudget =
			existingTiming && typeof existingTiming === 'object' ? existingTiming.timeBudget : undefined;

		const patch = {};
		if (timeBudgetMs > 0 || Number.isFinite(existingTimeBudget)) {
			patch.timeBudget = timeBudgetMs > 0 ? timeBudgetMs : null;
		}

		if (typeof existingDueAt !== 'number' || !Number.isFinite(existingDueAt)) {
			if (dueInMs > 0) {
				patch.dueAt = now + dueInMs;
			}
		} else if (dueInMs <= 0) {
			patch.dueAt = null;
		}

		return patch;
	}

	/**
	 * @returns {{ byMember: Map<string, string>, inFlight: Promise<void>|null, loadedAt: number }} Shared rooms cache.
	 */
	_roomsCache() {
		const meta = this.ctx?.meta;
		if (!meta || typeof meta !== 'object') {
			return { byMember: new Map(), inFlight: null, loadedAt: 0 };
		}

		let cache = ROOMS_CACHE_BY_META.get(meta);
		if (!cache) {
			cache = { byMember: new Map(), inFlight: null, loadedAt: 0 };
			ROOMS_CACHE_BY_META.set(meta, cache);
		}

		return cache;
	}

	/**
	 * @param {any} value Multilang string or string.
	 * @returns {string} Best-effort translated string.
	 */
	_translatedObjectString(value) {
		if (typeof value === 'string') {
			return value;
		}
		if (!value || typeof value !== 'object') {
			return '';
		}
		const preferred = value['en'] || value['de'];
		if (typeof preferred === 'string') {
			return preferred;
		}
		for (const v of Object.values(value)) {
			if (typeof v === 'string' && v.trim()) {
				return v;
			}
		}
		return '';
	}

	/**
	 * Best-effort: build a cache of `enum.rooms.*` memberships.
	 *
	 * @returns {void}
	 */
	_ensureRoomsIndexLoaded() {
		const cache = this._roomsCache();
		if (cache.inFlight || cache.loadedAt) {
			return;
		}

		const getForeignObjects = this.ctx?.api?.iobroker?.objects?.getForeignObjects;
		if (typeof getForeignObjects !== 'function') {
			cache.loadedAt = Date.now();
			return;
		}

		const buildIndex = enums => {
			const next = new Map();
			for (const obj of Object.values(enums || {})) {
				if (!obj || obj.type !== 'enum') {
					continue;
				}
				const members = obj?.common?.members;
				if (!Array.isArray(members) || members.length === 0) {
					continue;
				}

				const roomName = this._translatedObjectString(obj.common?.name) || obj._id || '';
				if (!roomName) {
					continue;
				}

				for (const member of members) {
					if (typeof member !== 'string' || !member || next.has(member)) {
						continue;
					}
					next.set(member, roomName);
				}
			}
			cache.byMember = next;
			cache.loadedAt = Date.now();
		};

		try {
			const res = getForeignObjects('enum.rooms.*', 'enum');
			if (res && typeof res.then === 'function') {
				cache.inFlight = Promise.resolve(res)
					.then(buildIndex)
					.catch(() => {
						cache.loadedAt = Date.now();
					})
					.finally(() => {
						cache.inFlight = null;
					});
				return;
			}
			buildIndex(res);
		} catch {
			cache.loadedAt = Date.now();
		}
	}

	/**
	 * @param {string} id State/object id.
	 * @returns {string} Best-effort room name based on `enum.rooms.*` membership.
	 */
	_resolveRoomName(id) {
		this._ensureRoomsIndexLoaded();

		const byMember = this._roomsCache().byMember;
		for (let cur = id; cur && cur.includes('.'); cur = cur.slice(0, cur.lastIndexOf('.'))) {
			const room = byMember.get(cur);
			if (room) {
				return room;
			}
		}
		return '';
	}

	/**
	 * @param {unknown} value Candidate object.
	 * @returns {boolean} True when `value` is a plain object.
	 */
	_isPlainObject(value) {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	/**
	 * @param {object} a Plain object.
	 * @param {object} b Plain object.
	 * @returns {boolean} Shallow equality.
	 */
	_shallowEqual(a, b) {
		const aKeys = Object.keys(a);
		const bKeys = Object.keys(b);
		if (aKeys.length !== bKeys.length) {
			return false;
		}
		for (const k of aKeys) {
			if (!Object.prototype.hasOwnProperty.call(b, k) || a[k] !== b[k]) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Merge details and add `details.location` from `enum.rooms.*` when available.
	 *
	 * Note: patches replace the full `details` object; always merge with `existing.details`.
	 *
	 * @param {object} [info] Details merge inputs.
	 * @param {object} [info.existingDetails] Existing message details.
	 * @param {object} [info.nextDetails] Rule-provided details.
	 * @returns {object|null} Details patch, or null when nothing should be patched.
	 */
	_mergeDetailsWithLocation({ existingDetails = null, nextDetails = undefined } = {}) {
		const existing = this._isPlainObject(existingDetails) ? existingDetails : null;
		const incoming = this._isPlainObject(nextDetails) ? nextDetails : null;

		const room = this._resolveRoomName(this.targetId);
		if (!room && !incoming) {
			return null;
		}

		const merged = { ...(existing || {}), ...(incoming || {}) };
		if (room && (!merged.location || typeof merged.location !== 'string' || !merged.location.trim())) {
			merged.location = room;
		}

		if (!existing) {
			return merged;
		}

		return this._shallowEqual(existing, merged) ? null : merged;
	}

	/**
	 * Best-effort: if room enums are still loading, schedule a follow-up patch that fills `details.location`
	 * once the rooms index is available.
	 *
	 * @param {string} ref Message ref to patch.
	 * @returns {void}
	 */
	_scheduleLocationPatch(ref) {
		const cache = this._roomsCache();
		if (!cache?.inFlight || this._locationPatchScheduled) {
			return;
		}
		this._locationPatchScheduled = true;

		Promise.resolve(cache.inFlight)
			.then(() => {
				this._locationPatchScheduled = false;
				this._patchLocationIfMissing(ref);
			})
			.catch(() => {
				this._locationPatchScheduled = false;
			});
	}

	/**
	 * Best-effort: patch `details.location` from `enum.rooms.*` membership when it is still missing.
	 *
	 * @param {string} ref Message ref to patch.
	 * @returns {void}
	 */
	_patchLocationIfMissing(ref) {
		try {
			const msg = this.ctx.api.store.getMessageByRef(ref, 'all');
			if (!msg) {
				return;
			}

			const details = this._isPlainObject(msg.details) ? msg.details : null;
			const existingLocation = typeof details?.location === 'string' ? details.location.trim() : '';
			if (existingLocation) {
				return;
			}

			const room = this._resolveRoomName(this.targetId);
			if (!room) {
				return;
			}

			const merged = { ...(details || {}) };
			merged.location = room;

			this.ctx.api.store.updateMessage(ref, { details: merged });
		} catch {
			// must never break rule processing
		}
	}

	/**
	 * @returns {boolean} True when session start message is enabled.
	 */
	isSessionStartEnabled() {
		return this.messageConfig?.sessionStartEnabled === true;
	}

	/**
	 * @param {unknown} value CSV string.
	 * @returns {string[]} Unique, trimmed list.
	 */
	_parseCsvList(value) {
		if (typeof value !== 'string') {
			return [];
		}

		const items = value
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);

		return Array.from(new Set(items));
	}

	/**
	 * @param {object} info Audience inputs.
	 * @param {string} [info.tagsCsv] Comma-separated tag list.
	 * @param {string} [info.channelsCsv] Comma-separated channel list.
	 * @returns {object|undefined} Normalized `message.audience` object.
	 */
	_buildAudience({ tagsCsv, channelsCsv }) {
		const tags = this._parseCsvList(tagsCsv);
		const channels = this._parseCsvList(channelsCsv);

		if (tags.length === 0 && channels.length === 0) {
			return undefined;
		}

		const audience = {};
		if (tags.length) {
			audience.tags = tags;
		}
		if (channels.length) {
			audience.channels = { include: channels };
		}
		return audience;
	}

	/**
	 * @param {string} [suffix] Optional suffix (e.g. `_start`).
	 * @returns {string} Stable message ref.
	 */
	makeRef(suffix = '') {
		const { instanceId } = this.ctx.meta.plugin;
		return `IngestStates.${instanceId}.${this.ruleType}.${this.targetId}${suffix}`;
	}

	/**
	 * @returns {object|undefined} Normalized message audience.
	 */
	getAudience() {
		return this._buildAudience({
			tagsCsv: this.messageConfig?.audienceTags,
			channelsCsv: this.messageConfig?.audienceChannels,
		});
	}

	/**
	 * @returns {object|undefined} Normalized session start message audience.
	 */
	getStartAudience() {
		const cfg = this.startMessageConfig || this.messageConfig;
		return this._buildAudience({
			tagsCsv: cfg?.sessionStartAudienceTags,
			channelsCsv: cfg?.sessionStartAudienceChannels,
		});
	}

	/**
	 * Build message `details` from `msg-*` config.
	 *
	 * Note: this applies to the "end"/normal message only (not the session start message).
	 *
	 * @returns {object|null} Details object or null when config is empty.
	 */
	_detailsFromConfig() {
		const cfg = this.messageConfig || {};
		const out = {};

		const consumables = this._parseCsvList(cfg.consumables);
		if (consumables.length) {
			out.consumables = consumables;
		}

		const tools = this._parseCsvList(cfg.tools);
		if (tools.length) {
			out.tools = tools;
		}

		const reason = typeof cfg.reason === 'string' ? cfg.reason.trim() : '';
		if (reason) {
			out.reason = reason;
		}

		const task = typeof cfg.task === 'string' ? cfg.task.trim() : '';
		if (task) {
			out.task = task;
		}

		return Object.keys(out).length ? out : null;
	}

	/**
	 * Normalize a metrics "set" record into a store patch.
	 *
	 * @param {unknown} set Metrics set record: `{ key: { val, unit? } }`.
	 * @param {number} now Timestamp in ms.
	 * @returns {{ set: Record<string, {val: any, unit: string, ts: number}> }|null} Metrics patch or null when empty/invalid.
	 */
	_metricsPatchFromSet(set, now) {
		if (!set || typeof set !== 'object' || Array.isArray(set)) {
			return null;
		}

		const nextSet = Object.create(null);
		for (const [key, value] of Object.entries(set)) {
			if (typeof key !== 'string' || !key.trim() || key.includes('.')) {
				continue;
			}
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				continue;
			}
			nextSet[key] = {
				val: value.val,
				unit: typeof value.unit === 'string' ? value.unit : '',
				ts: now,
			};
		}

		return Object.keys(nextSet).length ? { set: nextSet } : null;
	}

	/**
	 * Normalize a metrics "set" record into a Map suitable for `MsgFactory.createMessage({ metrics })`.
	 *
	 * @param {unknown} set Metrics set record: `{ key: { val, unit? } }`.
	 * @param {number} now Timestamp in ms.
	 * @returns {Map<string, {val: any, unit: string, ts: number}>|undefined} Metrics Map, or undefined when empty/invalid.
	 */
	_metricsMapFromSet(set, now) {
		const patch = this._metricsPatchFromSet(set, now);
		if (!patch) {
			return undefined;
		}
		return new Map(Object.entries(patch.set));
	}

	/**
	 * @param {string} valueKey E.g. `remindValue`.
	 * @param {string} unitKey E.g. `remindUnit`.
	 * @returns {number} Duration in ms (0 when disabled/invalid).
	 */
	_getDurationMs(valueKey, unitKey) {
		const value = this.messageConfig?.[valueKey];
		const unitSeconds = this.messageConfig?.[unitKey];

		if (
			typeof value !== 'number' ||
			!Number.isFinite(value) ||
			value <= 0 ||
			typeof unitSeconds !== 'number' ||
			!Number.isFinite(unitSeconds) ||
			unitSeconds <= 0
		) {
			return 0;
		}

		return Math.trunc(value * unitSeconds * 1000);
	}

	/**
	 * @returns {string} Actor label for `lifecycle.stateChangedBy`.
	 */
	_actor() {
		return this.ctx?.meta?.plugin?.regId || 'IngestStates';
	}

	/**
	 * Resolve title/text for a message, preferring explicit config over rule defaults.
	 *
	 * @param {object} info Message inputs.
	 * @param {object} [info.config] Message config (from `msg-*` keys).
	 * @param {string} [info.defaultTitle] Rule-provided default title.
	 * @param {string} [info.defaultText] Rule-provided default text.
	 * @returns {{ title: string|undefined, text: string|undefined }} Resolved content.
	 */
	resolveTitleText({ config = this.messageConfig, defaultTitle, defaultText }) {
		const title = typeof config?.title === 'string' && config.title.trim() ? config.title.trim() : defaultTitle;
		const text = typeof config?.text === 'string' && config.text.trim() ? config.text.trim() : defaultText;

		return {
			title: this._unescapeNewlines(typeof title === 'string' && title.trim() ? title.trim() : undefined),
			text: this._unescapeNewlines(typeof text === 'string' && text.trim() ? text.trim() : undefined),
		};
	}

	/**
	 * Convert escaped newline sequences (`\\n`, `\\r\\n`) into real newlines.
	 *
	 * Note: `\\\\n` can be used to keep a literal `\\n` in the output.
	 *
	 * @param {string|undefined} text Input string.
	 * @returns {string|undefined} Output string.
	 */
	_unescapeNewlines(text) {
		if (typeof text !== 'string' || text.indexOf('\\') === -1) {
			return text;
		}

		const placeholder = '\u0000MSGHUB_LITERAL_NL\u0000';
		return text
			.replaceAll('\\\\n', placeholder)
			.replaceAll('\\r\\n', '\n')
			.replaceAll('\\n', '\n')
			.replaceAll(placeholder, '\\n');
	}

	/**
	 * Ensure the message is open/active.
	 *
	 * @param {object} [info] Message inputs.
	 * @param {string} [info.defaultTitle] Rule-provided default title when config is empty.
	 * @param {string} [info.defaultText] Rule-provided default text when config is empty.
	 * @param {number} [info.now] Timestamp in ms (defaults to Date.now()).
	 * @param {number} [info.startAt] Optional domain timestamp forwarded to `timing.startAt` on create.
	 * @param {number} [info.notifyAt] Override `timing.notifyAt` (defaults to `now`).
	 * @param {object} [info.details] Message details payload.
	 * @param {Record<string, {val: any, unit?: string}>} [info.metrics] Initial metrics to set (ts is set to `now`).
	 * @param {Array<object>} [info.actions] Message actions (`message.actions[]`).
	 * @returns {boolean} True when a message exists/was updated.
	 */
	openActive({
		defaultTitle,
		defaultText,
		now = Date.now(),
		startAt = undefined,
		notifyAt = undefined,
		details = undefined,
		metrics = undefined,
		actions = undefined,
	} = {}) {
		const ref = this.makeRef();
		const existing = this.ctx.api.store.getMessageByRef(ref, 'quasiOpen');
		const configDetails = this._detailsFromConfig();
		const ruleDetails = this._isPlainObject(details) ? details : null;
		const incomingDetails =
			ruleDetails || configDetails ? { ...(configDetails || {}), ...(ruleDetails || {}) } : undefined;
		const existingMetrics = existing?.metrics instanceof Map ? existing.metrics : new Map();

		let metricsPatch = this._metricsPatchFromSet(metrics, now);
		if (metricsPatch?.set && existingMetrics.size) {
			const nextSet = {};
			for (const [key, next] of Object.entries(metricsPatch.set)) {
				const prev = existingMetrics.get(key);
				const prevVal = prev?.val;
				const prevUnit = typeof prev?.unit === 'string' ? prev.unit : '';
				if (prevVal === next?.val && prevUnit === next?.unit) {
					continue;
				}
				nextSet[key] = next;
			}
			metricsPatch = Object.keys(nextSet).length ? { set: nextSet } : null;
		}

		if (existing) {
			const kind = existing?.kind || this.messageConfig?.kind || this.ctx.api.constants.kind.status;
			const patch = {};

			const taskTiming = this._taskTimingForUpdate({ kind, now, existingTiming: existing?.timing });
			if (taskTiming) {
				patch.timing = taskTiming;
			}

			const mergedDetails = this._mergeDetailsWithLocation({
				existingDetails: existing?.details,
				nextDetails: incomingDetails,
			});
			if (mergedDetails) {
				patch.details = mergedDetails;
			}
			if (metricsPatch) {
				patch.metrics = metricsPatch;
			}
			if (actions !== undefined) {
				const stableStringify = value => {
					const seen = new Set();
					const stringify = v => {
						if (v === null) {
							return 'null';
						}
						const t = typeof v;
						if (t === 'string') {
							return JSON.stringify(v);
						}
						if (t === 'number' || t === 'boolean') {
							return String(v);
						}
						if (t !== 'object') {
							return JSON.stringify(String(v));
						}
						if (seen.has(v)) {
							return '"[circular]"';
						}
						seen.add(v);
						if (Array.isArray(v)) {
							return `[${v.map(stringify).join(',')}]`;
						}
						const keys = Object.keys(v).sort();
						return `{${keys.map(k => `${JSON.stringify(k)}:${stringify(v[k])}`).join(',')}}`;
					};
					return stringify(value);
				};

				const nextActions = Array.isArray(actions) ? actions : [];
				const prevActions = Array.isArray(existing.actions) ? existing.actions : [];
				const sameActions = stableStringify(prevActions) === stableStringify(nextActions);
				if (!sameActions) {
					patch.actions = nextActions;
				}
			}

			if (Object.keys(patch).length) {
				this._traceStore('updateMessage(openActive.active)', ref, patch);
				this.ctx.api.store.updateMessage(ref, patch);
			}
			this._scheduleLocationPatch(ref);
			return true;
		}

		const { title, text } = this.resolveTitleText({ defaultTitle, defaultText });
		if (!title || !text) {
			throw new Error(`IngestStates: missing title/text defaults for '${ref}'`);
		}

		const kind = this.messageConfig?.kind || this.ctx.api.constants.kind.status;
		const level =
			typeof this.messageConfig?.level === 'number'
				? this.messageConfig.level
				: this.ctx.api.constants.level.notice;

		const remindEvery = this._getDurationMs('remindValue', 'remindUnit');
		const cooldown = this._getDurationMs('cooldownValue', 'cooldownUnit');

		const nextNotifyAt = typeof notifyAt === 'number' && Number.isFinite(notifyAt) ? Math.trunc(notifyAt) : now;
		const sysString = this.targetId.split('.').slice(0, 2).join('.') || 'IngestStates';
		const audience = this.getAudience();
		const actor = this._actor();
		const origin = { type: this.ctx.api.constants.origin.type.automation, system: sysString, id: this.targetId };
		const lifecycle = {
			state: this.ctx.api.constants.lifecycle.state.open,
			stateChangedBy: actor,
		};
		const timing = {
			notifyAt: nextNotifyAt,
			remindEvery: remindEvery > 0 ? remindEvery : undefined,
			cooldown: cooldown > 0 ? cooldown : undefined,
		};
		if (typeof startAt === 'number' && Number.isFinite(startAt)) {
			timing.startAt = Math.trunc(startAt);
		}
		const taskTiming = this._taskTimingForOpen({ kind, now });
		if (taskTiming) {
			Object.assign(timing, taskTiming);
		}
		const nextActions = Array.isArray(actions) ? actions : undefined;
		const mergedDetails = this._mergeDetailsWithLocation({
			existingDetails: existing?.details,
			nextDetails: incomingDetails,
		});
		const initialMetrics = this._metricsMapFromSet(metrics, now);

		if (!existing) {
			const created = this.ctx.api.factory.createMessage({
				ref,
				kind,
				level,
				title,
				text,
				origin,
				audience,
				...(mergedDetails ? { details: mergedDetails } : {}),
				...(initialMetrics ? { metrics: initialMetrics } : {}),
				...(nextActions !== undefined ? { actions: nextActions } : {}),
				lifecycle,
				timing,
			});
			if (!created) {
				return false;
			}
			this._traceStore('addMessage(openActive.create)', ref, created);
			const ok = this.ctx.api.store.addMessage(created);
			if (ok) {
				this._scheduleLocationPatch(ref);
			}
			return ok;
		}

		if (existing?.lifecycle?.state === this.ctx.api.constants.lifecycle.state.open) {
			return true;
		}

		const reopenPatch = {
			kind,
			level,
			title,
			text,
			origin,
			audience: audience || null,
			...(mergedDetails ? { details: mergedDetails } : {}),
			...(metricsPatch ? { metrics: metricsPatch } : {}),
			...(nextActions !== undefined ? { actions: nextActions } : {}),
			lifecycle,
			timing: {
				notifyAt: nextNotifyAt,
				remindEvery: remindEvery > 0 ? remindEvery : null,
				...(taskTiming ? taskTiming : {}),
			},
		};
		this._traceStore('updateMessage(openActive.reopen)', ref, reopenPatch);
		const ok = this.ctx.api.store.updateMessage(ref, reopenPatch);
		if (ok) {
			this._scheduleLocationPatch(ref);
		}
		return ok;
	}

	/**
	 * Resolve title/text for the session start message.
	 *
	 * @param {object} [info] Start message inputs.
	 * @param {string} [info.defaultTitle] Rule-provided default title.
	 * @param {string} [info.defaultText] Rule-provided default text.
	 * @returns {{ title: string|undefined, text: string|undefined }} Resolved content.
	 */
	resolveStartTitleText({ defaultTitle, defaultText } = {}) {
		const cfg = this.startMessageConfig || this.messageConfig || {};
		const title =
			typeof cfg?.sessionStartTitle === 'string' && cfg.sessionStartTitle.trim()
				? cfg.sessionStartTitle.trim()
				: defaultTitle;
		const text =
			typeof cfg?.sessionStartText === 'string' && cfg.sessionStartText.trim()
				? cfg.sessionStartText.trim()
				: defaultText;

		return {
			title: this._unescapeNewlines(typeof title === 'string' && title.trim() ? title.trim() : undefined),
			text: this._unescapeNewlines(typeof text === 'string' && text.trim() ? text.trim() : undefined),
		};
	}

	/**
	 * Ensure the session start message exists and is active.
	 *
	 * Note: this intentionally does not apply auto-close/close-action policies; the start message is removed
	 * by the session rule when the end message is created.
	 *
	 * @param {object} [info] Message inputs.
	 * @param {string} [info.defaultTitle] Rule-provided default title when config is empty.
	 * @param {string} [info.defaultText] Rule-provided default text when config is empty.
	 * @param {number} [info.now] Timestamp in ms (defaults to Date.now()).
	 * @param {number} [info.startAt] Optional domain timestamp forwarded to `timing.startAt` on create.
	 * @param {Array<object>} [info.actions] Message actions (`message.actions[]`).
	 * @returns {boolean} True when a message exists/was updated.
	 */
	openStartActive({ defaultTitle, defaultText, now = Date.now(), startAt = undefined, actions = undefined } = {}) {
		const ref = this.makeRef('_start');
		const existing = this.ctx.api.store.getMessageByRef(ref, 'quasiOpen');
		if (existing) {
			return true;
		}

		const { title, text } = this.resolveStartTitleText({ defaultTitle, defaultText });
		if (!title || !text) {
			throw new Error(`IngestStates: missing session start title/text defaults for '${ref}'`);
		}

		const cfg = this.startMessageConfig || this.messageConfig || {};
		const kind = cfg?.sessionStartKind || this.messageConfig?.kind || this.ctx.api.constants.kind.status;
		const level =
			typeof cfg?.sessionStartLevel === 'number'
				? cfg.sessionStartLevel
				: typeof this.messageConfig?.level === 'number'
					? this.messageConfig.level
					: this.ctx.api.constants.level.notice;
		const audience = this.getStartAudience();

		const sysString = this.targetId.split('.').slice(0, 2).join('.') || 'IngestStates';
		const origin = { type: this.ctx.api.constants.origin.type.automation, system: sysString, id: this.targetId };
		const lifecycle = {
			state: this.ctx.api.constants.lifecycle.state.open,
			stateChangedBy: this._actor(),
		};
		const remindEvery = this._getDurationMs('remindValue', 'remindUnit');
		const timing = {
			notifyAt: now,
			remindEvery: remindEvery > 0 ? remindEvery : undefined,
		};
		if (typeof startAt === 'number' && Number.isFinite(startAt)) {
			timing.startAt = Math.trunc(startAt);
		}
		const mergedDetails = this._mergeDetailsWithLocation({ existingDetails: existing?.details });

		if (!existing) {
			const created = this.ctx.api.factory.createMessage({
				ref,
				kind,
				level,
				title,
				text,
				origin,
				audience,
				...(mergedDetails ? { details: mergedDetails } : {}),
				...(actions !== undefined ? { actions } : {}),
				lifecycle,
				timing,
			});
			if (!created) {
				return false;
			}
			return this.ctx.api.store.addOrUpdateMessage(created);
		}

		return this.ctx.api.store.updateMessage(ref, {
			kind,
			level,
			title,
			text,
			origin,
			audience: audience || null,
			...(mergedDetails ? { details: mergedDetails } : {}),
			...(actions !== undefined ? { actions } : {}),
			lifecycle,
			timing: {
				notifyAt: now,
				remindEvery: remindEvery > 0 ? remindEvery : null,
			},
		});
	}

	/**
	 * Patch session start message metrics with change detection + throttling.
	 *
	 * @param {object} [info] Metrics patch inputs.
	 * @param {Record<string, {val: number|string|boolean|null, unit?: string, ts?: number}>} [info.set] Metrics to set/update.
	 * @param {string[]} [info.delete] Metric keys to delete.
	 * @param {number} [info.now] Timestamp in ms (defaults to Date.now()).
	 * @param {boolean} [info.force] When true, bypass in-memory throttling.
	 * @returns {boolean} True when a patch was applied.
	 */
	patchStartMetrics({ set = {}, delete: deleteKeys = [], now = Date.now(), force = false } = {}) {
		const maxIntervalMs = this.ctx.meta.options.resolveInt('metricsMaxIntervalMs', 60000);
		if (!Number.isFinite(maxIntervalMs) || maxIntervalMs <= 0) {
			return false;
		}

		const intervalMs = Math.min(Math.max(Math.trunc(maxIntervalMs), 5000), 1000 * 60 * 60 * 3);
		if (!force && this._lastStartMetricsPatchAt && now - this._lastStartMetricsPatchAt < intervalMs) {
			return false;
		}

		const ref = this.makeRef('_start');
		const existing = this.ctx.api.store.getMessageByRef(ref, 'quasiOpen');
		if (!existing) {
			return false;
		}

		const existingMetrics = existing?.metrics instanceof Map ? existing.metrics : new Map();
		const nextSet = {};
		for (const [key, value] of Object.entries(set || {})) {
			if (!key || typeof key !== 'string') {
				continue;
			}

			const nextVal = value?.val;
			const nextUnit = typeof value?.unit === 'string' ? value.unit : '';

			const prev = existingMetrics.get(key);
			const prevVal = prev?.val;
			const prevUnit = typeof prev?.unit === 'string' ? prev.unit : '';

			if (prevVal === nextVal && prevUnit === nextUnit) {
				continue;
			}

			nextSet[key] = { val: nextVal, unit: nextUnit, ts: now };
		}

		const deleteList = Array.isArray(deleteKeys) ? deleteKeys.filter(k => typeof k === 'string' && k.trim()) : [];
		if (Object.keys(nextSet).length === 0 && deleteList.length === 0) {
			return false;
		}

		const patch = {
			metrics: {
				set: nextSet,
				...(deleteList.length ? { delete: deleteList } : {}),
			},
		};
		this._traceStore('updateMessage(patchStartMetrics)', ref, patch);
		const ok = this.ctx.api.store.updateMessage(ref, patch);
		if (ok) {
			this._lastStartMetricsPatchAt = now;
		}
		return ok;
	}

	/**
	 * Soft-delete the session start message (best-effort).
	 *
	 * @returns {void}
	 */
	removeStartMessage() {
		const ref = this.makeRef('_start');
		try {
			this._traceStore('removeMessage(removeStartMessage)', ref);
			this.ctx.api.store.removeMessage(ref);
		} catch {
			// ignore
		}
	}

	/**
	 * Session-only: close the session end message when a new session starts (best-effort).
	 *
	 * Note: this is independent of `msg-resetOnNormal`; it is used to avoid stale end messages across sessions.
	 *
	 * @returns {boolean} True when a close patch was applied.
	 */
	closeEndOnStart() {
		const ref = this.makeRef();
		this._traceStore('completeAfterCauseEliminated(closeEndOnStart)', ref);
		return this.ctx.api.store.completeAfterCauseEliminated(ref, { actor: this._actor() });
	}

	/**
	 * Close the message when the rule returns to normal (best-effort).
	 *
	 * Note: respects `msg-resetOnNormal`:
	 * - when `false`, it keeps the message and injects a manual `close` action (so the user can dismiss it)
	 * - otherwise, it closes via `completeAfterCauseEliminated(...)`
	 *
	 * @returns {boolean} True when a close was triggered.
	 */
	closeOnNormal() {
		const ref = this.makeRef();
		const existing = this.ctx.api.store.getMessageByRef(ref, 'all');
		if (!existing) {
			return false;
		}

		if (this.messageConfig?.resetOnNormal === false) {
			const closeType = this.ctx.api.constants.actions.type.close;
			const hasClose = Array.isArray(existing.actions) && existing.actions.some(a => a?.type === closeType);
			if (hasClose) {
				return true;
			}

			const nextActions = Array.isArray(existing.actions) ? existing.actions.slice() : [];
			nextActions.push({ id: 'close', type: closeType });

			const timingPatch = {};
			if (!Number.isFinite(existing?.timing?.notifyAt)) {
				timingPatch.notifyAt = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
			}
			if (Number.isFinite(existing?.timing?.remindEvery)) {
				timingPatch.remindEvery = null;
			}

			const patch = {
				actions: nextActions,
				...(Object.keys(timingPatch).length ? { timing: timingPatch } : {}),
			};

			this._traceStore('updateMessage(closeOnNormal.addCloseAction)', ref, patch);
			return this.ctx.api.store.updateMessage(ref, patch);
		}

		const actor = this._actor();
		this._traceStore('completeAfterCauseEliminated(closeOnNormal)', ref);
		return this.ctx.api.store.completeAfterCauseEliminated(ref, { actor });
	}

	/**
	 * Patch message metrics with change detection + throttling.
	 *
	 * Throttling is in-memory (restart resets the timer); patches are silent by design (metrics don't bump `updatedAt`).
	 *
	 * @param {object} [info] Metrics patch inputs.
	 * @param {Record<string, {val: number|string|boolean|null, unit?: string, ts?: number}>} [info.set] Metrics to set/update.
	 * @param {string[]} [info.delete] Metric keys to delete.
	 * @param {number} [info.now] Timestamp in ms (defaults to Date.now()).
	 * @param {boolean} [info.force] When true, bypass in-memory throttling.
	 * @returns {boolean} True when a patch was applied.
	 */
	patchMetrics({ set = {}, delete: deleteKeys = [], now = Date.now(), force = false } = {}) {
		const maxIntervalMs = this.ctx.meta.options.resolveInt('metricsMaxIntervalMs', 60000);
		if (!Number.isFinite(maxIntervalMs) || maxIntervalMs <= 0) {
			return false;
		}

		const intervalMs = Math.min(Math.max(Math.trunc(maxIntervalMs), 5000), 1000 * 60 * 60 * 3);
		if (!force && this._lastMetricsPatchAt && now - this._lastMetricsPatchAt < intervalMs) {
			return false;
		}

		const ref = this.makeRef();
		const existing = this.ctx.api.store.getMessageByRef(ref, 'quasiOpen');
		if (!existing) {
			return false;
		}

		const nextSet = {};
		const existingMetrics = existing?.metrics instanceof Map ? existing.metrics : new Map();

		for (const [key, value] of Object.entries(set || {})) {
			if (typeof key !== 'string' || !key.trim() || !value || typeof value !== 'object') {
				continue;
			}

			const nextVal = value.val;
			const nextUnit = typeof value.unit === 'string' ? value.unit : '';

			const prev = existingMetrics.get(key);
			const prevVal = prev?.val;
			const prevUnit = typeof prev?.unit === 'string' ? prev.unit : '';

			if (prevVal === nextVal && prevUnit === nextUnit) {
				continue;
			}

			nextSet[key] = { val: nextVal, unit: nextUnit, ts: now };
		}

		const deleteList = Array.isArray(deleteKeys) ? deleteKeys.filter(k => typeof k === 'string' && k.trim()) : [];

		if (Object.keys(nextSet).length === 0 && deleteList.length === 0) {
			return false;
		}

		const patch = {
			metrics: {
				set: nextSet,
				...(deleteList.length ? { delete: deleteList } : {}),
			},
		};
		this._traceStore('updateMessage(patchMetrics)', ref, patch);
		const ok = this.ctx.api.store.updateMessage(ref, patch);
		if (ok) {
			this._lastMetricsPatchAt = now;
		}
		return ok;
	}

	/**
	 * @returns {void}
	 */
	dispose() {}
}

module.exports = { MessageWriter, TargetMessageWriter };
