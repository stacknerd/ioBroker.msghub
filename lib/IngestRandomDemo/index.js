/**
 * Create a MsgIngest producer plugin that periodically generates random demo messages.
 *
 * Docs: ../../docs/plugins/IngestRandomDemo.md
 *
 * This plugin is intended for development/testing:
 * - it does not subscribe to ioBroker states,
 * - it creates/updates messages on an interval,
 * - created messages auto-expire to avoid unbounded list growth.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance (logger only).
 * @param {object} [options] Plugin options.
 * @param {number} [options.intervalMs] Generation interval in ms (default: 15000).
 * @param {number} [options.ttlMs] Message time-to-live base in ms (default: 120000).
 * @param {number} [options.ttlJitter] TTL randomization ratio (default: 0.5 = 50%).
 * @param {number} [options.refPoolSize] Number of refs used in "create" mode (default: 15).
 * @param {string} [options.pluginBaseObjectId] Full object id of the plugin base object
 *   (e.g. `msghub.0.IngestRandomDemo.0`).
 * @returns {{ start: (ctx: object) => void, stop: (ctx?: object) => void }} Plugin instance.
 */
function IngestRandomDemo(adapter, options = {}) {
	if (!adapter) {
		throw new Error('IngestRandomDemo: adapter is required');
	}

	const { intervalMs = 15000, ttlMs = 120000, ttlJitter = 0.5, refPoolSize = 15, pluginBaseObjectId } = options;

	const baseFullId = typeof pluginBaseObjectId === 'string' ? pluginBaseObjectId.trim() : '';
	if (!baseFullId) {
		throw new Error('IngestRandomDemo: options.pluginBaseObjectId is required');
	}

	// Use the plugin base object id as ref prefix so multiple instances (different instanceId) do not collide.
	const refPrefix = `${baseFullId}.ingestRandomDemo`;

	let timer = null;
	let ctxRef = null;
	let levels = null;
	let kinds = null;

	const pick = list => list[Math.floor(Math.random() * list.length)];
	const refPool = Array.from({ length: refPoolSize }, (_, i) => `${refPrefix}.${String(i + 1).padStart(2, '0')}`);

	const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
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

	const titles = ['Demo-Meldung', 'Zufallsereignis', 'Test-Notification', 'System-Hinweis', 'Status-Update'];

	const texts = [
		'Beispieltext (random).',
		'Dies ist eine automatisch generierte Demo-Meldung.',
		'Nur zu Testzwecken.',
		'Kurzes Status-Update aus dem Demo-Producer.',
		'Ein zufälliger Eintrag zur Verifikation des Datenflusses.',
	];

	const tick = () => {
		const now = Date.now();
		const ref = pick(refPool);
		const ttlNow = pickTtlMs();

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

		// Update existing messages to keep the demo lively.
		ctxRef.api.store.updateMessage(ref, {
			title: pick(titles),
			text: pick(texts),
			level: pick(levels),
			timing: { expiresAt: now + ttlNow },
		});
	};

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

		timer = setInterval(() => {
			try {
				tick();
			} catch (e) {
				adapter?.log?.warn?.(`IngestRandomDemo: tick failed: ${e?.message || e}`);
			}
		}, intervalMs);
	};

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
