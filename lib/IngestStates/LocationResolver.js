'use strict';

/**
 * LocationResolver
 * ================
 *
 * Synchronous lookup of a target's location (room name) based on `enum.rooms.*` membership.
 *
 * Design:
 * - `resolve(id)` is synchronous and side-effect free.
 * - `buildCache()` / `updateCache()` perform the ioBroker object I/O and rebuild the internal index.
 *
 * Expected wiring:
 * - The engine primes and updates this resolver (async) on startup / relevant object changes.
 * - Rules / MessageWriter use `resolve(id)` synchronously.
 */
class LocationResolver {
	/**
	 * @param {object} ctx Plugin runtime context (`ctx.api.*`).
	 */
	constructor(ctx) {
		this.ctx = ctx;

		const raw = ctx?.api?.i18n?.i18nLocale || ctx?.api?.i18n?.i18nlocale || 'en';
		this._locale = typeof raw === 'string' && raw.trim() ? raw.trim() : 'en';

		this._byMember = new Map(); // memberId -> roomName
		this._loadedAt = 0;
	}

	/**
	 * @param {any} value Multilang string or string.
	 * @returns {string} Best-effort translated string.
	 */
	_translatedObjectString(value) {
		if (typeof value === 'string') {
			return value;
		}
		if (!value || typeof value !== 'object') {
			return '';
		}

		const locale = this._locale;
		const base = locale.includes('-') ? locale.split('-')[0] : locale;

		const candidates = [value[locale], value[base], value.en, value.de];

		for (const c of candidates) {
			if (typeof c === 'string' && c.trim()) {
				return c.trim();
			}
		}
		for (const v of Object.values(value)) {
			if (typeof v === 'string' && v.trim()) {
				return v.trim();
			}
		}
		return '';
	}

	/**
	 * Rebuild the `enum.rooms.*` membership index (best-effort).
	 *
	 * @returns {Promise<void>} Resolves after rebuild.
	 */
	async buildCache() {
		const getForeignObjects = this.ctx?.api?.iobroker?.objects?.getForeignObjects;
		if (typeof getForeignObjects !== 'function') {
			this._byMember = new Map();
			this._loadedAt = Date.now();
			return;
		}

		let enums = null;
		try {
			const res = getForeignObjects('enum.rooms.*', 'enum');
			enums = res && typeof res.then === 'function' ? await res : res;
		} catch {
			enums = null;
		}

		const next = new Map();
		for (const obj of Object.values(enums || {})) {
			if (!obj || obj.type !== 'enum') {
				continue;
			}
			const members = obj?.common?.members;
			if (!Array.isArray(members) || members.length === 0) {
				continue;
			}

			const roomName = this._translatedObjectString(obj.common?.name) || obj._id || '';
			if (!roomName) {
				continue;
			}

			for (const member of members) {
				if (typeof member !== 'string' || !member) {
					continue;
				}
				// Deterministic: keep the first seen assignment.
				if (!next.has(member)) {
					next.set(member, roomName);
				}
			}
		}

		this._byMember = next;
		this._loadedAt = Date.now();
	}

	/**
	 * Alias for `buildCache()` (intended for object-change refresh hooks).
	 *
	 * @returns {Promise<void>} Resolves after rebuild.
	 */
	async updateCache() {
		return await this.buildCache();
	}

	/**
	 * Resolve a room name for a state/object id.
	 *
	 * Semantics:
	 * - returns `''` when unknown/not loaded
	 * - walks up the id hierarchy (`a.b.c` -> `a.b` -> `a`) to match enum membership
	 *
	 * @param {string} id Object/state id.
	 * @returns {string} Room name or empty string.
	 */
	resolve(id) {
		const byMember = this._byMember;
		if (!byMember || byMember.size === 0) {
			return '';
		}
		for (
			let cur = id;
			typeof cur === 'string' && cur && cur.includes('.');
			cur = cur.slice(0, cur.lastIndexOf('.'))
		) {
			const room = byMember.get(cur);
			if (room) {
				return room;
			}
		}
		return '';
	}

	/**
	 * @returns {number} Timestamp (ms) when the cache was last built.
	 */
	loadedAt() {
		return this._loadedAt;
	}
}

module.exports = { LocationResolver };
