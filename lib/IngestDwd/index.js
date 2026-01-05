'use strict';

const crypto = require('node:crypto');

const { ensureCtxAvailability } = require('../IoPluginGuards');
const { manifest } = require('./manifest');

function IngestDwd(options = {}) {
	let started = false;

	let log = null;
	let iobroker = null;
	let store = null;
	let factory = null;
	let constants = null;
	let resources = null;
	let managedObjects = null;
	let pluginInfo = null;
	let ai = null;

	let cfg = null;
	let watched = [];
	let syncTimer = null;

	const HUGE_REMIND_EVERY_MS = 10 * 365 * 24 * 60 * 60 * 1000;

	const toCsvList = s =>
		String(s || '')
			.split(',')
			.map(x => x.trim())
			.filter(Boolean);

	const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

	const parseWarningObject = val => {
		if (!val) {
			return null;
		}
		if (isPlainObject(val)) {
			return val;
		}
		if (typeof val === 'string' && val.trim()) {
			try {
				const parsed = JSON.parse(val);
				return isPlainObject(parsed) ? parsed : null;
			} catch {
				return null;
			}
		}
		return null;
	};

	const isEmptyObject = obj => isPlainObject(obj) && Object.keys(obj).length === 0;

	const normalizeNumber = v => {
		if (v === null || v === undefined) {
			return null;
		}
		const n = typeof v === 'number' ? v : Number(v);
		return Number.isFinite(n) ? n : null;
	};

	const computeStableHash = warning => {
		const stable = Object.freeze({
			state: typeof warning?.state === 'string' ? warning.state : '',
			type: normalizeNumber(warning?.type),
			level: normalizeNumber(warning?.level),
			regionName: typeof warning?.regionName === 'string' ? warning.regionName : '',
			description: typeof warning?.description === 'string' ? warning.description : '',
			event: typeof warning?.event === 'string' ? warning.event : '',
			headline: typeof warning?.headline === 'string' ? warning.headline : '',
			stateShort: typeof warning?.stateShort === 'string' ? warning.stateShort : '',
			altitudeStart: normalizeNumber(warning?.altitudeStart),
			altitudeEnd: normalizeNumber(warning?.altitudeEnd),
		});

		const text = JSON.stringify(stable);
		return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
	};

	const refPrefix = () => `${pluginInfo.type}.${pluginInfo.instanceId}.`;

	const warningRef = hash => `${refPrefix()}${hash}`;

	const computeLevel = warningLevel => {
		const v = normalizeNumber(warningLevel);
		if (v === null) {
			return constants.level.notice;
		}
		if (v <= 0) {
			return constants.level.none;
		}
		if (v === 1 || v === 2) {
			return constants.level.notice;
		}
		if (v === 3 || v === 4) {
			return constants.level.warning;
		}
		return constants.level.warning;
	};

	const matchesAltitude = warning => {
		if (!cfg.useAltitudeFilter) {
			return true;
		}
		const a = normalizeNumber(cfg.altitudeM);
		if (a === null) {
			return true;
		}
		const start = normalizeNumber(warning?.altitudeStart);
		const end = normalizeNumber(warning?.altitudeEnd);
		if (start === null || end === null) {
			return true;
		}
		return start <= a && a <= end;
	};

	const buildAudience = () => {
		const tags = toCsvList(cfg.audienceTagsCsv);
		const include = toCsvList(cfg.audienceChannelsIncludeCsv);
		const exclude = toCsvList(cfg.audienceChannelsExcludeCsv);

		if (tags.length === 0 && include.length === 0 && exclude.length === 0) {
			return undefined;
		}

		const out = {};
		if (tags.length > 0) {
			out.tags = tags;
		}
		if (include.length > 0 || exclude.length > 0) {
			out.channels = {};
			if (include.length > 0) {
				out.channels.include = include;
			}
			if (exclude.length > 0) {
				out.channels.exclude = exclude;
			}
		}
		return out;
	};

	const cacheOwnId = () => `${pluginInfo.baseOwnId}.aiCache`;
	const cacheFullId = () => iobroker.ids.toFullId(cacheOwnId());

	const ensureCacheState = async () => {
		await iobroker.objects.setObjectNotExists(cacheOwnId(), {
			type: 'state',
			common: {
				name: 'AI cache (IngestDwd)',
				type: 'string',
				role: 'json',
				read: true,
				write: false,
			},
			native: {},
		});
	};

	const loadCache = async () => {
		await ensureCacheState();
		const st = await iobroker.states.getForeignState(cacheFullId());
		const raw = st?.val;
		if (!raw) {
			return { version: 1, entries: {} };
		}
		try {
			const parsed = JSON.parse(String(raw));
			if (!isPlainObject(parsed) || !isPlainObject(parsed.entries)) {
				return { version: 1, entries: {} };
			}
			return { version: 1, entries: parsed.entries };
		} catch {
			return { version: 1, entries: {} };
		}
	};

	const saveCache = async cache => {
		await ensureCacheState();
		await iobroker.states.setState(cacheOwnId(), {
			val: JSON.stringify(cache || { version: 1, entries: {} }),
			ack: true,
		});
	};

	const maybeAiSummarize = async ({ cache, key, input, purpose }) => {
		if (!cfg.aiEnhancement) {
			return null;
		}
		if (!input || typeof input !== 'string' || !input.trim()) {
			return null;
		}
		if (!ai || typeof ai.getStatus !== 'function' || typeof ai.text !== 'function') {
			return null;
		}
		if (ai.getStatus()?.enabled !== true) {
			return null;
		}

		const entry = cache.entries[key];
		if (entry && entry.in === input && typeof entry.out === 'string' && entry.out.trim()) {
			log.debug(`IngestDwd: aiEnhancement purpose='${purpose}' key='${key}' fromCache=true out='${entry.out}'`);
			return entry.out;
		}

		const res = await ai.text({
			purpose,
			hints: { quality: 'fast', temperature: 0.2, maxTokens: 140 },
			cache: { key: `${pluginInfo.regId}:${purpose}:${key}`, ttlMs: 1000 * 60 * 60 * 24 },
			messages: [
				{
					role: 'system',
					content:
						'Du fasst DWD-Wetterwarnungen zusammen. Antworte als kurzer deutscher Text (max. 200 Zeichen), ohne Anführungszeichen.',
				},
				{ role: 'user', content: input },
			],
		});

		const out = res?.ok && typeof res.value === 'string' ? res.value.trim() : '';
		if (!out) {
			return null;
		}

		log.debug(`IngestDwd: aiEnhancement purpose='${purpose}' key='${key}' fromCache=false out='${out}'`);
		cache.entries[key] = { in: input, out, updatedAt: Date.now() };
		return out;
	};

	const buildDetails = (warning, { taskText }) => {
		const region = typeof warning?.regionName === 'string' ? warning.regionName.trim() : '';
		const state = typeof warning?.state === 'string' ? warning.state.trim() : '';

		const start = normalizeNumber(warning?.altitudeStart);
		const end = normalizeNumber(warning?.altitudeEnd);
		const altitude =
			start !== null && end !== null ? `${Math.trunc(start)}-${Math.trunc(end)}m` : '';

		const base = [region, state].filter(Boolean).join(', ');
		const location = base ? (altitude ? `${base} (${altitude})` : base) : altitude ? altitude : '';

		const out = {
			reason: 'Wetterbedingung',
			...(location ? { location } : {}),
		};

		if (taskText) {
			out.task = taskText;
		}

		return out;
	};

	const farFutureNotifyAt = () => Date.now() + HUGE_REMIND_EVERY_MS;

	const ensureNotifyAtFiniteAfterImmediateDue = ref => {
		// When we create a message with notifyAt omitted, MsgStore dispatches an immediate "due".
		// To avoid later due-on-update semantics, we ensure notifyAt becomes a finite number.
		store.updateMessage(ref, { timing: { notifyAt: farFutureNotifyAt() } });
	};

	const buildActions = () => [
		{ type: constants.actions.type.ack, id: 'ack' },
		{ type: constants.actions.type.snooze, id: 'snooze1h', payload: { forMs: 60 * 60 * 1000 } },
	];

	const upsertWarning = async (warning, { cache }) => {
		const now = Date.now();
		const start = normalizeNumber(warning?.start);
		const end = normalizeNumber(warning?.end);

		const hash = computeStableHash(warning);
		const ref = warningRef(hash);

		const headline = typeof warning?.headline === 'string' ? warning.headline.trim() : '';
		const description = typeof warning?.description === 'string' ? warning.description.trim() : '';
		const instruction = typeof warning?.instruction === 'string' ? warning.instruction.trim() : '';

		const aiText = await maybeAiSummarize({
			cache,
			key: `${hash}:text`,
			input: description || headline,
			purpose: 'dwd.summary.text',
		});
		const aiTask = await maybeAiSummarize({
			cache,
			key: `${hash}:task`,
			input: instruction,
			purpose: 'dwd.summary.task',
		});

		const title = headline || (typeof warning?.event === 'string' ? warning.event.trim() : '') || ref;
		const text = aiText || description;
		const taskText = aiTask || instruction;

		const timing = {
			...(end !== null ? { expiresAt: end } : {}),
			remindEvery: HUGE_REMIND_EVERY_MS,
			...(start !== null && start > now ? { notifyAt: start } : {}),
		};

		const audience = buildAudience();
		const details = buildDetails(warning, { taskText });
		const actions = buildActions();
		const level = computeLevel(warning?.level);

		const existing = store.getMessageByRef(ref);
		if (!existing) {
			const msg = factory.createMessage({
				ref,
				title,
				text,
				level,
				kind: constants.kind.status,
				origin: { type: constants.origin.type.import, system: cfg.dwdInstance, id: hash },
				timing,
				details,
				actions,
				audience,
			});
			if (!msg) {
				return null;
			}
			const ok = store.addMessage(msg);
			if (!ok) {
				return null;
			}
			log.debug(`IngestDwd: new warning hash='${hash}' ref='${ref}' title='${title}'`);
			if (!(start !== null && start > now)) {
				ensureNotifyAtFiniteAfterImmediateDue(ref);
			}
			return ref;
		}

		// If a warning's start timestamp moved into the past but we still have a future notifyAt,
		// ensure it becomes due soon (without using due-on-update semantics).
		const existingNotifyAt =
			typeof existing?.timing?.notifyAt === 'number' && Number.isFinite(existing.timing.notifyAt)
				? existing.timing.notifyAt
				: null;
		const needsDueNow = start !== null && start <= now && existingNotifyAt !== null && existingNotifyAt > now;
		const timingPatch = {
			...(end !== null ? { expiresAt: end } : {}),
			remindEvery: HUGE_REMIND_EVERY_MS,
			...(start !== null && start > now ? { notifyAt: start } : {}),
			...(needsDueNow ? { notifyAt: now } : {}),
		};

		store.updateMessage(ref, {
			title,
			text,
			level,
			timing: timingPatch,
			details,
			actions,
			audience,
		});

		return ref;
	};

	const listWarningStateIds = () => {
		const base = cfg.dwdInstance;
		const out = [`${base}.numberOfWarnings`];
		out.push(`${base}.warning.object`);
		for (let i = 1; i <= 9; i += 1) {
			out.push(`${base}.warning${i}.object`);
		}
		return out;
	};

	const syncNow = async () => {
		if (!started) {
			return;
		}

		const ids = listWarningStateIds();
		const states = await Promise.all(
			ids.map(id =>
				iobroker.states
					.getForeignState(id)
					.catch(e => log.warn(`IngestDwd: getForeignState failed for '${id}': ${e?.message || e}`)),
			),
		);

		const warnings = [];
		for (let i = 0; i < ids.length; i += 1) {
			const id = ids[i];
			if (!id || !/\.warning\d*\.object$/.test(id)) {
				continue;
			}
			const st = states[i];
			const obj = parseWarningObject(st?.val);
			if (!obj || isEmptyObject(obj)) {
				continue;
			}
			if (!matchesAltitude(obj)) {
				continue;
			}
			warnings.push(obj);
		}

		const cache = await loadCache();
		const activeRefs = new Set();
		for (const w of warnings) {
			const ref = await upsertWarning(w, { cache });
			if (ref) {
				activeRefs.add(ref);
			}
		}

		// Persist AI cache (only if enabled; best-effort).
		if (cfg.aiEnhancement && Object.keys(cache.entries || {}).length > 0) {
			saveCache(cache).catch(e => log.warn(`IngestDwd: saveCache failed: ${e?.message || e}`));
		}

		// Remove warnings that disappeared from DWD.
		const prefix = refPrefix();
		const existing = store.getMessages().map(m => (typeof m?.ref === 'string' ? m.ref : '')).filter(Boolean);
		for (const ref of existing) {
			if (!ref.startsWith(prefix)) {
				continue;
			}
			if (activeRefs.has(ref)) {
				continue;
			}
			log.debug(`IngestDwd: warning disappeared ref='${ref}'`);
			store.completeAfterCauseEliminated(ref, { actor: pluginInfo.regId });
		}
	};

	const scheduleSync = () => {
		if (!started) {
			return;
		}
		if (syncTimer) {
			resources.clearTimeout(syncTimer);
			syncTimer = null;
		}
		syncTimer = resources.setTimeout(() => {
			syncTimer = null;
			syncNow().catch(e => log.warn(`IngestDwd: sync failed: ${e?.message || e}`));
		}, cfg.syncDebounceMs);
	};

	const start = ctx => {
		if (started) {
			return;
		}

		ensureCtxAvailability('IngestDwd.start', ctx, {
			plainObject: [
				'api',
				'meta',
				'api.log',
				'api.iobroker',
				'api.iobroker.ids',
				'api.iobroker.objects',
				'api.iobroker.states',
				'api.iobroker.subscribe',
				'api.store',
				'api.factory',
				'api.constants',
				'meta.options',
				'meta.resources',
				'meta.plugin',
				'meta.managedObjects',
			],
			fn: [
				'api.log.debug',
				'api.log.warn',
				'api.iobroker.ids.toFullId',
				'api.iobroker.objects.setObjectNotExists',
				'api.iobroker.states.getForeignState',
				'api.iobroker.states.setState',
				'api.iobroker.subscribe.subscribeForeignStates',
				'api.iobroker.subscribe.unsubscribeForeignStates',
				'api.store.getMessageByRef',
				'api.store.getMessages',
				'api.store.addMessage',
				'api.store.updateMessage',
				'api.store.completeAfterCauseEliminated',
				'api.factory.createMessage',
				'meta.options.resolveString',
				'meta.options.resolveInt',
				'meta.options.resolveBool',
				'meta.resources.setTimeout',
				'meta.resources.clearTimeout',
				'meta.managedObjects.report',
				'meta.managedObjects.applyReported',
			],
			stringNonEmpty: ['meta.plugin.baseOwnId'],
		});

		log = ctx.api.log;
		iobroker = ctx.api.iobroker;
		store = ctx.api.store;
		factory = ctx.api.factory;
		constants = ctx.api.constants;
		resources = ctx.meta.resources;
		managedObjects = ctx.meta.managedObjects;
		pluginInfo = Object.freeze({
			type: typeof ctx?.meta?.plugin?.type === 'string' ? ctx.meta.plugin.type : 'IngestDwd',
			instanceId: Number.isFinite(ctx?.meta?.plugin?.instanceId) ? Math.trunc(ctx.meta.plugin.instanceId) : 0,
			regId: typeof ctx?.meta?.plugin?.regId === 'string' ? ctx.meta.plugin.regId : 'IngestDwd:0',
			baseOwnId: ctx.meta.plugin.baseOwnId.trim(),
		});
		ai = ctx.api.ai || null;

		cfg = Object.freeze({
			dwdInstance: ctx.meta.options.resolveString('dwdInstance', options.dwdInstance),
			useAltitudeFilter: ctx.meta.options.resolveBool('useAltitudeFilter', options.useAltitudeFilter),
			altitudeM: ctx.meta.options.resolveInt('altitudeM', options.altitudeM),
			audienceTagsCsv: ctx.meta.options.resolveString('audienceTagsCsv', options.audienceTagsCsv),
			audienceChannelsIncludeCsv: ctx.meta.options.resolveString(
				'audienceChannelsIncludeCsv',
				options.audienceChannelsIncludeCsv,
			),
			audienceChannelsExcludeCsv: ctx.meta.options.resolveString(
				'audienceChannelsExcludeCsv',
				options.audienceChannelsExcludeCsv,
			),
			aiEnhancement: ctx.meta.options.resolveBool('aiEnhancement', options.aiEnhancement),
			syncDebounceMs: ctx.meta.options.resolveInt('syncDebounceMs', options.syncDebounceMs),
		});

		watched = listWarningStateIds();
		for (const id of watched) {
			iobroker.subscribe.subscribeForeignStates(id);
		}

		managedObjects
			.report(watched, {
				managedText: 'IngestDwd',
			})
			.then(() => managedObjects.applyReported())
			.catch(() => undefined);

		started = true;
		log.debug('IngestDwd: start');
		scheduleSync();
	};

	const stop = () => {
		if (!started) {
			return;
		}
		if (syncTimer) {
			resources.clearTimeout(syncTimer);
			syncTimer = null;
		}
		for (const id of watched) {
			iobroker.subscribe.unsubscribeForeignStates(id);
		}
		watched = [];
		started = false;
	};

	const onStateChange = (id, _state, _ctx) => {
		if (!started) {
			return;
		}
		const fullId = typeof id === 'string' ? id : '';
		if (!fullId) {
			return;
		}
		if (fullId === `${cfg.dwdInstance}.numberOfWarnings` || /\.warning\d*\.object$/.test(fullId)) {
			scheduleSync();
		}
	};

	return Object.freeze({
		start,
		stop,
		onStateChange,
	});
}

module.exports = { IngestDwd, manifest };
