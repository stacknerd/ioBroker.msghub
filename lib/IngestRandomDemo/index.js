/**
 * IngestRandomDemo
 * ===============
 * Random/demo producer plugin for MsgHub (MsgIngest).
 *
 * Docs: ../../docs/plugins/IngestRandomDemo.md
 *
 * Purpose
 * -------
 * This plugin exists as a development/test producer that exercises the "happy path" of the system:
 * - it does not subscribe to any ioBroker states,
 * - it periodically creates/updates MsgHub messages through the public `ctx.api.store.*` API,
 * - messages are short-lived (TTL) to avoid unbounded list growth.
 *
 * Where it sits in the system
 * ---------------------------
 * - The adapter (`main.js`) owns the `MsgStore` instance (core in `src/`).
 * - `MsgStore` owns `msgIngest`, which dispatches inbound events to producer plugins like this one.
 * - `MsgPlugins` wires this factory into the ingest host and calls `start()` / `stop()` based on enable states.
 *
 * Core responsibilities
 * --------------------
 * - Generate a stable pool of refs and "upsert" within that pool:
 *   - if a ref does not exist yet: create a new message (via `ctx.api.factory.createMessage()` + `ctx.api.store.addMessage()`).
 *   - if it exists: update it (via `ctx.api.store.updateMessage()`).
 * - Keep messages self-cleaning by setting `timing.expiresAt`.
 *
 * Design guidelines / invariants (similar spirit as `MsgStore`)
 * ------------------------------------------------------------
 * - Single source of truth: never mutate MsgStore internals; only use `ctx.api.store.*` methods.
 * - Normalization boundary: create full messages via `ctx.api.factory.createMessage()`; for updates, send patches only.
 * - Best-effort operation: demo producers must never crash the adapter; runtime errors are caught and logged.
 * - Predictable lifecycle: `start()` is idempotent, `stop()` is safe to call multiple times.
 */

/**
 *
 * constants: import('../../src/MsgConstants').MsgConstants,
 * factory: { createMessage: Function },
 * store: {
 * addMessage: Function,
 * updateMessage: Function,
 * getMessageByRef: Function
 * }
 * }} api Stable ingestion API surface provided by `MsgIngest`.
 *
 * [meta] Dispatch metadata (reason, pluginId, ...).
 */

/**
 * [intervalMs=15000] Generation interval in ms.
 *
 * [ttlMs=120000] Base message time-to-live in ms.
 *
 * [ttlJitter=0.5] TTL randomization ratio (0.5 => +/- 50%).
 *
 * [refPoolSize=15] Size of the stable ref pool (limits concurrent demo messages).
 *
 * pluginBaseObjectId Full object id of the plugin base object (required, e.g. `msghub.0.IngestRandomDemo.0`).
 */

/**
 * Create a MsgIngest producer plugin that periodically generates random demo messages.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance (logger only).
 * @param {IngestRandomDemoOptions} [options] Plugin options (stored in ioBroker object `native`).
 * @returns {{ start: (ctx: MsgIngestProducerContext) => void, stop: (ctx?: MsgIngestProducerContext) => void }} Plugin instance.
 */
