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
	 * @param {import('./IoPlugins').IoPlugins} ioPlugins
	 *   Plugin runtime manager to delegate admin actions to.
	 * @param {object} [options] Optional runtime services.
	 * @param {import('../src/MsgAi').MsgAi|null} [options.ai] Optional MsgAi instance for diagnostics.
	 */
	constructor(adapter, ioPlugins, { ai = null } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoAdminTab: adapter is required');
		}
		if (!ioPlugins) {
			throw new Error('IoAdminTab: ioPlugins is required');
		}
		this.adapter = adapter;
		this.ioPlugins = ioPlugins;
		this.ai = ai && typeof ai === 'object' ? ai : null;

		// Cache to prevent log spam: instanceKey -> "k1,k2,k3"
		this._unknownNativeKeysCache = new Map();
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
				const allowed = new Set(['enabled']);
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
		const plugins = this.ioPlugins.getCatalog();
		return this._ok({ plugins });
	}

	/**
	 * Handle `admin.plugins.listInstances`.
	 *
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Instances response wrapper.
	 */
	async _pluginsListInstances() {
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
		return this._ok(await this.ioPlugins.createInstance(payload));
	}

	/**
	 * Handle `admin.plugins.deleteInstance`.
	 *
	 * @param {any} payload Delete payload.
	 * @returns {Promise<{ ok: boolean, data?: any, error?: any }>} Delete response wrapper.
	 */
	async _pluginsDeleteInstance(payload) {
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
		await this.ioPlugins.setInstanceEnabled(payload);
		return this._ok({});
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

		return this._err('UNKNOWN_COMMAND', `Unknown admin command '${c}'`);
	}
}

module.exports = { IoAdminTab };
