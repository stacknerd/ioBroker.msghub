'use strict';

const { MsgStorage } = require(`${__dirname}/MsgStorage`);
const { isObject } = require(`${__dirname}/MsgUtils`);

/**
 * Centralized stats snapshots + persistent rollups.
 */
class MsgStats {
	/**
	 * @returns {number} One day in milliseconds.
	 */
	static DAY_MS = 24 * 60 * 60 * 1000;

	/**
	 * @param {any} v Candidate value.
	 * @returns {boolean} True if v is a finite number.
	 */
	static _isFiniteNumber(v) {
		return typeof v === 'number' && Number.isFinite(v);
	}

	/**
	 * @param {number} [ts] Timestamp (ms).
	 * @returns {number} Local day start (ms).
	 */
	static _startOfLocalDay(ts = Date.now()) {
		const safeTs = this._isFiniteNumber(ts) ? ts : Date.now();
		const d = new Date(safeTs);
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	}

	/**
	 * @param {number} [ts] Timestamp (ms).
	 * @returns {number} Local week start (Monday 00:00, ms).
	 */
	static _startOfLocalWeek(ts = Date.now()) {
		const safeTs = this._isFiniteNumber(ts) ? ts : Date.now();
		const d = new Date(safeTs);
		const day = d.getDay(); // 0 (Sun) .. 6 (Sat)
		const daysSinceMonday = (day + 6) % 7; // Mon -> 0, Sun -> 6
		d.setHours(0, 0, 0, 0);
		d.setDate(d.getDate() - daysSinceMonday);
		return d.getTime();
	}

	/**
	 * @param {number} [ts] Timestamp (ms).
	 * @returns {number} Local month start (first day 00:00, ms).
	 */
	static _startOfLocalMonth(ts = Date.now()) {
		const safeTs = this._isFiniteNumber(ts) ? ts : Date.now();
		const d = new Date(safeTs);
		d.setHours(0, 0, 0, 0);
		d.setDate(1);
		return d.getTime();
	}

	/**
	 * @param {number} [ts] Timestamp (ms).
	 * @returns {number} Next local month start (ms).
	 */
	static _startOfNextLocalMonth(ts = Date.now()) {
		const safeTs = this._isFiniteNumber(ts) ? ts : Date.now();
		const d = new Date(safeTs);
		d.setHours(0, 0, 0, 0);
		d.setDate(1);
		d.setMonth(d.getMonth() + 1);
		return d.getTime();
	}

	/**
	 * @param {number} ts Timestamp (ms).
	 * @returns {string} Local day key (YYYY-MM-DD).
	 */
	static _formatLocalDayKey(ts) {
		const d = new Date(this._isFiniteNumber(ts) ? ts : Date.now());
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	/**
	 * @param {string} key Local day key (YYYY-MM-DD).
	 * @returns {number|null} Local day start timestamp (ms) or null when invalid.
	 */
	static _parseLocalDayKeyToTs(key) {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
		if (!m) {
			return null;
		}
		const year = Number(m[1]);
		const month = Number(m[2]) - 1;
		const day = Number(m[3]);
		if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
			return null;
		}
		const d = new Date(year, month, day);
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	}

	/**
	 * Centralized stats snapshots + persistent rollups.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { locale?: string }} adapter ioBroker adapter instance.
	 * @param {import('./MsgConstants').MsgConstants} msgConstants Shared constants (kinds, lifecycle, notifications, ...).
	 * @param {import('./MsgStore').MsgStore} store Owning store instance (source of messages, storage, archive).
	 * @param {object} [options] Optional configuration.
	 * @param {number} [options.rollupKeepDays] Retention for rollup buckets (days).
	 * @param {() => any} [options.createStorageBackend] Platform-resolved storage backend factory for rollup persistence.
	 */
	constructor(adapter, msgConstants, store, { rollupKeepDays = 400, createStorageBackend } = {}) {
		if (!adapter?.namespace) {
			throw new Error('MsgStats: adapter is required');
		}
		if (!msgConstants) {
			throw new Error('MsgStats: msgConstants is required');
		}
		if (!store) {
			throw new Error('MsgStats: store is required');
		}
		if (typeof createStorageBackend !== 'function') {
			throw new Error('MsgStats: options.createStorageBackend is required');
		}

		this.adapter = adapter;
		this.msgConstants = msgConstants;
		this.store = store;
		this.rollupKeepDays =
			typeof rollupKeepDays === 'number' && Number.isFinite(rollupKeepDays)
				? Math.max(1, Math.trunc(rollupKeepDays))
				: 400;

		this._rollupStorage = new MsgStorage(this.adapter, {
			fileName: 'stats-rollup.json',
			writeIntervalMs: 10000,
			createStorageBackend,
		});

		this._initialized = false;
		this._rollup = this._createEmptyRollup();
	}

