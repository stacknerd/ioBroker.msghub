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

/**
 * Create the IngestHue plugin factory.
 *
 * @param {object} [options] Plugin options (from ioBroker `native`); supported keys: `monitorBattery`, `monitorReachable`, `reachableAllowRoles`, `batteryCreateBelow`, `batteryRemoveAbove`.
 * @returns {{ start: (ctx: any) => void, stop: (ctx?: any) => void, onStateChange: (id: string, state: any, ctx?: any) => void, onObjectChange: (id: string, obj: any, ctx?: any) => void }} Plugin handler instance.
 */
function IngestHue(options = {}) {
	const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

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

	let ctxRef = null;
	let running = false;

	const watched = new Map();
	const subscribed = new Set();
	let roomsByMember = new Map();

	const api = () => (ctxRef && isPlainObject(ctxRef.api) ? ctxRef.api : null);

	const log = () => api()?.log || null;
	const store = () => api()?.store || null;
	const factory = () => api()?.factory || null;
	const constants = () => api()?.constants || null;
	const iobroker = () => api()?.iobroker || null;
	const i18n = () => api()?.i18n || null;

	const t = (key, ...args) => {
		const tr = i18n();
		if (!tr || typeof tr.t !== 'function') {
			// Minimal fallback: substitute %s placeholders.
			let s = key == null ? '' : String(key);
			for (const arg of args) {
				s = s.replace('%s', arg == null ? '' : String(arg));
			}
			return s;
		}
		return tr.t(String(key), ...args);
	};

	const translatedObjectString = value => {
		const tr = i18n();
		if (typeof value === 'string') {
			return value;
		}
		if (!tr || typeof tr.getTranslatedObject !== 'function') {
			return '';
		}
		return tr.getTranslatedObject(value) || '';
	};

	const safe = async (label, fn) => {
		try {
			return await fn();
		} catch (e) {
			log()?.debug?.(`IngestHue: ${label} failed: ${e?.message || e}`);
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
		const broker = iobroker();
		if (!broker?.objects?.getForeignObjects) {
			return;
		}

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
		const reporter = ctxRef?.meta?.managedObjects;
		if (!reporter || typeof reporter.report !== 'function' || typeof reporter.applyReported !== 'function') {
			return;
		}

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
		const broker = iobroker();
		if (!broker?.objects?.getForeignObjects || !broker?.objects?.getForeignObject) {
			return;
		}

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

		// Unsubscribe removed ids.
		for (const id of subscribed) {
			if (nextWatched.has(id)) {
				continue;
			}
			try {
				broker.subscribe?.unsubscribeForeignStates?.(id);
			} catch {
				// ignore (best-effort)
			}
			subscribed.delete(id);
			watched.delete(id);
		}

		// Subscribe new ids and update watched info.
		for (const [id, info] of nextWatched.entries()) {
			if (!subscribed.has(id)) {
				try {
					broker.subscribe?.subscribeForeignStates?.(id);
					subscribed.add(id);
				} catch (e) {
					log()?.warn?.(`IngestHue: subscribeForeignStates('${id}') failed: ${e?.message || e}`);
					continue;
				}
			}
			watched.set(id, info);
		}

		await reportManagedMeta();
	};

	const emitBattery = (id, value) => {
		const st = store();
		const f = factory();
		const c = constants();
		const info = watched.get(id);
		if (
			!running ||
			!st?.addOrUpdateMessage ||
			!st?.completeAfterCauseEliminated ||
			!f?.createMessage ||
			!c ||
			!info
		) {
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
				level: c.level?.warning ?? 20,
				kind: c.kind?.task ?? 'task',
				origin: { type: c.origin?.type?.automation ?? 'automation', system: 'IngestHue', id },
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
		const st = store();
		const f = factory();
		const c = constants();
		const info = watched.get(id);
		if (
			!running ||
			!st?.addOrUpdateMessage ||
			!st?.completeAfterCauseEliminated ||
			!f?.createMessage ||
			!c ||
			!info
		) {
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
				level: c.level?.error ?? 30,
				kind: c.kind?.status ?? 'status',
				origin: { type: c.origin?.type?.automation ?? 'automation', system: 'IngestHue', id },
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
		const broker = iobroker();
		if (!broker?.states?.getForeignState) {
			return;
		}

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
		if (!ctx || !isPlainObject(ctx) || !isPlainObject(ctx.api)) {
			throw new Error('IngestHue.start: ctx.api is required');
		}

		// Validate required capabilities early (fail fast, but no legacy adapter access).
		if (!ctx.api.store?.addOrUpdateMessage || !ctx.api.store?.removeMessage) {
			throw new Error('IngestHue.start: ctx.api.store.addOrUpdateMessage is required');
		}
		if (typeof ctx.api.store?.completeAfterCauseEliminated !== 'function') {
			throw new Error('IngestHue.start: ctx.api.store.completeAfterCauseEliminated is required');
		}
		if (typeof ctx.api.factory?.createMessage !== 'function') {
			throw new Error('IngestHue.start: ctx.api.factory.createMessage is required');
		}
		if (!ctx.api.constants) {
			throw new Error('IngestHue.start: ctx.api.constants is required');
		}
		if (!ctx.api.iobroker?.objects?.getForeignObjects || !ctx.api.iobroker?.objects?.getForeignObject) {
			throw new Error(
				'IngestHue.start: ctx.api.iobroker.objects.getForeignObjects/getForeignObject are required',
			);
		}
		if (!ctx.api.iobroker?.states?.getForeignState) {
			throw new Error('IngestHue.start: ctx.api.iobroker.states.getForeignState is required');
		}
		if (
			!ctx.api.iobroker?.subscribe?.subscribeForeignStates ||
			!ctx.api.iobroker?.subscribe?.unsubscribeForeignStates
		) {
			throw new Error(
				'IngestHue.start: ctx.api.iobroker.subscribe.subscribeForeignStates/unsubscribeForeignStates are required',
			);
		}

		ctxRef = ctx;
		running = true;

		// Startup runs best-effort and async so the adapter can continue booting.
		(async () => {
			await discover();
			await evaluateNow();
		})().catch(e => log()?.warn?.(`IngestHue: startup failed: ${e?.message || e}`));
	};

	const stop = () => {
		const broker = iobroker();
		running = false;

		for (const id of subscribed) {
			try {
				broker?.subscribe?.unsubscribeForeignStates?.(id);
			} catch {
				// ignore (best-effort)
			}
		}
		subscribed.clear();
		watched.clear();
		roomsByMember = new Map();

		ctxRef = null;
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

module.exports = { IngestHue };
