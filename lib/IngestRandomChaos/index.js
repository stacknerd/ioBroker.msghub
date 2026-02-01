/**
 * IngestRandomChaos
 * ================
 * Demo/load generator for MsgHub.
 *
 * While enabled, this ingest plugin periodically injects "compressed realism" into the store:
 * create/update/remove cycles with plausible lifecycle transitions and occasional metric changes.
 *
 * Docs: ../../docs/plugins/IngestRandomChaos.md
 */

'use strict';

const { manifest } = require('./manifest');
const { ensureCtxAvailability } = require('../IoPluginGuards');

/**
 * Create a MsgIngest plugin handler that generates random message traffic.
 *
 * Options are provided by `IoPlugins` from the plugin's ioBroker object `native`, plus `pluginBaseObjectId`.
 *
 * @param {object} [options] Plugin options.
 * @param {number} [options.intervalMinMs] Minimum delay between ticks in ms (see `manifest.options`).
 * @param {number} [options.intervalMaxMs] Maximum delay between ticks in ms (see `manifest.options`).
 * @param {number} [options.maxPool] Maximum number of concurrently "active" messages (see `manifest.options`).
 * @param {string} [options.pluginBaseObjectId] Full ioBroker id of this plugin instance base object.
 * @returns {{ start: (ctx: any) => void, stop: (ctx: any) => void }} Ingest handler.
 */
