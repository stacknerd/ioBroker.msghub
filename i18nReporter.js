'use strict';

function nowMs() {
	return Date.now();
}

function isNonEmptyString(s) {
	return typeof s === 'string' && s.trim();
}

function normalizeLang(lang) {
	const s = typeof lang === 'string' ? lang.trim().toLowerCase() : '';
	return s || 'en';
}

function bumpEntry(map, key, now) {
	if (!map.has(key)) {
		map.set(key, { count: 1, firstSeenAt: now, lastSeenAt: now });
		return;
	}
	const entry = map.get(key);
	entry.count += 1;
	entry.lastSeenAt = now;
}

function enforceMaxEntries(map, maxEntries) {
	if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
		return;
	}
	while (map.size > maxEntries) {
		const firstKey = map.keys().next().value;
		map.delete(firstKey);
	}
}

function toPlainObject(map) {
	const out = {};
	for (const [k, v] of map.entries()) {
		out[k] = v;
	}
	return out;
}

/**
 * Create a runtime i18n reporter that tracks used keys and best-effort missing translations.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance.
 * @param {object} [options] Options.
 * @param {boolean} [options.enabled] Enable reporting.
 * @param {string} [options.lang] i18n language (e.g. `de`).
 * @param {string} [options.fileName] File name within adapter file storage (e.g. `data/i18nReport.json`).
 * @param {number} [options.writeIntervalMs] Throttle interval for writes.
 * @param {number} [options.maxUsedKeys] Soft limit for stored `used` keys (FIFO).
 * @param {number} [options.maxMissingKeys] Soft limit for stored `missing` keys (FIFO).
 * @returns {{ enabled: boolean, lang: string, fileName: string, wrapTranslate: Function, flush: Function, dispose: Function, getStats: Function }} Reporter.
 */
function createI18nReporter(adapter, options = {}) {
	const enabled = options?.enabled === true;
	const lang = normalizeLang(options?.lang);
	const fileName = isNonEmptyString(options?.fileName) ? options.fileName.trim() : 'data/i18nReport.json';
	const writeIntervalMs =
		typeof options?.writeIntervalMs === 'number' && Number.isFinite(options.writeIntervalMs)
			? Math.max(1000, Math.trunc(options.writeIntervalMs))
			: 15000;
	const maxUsedKeys =
		typeof options?.maxUsedKeys === 'number' && Number.isFinite(options.maxUsedKeys)
			? Math.max(0, Math.trunc(options.maxUsedKeys))
			: 2000;
	const maxMissingKeys =
		typeof options?.maxMissingKeys === 'number' && Number.isFinite(options.maxMissingKeys)
			? Math.max(0, Math.trunc(options.maxMissingKeys))
			: 2000;

	const used = new Map();
	const missing = new Map();
	let usedCalls = 0;
	let missingCalls = 0;
	const startedAt = nowMs();

	let dirty = false;
	let lastWriteAt = 0;
	let writeTimer = null;
	let inFlight = null;

	function shouldConsiderMissing({ key, out }) {
		if (!isNonEmptyString(key)) {
			return false;
		}
		if (lang === 'en') {
			return false;
		}
		if (!isNonEmptyString(out)) {
			return false;
		}
		return key === out;
	}

	function scheduleWrite() {
		if (!enabled) {
			return;
		}
		if (writeTimer) {
			return;
		}
		writeTimer = setTimeout(() => {
			writeTimer = null;
			flush().catch(() => undefined);
		}, writeIntervalMs);
		// Do not keep the process alive just for a best-effort dev report.
		writeTimer?.unref?.();
	}

	async function flush() {
		if (!enabled || !dirty) {
			return;
		}
		if (writeTimer) {
			clearTimeout(writeTimer);
			writeTimer = null;
		}
		if (!adapter || typeof adapter.writeFileAsync !== 'function') {
			return;
		}

		if (inFlight) {
			return inFlight;
		}

		const snapshotNow = nowMs();
		const report = {
			schema_v: 1,
			meta: {
				namespace: adapter.namespace,
				lang,
				startedAt,
				lastWriteAt: snapshotNow,
			},
			totals: {
				usedCalls,
				missingCalls,
				usedKeys: used.size,
				missingKeys: missing.size,
			},
			used: toPlainObject(used),
			missing: toPlainObject(missing),
		};

		dirty = false;
		lastWriteAt = snapshotNow;
		inFlight = Promise.resolve()
			.then(() => adapter.writeFileAsync(adapter.namespace, fileName, JSON.stringify(report, null, 2)))
			.catch(e => {
				dirty = true;
				adapter?.log?.debug?.(`i18nReporter: write failed (${e?.message || e})`);
			})
			.finally(() => {
				inFlight = null;
			});

		return inFlight;
	}

	function observeTranslation(key, out) {
		if (!enabled) {
			return;
		}
		const now = nowMs();
		const k = typeof key === 'string' ? key : String(key);
		if (!k) {
			return;
		}

		usedCalls += 1;
		bumpEntry(used, k, now);
		enforceMaxEntries(used, maxUsedKeys);

		if (shouldConsiderMissing({ key: k, out })) {
			missingCalls += 1;
			bumpEntry(missing, k, now);
			enforceMaxEntries(missing, maxMissingKeys);
		}

		dirty = true;
		scheduleWrite();
	}

	function wrapTranslate(translateFn) {
		return (...args) => {
			const key = args[0];
			let out;
			try {
				out = translateFn(...args);
			} catch (e) {
				out = String(key);
				adapter?.log?.debug?.(`i18nReporter: translate failed (${e?.message || e})`);
			}
			observeTranslation(key, out);
			return out;
		};
	}

	function dispose() {
		if (writeTimer) {
			clearTimeout(writeTimer);
			writeTimer = null;
		}
	}

	return Object.freeze({
		enabled,
		lang,
		fileName,
		wrapTranslate,
		flush,
		dispose,
		getStats: () =>
			Object.freeze({
				usedCalls,
				missingCalls,
				usedKeys: used.size,
				missingKeys: missing.size,
				startedAt,
				lastWriteAt,
			}),
	});
}

module.exports = { createI18nReporter };
