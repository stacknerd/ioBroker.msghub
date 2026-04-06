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

/**
 * Adapter-side web-safe runtime command facade for MsgHub.
 */
class IoWebUi {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} adapter
	 *   ioBroker adapter instance (used for logging and namespace).
	 * @param {object} [options] Optional runtime services.
	 * @param {any} [options.msgStore] Optional MsgStore instance for diagnostics.
	 */
	constructor(adapter, { msgStore = null } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoWebUi: adapter is required');
		}
		this.adapter = adapter;
		this.msgStore = msgStore && typeof msgStore === 'object' ? msgStore : null;
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

		if (c === 'web.stats.get') {
			return await this._statsGet(payload);
		}
		if (c === 'web.messages.query') {
			return await this._messagesQuery(payload);
		}
		if (c === 'web.messages.action') {
			return await this._messagesExecuteAction(payload);
		}
		if (c === 'web.constants.get') {
			return await this._constantsGet();
		}
		if (c === 'web.ping') {
			return { ok: true, data: 'pong' };
		}

		return this._err('UNKNOWN_COMMAND', `Unknown web command '${c}'`);
	}
}

module.exports = { IoWebUi };
