/**
 * IngestHue
 * =========
 * Producer plugin that watches Hue adapter device-health states and creates
 * MsgHub messages for low batteries and unreachable devices.
 *
 * Docs: ../../docs/plugins/IngestHue.md
 */

'use strict';

const { ensureCtxAvailability } = require('../IoPluginGuards');
const { manifest } = require('./manifest');
const { HUE_MODELS } = require('./models');

const BATTERY_PARENT_ROLE_DENYLIST = Object.freeze(['ZLLLightLevel', 'ZLLTemperature']);
const BATTERY_DUE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const BATTERY_REMIND_EVERY_MS = 48 * 60 * 60 * 1000;
const REACHABLE_REMIND_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Check whether a value is a plain object.
 *
 * @param {any} value Candidate value.
 * @returns {boolean} True when the value is a plain object.
 */
function isPlainObject(value) {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Return a readable string from ioBroker translated name objects.
 *
 * @param {any} value ioBroker name value.
 * @returns {string} Best-effort readable label.
 */
function translatedObjectString(value) {
	if (typeof value === 'string') {
		return value.trim();
	}
	if (!isPlainObject(value)) {
		return '';
	}
	const named = value;
	for (const lang of ['en', 'de']) {
		const entry = named[lang];
		if (typeof entry === 'string' && entry.trim()) {
			return entry.trim();
		}
	}
	for (const entry of Object.values(named)) {
		if (typeof entry === 'string' && entry.trim()) {
			return entry.trim();
		}
	}
	return '';
}

/**
 * Normalize a CSV string to a trimmed list.
 *
 * @param {any} value Raw CSV value.
 * @returns {string[]} Parsed list.
 */
function csvList(value) {
	if (Array.isArray(value)) {
		return value.map(v => String(v || '').trim()).filter(Boolean);
	}
	return String(value || '')
		.split(',')
		.map(v => v.trim())
		.filter(Boolean);
}

/**
 * Normalize a Hue adapter instance id.
 *
 * @param {any} value Raw instance value.
 * @returns {string} Normalized instance id.
 */
function normalizeHueInstance(value) {
	const raw = typeof value === 'string' ? value.trim() : '';
	const cleaned = raw.replace(/\.\*$/u, '').replace(/\.$/u, '');
	return cleaned || 'hue.0';
}

/**
 * Convert common Hue adapter state values to booleans.
 *
 * @param {any} value Raw state value.
 * @returns {boolean|null} Boolean value or null when unsupported.
 */
function toBoolean(value) {
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value !== 0;
	}
	if (typeof value === 'string') {
		const s = value.trim().toLowerCase();
		if (s === 'true' || s === '1' || s === 'on') {
			return true;
		}
		if (s === 'false' || s === '0' || s === 'off') {
			return false;
		}
	}
	return null;
}

/**
 * Convert a value to a finite number.
 *
 * @param {any} value Raw value.
 * @returns {number|null} Number or null when unsupported.
 */
