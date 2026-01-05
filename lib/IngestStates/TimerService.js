'use strict';

/**
 * Persistent timer registry for IngestStates.
 *
 * Timers are stored as JSON in an internal ioBroker state:
 * `msghub.<instance>.IngestStates.<pluginInstanceId>.timers`
 *
 * Use-case: rules need durable timers even when a message does not exist yet.
 */
class TimerService {
	/**
	 * @param {object} ctx Plugin runtime context.
	 * @param {object} [options] Options.
	 * @param {(timer: { id: string, at: number, kind: string, data?: any }) => void} [options.onDue] Callback for due timers.
	 * @param {boolean} [options.traceEvents] Enable verbose debug logging.
	 */
	constructor(ctx, { onDue = undefined, traceEvents = false } = {}) {
		this.ctx = ctx;
		this.onDue = typeof onDue === 'function' ? onDue : () => undefined;
		this._traceEvents = traceEvents === true;
		this._log = ctx?.api?.log || null;

		this._ownId = `${ctx.meta.plugin.baseOwnId}.timers`;
		this._fullId = `${ctx.meta.plugin.baseFullId}.timers`;

		this._timers = new Map(); // id -> { at, kind, data? }
		this._handles = new Map(); // id -> timeoutHandle
		this._flushHandle = null;
		this._started = false;
	}

	/**
	 * @param {string} msg Debug message.
	 * @returns {void}
	 */
	_trace(msg) {
		if (!this._traceEvents || typeof this._log?.debug !== 'function') {
			return;
		}
		this._log.debug(`${this._fullId}: ${msg}`);
	}

	/**
	 * Ensure the timers state exists, load stored timers, and schedule in-memory timeouts.
	 *
	 * @returns {Promise<void>} Resolves when ready.
	 */
	async start() {
		if (this._started) {
			return;
		}
		this._started = true;

		await this.ctx.api.iobroker.objects.setObjectNotExists(this._ownId, {
			type: 'state',
			common: {
				name: 'IngestStates timers (internal)',
				type: 'string',
				role: 'json',
				read: true,
				write: false,
			},
			native: {},
		});

		try {
			const st = await this.ctx.api.iobroker.states.getForeignState(this._fullId);
			const raw = typeof st?.val === 'string' ? st.val : '';
			const parsed = raw ? JSON.parse(raw) : null;
			const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
			const timers =
				obj && obj.timers && typeof obj.timers === 'object' && !Array.isArray(obj.timers) ? obj.timers : null;

			if (timers) {
				for (const [id, entry] of Object.entries(timers)) {
					if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
						continue;
					}
					const at = entry.at;
					const kind = entry.kind;
					if (typeof id !== 'string' || !id.trim() || typeof at !== 'number' || !Number.isFinite(at)) {
						continue;
					}
					if (typeof kind !== 'string' || !kind.trim()) {
						continue;
					}
					this._timers.set(id, { at: Math.trunc(at), kind: kind.trim(), data: entry.data });
				}
			}
		} catch {
			// ignore (best-effort)
		}

		if (this._traceEvents) {
			const list = Array.from(this._timers.entries())
				.slice(0, 10)
				.map(([id, t]) => {
					const inMs = Math.max(0, Math.trunc(t.at - Date.now()));
					return `${id} kind='${t.kind}' inMs=${inMs}`;
				});
			const suffix = this._timers.size > list.length ? ` (+${this._timers.size - list.length} more)` : '';
			this._trace(`loaded timers=${this._timers.size}: ${list.join(', ')}${suffix}`);
		}

