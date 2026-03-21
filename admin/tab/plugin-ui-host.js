/* global window, document, lang, t */
'use strict';

/**
 * MsgHub Admin Tab: Plugin Admin UI Host.
 *
 * Loads, caches, and mounts plugin ESM bundles into Light DOM containers
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
 * and Light DOM mounting for plugin panel tabs.
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
		// msghubRequest resolves with res.data directly — bundleData is the payload, not an {ok,data} envelope.
		const bundleData = await request('admin.pluginUi.bundle.get', { pluginType, instanceId, panelId });
		if (!bundleData?.js) {
			throw new Error('bundle.get returned no JS content');
		}
		const { hash: responseHash, js, css = null } = bundleData;

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
	 * Renders an isolated error state into the given target element.
	 * Called with the mount wrapper on module.mount() failure, or with the
	 * container directly when bundle fetch/import fails before a mount wrapper exists.
	 *
	 * @param {Element} target - Element to render the error into.
	 * @param {string} [message] - Human-readable error text; defaults to a generic failure message.
	 */
	function renderErrorState(target, message) {
		const el = document.createElement('div');
		el.setAttribute('class', 'msghub-plugin-panel-error');
		el.setAttribute('role', 'alert');
		el.textContent = message || t('msghub.i18n.core.admin.ui.pluginPanel.loadError.text');
		target.replaceChildren(el);
	}

	/**
	 * Builds the bundle context object passed to module.mount().
	 * ctx.root is the mount wrapper div — the plugin's rendering target and CSS scope root.
	 * AdminTab base CSS (admin/tab.css, admin/tab/*.css) is available in Light DOM naturally.
	 *
	 * @param {{ root: Element, pluginType: string, instanceId: string, panelId: string }} params - Mount target and plugin identity.
	 * @returns {object} Frozen bundle context passed to module.mount().
	 */
	function buildCtx({ root, pluginType, instanceId, panelId }) {
		return Object.freeze({
			root,
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
				 * Returns a normalized { ok, data } / { ok, error } envelope to the bundle,
				 * insulating it from the msghubRequest transport (which resolves with res.data directly).
				 *
				 * @param {string} command - Panel-scoped RPC command name.
				 * @param {any} [payload] - Optional command payload.
				 * @returns {Promise<{ ok: boolean, data?: any, error?: object }>} Normalized response envelope.
				 */
				request(command, payload) {
					return request('admin.pluginUi.rpc', {
						pluginType,
						instanceId,
						panelId,
						command,
						payload,
					}).then(
						data => ({ ok: true, data }),
						err => ({ ok: false, error: { message: err?.message || String(err) } }),
					);
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
	 * Mounts a plugin ESM bundle into a Light DOM wrapper inside the given container.
	 * Creates a scoped mount wrapper div (ctx.root), injects companion CSS as a <style>
	 * tag inside the wrapper, then calls module.mount(ctx).
	 *
	 * @param {{ container: Element, pluginType: string, instanceId: string, panelId: string, hash?: string }} opts
	 *   hash: known bundle hash (from discover/registry); used for cache fast-path.
	 * @returns {Promise<object>} Handle for unmount/retry.
	 */
	async function mount({ container, pluginType, instanceId, panelId, hash = '' }) {
		// Handle tracks mount state; _module/_ctx are set on success.
		const handle = {
			_container: container,
			_pluginType: pluginType,
			_instanceId: instanceId,
			_panelId: panelId,
			_mounted: false,
		};

		try {
			const { module, css } = await loadBundle(pluginType, instanceId, panelId, hash);

			// Create the Light DOM mount wrapper — this is ctx.root and the CSS scope root.
			// Plugin companion CSS scopes to .msghub-plugin-ui-mount[data-plugin-type=...][data-panel-id=...].
			const mountWrapper = document.createElement('div');
			mountWrapper.setAttribute('class', 'msghub-plugin-ui-mount');
			mountWrapper.setAttribute('data-plugin-type', pluginType);
			mountWrapper.setAttribute('data-plugin-instance-id', instanceId);
			mountWrapper.setAttribute('data-panel-id', panelId);
			container.appendChild(mountWrapper);

			if (css) {
				// Inject companion CSS as a <style> tag inside the mount wrapper so it is
				// automatically removed when the wrapper is cleared on unmount/retry.
				const styleEl = document.createElement('style');
				styleEl.textContent = css;
				mountWrapper.appendChild(styleEl);
			}

			const ctx = buildCtx({ root: mountWrapper, pluginType, instanceId, panelId });
			try {
				await module.mount(ctx);
				handle._mounted = true;
				handle._module = module;
				handle._ctx = ctx;
			} catch {
				// module.mount() threw — render error inside the mount wrapper.
				renderErrorState(mountWrapper, t('msghub.i18n.core.admin.ui.pluginPanel.mountError.text'));
			}
		} catch {
			// Bundle fetch or import failed — no mount wrapper exists yet; render error in container.
			renderErrorState(container, t('msghub.i18n.core.admin.ui.pluginPanel.loadError.text'));
		}

		return handle;
	}

	/**
	 * Unmounts a previously mounted plugin panel.
	 * Calls module.unmount() if exported, then clears the container,
	 * removing the mount wrapper and all plugin-owned DOM.
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
		if (handle._container) {
			handle._container.replaceChildren();
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
