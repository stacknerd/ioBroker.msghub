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

/**
 * Create a MsgIngest plugin handler that generates random message traffic.
 *
 * Options are provided by `IoPlugins` from the plugin's ioBroker object `native`, plus `pluginBaseObjectId`.
 *
 * @param {object} [options] Plugin options.
 * @param {number} [options.intervalMinMs] Minimum delay between ticks in ms (default: 2000).
 * @param {number} [options.intervalMaxMs] Maximum delay between ticks in ms (default: 5000).
 * @param {number} [options.maxPool] Maximum number of concurrently "active" messages (default: 10).
 * @param {string} [options.pluginBaseObjectId] Full ioBroker id of this plugin instance base object.
 * @returns {{ start: (ctx: any) => void, stop: (ctx: any) => void }} Ingest handler.
 */
function IngestRandomChaos(options = {}) {
	const toFiniteInt = (value, fallback) => {
		const n = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(n)) {
			return fallback;
		}
		return Math.trunc(n);
	};

	const intervalMinMs = Math.max(50, toFiniteInt(options.intervalMinMs, 2000));
	const intervalMaxMs = Math.max(intervalMinMs, toFiniteInt(options.intervalMaxMs, 5000));
	const maxPool = Math.max(1, toFiniteInt(options.maxPool, 10));

	const ORIGIN_SYSTEM = 'IngestRandomChaos';
	const ORIGIN_ID = 'IngestRandomChaos';
	const ACTOR = 'IngestRandomChaos';

	const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	let slotSeq = 0;

	let ctxRef = null;
	let running = false;
	let timer = null;

	// Stable pool for this run: ref -> entry.
	// Important: this is intentionally capped to `maxPool` entries so we reuse refs and don't spam the archive
	// with unbounded new message refs over time.
	const pool = new Map();

	const randomInt = (min, max) => {
		const a = Math.ceil(min);
		const b = Math.floor(max);
		return Math.floor(Math.random() * (b - a + 1)) + a;
	};

	const pickOne = list => (Array.isArray(list) && list.length > 0 ? list[randomInt(0, list.length - 1)] : undefined);
	const pickFromMap = map => {
		if (!map || typeof map !== 'object') {
			return undefined;
		}
		const values = Object.values(map);
		return pickOne(values);
	};

	const rooms = ['Hallway', 'Kitchen', 'Living Room', 'Office', 'Garage', 'Bedroom', 'Garden'];
	const taskVerbs = ['Check', 'Replace', 'Refill', 'Restart', 'Inspect', 'Clean', 'Update'];
	const taskObjects = ['battery', 'filter', 'router', 'sensor', 'dashboard', 'lamp', 'thermostat'];
	const statusSubjects = ['Temperature', 'Humidity', 'Air quality', 'Power', 'Network', 'Door', 'Window'];
	const statusStates = ['OK', 'Warning', 'Offline', 'Online', 'Degraded', 'Recovered'];

	const getApi = () => {
		const api = ctxRef?.api;
		return api && typeof api === 'object' ? api : null;
	};

	const scheduleNext = () => {
		if (!running) {
			return;
		}
		const delay = randomInt(intervalMinMs, intervalMaxMs);
		timer = setTimeout(() => {
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
			clearTimeout(timer);
			timer = null;
		}
	};

	const makeRef = (kind, slot) => {
		// Reuse stable refs per plugin run to keep the archive footprint bounded.
		return `chaos:${runId}:${kind}:${slot}`;
	};

	const makeOrigin = constants => ({
		type: constants?.origin?.type?.automation || 'automation',
		system: ORIGIN_SYSTEM,
		id: ORIGIN_ID,
	});

	const makeBaseLifecycle = constants => ({
		state: constants?.lifecycle?.state?.open || 'open',
		stateChangedAt: Date.now(),
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

	const buildContentForKind = (kind, constants) => {
		const location = pickOne(rooms) || 'Unknown';
		const level = pickFromMap(constants?.level) ?? 10;
		const now = Date.now();

		if (kind === (constants?.kind?.task || 'task')) {
			const verb = pickOne(taskVerbs) || 'Check';
			const obj = pickOne(taskObjects) || 'sensor';
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

		const subject = pickOne(statusSubjects) || 'Status';
		const state = pickOne(statusStates) || 'OK';
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
		const api = getApi();
		if (!api?.factory?.createMessage || !api?.store?.addMessage || !api?.store?.getMessageByRef) {
			return;
		}

		const constants = api.constants || {};
		const inactive = findAnyInactiveEntry();
		const kind = inactive?.kind || pickOne([constants?.kind?.task || 'task', constants?.kind?.status || 'status']);
		const slot = inactive?.slot || (slotSeq < maxPool ? (slotSeq += 1) : null);
		if (!slot) {
			return;
		}
		const ref = inactive?.ref || makeRef(kind, slot);
		const content = buildContentForKind(kind, constants);

		const includeMetrics = Math.random() < 0.5;

		// Reuse refs where possible:
		// - If the message exists already (likely soft-deleted), revive via updateMessage.
		// - Otherwise create a fresh message once for this ref.
		const existing = api.store.getMessageByRef(ref);
		if (existing) {
			const patch = {
				title: content.title,
				text: content.text,
				level: content.level,
				details: content.details,
				timing: content.timing,
				lifecycle: makeBaseLifecycle(constants),
				metrics: includeMetrics ? makeMetrics() : null,
			};
			const ok = api.store.updateMessage(ref, patch);
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

		const msg = api.factory.createMessage({
			ref,
			title: content.title,
			text: content.text,
			level: content.level,
			kind,
			origin: makeOrigin(constants),
			lifecycle: makeBaseLifecycle(constants),
			timing: content.timing,
			details: content.details,
			metrics: includeMetrics ? makeMetrics() : undefined,
		});

		if (!msg) {
			return;
		}

		const ok = api.store.addMessage(msg);
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
		const api = getApi();
		if (!api?.store?.updateMessage || !api?.store?.getMessageByRef) {
			return;
		}

		const refs = getActiveRefs();
		const ref = pickOne(refs);
		if (!ref) {
			return;
		}

		const existing = api.store.getMessageByRef(ref);
		if (!existing) {
			const entry = pool.get(ref);
			if (entry) {
				entry.active = false;
				pool.set(ref, entry);
			}
			return;
		}

		const constants = api.constants || {};
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
		entry.updates = (entry.updates || 0) + 1;
		pool.set(ref, entry);

		const now = Date.now();
		const patch = {};

		const currentState = existing?.lifecycle?.state || constants?.lifecycle?.state?.open || 'open';
		const isTask = existing.kind === (constants?.kind?.task || 'task');

		// Lifecycle transitions (simple but plausible).
		if (currentState === (constants?.lifecycle?.state?.open || 'open')) {
			const roll = Math.random();
			if (isTask && roll < 0.25) {
				patch.lifecycle = {
					state: constants?.lifecycle?.state?.snoozed || 'snoozed',
					stateChangedAt: now,
					stateChangedBy: ACTOR,
				};
				patch.timing = { notifyAt: now + randomInt(1000 * 15, 1000 * 90) };
			} else if (roll < 0.6) {
				patch.lifecycle = {
					state: constants?.lifecycle?.state?.acked || 'acked',
					stateChangedAt: now,
					stateChangedBy: ACTOR,
				};
			} else if (roll < 0.75) {
				patch.lifecycle = {
					state: constants?.lifecycle?.state?.closed || 'closed',
					stateChangedAt: now,
					stateChangedBy: ACTOR,
				};
			}
		} else if (currentState === (constants?.lifecycle?.state?.snoozed || 'snoozed')) {
			patch.lifecycle = {
				state: constants?.lifecycle?.state?.open || 'open',
				stateChangedAt: now,
				stateChangedBy: ACTOR,
			};
			patch.timing = { notifyAt: now + randomInt(1000 * 2, 1000 * 15) };
		} else if (currentState === (constants?.lifecycle?.state?.acked || 'acked')) {
			if (Math.random() < 0.5) {
				patch.lifecycle = {
					state: constants?.lifecycle?.state?.closed || 'closed',
					stateChangedAt: now,
					stateChangedBy: ACTOR,
				};
			} else {
				patch.lifecycle = {
					state: constants?.lifecycle?.state?.open || 'open',
					stateChangedAt: now,
					stateChangedBy: ACTOR,
				};
			}
		}

		// Content updates (keep it light; avoid touching excluded sections).
		if (Math.random() < 0.6) {
			patch.level = pickFromMap(constants?.level) ?? existing.level;
			const baseText = typeof entry.baseText === 'string' && entry.baseText.trim() ? entry.baseText.trim() : '';
			patch.text = baseText ? `${baseText} (update #${entry.updates})` : `Chaos update #${entry.updates}`;
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

		const ok = api.store.updateMessage(ref, patch);
		if (!ok) {
			// If patching fails (e.g. message got removed concurrently), mark it inactive to allow revival later.
			entry.active = false;
			pool.set(ref, entry);
		}
	};

	const removeOne = () => {
		const api = getApi();
		if (!api?.store?.removeMessage) {
			return;
		}

		const refs = getActiveRefs();
		const ref = pickOne(refs);
		if (!ref) {
			return;
		}

		api.store.removeMessage(ref);
		const entry = pool.get(ref);
		if (entry) {
			entry.active = false;
			pool.set(ref, entry);
		}
	};

	const tick = () => {
		const api = getApi();
		if (!api) {
			return;
		}

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
			ctxRef = ctx;
			running = true;
			stopTimer();
			scheduleNext();
			ctx?.api?.log?.info?.(
				`IngestRandomChaos: started (interval=${intervalMinMs}..${intervalMaxMs}ms, maxPool=${maxPool})`,
			);
		},
		stop(ctx) {
			running = false;
			stopTimer();
			const api = ctx?.api || getApi();
			if (api?.store?.removeMessage) {
				for (const ref of pool.keys()) {
					api.store.removeMessage(ref);
				}
			}
			pool.clear();
			ctx?.api?.log?.info?.('IngestRandomChaos: stopped');
		},
	};
}

module.exports = { IngestRandomChaos };