	/**
	 * @returns {{ schemaVersion: number, lastClosedAt: number, days: Record<string, { total: number, byKind: Record<string, number> }> }} Empty rollup object.
	 */
	_createEmptyRollup() {
		return {
			schemaVersion: 1,
			lastClosedAt: 0,
			days: {},
		};
	}

	/**
	 * @returns {Promise<void>}
	 */
	async init() {
		if (this._initialized) {
			return;
		}
		await this._rollupStorage.init();

		const loaded = await this._rollupStorage.readJson(null);
		if (isObject(loaded) && loaded.schemaVersion === 1 && isObject(loaded.days)) {
			this._rollup = {
				schemaVersion: 1,
				lastClosedAt: MsgStats._isFiniteNumber(loaded.lastClosedAt) ? loaded.lastClosedAt : 0,
				days: loaded.days,
			};
		} else {
			this._rollup = this._createEmptyRollup();
		}

		this._initialized = true;
	}

	/**
	 * @returns {void}
	 */
	onUnload() {
		this._rollupStorage.flushPending();
	}

	/**
	 * Record a single close-transition into the persistent rollup buckets.
	 *
	 * @param {object} message Message object (expected lifecycle.state="closed").
	 * @returns {void}
	 */
	recordClosed(message) {
		try {
			if (!message || typeof message !== 'object') {
				return;
			}

			const state = message?.lifecycle?.state;
			if (state !== this.msgConstants.lifecycle?.state?.closed) {
				return;
			}

			const tsRaw = message?.lifecycle?.stateChangedAt;
			const closedAt = MsgStats._isFiniteNumber(tsRaw) ? Math.trunc(tsRaw) : Date.now();
			const dayKey = MsgStats._formatLocalDayKey(closedAt);

			const days = isObject(this._rollup.days) ? this._rollup.days : {};
			if (!isObject(days[dayKey])) {
				days[dayKey] = { total: 0, byKind: {} };
			}

			const bucket = days[dayKey];
			bucket.total = (typeof bucket.total === 'number' && Number.isFinite(bucket.total) ? bucket.total : 0) + 1;

			const kind = typeof message.kind === 'string' && message.kind.trim() ? message.kind.trim() : 'unknown';
			const byKind = isObject(bucket.byKind) ? bucket.byKind : {};
			byKind[kind] = (typeof byKind[kind] === 'number' && Number.isFinite(byKind[kind]) ? byKind[kind] : 0) + 1;
			bucket.byKind = byKind;

			this._rollup.days = days;
			this._rollup.lastClosedAt = Math.max(
				typeof this._rollup.lastClosedAt === 'number' && Number.isFinite(this._rollup.lastClosedAt)
					? this._rollup.lastClosedAt
					: 0,
				closedAt,
			);

			this._pruneOldRollupDays();
			this._rollupStorage.writeJson(this._rollup);
		} catch (e) {
			this.adapter?.log?.warn?.(`MsgStats: recordClosed failed: ${e?.message || e}`);
		}
	}

	/**
	 * Drop old rollup buckets beyond retention.
	 *
	 * @returns {void}
	 */
	_pruneOldRollupDays() {
		const keepDays = this.rollupKeepDays;
		if (!keepDays || keepDays <= 0) {
			return;
		}

		const cutoff = MsgStats._startOfLocalDay(Date.now()) - keepDays * MsgStats.DAY_MS;
		const days = isObject(this._rollup.days) ? this._rollup.days : {};
		for (const key of Object.keys(days)) {
			const dayStart = MsgStats._parseLocalDayKeyToTs(key);
			if (typeof dayStart === 'number' && Number.isFinite(dayStart) && dayStart < cutoff) {
				delete days[key];
			}
		}
		this._rollup.days = days;
	}

	/**
	 * @param {number} now Current timestamp.
	 * @returns {{ startOfToday: number, startOfTomorrow: number, startOfWeek: number, startOfNextWeek: number, startOfMonth: number, startOfNextMonth: number, next7DaysEnd: number }} Window boundaries (local time).
	 */
	_computeWindows(now) {
		const startOfToday = MsgStats._startOfLocalDay(now);
		const startOfTomorrow = startOfToday + MsgStats.DAY_MS;
		const startOfWeek = MsgStats._startOfLocalWeek(now);
		const startOfNextWeek = startOfWeek + 7 * MsgStats.DAY_MS;
		const startOfMonth = MsgStats._startOfLocalMonth(now);
		const startOfNextMonth = MsgStats._startOfNextLocalMonth(now);
		return Object.freeze({
			startOfToday,
			startOfTomorrow,
			startOfWeek,
			startOfNextWeek,
			startOfMonth,
			startOfNextMonth,
			next7DaysEnd: startOfToday + 7 * MsgStats.DAY_MS,
		});
	}

