/**
 * IoAdminTab
 * ==========
 * Adapter-side Admin Tab command facade for MsgHub.
 *
 * Responsibilities
 * - Handle adminTab sendTo commands (`admin.*`) and map them to runtime services.
 * - Normalize payloads and shape responses (DTOs) for the frontend.
 * - Perform non-blocking diagnostics useful for users (e.g. warn about unknown native keys).
 *
 * Non-responsibilities
 * - Plugin runtime orchestration (start/stop/restart) → owned by `IoPlugins`.
 * - ioBroker messagebox dispatch for Engage plugins → owned by `IoPlugins`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isObject } = require(`${__dirname}/../src/MsgUtils`);

/**
 * Adapter-side Admin Tab command facade for MsgHub.
 *
 * Routes `sendTo` commands from the Admin tab (e.g. `admin.plugins.*`) to the
 * runtime services (currently `IoPlugins`) and returns frontend-friendly DTOs.
 */
class IoAdminTab {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} adapter
	 *   ioBroker adapter instance (used for logging and namespace).
	 * @param {import('./IoPlugins').IoPlugins|null} ioPlugins
	 *   Plugin runtime manager to delegate admin actions to (can be null if plugin wiring failed).
	 * @param {object} [options] Optional runtime services.
	 * @param {import('../src/MsgAi').MsgAi|null} [options.ai] Optional MsgAi instance for diagnostics.
	 * @param {any} [options.msgStore] Optional MsgStore instance for diagnostics.
	 */
	constructor(adapter, ioPlugins, { ai = null, msgStore = null } = { ai: null, msgStore: null }) {
		if (!adapter?.namespace) {
			throw new Error('IoAdminTab: adapter is required');
		}
		this.adapter = adapter;
		this.ioPlugins = ioPlugins && typeof ioPlugins === 'object' ? ioPlugins : null;
		this.ai = ai && typeof ai === 'object' ? ai : null;
		this.msgStore = msgStore && typeof msgStore === 'object' ? msgStore : null;

		// Cache to prevent log spam: instanceKey -> "k1,k2,k3"
		this._unknownNativeKeysCache = new Map();

		// Cache for schema parsing (admin/jsonCustom.json -> Bulk Apply schema)
		this._ingestStatesSchemaCache = null;
	}

	/**
	 * Standard error response when IoPlugins is not wired.
	 *
	 * @returns {{ ok: false, error: { code: string, message: string } }} Error response wrapper.
	 */
	_pluginsNotReady() {
		return this._err('NOT_READY', 'Plugin runtime not ready');
	}

	/**
	 * Wrap a successful response payload for the Admin tab.
	 *
	 * @param {any} data Response payload.
	 * @returns {{ ok: true, data: any, native?: any }} Ok response wrapper.
	 */
	_ok(data) {
		return { ok: true, data: data || {} };
	}

	/**
	 * Wrap an error response for the Admin tab.
	 *
	 * @param {string} code Error code.
	 * @param {string} message Error message.
	 * @returns {{ ok: false, error: { code: string, message: string }, native?: any }} Error response wrapper.
	 */
	_err(code, message) {
		return { ok: false, error: { code: String(code || 'ERROR'), message: String(message || 'Error') } };
	}

	/**
	 * Best-effort warn about unknown `native.*` keys for plugin instances.
	 *
	 * This helps detect config drift, but does not block or mutate any data.
	 *
	 * @param {{ plugins: any[], instances: any[] }} data Plugin catalog + instances.
	 * @returns {void} Nothing.
	 */
	_warnUnknownNativeKeys({ plugins, instances }) {
		try {
			const allowedByType = new Map();
			for (const p of plugins || []) {
				if (!p?.type) {
					continue;
				}
				// `native.*` keys that are not part of the manifest options schema, but are still valid.
				// - `enabled`: mirrored desired enable state (for admin UI)
				// - `channel`: optional routing channel for message audience filtering (Notify/Bridge/Engage)
				const allowed = new Set(['enabled', 'channel']);
				if (isObject(p.options)) {
					for (const k of Object.keys(p.options)) {
						allowed.add(k);
					}
				}
				if (isObject(p.defaultOptions)) {
					for (const k of Object.keys(p.defaultOptions)) {
						allowed.add(k);
					}
				}
				allowedByType.set(p.type, allowed);
			}

			for (const inst of instances || []) {
				const type = typeof inst?.type === 'string' ? inst.type : '';
				const instanceId = Number.isFinite(inst?.instanceId) ? Math.trunc(inst.instanceId) : NaN;
				if (!type || !Number.isFinite(instanceId)) {
					continue;
				}
				const allowed = allowedByType.get(type);
				if (!allowed) {
					continue;
				}
				const native = isObject(inst?.native) ? inst.native : {};
				const unknown = Object.keys(native)
					.filter(k => !allowed.has(k))
					.sort();
				if (unknown.length === 0) {
					this._unknownNativeKeysCache.delete(`${type}.${instanceId}`);
					continue;
				}
				const sig = unknown.join(',');
				const key = `${type}.${instanceId}`;
				if (this._unknownNativeKeysCache.get(key) === sig) {
					continue;
				}
				this._unknownNativeKeysCache.set(key, sig);
				this.adapter?.log?.warn?.(
					`AdminTab: unknown native keys for '${this.adapter.namespace}.${type}.${instanceId}': ${unknown.join(', ')}`,
				);
			}
		} catch {
			// swallow
		}
	}

	/**
	 * Handle `admin.plugins.getCatalog`.
	 *
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Catalog response wrapper.
	 */
	async _pluginsGetCatalog() {
		if (!this.ioPlugins || typeof this.ioPlugins.getCatalog !== 'function') {
			return this._pluginsNotReady();
		}
		const plugins = this.ioPlugins.getCatalog();
		return this._ok({ plugins });
	}

	/**
	 * Handle `admin.plugins.listInstances`.
	 *
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Instances response wrapper.
	 */
	async _pluginsListInstances() {
		if (
			!this.ioPlugins ||
			typeof this.ioPlugins.getCatalog !== 'function' ||
			typeof this.ioPlugins.listInstances !== 'function'
		) {
			return this._pluginsNotReady();
		}
		const plugins = this.ioPlugins.getCatalog();
		const instances = await this.ioPlugins.listInstances();
		this._warnUnknownNativeKeys({ plugins, instances });
		return this._ok({ instances });
	}

	/**
	 * Handle `admin.plugins.createInstance`.
	 *
	 * @param {any} payload Create payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Create response wrapper.
	 */
	async _pluginsCreateInstance(payload) {
		if (!this.ioPlugins || typeof this.ioPlugins.createInstance !== 'function') {
			return this._pluginsNotReady();
		}
		return this._ok(await this.ioPlugins.createInstance(payload));
	}

	/**
	 * Handle `admin.plugins.deleteInstance`.
	 *
	 * @param {any} payload Delete payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Delete response wrapper.
	 */
	async _pluginsDeleteInstance(payload) {
		if (!this.ioPlugins || typeof this.ioPlugins.deleteInstance !== 'function') {
			return this._pluginsNotReady();
		}
		await this.ioPlugins.deleteInstance(payload);
		return this._ok({});
	}

	/**
	 * Handle `admin.plugins.updateInstance`.
	 *
	 * @param {any} payload Update payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Update response wrapper.
	 */
	async _pluginsUpdateInstance(payload) {
		if (!this.ioPlugins || typeof this.ioPlugins.updateInstanceNative !== 'function') {
			return this._pluginsNotReady();
		}
		await this.ioPlugins.updateInstanceNative(payload);
		return this._ok({});
	}

	/**
	 * Handle `admin.plugins.setEnabled`.
	 *
	 * @param {any} payload Enable payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Enable response wrapper.
	 */
	async _pluginsSetEnabled(payload) {
		if (!this.ioPlugins || typeof this.ioPlugins.setInstanceEnabled !== 'function') {
			return this._pluginsNotReady();
		}
		await this.ioPlugins.setInstanceEnabled(payload);
		return this._ok({});
	}

	/**
	 * Resolve whether `IngestStates` is available + enabled.
	 *
	 * @returns {Promise<{ ok: true, enabled: true } | { ok: false, error: { code: string, message: string } }>}
	 *   Enabled status wrapper (error when missing/disabled/not ready).
	 */
	async _ingestStatesEnsureEnabled() {
		if (!this.ioPlugins || typeof this.ioPlugins.listInstances !== 'function') {
			return this._pluginsNotReady();
		}

		const instances = await this.ioPlugins.listInstances();
		const inst = (instances || []).find(x => x?.type === 'IngestStates' && x?.instanceId === 0) || null;
		if (!inst) {
			return this._err('PLUGIN_NOT_FOUND', 'IngestStates is not configured (create/enable the plugin first)');
		}
		if (inst.enabled !== true) {
			return this._err('PLUGIN_DISABLED', 'IngestStates is disabled (enable the plugin first)');
		}
		return { ok: true, enabled: true };
	}

	/**
	 * Read foreign objects by wildcard pattern.
	 *
	 * @param {string} pattern ioBroker object id pattern.
	 * @returns {Promise<Record<string, any>>} Objects by id.
	 */
	async _getForeignObjects(pattern) {
		const adapter = this.adapter;
		if (typeof adapter?.getForeignObjectsAsync === 'function') {
			return await adapter.getForeignObjectsAsync(pattern);
		}
		if (typeof adapter?.getForeignObjects === 'function') {
			return await new Promise((resolve, reject) => {
				adapter.getForeignObjects(pattern, (err, res) => (err ? reject(err) : resolve(res || {})));
			});
		}
		throw new Error('adapter.getForeignObjects is not available');
	}

	/**
	 * Read a single foreign object by id.
	 *
	 * @param {string} id ioBroker object id.
	 * @returns {Promise<any|null>} Object or null.
	 */
	async _getForeignObject(id) {
		const adapter = this.adapter;
		if (typeof adapter?.getForeignObjectAsync === 'function') {
			return await adapter.getForeignObjectAsync(id);
		}
		if (typeof adapter?.getForeignObject === 'function') {
			return await new Promise((resolve, reject) => {
				adapter.getForeignObject(id, (err, res) => (err ? reject(err) : resolve(res || null)));
			});
		}
		throw new Error('adapter.getForeignObject is not available');
	}

	/**
	 * Write a foreign object (full replace).
	 *
	 * @param {string} id ioBroker object id.
	 * @param {any} obj Object payload.
	 * @returns {Promise<void>} Resolves when written.
	 */
	async _setForeignObject(id, obj) {
		const adapter = this.adapter;
		if (typeof adapter?.setForeignObjectAsync === 'function') {
			await adapter.setForeignObjectAsync(id, obj);
			return;
		}
		if (typeof adapter?.setForeignObject === 'function') {
			await new Promise((resolve, reject) => {
				adapter.setForeignObject(id, obj, err => (err ? reject(err) : resolve(undefined)));
			});
			return;
		}
		throw new Error('adapter.setForeignObject is not available');
	}

	/**
	 * Deep clone (JSON-safe) for config payloads.
	 *
	 * @param {any} value Input.
	 * @returns {any} Cloned value.
	 */
	_cloneJson(value) {
		return JSON.parse(JSON.stringify(value ?? null));
	}

	/**
	 * Deep merge plain objects (arrays/primitives are replaced).
	 *
	 * @param {any} base Base value.
	 * @param {any} patch Patch value.
	 * @returns {any} Merged value.
	 */
	_mergeDeep(base, patch) {
		if (!isObject(base) || !isObject(patch)) {
			return this._cloneJson(patch);
		}
		const out = { ...base };
		for (const [k, v] of Object.entries(patch)) {
			if (isObject(v) && isObject(out[k])) {
				out[k] = this._mergeDeep(out[k], v);
			} else {
				out[k] = this._cloneJson(v);
			}
		}
		return out;
	}

	/**
	 * Canonicalize IngestStates Custom configs by moving known dotted keys into nested objects.
	 *
	 * This prevents config drift where both `thr.mode` and `thr: { mode }` exist.
	 * Nested objects win on conflict (dotted keys only fill missing leaves).
	 *
	 * Note: This is intentionally limited to known IngestStates prefixes so we do not
	 * touch unrelated dotted keys from other adapters/usages.
	 *
	 * @param {any} entry Custom entry (should already be `managedMeta`-free).
	 * @returns {any} Canonicalized clone.
	 */
	_canonicalizeIngestStatesCustom(entry) {
		const out = this._cloneJson(entry);
		if (!isObject(out)) {
			return out;
		}

		const prefixes = ['thr', 'fresh', 'trg', 'ns', 'sess', 'msg'];
		const hasPrefix = key => prefixes.some(p => String(key).startsWith(`${p}.`));

		for (const key of Object.keys(out)) {
			if (!key.includes('.') || !hasPrefix(key)) {
				continue;
			}

			const value = out[key];
			const parts = key.split('.').filter(Boolean);
			if (parts.length < 2) {
				delete out[key];
				continue;
			}

			let cur = out;
			for (let i = 0; i < parts.length - 1; i += 1) {
				const p = parts[i];
				if (!isObject(cur[p])) {
					cur[p] = {};
				}
				cur = cur[p];
			}

			const leaf = parts[parts.length - 1];
			if (!Object.prototype.hasOwnProperty.call(cur, leaf)) {
				cur[leaf] = value;
			}

			delete out[key];
		}

		return out;
	}

	/**
	 * Remove managed meta keys from a Custom entry so bulk operations never touch `managedMeta`.
	 *
	 * This removes both:
	 * - `managedMeta` (nested object)
	 * - `managedMeta.*` (dotted keys as stored by jsonCustom)
	 *
	 * @param {any} entry Custom entry.
	 * @returns {any} Cloned entry without managedMeta.
	 */
	_stripManagedMeta(entry) {
		const x = this._cloneJson(entry);
		if (!isObject(x)) {
			return x;
		}

		delete x.managedMeta;
		for (const k of Object.keys(x)) {
			if (String(k).startsWith('managedMeta.')) {
				delete x[k];
			}
		}
		return x;
	}

	/**
	 * Pick existing managed meta keys from a Custom entry so we can preserve them on write.
	 *
	 * @param {any} entry Custom entry.
	 * @returns {any} Cloned managed meta payload (nested + dotted keys).
	 */
	_pickManagedMeta(entry) {
		if (!isObject(entry)) {
			return {};
		}

		const keep = {};
		if (isObject(entry.managedMeta)) {
			keep.managedMeta = this._cloneJson(entry.managedMeta);
		}
		for (const [k, v] of Object.entries(entry)) {
			if (String(k).startsWith('managedMeta.')) {
				keep[k] = this._cloneJson(v);
			}
		}
		return keep;
	}

	/**
	 * Re-attach preserved `managedMeta` keys to a new custom payload.
	 *
	 * @param {any} base Existing custom entry.
	 * @param {any} next Next custom entry to write (must already be managedMeta-free).
	 * @returns {any} Next custom entry with preserved managedMeta re-attached.
	 */
	_attachManagedMeta(base, next) {
		const out = isObject(next) ? this._cloneJson(next) : {};
		const keep = this._pickManagedMeta(base);
		for (const [k, v] of Object.entries(keep)) {
			out[k] = v;
		}
		return out;
	}

	/**
	 * Resolve the Bulk Apply schema from `admin/jsonCustom.json` (best-effort).
	 *
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Response wrapper.
	 */
	async _ingestStatesSchemaGet() {
		try {
			if (this._ingestStatesSchemaCache) {
				return this._ok(this._cloneJson(this._ingestStatesSchemaCache));
			}

			const file = path.join(__dirname, '..', 'admin', 'jsonCustom.json');
			const raw = fs.readFileSync(file, 'utf8');
			const parsed = JSON.parse(raw);
			const rootItems = isObject(parsed?.items) ? parsed.items : {};

			const fields = {};

			const addField = (key, node) => {
				if (typeof key !== 'string' || !key.trim()) {
					return;
				}
				if (key === 'managedMeta' || key.startsWith('managedMeta.')) {
					return;
				}
				if (!/^(thr|fresh|trg|ns|sess|msg)\./.test(key)) {
					return;
				}
				if (!node || typeof node !== 'object') {
					return;
				}
				const type = typeof node.type === 'string' ? node.type : '';
				if (!type || type === 'header' || type === 'staticText' || type === 'panel') {
					return;
				}
				const out = {};
				out.type = type;
				if (node.default !== undefined) {
					out.default = node.default;
				}
				if (type === 'select' && Array.isArray(node.options)) {
					out.options = node.options.map(o => o?.value).filter(v => v !== undefined && v !== null);
				}
				if (typeof node.min === 'number' && Number.isFinite(node.min)) {
					out.min = node.min;
				}
				if (typeof node.max === 'number' && Number.isFinite(node.max)) {
					out.max = node.max;
				}
				fields[key] = out;
			};

			const walk = items => {
				if (!isObject(items)) {
					return;
				}
				for (const [key, node] of Object.entries(items)) {
					addField(key, node);
					if (isObject(node?.items)) {
						walk(node.items);
					}
				}
			};

			walk(rootItems);

			// Defaults for fields without explicit defaults in jsonCustom.json
			const defaultByType = type => {
				if (type === 'checkbox') {
					return false;
				}
				if (type === 'number') {
					return 0;
				}
				if (type === 'select') {
					return undefined;
				}
				// `text`, `objectId`, etc.
				return '';
			};

			const defaults = {
				enabled: true,
				mode: 'threshold',
			};

			for (const [key, info] of Object.entries(fields)) {
				if (info.default !== undefined) {
					defaults[key] = info.default;
					continue;
				}
				if (Array.isArray(info.options) && info.options.length) {
					defaults[key] = info.options[0];
					continue;
				}
				defaults[key] = defaultByType(info.type);
			}

			const schema = Object.freeze({
				version: 1,
				generatedAt: Date.now(),
				fields,
				defaults,
			});

			this._ingestStatesSchemaCache = schema;
			return this._ok(this._cloneJson(schema));
		} catch (e) {
			return this._err('INTERNAL', `Failed to load schema: ${String(e?.message || e)}`);
		}
	}

	/**
	 * Read an existing `common.custom.<msghub.X>` entry from a source object.
	 *
	 * @param {{ id?: string }} payload Command payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Response wrapper.
	 */
	async _ingestStatesReadCustom(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
		if (!id) {
			return this._err('BAD_REQUEST', 'Missing id');
		}

		const obj = await this._getForeignObject(id);
		if (!obj) {
			return this._err('NOT_FOUND', `Object not found: '${id}'`);
		}

		const customKey = this.adapter.namespace;
		const entry =
			obj?.common && isObject(obj.common) && obj.common.custom && isObject(obj.common.custom)
				? obj.common.custom[customKey]
				: null;

		const customNoMeta = entry && isObject(entry) ? this._stripManagedMeta(entry) : null;
		const custom =
			customNoMeta && isObject(customNoMeta) ? this._canonicalizeIngestStatesCustom(customNoMeta) : null;
		return this._ok({ id, customKey, custom });
	}

	/**
	 * Preview a bulk-apply operation for `common.custom.<msghub.X>`.
	 *
	 * @param {{ pattern?: string, custom?: any, replace?: boolean, limit?: number }} payload Command payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Response wrapper.
	 */
	async _ingestStatesBulkApplyPreview(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const pattern = typeof payload?.pattern === 'string' ? payload.pattern.trim() : '';
		if (!pattern) {
			return this._err('BAD_REQUEST', 'Missing pattern');
		}

		if (!isObject(payload?.custom)) {
			return this._err('BAD_REQUEST', 'Missing custom config (object)');
		}

		const replace = payload?.replace === true;
		const limitRaw = Number(payload?.limit);
		const limit = Number.isFinite(limitRaw) ? Math.max(0, Math.min(500, Math.trunc(limitRaw))) : 50;

		const customPatch = this._canonicalizeIngestStatesCustom(this._stripManagedMeta(payload.custom));
		const ownPrefix = `${this.adapter.namespace}.`;
		const customKey = this.adapter.namespace;

		const objects = await this._getForeignObjects(pattern);

		let total = 0;
		let matchedStates = 0;
		let willChange = 0;
		let unchanged = 0;
		const sample = [];

		for (const [id, obj] of Object.entries(objects || {})) {
			total += 1;
			if (typeof id !== 'string' || !id || id.startsWith(ownPrefix)) {
				continue;
			}
			if (obj?.type !== 'state') {
				continue;
			}
			matchedStates += 1;

			const existing =
				obj?.common && isObject(obj.common) && obj.common.custom && isObject(obj.common.custom)
					? obj.common.custom[customKey]
					: null;

			const existingNoMeta =
				existing && isObject(existing)
					? this._canonicalizeIngestStatesCustom(this._stripManagedMeta(existing))
					: null;
			const nextNoMeta = replace
				? customPatch
				: this._mergeDeep(existingNoMeta && isObject(existingNoMeta) ? existingNoMeta : {}, customPatch);
			const next = this._attachManagedMeta(existing, nextNoMeta);
			const existingJson = JSON.stringify(existing && isObject(existing) ? existing : null);
			const nextJson = JSON.stringify(next);
			const isChanged = existingJson !== nextJson;
			if (isChanged) {
				willChange += 1;
			} else {
				unchanged += 1;
			}

			if (sample.length < limit) {
				sample.push({ id, changed: isChanged });
			}
		}

		return this._ok({
			customKey,
			pattern,
			replace,
			totalObjects: total,
			matchedStates,
			willChange,
			unchanged,
			sample,
		});
	}

	/**
	 * Apply a bulk-apply operation for `common.custom.<msghub.X>`.
	 *
	 * @param {{ pattern?: string, custom?: any, replace?: boolean }} payload Command payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Response wrapper.
	 */
	async _ingestStatesBulkApplyApply(payload) {
		const gate = await this._ingestStatesEnsureEnabled();
		if (!gate?.ok) {
			return gate;
		}

		const pattern = typeof payload?.pattern === 'string' ? payload.pattern.trim() : '';
		if (!pattern) {
			return this._err('BAD_REQUEST', 'Missing pattern');
		}

		if (!isObject(payload?.custom)) {
			return this._err('BAD_REQUEST', 'Missing custom config (object)');
		}

		const replace = payload?.replace === true;
		const customPatch = this._canonicalizeIngestStatesCustom(this._stripManagedMeta(payload.custom));

		const ownPrefix = `${this.adapter.namespace}.`;
		const customKey = this.adapter.namespace;

		const objects = await this._getForeignObjects(pattern);

		let total = 0;
		let matchedStates = 0;
		let updated = 0;
		let unchanged = 0;
		const errors = [];

		for (const [id, obj] of Object.entries(objects || {})) {
			total += 1;
			if (typeof id !== 'string' || !id || id.startsWith(ownPrefix)) {
				continue;
			}
			if (obj?.type !== 'state') {
				continue;
			}
			matchedStates += 1;

			const common = isObject(obj?.common) ? obj.common : {};
			const custom = isObject(common.custom) ? common.custom : {};
			const existing = custom[customKey] && isObject(custom[customKey]) ? custom[customKey] : null;

			const existingNoMeta =
				existing && isObject(existing)
					? this._canonicalizeIngestStatesCustom(this._stripManagedMeta(existing))
					: null;
			const nextNoMeta = replace
				? customPatch
				: this._mergeDeep(existingNoMeta && isObject(existingNoMeta) ? existingNoMeta : {}, customPatch);
			const next = this._attachManagedMeta(existing, nextNoMeta);
			const existingJson = JSON.stringify(existing && isObject(existing) ? existing : null);
			const nextJson = JSON.stringify(next);
			if (existingJson === nextJson) {
				unchanged += 1;
				continue;
			}

			try {
				const nextObj = this._cloneJson(obj);
				if (!isObject(nextObj.common)) {
					nextObj.common = {};
				}
				if (!isObject(nextObj.common.custom)) {
					nextObj.common.custom = {};
				}
				nextObj.common.custom[customKey] = next;
				await this._setForeignObject(id, nextObj);
				updated += 1;
			} catch (e) {
				errors.push({ id, message: String(e?.message || e) });
			}
		}

		return this._ok({
			customKey,
			pattern,
			replace,
			totalObjects: total,
			matchedStates,
			updated,
			unchanged,
			errors,
		});
	}

	/**
	 * Handle `admin.ai.test`.
	 *
	 * This is a diagnostics helper for the instance config (jsonConfig):
	 * it performs a minimal AI request and returns a `native.*` patch via `useNative`.
	 *
	 * @param {any} payload Test request payload.
	 * @returns {Promise<{ ok?: boolean, data?: any, error?: any, native?: any }>} Response wrapper.
	 */
	async _aiTest(payload) {
		const baseAi = this.ai;
		if (!baseAi || typeof baseAi.createCallerApi !== 'function') {
			return { native: { aiTestLastResult: 'ERROR NOT_READY: AI runtime not wired' } };
		}

		const safe = payload && typeof payload === 'object' ? payload : {};
		const purpose = typeof safe.purpose === 'string' && safe.purpose.trim() ? safe.purpose.trim() : 'ai-test';
		const quality = typeof safe.quality === 'string' && safe.quality.trim() ? safe.quality.trim() : 'balanced';
		const prompt =
			typeof safe.prompt === 'string' && safe.prompt.trim()
				? safe.prompt.trim()
				: 'Respond with a short sentence: pong';

		// Allow config-page tests without requiring an adapter restart:
		// when provider options are passed explicitly, build a temporary MsgAi instance.
		let ai = baseAi;
		const provider = typeof safe.provider === 'string' && safe.provider.trim() ? safe.provider.trim() : '';
		const openai = safe.openai && typeof safe.openai === 'object' ? safe.openai : null;
		const apiKey = typeof openai?.apiKey === 'string' ? openai.apiKey.trim() : '';
		const wantsOverrides = !!(
			provider ||
			apiKey ||
			openai?.baseUrl ||
			(openai?.modelsByQuality && typeof openai.modelsByQuality === 'object') ||
			Array.isArray(openai?.purposeModelOverrides)
		);

		if (wantsOverrides) {
			try {
				const { MsgAi } = require(`${__dirname}/../src/MsgAi`);
				ai = new MsgAi(this.adapter, {
					enabled: true,
					provider: provider || 'openai',
					openai: {
						apiKey,
						baseUrl: openai?.baseUrl,
						modelsByQuality: openai?.modelsByQuality,
						purposeModelOverrides: openai?.purposeModelOverrides,
					},
					timeoutMs: 15000,
					maxConcurrency: 1,
				});
			} catch (e) {
				return {
					native: {
						aiTestLastResult: `ERROR INTERNAL: Failed to build test AI runtime: ${String(e?.message || e)}`,
					},
				};
			}
		}

		const api = ai.createCallerApi({ regId: 'Admin:jsonConfig' });
		const res = await api.text({
			purpose,
			messages: [
				{ role: 'system', content: 'You are a connectivity test. Reply concisely.' },
				{ role: 'user', content: prompt },
			],
			hints: { quality },
			timeoutMs: 15000,
		});

		const out =
			res?.ok === true
				? String(res.value || '')
				: `ERROR ${String(res?.error?.code || 'ERROR')}: ${String(res?.error?.message || 'Error')}`;

		const meta = res?.meta && typeof res.meta === 'object' ? res.meta : {};
		const summary = [
			`ok=${res?.ok === true ? 'true' : 'false'}`,
			meta.provider ? `provider=${meta.provider}` : null,
			meta.model ? `model=${meta.model}` : null,
			meta.quality ? `quality=${meta.quality}` : null,
			typeof meta.durationMs === 'number' ? `durationMs=${meta.durationMs}` : null,
			meta.cached ? `cached=${meta.cached}` : null,
		]
			.filter(Boolean)
			.join(' ');

		return { native: { aiTestLastResult: `${summary}\n\n${out}`.trim() } };
	}

	/**
	 * Handle `admin.stats.get`.
	 *
	 * @param {any} payload Stats request payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Stats response wrapper.
	 */
	async _statsGet(payload) {
		const store = this.msgStore;
		if (!store || typeof store.getStats !== 'function') {
			return this._err('NOT_READY', 'Stats runtime not ready');
		}

		const safe = payload && typeof payload === 'object' ? payload : {};
		const includeRaw = isObject(safe.include) ? safe.include : {};
		const include = {};

		include.archiveSize = includeRaw.archiveSize === true;
		const maxAgeRaw = includeRaw.archiveSizeMaxAgeMs;
		if (typeof maxAgeRaw === 'number' && Number.isFinite(maxAgeRaw)) {
			include.archiveSizeMaxAgeMs = Math.max(0, Math.trunc(maxAgeRaw));
		}

		try {
			const stats = await store.getStats({ include });
			return this._ok(stats);
		} catch (e) {
			return this._err('INTERNAL', `Stats failed: ${String(e?.message || e)}`);
		}
	}

	/**
	 * Handle `admin.messages.query`.
	 *
	 * This is intentionally a thin proxy to `MsgStore.queryMessages(...)` so the Admin tab can render
	 * a message table without requiring any direct backend coupling.
	 *
	 * @param {any} payload Query payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Query response wrapper.
	 */
	async _messagesQuery(payload) {
		const store = this.msgStore;
		if (!store || typeof store.queryMessages !== 'function') {
			return this._err('NOT_READY', 'Store runtime not ready');
		}

		let tz = null;
		try {
			tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
		} catch {
			tz = null;
		}

		const safe = payload && typeof payload === 'object' ? payload : {};
		const queryRaw = isObject(safe.query) ? safe.query : {};

		const query = {};
		if (isObject(queryRaw.where)) {
			query.where = queryRaw.where;
		}
		if (isObject(queryRaw.page)) {
			query.page = queryRaw.page;
		}
		if (Array.isArray(queryRaw.sort)) {
			query.sort = queryRaw.sort;
		} else if (isObject(queryRaw.sort)) {
			query.sort = queryRaw.sort;
		}

		try {
			const res = store.queryMessages(query);
			const items = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
			const total = typeof res?.total === 'number' && Number.isFinite(res.total) ? Math.trunc(res.total) : null;
			const pages = typeof res?.pages === 'number' && Number.isFinite(res.pages) ? Math.trunc(res.pages) : null;
			return this._ok({
				meta: {
					generatedAt: Date.now(),
					tz,
				},
				items,
				...(total != null ? { total } : {}),
				...(pages != null ? { pages } : {}),
			});
		} catch (e) {
			return this._err('BAD_REQUEST', `Query failed: ${String(e?.message || e)}`);
		}
	}

	/**
	 * Handle `admin.constants.get`.
	 *
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Constants response wrapper.
	 */
	async _constantsGet() {
		const store = this.msgStore;
		const msgConstants = store?.msgConstants;
		if (!msgConstants || typeof msgConstants !== 'object') {
			return this._err('NOT_READY', 'Constants not ready');
		}

		const kind = msgConstants.kind && typeof msgConstants.kind === 'object' ? msgConstants.kind : {};
		const lifecycle =
			msgConstants.lifecycle && typeof msgConstants.lifecycle === 'object' ? msgConstants.lifecycle : {};
		const level = msgConstants.level && typeof msgConstants.level === 'object' ? msgConstants.level : {};

		return this._ok({
			kind,
			lifecycle: lifecycle?.state && typeof lifecycle.state === 'object' ? { state: lifecycle.state } : {},
			level,
		});
	}

	/**
	 * Main entry point for `main.js` to handle adminTab sendTo commands.
	 *
	 * @param {string} cmd Command name (e.g. `admin.plugins.getCatalog`).
	 * @param {any} payload Command payload.
	 * @returns {Promise<{ ok?: boolean, data?: any, error?: any, native?: any }>} Response wrapper for the Admin tab.
	 */
	async handleCommand(cmd, payload) {
		const c = typeof cmd === 'string' ? cmd.trim() : '';
		if (!c) {
			return this._err('BAD_REQUEST', 'Missing command');
		}

		// New (preferred) namespace
		if (c === 'admin.plugins.getCatalog') {
			return await this._pluginsGetCatalog();
		}
		if (c === 'admin.plugins.listInstances') {
			return await this._pluginsListInstances();
		}
		if (c === 'admin.plugins.createInstance') {
			return await this._pluginsCreateInstance(payload);
		}
		if (c === 'admin.plugins.deleteInstance') {
			return await this._pluginsDeleteInstance(payload);
		}
		if (c === 'admin.plugins.updateInstance') {
			return await this._pluginsUpdateInstance(payload);
		}
		if (c === 'admin.plugins.setEnabled') {
			return await this._pluginsSetEnabled(payload);
		}
		if (c === 'admin.ai.test') {
			return await this._aiTest(payload);
		}
		if (c === 'admin.stats.get') {
			return await this._statsGet(payload);
		}
		if (c === 'admin.messages.query') {
			return await this._messagesQuery(payload);
		}
		if (c === 'admin.constants.get') {
			return await this._constantsGet();
		}
		if (c === 'admin.ingestStates.custom.read') {
			return await this._ingestStatesReadCustom(payload);
		}
		if (c === 'admin.ingestStates.schema.get') {
			return await this._ingestStatesSchemaGet();
		}
		if (c === 'admin.ingestStates.bulkApply.preview') {
			return await this._ingestStatesBulkApplyPreview(payload);
		}
		if (c === 'admin.ingestStates.bulkApply.apply') {
			return await this._ingestStatesBulkApplyApply(payload);
		}

		return this._err('UNKNOWN_COMMAND', `Unknown admin command '${c}'`);
	}
}

module.exports = { IoAdminTab };