		for (const [id, timer] of this._timers.entries()) {
			this._scheduleHandle(id, timer);
		}
	}

	/**
	 * Stop timers (best-effort).
	 *
	 * @returns {void}
	 */
	stop() {
		if (this._flushHandle) {
			this.ctx.meta.resources.clearTimeout(this._flushHandle);
			this._flushHandle = null;
		}

		for (const handle of this._handles.values()) {
			this.ctx.meta.resources.clearTimeout(handle);
		}
		this._handles.clear();
		this._timers.clear();
		this._started = false;
	}

	/**
	 * @param {string} id Timer id.
	 * @param {number} at Due timestamp (ms).
	 * @param {string} kind Timer kind.
	 * @param {any} [data] Payload.
	 * @returns {void}
	 */
	set(id, at, kind, data = undefined) {
		const tid = typeof id === 'string' ? id.trim() : '';
		const k = typeof kind === 'string' ? kind.trim() : '';
		if (!tid || !k || typeof at !== 'number' || !Number.isFinite(at)) {
			return;
		}

		const timer = { at: Math.trunc(at), kind: k, ...(data !== undefined ? { data } : {}) };
		this._timers.set(tid, timer);
		this._trace(
			`set id='${tid}' kind='${k}' inMs=${Math.max(0, timer.at - Date.now())} data=${data ? 'yes' : 'no'}`,
		);
		this._scheduleHandle(tid, timer);
		this._queueFlush();
	}

	/**
	 * @param {string} id Timer id.
	 * @returns {void}
	 */
	delete(id) {
		const tid = typeof id === 'string' ? id.trim() : '';
		if (!tid) {
			return;
		}

		const handle = this._handles.get(tid);
		if (handle) {
			this.ctx.meta.resources.clearTimeout(handle);
			this._handles.delete(tid);
		}
		const existed = this._timers.delete(tid);
		if (existed) {
			this._trace(`delete id='${tid}'`);
			this._queueFlush();
		}
	}

	/**
	 * @param {string} id Timer id.
	 * @returns {object|null} Timer or null.
	 */
	get(id) {
		const tid = typeof id === 'string' ? id.trim() : '';
		return tid && this._timers.has(tid) ? this._timers.get(tid) : null;
	}

	/**
	 * Schedule or reschedule an in-memory timer handle for a persisted timer entry.
	 *
	 * @param {string} id Timer id.
	 * @param {object} timer Timer entry.
	 * @returns {void}
	 */
	_scheduleHandle(id, timer) {
		const existing = this._handles.get(id);
		if (existing) {
			this.ctx.meta.resources.clearTimeout(existing);
			this._handles.delete(id);
		}

		const now = Date.now();
		const MAX_TIMEOUT_MS = 0x7fffffff; // Node.js clamps higher values; keep long timers stable across restarts.
		const ms = Math.min(Math.max(0, timer.at - now), MAX_TIMEOUT_MS);
		this._trace(`schedule id='${id}' kind='${timer.kind}' inMs=${ms}`);
		const handle = this.ctx.meta.resources.setTimeout(() => {
			this._handles.delete(id);

			const current = this._timers.get(id);
			if (!current) {
				return;
			}
			if (current.at > Date.now()) {
				this._scheduleHandle(id, current);
				return;
			}

			this._timers.delete(id);
			this._queueFlush();

			try {
				this._trace(`due id='${id}' kind='${current.kind}'`);
				this.onDue({ id, ...current });
			} catch {
				// ignore (best-effort)
			}
		}, ms);

		this._handles.set(id, handle);
	}

	/**
	 * Debounced flush of timers into the persisted JSON state.
	 *
	 * @returns {void}
	 */
	_queueFlush() {
		if (this._flushHandle) {
			return;
		}
		this._flushHandle = this.ctx.meta.resources.setTimeout(() => {
			this._flushHandle = null;
			this._flushNow();
		}, 100);
	}

	/**
	 * Flush current timers map into the persisted JSON state (best-effort).
	 *
	 * @returns {void}
	 */
	_flushNow() {
		const timers = {};
		for (const [id, entry] of this._timers.entries()) {
			timers[id] = entry;
		}

		const payload = JSON.stringify({ schemaVersion: 1, timers });
		this.ctx.api.iobroker.states.setForeignState(this._fullId, { val: payload, ack: true }).catch(() => undefined);
	}
}

module.exports = { TimerService };