	/**
	 * @param {number} rangeStart Inclusive range start (local day boundary).
	 * @param {number} rangeEnd Exclusive range end (local day boundary).
	 * @returns {{ total: number, byKind: Record<string, number> }} Aggregated counters for the range.
	 */
	_sumRollup(rangeStart, rangeEnd) {
		const days = isObject(this._rollup.days) ? this._rollup.days : {};
		let total = 0;
		const byKind = Object.create(null);

		for (const [key, bucket] of Object.entries(days)) {
			const dayStart = MsgStats._parseLocalDayKeyToTs(key);
			if (dayStart == null) {
				continue;
			}
			if (dayStart < rangeStart || dayStart >= rangeEnd) {
				continue;
			}

			const bucketTotal = typeof bucket?.total === 'number' && Number.isFinite(bucket.total) ? bucket.total : 0;
			total += bucketTotal;

			const bk = isObject(bucket?.byKind) ? bucket.byKind : {};
			for (const [kind, count] of Object.entries(bk)) {
				const numeric = typeof count === 'number' && Number.isFinite(count) ? count : 0;
				byKind[kind] =
					(typeof byKind[kind] === 'number' && Number.isFinite(byKind[kind]) ? byKind[kind] : 0) + numeric;
			}
		}

		return { total, byKind };
	}

	/**
	 * @param {Array<object>} messages Current store list.
	 * @returns {{ total: number, byKind: Record<string, number>, byLifecycle: Record<string, number>, byLevel: Record<string, number>, byOriginSystem: Record<string, number> }} Snapshot counters for the current list.
	 */
	_computeCurrent(messages) {
		const byKind = Object.create(null);
		const byLifecycle = Object.create(null);
		const byLevel = Object.create(null);
		const byOriginSystem = Object.create(null);

		for (const msg of messages) {
			if (!msg || typeof msg !== 'object') {
				continue;
			}
			const kind = typeof msg.kind === 'string' && msg.kind.trim() ? msg.kind.trim() : 'unknown';
			byKind[kind] = (byKind[kind] || 0) + 1;

			const state =
				typeof msg?.lifecycle?.state === 'string' && msg.lifecycle.state.trim()
					? msg.lifecycle.state.trim()
					: 'unknown';
			byLifecycle[state] = (byLifecycle[state] || 0) + 1;

			const levelKey = MsgStats._isFiniteNumber(msg.level) ? String(msg.level) : 'unknown';
			byLevel[levelKey] = (byLevel[levelKey] || 0) + 1;

			const originSystem =
				typeof msg?.origin?.system === 'string' && msg.origin.system.trim()
					? msg.origin.system.trim()
					: 'unknown';
			byOriginSystem[originSystem] = (byOriginSystem[originSystem] || 0) + 1;
		}

		return {
			total: messages.length,
			byKind,
			byLifecycle,
			byLevel,
			byOriginSystem,
		};
	}

	/**
	 * Return the domain "fällig" timestamp (timing.dueAt/startAt), not notification due.
	 *
	 * @param {object} message Message object.
	 * @returns {number|null} Timestamp or null if missing.
	 */
	_getDomainDueTs(message) {
		if (!message || typeof message !== 'object') {
			return null;
		}

		const timing = message.timing && typeof message.timing === 'object' ? message.timing : {};
		const dueAt = MsgStats._isFiniteNumber(timing.dueAt) ? Math.trunc(timing.dueAt) : null;
		const startAt = MsgStats._isFiniteNumber(timing.startAt) ? Math.trunc(timing.startAt) : null;
		const kind = typeof message.kind === 'string' ? message.kind : '';

		// Domain semantics: appointments are "fällig" by startAt, others by dueAt.
		if (kind === this.msgConstants.kind?.appointment) {
			return startAt != null ? startAt : dueAt;
		}
		return dueAt != null ? dueAt : startAt;
	}

