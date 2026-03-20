/* global window, document, lang */
'use strict';

/**
 * MsgHub Admin Tab: Plugin Admin UI Host.
 *
 * Loads, caches, and mounts plugin ESM bundles into Shadow DOM containers
 * within plugin panel tab content areas.
 *
 * Integration:
 * - Exposed as window.createMsghubPluginUiHost; instantiated by boot.js.
 * - Receives { request, api } from boot.js context.
 *
 * Interface:
 * - Returns { mount, unmount, retry }.
 */

/**
 * Creates a plugin UI host that manages bundle loading, caching,
 * and Shadow DOM mounting for plugin panel tabs.
 *
 * @param {{ request: Function, api: object, _importFn?: Function }} opts
 *   _importFn: optional test seam — receives JS source string, returns module.
 *   In production, bundles are imported via Blob URL (native dynamic import).
 * @returns {{ mount: Function, unmount: Function, retry: Function }} Host interface.
 */
function createMsghubPluginUiHost({ request, api, _importFn = undefined }) {
	// Cache keyed by "pluginType:instanceId:panelId:hash" → { module, css }
	const bundleCache = new Map();

	/**
	 * Imports a JS module from source.
	 * Uses _importFn (test seam) if provided; otherwise creates a Blob URL,
	 * imports it via dynamic import, and revokes the URL immediately.
	 *
	 * @param {string} js - Module source code.
	 * @returns {Promise<object>} Imported module.
	 */
	async function importFromSource(js) {
		if (_importFn != null) {
			return _importFn(js);
		}
		const blob = new Blob([js], { type: 'text/javascript' });
		const blobUrl = URL.createObjectURL(blob);
		try {
			return await import(blobUrl);
		} finally {
			URL.revokeObjectURL(blobUrl);
		}
	}

	/**
	 * Fetches and caches a plugin bundle.
	 * Cache is keyed by (pluginType, instanceId, panelId, hash).
	 * If a matching cache entry exists (by hash), bundle.get is skipped entirely.
	 *
	 * @param {string} pluginType - Plugin type identifier (e.g. 'IngestStates').
	 * @param {string} instanceId - Plugin instance id (e.g. '0').
	 * @param {string} panelId - Panel id within the plugin's adminUi declaration.
	 * @param {string} [hash] - Known hash from discover/registry; used for cache lookup.
	 * @returns {Promise<{ module: object, css: string|null, hash: string }>} Cached or freshly loaded bundle entry.
	 */
	async function loadBundle(pluginType, instanceId, panelId, hash) {
		// Fast path: known hash already in cache — skip bundle.get entirely.
		if (hash) {
			const cachedKey = `${pluginType}:${instanceId}:${panelId}:${hash}`;
			if (bundleCache.has(cachedKey)) {
				return bundleCache.get(cachedKey);
			}
		}

		// Fetch bundle metadata and source from backend.
		const result = await request('admin.pluginUi.bundle.get', { pluginType, instanceId, panelId });
		if (!result?.ok || !result.data) {
			throw new Error(result?.error?.message || 'bundle.get failed');
		}
		const { hash: responseHash, js, css = null } = result.data;

		// Check cache again using the authoritative hash from the response.
		const cacheKey = `${pluginType}:${instanceId}:${panelId}:${responseHash}`;
		if (bundleCache.has(cacheKey)) {
			return bundleCache.get(cacheKey);
		}

		const module = await importFromSource(js);
		const entry = { module, css, hash: responseHash };
		bundleCache.set(cacheKey, entry);
		return entry;
	}

	/**
	 * Renders an isolated error state.
	 * Targets the shadow root if one is attached to the container (so the error
	 * is visible even when shadow DOM is active); falls back to light DOM.
	 *
	 * @param {Element} container - The plugin panel host element.
	 * @param {string} [message] - Human-readable error text; defaults to a generic failure message.
	 */
	function renderErrorState(container, message) {
		const target = container.shadowRoot || container;
		const el = document.createElement('div');
		el.setAttribute('class', 'msghub-plugin-panel-error');
		el.setAttribute('role', 'alert');
		el.textContent = message || 'Failed to load plugin panel.';
		target.replaceChildren(el);
	}

	/**
	 * Builds the bundle context object passed to module.mount().
	 *
	 * @param {{ root: Element, shadowRoot: ShadowRoot, pluginType: string, instanceId: string, panelId: string }} params - Mount targets and plugin identity.
	 * @returns {object} Frozen bundle context passed to module.mount().
	 */
	function buildCtx({ root, shadowRoot, pluginType, instanceId, panelId }) {
		return Object.freeze({
			root,
			shadowRoot,
			plugin: Object.freeze({ type: pluginType, instanceId }),
			panel: Object.freeze({ id: panelId }),
			host: Object.freeze({
				apiVersion: '1',
				adapterInstance: api?.host?.adapterInstance || '',
				uiTextLanguage: lang,
			}),
			api: Object.freeze({
				/**
				 * Sends an RPC command to the plugin panel backend.
				 *
				 * @param {string} command - Panel-scoped RPC command name.
				 * @param {any} [payload] - Optional command payload.
				 * @returns {Promise<{ ok: boolean, data?: any, error?: object }>} Backend response envelope.
				 */
				request(command, payload) {
					return request('admin.pluginUi.rpc', {
						pluginType,
						instanceId,
						panelId,
						command,
						payload,
					});
				},
				i18n: Object.freeze({ t: key => (api?.i18n?.t ? api.i18n.t(key) : key) }),
				ui: Object.freeze({
					toast: (message, opts) => api?.ui?.toast?.(message, opts),
					dialog: Object.freeze({
						confirm: (message, opts) => api?.ui?.dialog?.confirm?.(message, opts),
					}),
					overlayLarge: Object.freeze({
						open: (content, opts) => api?.ui?.overlayLarge?.open?.(content, opts),
						close: () => api?.ui?.overlayLarge?.close?.(),
					}),
				}),
			}),
		});
	}

	/**
	 * Mounts a plugin ESM bundle into a Shadow DOM inside the given container.
	 * If the container already has a shadow root (from a previous mount), it is
	 * reused and cleared rather than recreated.
	 *
	 * @param {{ container: Element, pluginType: string, instanceId: string, panelId: string, hash?: string }} opts
	 *   hash: known bundle hash (from discover/registry); used for cache fast-path.
	 * @returns {Promise<object>} Handle for unmount/retry.
	 */
	async function mount({ container, pluginType, instanceId, panelId, hash = '' }) {
		// Handle tracks mount state; _module/_ctx/_shadowRoot are set on success.
		const handle = {
			_container: container,
			_pluginType: pluginType,
			_instanceId: instanceId,
			_panelId: panelId,
			_mounted: false,
		};

		try {
			const { module, css } = await loadBundle(pluginType, instanceId, panelId, hash);

			// Reuse an existing shadow root (open mode) rather than calling attachShadow
			// again — re-attaching fails when a shadow root already exists on the container.
			const shadowRoot = container.shadowRoot || container.attachShadow({ mode: 'open' });
			shadowRoot.replaceChildren();

			if (css) {
				const styleEl = document.createElement('style');
				styleEl.textContent = css;
				shadowRoot.appendChild(styleEl);
			}

			const root = document.createElement('div');
			root.setAttribute('class', 'msghub-plugin-panel-root');
			shadowRoot.appendChild(root);

			const ctx = buildCtx({ root, shadowRoot, pluginType, instanceId, panelId });
			try {
				await module.mount(ctx);
				handle._mounted = true;
				handle._module = module;
				handle._ctx = ctx;
				handle._shadowRoot = shadowRoot;
			} catch {
				// module.mount() threw — render error inside shadow DOM so it is visible.
				renderErrorState(container, 'Plugin panel failed to mount.');
			}
		} catch {
			// Bundle fetch or import failed — render error (shadow root may not exist yet).
			renderErrorState(container, 'Failed to load plugin panel.');
		}

		return handle;
	}

	/**
	 * Unmounts a previously mounted plugin panel.
	 * Calls module.unmount() if exported, then clears the shadow root content.
	 *
	 * @param {object} handle - Handle returned by mount().
	 * @returns {Promise<void>}
	 */
	async function unmount(handle) {
		if (!handle) {
			return;
		}
		if (handle._mounted && handle._module?.unmount) {
			try {
				await handle._module.unmount(handle._ctx);
			} catch {
				// Ignore unmount errors — the panel may already be in a broken state.
			}
		}
		if (handle._shadowRoot) {
			handle._shadowRoot.replaceChildren();
		}
		handle._mounted = false;
		handle._module = null;
		handle._ctx = null;
	}

	/**
	 * Retries a failed (or previously mounted) panel.
	 * Clears all cache entries for this panel so the bundle is re-fetched,
	 * then unmounts and re-mounts without a hash hint (forces bundle.get call).
	 *
	 * @param {object} handle - Handle returned by mount().
	 * @returns {Promise<object>} New handle for the retried mount.
	 */
	async function retry(handle) {
		if (!handle) {
			return null;
		}
		// Clear all cache entries for this (pluginType, instanceId, panelId).
		const keyPrefix = `${handle._pluginType}:${handle._instanceId}:${handle._panelId}:`;
		for (const key of bundleCache.keys()) {
			if (key.startsWith(keyPrefix)) {
				bundleCache.delete(key);
			}
		}
		await unmount(handle);
		// No hash: forces bundle.get to be called on the next mount.
		return mount({
			container: handle._container,
			pluginType: handle._pluginType,
			instanceId: handle._instanceId,
			panelId: handle._panelId,
		});
	}

	return { mount, unmount, retry };
}

window.createMsghubPluginUiHost = createMsghubPluginUiHost;