function IngestRandomDemo(adapter, options = {}) {
	if (!adapter) {
		throw new Error('IngestRandomDemo: adapter is required');
	}

	// ---------------------------------------------------------------------------
	// Configuration and derived identifiers
	// ---------------------------------------------------------------------------
	const { intervalMs = 15000, ttlMs = 120000, ttlJitter = 0.5, refPoolSize = 15, pluginBaseObjectId } = options;

	const baseFullId = typeof pluginBaseObjectId === 'string' ? pluginBaseObjectId.trim() : '';
	if (!baseFullId) {
		throw new Error('IngestRandomDemo: options.pluginBaseObjectId is required');
	}

	// ---------------------------------------------------------------------------
	// Runtime state (ingest-local)
	// ---------------------------------------------------------------------------
	let timer = null;
	let ctxRef = null;
	let levels = null;
	let kinds = null;

	/**
	 * Pick a random element from a non-empty list.
	 *
	 * This is intentionally tiny: the demo keeps all randomness local so the rest of the pipeline
	 * (factory/store/render/notify) can be tested deterministically by controlling the timer only.
	 *
	 * @template T
	 * @param {T[]} list Non-empty list to pick from.
	 * @returns {T} Random element from the list.
	 */
	const pick = list => list[Math.floor(Math.random() * list.length)];

	/**
	 * Stable ref pool (bounded growth)
	 *
	 * We reuse a fixed set of refs instead of generating UUIDs:
	 * - The store won't grow beyond `refPoolSize` messages (expired messages are pruned by MsgStore anyway).
	 * - Updates exercise `MsgStore.updateMessage()` and `MsgFactory.applyPatch()` continuously.
	 */
	const refPool = Array.from({ length: refPoolSize }, (_, i) => `${baseFullId}_ref${String(i + 1).padStart(2, '0')}`);

	/**
	 * Random integer in the inclusive range [min, max].
	 *
	 * @param {number} min Minimum value (inclusive).
	 * @param {number} max Maximum value (inclusive).
	 * @returns {number} Random integer in the range.
	 */
	const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

	/**
	 * Pick a TTL value for the current tick.
	 *
	 * Notes:
	 * - `ttlMs` may be configured as a number or numeric string; we coerce with `Number(...)`.
	 * - `ttlJitter` is clamped to >= 0; negative jitter makes little sense.
	 * - `min` is clamped to at least 1000ms so messages don't disappear "immediately" in typical demos.
	 *
	 * If you want messages to expire immediately (for stress testing), set `ttlMs <= 0` and/or use a tiny interval.
	 *
	 * @returns {number} TTL in milliseconds.
	 */
	const pickTtlMs = () => {
		const baseTtlMs = Number.isFinite(Number(ttlMs)) ? Number(ttlMs) : 120000;
		if (baseTtlMs <= 0) {
			return baseTtlMs;
		}
		const jitter = Number.isFinite(Number(ttlJitter)) ? Math.max(0, Number(ttlJitter)) : 0;
		const min = Math.max(1000, Math.floor(baseTtlMs * (1 - jitter)));
		const max = Math.max(min, Math.floor(baseTtlMs * (1 + jitter)));
		return randInt(min, max);
	};

	const titles = [
		'Demo Alert',
		'Random Event',
		'Test Notification',
		'System Notice',
		'Status Update',
		'Service Message',
		'Heartbeat Ping',
		'Background Job',
		'Queue Update',
		'Sync Notice',
		'Connection Status',
		'Maintenance Note',
		'Operational Info',
		'Health Check',
		'Activity Report',
	];

	const texts = [
		'Sample text (random).',
		'This is an automatically generated demo message.',
		'For testing purposes only.',
		'Quick status update from the demo producer.',
		'A random entry to verify the data flow.',
		'Mock notification created for validation.',
		'Synthetic event emitted by the test pipeline.',
		'Demo payload: no action required.',
		'Generated message to confirm end-to-end delivery.',
		'A placeholder update from the notification service.',
		'Randomized test event for monitoring.',
		'System note: running in demo mode.',
		'Status check: all services responding.',
		'Health ping received from the producer.',
		'Verification entry: message routing OK.',
	];

	const tick = () => {
		const now = Date.now();
		const ref = pick(refPool);
		const ttlNow = pickTtlMs();

		// Creation path:
		// - We create full messages through the factory to keep normalization rules in one place.
		// - We set expiresAt so MsgStore can prune the message later.
		// - We intentionally do NOT set notifyAt; MsgStore will treat "no notifyAt" as immediately due.
		if (ctxRef.api.store.getMessageByRef(ref) == null) {
			const created = ctxRef.api.factory.createMessage({
				ref,
				title: pick(titles),
				text: pick(texts),
				level: pick(levels),
				kind: pick(kinds),
				origin: { type: ctxRef.api.constants.origin.type.automation, system: 'IngestRandomDemo' },
				timing: { expiresAt: now + ttlNow },
			});
			if (created) {
				ctxRef.api.store.addMessage(created);
			}
			return;
		}

		// Update path:
		// - We send only a patch object, not a full message.
		// - MsgStore delegates validation and merge semantics to MsgFactory.applyPatch().
		// - We refresh expiresAt on every update to keep the set "alive" while the plugin runs.
		ctxRef.api.store.updateMessage(ref, {
			title: pick(titles),
			text: pick(texts),
			level: pick(levels),
			timing: { expiresAt: now + ttlNow },
		});
	};

	/**
	 * Start the producer (idempotent).
	 *
	 * Contract:
	 * - Called by MsgPlugins when the plugin gets enabled.
	 * - A valid MsgHub plugin context is required; we only use `ctx.api.store/factory/constants`.
	 * - The producer will emit one immediate tick to verify wiring before the first interval fires.
	 *
	 * @param {MsgIngestProducerContext} ctx MsgHub ingest plugin context.
	 * @returns {void}
	 */
	const start = ctx => {
		if (timer) {
			return;
		}
		if (!ctx?.api?.store || !ctx?.api?.factory || !ctx?.api?.constants) {
			throw new Error('IngestRandomDemo.start: ctx.api.store/factory/constants are required');
		}
		ctxRef = ctx;
		levels = Object.values(ctx.api.constants.level);
		kinds = Object.values(ctx.api.constants.kind);

		// Create the first message immediately to verify the wiring.
		try {
			tick();
		} catch (e) {
			adapter?.log?.warn?.(`IngestRandomDemo: tick failed: ${e?.message || e}`);
		}

		// Periodic generation.
		// Any runtime errors are caught per-tick so the interval doesn't stop silently.
		timer = setInterval(() => {
			try {
				tick();
			} catch (e) {
				adapter?.log?.warn?.(`IngestRandomDemo: tick failed: ${e?.message || e}`);
			}
		}, intervalMs);
	};

	/**
	 * Stop the producer (idempotent).
	 *
	 * Notes:
	 * - Existing messages are not deleted here; they will expire naturally via `expiresAt`.
	 * - This keeps stop() side-effect-light and mirrors the "best-effort" philosophy of core components.
	 *
	 * @returns {void}
	 */
	const stop = () => {
		if (!timer) {
			return;
		}
		clearInterval(timer);
		timer = null;
		ctxRef = null;
		levels = null;
		kinds = null;
	};

	return { start, stop };
}

module.exports = { IngestRandomDemo };
