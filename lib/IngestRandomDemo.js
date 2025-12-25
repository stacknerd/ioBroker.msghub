/**
 * Create a MsgIngest producer plugin that periodically generates random demo messages.
 *
 * This plugin is intended for development/testing:
 * - it does not subscribe to ioBroker states,
 * - it creates/updates messages on an interval,
 * - created messages auto-expire to avoid unbounded list growth.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance (logger only).
 * @param {object} [options] Plugin options.
 * @param {number} [options.intervalMs] Generation interval in ms (default: 15000).
 * @param {number} [options.ttlMs] Message time-to-live in ms (default: 120000).
 * @param {number} [options.refPoolSize] Number of refs used in "create" mode (default: 15).
 * @returns {{ start: (ctx: object) => void, stop: (ctx?: object) => void }} Plugin instance.
 */
function IngestRandomDemo(adapter, { intervalMs = 15000, ttlMs = 120000, refPoolSize = 15 } = {}) {
	if (!adapter) {
		throw new Error('IngestRandomDemo: adapter is required');
	}

	const refPrefix = 'IngestRandomDemo';

	let timer = null;
	let seq = 0;
	let ctxRef = null;
	let levels = null;
	let kinds = null;

	const pick = list => list[Math.floor(Math.random() * list.length)];
	const refPool = Array.from({ length: refPoolSize }, (_, i) => `${refPrefix}.${String(i + 1).padStart(2, '0')}`);

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
		seq += 1;
		const ref = refPool[(seq - 1) % refPool.length];

		if (ctxRef.api.store.getMessageByRef(ref) == null) {
			const created = ctxRef.api.factory.createMessage({
				ref,
				title: pick(titles),
				text: pick(texts),
				level: pick(levels),
				kind: pick(kinds),
				origin: { type: ctxRef.api.constants.origin.type.automation, system: 'IngestRandomDemo' },
				timing: { expiresAt: now + ttlMs },
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
			timing: { expiresAt: now + ttlMs },
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
