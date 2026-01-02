/**
 * IngestHue
 * =========
 *
 * Producer plugin that watches Hue adapter states (battery + reachability) and
 * creates/updates/removes MsgHub messages.
 *
 * Design goals
 * - No adapter dependency in the factory: use `ctx.api.*` only.
 * - Stable message refs derived from state ids (dedupe across restarts).
 * - Snapshot-based discovery on startup (low runtime overhead).
 * - Best-effort I/O: never crash the adapter on missing objects / read errors.
 *
 * Message refs
 * - Battery: `hue:battery:<stateId>`
 * - Reachable: `hue:reachable:<stateId>`
 */

'use strict';

const { HUE_MODELS } = require('./models');
const { manifest } = require('./manifest');
const { ensureCtxAvailability } = require('../IoPluginGuards');

/**
 * Create the IngestHue plugin factory.
 *
 * @param {object} [options] Plugin options (from ioBroker `native`); supported keys: `monitorBattery`, `monitorReachable`, `reachableAllowRoles`, `batteryCreateBelow`, `batteryRemoveAbove`.
 * @returns {{ start: (ctx: any) => void, stop: (ctx?: any) => void, onStateChange: (id: string, state: any, ctx?: any) => void, onObjectChange: (id: string, obj: any, ctx?: any) => void }} Plugin handler instance.
 */
