/// <reference lib="dom" />
/* global window */
(function () {
	'use strict';

	const win = window;

	/**
	 * Plugins data access module.
	 *
	 * Contains:
	 * - MsgConstants cache loader.
	 * - Plugin readme fetch and cache.
	 * - Thin wrappers for all ctx.api.plugins CRUD operations.
	 *
	 * Integration:
	 * - Uses shared state from `state.js`.
	 * - Consumed by `index.js` via the pluginsDataApi instance.
	 * - Loaded before `index.js` (registry load order).
	 *
	 * Public API:
	 * - `createPluginsDataApi(options)`
	 */

	/**
	 * Creates the plugins data facade for one panel instance.
	 *
	 * @param {object} options - Factory options.
	 * @param {object} options.state - Shared mutable plugins state (from state.js).
	 * @param {object} options.constantsApi - ctx.api.constants.
	 * @param {object} options.pluginsApi - ctx.api.plugins.
	 * @returns {object} Frozen plugins data facade.
	 */
	function createPluginsDataApi(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const state = opts.state;
		const constantsApi = opts.constantsApi;
		const pluginsApi = opts.pluginsApi;

		/**
		 * Loads and caches MsgConstants. Returns null if unavailable.
		 *
		 * @returns {Promise<object|null>} Resolved constants or null.
		 */
		async function ensureConstantsLoaded() {
			if (state.cachedConstants) {
				return state.cachedConstants;
			}
			try {
				if (!constantsApi?.get) {
					throw new Error('Constants API is not available');
				}
				state.cachedConstants = await constantsApi.get();
			} catch {
				state.cachedConstants = null;
			}
			return state.cachedConstants;
		}

		/**
		 * Fetches and caches plugin readme metadata from plugin-readmes.json.
		 *
		 * @returns {Promise<Map>} Resolved readme map keyed by plugin type.
		 */
		async function ensurePluginReadmesLoaded() {
			if (state.pluginReadmesLoadPromise) {
				return state.pluginReadmesLoadPromise;
			}
			state.pluginReadmesLoadPromise = (async () => {
				try {
					const res = await fetch('plugin-readmes.json', { cache: 'no-store' });
					if (!res?.ok) {
						return state.pluginReadmesByType;
					}
					const data = await res.json();
					if (!data || typeof data !== 'object') {
						return state.pluginReadmesByType;
					}
					const map = new Map();
					for (const [k, v] of Object.entries(data)) {
						if (typeof k !== 'string' || !k.trim()) {
							continue;
						}
						if (!v || typeof v !== 'object') {
							continue;
						}
						const md = typeof v.md === 'string' ? v.md : '';
						const source = typeof v.source === 'string' ? v.source : '';
						if (!md.trim()) {
							continue;
						}
						map.set(k.trim(), { md, source });
					}
					state.pluginReadmesByType = map;
					return state.pluginReadmesByType;
				} catch {
					return state.pluginReadmesByType;
				}
			})();
			return state.pluginReadmesLoadPromise;
		}

		/**
		 * Fetches the plugin catalog from the backend.
		 *
		 * @returns {Promise<object>} Catalog response.
		 */
		async function getCatalog() {
			if (!pluginsApi?.getCatalog) {
				throw new Error('Plugins API is not available');
			}
			return pluginsApi.getCatalog();
		}

		/**
		 * Lists all current plugin instances from the backend.
		 *
		 * @returns {Promise<object>} Instances response.
		 */
		async function listInstances() {
			if (!pluginsApi?.listInstances) {
				throw new Error('Plugins API is not available');
			}
			return pluginsApi.listInstances();
		}

		/**
		 * Creates a new plugin instance.
		 *
		 * @param {object} params - Params: type, instanceId, native.
		 * @returns {Promise<object>} Created instance response.
		 */
		async function createInstance(params) {
			if (!pluginsApi?.createInstance) {
				throw new Error('Plugins API is not available');
			}
			return pluginsApi.createInstance(params);
		}

		/**
		 * Updates an existing plugin instance's configuration.
		 *
		 * @param {object} params - Params: type, instanceId, native.
		 * @returns {Promise<object>} Updated instance response.
		 */
		async function updateInstance(params) {
			if (!pluginsApi?.updateInstance) {
				throw new Error('Plugins API is not available');
			}
			return pluginsApi.updateInstance(params);
		}

		/**
		 * Enables or disables a plugin instance.
		 *
		 * @param {object} params - Params: type, instanceId, enabled.
		 * @returns {Promise<void>} Completion promise.
		 */
		async function setEnabled(params) {
			if (!pluginsApi?.setEnabled) {
				throw new Error('Plugins API is not available');
			}
			return pluginsApi.setEnabled(params);
		}

		/**
		 * Deletes a plugin instance.
		 *
		 * @param {object} params - Params: type, instanceId.
		 * @returns {Promise<void>} Completion promise.
		 */
		async function deleteInstance(params) {
			if (!pluginsApi?.deleteInstance) {
				throw new Error('Plugins API is not available');
			}
			return pluginsApi.deleteInstance(params);
		}

		return Object.freeze({
			ensureConstantsLoaded,
			ensurePluginReadmesLoaded,
			getCatalog,
			listInstances,
			createInstance,
			updateInstance,
			setEnabled,
			deleteInstance,
		});
	}

	win.MsghubAdminTabPluginsData = Object.freeze({ createPluginsDataApi });
})();
