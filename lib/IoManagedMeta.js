/**
 * IoManagedMeta
 * =============
 *
 * Encapsulated helper to:
 * - stamp ioBroker objects with managed metadata (`common.custom.<instance>.managedMeta-*`)
 * - track "managed ids" per plugin instance
 * - write the current managed-id list as a watchlist state (`<Type>.<instanceId>.watchlist`)
 *
 * This is intentionally best-effort: failures must never crash the adapter.
 */
'use strict';

const { isObject } = require(`${__dirname}/../src/MsgUtils`);
const { buildIoBrokerApi } = require(`${__dirname}/../src/MsgHostApi`);

/**
 * IoManagedMeta
 *
 * Adapter-side helper for:
 * - managed meta stamping (`common.custom.<ns>.managedMeta-*`)
 * - per-plugin managed id watchlists (`<Type>.<instanceId>.watchlist`)
 * - background cleanup (janitor)
 */
class IoManagedMeta {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string, i18n?: ({ t?: Function, getTranslatedObject?: Function } | null) }} adapter Adapter instance.
	 * @param {object} [options] Options.
	 * @param {string} [options.hostName] Host name for ioBroker API wrapper.
	 */
	constructor(adapter, { hostName = 'IoManagedMeta' } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoManagedMeta: adapter is required');
		}
		this.adapter = adapter;
		this._ioBroker = buildIoBrokerApi(this.adapter, { hostName });
		this._entries = new Map(); // `${type}.${instanceId}` -> { identity, managedBy, pending: Map<id, {managedText?:string}> }

		this._janitor = {
			timer: setTimeout(() => {}, 0),
			running: false,
			intervalMs: 30 * 60 * 1000,
			initialDelayMs: 5 * 60 * 1000,
		};
		clearTimeout(this._janitor.timer);
		this._scheduleJanitor(this._janitor.initialDelayMs);
	}

	/**
	 * Optional explicit cleanup. The janitor timer is unref'ed so it does not block process exit,
	 * but this provides best-effort cleanup for environments that keep the process alive.
	 *
	 * @returns {void}
	 */
	dispose() {
		clearTimeout(this._janitor.timer);
	}

	/**
	 * Run the janitor once (best-effort).
	 *
	 * Exposed primarily for tests and manual debugging.
	 *
	 * @returns {Promise<void>} Resolves after one janitor pass.
	 */
	async runJanitorOnce() {
		await this._runJanitorOnce();
	}

	/**
	 * Create a per-plugin reporter that buffers `report(...)` calls until `applyReported()`.
	 *
	 * @param {object} options Options.
	 * @param {string} options.category Plugin category (ingest|notify|bridge|engage).
	 * @param {string} options.type Plugin type.
	 * @param {number} options.instanceId Plugin instance id.
	 * @param {string} options.pluginBaseObjectId Full base object id (with namespace; used as `managedBy`).
	 * @returns {{ report: (ids: string|string[], meta?: { managedText?: any }) => Promise<void>, applyReported: () => Promise<void> }} Reporter.
	 */
	createReporter({ category, type, instanceId, pluginBaseObjectId }) {
		const t = typeof type === 'string' ? type.trim() : '';
		const inst = Number(instanceId);
		const managedBy = typeof pluginBaseObjectId === 'string' ? pluginBaseObjectId.trim() : '';
		if (!t || !Number.isInteger(inst) || inst < 0) {
			throw new Error('IoManagedMeta: invalid reporter identity');
		}
		if (!managedBy) {
			throw new Error('IoManagedMeta: pluginBaseObjectId is required');
		}

		const key = `${t}.${inst}`;
		let entry = this._entries.get(key);
		if (!entry) {
			entry = {
				identity: { category, type: t, instanceId: inst },
				managedBy,
				pending: new Map(),
			};
			this._entries.set(key, entry);
		} else {
			entry.identity = { category, type: t, instanceId: inst };
			entry.managedBy = managedBy;
		}

		const report = async (ids, meta = {}) => {
			try {
				const list = Array.isArray(ids) ? ids : [ids];
				const managedText = Reflect.get(meta || {}, 'managedText');
				const hasManagedText = typeof managedText === 'string';
				for (const id of list) {
					if (typeof id !== 'string' || !id.trim()) {
						continue;
					}
					entry.pending.set(id.trim(), { managedText: hasManagedText ? managedText : undefined });
				}
			} catch {
				// swallow (best-effort)
			}
		};

		const applyReported = async () => {
			try {
				if (entry.pending.size === 0) {
					return;
				}

				const ids = Array.from(entry.pending.keys());
				ids.sort();

				await this._ensureWatchlistStateAsync(entry.identity);
				await this._setWatchlistAsync(entry.identity, ids);

				for (const id of ids) {
					const info = entry.pending.get(id);
					await this._ensureManagedMetaAsync({
						id,
						managedBy: entry.managedBy,
						managedText: info?.managedText,
					});
				}
			} catch {
				// swallow (best-effort)
			} finally {
				try {
					entry.pending.clear();
				} catch {
					// swallow
				}
			}
		};

		return Object.freeze({ report, applyReported });
	}

	/**
	 * Best-effort: clear buffered ids for a plugin instance and reset the watchlist state to `[]` (when it exists).
	 *
	 * This must NOT create the watchlist object/state when it does not exist yet.
	 *
	 * @param {{ type: string, instanceId: number }} identity Plugin identity.
	 * @returns {Promise<void>} Resolves after best-effort reset.
	 */
	async clearWatchlist(identity) {
		const type = typeof identity?.type === 'string' ? identity.type.trim() : '';
		const instanceId = Number(identity?.instanceId);
		if (!type || !Number.isInteger(instanceId) || instanceId < 0) {
			return;
		}

		const key = `${type}.${instanceId}`;
		const entry = this._entries.get(key);
		if (entry?.pending) {
			try {
				entry.pending.clear();
			} catch {
				// swallow
			}
		}

		const ownId = this._getPluginWatchlistOwnId({ type, instanceId });
		try {
			const existing = await this._getObjectAsync(ownId);
			if (!existing) {
				return;
			}
			const st = await this._getStateAsync(ownId);
			const ids = this._parseWatchlistIds(st?.val);

			// Clear the watchlist immediately (fast), then clean up objects in the background.
			await this._setStateAckAsync(ownId, '[]');
			void this._cleanupOrphansFromWatchlistAsync({ type, instanceId, ids }).catch(() => {});
		} catch {
			// swallow (best-effort)
		}
	}

	/**
	 * Best-effort helper: stamp an ioBroker object with plugin-managed metadata.
	 *
	 * @param {{ id: string, managedBy?: string, managedText?: string }} options Options.
	 * @returns {Promise<void>} Resolves after the best-effort write.
	 */
	async _ensureManagedMetaAsync({ id, managedBy, managedText }) {
		const hasManagedBy = typeof managedBy === 'string' && managedBy.trim();
		const hasManagedText = typeof managedText === 'string';
		if (!hasManagedBy && !hasManagedText) {
			return;
		}

		const obj = await this._ioBroker.objects.getForeignObject(id);
		if (!obj) {
			return;
		}

		const nowIso = new Date().toISOString();

		const customKey = typeof this._ioBroker?.ids?.namespace === 'string' ? this._ioBroker.ids.namespace : '';
		if (!customKey) {
			return;
		}

		const existingCustom =
			isObject(obj.common) && isObject(obj.common.custom) && isObject(obj.common.custom[customKey])
				? obj.common.custom[customKey]
				: {};
		const existingManagedBy =
			typeof existingCustom['managedMeta-managedBy'] === 'string' ? existingCustom['managedMeta-managedBy'] : '';
		const existingManagedText =
			typeof existingCustom['managedMeta-managedText'] === 'string'
				? existingCustom['managedMeta-managedText']
				: '';
		const existingManagedSince =
			typeof existingCustom['managedMeta-managedSince'] === 'string'
				? existingCustom['managedMeta-managedSince']
				: '';
		const existingManagedMessage = existingCustom['managedMeta-managedMessage'];

		const desiredManagedBy = hasManagedBy ? managedBy : existingManagedBy;
		const desiredManagedText = hasManagedText ? managedText : existingManagedText;
		const desiredManagedSince = existingManagedSince || nowIso;

		const needsUpdate =
			(hasManagedBy && existingManagedBy !== managedBy) ||
			(hasManagedText && existingManagedText !== managedText) ||
			typeof existingManagedSince !== 'string' ||
			existingManagedMessage !== true ||
			existingCustom.enabled !== true;

		if (!needsUpdate) {
			return;
		}

		const patch = {
			common: {
				custom: {
					[customKey]: {
						...(isObject(existingCustom) ? existingCustom : {}),
						'managedMeta-managedBy': desiredManagedBy,
						'managedMeta-managedText': desiredManagedText,
						'managedMeta-managedSince': desiredManagedSince,
						'managedMeta-managedMessage': true,
						enabled: true,
					},
				},
			},
		};

		try {
			await this._ioBroker.objects.extendForeignObject(id, patch);
		} catch (e) {
			this.adapter?.log?.warn?.(`IoManagedMeta: failed to set managed meta on '${id}': ${e?.message || e}`);
		}
	}

	/**
	 * Translate a string template via adapter i18n (when available).
	 *
	 * @param {string} template Template string with `%s` placeholders.
	 * @param {...any} args Template arguments.
	 * @returns {ioBroker.StringOrTranslated} ioBroker translated name or a stable `{en,de}` fallback.
	 */
	_getTranslatedName(template, ...args) {
		const i18n = this.adapter?.i18n;
		if (i18n && typeof i18n.getTranslatedObject === 'function') {
			const out = i18n.getTranslatedObject(template, ...args);
			if (out) {
				return out;
			}
		}
		const format = (tmpl, params) => {
			if (typeof tmpl !== 'string') {
				return '';
			}
			let i = 0;
			return tmpl.replace(/%s/g, () => String(params?.[i++] ?? ''));
		};
		const s = format(template, args);
		return { en: s, de: s };
	}

	/**
	 * Build the plugin watchlist state "own id" (without namespace).
	 *
	 * @param {{ type: string, instanceId: number }} options Options.
	 * @returns {string} Own state id.
	 */
	_getPluginWatchlistOwnId({ type, instanceId }) {
		return `${type}.${instanceId}.watchlist`;
	}

	/**
	 * Ensure the plugin watchlist state exists and has a string value (seeded as `[]` when missing).
	 *
	 * This is a best-effort helper and must never crash the adapter.
	 *
	 * @param {{ category: string, type: string, instanceId: number }} identity Plugin identity.
	 * @returns {Promise<void>} Resolves after best-effort ensure/seed.
	 */
	async _ensureWatchlistStateAsync({ category, type, instanceId }) {
		const watchlistStateId = this._getPluginWatchlistOwnId({ type, instanceId });
		const watchlistName = this._getTranslatedName(
			'watchlist of MsgHub plugin (%s/%s/%s)',
			category,
			type,
			instanceId,
		);

		try {
			await this._setObjectNotExistsAsync(watchlistStateId, {
				type: 'state',
				common: {
					name: watchlistName,
					type: 'string',
					role: 'json',
					read: true,
					write: false,
				},
				native: {},
			});
		} catch {
			// swallow (best-effort)
		}

		try {
			const existingWatchlist = await this._getStateAsync(watchlistStateId);
			if (!existingWatchlist || typeof existingWatchlist.val !== 'string') {
				await this._setStateAckAsync(watchlistStateId, '[]');
			}
		} catch {
			// swallow (best-effort)
		}
	}

	/**
	 * Persist the current watchlist ids for a plugin instance.
	 *
	 * @param {{ type: string, instanceId: number }} identity Plugin identity.
	 * @param {string[]} ids List of ioBroker ids.
	 * @returns {Promise<void>} Resolves after best-effort write.
	 */
	async _setWatchlistAsync({ type, instanceId }, ids) {
		try {
			const ownId = this._getPluginWatchlistOwnId({ type, instanceId });
			await this._setStateAckAsync(ownId, JSON.stringify(Array.isArray(ids) ? ids : []));
		} catch {
			// swallow (best-effort)
		}
	}

	/**
	 * Schedule the background janitor to run once after the given delay.
	 *
	 * @param {number} delayMs Delay in milliseconds.
	 * @returns {void}
	 */
	_scheduleJanitor(delayMs) {
		clearTimeout(this._janitor.timer);
		const d = typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs >= 0 ? Math.trunc(delayMs) : 0;
		this._janitor.timer = setTimeout(() => {
			void this._runJanitorOnce().finally(() => {
				this._scheduleJanitor(this._janitor.intervalMs);
			});
		}, d);
		if (typeof this._janitor.timer.unref === 'function') {
			this._janitor.timer.unref();
		}
	}

	/**
	 * Run one janitor pass (best-effort).
	 *
	 * Scans `common.custom.<ns>.managedMeta-*` entries and applies the orphan policy when the owning
	 * plugin watchlist does not list the object (or the watchlist does not exist).
	 *
	 * @returns {Promise<void>} Resolves after one pass.
	 */
	async _runJanitorOnce() {
		if (this._janitor.running) {
			return;
		}
		this._janitor.running = true;
		try {
			const customKey = typeof this._ioBroker?.ids?.namespace === 'string' ? this._ioBroker.ids.namespace : '';
			if (!customKey) {
				return;
			}

			const objects = await this._listObjectsWithCustom(customKey);
			for (const obj of objects) {
				const id = typeof obj?._id === 'string' ? obj._id : '';
				if (!id) {
					continue;
				}
				const custom =
					isObject(obj.common) && isObject(obj.common.custom) && isObject(obj.common.custom[customKey])
						? obj.common.custom[customKey]
						: null;
				if (!custom) {
					continue;
				}

				const managedBy =
					typeof custom['managedMeta-managedBy'] === 'string' ? custom['managedMeta-managedBy'].trim() : '';
				if (!managedBy) {
					continue;
				}

				const parsed = this._parsePluginBaseObjectIdFromManagedBy(managedBy);
				let isListed = false;
				if (parsed) {
					const watchlistStateId = this._getPluginWatchlistOwnId(parsed);
					const watchlistObj = await this._getObjectAsync(watchlistStateId);
					if (watchlistObj) {
						const st = await this._getStateAsync(watchlistStateId);
						const ids = this._parseWatchlistIds(st?.val);
						isListed = ids.includes(id);
					}
				}

				if (isListed) {
					continue;
				}

				await this._applyOrphanPolicy({ id, customKey, custom });
			}
		} catch (e) {
			this.adapter?.log?.debug?.(`IoManagedMeta: janitor failed (swallowed): ${e?.message || e}`);
		} finally {
			this._janitor.running = false;
		}
	}

	/**
	 * List all objects that have a `common.custom[customKey]` entry.
	 *
	 * Prefers the `system/custom` view when available (fast); falls back to `getForeignObjects('*')`.
	 *
	 * @param {string} customKey Adapter namespace key (e.g. `msghub.0`).
	 * @returns {Promise<any[]>} List of objects.
	 */
	async _listObjectsWithCustom(customKey) {
		try {
			if (typeof this.adapter?.getObjectViewAsync === 'function') {
				const res = await this.adapter.getObjectViewAsync('system', 'custom', {
					startkey: customKey,
					endkey: `${customKey}\u9999`,
					include_docs: true,
				});
				const rows = Array.isArray(res?.rows) ? res.rows : [];
				const out = [];
				for (const row of rows) {
					const id = typeof row?.id === 'string' ? row.id.trim() : '';
					if (!id) {
						continue;
					}
					try {
						const obj = await this._ioBroker.objects.getForeignObject(id);
						if (obj) {
							out.push(obj);
						}
					} catch {
						// ignore
					}
				}
				return out;
			}
		} catch {
			// fall through
		}

		try {
			const objs = await this._ioBroker.objects.getForeignObjects('*');
			return objs && typeof objs === 'object' ? Object.values(objs) : [];
		} catch {
			return [];
		}
	}

	/**
	 * Escape a string for use in a RegExp.
	 *
	 * @param {string} s Input string.
	 * @returns {string} Escaped string.
	 */
	static _escapeRegExp(s) {
		return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/**
	 * Parse a plugin base object full id from a `managedBy` string.
	 *
	 * @param {any} managedBy Candidate managedBy value.
	 * @returns {{ type: string, instanceId: number } | null} Parsed identity or null.
	 */
	_parsePluginBaseObjectIdFromManagedBy(managedBy) {
		if (typeof managedBy !== 'string' || !managedBy.trim()) {
			return null;
		}
		const ns = typeof this.adapter?.namespace === 'string' ? this.adapter.namespace.trim() : '';
		if (!ns) {
			return null;
		}
		const re = new RegExp(`^${IoManagedMeta._escapeRegExp(ns)}\\.([A-Za-z][A-Za-z0-9_]*)\\.(\\d+)$`);
		const m = managedBy.trim().match(re);
		if (!m) {
			return null;
		}
		const type = m[1];
		const instanceId = Number(m[2]);
		if (!type || !Number.isInteger(instanceId) || instanceId < 0) {
			return null;
		}
		return { type, instanceId };
	}

	/**
	 * Parse a watchlist state value into a list of string ids.
	 *
	 * @param {any} val Watchlist state value (expected JSON string array).
	 * @returns {string[]} Parsed id list (may be empty).
	 */
	_parseWatchlistIds(val) {
		if (typeof val !== 'string') {
			return [];
		}
		try {
			const parsed = JSON.parse(val);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
		} catch {
			return [];
		}
	}

	/**
	 * Apply the orphan cleanup policy for one object.
	 *
	 * Policy:
	 * - set `managedMeta-managedMessage=false`
	 * - if `mode===''` and `enabled===true`, set `enabled=false`
	 *
	 * @param {object} options Options.
	 * @param {string} options.id Foreign object id.
	 * @param {string} options.customKey Adapter namespace key (e.g. `msghub.0`).
	 * @param {object} options.custom Existing `common.custom[customKey]` entry.
	 * @returns {Promise<void>} Resolves after best-effort patch.
	 */
	async _applyOrphanPolicy({ id, customKey, custom }) {
		const currentCustom = isObject(custom) ? custom : {};
		const nextCustom = { ...currentCustom, 'managedMeta-managedMessage': false };

		const mode = typeof currentCustom.mode === 'string' ? currentCustom.mode : '';
		if (mode.trim() === '' && currentCustom.enabled === true) {
			nextCustom.enabled = false;
		}

		const patch = {
			common: {
				custom: {
					[customKey]: nextCustom,
				},
			},
		};

		try {
			await this._ioBroker.objects.extendForeignObject(id, patch);
		} catch (e) {
			this.adapter?.log?.debug?.(
				`IoManagedMeta: janitor patch failed for '${id}' (swallowed): ${e?.message || e}`,
			);
		}
	}

	/**
	 * Background cleanup invoked from `clearWatchlist(...)`.
	 *
	 * Uses the ids that were previously listed in the plugin watchlist and applies the orphan policy
	 * when the object is still attributed to this plugin instance.
	 *
	 * @param {object} options Options.
	 * @param {string} options.type Plugin type.
	 * @param {number} options.instanceId Plugin instance id.
	 * @param {string[]} options.ids Previously listed ids.
	 * @returns {Promise<void>} Resolves when done.
	 */
	async _cleanupOrphansFromWatchlistAsync({ type, instanceId, ids }) {
		const list = Array.isArray(ids) ? ids : [];
		if (list.length === 0) {
			return;
		}

		const customKey = typeof this._ioBroker?.ids?.namespace === 'string' ? this._ioBroker.ids.namespace : '';
		if (!customKey) {
			return;
		}

		const key = `${type}.${instanceId}`;
		const managedBy =
			typeof this._entries.get(key)?.managedBy === 'string' && this._entries.get(key).managedBy.trim()
				? this._entries.get(key).managedBy.trim()
				: `${customKey}.${type}.${instanceId}`;

		let i = 0;
		for (const id of list) {
			i += 1;
			if (typeof id !== 'string' || !id.trim()) {
				continue;
			}
			const obj = await this._ioBroker.objects.getForeignObject(id.trim()).catch(() => null);
			if (!obj) {
				continue;
			}
			const custom =
				isObject(obj.common) && isObject(obj.common.custom) && isObject(obj.common.custom[customKey])
					? obj.common.custom[customKey]
					: null;
			if (!custom) {
				continue;
			}
			const currentManagedBy =
				typeof custom['managedMeta-managedBy'] === 'string' ? custom['managedMeta-managedBy'].trim() : '';
			if (currentManagedBy !== managedBy) {
				continue;
			}

			await this._applyOrphanPolicy({ id: id.trim(), customKey, custom });

			// Yield to keep disable responsive even for long lists.
			if (i % 50 === 0) {
				await new Promise(resolve => setImmediate(resolve));
			}
		}
	}

	/**
	 * Adapter object getter wrapper (async API preferred; callback API fallback).
	 *
	 * @param {string} ownId Own object id (without namespace).
	 * @returns {Promise<ioBroker.Object | null | undefined>} Resolves with the object (or null/undefined when missing).
	 */
	async _getObjectAsync(ownId) {
		if (typeof this.adapter.getObjectAsync === 'function') {
			return this.adapter.getObjectAsync(ownId);
		}
		return new Promise(resolve => this.adapter.getObject(ownId, (err, obj) => resolve(err ? null : obj)));
	}

	/**
	 * Adapter state getter wrapper (async API preferred; callback API fallback).
	 *
	 * @param {string} ownId Own state id (without namespace).
	 * @returns {Promise<ioBroker.State | null | undefined>} Resolves with the state (or null/undefined when missing).
	 */
	async _getStateAsync(ownId) {
		if (typeof this.adapter.getStateAsync === 'function') {
			return this.adapter.getStateAsync(ownId);
		}
		return new Promise(resolve => this.adapter.getState(ownId, (err, state) => resolve(err ? null : state)));
	}

	/**
	 * Persist a state value as acked (`ack: true`).
	 *
	 * @param {string} ownId Own state id (without namespace).
	 * @param {ioBroker.StateValue} val Value to persist.
	 * @returns {Promise<void>} Resolves after writing the acked value.
	 */
	async _setStateAckAsync(ownId, val) {
		if (typeof this.adapter.setStateAsync === 'function') {
			await this.adapter.setStateAsync(ownId, { val, ack: true });
			return;
		}
		return new Promise((resolve, reject) =>
			this.adapter.setState(ownId, { val, ack: true }, err => (err ? reject(err) : resolve(undefined))),
		);
	}

	/**
	 * Ensure an object exists (async API preferred; callback API fallback).
	 *
	 * @param {string} ownId Own object id (without namespace).
	 * @param {any} obj Object to create.
	 * @returns {Promise<void>} Resolves after ensuring the object.
	 */
	async _setObjectNotExistsAsync(ownId, obj) {
		if (typeof this.adapter.setObjectNotExistsAsync === 'function') {
			await this.adapter.setObjectNotExistsAsync(ownId, obj);
			return;
		}
		return new Promise((resolve, reject) =>
			this.adapter.setObjectNotExists(ownId, obj, err => (err ? reject(err) : resolve(undefined))),
		);
	}
}

module.exports = { IoManagedMeta };
