/**
 * NotifyStates
 * ============
 * MsgHub notifier plugin that writes notification events into ioBroker states.
 *
 * Docs: ../../docs/plugins/NotifyStates.md
 *
 */

'use strict';

const { serializeWithMaps } = require(`${__dirname}/../../src/MsgUtils`);
const { MsgConstants } = require(`${__dirname}/../../src/MsgConstants`);

/**
 * Create a MsgNotify plugin handler.
 *
 * @param {{ blobIntervalMs?: number, pluginBaseObjectId?: string , mapTypeMarker?, statsMinIntervalMs?: number, statsMaxIntervalMs?: number}} [options] Plugin options (from ioBroker `native`).
 * @returns {{ start?: (ctx: any) => void, stop?: (ctx: any) => void, onNotifications: (event: string, notifications: any[], ctx: any) => void }} Handler object.
 */
function NotifyStates(options = {}) {
	const baseFullId = typeof options?.pluginBaseObjectId === 'string' ? options.pluginBaseObjectId.trim() : '';
	if (!baseFullId) {
		throw new Error('NotifyStates: options.pluginBaseObjectId is required');
	}

	// NOTE: ioBroker adapter APIs mostly expect "own ids" (without namespace).
	// We derive own-id prefixes from `pluginBaseObjectId` when `start(ctx)` runs (we need ctx.api.iobroker.ids).
	let baseOwnId = null;
	let blobStateId = null;
	let latestPrefix = null;
	let kindPrefix = null;
	let levelPrefix = null;
	let statsPrefix = null;
	let statsIds = null;

	const blobTimerIntervalMs =
		typeof options?.blobIntervalMs === 'number' && Number.isFinite(options.blobIntervalMs)
			? options.blobIntervalMs
			: 1000 * 60 * 5;

	// Stats: update after notifications, throttled by statsMinIntervalMs, but at least every statsMaxIntervalMs.
	const statsMinIntervalMs =
		typeof options?.statsMinIntervalMs === 'number' && Number.isFinite(options.statsMinIntervalMs)
			? Math.max(0, options.statsMinIntervalMs)
			: 1000;
	const statsMaxIntervalMs =
		typeof options?.statsMaxIntervalMs === 'number' && Number.isFinite(options.statsMaxIntervalMs)
			? Math.max(0, options.statsMaxIntervalMs)
			: 1000 * 60 * 5;

	// Read allowed kinds/levels/events from MsgConstants (or ctx.api.constants) to avoid hardcoded lists.
	let kindEntries = [];
	let levelEntries = [];
	let eventEntries = [];

	// Build lookup tables that accept either the key or the stored value.
	// This supports flexible inputs from different call sites / older integrations.
	let kindValueToKey = new Map();
	let levelValueToKey = new Map();
	let eventKeyToValue = new Map();
	let kindKeys = new Set();
	let levelKeys = new Set();
	let eventValues = new Set();

	const rebuildLookups = constants => {
		kindEntries = Object.entries(constants?.kind || {});
		levelEntries = Object.entries(constants?.level || {});
		eventEntries = Object.entries(constants?.notfication?.events || {});

		kindValueToKey = new Map(kindEntries.map(([key, value]) => [value, key]));
		levelValueToKey = new Map(levelEntries.map(([key, value]) => [value, key]));
		eventKeyToValue = new Map(eventEntries);
		kindKeys = new Set(kindEntries.map(([key]) => key));
		levelKeys = new Set(levelEntries.map(([key]) => key));
		eventValues = new Set(eventEntries.map(([, value]) => value));
	};

	let i18n = null;
	let iobroker = null;
	let log = null;
	let store = null;

	// Cache in-flight state creations to avoid parallel setObject calls.
	const initPromises = new Map();
	// Track per-state display names for lazy creation in writeState.
	const stateNames = new Map();

	const { mapTypeMarker } = options;

	let blobTimer = null;
	let statsKickTimer = null;
	let statsMinTimer = null;
	let statsMaxTimer = null;
	let statsLastWrittenAt = 0;

	const ensureInitialized = (ctx = {}) => {
		// Only initialize once (or when ctx becomes available).
		if (baseOwnId && latestPrefix && kindPrefix && levelPrefix && statsPrefix && statsIds) {
			return;
		}

		log = ctx?.api?.log || log;
		i18n = ctx?.api?.i18n || i18n;
		iobroker = ctx?.api?.iobroker || iobroker;
		store = ctx?.api?.store || store;

		const ids = iobroker?.ids;
		if (!ids || typeof ids.toOwnId !== 'function') {
			throw new Error('NotifyStates.start: ctx.api.iobroker.ids.toOwnId is required');
		}

		baseOwnId = ids.toOwnId(baseFullId);
		blobStateId = `${baseOwnId}.fullJson`;
		latestPrefix = `${baseOwnId}.Latest`;
		kindPrefix = `${baseOwnId}.byKind`;
		levelPrefix = `${baseOwnId}.byLevel`;
		statsPrefix = `${baseOwnId}.Stats`;
		statsIds = Object.freeze({
			total: `${statsPrefix}.total`,
			open: `${statsPrefix}.open`,
			dueNow: `${statsPrefix}.dueNow`,
			deleted: `${statsPrefix}.deleted`,
			expired: `${statsPrefix}.expired`,
		});

		rebuildLookups(ctx?.api?.constants || MsgConstants);
	};

	const start = ctx => {
		ensureInitialized(ctx);
		log?.debug?.('NotifyStates: start');

		// Fire-and-forget initialization to create all states once at startup.
		ensureAllStates().catch(err => {
			log?.warn?.(`NotifyStates: ensureAllStates failed: ${err?.message || err}`);
		});

		// Periodic full store dump (best-effort). 0 disables.
		if (blobTimerIntervalMs > 0 && !blobTimer) {
			// First write right away for fast feedback after startup.
			writeBlob();
			blobTimer = setInterval(() => writeBlob(), blobTimerIntervalMs);
		}

		// First stats write right away for fast feedback after startup (and to (re-)arm max timer).
		writeStatsNow();
	};

	const stop = _ctx => {
		if (blobTimer) {
			clearInterval(blobTimer);
			blobTimer = null;
		}
		if (statsKickTimer) {
			clearTimeout(statsKickTimer);
			statsKickTimer = null;
		}
		if (statsMinTimer) {
			clearTimeout(statsMinTimer);
			statsMinTimer = null;
		}
		if (statsMaxTimer) {
			clearTimeout(statsMaxTimer);
			statsMaxTimer = null;
		}
	};

	const writeBlob = () => {
		if (!blobStateId) {
			return;
		}
		if (!store || typeof store.getMessages !== 'function') {
			return;
		}
		const messages = store.getMessages();
		writeState(blobStateId, messages);
	};

	/**
	 * Ensure a single ioBroker state exists.
	 *
	 * This is safe to call repeatedly. Concurrent callers share one in-flight promise.
	 *
	 * @param {string} id Object id without adapter namespace prefix.
	 * @param {string|Record<string,string>} [stateName] Translated name (preferred) or string fallback.
	 * @returns {Promise<void>} Resolves when the object exists (or when creation failed but was handled).
	 */
	const ensureState = (id, stateName) => {
		// No id means nothing to create.
		if (!id) {
			return Promise.resolve();
		}
		if (!iobroker?.objects || typeof iobroker.objects.setObjectNotExists !== 'function') {
			return Promise.reject(new Error('NotifyStates: ctx.api.iobroker.objects.setObjectNotExists is required'));
		}
		// Reuse an existing creation promise if already started.
		if (initPromises.has(id)) {
			return initPromises.get(id);
		}
		const guarded = iobroker.objects
			.setObjectNotExists(id, {
				type: 'state',
				common: {
					// Use translated name when provided, fallback to the id itself.
					name: stateName || id,
					type: 'string',
					role: 'json',
					read: true,
					write: false,
				},
				native: {},
			})
			.then(() => undefined)
			.catch(err => {
				// On failure, drop the cached promise to allow retry later.
				initPromises.delete(id);
				log?.warn?.(`NotifyStates: failed to create state "${id}": ${err?.message || err}`);
			});
		initPromises.set(id, guarded);
		return guarded;
	};

	/**
	 * Ensure a single numeric ioBroker state exists.
	 *
	 * This is safe to call repeatedly. Concurrent callers share one in-flight promise.
	 *
	 * @param {string} id Object id without adapter namespace prefix.
	 * @param {string|Record<string,string>} [stateName] Translated name (preferred) or string fallback.
	 * @returns {Promise<void>} Resolves when the object exists (or when creation failed but was handled).
	 */
	const ensureNumberState = (id, stateName) => {
		// No id means nothing to create.
		if (!id) {
			return Promise.resolve();
		}
		if (!iobroker?.objects || typeof iobroker.objects.setObjectNotExists !== 'function') {
			return Promise.reject(new Error('NotifyStates: ctx.api.iobroker.objects.setObjectNotExists is required'));
		}
		// Reuse an existing creation promise if already started.
		if (initPromises.has(id)) {
			return initPromises.get(id);
		}
		const guarded = iobroker.objects
			.setObjectNotExists(id, {
				type: 'state',
				common: {
					// Use translated name when provided, fallback to the id itself.
					name: stateName || id,
					type: 'number',
					role: 'value',
					read: true,
					write: false,
				},
				native: {},
			})
			.then(() => undefined)
			.catch(err => {
				// On failure, drop the cached promise to allow retry later.
				initPromises.delete(id);
				log?.warn?.(`NotifyStates: failed to create state "${id}": ${err?.message || err}`);
			});
		initPromises.set(id, guarded);
		return guarded;
	};

	const formatTemplate = (template, args) => {
		if (typeof template !== 'string') {
			return '';
		}
		let i = 0;
		return template.replace(/%s/g, () => String(args?.[i++] ?? ''));
	};

	const ensureStateName = (id, rawTemplate, ...args) => {
		const name =
			i18n && typeof i18n.getTranslatedObject === 'function'
				? i18n.getTranslatedObject(rawTemplate, ...args)
				: formatTemplate(rawTemplate, args);
		stateNames.set(id, name);
		return name;
	};

	const ensureAllStates = async () => {
		if (!baseOwnId || !latestPrefix || !kindPrefix || !levelPrefix || !statsPrefix || !statsIds) {
			throw new Error('NotifyStates: not initialized (start(ctx) not called yet)');
		}

		// Pre-create all states at startup for discoverability in admin UI.
		const promises = [];
		const eventValueList = eventEntries.map(([, value]) => value);

		// Store dump state (optional feature, but always ensure the object exists when the plugin is active).
		ensureStateName(blobStateId, 'full json dump of MsgHub store (interval=%ss)', blobTimerIntervalMs / 1000);
		promises.push(ensureState(blobStateId, stateNames.get(blobStateId)));

		// Store stats states (read-only, numeric).
		ensureStateName(statsIds.total, 'Messages (total)');
		promises.push(ensureNumberState(statsIds.total, stateNames.get(statsIds.total)));
		ensureStateName(statsIds.open, 'Messages (open)');
		promises.push(ensureNumberState(statsIds.open, stateNames.get(statsIds.open)));
		ensureStateName(statsIds.dueNow, 'Messages (due now)');
		promises.push(ensureNumberState(statsIds.dueNow, stateNames.get(statsIds.dueNow)));
		ensureStateName(statsIds.deleted, 'Messages (deleted)');
		promises.push(ensureNumberState(statsIds.deleted, stateNames.get(statsIds.deleted)));
		ensureStateName(statsIds.expired, 'Messages (expired)');
		promises.push(ensureNumberState(statsIds.expired, stateNames.get(statsIds.expired)));

		for (const eventValue of eventValueList) {
			const id = `${latestPrefix}.${eventValue}`;
			ensureStateName(id, "latest notification for event '%s'", eventValue);
			promises.push(ensureState(id, stateNames.get(id)));
		}
		// Create one state per kind+event from MsgConstants.kind + MsgConstants.notfication.events.
		for (const [kindKey] of kindEntries) {
			for (const eventValue of eventValueList) {
				const id = `${kindPrefix}.${kindKey}.${eventValue}`;
				ensureStateName(id, "latest notification of kind '%s' for event '%s'", kindKey, eventValue);
				promises.push(ensureState(id, stateNames.get(id)));
			}
		}
		// Create one state per level+event from MsgConstants.level + MsgConstants.notfication.events.
		for (const [levelKey] of levelEntries) {
			for (const eventValue of eventValueList) {
				const id = `${levelPrefix}.${levelKey}.${eventValue}`;
				ensureStateName(id, "latest notification of level '%s' for event '%s'", levelKey, eventValue);
				promises.push(ensureState(id, stateNames.get(id)));
			}
		}
		await Promise.all(promises);
	};

	/**
	 * Write a JSON value into a state (best-effort).
	 *
	 * - Ensures the state exists first (lazy fallback when pre-creation didn't happen or failed).
	 * - Uses `serializeWithMaps` to preserve Map values in the notification payload.
	 * - Writes `ack: true` because these states are outputs of the adapter, not user inputs.
	 *
	 * @param {string} id Object id without adapter namespace prefix.
	 * @param {any} value Payload (object or array) to serialize and store.
	 */
	const writeState = (id, value) => {
		// Skip invalid ids to avoid accidental root writes.
		if (!id) {
			return;
		}
		if (!iobroker?.states || typeof iobroker.states.setState !== 'function') {
			log?.warn?.('NotifyStates: ctx.api.iobroker.states.setState is required');
			return;
		}
		// Serialize while preserving Map values from the message model.
		const serialized = serializeWithMaps(value, mapTypeMarker);
		// Ensure the target state exists before writing.
		const writePromise = ensureState(id, stateNames.get(id) || id).then(() => {
			return iobroker.states.setState(id, { val: serialized, ack: true });
		});

		writePromise.catch(err => {
			// Log but do not throw; notifications should not crash the adapter.
			log?.warn?.(`NotifyStates: failed to write state "${id}": ${err?.message || err}`);
		});
	};

	/**
	 * Write a number value into a state (best-effort).
	 *
	 * - Ensures the state exists first (lazy fallback when pre-creation didn't happen or failed).
	 * - Writes `ack: true` because these states are outputs of the adapter, not user inputs.
	 *
	 * @param {string} id Object id without adapter namespace prefix.
	 * @param {number} value Numeric value to store.
	 */
	const writeNumberState = (id, value) => {
		// Skip invalid ids to avoid accidental root writes.
		if (!id) {
			return;
		}
		if (!iobroker?.states || typeof iobroker.states.setState !== 'function') {
			log?.warn?.('NotifyStates: ctx.api.iobroker.states.setState is required');
			return;
		}
		const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
		const writePromise = ensureNumberState(id, stateNames.get(id) || id).then(() => {
			return iobroker.states.setState(id, { val: numeric, ack: true });
		});

		writePromise.catch(err => {
			log?.warn?.(`NotifyStates: failed to write state "${id}": ${err?.message || err}`);
		});
	};

	const scheduleStatsMaxTimer = () => {
		if (!statsMaxIntervalMs || statsMaxIntervalMs <= 0) {
			return;
		}
		if (statsMaxTimer) {
			clearTimeout(statsMaxTimer);
		}
		statsMaxTimer = setTimeout(() => {
			statsMaxTimer = null;
			writeStatsNow();
		}, statsMaxIntervalMs);
	};

	const computeStats = () => {
		if (!store || typeof store.getMessages !== 'function') {
			return null;
		}
		const messages = store.getMessages();
		if (!Array.isArray(messages)) {
			return null;
		}

		const now = Date.now();
		const constants = MsgConstants;
		const lifecycle = constants?.lifecycle?.state || {};

		let open = 0;
		let deleted = 0;
		let expired = 0;
		let dueNow = 0;

		for (const msg of messages) {
			const state = msg?.lifecycle?.state || lifecycle.open || 'open';
			if (state === lifecycle.deleted || state === 'deleted') {
				deleted += 1;
				continue;
			}
			if (state === lifecycle.expired || state === 'expired') {
				expired += 1;
				continue;
			}
			if (state === lifecycle.open || state === 'open') {
				open += 1;
				const notifyAt = msg?.timing?.notifyAt;
				const expiresAt = msg?.timing?.expiresAt;
				const notExpired = typeof expiresAt !== 'number' || expiresAt > now;
				if (typeof notifyAt === 'number' && notifyAt <= now && notExpired) {
					dueNow += 1;
				}
			}
		}

		return {
			total: messages.length,
			open,
			dueNow,
			deleted,
			expired,
		};
	};

	const writeStatsNow = () => {
		if (!statsIds) {
			return;
		}
		const s = computeStats();
		if (!s) {
			return;
		}
		statsLastWrittenAt = Date.now();
		writeNumberState(statsIds.total, s.total);
		writeNumberState(statsIds.open, s.open);
		writeNumberState(statsIds.dueNow, s.dueNow);
		writeNumberState(statsIds.deleted, s.deleted);
		writeNumberState(statsIds.expired, s.expired);
		scheduleStatsMaxTimer();
	};

	const requestStatsWrite = () => {
		// Disable the throttle by setting statsMinIntervalMs to 0.
		if (!statsMinIntervalMs || statsMinIntervalMs <= 0) {
			writeStatsNow();
			return;
		}

		const now = Date.now();
		const nextAt = statsLastWrittenAt + statsMinIntervalMs;
		const waitMs = Math.max(0, nextAt - now);

		if (waitMs === 0) {
			writeStatsNow();
			return;
		}

		// Keep only one pending timer; the soonest allowed write wins.
		if (statsMinTimer) {
			return;
		}
		statsMinTimer = setTimeout(() => {
			statsMinTimer = null;
			writeStatsNow();
		}, waitMs);
	};

	const kickStatsWrite = () => {
		// Defer the throttle decision so store side-effects (e.g. due rescheduling via stealth patches) can complete.
		if (statsKickTimer) {
			return;
		}
		statsKickTimer = setTimeout(() => {
			statsKickTimer = null;
			requestStatsWrite();
		}, 0);
	};

	// ---------------------------------------------------------------------------
	// Routing helpers (kind/level/event normalization)
	// ---------------------------------------------------------------------------

	const resolveKindKey = kind => {
		// Accept only string kinds.
		if (typeof kind !== 'string') {
			return null;
		}
		// If the value is already a MsgConstants.kind value, map it to its key.
		if (kindValueToKey.has(kind)) {
			return kindValueToKey.get(kind);
		}
		// If the value is already a key, accept it.
		if (kindKeys.has(kind)) {
			return kind;
		}
		// Unknown kind -> no routing.
		return null;
	};

	const resolveLevelKey = level => {
		// Allow numeric levels and numeric strings like "10".
		const numericLevel = typeof level === 'string' && level.trim() !== '' ? Number(level) : level;
		// If the numeric value matches a MsgConstants.level entry, use its key.
		if (levelValueToKey.has(numericLevel)) {
			return levelValueToKey.get(numericLevel);
		}
		// If a string key was passed directly, accept it.
		if (typeof level === 'string' && levelKeys.has(level)) {
			return level;
		}
		// Unknown level -> no routing.
		return null;
	};

	const resolveEventValue = event => {
		if (typeof event !== 'string') {
			return null;
		}
		const trimmed = event.trim();
		if (!trimmed) {
			return null;
		}
		if (eventValues.has(trimmed)) {
			return trimmed;
		}
		if (eventKeyToValue.has(trimmed)) {
			return eventKeyToValue.get(trimmed);
		}
		return null;
	};

	const onNotifications = (event, notifications, ctx = {}) => {
		ensureInitialized(ctx);

		// MsgNotify always calls with an array, but we still guard for safety.
		if (!Array.isArray(notifications) || notifications.length === 0) {
			return;
		}
		// Keep the "latest" state small: write a single item or the list as-is.
		const payload = notifications.length === 1 ? notifications[0] : notifications;
		const eventName = typeof event === 'string' && event.trim() ? event.trim() : undefined;
		const eventValue = eventName ? resolveEventValue(eventName) : null;
		if (!eventValue) {
			return;
		}
		writeState(`${latestPrefix}.${eventValue}`, payload);

		// Route each notification to its kind- and level-specific state.
		for (const notification of notifications) {
			// Only process valid notification objects.
			if (!notification || typeof notification !== 'object') {
				continue;
			}
			// Resolve kind and write to the kind-specific state.
			const kindKey = resolveKindKey(notification.kind);
			if (kindKey && eventValue) {
				writeState(`${kindPrefix}.${kindKey}.${eventValue}`, notification);
			}
			// Resolve level and write to the level-specific state.
			const levelKey = resolveLevelKey(notification.level);
			if (levelKey && eventValue) {
				writeState(`${levelPrefix}.${levelKey}.${eventValue}`, notification);
			}
		}

		kickStatsWrite();
	};

	return {
		start,
		stop,
		onNotifications,
	};
}

module.exports = { NotifyStates };
