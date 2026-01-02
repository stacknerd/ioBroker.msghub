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
const { manifest } = require('./manifest');
const { ensureCtxAvailability } = require('../IoPluginGuards');

/**
 * Create a MsgNotify plugin handler.
 *
 * @param {{ blobIntervalMs?: number, pluginBaseObjectId?: string, mapTypeMarker?: string, statsMinIntervalMs?: number, statsMaxIntervalMs?: number}} [options] Plugin options (from ioBroker `native`).
 * @returns {{ start?: (ctx: any) => void, stop?: (ctx: any) => void, onNotifications: (event: string, notifications: any[], ctx: any) => void }} Handler object.
 */
function NotifyStates(options = {}) {
	const baseFullId = typeof options.pluginBaseObjectId === 'string' ? options.pluginBaseObjectId.trim() : '';
	if (!baseFullId) {
		throw new Error('NotifyStates: options.pluginBaseObjectId is required');
	}

	let started = false;

	let log = null;
	let i18n = null;
	let iobroker = null;
	let store = null;
	let constants = null;
	let resources = null;

	let baseOwnId = null;
	let blobStateId = null;
	let latestPrefix = null;
	let kindPrefix = null;
	let levelPrefix = null;
	let statsPrefix = null;
	let statsIds = null;

	let blobTimerIntervalMs = 0;
	let statsMinIntervalMs = 0;
	let statsMaxIntervalMs = 0;
	let mapTypeMarker = undefined;

	let kindEntries = [];
	let levelEntries = [];
	let eventEntries = [];

	let kindValueToKey = new Map();
	let levelValueToKey = new Map();
	let eventKeyToValue = new Map();
	let kindKeys = new Set();
	let levelKeys = new Set();
	let eventValues = new Set();

	const initPromises = new Map();
	const stateNames = new Map();

	let blobTimer = null;
	let statsKickTimer = null;
	let statsMinTimer = null;
	let statsMaxTimer = null;
	let statsLastWrittenAt = 0;

	const rebuildLookups = () => {
		kindEntries = Object.entries(constants.kind);
		levelEntries = Object.entries(constants.level);
		eventEntries = Object.entries(constants.notfication.events);

		kindValueToKey = new Map(kindEntries.map(([key, value]) => [value, key]));
		levelValueToKey = new Map(levelEntries.map(([key, value]) => [value, key]));
		eventKeyToValue = new Map(eventEntries);
		kindKeys = new Set(kindEntries.map(([key]) => key));
		levelKeys = new Set(levelEntries.map(([key]) => key));
		eventValues = new Set(eventEntries.map(([, value]) => value));
	};

	const ensureStateName = (id, rawTemplate, ...args) => {
		const name = i18n.t(rawTemplate, ...args);
		stateNames.set(id, name);
		return name;
	};

	const ensureState = (id, stateName) => {
		if (!id) {
			return Promise.resolve();
		}
		if (initPromises.has(id)) {
			return initPromises.get(id);
		}

		const guarded = iobroker.objects
			.setObjectNotExists(id, {
				type: 'state',
				common: {
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
				initPromises.delete(id);
				log.warn(`NotifyStates: failed to create state "${id}": ${err?.message || err}`);
			});

		initPromises.set(id, guarded);
		return guarded;
	};

	const ensureNumberState = (id, stateName) => {
		if (!id) {
			return Promise.resolve();
		}
		if (initPromises.has(id)) {
			return initPromises.get(id);
		}

		const guarded = iobroker.objects
			.setObjectNotExists(id, {
				type: 'state',
				common: {
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
				initPromises.delete(id);
				log.warn(`NotifyStates: failed to create state "${id}": ${err?.message || err}`);
			});

		initPromises.set(id, guarded);
		return guarded;
	};

	const ensureAllStates = async () => {
		if (!started) {
			throw new Error('NotifyStates: not started (start(ctx) not called yet)');
		}

		const promises = [];
		const eventValueList = eventEntries.map(([, value]) => value);

		ensureStateName(blobStateId, 'full json dump of MsgHub store (interval=%ss)', blobTimerIntervalMs / 1000);
		promises.push(ensureState(blobStateId, stateNames.get(blobStateId)));

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
			ensureStateName(id, 'latest notification for event "%s"', eventValue);
			promises.push(ensureState(id, stateNames.get(id)));
		}

		for (const [kindKey] of kindEntries) {
			for (const eventValue of eventValueList) {
				const id = `${kindPrefix}.${kindKey}.${eventValue}`;
				ensureStateName(id, 'latest notification of kind "%s" for event "%s"', kindKey, eventValue);
				promises.push(ensureState(id, stateNames.get(id)));
			}
		}

		for (const [levelKey] of levelEntries) {
			for (const eventValue of eventValueList) {
				const id = `${levelPrefix}.${levelKey}.${eventValue}`;
				ensureStateName(id, 'latest notification of level "%s" for event "%s"', levelKey, eventValue);
				promises.push(ensureState(id, stateNames.get(id)));
			}
		}

		await Promise.all(promises);
	};

	const writeState = (id, value) => {
		if (!id) {
			return;
		}

		const serialized = serializeWithMaps(value, mapTypeMarker);
		ensureState(id, stateNames.get(id) || id)
			.then(() => iobroker.states.setState(id, { val: serialized, ack: true }))
			.catch(err => log.warn(`NotifyStates: failed to write state "${id}": ${err?.message || err}`));
	};

	const writeNumberState = (id, value) => {
		if (!id) {
			return;
		}

		const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
		ensureNumberState(id, stateNames.get(id) || id)
			.then(() => iobroker.states.setState(id, { val: numeric, ack: true }))
			.catch(err => log.warn(`NotifyStates: failed to write state "${id}": ${err?.message || err}`));
	};

	const writeBlob = () => {
		writeState(blobStateId, store.getMessages());
	};

	const scheduleStatsMaxTimer = () => {
		if (!statsMaxIntervalMs || statsMaxIntervalMs <= 0) {
			return;
		}
		if (statsMaxTimer) {
			resources.clearTimeout(statsMaxTimer);
		}
		statsMaxTimer = resources.setTimeout(() => {
			statsMaxTimer = null;
			writeStatsNow();
		}, statsMaxIntervalMs);
	};

	const computeStats = () => {
		const messages = store.getMessages();
		const now = Date.now();
		const lifecycle = constants.lifecycle.state;

		let open = 0;
		let deleted = 0;
		let expired = 0;
		let dueNow = 0;

		for (const msg of messages) {
			const state = msg && msg.lifecycle ? msg.lifecycle.state : undefined;
			if (state === lifecycle.deleted) {
				deleted += 1;
				continue;
			}
			if (state === lifecycle.expired) {
				expired += 1;
				continue;
			}
			if (state === lifecycle.open) {
				open += 1;
				const notifyAt = msg && msg.timing ? msg.timing.notifyAt : undefined;
				const expiresAt = msg && msg.timing ? msg.timing.expiresAt : undefined;
				const notExpired = typeof expiresAt !== 'number' || expiresAt > now;
				if (typeof notifyAt === 'number' && notifyAt <= now && notExpired) {
					dueNow += 1;
				}
			}
		}

		return { total: messages.length, open, dueNow, deleted, expired };
	};

	const writeStatsNow = () => {
		const s = computeStats();

		statsLastWrittenAt = Date.now();
		writeNumberState(statsIds.total, s.total);
		writeNumberState(statsIds.open, s.open);
		writeNumberState(statsIds.dueNow, s.dueNow);
		writeNumberState(statsIds.deleted, s.deleted);
		writeNumberState(statsIds.expired, s.expired);
		scheduleStatsMaxTimer();
	};

	const requestStatsWrite = () => {
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

		if (statsMinTimer) {
			return;
		}
		statsMinTimer = resources.setTimeout(() => {
			statsMinTimer = null;
			writeStatsNow();
		}, waitMs);
	};

	const kickStatsWrite = () => {
		if (statsKickTimer) {
			return;
		}
		statsKickTimer = resources.setTimeout(() => {
			statsKickTimer = null;
			requestStatsWrite();
		}, 0);
	};

	const resolveKindKey = kind => {
		if (typeof kind !== 'string') {
			return null;
		}
		if (kindValueToKey.has(kind)) {
			return kindValueToKey.get(kind);
		}
		return kindKeys.has(kind) ? kind : null;
	};

	const resolveLevelKey = level => {
		const numericLevel = typeof level === 'string' && level.trim() !== '' ? Number(level) : level;
		if (levelValueToKey.has(numericLevel)) {
			return levelValueToKey.get(numericLevel);
		}
		if (typeof level === 'string' && levelKeys.has(level)) {
			return level;
		}
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

	const start = ctx => {
		if (started) {
			return;
		}
		ensureCtxAvailability('NotifyStates.start', ctx, {
			plainObject: [
				'api',
				'meta',
				'api.log',
				'api.i18n',
				'api.iobroker',
				'api.iobroker.objects',
				'api.iobroker.states',
				'api.store',
				'api.constants',
				'api.constants.kind',
				'api.constants.level',
				'api.constants.notfication',
				'api.constants.notfication.events',
				'meta.resources',
				'meta.options',
				'meta.plugin',
			],
			fn: [
				'api.log.debug',
				'api.log.warn',
				'api.i18n.t',
				'api.iobroker.objects.setObjectNotExists',
				'api.iobroker.states.setState',
				'api.store.getMessages',
				'meta.resources.setTimeout',
				'meta.resources.clearTimeout',
				'meta.resources.setInterval',
				'meta.resources.clearInterval',
				'meta.options.resolveInt',
				'meta.options.resolveString',
			],
			stringNonEmpty: ['meta.plugin.baseOwnId'],
		});

		log = ctx.api.log;
		i18n = ctx.api.i18n;
		iobroker = ctx.api.iobroker;
		store = ctx.api.store;
		constants = ctx.api.constants;
		resources = ctx.meta.resources;

		baseOwnId = ctx.meta.plugin.baseOwnId.trim();
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

		rebuildLookups();

		blobTimerIntervalMs = ctx.meta.options.resolveInt('blobIntervalMs', options.blobIntervalMs);
		statsMinIntervalMs = ctx.meta.options.resolveInt('statsMinIntervalMs', options.statsMinIntervalMs);
		statsMaxIntervalMs = ctx.meta.options.resolveInt('statsMaxIntervalMs', options.statsMaxIntervalMs);
		mapTypeMarker = ctx.meta.options.resolveString('mapTypeMarker', options.mapTypeMarker);

		started = true;
		log.debug('NotifyStates: start');

		ensureAllStates().catch(err => log.warn(`NotifyStates: ensureAllStates failed: ${err?.message || err}`));

		if (blobTimerIntervalMs > 0) {
			writeBlob();
			blobTimer = resources.setInterval(() => writeBlob(), blobTimerIntervalMs);
		}

		writeStatsNow();
	};

	const stop = () => {
		if (blobTimer) {
			resources.clearInterval(blobTimer);
			blobTimer = null;
		}
		if (statsKickTimer) {
			resources.clearTimeout(statsKickTimer);
			statsKickTimer = null;
		}
		if (statsMinTimer) {
			resources.clearTimeout(statsMinTimer);
			statsMinTimer = null;
		}
		if (statsMaxTimer) {
			resources.clearTimeout(statsMaxTimer);
			statsMaxTimer = null;
		}
		started = false;
	};

	const onNotifications = (event, notifications) => {
		if (!started) {
			throw new Error('NotifyStates: onNotifications called before start(ctx)');
		}
		if (!Array.isArray(notifications) || notifications.length === 0) {
			return;
		}

		const eventValue = resolveEventValue(event);
		if (!eventValue) {
			return;
		}

		const payload = notifications.length === 1 ? notifications[0] : notifications;
		writeState(`${latestPrefix}.${eventValue}`, payload);

		for (const notification of notifications) {
			if (!notification || typeof notification !== 'object') {
				continue;
			}
			const kindKey = resolveKindKey(notification.kind);
			if (kindKey) {
				writeState(`${kindPrefix}.${kindKey}.${eventValue}`, notification);
			}
			const levelKey = resolveLevelKey(notification.level);
			if (levelKey) {
				writeState(`${levelPrefix}.${levelKey}.${eventValue}`, notification);
			}
		}

		kickStatsWrite();
	};

	return { start, stop, onNotifications };
}

module.exports = { NotifyStates, manifest };