function IngestRandomChaos(options = {}) {
	let intervalMinMs = 0;
	let intervalMaxMs = 0;
	let maxPool = 0;

	const ORIGIN_SYSTEM = 'IngestRandomChaos';
	const ORIGIN_ID = 'IngestRandomChaos';
	const ACTOR = 'IngestRandomChaos';

	const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	let slotSeq = 0;

	let log = null;
	let store = null;
	let factory = null;
	let constants = null;
	let running = false;
	let timer = null;
	let resourcesRef = null;
	let originAutomationType = null;
	let kindTask = null;
	let kindStatus = null;
	let kindAppointment = null;
	let kindShoppinglist = null;
	let kindInventorylist = null;
	let stateOpen = null;
	let stateSnoozed = null;
	let stateAcked = null;
	let stateClosed = null;
	let levelValues = [];

	let refOwnId = 'IngestRandomChaos.0';

	// Stable pool for this run: ref -> entry.
	// Important: this is intentionally capped to `maxPool` entries so we reuse refs and don't spam the archive
	// with unbounded new message refs over time.
	const pool = new Map();

	const randomInt = (min, max) => {
		const a = Math.ceil(min);
		const b = Math.floor(max);
		return Math.floor(Math.random() * (b - a + 1)) + a;
	};

	const pickOne = list => list[randomInt(0, list.length - 1)];

	const rooms = ['Hallway', 'Kitchen', 'Living Room', 'Office', 'Garage', 'Bedroom', 'Garden'];
	const taskVerbs = ['Check', 'Replace', 'Refill', 'Restart', 'Inspect', 'Clean', 'Update'];
	const taskObjects = ['battery', 'filter', 'router', 'sensor', 'dashboard', 'lamp', 'thermostat'];
	const statusSubjects = ['Temperature', 'Humidity', 'Air quality', 'Power', 'Network', 'Door', 'Window'];
	const statusStates = ['OK', 'Warning', 'Offline', 'Online', 'Degraded', 'Recovered'];

	const scheduleNext = () => {
		if (!running) {
			return;
		}
		const delay = randomInt(intervalMinMs, intervalMaxMs);
		timer = resourcesRef.setTimeout(() => {
			timer = null;
			try {
				tick();
			} finally {
				scheduleNext();
			}
		}, delay);
	};

	const stopTimer = () => {
		if (timer) {
			resourcesRef.clearTimeout(timer);
			timer = null;
		}
	};

	const makeRef = (kind, slot) => {
		// Reuse stable refs per plugin run to keep the archive footprint bounded.
		// Use only "URL-unreserved-ish" characters so MsgFactory doesn't need to normalize (and warn / double-encode).
		return `${refOwnId}.${runId}.${kind}.${slot}`;
	};

	const makeOrigin = () => ({
		type: originAutomationType,
		system: ORIGIN_SYSTEM,
		id: ORIGIN_ID,
	});

	const makeBaseLifecycle = () => ({
		state: stateOpen,
		stateChangedBy: ACTOR,
	});

	const makeMetrics = () => {
		// Metrics must be a Map in the canonical store.
		const now = Date.now();
		const key = pickOne(['progress', 'temperature', 'battery', 'latency']);
		if (key === 'temperature') {
			return new Map([[key, { val: randomInt(18, 28), unit: 'C', ts: now }]]);
		}
		if (key === 'battery') {
			return new Map([[key, { val: randomInt(5, 100), unit: '%', ts: now }]]);
		}
		if (key === 'latency') {
			return new Map([[key, { val: randomInt(10, 400), unit: 'ms', ts: now }]]);
		}
		return new Map([[key, { val: randomInt(0, 100), unit: '%', ts: now }]]);
	};

	const computeIcon = ({ kind, level }) => {
		const n = typeof level === 'number' ? level : Number(level);
		const levelWarning =
			typeof constants?.level?.warning === 'number' && Number.isFinite(constants.level.warning)
				? constants.level.warning
				: 30;
		const levelError =
			typeof constants?.level?.error === 'number' && Number.isFinite(constants.level.error)
				? constants.level.error
				: 40;
		const levelCritical =
			typeof constants?.level?.critical === 'number' && Number.isFinite(constants.level.critical)
				? constants.level.critical
				: 50;

		// Severity override (>= warning) for demos: quick visual scanning.
		if (Number.isFinite(n) && n >= levelWarning) {
			if (n >= levelCritical) {
				return '🛑';
			}
			if (n >= levelError) {
				return '❌';
			}
			return '⚠️';
		}

		// Kind-first base icons.
		if (kind === kindTask) {
			return '✅';
		}
		if (kind === kindStatus) {
			return '📡';
		}
		if (kindAppointment && kind === kindAppointment) {
			return '📅';
		}
		if (kindShoppinglist && kind === kindShoppinglist) {
			return '🛒';
		}
		if (kindInventorylist && kind === kindInventorylist) {
			return '📦';
		}
		return '';
	};

	const buildContentForKind = kind => {
		const location = pickOne(rooms);
		const level = pickOne(levelValues);
		const now = Date.now();

		if (kind === kindTask) {
			const verb = pickOne(taskVerbs);
			const obj = pickOne(taskObjects);
			const title = `${verb} ${obj}`;
			const text = `${verb} the ${obj} in ${location}.`;
			return {
				title,
				text,
				level,
				details: { location, task: `${verb} ${obj}` },
				timing: {
					// "compressed realism": due soon, but notify a bit earlier.
					dueAt: now + randomInt(1000 * 15, 1000 * 90),
					notifyAt: now + randomInt(1000 * 2, 1000 * 20),
				},
			};
		}

		const subject = pickOne(statusSubjects);
		const state = pickOne(statusStates);
		const title = `${subject} (${location})`;
		const text = `${subject} is ${state} in ${location}.`;
		return {
			title,
			text,
			level,
			details: { location, reason: `${subject}:${state}` },
			timing: {
				notifyAt: now + randomInt(1000 * 2, 1000 * 20),
			},
		};
	};

	const isEntryActive = entry => entry && entry.active === true;
	const getActiveRefs = () =>
		Array.from(pool.values())
			.filter(isEntryActive)
			.map(e => e.ref);
	const findAnyInactiveEntry = () => Array.from(pool.values()).find(e => !isEntryActive(e));

	const createOne = () => {
		const inactive = findAnyInactiveEntry();
		const kind = inactive ? inactive.kind : pickOne([kindTask, kindStatus]);
		const slot = inactive ? inactive.slot : slotSeq < maxPool ? (slotSeq += 1) : null;
		if (!slot) {
			return;
		}
		const ref = inactive ? inactive.ref : makeRef(kind, slot);
		const content = buildContentForKind(kind);

		const includeMetrics = Math.random() < 0.5;

		// Reuse refs where possible, but keep semantics explicit:
		// - update only when quasi-open (active)
		// - otherwise recreate via addMessage (so the core can produce realistic recreated/recovered behavior)
		const existing = store.getMessageByRef(ref, 'quasiOpen');
		if (existing) {
			const desiredIcon = computeIcon({ kind, level: content.level });
			const patch = {
				title: content.title,
				text: content.text,
				level: content.level,
				...(desiredIcon && existing.icon !== desiredIcon ? { icon: desiredIcon } : {}),
				lifecycle: makeBaseLifecycle(),
				timing: content.timing,
				details: content.details,
				metrics: includeMetrics ? makeMetrics() : null,
			};
			const ok = store.updateMessage(ref, patch);
			if (!ok) {
				return;
			}
			pool.set(ref, {
				ref,
				slot,
				kind,
				active: true,
				hasMetrics: includeMetrics,
				baseTitle: content.title,
				baseText: content.text,
				updates: 0,
			});
			return;
		}

		const icon = computeIcon({ kind, level: content.level });
		const msg = factory.createMessage({
			ref,
			...(icon ? { icon } : {}),
			title: content.title,
			text: content.text,
			level: content.level,
			kind,
			origin: makeOrigin(),
			lifecycle: makeBaseLifecycle(),
			timing: content.timing,
			details: content.details,
			metrics: includeMetrics ? makeMetrics() : undefined,
		});

		if (!msg) {
			return;
		}

		const ok = store.addMessage(msg);
		if (!ok) {
			return;
		}

		pool.set(ref, {
			ref,
			slot,
			kind,
			active: true,
			hasMetrics: includeMetrics,
			baseTitle: content.title,
			baseText: content.text,
			updates: 0,
		});
	};

	const updateOne = () => {
		const refs = getActiveRefs();
		if (refs.length === 0) {
			return;
		}
		const ref = pickOne(refs);
		const existing = store.getMessageByRef(ref, 'quasiOpen');
		if (!existing) {
			const entry = pool.get(ref);
			if (entry) {
				entry.active = false;
				pool.set(ref, entry);
			}
			return;
		}

		const entry = pool.get(ref) || {
			ref,
			slot: null,
			kind: existing.kind,
			active: true,
			hasMetrics: false,
			baseTitle: '',
			baseText: '',
			updates: 0,
		};
		entry.updates += 1;
		pool.set(ref, entry);

		const now = Date.now();
		const patch = {};

		const currentState =
			existing && existing.lifecycle && typeof existing.lifecycle.state === 'string'
				? existing.lifecycle.state
				: stateOpen;
		const isTask = existing.kind === kindTask;

		// Lifecycle transitions (simple but plausible).
		if (currentState === stateOpen) {
			const roll = Math.random();
			if (isTask && roll < 0.25) {
				patch.lifecycle = { state: stateSnoozed, stateChangedBy: ACTOR };
				patch.timing = { notifyAt: now + randomInt(1000 * 15, 1000 * 90) };
			} else if (roll < 0.6) {
				patch.lifecycle = { state: stateAcked, stateChangedBy: ACTOR };
			} else if (roll < 0.75) {
				patch.lifecycle = { state: stateClosed, stateChangedBy: ACTOR };
			}
		} else if (currentState === stateSnoozed) {
			patch.lifecycle = { state: stateOpen, stateChangedBy: ACTOR };
			patch.timing = { notifyAt: now + randomInt(1000 * 2, 1000 * 15) };
		} else if (currentState === stateAcked) {
			patch.lifecycle = {
				state: Math.random() < 0.5 ? stateClosed : stateOpen,
				stateChangedBy: ACTOR,
			};
		}

		// Content updates (keep it light; avoid touching excluded sections).
		if (Math.random() < 0.6) {
			patch.level = pickOne(levelValues);
			patch.text = entry.baseText
				? `${entry.baseText} (update #${entry.updates})`
				: `Chaos update #${entry.updates}`;
		}

		// Icon: keep consistent with kind + severity (derived).
		{
			const nextLevel = Object.prototype.hasOwnProperty.call(patch, 'level') ? patch.level : existing.level;
			const desiredIcon = computeIcon({ kind: existing.kind, level: nextLevel });
			if (desiredIcon && existing.icon !== desiredIcon) {
				patch.icon = desiredIcon;
			}
		}

		// Metrics updates (only when the message originally had metrics).
		if (entry.hasMetrics && Math.random() < 0.5) {
			const metricKey = pickOne(['progress:%', 'temperature:C', 'battery:%', 'latency:ms']);
			const [key, unitRaw] = String(metricKey).split(':');
			const unit = unitRaw || (key === 'temperature' ? 'C' : key === 'latency' ? 'ms' : '%');
			const val =
				key === 'temperature'
					? randomInt(18, 28)
					: key === 'battery'
						? randomInt(5, 100)
						: key === 'latency'
							? randomInt(10, 400)
							: randomInt(0, 100);
			patch.metrics = { set: { [key]: { val, unit, ts: now } } };
		}

		// No-op guard.
		if (Object.keys(patch).length === 0) {
			return;
		}

		const ok = store.updateMessage(ref, patch);
		if (!ok) {
			// If patching fails (e.g. message got removed concurrently), mark it inactive to allow revival later.
			entry.active = false;
			pool.set(ref, entry);
			return;
		}
		if (patch?.lifecycle?.state === stateClosed) {
			entry.active = false;
			pool.set(ref, entry);
		}
	};

	const removeOne = () => {
		const refs = getActiveRefs();
		if (refs.length === 0) {
			return;
		}
		const ref = pickOne(refs);

		store.removeMessage(ref);
		const entry = pool.get(ref);
		if (entry) {
			entry.active = false;
			pool.set(ref, entry);
		}
	};

	const tick = () => {
		const activeCount = getActiveRefs().length;
		if (activeCount === 0) {
			createOne();
			return;
		}

		// Keep the pool filled (creates become less likely when at/over max).
		const allowCreate = activeCount < maxPool;
		const roll = Math.random();

		if (allowCreate && roll < 0.35) {
			createOne();
			return;
		}
		if (roll < 0.8) {
			updateOne();
			return;
		}
		removeOne();
	};

	return {
		start(ctx) {
			ensureCtxAvailability('IngestRandomChaos.start', ctx, {
				plainObject: [
					'api',
					'meta',
					'api.log',
					'api.constants',
					'api.factory',
					'api.store',
					'meta.options',
					'meta.resources',
					'meta.plugin',
				],
				fn: [
					'meta.options.resolveInt',
					'meta.resources.setTimeout',
					'meta.resources.clearTimeout',
					'api.log.info',
					'api.factory.createMessage',
					'api.store.addMessage',
					'api.store.updateMessage',
					'api.store.getMessageByRef',
					'api.store.removeMessage',
				],
				stringNonEmpty: ['meta.plugin.baseOwnId'],
			});

			intervalMinMs = ctx.meta.options.resolveInt('intervalMinMs', options.intervalMinMs);
			intervalMaxMs = ctx.meta.options.resolveInt('intervalMaxMs', options.intervalMaxMs);
			intervalMaxMs = Math.max(intervalMinMs, intervalMaxMs);
			maxPool = ctx.meta.options.resolveInt('maxPool', options.maxPool);

			log = ctx.api.log;
			store = ctx.api.store;
			factory = ctx.api.factory;
			constants = ctx.api.constants;

			originAutomationType = constants.origin.type.automation;
			kindTask = constants.kind.task;
			kindStatus = constants.kind.status;
			kindAppointment = constants.kind.appointment;
			kindShoppinglist = constants.kind.shoppinglist;
			kindInventorylist = constants.kind.inventorylist;
			stateOpen = constants.lifecycle.state.open;
			stateSnoozed = constants.lifecycle.state.snoozed;
			stateAcked = constants.lifecycle.state.acked;
			stateClosed = constants.lifecycle.state.closed;
			levelValues = Object.values(constants.level);
			if (levelValues.length === 0) {
				throw new Error('IngestRandomChaos.start: ctx.api.constants.level must contain values');
			}

			resourcesRef = ctx.meta.resources;
			refOwnId = ctx.meta.plugin.baseOwnId.trim();

			running = true;
			stopTimer();
			scheduleNext();
			log.info(`started (interval=${intervalMinMs}..${intervalMaxMs}ms, maxPool=${maxPool})`);
		},
		stop(ctx) {
			// Stop can be called without a ctx (tests) or without a prior start (disabled plugin / best-effort host stop).
			// Prefer the existing captured refs (from start), but fall back to ctx when available.
			if (!store && ctx?.api?.store) {
				store = ctx.api.store;
			}
			if (!log && ctx?.api?.log) {
				log = ctx.api.log;
			}
			if (!resourcesRef && ctx?.meta?.resources) {
				resourcesRef = ctx.meta.resources;
			}
			if (ctx?.meta?.plugin?.baseOwnId && typeof ctx.meta.plugin.baseOwnId === 'string') {
				const next = ctx.meta.plugin.baseOwnId.trim();
				if (next) {
					refOwnId = next;
				}
			}

			running = false;
			stopTimer();

			const removedRefs = new Set();

			// 1) Remove messages from the current run (tracked pool).
			if (store?.removeMessage) {
				for (const ref of pool.keys()) {
					removedRefs.add(ref);
					store.removeMessage(ref, { actor: ACTOR });
				}
			}

			// 2) Best-effort cleanup of stale messages from previous runs/crashes.
			//    Those refs are not in `pool` (because `runId` changes on every start).
			if (store?.removeMessage && typeof store?.getMessages === 'function') {
				const prefix = `${refOwnId}.`;
				const messages = store.getMessages();
				for (const msg of messages) {
					const ref = typeof msg?.ref === 'string' ? msg.ref : '';
					if (!ref || removedRefs.has(ref) || !ref.startsWith(prefix)) {
						continue;
					}
					if (msg?.origin?.system && msg.origin.system !== ORIGIN_SYSTEM) {
						continue;
					}
					if (msg?.origin?.id && msg.origin.id !== ORIGIN_ID) {
						continue;
					}
					removedRefs.add(ref);
					store.removeMessage(ref, { actor: ACTOR });
				}
			}

			pool.clear();
			log?.info?.('stopped');
		},
	};
}

module.exports = { IngestRandomChaos, manifest };
