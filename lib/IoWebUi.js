/**
 * IoWebUi
 * =======
 * Adapter-side web-safe runtime command facade for MsgHub.
 *
 * Docs: ../docs/io/IoWebUi.md
 *
 * Responsibilities
 * - Handle web-safe runtime commands (`web.*`) and map them to runtime services.
 * - Normalize payloads and shape responses (DTOs) for web-host consumers.
 *
 * Non-responsibilities
 * - Admin-only command handling (`admin.*`) -> owned by `IoAdminTab`.
 * - Config command handling (`config.*`) -> owned by `IoAdminConfig`.
 * - WebExtension mount/routing/asset serving -> future `IoWebExtension`.
 */

'use strict';

const { isObject, serializeWithMaps } = require(`${__dirname}/../src/MsgUtils`);
const { IoUiCatalog } = require('./IoUiCatalog');
const { IoPluginUiRpc } = require('./IoPluginUiRpc');

/**
 * Adapter-side web-safe runtime command facade for MsgHub.
 */
class IoWebUi {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} adapter
	 *   ioBroker adapter instance (used for logging and namespace).
	 * @param {object} [options] Optional runtime services.
	 * @param {any} [options.msgStore] Optional MsgStore instance for diagnostics.
	 * @param {import('./IoPlugins').IoPlugins|null} [options.ioPlugins] Optional plugin runtime manager.
	 * @param {IoPluginUiRpc|null} [options.pluginUiRpc] Optional shared plugin UI RPC dispatcher.
	 * @param {IoUiCatalog|null} [options.uiCatalog] Optional shared UI catalog for `web.view.get`.
	 * @param {import('./IoAdminCapabilities').IoAdminCapabilities|null} [options.adminCapabilities]
	 *   Optional shared capability authority for canonical payload-token validation.
	 */
	constructor(
		adapter,
		{ msgStore = null, ioPlugins = null, pluginUiRpc = null, uiCatalog = null, adminCapabilities = null } = {},
	) {
		if (!adapter?.namespace) {
			throw new Error('IoWebUi: adapter is required');
		}
		this.adapter = adapter;
		this.msgStore = msgStore && typeof msgStore === 'object' ? msgStore : null;
		this.ioPlugins = ioPlugins && typeof ioPlugins === 'object' ? ioPlugins : null;
		this.adminCapabilities = adminCapabilities && typeof adminCapabilities === 'object' ? adminCapabilities : null;
		this.pluginUiRpc =
			pluginUiRpc && typeof pluginUiRpc === 'object' ? pluginUiRpc : new IoPluginUiRpc(adapter, this.ioPlugins);
		this.uiCatalog = uiCatalog && typeof uiCatalog === 'object' ? uiCatalog : new IoUiCatalog();
		this._bundleCache = new Map();
	}

	/**
	 * Wrap a successful response payload for the web UI.
	 *
	 * @param {any} data Response payload.
	 * @returns {{ ok: true, data: any }} Ok response wrapper.
	 */
	_ok(data) {
		return { ok: true, data: data || {} };
	}

	/**
	 * Wrap an error response for the web UI.
	 *
	 * @param {string} code Error code.
	 * @param {string} message Error message.
	 * @returns {{ ok: false, error: { code: string, message: string } }} Error response wrapper.
	 */
	_err(code, message) {
		return { ok: false, error: { code: String(code || 'ERROR'), message: String(message || 'Error') } };
	}

	/**
	 * Validate the canonical `payload.token` for `web.*` and strip it before
	 * the business payload reaches web command handlers.
	 *
	 * @param {any} payload Raw command payload.
	 * @returns {{ ok: true, payload: Record<string, any> } | { ok: false, error: { code: string, message: string } }}
	 *   Either the cleaned payload or a structured backend error.
	 */
	_getAuthorizedPayload(payload) {
		if (!this.adminCapabilities || typeof this.adminCapabilities.consumePayloadToken !== 'function') {
			return this._err('NOT_READY', 'Admin capability authority not ready');
		}
		try {
			return {
				ok: true,
				payload: this.adminCapabilities.consumePayloadToken({
					host: 'admin',
					capability: 'web',
					payload,
				}),
			};
		} catch (e) {
			return this._err('FORBIDDEN', String(e?.message || e));
		}
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
	 * Handle `web.stats.get`.
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
	 * Handle `web.messages.query`.
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
	 * Handle `web.messages.action`.
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
		const ok = msgActions.execute({ ref, actionId, actor: 'WebUi' });
		return ok ? this._ok({ executed: true }) : this._err('REJECTED', 'Action rejected or not found');
	}

	/**
	 * Handle `web.constants.get`.
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
	 * Handle `web.pluginUi.discover`.
	 *
	 * Returns all plugin UI panel contributions with computed content hashes.
	 * Hash computation is parallel and best-effort: if hash computation fails for a panel,
	 * the contribution is still returned with `bundle.hash: ''` and a warn is logged.
	 * `bundle.get` is the authoritative hash source; discover hash is informational only.
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
						`WebUi: failed to compute hash for '${c.pluginType}/${c.panelId}': ${e?.message || e}`,
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
						`WebUi: failed to read Admin UI i18n for '${pluginType}': ${e?.message || e}`,
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
	 * Handle `web.pluginUi.bundle.get`.
	 *
	 * Fetches the ESM bundle (and optional CSS and i18n) for a plugin UI panel.
	 * Bundles are cached in-memory keyed by (pluginType, instanceId, panelId, hash, lang).
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
		const rawLang = typeof payload?.lang === 'string' ? payload.lang.trim().toLowerCase() : '';
		const lang = /^[a-z]{2}(-[a-z]{2,4})?$/.test(rawLang) ? rawLang : 'en';

		if (!pluginType || !panelId) {
			return this._err('BAD_REQUEST', 'pluginType and panelId are required');
		}

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

		let hash;
		try {
			hash = await this.ioPlugins.computeAdminUiBundleHash({ type: pluginType, panelId });
		} catch (e) {
			if (e?.code === 'NOT_FOUND') {
				return this._err('NOT_FOUND', `Bundle files not found for '${pluginType}:${instanceId}/${panelId}'`);
			}
			this.adapter?.log?.error?.(
				`WebUi: hash computation failed for '${pluginType}:${instanceId}/${panelId}': ${e?.message || e}`,
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
				`WebUi: bundle read failed for '${pluginType}:${instanceId}/${panelId}': ${e?.message || e}`,
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
	 * Handle `web.pluginUi.rpc`.
	 *
	 * @param {any} payload RPC payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} RPC response wrapper.
	 */
	async _pluginUiRpc(payload) {
		return await this.pluginUiRpc.handleWebRpc(payload);
	}

	/**
	 * Handle `web.view.get`.
	 *
	 * @param {any} payload View request payload (`{ mode, targetId? }`).
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} View response wrapper.
	 */
	async _viewGet(payload) {
		if (!this.uiCatalog || typeof this.uiCatalog.getView !== 'function') {
			return this._err('NOT_READY', 'UI catalog not ready');
		}
		try {
			return this._ok(this.uiCatalog.getView(payload));
		} catch (e) {
			const code = typeof e?.code === 'string' ? e.code : 'INTERNAL';
			return this._err(code, String(e?.message || e));
		}
	}

	/**
	 * Main entry point for `main.js` or future web-host adapters to handle web-safe commands.
	 *
	 * @param {string} cmd Command name.
	 * @param {any} payload Command payload.
	 * @returns {Promise<{ ok?: boolean, data?: any, error?: any }>}
	 *   Response wrapper for the web UI facade.
	 */
	async handleCommand(cmd, payload) {
		const c = typeof cmd === 'string' ? cmd.trim() : '';
		if (!c) {
			return this._err('BAD_REQUEST', 'Missing command');
		}
		const authorized = this._getAuthorizedPayload(payload);
		if (authorized.ok !== true) {
			return authorized;
		}
		const cleanPayload = authorized.payload;

		if (c === 'web.stats.get') {
			return await this._statsGet(cleanPayload);
		}
		if (c === 'web.messages.query') {
			return await this._messagesQuery(cleanPayload);
		}
		if (c === 'web.messages.action') {
			return await this._messagesExecuteAction(cleanPayload);
		}
		if (c === 'web.constants.get') {
			return await this._constantsGet();
		}
		if (c === 'web.view.get') {
			return await this._viewGet(cleanPayload);
		}
		if (c === 'web.pluginUi.discover') {
			return await this._pluginUiDiscover(cleanPayload);
		}
		if (c === 'web.pluginUi.bundle.get') {
			return await this._pluginUiBundleGet(cleanPayload);
		}
		if (c === 'web.pluginUi.rpc') {
			return await this._pluginUiRpc(cleanPayload);
		}
		if (c === 'web.ping') {
			return { ok: true, data: 'pong' };
		}

		return this._err('UNKNOWN_COMMAND', `Unknown web command '${c}'`);
	}
}

module.exports = { IoWebUi };
