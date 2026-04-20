/**
 * IoIdCatalog
 * ===========
 * Shared backend cache and projection owner for config-facing ID catalog commands.
 *
 * Docs: ../docs/io/IoIdCatalog.md
 *
 * Responsibilities
 * - Build and own the reduced shared backend full-cache for ioBroker state objects.
 * - Apply one global TTL and expose an explicit full reset.
 * - Serve flat `get(filter)` and tree-oriented `openTree(entry, depth)` views from the same cache.
 * - Produce the shared `meta` block for ID-catalog command responses.
 *
 * Non-responsibilities
 * - Config token validation and command routing.
 * - Frontend merge strategies or picker UI behavior.
 * - Broad ioBroker object projection beyond the hard whitelist.
 *
 */

'use strict';

const { performance } = require('node:perf_hooks');

/**
 * Owns the shared backend cache for config-facing ID catalog access.
 */
class IoIdCatalog {
	static DEFAULT_TTL_MS = 30 * 60 * 1000;

	/**
	 * Create one catalog owner bound to one adapter instance.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} adapter
	 *   ioBroker adapter instance.
	 * @param {object} [options] Optional runtime hooks.
	 * @param {number} [options.ttlMs] Global TTL for the shared backend cache.
	 * @param {() => number} [options.now] Millisecond clock used for cache timestamps.
	 * @param {() => number} [options.performanceNow] High-resolution clock used for command durations.
	 */
	constructor(adapter, { ttlMs = IoIdCatalog.DEFAULT_TTL_MS, now, performanceNow } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoIdCatalog: adapter is required');
		}
		this.adapter = adapter;
		this.ttlMs =
			Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
				? Math.trunc(Number(ttlMs))
				: IoIdCatalog.DEFAULT_TTL_MS;
		this._now = typeof now === 'function' ? now : () => Date.now();
		this._performanceNow = typeof performanceNow === 'function' ? performanceNow : () => performance.now();
		this._cache = null;
		this._cachePromise = null;
		this._cacheGeneration = 0;
	}

	/**
	 * Return a reduced flat catalog view from the shared backend cache.
	 *
	 * @param {any} payload Optional command payload.
	 * @returns {Promise<object>} Reduced catalog response.
	 */
	async get(payload) {
		const startedAt = this._performanceNow();
		let cache;
		try {
			cache = await this._getOrBuildCache();
		} catch (e) {
			return this._err('NOT_READY', String(e?.message || e));
		}
		const filter = this._normalizeFilter(payload?.filter);
		return {
			ok: true,
			data: {
				objects: this._selectObjects(cache.objects, filter),
				meta: this._buildMeta(startedAt, cache),
			},
		};
	}

	/**
	 * Return one tree-oriented catalog slice from the shared backend cache.
	 *
	 * @param {any} payload Optional command payload.
	 * @returns {Promise<object>} Tree slice response.
	 */
	async openTree(payload) {
		const startedAt = this._performanceNow();
		let cache;
		try {
			cache = await this._getOrBuildCache();
		} catch (e) {
			return this._err('NOT_READY', String(e?.message || e));
		}
		const entry = this._normalizeEntry(payload?.entry);
		const depth = this._normalizeDepth(payload?.depth);
		return {
			ok: true,
			data: {
				entry,
				depth,
				ancestors: this._buildAncestorNodes(cache.objects, entry),
				nodes: this._buildTreeNodes(cache.objects, entry, depth),
				meta: this._buildMeta(startedAt, cache),
			},
		};
	}

	/**
	 * Drop the shared backend cache immediately.
	 *
	 * @returns {{ok: true, data: {reset: true, hadCache: boolean}}} Reset result.
	 */
	reset() {
		const hadCache = !!this._cache || !!this._cachePromise;
		this._cacheGeneration += 1;
		this._cache = null;
		this._cachePromise = null;
		return {
			ok: true,
			data: {
				reset: true,
				hadCache,
			},
		};
	}

	/**
	 * Build a structured error response.
	 *
	 * @param {string} code Machine-readable error code.
	 * @param {string} message Human-readable error message.
	 * @returns {{ok: false, error: {code: string, message: string}}} Error response.
	 */
	_err(code, message) {
		return {
			ok: false,
			error: {
				code: String(code || 'ERROR'),
				message: String(message || 'Error'),
			},
		};
	}

	/**
	 * Return one valid cache instance or build it on demand.
	 *
	 * @returns {Promise<{createdAt: number, objects: Record<string, any>}>} Active cache.
	 */
	async _getOrBuildCache() {
		const cached = this._cache;
		if (cached && this._isCacheFresh(cached)) {
			return cached;
		}
		const activeBuild = this._cachePromise;
		if (activeBuild) {
			return await activeBuild;
		}
		const buildGeneration = this._cacheGeneration;
		const buildPromise = this._buildCache();
		this._cachePromise = buildPromise;
		try {
			const builtCache = await buildPromise;
			if (this._cachePromise === buildPromise && this._cacheGeneration === buildGeneration) {
				this._cache = builtCache;
			}
			return builtCache;
		} finally {
			if (this._cachePromise === buildPromise) {
				this._cachePromise = null;
			}
		}
	}

	/**
	 * Check whether one cache snapshot is still valid under the global TTL.
	 *
	 * @param {{createdAt: number}|null} cache Candidate cache snapshot.
	 * @returns {boolean} True when the cache is still valid.
	 */
	_isCacheFresh(cache) {
		return !!cache && Number.isFinite(cache.createdAt) && this._now() - cache.createdAt < this.ttlMs;
	}

	/**
	 * Build the shared reduced full-cache from ioBroker state objects.
	 *
	 * @returns {Promise<{createdAt: number, objects: Record<string, any>}>} New cache snapshot.
	 */
	async _buildCache() {
		const objects = await this._getForeignObjectsAsync('*', 'state');
		const reduced = {};
		for (const [id, obj] of Object.entries(objects || {})) {
			if (!obj || typeof obj !== 'object' || obj.type !== 'state') {
				continue;
			}
			const out = {
				_id: typeof obj._id === 'string' && obj._id.trim() ? obj._id : id,
			};
			const common = this._projectCommon(obj.common);
			if (common) {
				out.common = common;
			}
			reduced[id] = out;
		}
		return {
			createdAt: this._now(),
			objects: reduced,
		};
	}

	/**
	 * Read foreign objects via async or callback adapter API.
	 *
	 * @param {string} pattern ioBroker object pattern.
	 * @param {string} [type] Optional ioBroker object type filter.
	 * @returns {Promise<Record<string, any>>} Raw foreign object map.
	 */
	async _getForeignObjectsAsync(pattern, type = undefined) {
		if (typeof this.adapter?.getForeignObjectsAsync === 'function') {
			const objects =
				type === undefined
					? await this.adapter.getForeignObjectsAsync(pattern)
					: await this.adapter.getForeignObjectsAsync(pattern, type);
			return objects || {};
		}
		if (typeof this.adapter?.getForeignObjects === 'function') {
			return await new Promise((resolve, reject) => {
				if (type === undefined) {
					this.adapter.getForeignObjects(pattern, (err, objs) => (err ? reject(err) : resolve(objs || {})));
					return;
				}
				this.adapter.getForeignObjects(pattern, type, (err, objs) => (err ? reject(err) : resolve(objs || {})));
			});
		}
		throw new Error('getForeignObjects is not available');
	}

	/**
	 * Reduce one ioBroker `common` block to the hard picker whitelist.
	 *
	 * @param {any} commonIn Raw `common` block.
	 * @returns {Record<string, any>|undefined} Whitelisted `common` projection.
	 */
	_projectCommon(commonIn) {
		if (!commonIn || typeof commonIn !== 'object' || Array.isArray(commonIn)) {
			return undefined;
		}
		const commonOut = {};
		if (typeof commonIn.name !== 'undefined') {
			commonOut.name = commonIn.name;
		}
		if (typeof commonIn.type === 'string' && commonIn.type) {
			commonOut.type = commonIn.type;
		}
		if (typeof commonIn.role === 'string' && commonIn.role) {
			commonOut.role = commonIn.role;
		}
		if (typeof commonIn.unit === 'string' && commonIn.unit) {
			commonOut.unit = commonIn.unit;
		}
		return Object.keys(commonOut).length > 0 ? commonOut : undefined;
	}

	/**
	 * Normalize one filter candidate.
	 *
	 * @param {any} value Raw filter candidate.
	 * @returns {string} Normalized filter with `'*'` fallback.
	 */
	_normalizeFilter(value) {
		return typeof value === 'string' && value.trim() ? value.trim() : '*';
	}

	/**
	 * Normalize one tree entry candidate.
	 *
	 * @param {any} value Raw entry candidate.
	 * @returns {string} Normalized entry path or empty string for root.
	 */
	_normalizeEntry(value) {
		return typeof value === 'string'
			? value
					.trim()
					.replace(/\.+/g, '.')
					.replace(/^\.|\.$/g, '')
			: '';
	}

	/**
	 * Normalize one tree depth candidate.
	 *
	 * @param {any} value Raw depth candidate.
	 * @returns {number} Safe tree depth in the range `1..8`.
	 */
	_normalizeDepth(value) {
		const n = Number(value);
		if (!Number.isFinite(n)) {
			return 1;
		}
		return Math.max(1, Math.min(8, Math.trunc(n)));
	}

	/**
	 * Filter the reduced object map by one ioBroker-style glob.
	 *
	 * @param {Record<string, any>} objects Shared reduced object map.
	 * @param {string} filter Normalized filter.
	 * @returns {Record<string, any>} Filtered object map.
	 */
	_selectObjects(objects, filter) {
		if (filter === '*') {
			return this._cloneProjectedObjectMap(objects);
		}
		const out = {};
		for (const [id, obj] of Object.entries(objects || {})) {
			if (this._matchesFilter(id, filter)) {
				out[id] = this._cloneProjectedObject(obj);
			}
		}
		return out;
	}

	/**
	 * Check whether one object id matches one ioBroker-style glob.
	 *
	 * Supported wildcards are `*` and `?`.
	 *
	 * @param {string} id Full object id.
	 * @param {string} filter Normalized filter.
	 * @returns {boolean} True when the id matches the filter.
	 */
	_matchesFilter(id, filter) {
		const escaped = String(filter)
			.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
			.replace(/\*/g, '.*')
			.replace(/\\\?/g, '.');
		return new RegExp(`^${escaped}$`).test(String(id));
	}

	/**
	 * Build the shared `meta` block for `get` and `openTree`.
	 *
	 * @param {number} startedAt High-resolution command start timestamp.
	 * @param {{createdAt: number}} cache Active cache snapshot.
	 * @returns {{backendDurationMs: number, createdAt: number, ttlMs: number}} Shared meta block.
	 */
	_buildMeta(startedAt, cache) {
		return {
			backendDurationMs: Number((this._performanceNow() - startedAt).toFixed(1)),
			createdAt: cache.createdAt,
			ttlMs: this.ttlMs,
		};
	}

	/**
	 * Build one tree-oriented node list from the reduced full-cache.
	 *
	 * @param {Record<string, any>} objects Shared reduced object map.
	 * @param {string} entry Normalized subtree entry.
	 * @param {number} depth Normalized response depth.
	 * @returns {object[]} Tree node list sorted by level and entry.
	 */
	_buildTreeNodes(objects, entry, depth) {
		const nodesByEntry = new Map();
		for (const [id, obj] of Object.entries(objects || {})) {
			const relativeTokens = entry ? this._tokenizeRelativeEntry(id, entry) : this._tokenizeRootId(id);
			if (relativeTokens.length === 0) {
				continue;
			}
			const maxLevel = Math.min(depth, relativeTokens.length);
			for (let level = 1; level <= maxLevel; level += 1) {
				const pathTokens = relativeTokens.slice(0, level);
				const nodeEntry = entry ? `${entry}.${pathTokens.join('.')}` : pathTokens.join('.');
				const parentTokens = pathTokens.slice(0, -1);
				const parent = entry
					? parentTokens.length > 0
						? `${entry}.${parentTokens.join('.')}`
						: entry
					: parentTokens.join('.');
				const isExactState = level === relativeTokens.length;
				const hasChildren = relativeTokens.length > level;
				let node = nodesByEntry.get(nodeEntry);
				if (!node) {
					node = {
						entry: nodeEntry,
						parent: parent || '',
						level,
						label: pathTokens[pathTokens.length - 1] || nodeEntry,
						expandable: false,
					};
					nodesByEntry.set(nodeEntry, node);
				}
				if (hasChildren) {
					node.expandable = true;
				}
				if (isExactState) {
					node._id = obj._id;
					if (obj.common) {
						node.common = this._cloneProjectedCommon(obj.common);
					}
				}
			}
		}
		return Array.from(nodesByEntry.values()).sort((a, b) => {
			if (a.level !== b.level) {
				return a.level - b.level;
			}
			return String(a.entry).localeCompare(String(b.entry));
		});
	}

	/**
	 * Build the orienting ancestor path for one non-root tree entry.
	 *
	 * The ancestor path includes the requested `entry` itself but never expands
	 * sideways into sibling nodes on those levels.
	 *
	 * @param {Record<string, any>} objects Shared reduced object map.
	 * @param {string} entry Normalized subtree entry.
	 * @returns {object[]} Ordered ancestor path from root to `entry`.
	 */
	_buildAncestorNodes(objects, entry) {
		if (!entry) {
			return [];
		}
		const tokens = this._tokenizeRootId(entry);
		const ancestors = [];
		for (let level = 1; level <= tokens.length; level += 1) {
			const pathTokens = tokens.slice(0, level);
			const nodeEntry = pathTokens.join('.');
			const parentTokens = pathTokens.slice(0, -1);
			const projected = objects[nodeEntry] || null;
			const node = {
				entry: nodeEntry,
				parent: parentTokens.join('.'),
				level,
				label: pathTokens[pathTokens.length - 1] || nodeEntry,
				expandable: this._hasDescendants(objects, nodeEntry),
			};
			if (projected) {
				node._id = projected._id;
				if (projected.common) {
					node.common = this._cloneProjectedCommon(projected.common);
				}
			}
			ancestors.push(node);
		}
		return ancestors;
	}

	/**
	 * Tokenize one full state id for root-tree grouping.
	 *
	 * Root grouping keeps the instance prefix up to the first numeric segment,
	 * for example `javascript.0` or `system.adapter.web.1`.
	 *
	 * @param {string} id Full state id.
	 * @returns {string[]} Root-relative token list.
	 */
	_tokenizeRootId(id) {
		const parts = String(id || '')
			.split('.')
			.filter(Boolean);
		if (parts.length === 0) {
			return [];
		}
		const firstNumericIndex = parts.findIndex(part => /^\d+$/.test(part));
		if (firstNumericIndex === -1) {
			return [parts[0], ...parts.slice(1)];
		}
		return [parts.slice(0, firstNumericIndex + 1).join('.'), ...parts.slice(firstNumericIndex + 1)];
	}

	/**
	 * Tokenize one state id relative to one subtree entry.
	 *
	 * @param {string} id Full state id.
	 * @param {string} entry Normalized subtree entry.
	 * @returns {string[]} Entry-relative token list.
	 */
	_tokenizeRelativeEntry(id, entry) {
		const prefix = `${entry}.`;
		if (!String(id).startsWith(prefix)) {
			return [];
		}
		return String(id).slice(prefix.length).split('.').filter(Boolean);
	}

	/**
	 * Check whether one catalog entry has known descendants in the shared cache.
	 *
	 * @param {Record<string, any>} objects Shared reduced object map.
	 * @param {string} entry Catalog entry to inspect.
	 * @returns {boolean} True when the entry has descendants in the cache.
	 */
	_hasDescendants(objects, entry) {
		const prefix = `${entry}.`;
		return Object.keys(objects || {}).some(id => id.startsWith(prefix));
	}

	/**
	 * Clone one reduced object map so callers cannot mutate the shared cache.
	 *
	 * @param {Record<string, any>} objects Reduced object map.
	 * @returns {Record<string, any>} Cloned reduced object map.
	 */
	_cloneProjectedObjectMap(objects) {
		const out = {};
		for (const [id, obj] of Object.entries(objects || {})) {
			out[id] = this._cloneProjectedObject(obj);
		}
		return out;
	}

	/**
	 * Clone one reduced catalog object.
	 *
	 * @param {Record<string, any>} obj Reduced catalog object.
	 * @returns {Record<string, any>} Cloned reduced catalog object.
	 */
	_cloneProjectedObject(obj) {
		const out = {
			_id: obj._id,
		};
		if (obj.common) {
			out.common = this._cloneProjectedCommon(obj.common);
		}
		return out;
	}

	/**
	 * Clone one reduced `common` block.
	 *
	 * @param {Record<string, any>} common Reduced `common` block.
	 * @returns {Record<string, any>} Cloned `common` block.
	 */
	_cloneProjectedCommon(common) {
		return { ...common };
	}
}

module.exports = { IoIdCatalog };