function IngestHue(options = {}) {
	const toFiniteNumber = v => {
		if (typeof v === 'number' && Number.isFinite(v)) {
			return v;
		}
		if (typeof v === 'string' && v.trim() !== '') {
			const n = Number(v);
			return Number.isFinite(n) ? n : null;
		}
		return null;
	};

	const toBoolean = v => {
		if (typeof v === 'boolean') {
			return v;
		}
		if (typeof v === 'number' && Number.isFinite(v)) {
			return v !== 0;
		}
		if (typeof v === 'string') {
			const s = v.trim().toLowerCase();
			if (s === 'true' || s === '1' || s === 'on') {
				return true;
			}
			if (s === 'false' || s === '0' || s === 'off') {
				return false;
			}
		}
		return null;
	};

	const normalizeStringArray = v => {
		if (Array.isArray(v)) {
			return v
				.filter(x => typeof x === 'string')
				.map(x => x.trim())
				.filter(Boolean);
		}
		if (typeof v === 'string') {
			return v
				.split(',')
				.map(p => p.trim())
				.filter(Boolean);
		}
		return null;
	};

	const cfg = Object.freeze({
		monitorBattery: options.monitorBattery !== false,
		monitorReachable: options.monitorReachable !== false,
		reachableAllowRoles: normalizeStringArray(options.reachableAllowRoles) || ['ZLLSwitch', 'ZLLPresence'], // [] => allow all
		batteryCreateBelow: toFiniteNumber(options.batteryCreateBelow) ?? 7,
		batteryRemoveAbove: toFiniteNumber(options.batteryRemoveAbove) ?? 30,
	});

	let running = false;

	let log = null;
	let store = null;
	let factory = null;
	let constants = null;
	let iobroker = null;
	let i18n = null;
	let managedObjects = null;

	const watched = new Map();
	const subscribed = new Set();
	let roomsByMember = new Map();

	const t = (key, ...args) => i18n.t(String(key), ...args);

	const translatedObjectString = value => {
		if (typeof value === 'string') {
			return value;
		}
		if (!value || typeof value !== 'object') {
			return '';
		}
		const preferred = value.en || value.de;
		if (typeof preferred === 'string') {
			return preferred;
		}
		for (const v of Object.values(value)) {
			if (typeof v === 'string' && v.trim()) {
				return v;
			}
		}
		return '';
	};

	const safe = async (label, fn) => {
		try {
			return await fn();
		} catch (e) {
			log.debug(`IngestHue: ${label} failed: ${e?.message || e}`);
			return null;
		}
	};

	const makeRef = (type, id) => `hue:${type}:${id}`;

	const resolveRoomName = id => {
		for (let cur = id; cur && cur.includes('.'); cur = cur.slice(0, cur.lastIndexOf('.'))) {
			const room = roomsByMember.get(cur);
			if (room) {
				return room;
			}
		}
		return '';
	};

	const buildRoomsIndex = async () => {
		const broker = iobroker;
		const enums =
			(await safe('getForeignObjects(enum.rooms.*)', () => broker.objects.getForeignObjects('enum.rooms.*'))) ||
			{};
		const next = new Map();

		for (const obj of Object.values(enums)) {
			if (!obj || obj.type !== 'enum') {
				continue;
			}
			const members = obj?.common?.members;
			if (!Array.isArray(members) || members.length === 0) {
				continue;
			}
			const roomName = translatedObjectString(obj.common?.name) || obj._id;
			for (const member of members) {
				if (typeof member !== 'string' || !member || next.has(member)) {
					continue;
				}
				next.set(member, roomName);
			}
		}

		roomsByMember = next;
	};

	const reportManagedMeta = async () => {
		const reporter = managedObjects;

		const batteryIds = [];
		const reachableIds = [];
		for (const [id, info] of watched.entries()) {
			(info.type === 'battery' ? batteryIds : reachableIds).push(id);
		}

		if (batteryIds.length > 0) {
			await reporter.report(batteryIds, {
				managedText: t(
					'This state is monitored by the IngestHue plugin.\nA message is created when the battery level drops below %s%% and removed when it rises to %s%% or higher.',
					cfg.batteryCreateBelow,
					cfg.batteryRemoveAbove,
				),
			});
		}
		if (reachableIds.length > 0) {
			await reporter.report(reachableIds, {
				managedText: t(
					'This state is monitored by the IngestHue plugin.\nA message is created when the device becomes unreachable and removed once it is reachable again.',
				),
			});
		}

		await reporter.applyReported();
	};

	const discover = async () => {
		const broker = iobroker;

		await buildRoomsIndex();

		const objects = (await safe('getForeignObjects(hue.*)', () => broker.objects.getForeignObjects('hue.*'))) || {};

		const nextWatched = new Map();

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
			let parentRole = '';
			const parentObj =
				objects[parentId] ||
				(await safe(`getForeignObject(${parentId})`, () => broker.objects.getForeignObject(parentId)));
			parentRole = parentObj?.common?.role || '';

			// Battery noise reduction: skip common "sensor sub-channels" we don't want tasks for.
			if (isBattery && (parentRole === 'ZLLLightLevel' || parentRole === 'ZLLTemperature')) {
				continue;
			}

			// Reachable default filter: avoid noise unless explicitly allowed.
			if (isReachable && cfg.reachableAllowRoles.length > 0 && !cfg.reachableAllowRoles.includes(parentRole)) {
				continue;
			}

			const name = translatedObjectString(obj.common?.name) || id;
			const room = resolveRoomName(id);

			let modelid = '';
			if (isBattery) {
				const baseId = id.slice(0, -'.battery'.length);
				const baseObj =
					objects[baseId] ||
					(await safe(`getForeignObject(${baseId})`, () => broker.objects.getForeignObject(baseId)));
				modelid = baseObj?.native?.modelid || '';
			}

			const info = {
				type: isBattery ? 'battery' : 'reachable',
				name,
				room,
				parentRole,
				modelid,
			};
			nextWatched.set(id, info);
		}

		// Subscribe new ids and update watched info.
		for (const [id, info] of nextWatched.entries()) {
			if (!subscribed.has(id)) {
				try {
					broker.subscribe.subscribeForeignStates(id);
					subscribed.add(id);
				} catch (e) {
					log.warn(`IngestHue: subscribeForeignStates('${id}') failed: ${e?.message || e}`);
					continue;
				}
			}
			watched.set(id, info);
		}

		await reportManagedMeta();
	};

	const emitBattery = (id, value) => {
		const st = store;
		const f = factory;
		const c = constants;
		const info = watched.get(id);
		if (!running || !info) {
			return;
		}

		const level = toFiniteNumber(value);
		if (level == null) {
			return;
		}

		const ref = makeRef('battery', id);

		// Create/update below lower threshold.
		if (level < cfg.batteryCreateBelow) {
			const model = HUE_MODELS[info.modelid] || {};
			const deviceLabel = t(model.label || 'Hue device');
			const title = t('%s: %s', deviceLabel, info.name);

			const rawBattery = model.battery;
			const consumables = Array.isArray(rawBattery)
				? rawBattery.map(x => t(String(x))).filter(Boolean)
				: typeof rawBattery === 'string' && rawBattery.trim()
					? [t(rawBattery.trim())]
					: [];
			const batteryText = consumables.join(', ');

			const text = batteryText
				? t('Battery level is %s%%.\nReplace batteries (%s).', level, batteryText)
				: t('Battery level is %s%%.\nReplace the batteries.', level);

			const rawTools = model.tools;
			const tools = Array.isArray(rawTools)
				? rawTools.map(x => t(String(x))).filter(Boolean)
				: typeof rawTools === 'string' && rawTools.trim()
					? [t(rawTools.trim())]
					: [];

			const created = f.createMessage({
				ref,
				title,
				text,
				level: c.level.warning,
				kind: c.kind.task,
				origin: { type: c.origin.type.automation, system: 'IngestHue', id },
				details: {
					location: info.room || undefined,
					task: t('Replace batteries in "%s"', info.name),
					reason: t('Battery level is %s%%', level),
					tools: tools.length > 0 ? tools : undefined,
					consumables: consumables.length > 0 ? consumables : undefined,
				},
			});

			if (created) {
				st.addOrUpdateMessage(created);
			}
			return;
		}

		// Remove at/above upper threshold.
		if (level >= cfg.batteryRemoveAbove) {
			st.completeAfterCauseEliminated(ref, { actor: 'IngestHue', finishedAt: Date.now() });
		}
	};

	const emitReachable = (id, value) => {
		const st = store;
		const f = factory;
		const c = constants;
		const info = watched.get(id);
		if (!running || !info) {
			return;
		}

		const reachable = toBoolean(value);
		if (reachable == null) {
			return;
		}

		const ref = makeRef('reachable', id);

		if (reachable === false) {
			const roleLabel =
				info.parentRole === 'ZLLPresence'
					? 'Motion sensor'
					: info.parentRole === 'ZLLSwitch'
						? 'Light switch'
						: 'Hue device';
			const title = t('%s: %s', t(roleLabel), info.name);
			const created = f.createMessage({
				ref,
				title,
				text: t('Device is not reachable.'),
				level: c.level.error,
				kind: c.kind.status,
				origin: { type: c.origin.type.automation, system: 'IngestHue', id },
				details: {
					location: info.room || undefined,
					reason: t('Device is not reachable'),
				},
			});
			if (created) {
				st.addOrUpdateMessage(created);
			}
			return;
		}

		st.completeAfterCauseEliminated(ref, { actor: 'IngestHue', finishedAt: Date.now() });
	};

	const evaluateNow = async () => {
		const broker = iobroker;

		for (const [id, info] of watched.entries()) {
			const st = await safe(`getForeignState(${id})`, () => broker.states.getForeignState(id));
			if (!st) {
				continue;
			}
			(info.type === 'battery' ? emitBattery : emitReachable)(id, st.val);
		}
	};

	const start = ctx => {
		if (running) {
			return;
		}
		ensureCtxAvailability('IngestHue.start', ctx, {
			plainObject: [
				'api',
				'meta',
				'api.log',
				'api.i18n',
				'api.store',
				'api.factory',
				'api.constants',
				'api.iobroker',
				'api.iobroker.objects',
				'api.iobroker.states',
				'api.iobroker.subscribe',
				'meta.plugin',
				'meta.resources',
				'meta.managedObjects',
			],
			fn: [
				'api.log.debug',
				'api.log.warn',
				'api.i18n.t',
				'api.store.addOrUpdateMessage',
				'api.store.completeAfterCauseEliminated',
				'api.factory.createMessage',
				'api.iobroker.objects.getForeignObjects',
				'api.iobroker.objects.getForeignObject',
				'api.iobroker.states.getForeignState',
				'api.iobroker.subscribe.subscribeForeignStates',
				'api.iobroker.subscribe.unsubscribeForeignStates',
				'meta.managedObjects.report',
				'meta.managedObjects.applyReported',
			],
		});

		log = ctx.api.log;
		i18n = ctx.api.i18n;
		iobroker = ctx.api.iobroker;
		store = ctx.api.store;
		factory = ctx.api.factory;
		constants = ctx.api.constants;
		managedObjects = ctx.meta.managedObjects;
		running = true;

		// Startup runs best-effort and async so the adapter can continue booting.
		(async () => {
			await discover();
			await evaluateNow();
		})().catch(e => log.warn(`IngestHue: startup failed: ${e?.message || e}`));
	};

	const stop = _ctx => {
		running = false;
		subscribed.clear();
		watched.clear();
		roomsByMember = new Map();
	};

	const onStateChange = (id, state) => {
		if (!running || typeof id !== 'string' || !id || !state) {
			return;
		}
		const info = watched.get(id);
		if (!info) {
			return;
		}
		(info.type === 'battery' ? emitBattery : emitReachable)(id, state.val);
	};

	// Discovery is intentionally startup-only today.
	const onObjectChange = () => {};

	return { start, stop, onStateChange, onObjectChange };
}

module.exports = { IngestHue, manifest };
