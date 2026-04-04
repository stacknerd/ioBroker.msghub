/**
 * IoAdminTab
 * ==========
 * Adapter-side Admin Tab command facade for MsgHub.
 *
 * Docs: ../docs/io/IoAdminTab.md
 *
 * Responsibilities
 * - Handle adminTab sendTo commands (`admin.*`) and map them to runtime services.
 * - Normalize payloads and shape responses (DTOs) for the frontend.
 * - Perform non-blocking diagnostics useful for users (e.g. warn about unknown native keys).
 * - Serve only AdminTab runtime commands; config commands are owned by `IoAdminConfig`.
 *
 * Non-responsibilities
 * - Plugin runtime orchestration (start/stop/restart) → owned by `IoPlugins`.
 * - ioBroker messagebox dispatch for Engage plugins → owned by `IoPlugins`.
 */

'use strict';

const { isObject, serializeWithMaps } = require(`${__dirname}/../src/MsgUtils`);

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
	 * @param {any} [options.msgStore] Optional MsgStore instance for diagnostics.
	 */
	constructor(adapter, ioPlugins, { msgStore = null } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoAdminTab: adapter is required');
		}
		this.adapter = adapter;
		this.ioPlugins = ioPlugins && typeof ioPlugins === 'object' ? ioPlugins : null;
		this.msgStore = msgStore && typeof msgStore === 'object' ? msgStore : null;

		// Cache to prevent log spam: instanceKey -> "k1,k2,k3"
		this._unknownNativeKeysCache = new Map();

		// In-memory cache for plugin admin UI bundles: key = `${type}:${instanceId}:${panelId}:${hash}`
		this._bundleCache = new Map();
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
	 * Handle `admin.pluginUi.discover`.
	 *
	 * Returns all admin UI panel contributions with computed content hashes.
	 * Hash computation is parallel and best-effort: if hash computation fails for a panel,
	 * the contribution is still returned with `bundle.hash: ''` and a warn is logged.
	 * `bundle.get` is the authoritative hash source; discover hash is informational only (per D6).
	 *
	 * @param {any} payload Request payload (`{ lang? }`).
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Discover response wrapper.
	 */
	async _pluginUiDiscover(payload) {
		if (
			!this.ioPlugins ||
			typeof this.ioPlugins.getAdminUiContributions !== 'function' ||
			typeof this.ioPlugins.computeAdminUiBundleHash !== 'function' ||
			typeof this.ioPlugins.readAdminUiTranslations !== 'function'
		) {
			return this._pluginsNotReady();
		}
		const ioPlugins = this.ioPlugins;
		const rawLang = typeof payload?.lang === 'string' ? payload.lang.trim().toLowerCase() : '';
		const lang = /^[a-z]{2}(-[a-z]{2,4})?$/.test(rawLang) ? rawLang : 'en';
		const contribs = ioPlugins.getAdminUiContributions();
		const hashes = await Promise.all(
			contribs.map(async c => {
				try {
					return await ioPlugins.computeAdminUiBundleHash({
						type: c.pluginType,
						panelId: c.panelId,
					});
				} catch (e) {
					this.adapter?.log?.warn?.(
						`AdminTab: failed to compute hash for '${c.pluginType}/${c.panelId}': ${e?.message || e}`,
					);
					return '';
				}
			}),
		);
		const translationsByType = new Map();
		await Promise.all(
			Array.from(
				new Set(contribs.map(c => c.pluginType).filter(type => typeof type === 'string' && type.trim())),
			).map(async pluginType => {
				try {
					translationsByType.set(
						pluginType,
						await ioPlugins.readAdminUiTranslations({ type: pluginType, lang }),
					);
				} catch (e) {
					this.adapter?.log?.warn?.(
						`AdminTab: failed to read Admin UI i18n for '${pluginType}': ${e?.message || e}`,
					);
					translationsByType.set(pluginType, null);
				}
			}),
		);
		return this._ok(
			contribs.map((c, i) => ({
				...c,
				bundle: { hash: hashes[i] },
				i18n: translationsByType.get(c.pluginType) ?? null,
			})),
		);
	}

	/**
	 * Handle `admin.pluginUi.bundle.get`.
	 *
	 * Fetches the ESM bundle (and optional CSS and i18n) for a plugin admin UI panel.
	 * Bundles are cached in-memory keyed by (pluginType, instanceId, panelId, hash, lang).
	 * Lang is part of the cache key because the i18n payload is language-dependent.
	 * Bundle JS is limited to 512 KB; companion CSS and i18n to 64 KB each.
	 *
	 * @param {any} payload Request payload: `{ pluginType, instanceId?, panelId, lang? }`.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Bundle response wrapper.
	 */
	async _pluginUiBundleGet(payload) {
		if (
			!this.ioPlugins ||
			typeof this.ioPlugins.getAdminUiContributions !== 'function' ||
			typeof this.ioPlugins.readAdminUiBundle !== 'function' ||
			typeof this.ioPlugins.computeAdminUiBundleHash !== 'function'
		) {
			return this._pluginsNotReady();
		}

		const pluginType = typeof payload?.pluginType === 'string' ? payload.pluginType.trim() : '';
		const panelId = typeof payload?.panelId === 'string' ? payload.panelId.trim() : '';
		const instanceId =
			typeof payload?.instanceId === 'number' && Number.isFinite(payload.instanceId)
				? Math.trunc(payload.instanceId)
				: 0;
		// Normalize lang to a safe base language code (e.g. 'de', 'en', 'zh-cn').
		// Rejects any value that cannot form a valid BCP 47 base tag to prevent path traversal.
		const rawLang = typeof payload?.lang === 'string' ? payload.lang.trim().toLowerCase() : '';
		const lang = /^[a-z]{2}(-[a-z]{2,4})?$/.test(rawLang) ? rawLang : 'en';

		if (!pluginType || !panelId) {
			return this._err('BAD_REQUEST', 'pluginType and panelId are required');
		}

		// Validate: plugin is running and panel exists.
		const contributions = this.ioPlugins.getAdminUiContributions();
		const contrib = contributions.find(
			c => c.pluginType === pluginType && c.instanceId === instanceId && c.panelId === panelId,
		);
		if (!contrib) {
			return this._err(
				'NOT_FOUND',
				`Plugin UI panel '${pluginType}:${instanceId}/${panelId}' not found or plugin not started`,
			);
		}

		// Compute (or fetch cached) content hash from artifacts on disk (per D3/D6: authoritative path).
		let hash;
		try {
			hash = await this.ioPlugins.computeAdminUiBundleHash({ type: pluginType, panelId });
		} catch (e) {
			if (e?.code === 'NOT_FOUND') {
				return this._err('NOT_FOUND', `Bundle files not found for '${pluginType}:${instanceId}/${panelId}'`);
			}
			this.adapter?.log?.error?.(
				`AdminTab: hash computation failed for '${pluginType}:${instanceId}/${panelId}': ${e?.message || e}`,
			);
			return this._err('INTERNAL', 'Bundle hash computation failed');
		}

		const cacheKey = `${pluginType}:${instanceId}:${panelId}:${hash}:${lang}`;
		if (this._bundleCache.has(cacheKey)) {
			return this._ok(this._bundleCache.get(cacheKey));
		}

		let bundle;
		try {
			bundle = await this.ioPlugins.readAdminUiBundle({ type: pluginType, instanceId, panelId, lang });
		} catch (e) {
			if (e?.code === 'NOT_FOUND') {
				return this._err('NOT_FOUND', `Bundle file not found for '${pluginType}:${instanceId}/${panelId}'`);
			}
			if (e?.code === 'FORBIDDEN') {
				return this._err(
					'FORBIDDEN',
					`Bundle entry path is not allowed for '${pluginType}:${instanceId}/${panelId}'`,
				);
			}
			this.adapter?.log?.error?.(
				`AdminTab: bundle read failed for '${pluginType}:${instanceId}/${panelId}': ${e?.message || e}`,
			);
			return this._err('INTERNAL', 'Bundle read failed');
		}

		const JS_LIMIT = 512 * 1024;
		const CSS_LIMIT = 64 * 1024;
		if (Buffer.byteLength(bundle.js, 'utf8') > JS_LIMIT) {
			return this._err('INTERNAL', `Bundle JS exceeds ${JS_LIMIT} byte limit`);
		}
		if (bundle.css != null && Buffer.byteLength(bundle.css, 'utf8') > CSS_LIMIT) {
			return this._err('INTERNAL', `Bundle CSS exceeds ${CSS_LIMIT} byte limit`);
		}

		const data = {
			apiVersion: contrib.apiVersion,
			moduleFormat: 'esm',
			hash,
			js: bundle.js,
			...(bundle.css != null ? { css: bundle.css } : {}),
			i18n: bundle.i18n ?? null,
		};
		this._bundleCache.set(cacheKey, data);
		return this._ok(data);
	}

	/**
	 * Handle `admin.pluginUi.rpc`.
	 *
	 * Dispatches an RPC call to the plugin's `handleAdminUiRpc` method.
	 * Identity is host-bound: the bundle cannot override pluginType, instanceId, or panelId.
	 * Payload is limited to 64 KB serialized. Timeout: 10 000 ms.
	 *
	 * @param {any} payload RPC payload: `{ pluginType, instanceId?, panelId, command, payload? }`.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} RPC response wrapper.
	 */
	async _pluginUiRpc(payload) {
		if (!this.ioPlugins || typeof this.ioPlugins.getAdminUiContributions !== 'function') {
			return this._pluginsNotReady();
		}

		const pluginType = typeof payload?.pluginType === 'string' ? payload.pluginType.trim() : '';
		const panelId = typeof payload?.panelId === 'string' ? payload.panelId.trim() : '';
		const command = typeof payload?.command === 'string' ? payload.command.trim() : '';
		const instanceId =
			typeof payload?.instanceId === 'number' && Number.isFinite(payload.instanceId)
				? Math.trunc(payload.instanceId)
				: 0;

		if (!pluginType || !panelId || !command) {
			return this._err('BAD_REQUEST', 'pluginType, panelId, and command are required');
		}

		// Validate RPC payload size (64 KB serialized).
		const rpcPayload = payload?.payload ?? null;
		try {
			const serialized = JSON.stringify(rpcPayload);
			if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
				return this._err('BAD_REQUEST', 'RPC payload exceeds 64 KB limit');
			}
		} catch {
			return this._err('BAD_REQUEST', 'RPC payload is not serializable');
		}

		// Validate: plugin is running and panel is declared.
		const contributions = this.ioPlugins.getAdminUiContributions();
		const contrib = contributions.find(
			c => c.pluginType === pluginType && c.instanceId === instanceId && c.panelId === panelId,
		);
		if (!contrib) {
			return this._err(
				'NOT_FOUND',
				`Plugin '${pluginType}:${instanceId}' not started or panel '${panelId}' not found`,
			);
		}

		// Call plugin runtime — identity (pluginType, instanceId, panelId) is host-bound.
		const rpcResult = this.ioPlugins.callPluginRuntime({
			type: pluginType,
			instanceId,
			method: 'handleAdminUiRpc',
			args: [{ panelId, command, payload: rpcPayload }],
		});

		if (rpcResult == null) {
			return this._err('NOT_READY', `Plugin '${pluginType}:${instanceId}' runtime is not available`);
		}

		let result;
		try {
			const timeoutPromise = new Promise((_, reject) =>
				setTimeout(() => reject(Object.assign(new Error('RPC timeout'), { code: 'TIMEOUT' })), 10000),
			);
			result = await Promise.race([rpcResult, timeoutPromise]);
		} catch (e) {
			if (e?.code === 'TIMEOUT') {
				return this._err('TIMEOUT', 'RPC call timed out');
			}
			this.adapter?.log?.error?.(
				`AdminTab: RPC error for '${pluginType}:${instanceId}/${panelId}/${command}': ${e?.message || e}`,
			);
			return this._err('INTERNAL', 'RPC call failed');
		}

		// Plugin is responsible for returning { ok, data } or { ok: false, error: { code, message } }.
		if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
			return result;
		}

		return this._err('INTERNAL', 'Plugin RPC returned unexpected response format');
	}

	/**
	 * Normalize raw options into jsonCustom-compatible select options.
	 *
	 * jsonCustom `selectSendTo` treats empty arrays as "offline"; keep non-empty options as-is.
	 *
	 * @param {Array<{value?: unknown, label?: unknown}>|unknown} items Candidate options.
	 * @returns {Array<{value: string, label: string}>} Sanitized option list.
	 */
	_ensureOptionsArray(items) {
		const list = Array.isArray(items) ? items : [];
		const next = [];
		for (const it of list) {
			const value = typeof it?.value === 'string' ? it.value : '';
			const label = typeof it?.label === 'string' ? it.label : '';
			if (!value) {
				continue;
			}
			next.push({ value, label });
		}
		return next;
	}

	/**
	 * Generic IngestStates command pass-through for `admin.ingestStates.presets.selectOptions*`.
	 *
	 * Passes the command suffix and raw payload to IngestStates without interpretation.
	 * IngestStates owns all IngestStates-specific command and payload interpretation.
	 *
	 * @param {string} cmd Full command id.
	 * @param {any} payload Optional payload.
	 * @returns {Promise<Array<{value: string, label: string}>>} Select options array.
	 */
	async _ingestStatesPassThrough(cmd, payload) {
		const baseCmd = 'admin.ingestStates.presets.selectOptions';
		const rawCmd = typeof cmd === 'string' ? cmd.trim() : '';
		if (!rawCmd.startsWith(baseCmd)) {
			return this._ensureOptionsArray([]);
		}

		// Pass suffix and raw payload verbatim — IngestStates interprets both.
		const suffix = rawCmd.slice(baseCmd.length);
		const raw =
			this.ioPlugins?.callPluginRuntime?.({
				type: 'IngestStates',
				instanceId: 0,
				method: 'getPresetSelectOptions',
				args: [{ suffix, payload }],
			}) ?? null;

		if (raw === null) {
			return this._ensureOptionsArray([]);
		}

		return this._ensureOptionsArray(await Promise.resolve(raw));
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
			const itemsRaw = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
			const items = itemsRaw.map(item => {
				if (!item || typeof item !== 'object') {
					return item;
				}
				try {
					return JSON.parse(serializeWithMaps(item));
				} catch {
					return item;
				}
			});
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
	 * Handle `admin.messages.delete`.
	 *
	 * Performs a soft delete via `MsgStore.removeMessage(ref)` for each ref.
	 *
	 * @param {any} payload Delete payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Delete response wrapper.
	 */
	async _messagesDelete(payload) {
		const store = this.msgStore;
		if (!store || typeof store.removeMessage !== 'function') {
			return this._err('NOT_READY', 'Store runtime not ready');
		}

		const safe = payload && typeof payload === 'object' ? payload : {};
		const refsRaw = Array.isArray(safe.refs) ? safe.refs : [];
		const refs = refsRaw
			.filter(r => typeof r === 'string')
			.map(r => r.trim())
			.filter(Boolean);
		const uniqueRefs = Array.from(new Set(refs));

		if (uniqueRefs.length === 0) {
			return this._err('BAD_REQUEST', 'Missing refs');
		}
		if (uniqueRefs.length > 5000) {
			return this._err('BAD_REQUEST', `Too many refs (${uniqueRefs.length})`);
		}

		let deleted = 0;
		const missing = [];
		for (const ref of uniqueRefs) {
			try {
				const ok = store.removeMessage(ref, { actor: 'AdminTab' });
				if (ok) {
					deleted += 1;
				} else {
					missing.push(ref);
				}
			} catch {
				missing.push(ref);
			}
		}

		return this._ok({ requested: uniqueRefs.length, deleted, missing });
	}

	/**
	 * Handle `admin.messages.action`.
	 *
	 * Executes one action by id on the given message ref via `MsgAction.execute()`.
	 * Only the action id is provided by the caller; the action type is resolved from
	 * the stored message's `actions[]` whitelist (as per MsgAction contract).
	 *
	 * @param {any} payload Action payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Action response wrapper.
	 */
	async _messagesExecuteAction(payload) {
		const ref = typeof payload?.ref === 'string' ? payload.ref.trim() : '';
		const actionId = typeof payload?.actionId === 'string' ? payload.actionId.trim() : '';
		if (!ref || !actionId) {
			return this._err('BAD_REQUEST', 'ref and actionId are required');
		}
		const msgActions = this.msgStore?.msgActions;
		if (!msgActions || typeof msgActions.execute !== 'function') {
			return this._err('NOT_READY', 'Action executor not available');
		}
		const ok = msgActions.execute({ ref, actionId, actor: 'AdminTab' });
		return ok ? this._ok({ executed: true }) : this._err('REJECTED', 'Action rejected or not found');
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
		const notfication =
			msgConstants.notfication && typeof msgConstants.notfication === 'object' ? msgConstants.notfication : {};

		return this._ok({
			kind,
			lifecycle: lifecycle?.state && typeof lifecycle.state === 'object' ? { state: lifecycle.state } : {},
			level,
			notfication:
				notfication?.events && typeof notfication.events === 'object' ? { events: notfication.events } : {},
		});
	}

	/**
	 * Main entry point for `main.js` to handle adminTab sendTo commands.
	 *
	 * @param {string} cmd Command name (e.g. `admin.plugins.getCatalog`).
	 * @param {any} payload Command payload.
	 * @returns {Promise<{ ok?: boolean, data?: any, error?: any, native?: any } | Array<{value: string, label: string}>>}
	 *   Response wrapper for the Admin tab, or select options array for `admin.ingestStates.presets.selectOptions*`.
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
		if (c === 'admin.pluginUi.discover') {
			return await this._pluginUiDiscover(payload);
		}
		if (c === 'admin.pluginUi.bundle.get') {
			return await this._pluginUiBundleGet(payload);
		}
		if (c === 'admin.pluginUi.rpc') {
			return await this._pluginUiRpc(payload);
		}
		if (c === 'admin.stats.get') {
			return await this._statsGet(payload);
		}
		if (c === 'admin.messages.query') {
			return await this._messagesQuery(payload);
		}
		if (c === 'admin.messages.delete') {
			return await this._messagesDelete(payload);
		}
		if (c === 'admin.messages.action') {
			return await this._messagesExecuteAction(payload);
		}
		if (c === 'admin.constants.get') {
			return await this._constantsGet();
		}
		if (c.startsWith('admin.ingestStates.presets.selectOptions')) {
			return await this._ingestStatesPassThrough(c, payload);
		}

		if (c === 'admin.ping') {
			return { ok: true, data: 'pong' };
		}

		return this._err('UNKNOWN_COMMAND', `Unknown admin command '${c}'`);
	}
}

module.exports = { IoAdminTab };