function toNumber(value) {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim()) {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/**
 * Normalize ioBroker timestamp fields for metrics.
 *
 * @param {any} value Timestamp candidate.
 * @returns {number|null} Timestamp in milliseconds or null.
 */
function toTimestampMetricValue(value) {
	const n = toNumber(value);
	return n === null ? null : Math.trunc(n);
}

/**
 * Create the IngestHue plugin instance.
 *
 * @param {object} [options] Plugin options.
 * @returns {object} Plugin handler.
 */
function IngestHue(options = {}) {
	let started = false;
	let log = null;
	let iobroker = null;
	let store = null;
	let factory = null;
	let constants = null;
	let resources = null;
	let managedObjects = null;
	let i18n = null;
	let cfg = null;
	let pluginInfo = null;
	let rescanTimer = null;

	const watched = new Map();
	const subscribed = new Set();
	let roomsByMember = new Map();

	/**
	 * Translate a plugin-owned key.
	 *
	 * @param {string} key Translation key.
	 * @param {...unknown} args Format arguments.
	 * @returns {string} Translated text.
	 */
	const t = (key, ...args) => i18n.t(key, ...args);

	/**
	 * Run an async ioBroker operation without failing plugin startup.
	 *
	 * @param {string} label Operation label for logs.
	 * @param {Function} fn Operation callback.
	 * @returns {Promise<any|null>} Operation result or null.
	 */
	const safe = async (label, fn) => {
		try {
			return await fn();
		} catch (e) {
			log.debug(`${label} failed: ${e?.message || e}`);
			return null;
		}
	};

	/**
	 * Build the plugin-owned ref for a watched Hue state.
	 *
	 * @param {string} stateId Hue state id.
	 * @returns {string} Stable message ref.
	 */
	const messageRef = stateId => `${pluginInfo.type}.${pluginInfo.instanceId}.${stateId}`;

	/**
	 * Resolve the room name for an ioBroker id by walking parent prefixes.
	 *
	 * @param {string} id Object or state id.
	 * @returns {string} Room name or empty string.
	 */
	const resolveRoomName = id => {
		for (let cur = id; cur && cur.includes('.'); cur = cur.slice(0, cur.lastIndexOf('.'))) {
			const room = roomsByMember.get(cur);
			if (room) {
				return room;
			}
		}
		return '';
	};

	/**
	 * Rebuild the room lookup from `enum.rooms.*`.
	 *
	 * @returns {Promise<void>} Resolves after the cache was updated.
	 */
	const buildRoomsIndex = async () => {
		const enums =
			(await safe('getForeignObjects(enum.rooms.*)', () => iobroker.objects.getForeignObjects('enum.rooms.*'))) ||
			{};
		const next = new Map();

		for (const obj of Object.values(enums)) {
			if (!obj || obj.type !== 'enum') {
				continue;
			}
			const members = Array.isArray(obj?.common?.members) ? obj.common.members : [];
			const name = translatedObjectString(obj?.common?.name) || obj?._id || '';
			for (const member of members) {
				if (typeof member === 'string' && member && !next.has(member)) {
					next.set(member, name);
				}
			}
		}

		roomsByMember = next;
	};

	/**
	 * Load an object from the current discovery snapshot or via the object API.
	 *
	 * @param {object} objects Discovery object map.
	 * @param {string} id Object id.
	 * @returns {Promise<object|null>} ioBroker object or null.
	 */
	const getObject = async (objects, id) => {
		if (objects && objects[id]) {
			return objects[id];
		}
		return safe(`getForeignObject(${id})`, () => iobroker.objects.getForeignObject(id));
	};

	/**
	 * Translate a list of i18n keys and remove blank results.
	 *
	 * @param {string[]} keys Translation keys.
	 * @returns {string[]} Translated values.
	 */
	const translateKeyList = keys =>
		(Array.isArray(keys) ? keys : [])
			.map(key => (typeof key === 'string' && key ? t(key) : ''))
			.map(value => String(value || '').trim())
			.filter(Boolean);

	/**
	 * Build the static audience block from plugin configuration.
	 *
	 * @returns {object|undefined} Audience block or undefined.
	 */
	const buildAudience = () => {
		const tags = csvList(cfg.audienceTagsCsv);
		const include = csvList(cfg.audienceChannelsIncludeCsv);
		const exclude = csvList(cfg.audienceChannelsExcludeCsv);

		if (tags.length === 0 && include.length === 0 && exclude.length === 0) {
			return undefined;
		}

		const audience = {};
		if (tags.length > 0) {
			audience.tags = tags;
		}
		if (include.length > 0 || exclude.length > 0) {
			audience.channels = {};
			if (include.length > 0) {
				audience.channels.include = include;
			}
			if (exclude.length > 0) {
				audience.channels.exclude = exclude;
			}
		}
		return audience;
	};

	/**
	 * Build generic state metrics for a watched Hue state.
	 *
	 * @param {object} info Watched-state metadata.
	 * @param {object} state ioBroker state.
	 * @returns {Map<string, { val: any, unit: string, ts: number }>} Metrics map.
	 */
	const buildStateMetrics = (info, state) => {
		const now = Date.now();
		return new Map([
			['state-value', { val: state?.val ?? null, unit: info.stateUnit || '', ts: now }],
			['state-lc', { val: toTimestampMetricValue(state?.lc), unit: 'ms', ts: now }],
			['state-ts', { val: toTimestampMetricValue(state?.ts), unit: 'ms', ts: now }],
		]);
	};

	/**
	 * Compare two metric entries.
	 *
	 * @param {any} left Left metric.
	 * @param {any} right Right metric.
	 * @returns {boolean} True when the render-relevant metric values match.
	 */
	const isSameMetric = (left, right) =>
		!!left && !!right && Object.is(left.val, right.val) && String(left.unit || '') === String(right.unit || '');

	/**
	 * Build a metrics patch containing only actual changes.
	 *
	 * @param {Map<string, any>} existing Existing message metrics.
	 * @param {Map<string, any>} desired Desired message metrics.
	 * @returns {{ set?: object, delete?: string[] }|null} Metrics patch or null.
	 */
	const buildMetricsPatch = (existing, desired) => {
		const prev = existing instanceof Map ? existing : new Map();
		const set = {};
		for (const [key, metric] of desired.entries()) {
			if (!isSameMetric(prev.get(key), metric)) {
				set[key] = metric;
			}
		}

		const deleteKeys = [];
		for (const key of prev.keys()) {
			if (!desired.has(key)) {
				deleteKeys.push(key);
			}
		}

		const hasSet = Object.keys(set).length > 0;
		const hasDelete = deleteKeys.length > 0;
		if (!hasSet && !hasDelete) {
			return null;
		}
		return {
			...(hasSet ? { set } : {}),
			...(hasDelete ? { delete: deleteKeys } : {}),
		};
	};

	/**
	 * Add a new message or patch existing metrics only when metric values changed.
	 *
	 * @param {object} msg Desired normalized message.
	 * @returns {void}
	 */
	const addOrPatchMessage = msg => {
		const existing = store.getMessageByRef(msg.ref, 'quasiOpen');
		if (!existing) {
			store.addOrUpdateMessage(msg);
			return;
		}

		const metricsPatch = buildMetricsPatch(existing.metrics, msg.metrics);
		if (metricsPatch) {
			store.updateMessage(msg.ref, { metrics: metricsPatch });
		}
	};

	/**
	 * Report watched Hue states to the managed-object helper.
	 *
	 * @returns {Promise<void>} Resolves after metadata was flushed.
	 */
	const reportManagedObjects = async () => {
		const batteryIds = [];
		const reachableIds = [];
		for (const [id, info] of watched.entries()) {
			if (info.signal === 'battery') {
				batteryIds.push(id);
			} else if (info.signal === 'reachable') {
				reachableIds.push(id);
			}
		}

		if (batteryIds.length > 0) {
			await managedObjects.report(batteryIds, {
				managedText: t(
					'msghub.i18n.IngestHue.managed.battery.text',
					cfg.batteryCreateBelow,
					cfg.batteryRemoveAbove,
				),
			});
		}
		if (reachableIds.length > 0) {
			await managedObjects.report(reachableIds, {
				managedText: t('msghub.i18n.IngestHue.managed.reachable.text'),
			});
		}

		await managedObjects.applyReported();
	};

	/**
	 * Compute the watched Hue states for the current configuration.
	 *
	 * @returns {Promise<Map<string, object>>} Map of state id to watch metadata.
	 */
	const discoverWatchedStates = async () => {
		await buildRoomsIndex();

		const objects =
			(await safe(`getForeignObjects(${cfg.hueInstance}.*)`, () =>
				iobroker.objects.getForeignObjects(`${cfg.hueInstance}.*`),
			)) || {};
		const next = new Map();

		for (const [id, obj] of Object.entries(objects)) {
			if (!obj || obj.type !== 'state') {
				continue;
			}

			const isBattery = cfg.monitorBattery && id.endsWith('.battery');
			const isReachable = cfg.monitorReachable && id.endsWith('.reachable');
			if (!isBattery && !isReachable) {
				continue;
			}

			const parentId = id.slice(0, id.lastIndexOf('.'));
			const parentObj = await getObject(objects, parentId);
			const parentRole = typeof parentObj?.common?.role === 'string' ? parentObj.common.role : '';

			if (isBattery && BATTERY_PARENT_ROLE_DENYLIST.includes(parentRole)) {
				continue;
			}
			if (isReachable && cfg.reachableAllowRoles.length > 0 && !cfg.reachableAllowRoles.includes(parentRole)) {
				continue;
			}

			const displayName =
				translatedObjectString(parentObj?.common?.name) || translatedObjectString(obj?.common?.name) || id;
			const room = resolveRoomName(id);
			const modelId = typeof parentObj?.native?.modelid === 'string' ? parentObj.native.modelid : '';
			const stateUnit = typeof obj?.common?.unit === 'string' ? obj.common.unit.trim() : '';

			next.set(id, {
				signal: isBattery ? 'battery' : 'reachable',
				name: displayName,
				room,
				parentRole,
				modelId,
				stateUnit,
			});
		}

		return next;
	};

	/**
	 * Synchronize foreign state subscriptions with a new watch map.
	 *
	 * @param {Map<string, object>} next Next watched state map.
	 * @returns {void}
	 */
	const updateSubscriptions = next => {
		for (const id of subscribed) {
			if (!next.has(id)) {
				try {
					iobroker.subscribe.unsubscribeForeignStates(id);
				} catch (e) {
					log.warn(`unsubscribeForeignStates failed for '${id}': ${e?.message || e}`);
				}
				subscribed.delete(id);
				watched.delete(id);
			}
		}

		for (const [id, info] of next.entries()) {
			if (!subscribed.has(id)) {
				try {
					iobroker.subscribe.subscribeForeignStates(id);
					subscribed.add(id);
				} catch (e) {
					log.warn(`subscribeForeignStates failed for '${id}': ${e?.message || e}`);
					continue;
				}
			}
			watched.set(id, info);
		}
	};

	/**
	 * Create or close the battery task for one watched state.
	 *
	 * @param {string} id State id.
	 * @param {object} state ioBroker state.
	 * @returns {void}
	 */
	const emitBattery = (id, state) => {
		const info = watched.get(id);
		if (!started || !info) {
			return;
		}

		const level = toNumber(state?.val);
		if (level === null) {
			return;
		}

		const ref = messageRef(id);
		if (level >= cfg.batteryRemoveAbove) {
			store.completeAfterCauseEliminated(ref, { actor: pluginInfo.regId });
			return;
		}
		if (level >= cfg.batteryCreateBelow) {
			return;
		}

		const model = HUE_MODELS[info.modelId] || null;
		const deviceLabel = model?.labelKey ? t(model.labelKey) : t('msghub.i18n.IngestHue.model.hueDevice.label');
		const consumables = translateKeyList(model?.consumableKeys || []);
		const tools = translateKeyList(model?.toolKeys || []);
		const estimatedTimeMs = model?.estimatedTimeMs;
		const now = Date.now();
		const audience = buildAudience();

		const msg = factory.createMessage({
			ref,
			icon: '🪫',
			title: t('msghub.i18n.IngestHue.msg.battery.title', deviceLabel, info.name),
			text: t('msghub.i18n.IngestHue.msg.battery.text', level),
			level: constants.level.warning,
			kind: constants.kind.task,
			origin: { type: constants.origin.type.automation, system: cfg.hueInstance, id },
			timing: {
				notifyAt: now,
				remindEvery: BATTERY_REMIND_EVERY_MS,
				dueAt: now + BATTERY_DUE_AFTER_MS,
				...(Number.isFinite(estimatedTimeMs) ? { timeBudget: estimatedTimeMs } : {}),
			},
			details: {
				...(info.room ? { location: info.room } : {}),
				task: t('msghub.i18n.IngestHue.msg.battery.task', info.name),
				reason: t('msghub.i18n.IngestHue.msg.battery.reason', level),
				...(tools.length > 0 ? { tools } : {}),
				...(consumables.length > 0 ? { consumables } : {}),
			},
			metrics: buildStateMetrics(info, state),
			...(audience ? { audience } : {}),
		});
		if (msg) {
			addOrPatchMessage(msg);
		}
	};

	/**
	 * Create or close the reachability status for one watched state.
	 *
	 * @param {string} id State id.
	 * @param {object} state ioBroker state.
	 * @returns {void}
	 */
	const emitReachable = (id, state) => {
		const info = watched.get(id);
		if (!started || !info) {
			return;
		}

		const reachable = toBoolean(state?.val);
		if (reachable === null) {
			return;
		}

		const ref = messageRef(id);
		if (reachable) {
			store.completeAfterCauseEliminated(ref, { actor: pluginInfo.regId });
			return;
		}

		const model = HUE_MODELS[info.modelId] || null;
		const labelKey = model?.labelKey || 'msghub.i18n.IngestHue.model.hueDevice.label';
		const now = Date.now();
		const audience = buildAudience();
		const msg = factory.createMessage({
			ref,
			icon: '⛔',
			title: t('msghub.i18n.IngestHue.msg.reachable.title', t(labelKey), info.name),
			text: t('msghub.i18n.IngestHue.msg.reachable.text'),
			level: constants.level.error,
			kind: constants.kind.status,
			origin: { type: constants.origin.type.automation, system: cfg.hueInstance, id },
			timing: {
				notifyAt: now,
				remindEvery: REACHABLE_REMIND_EVERY_MS,
			},
			details: {
				...(info.room ? { location: info.room } : {}),
				reason: t('msghub.i18n.IngestHue.msg.reachable.reason'),
			},
			metrics: buildStateMetrics(info, state),
			...(audience ? { audience } : {}),
		});
		if (msg) {
			addOrPatchMessage(msg);
		}
	};

	/**
	 * Read and evaluate all currently watched states.
	 *
	 * @returns {Promise<void>} Resolves after evaluation.
	 */
	const evaluateWatchedStates = async () => {
		for (const [id, info] of watched.entries()) {
			const state = await safe(`getForeignState(${id})`, () => iobroker.states.getForeignState(id));
			if (!isPlainObject(state)) {
				continue;
			}
			if (info.signal === 'battery') {
				emitBattery(id, state);
			} else {
				emitReachable(id, state);
			}
		}
	};

	/**
	 * Rediscover Hue states, refresh subscriptions, and evaluate the snapshot.
	 *
	 * @returns {Promise<void>} Resolves after sync.
	 */
	const syncNow = async () => {
		if (!started) {
			return;
		}
		const next = await discoverWatchedStates();
		updateSubscriptions(next);
		await reportManagedObjects();
		await evaluateWatchedStates();
	};

	/**
	 * Schedule periodic rediscovery when configured.
	 *
	 * @returns {void}
	 */
	const startRescanTimer = () => {
		if (!cfg.rescanIntervalMs) {
			return;
		}
		rescanTimer = resources.setInterval(() => {
			syncNow().catch(e => log.warn(`IngestHue rescan failed: ${e?.message || e}`));
		}, cfg.rescanIntervalMs);
	};

	/**
	 * Start the plugin.
	 *
	 * @param {object} ctx Plugin runtime context.
	 * @returns {void}
	 */
	const start = ctx => {
		if (started) {
			return;
		}

		ensureCtxAvailability('IngestHue.start', ctx, {
			plainObject: [
				'api',
				'meta',
				'api.log',
				'api.i18n',
				'api.iobroker',
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
				'api.i18n.t',
				'api.iobroker.objects.getForeignObjects',
				'api.iobroker.objects.getForeignObject',
				'api.iobroker.states.getForeignState',
				'api.iobroker.subscribe.subscribeForeignStates',
				'api.iobroker.subscribe.unsubscribeForeignStates',
				'api.store.addOrUpdateMessage',
				'api.store.getMessageByRef',
				'api.store.updateMessage',
				'api.store.completeAfterCauseEliminated',
				'api.factory.createMessage',
				'meta.options.resolveString',
				'meta.options.resolveInt',
				'meta.options.resolveBool',
				'meta.resources.setInterval',
				'meta.resources.clearInterval',
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
		i18n = ctx.api.i18n;
		pluginInfo = Object.freeze({
			type: typeof ctx?.meta?.plugin?.type === 'string' ? ctx.meta.plugin.type : 'IngestHue',
			instanceId: Number.isFinite(ctx?.meta?.plugin?.instanceId) ? Math.trunc(ctx.meta.plugin.instanceId) : 0,
			regId: typeof ctx?.meta?.plugin?.regId === 'string' ? ctx.meta.plugin.regId : 'IngestHue:0',
		});

		cfg = Object.freeze({
			hueInstance: normalizeHueInstance(ctx.meta.options.resolveString('hueInstance', options.hueInstance)),
			monitorBattery: ctx.meta.options.resolveBool('monitorBattery', options.monitorBattery),
			batteryCreateBelow: ctx.meta.options.resolveInt('batteryCreateBelow', options.batteryCreateBelow),
			batteryRemoveAbove: ctx.meta.options.resolveInt('batteryRemoveAbove', options.batteryRemoveAbove),
			monitorReachable: ctx.meta.options.resolveBool('monitorReachable', options.monitorReachable),
			reachableAllowRoles: csvList(
				ctx.meta.options.resolveString('reachableAllowRolesCsv', options.reachableAllowRolesCsv),
			),
			rescanIntervalMs: ctx.meta.options.resolveInt('rescanIntervalMs', options.rescanIntervalMs),
			audienceTagsCsv: ctx.meta.options.resolveString('audienceTagsCsv', options.audienceTagsCsv),
			audienceChannelsIncludeCsv: ctx.meta.options.resolveString(
				'audienceChannelsIncludeCsv',
				options.audienceChannelsIncludeCsv,
			),
			audienceChannelsExcludeCsv: ctx.meta.options.resolveString(
				'audienceChannelsExcludeCsv',
				options.audienceChannelsExcludeCsv,
			),
		});

		started = true;
		syncNow().catch(e => log.warn(`IngestHue startup sync failed: ${e?.message || e}`));
		startRescanTimer();
	};

	/**
	 * Stop the plugin.
	 *
	 * @returns {void}
	 */
	const stop = () => {
		if (!started) {
			return;
		}
		started = false;
		if (rescanTimer) {
			resources.clearInterval(rescanTimer);
			rescanTimer = null;
		}
		for (const id of subscribed) {
			try {
				iobroker.subscribe.unsubscribeForeignStates(id);
			} catch (e) {
				log.warn(`unsubscribeForeignStates failed for '${id}': ${e?.message || e}`);
			}
		}
		subscribed.clear();
		watched.clear();
		roomsByMember = new Map();
	};

	/**
	 * Handle a Hue state change.
	 *
	 * @param {string} id State id.
	 * @param {object} state ioBroker state.
	 * @returns {void}
	 */
	const onStateChange = (id, state) => {
		if (!started || typeof id !== 'string' || !state || !watched.has(id)) {
			return;
		}
		const info = watched.get(id);
		if (info.signal === 'battery') {
			emitBattery(id, state);
		} else {
			emitReachable(id, state);
		}
	};

	return Object.freeze({
		start,
		stop,
		onStateChange,
	});
}

module.exports = { IngestHue, manifest };