	/**
	 * @param {Array<object>} messages Current store list.
	 * @param {{ startOfToday: number, startOfTomorrow: number, startOfWeek: number, startOfNextWeek: number, startOfMonth: number, startOfNextMonth: number, next7DaysEnd: number }} windows Window boundaries.
	 * @returns {{ total: number, overdue: number, today: number, tomorrow: number, next7Days: number, thisWeek: number, thisWeekFromToday: number, thisMonth: number, thisMonthFromToday: number, byKind: Record<string, { total: number, overdue: number, today: number, tomorrow: number, next7Days: number, thisWeek: number, thisWeekFromToday: number, thisMonth: number, thisMonthFromToday: number }> }} Due buckets (domain time).
	 */
	_computeSchedule(messages, windows) {
		const isQuasiDeletedState = this.msgConstants.lifecycle?.isQuasiDeletedState;

		const empty = Object.freeze({
			total: 0,
			overdue: 0,
			today: 0,
			tomorrow: 0,
			next7Days: 0,
			thisWeek: 0,
			thisWeekFromToday: 0,
			thisMonth: 0,
			thisMonthFromToday: 0,
		});
		const out = { ...empty };
		const byKind = Object.create(null);

		const bump = (obj, key) => {
			obj[key] = (typeof obj[key] === 'number' ? obj[key] : 0) + 1;
		};
		const ensureKind = kind => {
			if (!byKind[kind]) {
				byKind[kind] = { ...empty };
			}
			return byKind[kind];
		};

		for (const msg of messages) {
			if (!msg || typeof msg !== 'object') {
				continue;
			}

			const state = msg?.lifecycle?.state;
			if (typeof isQuasiDeletedState === 'function' && isQuasiDeletedState(state)) {
				continue;
			}

			const dueTs = this._getDomainDueTs(msg);
			if (dueTs == null) {
				continue;
			}

			const kind = typeof msg.kind === 'string' && msg.kind.trim() ? msg.kind.trim() : 'unknown';
			const kindBucket = ensureKind(kind);

			bump(out, 'total');
			bump(kindBucket, 'total');

			if (dueTs < windows.startOfToday) {
				bump(out, 'overdue');
				bump(kindBucket, 'overdue');
			}
			if (dueTs >= windows.startOfToday && dueTs < windows.startOfTomorrow) {
				bump(out, 'today');
				bump(kindBucket, 'today');
			}
			if (dueTs >= windows.startOfTomorrow && dueTs < windows.startOfTomorrow + MsgStats.DAY_MS) {
				bump(out, 'tomorrow');
				bump(kindBucket, 'tomorrow');
			}
			if (dueTs >= windows.startOfToday && dueTs < windows.next7DaysEnd) {
				bump(out, 'next7Days');
				bump(kindBucket, 'next7Days');
			}
			if (dueTs >= windows.startOfWeek && dueTs < windows.startOfNextWeek) {
				bump(out, 'thisWeek');
				bump(kindBucket, 'thisWeek');
			}
			if (dueTs >= windows.startOfToday && dueTs < windows.startOfNextWeek) {
				bump(out, 'thisWeekFromToday');
				bump(kindBucket, 'thisWeekFromToday');
			}
			if (dueTs >= windows.startOfMonth && dueTs < windows.startOfNextMonth) {
				bump(out, 'thisMonth');
				bump(kindBucket, 'thisMonth');
			}
			if (dueTs >= windows.startOfToday && dueTs < windows.startOfNextMonth) {
				bump(out, 'thisMonthFromToday');
				bump(kindBucket, 'thisMonthFromToday');
			}
		}

		return { ...out, byKind };
	}

	/**
	 * Return a JSON-serializable stats snapshot (for AdminTab / diagnostics).
	 *
	 * @param {{ include?: { archiveSize?: boolean, archiveSizeMaxAgeMs?: number } }} [options] Include flags for optional/expensive fields.
	 * @returns {Promise<any>} Stats object.
	 */
	async getStats(options = {}) {
		const now = Date.now();
		const windows = this._computeWindows(now);

		const messages = Array.isArray(this.store?.fullList) ? this.store.fullList : [];

		const current = this._computeCurrent(messages);
		const schedule = this._computeSchedule(messages, windows);

		const doneToday = this._sumRollup(windows.startOfToday, windows.startOfTomorrow);
		const doneThisWeek = this._sumRollup(windows.startOfWeek, windows.startOfNextWeek);
		const doneThisMonth = this._sumRollup(windows.startOfMonth, windows.startOfNextMonth);

		const storage =
			this.store?.msgStorage && typeof this.store.msgStorage.getStatus === 'function'
				? this.store.msgStorage.getStatus()
				: null;

		const include = isObject(options?.include) ? options.include : null;
		const archiveObj = this.store?.msgArchive;
		if (include?.archiveSize === true && archiveObj && typeof archiveObj.estimateSizeBytes === 'function') {
			await archiveObj.estimateSizeBytes({ maxAgeMs: include?.archiveSizeMaxAgeMs });
		}
		const archive = archiveObj && typeof archiveObj.getStatus === 'function' ? archiveObj.getStatus() : null;

		let tz = null;
		try {
			tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
		} catch {
			tz = null;
		}

		return {
			meta: {
				schemaVersion: 1,
				generatedAt: now,
				tz,
				locale: this.adapter?.locale || null,
				windows,
			},
			current,
			schedule,
			done: {
				today: doneToday,
				thisWeek: doneThisWeek,
				thisMonth: doneThisMonth,
				lastClosedAt:
					typeof this._rollup.lastClosedAt === 'number' && Number.isFinite(this._rollup.lastClosedAt)
						? this._rollup.lastClosedAt
						: null,
			},
			io: {
				storage,
				archive,
			},
		};
	}
}

module.exports = { MsgStats };
