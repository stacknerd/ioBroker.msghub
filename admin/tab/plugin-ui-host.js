/* global window, document, lang, t, h, mergePluginI18n */
'use strict';

/**
 * MsgHub Admin Tab: Plugin Admin UI Host.
 *
 * Docs: ../../docs/ui/tab-plugin-ui-host.md
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
 * @param {{ request: Function, api: object, onI18nReady?: Function, _importFn?: Function }} opts
 *   _importFn: optional test seam — receives JS source string, returns module.
 *   In production, bundles are imported via Blob URL (native dynamic import).
 * @returns {{ mount: Function, preloadI18n: Function, unmount: Function, retry: Function }} Host interface.
 */
function createMsghubPluginUiHost({ request, api, onI18nReady = undefined, _importFn = undefined }) {
	// Cache keyed by "pluginType:instanceId:panelId:hash:lang:projection" → entry
	const bundleCache = new Map();
	const i18nPreloadCache = new Map();
	const i18nReadyByPanelLang = new Map();

	/**
	 * Resolve one bundle-side plugin UI RPC command to the host-specific backend path.
	 *
	 * @param {string} command - Prefixed bundle command.
	 * @returns {{ ok: true, rpcCommand: string, panelCommand: string } | { ok: false, error: string }} Routing result.
	 */
	function resolvePluginUiRpcCommand(command) {
		const rawCommand = typeof command === 'string' ? command.trim() : '';
		if (!rawCommand) {
			return { ok: false, error: 'Plugin UI RPC command must start with admin. or web.' };
		}
		if (rawCommand.startsWith('admin.')) {
			const panelCommand = rawCommand.slice('admin.'.length).trim();
			return panelCommand
				? { ok: true, rpcCommand: 'admin.pluginUi.rpc', panelCommand }
				: { ok: false, error: 'Plugin UI RPC admin. command must include a panel command.' };
		}
		if (rawCommand.startsWith('web.')) {
			const panelCommand = rawCommand.slice('web.'.length).trim();
			return panelCommand
				? { ok: true, rpcCommand: 'web.pluginUi.rpc', panelCommand }
				: { ok: false, error: 'Plugin UI RPC web. command must include a panel command.' };
		}
		if (rawCommand.startsWith('config.')) {
			return { ok: false, error: 'Plugin UI RPC config. commands are not supported.' };
		}
		return { ok: false, error: 'Plugin UI RPC command must start with admin. or web.' };
	}

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
	 * Fetches and caches one plugin bundle projection.
	 * Cache is keyed by (pluginType, instanceId, panelId, hash, lang, projection).
	 * Lang is part of the key because the i18n payload is language-dependent.
	 * If a matching cache entry exists, bundle.get is skipped entirely.
	 *
	 * @param {string} pluginType - Plugin type identifier (e.g. 'IngestStates').
	 * @param {string} instanceId - Plugin instance id (e.g. '0').
	 * @param {string} panelId - Panel id within the plugin's adminUi declaration.
	 * @param {string} [hash] - Known hash from `web.view.get.pluginPanels[*].ui.bundle.hash`; used for cache lookup.
	 * @param {string} [activeLang] - Active UI language; included in cache key and forwarded to backend.
	 * @param {object} [options] Projection and import options.
	 * @param {string[]|null} [options.include] - Optional bundle parts to include.
	 * @param {string[]|null} [options.exclude] - Optional bundle parts to exclude.
	 * @param {string} [options.projectionKey] - Stable cache-key suffix for the projection.
	 * @param {boolean} [options.expectJs] - Whether JS must be present in the response.
	 * @param {boolean} [options.importJs] - Whether JS should be imported into a module.
	 * @returns {Promise<{ module: object|null, css: string|null, hash: string, i18n: object|null }>}
	 *   Cached or freshly loaded bundle entry.
	 */
	async function loadBundle(
		pluginType,
		instanceId,
		panelId,
		hash,
		activeLang,
		{ include = null, exclude = null, projectionKey = 'all', expectJs = true, importJs = true } = {},
	) {
		// Fast path: known hash already in cache — skip bundle.get entirely.
		if (hash) {
			const cachedKey = `${pluginType}:${instanceId}:${panelId}:${hash}:${activeLang}:${projectionKey}`;
			if (bundleCache.has(cachedKey)) {
				return bundleCache.get(cachedKey);
			}
		}

		// Fetch bundle metadata and source from backend.
		// msghubRequest resolves with res.data directly — bundleData is the payload, not an {ok,data} envelope.
		const bundleData = await request('web.pluginUi.bundle.get', {
			pluginType,
			instanceId,
			panelId,
			lang: activeLang,
			...(Array.isArray(include) && include.length > 0 ? { include } : {}),
			...(Array.isArray(exclude) && exclude.length > 0 ? { exclude } : {}),
		});
		if (expectJs && !bundleData?.js) {
			throw new Error('bundle.get returned no JS content');
		}
		const responseHash = typeof bundleData?.hash === 'string' ? bundleData.hash : String(hash || '');
		const js = typeof bundleData?.js === 'string' ? bundleData.js : '';
		const css = typeof bundleData?.css === 'string' ? bundleData.css : null;
		const i18nPayload = bundleData?.i18n ?? null;

		// Check cache again using the authoritative hash from the response.
		const cacheKey = `${pluginType}:${instanceId}:${panelId}:${responseHash}:${activeLang}:${projectionKey}`;
		if (bundleCache.has(cacheKey)) {
			return bundleCache.get(cacheKey);
		}

		const module = importJs && js ? await importFromSource(js) : null;
		const entry = { module, css, hash: responseHash, i18n: i18nPayload };
		bundleCache.set(cacheKey, entry);
		return entry;
	}

	function getPanelLangKey(pluginType, instanceId, panelId, activeLang) {
		return `${pluginType}:${instanceId}:${panelId}:${activeLang}`;
	}

	function applyPluginI18n(pluginType, instanceId, panelId, activeLang, hash, i18nData) {
		if (!i18nData?.translations) {
			return;
		}
		mergePluginI18n(pluginType, i18nData.translations);
		i18nReadyByPanelLang.set(getPanelLangKey(pluginType, instanceId, panelId, activeLang), String(hash || ''));
		if (typeof onI18nReady === 'function') {
			onI18nReady({
				pluginType,
				instanceId,
				panelId,
				lang: activeLang,
				hash: String(hash || ''),
			});
		}
	}

	async function preloadI18n({ pluginType, instanceId, panelId, hash = '' }) {
		const activeLang = lang;
		const preloadKey = `${getPanelLangKey(pluginType, instanceId, panelId, activeLang)}:i18n`;
		if (i18nPreloadCache.has(preloadKey)) {
			return i18nPreloadCache.get(preloadKey);
		}
		const pending = loadBundle(pluginType, instanceId, panelId, hash, activeLang, {
			include: ['i18n'],
			projectionKey: 'i18n',
			expectJs: false,
			importJs: false,
		})
			.then(entry => {
				applyPluginI18n(pluginType, instanceId, panelId, activeLang, entry.hash, entry.i18n);
				return entry;
			})
			.catch(err => {
				i18nPreloadCache.delete(preloadKey);
				throw err;
			});
		i18nPreloadCache.set(preloadKey, pending);
		return pending;
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
			dom: Object.freeze({
				h,
			}),
			api: Object.freeze({
				/**
				 * Sends an RPC command to the plugin panel backend.
				 * Returns a normalized { ok, data } / { ok, error } envelope to the bundle,
				 * insulating it from the msghubRequest transport (which resolves with res.data directly).
				 *
				 * @param {string} command - Prefixed plugin UI RPC command name.
				 * @param {any} [payload] - Optional command payload.
				 * @returns {Promise<{ ok: boolean, data?: any, error?: object }>} Normalized response envelope.
				 */
				request(command, payload) {
					const resolved = resolvePluginUiRpcCommand(command);
					if (!resolved.ok) {
						return Promise.resolve({ ok: false, error: { message: resolved.error } });
					}
					return request(resolved.rpcCommand, {
						pluginType,
						instanceId,
						panelId,
						command: resolved.panelCommand,
						payload,
					}).then(
						data => ({ ok: true, data }),
						err => ({ ok: false, error: { message: err?.message || String(err) } }),
					);
				},
				i18n: Object.freeze({ t: (key, ...args) => (api?.i18n?.t ? api.i18n.t(key, ...args) : key) }),
				ui: Object.freeze({
					toast: opts => api?.ui?.toast?.(opts),
					spinner: Object.freeze({
						show: opts => api?.ui?.spinner?.show?.(opts),
						hide: id => api?.ui?.spinner?.hide?.(id),
						isOpen: id => api?.ui?.spinner?.isOpen?.(id) ?? false,
					}),
					dialog: Object.freeze({
						confirm: opts => api?.ui?.dialog?.confirm?.(opts),
					}),
					overlayLarge: Object.freeze({
						open: opts => api?.ui?.overlayLarge?.open?.(opts),
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
	 *   hash: known bundle hash from the active view; used for cache fast-path.
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
			const activeLang = lang;
			const preloadedHash = i18nReadyByPanelLang.get(
				getPanelLangKey(pluginType, instanceId, panelId, activeLang),
			);
			const canSkipI18n = !!preloadedHash && (!hash || preloadedHash === hash);
			const {
				module,
				css,
				i18n: i18nData,
				hash: responseHash,
			} = await loadBundle(
				pluginType,
				instanceId,
				panelId,
				hash,
				activeLang,
				canSkipI18n
					? {
							exclude: ['i18n'],
							projectionKey: 'exclude:i18n',
							expectJs: true,
							importJs: true,
						}
					: undefined,
			);

			// Step 7a: Merge plugin-owned translations into the runtime i18n dictionary before mount.
			// Namespace filter and no-overwrite rule are enforced inside mergePluginI18n (runtime.js),
			// not here — this call is intentionally unconditional on i18nData presence check.
			applyPluginI18n(pluginType, instanceId, panelId, activeLang, responseHash, i18nData);

			// Create the Light DOM mount wrapper — this is ctx.root and the CSS scope root.
			// Plugin companion CSS scopes to .msghub-plugin-ui-mount[data-plugin-type=...][data-panel-id=...].
			const mountWrapper = document.createElement('div');
			mountWrapper.setAttribute('class', 'msghub-plugin-ui-mount');
			mountWrapper.setAttribute('data-plugin-type', pluginType);
			mountWrapper.setAttribute('data-plugin-instance-id', instanceId);
			mountWrapper.setAttribute('data-panel-id', panelId);
			container.appendChild(mountWrapper);

			if (css) {
				// Inject companion CSS as a sibling in the host container, not into ctx.root itself.
				// Bundles are free to call root.replaceChildren(...), so putting <style> into the
				// render root would make the companion CSS disappear on first render.
				const styleEl = document.createElement('style');
				styleEl.textContent = css;
				container.appendChild(styleEl);
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
		const preloadPrefix = `${handle._pluginType}:${handle._instanceId}:${handle._panelId}:`;
		for (const key of i18nPreloadCache.keys()) {
			if (key.startsWith(preloadPrefix)) {
				i18nPreloadCache.delete(key);
			}
		}
		for (const key of i18nReadyByPanelLang.keys()) {
			if (key.startsWith(preloadPrefix)) {
				i18nReadyByPanelLang.delete(key);
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

	return { mount, preloadI18n, unmount, retry };
}

window.createMsghubPluginUiHost = createMsghubPluginUiHost;
