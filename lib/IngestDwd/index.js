'use strict';

const crypto = require('node:crypto');

const { ensureCtxAvailability } = require('../IoPluginGuards');
const { manifest } = require('./manifest');

/**
 * IngestDwd plugin factory.
 *
 * Note on language:
 * - This plugin is designed for the German Weather Service (DWD) ioBroker adapter (`dwd.X`).
 * - As a result, its built-in texts (and AI prompt) are intentionally German-first and are not localized.
 * - If you need multilingual output, implement a downstream translation step (e.g. in a Notify plugin) instead.
 *
 * @param {object} [options] Plugin options.
 * @returns {object} Plugin instance.
 */
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
	let i18n = null;

	const t = (key, ...args) => {
		if (i18n && typeof i18n.t === 'function') {
			return i18n.t(key, ...args);
		}
		return String(key);
	};

	let cfg = null;
	let watched = [];
	let syncTimer = null;
	let stabilityBackoffMs = 0;

	const SILENCE_AFTER_EXPIRE_MS = 60 * 60 * 1000;
	const CACHE_VERSION = 2;
	const AI_PURPOSE = 'dwd.enhance.v1';
	const STABILITY_GATE_DELAY_MS = 250;
	const STABILITY_GATE_MAX_BACKOFF_MS = 5000;

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
			event: typeof warning?.event === 'string' ? warning.event : '',
			headline: typeof warning?.headline === 'string' ? warning.headline : '',
			stateShort: typeof warning?.stateShort === 'string' ? warning.stateShort : '',
			altitudeStart: normalizeNumber(warning?.altitudeStart),
			altitudeEnd: normalizeNumber(warning?.altitudeEnd),
		});

		const text = JSON.stringify(stable);
		return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
	};

	const computeVariantHash = warning => {
		const normalized = Object.freeze({
			state: typeof warning?.state === 'string' ? warning.state : '',
			type: normalizeNumber(warning?.type),
			level: normalizeNumber(warning?.level),
			start: normalizeNumber(warning?.start),
			end: normalizeNumber(warning?.end),
			regionName: typeof warning?.regionName === 'string' ? warning.regionName : '',
			event: typeof warning?.event === 'string' ? warning.event : '',
			headline: typeof warning?.headline === 'string' ? warning.headline : '',
			description: typeof warning?.description === 'string' ? warning.description : '',
			instruction: typeof warning?.instruction === 'string' ? warning.instruction : '',
			stateShort: typeof warning?.stateShort === 'string' ? warning.stateShort : '',
			altitudeStart: normalizeNumber(warning?.altitudeStart),
			altitudeEnd: normalizeNumber(warning?.altitudeEnd),
		});

		const text = JSON.stringify(normalized);
		return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
	};

	const computeWarningSetFingerprint = warnings => {
		const hashes = (Array.isArray(warnings) ? warnings : [])
			.map(w => computeVariantHash(w))
			.filter(Boolean)
			.sort();
		return crypto.createHash('sha1').update(hashes.join('|')).digest('hex').slice(0, 16);
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

	const createEmptyCache = () => ({
		version: CACHE_VERSION,
		entries: {},
		order: [],
	});

	const loadCache = async () => {
		await ensureCacheState();
		const st = await iobroker.states.getForeignState(cacheFullId());
		const raw = st?.val;
		if (!raw) {
			return createEmptyCache();
		}
		try {
			const parsed = JSON.parse(String(raw));
			if (!isPlainObject(parsed)) {
				return createEmptyCache();
			}

			// v2 cache (current)
			if (parsed.version === CACHE_VERSION && isPlainObject(parsed.entries)) {
				const order = Array.isArray(parsed.order) ? parsed.order.filter(x => typeof x === 'string' && x) : [];
				return {
					version: CACHE_VERSION,
					entries: parsed.entries,
					order,
				};
			}

			// v1 cache (legacy): ignore, start fresh.
			return createEmptyCache();
		} catch {
			return createEmptyCache();
		}
	};

	const saveCache = async cache => {
		await ensureCacheState();
		const safe =
			cache && isPlainObject(cache) && isPlainObject(cache.entries)
				? {
						version: CACHE_VERSION,
						entries: cache.entries,
						order: Array.isArray(cache.order) ? cache.order : [],
					}
				: createEmptyCache();
		await iobroker.states.setState(cacheOwnId(), {
			val: JSON.stringify(safe),
			ack: true,
		});
	};

	const touchCacheRef = (cache, ref) => {
		if (!cache || !Array.isArray(cache.order)) {
			return;
		}
		cache._dirty = true;
		cache.order = cache.order.filter(x => x !== ref);
		cache.order.push(ref);

		const max =
			typeof cfg?.keepCacheHistory === 'number' && Number.isFinite(cfg.keepCacheHistory)
				? cfg.keepCacheHistory
				: 0;
		if (max > 0) {
			while (cache.order.length > max) {
				const oldest = cache.order.shift();
				if (oldest && cache.entries && Object.prototype.hasOwnProperty.call(cache.entries, oldest)) {
					delete cache.entries[oldest];
				}
			}
		}
	};

	const deleteCacheRef = (cache, ref) => {
		if (!cache || !cache.entries) {
			return;
		}
		cache._dirty = true;
		if (Object.prototype.hasOwnProperty.call(cache.entries, ref)) {
			delete cache.entries[ref];
		}
		if (Array.isArray(cache.order)) {
			cache.order = cache.order.filter(x => x !== ref);
		}
	};

	const isAiAvailable = () =>
		cfg.aiEnhancement &&
		ai &&
		typeof ai.getStatus === 'function' &&
		typeof ai.json === 'function' &&
		ai.getStatus()?.enabled === true;

	const normalizeText = v => (typeof v === 'string' ? v.replace(/\s+/gu, ' ').trim() : '');

	const formatWarningEnd = ts => {
		if (typeof ts !== 'number' || !Number.isFinite(ts)) {
			return '';
		}
		const locale = typeof i18n?.locale === 'string' && i18n.locale.trim() ? i18n.locale.trim() : 'de-DE';

		try {
			const now = Date.now();
			const isSoon = ts - now < 5 * 24 * 60 * 60 * 1000;
			if (isSoon) {
				return new Intl.DateTimeFormat(locale, {
					weekday: 'long',
					hour: '2-digit',
					minute: '2-digit',
				}).format(new Date(ts));
			}
			return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
		} catch (e) {
			log.warn(`formatWarningEnd failed ts=${ts} locale='${locale}' err='${e?.message || e}'`);
			return String(ts);
		}
	};

	const addValidUntilToText = (text, endTs) => {
		if (typeof endTs !== 'number' || !Number.isFinite(endTs)) {
			return typeof text === 'string' ? text : '';
		}
		const formatted = formatWarningEnd(endTs);
		if (!formatted) {
			return typeof text === 'string' ? text : '';
		}
		const raw = typeof text === 'string' ? text : '';
		const suffix = String(t('msghub.i18n.IngestDwd.warning.validUntil.format', formatted) || '').trim();
		return `${raw.trim()}\n\n${suffix}`.trim();
	};

	const applyTitlePrefix = (prefix, title) => {
		const p = typeof prefix === 'string' ? prefix : '';
		const t = normalizeText(title);
		if (!t) {
			return p;
		}
		return `${p}${t}`;
	};

	const buildAiTextBlock = warning => {
		const end = normalizeNumber(warning?.end);
		const validUntil = end !== null ? formatWarningEnd(end) : '';
		return {
			headline: normalizeText(warning?.headline),
			event: normalizeText(warning?.event),
			description: normalizeText(warning?.description),
			instruction: typeof warning?.instruction === 'string' ? warning.instruction.trim() : '',
			...(validUntil ? { validUntil } : {}),
		};
	};

	const computeTextBlockJson = warning => JSON.stringify(buildAiTextBlock(warning));

	const computeTextBlockHash = textBlockJson =>
		crypto
			.createHash('sha1')
			.update(String(textBlockJson || ''))
			.digest('hex')
			.slice(0, 16);

	const postProcessAiTask = s => {
		const raw = typeof s === 'string' ? s.trim() : '';
		if (!raw) {
			return '';
		}
		const stripped = raw
			.replace(/^Achtung:\s*/iu, '')
			.replace(/^Empfohlene Maßnahmen:\s*/iu, '')
			.replace(/^Handlungsempfehlungen:\s*/iu, '')
			.replace(/^Gefahr durch:\s*/iu, '')
			.trim();
		return stripped.replace(/[.。]\s*$/u, '').trim();
	};

	const maybeAiEnhance = async ({ cache, ref, textBlockJson, textBlockHash }) => {
		if (!isAiAvailable()) {
			return null;
		}

		const entry = cache?.entries?.[ref];
		if (
			entry &&
			entry.textBlockHash === textBlockHash &&
			typeof entry.aiTitle === 'string' &&
			typeof entry.aiText === 'string' &&
			typeof entry.aiTask === 'string'
		) {
			return { aiTitle: entry.aiTitle, aiText: entry.aiText, aiTask: entry.aiTask, fromCache: true };
		}

		const res = await ai.json({
			purpose: AI_PURPOSE,
			hints: { quality: 'fast', temperature: 0.2, maxTokens: 220 },
			cache: {
				key: `${pluginInfo.regId}:${AI_PURPOSE}:${textBlockHash}`,
				ttlMs: 1000 * 60 * 60 * 24 * 30,
			},
			messages: [
				{
					role: 'system',
					content:
						'Du verbesserst DWD-Wetterwarnungen für eine Anzeige in einer Smart-Home-App. Antworte IMMER als gültiges JSON object mit den Feldern aiTitle, aiText, aiTask.\n' +
						'- aiTitle: deutscher Titel, 4 bis 6 Worte, sachlich, nicht reißerisch, ohne "Amtliche Warnung".\n' +
						'- aiText: GENAU 2 gut lesbare Sätze auf Deutsch, kurz (max. 180 Zeichen), natürlich im Fließtext. Nicht siezen. Keine Floskeln ("Es wird erwartet", "bis zum Ende der Warnung/Meldung"). Keine relativen Zeitangaben ("heute/morgen/übermorgen/nächste Woche"). Wenn "validUntil" vorhanden ist, MUSS "bis <validUntil>" im Text vorkommen (verwende den String unverändert; kein Rechnen, kein anderes Datum erfinden). Keine zusätzliche Zeile wie "Warnung gültig bis: ...".\n' +
						'- aiTask: nur konkrete Handlungsempfehlungen als kurze Imperativ-Phrasen (kommagetrennt). Keine Einleitung wie "Achtung"/"Gefahr"/"Empfohlene Maßnahmen". Wenn keine Maßnahmen erkennbar sind: leere Zeichenkette.\n' +
						'Gib keine zusätzlichen Felder aus.',
				},
				{ role: 'user', content: textBlockJson },
			],
		});

		const value = res?.ok === true ? res.value : null;
		if (!isPlainObject(value)) {
			return null;
		}

		const aiTitle = normalizeText(value.aiTitle);
		const aiText = normalizeText(value.aiText);
		const aiTask = postProcessAiTask(value.aiTask);

		if (!aiTitle && !aiText && !aiTask) {
			return null;
		}

		log.debug(`aiEnhancement ref='${ref}' fromCache=false title='${aiTitle}' text='${aiText}' task='${aiTask}'`);

		if (cache && isPlainObject(cache.entries)) {
			cache.entries[ref] = {
				textBlockHash,
				textBlockJson,
				aiTitle,
				aiText,
				aiTask,
				updatedAt: Date.now(),
			};
			touchCacheRef(cache, ref);
		}

		return { aiTitle, aiText, aiTask, fromCache: false };
	};

	const buildDetails = (warning, { taskText }) => {
		const region = typeof warning?.regionName === 'string' ? warning.regionName.trim() : '';
		const state = typeof warning?.state === 'string' ? warning.state.trim() : '';

		const start = normalizeNumber(warning?.altitudeStart);
		const end = normalizeNumber(warning?.altitudeEnd);
		const altitude = start !== null && end !== null ? `${Math.trunc(start)}-${Math.trunc(end)}m` : '';

		const base = [region, state].filter(Boolean).join(', ');
		const location = base ? (altitude ? `${base} (${altitude})` : base) : altitude ? altitude : '';

		const out = {
			reason: String(t('msghub.i18n.IngestDwd.details.reason.weatherCondition.label') || '').trim(),
			...(location ? { location } : {}),
			...(taskText ? { task: taskText } : {}),
		};

		return out;
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
		const event = typeof warning?.event === 'string' ? warning.event.trim() : '';
		const description = typeof warning?.description === 'string' ? warning.description.trim() : '';
		const instruction = typeof warning?.instruction === 'string' ? warning.instruction.trim() : '';

		const existing = store.getMessageByRef(ref, 'quasiOpen');

		const existingNotifyAt =
			typeof existing?.timing?.notifyAt === 'number' && Number.isFinite(existing.timing.notifyAt)
				? existing.timing.notifyAt
				: null;
		const existingExpiresAt =
			typeof existing?.timing?.expiresAt === 'number' && Number.isFinite(existing.timing.expiresAt)
				? existing.timing.expiresAt
				: null;
		const existingStartAt =
			typeof existing?.timing?.startAt === 'number' && Number.isFinite(existing.timing.startAt)
				? existing.timing.startAt
				: null;
		const existingEndAt =
			typeof existing?.timing?.endAt === 'number' && Number.isFinite(existing.timing.endAt)
				? existing.timing.endAt
				: null;

		const textBlockJson = computeTextBlockJson(warning);
		const textBlockHash = computeTextBlockHash(textBlockJson);

		const cachedEntry = cache?.entries?.[ref];
		const cachedAi =
			isAiAvailable() &&
			cfg.aiEnhancement &&
			cachedEntry &&
			cachedEntry.textBlockHash === textBlockHash &&
			typeof cachedEntry.aiTitle === 'string' &&
			typeof cachedEntry.aiText === 'string' &&
			typeof cachedEntry.aiTask === 'string'
				? cachedEntry
				: null;

		const mustRefreshAi =
			isAiAvailable() && cfg.aiEnhancement && (!cachedEntry || cachedEntry.textBlockHash !== textBlockHash);

		const titleBaseCandidate = normalizeText(cachedAi?.aiTitle) || headline || event || ref;
		const textBaseCandidate = addValidUntilToText(description || titleBaseCandidate, end);

		const textCandidate = normalizeText(cachedAi?.aiText) || textBaseCandidate;
		const taskCandidate = postProcessAiTask(cachedAi?.aiTask) || instruction;
		const titleCandidate = applyTitlePrefix(cfg.titlePrefix, titleBaseCandidate);

		const audience = buildAudience();
		const actions = buildActions();
		const level = computeLevel(warning?.level);

		let shouldPatch = false;
		if (!existing) {
			shouldPatch = true;
		} else {
			// Only treat non-hash fields as "update triggers":
			// - end: expiresAt changes
			// - start (future only): notifyAt changes
			// - description/instruction: changes are detected via AI text block hash (or raw fallback)
			if (end !== null && existingExpiresAt !== end) {
				shouldPatch = true;
			}
			if (start !== null && start > now && existingNotifyAt !== start) {
				shouldPatch = true;
			}
			if (start !== null && existingStartAt !== start) {
				shouldPatch = true;
			}
			if (end !== null && existingEndAt !== end) {
				shouldPatch = true;
			}
			if (mustRefreshAi) {
				shouldPatch = true;
			}

			const existingTask = typeof existing?.details?.task === 'string' ? existing.details.task : '';
			if ((existing?.title || '') !== titleCandidate || (existing?.text || '') !== textCandidate) {
				shouldPatch = true;
			}
			if (existingTask !== taskCandidate) {
				shouldPatch = true;
			}
		}

		if (!shouldPatch && existing) {
			return ref;
		}

		let aiOut = null;
		if (cfg.aiEnhancement && isAiAvailable()) {
			aiOut = cachedAi
				? { aiTitle: cachedAi.aiTitle, aiText: cachedAi.aiText, aiTask: cachedAi.aiTask, fromCache: true }
				: await maybeAiEnhance({ cache, ref, textBlockJson, textBlockHash });
			if (aiOut?.fromCache === true) {
				log.debug(
					`aiEnhancement ref='${ref}' fromCache=true title='${normalizeText(aiOut.aiTitle)}' text='${normalizeText(aiOut.aiText)}' task='${postProcessAiTask(aiOut.aiTask)}'`,
				);
			}
		}

		const titleRaw = normalizeText(aiOut?.aiTitle) || titleBaseCandidate;
		const title = applyTitlePrefix(cfg.titlePrefix, titleRaw);
		const text = normalizeText(aiOut?.aiText) || textCandidate;
		const taskText = postProcessAiTask(aiOut?.aiTask) || taskCandidate;

		const details = buildDetails(warning, { taskText });

		if (!existing) {
			const msg = factory.createMessage({
				ref,
				title,
				text,
				level,
				kind: constants.kind.status,
				origin: { type: constants.origin.type.import, system: cfg.dwdInstance, id: hash },
				timing: {
					...(end !== null ? { expiresAt: end } : {}),
					...(start !== null && start > now ? { notifyAt: start } : {}),
					...(start !== null ? { startAt: start } : {}),
					...(end !== null ? { endAt: end } : {}),
				},
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
			log.debug(`new warning hash='${hash}' ref='${ref}' title='${title}'`);
			return ref;
		}

		const timingPatch = {};
		if (end !== null && existingExpiresAt !== end) {
			timingPatch.expiresAt = end;
		}
		if (start !== null && start > now && existingNotifyAt !== start) {
			timingPatch.notifyAt = start;
		}
		if (start !== null && existingStartAt !== start) {
			timingPatch.startAt = start;
		}
		if (end !== null && existingEndAt !== end) {
			timingPatch.endAt = end;
		}

		// Avoid due-on-update spam: if we are patching while notifyAt is missing and the warning already started,
		// move notifyAt to a "quiet" time (1h after expiresAt).
		const needsSilencing =
			!(typeof timingPatch.notifyAt === 'number' && Number.isFinite(timingPatch.notifyAt)) &&
			existingNotifyAt === null;
		if (needsSilencing) {
			const base = end !== null ? end : now;
			timingPatch.notifyAt = base + (end !== null ? SILENCE_AFTER_EXPIRE_MS : 24 * 60 * 60 * 1000);
		}

		store.updateMessage(ref, {
			title,
			text,
			level,
			...(Object.keys(timingPatch).length > 0 ? { timing: timingPatch } : {}),
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

	const sleep = ms =>
		new Promise(resolve => {
			const wait = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
			resources.setTimeout(resolve, wait);
		});

	const readWarningsSnapshot = async () => {
		const ids = listWarningStateIds();
		const states = await Promise.all(
			ids.map(id =>
				iobroker.states
					.getForeignState(id)
					.catch(e => log.warn(`getForeignState failed for '${id}': ${e?.message || e}`)),
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

		return {
			warnings,
			fingerprint: computeWarningSetFingerprint(warnings),
		};
	};

	const scheduleSyncIn = ms => {
		if (!started) {
			return;
		}
		if (syncTimer) {
			resources.clearTimeout(syncTimer);
			syncTimer = null;
		}
		const wait = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
		syncTimer = resources.setTimeout(() => {
			syncTimer = null;
			syncNow().catch(e => log.warn(`sync failed: ${e?.message || e}`));
		}, wait);
	};

	const syncNow = async () => {
		if (!started) {
			return;
		}

		const snap1 = await readWarningsSnapshot();
		await sleep(STABILITY_GATE_DELAY_MS);
		if (!started) {
			return;
		}
		const snap2 = await readWarningsSnapshot();

		if (snap1.fingerprint !== snap2.fingerprint) {
			const nextBackoff = stabilityBackoffMs > 0 ? stabilityBackoffMs * 2 : STABILITY_GATE_DELAY_MS;
			stabilityBackoffMs = Math.min(STABILITY_GATE_MAX_BACKOFF_MS, Math.max(STABILITY_GATE_DELAY_MS, nextBackoff));
			log.debug(
				`stabilityGate: unstable warning set (f1=${snap1.fingerprint} f2=${snap2.fingerprint} count1=${snap1.warnings.length} count2=${snap2.warnings.length}), retry in ${stabilityBackoffMs}ms`,
			);
			scheduleSyncIn(stabilityBackoffMs);
			return;
		}

		stabilityBackoffMs = 0;
		const warnings = snap2.warnings;

		const cache = cfg.aiEnhancement ? await loadCache() : null;
		if (cache) {
			cache._dirty = false;
		}
		const activeRefs = new Set();
		for (const w of warnings) {
			const ref = await upsertWarning(w, { cache });
			if (ref) {
				activeRefs.add(ref);
			}
		}

		// Remove warnings that disappeared from DWD.
		const prefix = refPrefix();
		const existing = store
			.queryMessages({ where: { origin: { system: cfg.dwdInstance } } })
			.items.map(m => (typeof m?.ref === 'string' ? m.ref : ''))
			.filter(Boolean);
		for (const ref of existing) {
			if (!ref.startsWith(prefix)) {
				continue;
			}
			if (activeRefs.has(ref)) {
				continue;
			}
			log.debug(`warning disappeared ref='${ref}'`);
			store.completeAfterCauseEliminated(ref, { actor: pluginInfo.regId });
		}

		// Cache policy:
		// - keepCacheHistory=0: remove entries once the message is expired/deleted/removed.
		// - keepCacheHistory>0: keep entries for auditing, but cap total entry count (FIFO/LRU via `order`).
		if (cfg.aiEnhancement && cache && isPlainObject(cache.entries)) {
			const max =
				typeof cfg.keepCacheHistory === 'number' && Number.isFinite(cfg.keepCacheHistory)
					? cfg.keepCacheHistory
					: 0;

			if (max <= 0) {
				for (const ref of Object.keys(cache.entries)) {
					const msg = store.getMessageByRef(ref, 'quasiOpen');
					if (!msg) {
						deleteCacheRef(cache, ref);
					}
				}
			}

			if (Array.isArray(cache.order)) {
				cache.order = cache.order.filter(
					ref => !!ref && Object.prototype.hasOwnProperty.call(cache.entries, ref),
				);
			}

			if (max > 0 && Array.isArray(cache.order)) {
				while (cache.order.length > max) {
					const oldest = cache.order.shift();
					if (oldest && Object.prototype.hasOwnProperty.call(cache.entries, oldest)) {
						deleteCacheRef(cache, oldest);
					}
				}
			}
		}

		// Persist AI cache (best-effort).
		if (cfg.aiEnhancement && cache && cache._dirty) {
			saveCache(cache).catch(e => log.warn(`saveCache failed: ${e?.message || e}`));
		}
	};

	const scheduleSync = () => {
		scheduleSyncIn(cfg.syncDebounceMs);
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
				'api.store.queryMessages',
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
		i18n = ctx.api.i18n || null;

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
			titlePrefix: ctx.meta.options.resolveString('titlePrefix', options.titlePrefix),
			aiEnhancement: ctx.meta.options.resolveBool('aiEnhancement', options.aiEnhancement),
			keepCacheHistory: ctx.meta.options.resolveInt('keepCacheHistory', options.keepCacheHistory),
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
