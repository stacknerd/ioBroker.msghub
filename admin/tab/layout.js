/* global window, document, location, history, MutationObserver, win, args, applyTheme, detectTheme, readThemeFromTopWindow, urlThemeLocked, t */
'use strict';

/**
 * MsgHub Admin Tab layout, asset, and DOM orchestration.
 *
 * Docs: ../../docs/ui/tab-layout.md
 *
 * Contents:
 * - Tab navigation and panel visibility.
 * - Dynamic layout building from the registry.
 * - CSS and JS asset loading per composition.
 * - DOM helpers and panel boot error rendering.
 *
 * Integration:
 * - Uses runtime globals such as `args`, `applyTheme`, `detectTheme`, and `urlThemeLocked`.
 * - Is used by `boot.js` to initialize the visible admin layout.
 *
 * Interfaces:
 * - Exposes helpers such as `buildLayoutFromRegistry`, `initTabs`,
 *   `computeAssetsForComposition`, `getPanelDefinition`, `resolveViewId`,
 *   `resolvePanelMode`, `buildSinglePanelShell`, and `renderPanelModeError`.
 */

let currentActivePanelId = '';

// Maps panel tab ids (e.g. 'tab-messages') to their PanelDescriptor.
const panelDescriptors = new Map();
const APP_ICON_SLOTS = new Set(['any192', 'any512', 'maskable192', 'maskable512', 'apple180']);
const MANIFEST_ICON_SLOT_CONFIG = Object.freeze({
	any192: Object.freeze({ sizes: '192x192' }),
	any512: Object.freeze({ sizes: '512x512' }),
	maskable192: Object.freeze({ sizes: '192x192', purpose: 'maskable' }),
	maskable512: Object.freeze({ sizes: '512x512', purpose: 'maskable' }),
});
const GENERIC_PLUGIN_UI_ICON_FILES = Object.freeze({
	any192: 'pluginUI-192.png',
	any512: 'pluginUI-512.png',
	maskable192: 'pluginUI-maskable-192.png',
	maskable512: 'pluginUI-maskable-512.png',
	apple180: 'pluginUI-apple-180.png',
});

let appHeadVersion = 0;
let activeManifestUrl = '';

/**
 * Returns the producer-local id of a core panel.
 *
 * @param {string} registryKey - JS object key in registry.panels.
 * @param {object} def - Raw panel definition.
 * @returns {string} Local core panel id without the `tab-` prefix.
 */
function getCorePanelLocalId(registryKey, def) {
	const localId = typeof def?.id === 'string' ? def.id.trim() : '';
	return localId || String(registryKey || '').trim();
}

/**
 * Builds a canonical PanelDescriptor from a core panel registry entry.
 *
 * @param {string} registryKey - JS object key in registry.panels (e.g. 'messages').
 * @param {object} def - Raw panel definition from registry.panels[registryKey].
 * @returns {object} Canonical PanelDescriptor.
 */
function normalizeCorePanel(registryKey, def) {
	const localId = getCorePanelLocalId(registryKey, def);
	return {
		id: `tab-${localId}`,
		label: def.label,
		description: def.description,
		surface: def.surface,
		category: def.category,
		ui: def.ui ? { ...def.ui } : {},
		app: def.app,
		_registryKey: registryKey,
	};
}

/**
 * Builds a canonical PanelDescriptor from a plugin discover contribution and a plugin ref.
 *
 * `ui.entry` is intentionally absent from the frontend descriptor contract.
 * Bundle loading runs through `admin.pluginUi.bundle.get` RPC plus `bundle.hash`.
 *
 * @param {object} contrib - Discover contribution (`{ pluginType, instanceId, panelId, label, description, bundle, surface?, category?, app? }`).
 * @param {object} pluginRef - Plugin reference (`{ pluginType, instanceId, panelId }`).
 * @returns {object} Canonical PanelDescriptor.
 */
function normalizePluginPanel(contrib, pluginRef) {
	const key = `plugin-${pluginRef.pluginType}-${pluginRef.instanceId}-${pluginRef.panelId}`;
	return {
		id: `tab-${key}`,
		label: contrib.label,
		description: contrib.description,
		surface: contrib.surface,
		category: contrib.category,
		ui: {
			kind: 'plugin',
			loader: 'esm',
			// Bundle loading is host-owned via admin.pluginUi.bundle.get RPC.
			// `ui.entry` is intentionally not part of the frontend descriptor.
		},
		app: contrib.app,
	};
}

/**
 * Resolves hard-migrated panel/app metadata keys to translated text.
 *
 * Panel and app metadata in the shell path must already be i18n-key strings.
 * Legacy language-map payloads are intentionally not bridged here.
 *
 * @param {any} key - Expected i18n key string.
 * @returns {string} Translated text, or an empty string for non-string input.
 */
function resolvePanelI18nKey(key) {
	if (typeof key !== 'string') {
		return '';
	}
	return t(key);
}

/**
 * Registers a PanelDescriptor in the module-level map, keyed by `descriptor.id`.
 *
 * @param {object} descriptor - Canonical PanelDescriptor with a non-empty `id` field.
 */
function registerPanelDescriptor(descriptor) {
	if (descriptor && typeof descriptor.id === 'string' && descriptor.id) {
		panelDescriptors.set(descriptor.id, descriptor);
	}
}

/**
 * Returns whether the given value is one of the fixed app icon slots.
 *
 * @param {string} slot Candidate slot name.
 * @returns {boolean} True when the slot is supported.
 */
function isSupportedAppIconSlot(slot) {
	return APP_ICON_SLOTS.has(String(slot || '').trim());
}

/**
 * Returns the owner-local key that determines the icon directory for a core panel.
 *
 * @param {object} descriptor Canonical panel descriptor.
 * @returns {string} Owner-local panel key or an empty string.
 */
function getOwnerPanelKey(descriptor) {
	if (typeof descriptor?._registryKey === 'string' && descriptor._registryKey.trim()) {
		return descriptor._registryKey.trim();
	}
	if (typeof descriptor?.id === 'string' && descriptor.id.startsWith('tab-')) {
		return descriptor.id.slice('tab-'.length);
	}
	return '';
}

/**
 * Builds the static admin-host URL for a core panel icon.
 *
 * @param {object} descriptor Canonical panel descriptor.
 * @param {string} fileName Owner-local icon file name.
 * @returns {string|null} Static icon URL or null.
 */
function buildCoreIconUrl(descriptor, fileName) {
	const ownerPanelKey = getOwnerPanelKey(descriptor);
	if (!ownerPanelKey || !fileName) {
		return null;
	}
	return `icons/${encodeURIComponent(ownerPanelKey)}/${encodeURIComponent(fileName)}`;
}

/**
 * Builds the static admin-host URL for a generic plugin panel icon.
 *
 * @param {string} slot Fixed app icon slot name.
 * @returns {string|null} Static icon URL or null.
 */
function buildPluginIconUrl(slot) {
	const fileName =
		typeof GENERIC_PLUGIN_UI_ICON_FILES[slot] === 'string' ? GENERIC_PLUGIN_UI_ICON_FILES[slot].trim() : '';
	if (!fileName) {
		return null;
	}
	return `icons/pluginUI/${encodeURIComponent(fileName)}`;
}

/**
 * Derives a MIME type from an icon filename extension.
 *
 * @param {string} fileName Icon filename.
 * @returns {string} Best-effort MIME type.
 */
function detectIconMimeType(fileName) {
	const normalized = String(fileName || '').toLowerCase();
	if (normalized.endsWith('.png')) {
		return 'image/png';
	}
	if (normalized.endsWith('.svg')) {
		return 'image/svg+xml';
	}
	if (normalized.endsWith('.webp')) {
		return 'image/webp';
	}
	if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) {
		return 'image/jpeg';
	}
	if (normalized.endsWith('.gif')) {
		return 'image/gif';
	}
	if (normalized.endsWith('.ico')) {
		return 'image/x-icon';
	}
	return 'application/octet-stream';
}

/**
 * Revokes an object URL when the environment supports it.
 *
 * @param {string} href Candidate URL to revoke.
 */
function revokeObjectUrl(href) {
	if (typeof href === 'string' && href.startsWith('blob:') && typeof URL?.revokeObjectURL === 'function') {
		URL.revokeObjectURL(href);
	}
}

/**
 * Sets or removes a managed head meta tag.
 *
 * @param {string} name Meta name attribute value.
 * @param {string} content Meta content value; falsy removes the tag.
 */
function setOrRemoveHeadMeta(name, content) {
	const existing = document.head.querySelector(`meta[name="${name}"]`);
	if (!content) {
		existing?.remove();
		return;
	}
	if (existing) {
		existing.setAttribute('content', content);
		return;
	}
	const meta = document.createElement('meta');
	meta.setAttribute('name', name);
	meta.setAttribute('content', content);
	document.head.appendChild(meta);
}

/**
 * Sets or removes a managed head link element.
 *
 * @param {string} rel Link relation value.
 * @param {string} href Link target; falsy removes the link.
 */
function setOrRemoveHeadLink(rel, href) {
	const existing = document.head.querySelector(`link[rel="${rel}"]`);
	if (!href) {
		existing?.remove();
		return;
	}
	if (existing) {
		existing.setAttribute('href', href);
		return;
	}
	const link = document.createElement('link');
	link.setAttribute('rel', rel);
	link.setAttribute('href', href);
	document.head.appendChild(link);
}

/**
 * Removes a managed category marker from a panel container.
 *
 * @param {HTMLElement|Element|null|undefined} panelEl Panel element.
 */
function removeCategoryMarker(panelEl) {
	if (!panelEl?.children?.length) {
		return;
	}
	const marker = Array.from(panelEl.children).find(child =>
		String(child?.className || '')
			.split(/\s+/g)
			.some(token => token.startsWith('msghub-paneltype-')),
	);
	marker?.remove?.();
}

/**
 * Applies the semantic category marker to a panel container.
 *
 * @param {HTMLElement|Element|null|undefined} panelEl Panel element.
 * @param {string} category Semantic category string.
 */
function applyCategoryMarker(panelEl, category) {
	if (!panelEl) {
		return;
	}
	removeCategoryMarker(panelEl);
	const normalizedCategory = typeof category === 'string' ? category.trim() : '';
	if (!normalizedCategory) {
		return;
	}
	panelEl.appendChild(
		h('span', {
			class: `msghub-paneltype-${normalizedCategory}`,
			'aria-hidden': 'true',
		}),
	);
}

/**
 * Creates the mutable icon map used while building one manifest payload.
 *
 * @returns {Record<string, { url?: string, src?: string, mimeType?: string, content?: string }>} Empty icon map.
 */
function createResolvedIconMap() {
	return {};
}

/**
 * Resolves the complete icon asset metadata for one app slot.
 *
 * This AdminTab consumer knows exactly two static icon sources:
 * core panels keep their owner-local `admin/icons/<panel>/...` files, while
 * plugin panels always map to the generic host-owned `admin/icons/pluginUI/...` set.
 *
 * @param {object} descriptor Canonical panel descriptor.
 * @param {string} slot Fixed app icon slot name.
 * @returns {Promise<{ url: string, mimeType: string }|null>} Resolved icon asset or null.
 */
async function resolveIconAsset(descriptor, slot) {
	const normalizedSlot = typeof slot === 'string' ? slot.trim() : '';
	if (!isSupportedAppIconSlot(normalizedSlot)) {
		return null;
	}

	let fileName = '';
	let url = null;
	if (descriptor?.ui?.kind === 'core') {
		fileName =
			typeof descriptor?.app?.icons?.[normalizedSlot] === 'string'
				? descriptor.app.icons[normalizedSlot].trim()
				: '';
		if (!fileName) {
			return null;
		}
		url = buildCoreIconUrl(descriptor, fileName);
	} else if (descriptor?.ui?.kind === 'plugin') {
		fileName = GENERIC_PLUGIN_UI_ICON_FILES[normalizedSlot];
		url = buildPluginIconUrl(normalizedSlot);
	}
	if (!fileName || !url) {
		return null;
	}
	return {
		url,
		mimeType: detectIconMimeType(fileName),
	};
}

/**
 * Resolves an app icon URL for a canonical panel descriptor.
 *
 * Core panels resolve to their existing static admin-host paths.
 * Plugin panels resolve to the generic static host-owned `admin/icons/pluginUI/*` set.
 * Missing core app metadata or unsupported slots degrade to `null`.
 *
 * @param {object} descriptor Canonical panel descriptor.
 * @param {string} slot Fixed app icon slot name.
 * @returns {Promise<string|null>} Resolved URL or null.
 */
async function resolveIconUrl(descriptor, slot) {
	const asset = await resolveIconAsset(descriptor, slot);
	return asset?.url || null;
}

/**
 * Returns the current shell entry URL as an absolute runtime base when available.
 *
 * Blob-served manifests cannot safely resolve install targets against their own object
 * URL. The consumer therefore anchors host-neutral `app.url` targets against the
 * current shell entry (`origin + pathname`) before writing manifest `start_url` / `id`.
 *
 * @returns {string} Absolute runtime entry URL, or a path-only fallback.
 */
function getRuntimeEntryUrl() {
	const href = typeof location?.href === 'string' ? location.href.trim() : '';
	if (href) {
		try {
			const entryUrl = new URL(href);
			entryUrl.search = '';
			entryUrl.hash = '';
			return entryUrl.href;
		} catch {
			// Fall through to origin/path handling.
		}
	}

	const currentPath =
		typeof location?.pathname === 'string' && location.pathname.trim() ? location.pathname.trim() : '/tab.html';
	const origin = typeof location?.origin === 'string' ? location.origin.trim() : '';
	if (origin) {
		try {
			return new URL(currentPath, origin).href;
		} catch {
			// Fall through to the path-only fallback below.
		}
	}

	return currentPath;
}

/**
 * Resolves the runtime app URL from a host-neutral producer target.
 *
 * Current producer contract stores only stable single-panel target params (for example
 * `?panel=tab-messages`). The shell composes the install URL at runtime from the
 * current shell entry plus that target string.
 *
 * @param {string} appUrl Host-neutral app target from the producer contract.
 * @returns {string} Runtime URL for manifest `start_url` / `id`, or an empty string.
 */
function resolveRuntimeAppUrl(appUrl) {
	const raw = typeof appUrl === 'string' ? appUrl.trim() : '';
	if (!raw) {
		return '';
	}

	const runtimeEntryUrl = getRuntimeEntryUrl();
	try {
		return new URL(raw, runtimeEntryUrl).href;
	} catch {
		if (raw.startsWith('?') || raw.startsWith('#')) {
			return `${runtimeEntryUrl}${raw}`;
		}
		return raw;
	}
}

/**
 * Resolves one manifest icon source into a browser-loadable runtime URL.
 *
 * Relative core icon paths must not stay relative inside a blob-served manifest because
 * they would resolve against the blob URL instead of the current shell entry.
 *
 * @param {string} iconUrl Runtime icon URL candidate.
 * @returns {string} Absolute/browser-loadable manifest icon URL, or an empty string.
 */
function resolveManifestIconUrl(iconUrl) {
	const raw = typeof iconUrl === 'string' ? iconUrl.trim() : '';
	if (!raw) {
		return '';
	}

	const runtimeEntryUrl = getRuntimeEntryUrl();
	try {
		return new URL(raw, runtimeEntryUrl).href;
	} catch {
		return raw;
	}
}

/**
 * Resolves the shared head/manifest consumer contract for one panel descriptor.
 *
 * Title, app head meta, and manifest generation must consume the same translated
 * text fields and the same runtime-composed app target URL.
 *
 * @param {object} descriptor Canonical panel descriptor.
 * @returns {{ label: string, appName: string, appShortName: string, runtimeAppUrl: string }} Resolved consumer values.
 */
function resolveHeadManifestContract(descriptor) {
	const app = descriptor?.app;
	return {
		label: resolvePanelI18nKey(descriptor?.label),
		appName: resolvePanelI18nKey(app?.name),
		appShortName: resolvePanelI18nKey(app?.shortName ?? app?.name),
		runtimeAppUrl: resolveRuntimeAppUrl(app?.url),
	};
}

/**
 * Builds a manifest object for one installable panel descriptor.
 *
 * @param {object} descriptor Canonical panel descriptor.
 * @param {Record<string, { src?: string, mimeType?: string }>} resolvedIcons Resolved icon payloads.
 * @returns {object|null} Manifest object or null when no app block is present.
 */
function generateManifest(descriptor, resolvedIcons) {
	const app = descriptor?.app;
	if (!app) {
		return null;
	}
	const contract = resolveHeadManifestContract(descriptor);
	const manifest = {
		name: contract.appName,
		short_name: contract.appShortName,
		start_url: contract.runtimeAppUrl,
		id: contract.runtimeAppUrl,
	};
	if (typeof app.display === 'string' && app.display.trim()) {
		manifest.display = app.display.trim();
	}
	if (typeof app.themeColor === 'string' && app.themeColor.trim()) {
		manifest.theme_color = app.themeColor.trim();
	}
	if (typeof app.backgroundColor === 'string' && app.backgroundColor.trim()) {
		manifest.background_color = app.backgroundColor.trim();
	}
	const icons = [];
	for (const [slot, config] of Object.entries(MANIFEST_ICON_SLOT_CONFIG)) {
		const icon = resolvedIcons?.[slot];
		if (!icon?.src) {
			continue;
		}
		const entry = {
			src: icon.src,
			sizes: config.sizes,
			type:
				typeof icon.mimeType === 'string' && icon.mimeType.trim()
					? icon.mimeType.trim()
					: 'application/octet-stream',
		};
		const purpose = 'purpose' in config ? config.purpose : '';
		if (purpose) {
			entry.purpose = purpose;
		}
		icons.push(entry);
	}
	manifest.icons = icons;
	return manifest;
}

/**
 * Applies PWA/install head metadata for a descriptor with an `app` block.
 *
 * The operation is async because the shared title/head pipeline is async, even though
 * icon resolution for this consumer now uses only static host assets.
 *
 * @param {object} descriptor Canonical panel descriptor.
 * @returns {Promise<void>} Promise that settles after head metadata has been updated.
 */
async function applyAppHeadMeta(descriptor) {
	const app = descriptor?.app;
	if (!app) {
		return;
	}
	const version = appHeadVersion;
	const contract = resolveHeadManifestContract(descriptor);
	setOrRemoveHeadMeta('theme-color', typeof app.themeColor === 'string' ? app.themeColor : '');
	setOrRemoveHeadMeta('application-name', contract.appName);
	setOrRemoveHeadMeta('apple-mobile-web-app-title', contract.appShortName);
	setOrRemoveHeadMeta('apple-mobile-web-app-capable', 'yes');

	const slots = ['any192', 'any512', 'maskable192', 'maskable512', 'apple180'];
	const assets = await Promise.all(slots.map(slot => resolveIconAsset(descriptor, slot)));
	if (version !== appHeadVersion) {
		return;
	}

	const resolvedIcons = createResolvedIconMap();
	for (let i = 0; i < slots.length; i++) {
		const asset = assets[i];
		if (!asset) {
			continue;
		}
		resolvedIcons[slots[i]] = {
			...asset,
			src: resolveManifestIconUrl(asset.url),
		};
	}

	setOrRemoveHeadLink('apple-touch-icon', resolvedIcons.apple180?.url || '');

	const manifest = generateManifest(descriptor, resolvedIcons);
	if (manifest) {
		const manifestBlob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
		activeManifestUrl = URL.createObjectURL(manifestBlob);
		setOrRemoveHeadLink('manifest', activeManifestUrl);
	}
}

/**
 * Removes all managed app/install metadata from the document head.
 *
 * Revokes the manifest object URL before removing the managed links so repeated panel
 * switches do not leak browser resources.
 */
function resetAppHeadMeta() {
	appHeadVersion += 1;
	revokeObjectUrl(activeManifestUrl);
	activeManifestUrl = '';
	setOrRemoveHeadLink('manifest', '');
	setOrRemoveHeadLink('apple-touch-icon', '');
	setOrRemoveHeadMeta('theme-color', '');
	setOrRemoveHeadMeta('application-name', '');
	setOrRemoveHeadMeta('apple-mobile-web-app-title', '');
	setOrRemoveHeadMeta('apple-mobile-web-app-capable', '');
}

/**
 * Returns the tab target id from a tab link (`href="#tab-..."`).
 *
 * @param {Element|null|undefined} tab - Tab element.
 * @returns {string} Target panel id without the leading `#`.
 */
function getTabTargetId(tab) {
	const href = tab?.getAttribute?.('href') || '';
	return href.startsWith('#') ? href.slice(1) : '';
}

/**
 * Synchronises document.title and head meta with the currently active panel descriptor.
 *
 * Called with an explicit descriptor from `activatePanel()` (bypasses the default lookup)
 * or with no arguments from `applyStaticI18n()` for language-resync (uses the default
 * parameter to look up the active panel's descriptor).
 *
 * @param {object} [descriptor] PanelDescriptor for the active panel. Defaults to the
 *   descriptor of the currently active panel from `panelDescriptors`.
 * @returns {Promise<void>} Promise that settles after head metadata is synchronized.
 */
async function updateDocumentTitle(descriptor = panelDescriptors.get(currentActivePanelId)) {
	const contract = resolveHeadManifestContract(descriptor);
	const label = contract.label;
	document.title = label ? `${label} - MessageHub` : 'MessageHub';
	resetAppHeadMeta();
	if (descriptor?.app) {
		await applyAppHeadMeta(descriptor);
	}
}

/**
 * Activates a panel, updates tab state, and keeps the derived document title in sync.
 *
 * This is the single activation path for both tabbed and single-panel layouts.
 *
 * @param {string} id - Target panel DOM id.
 * @returns {string} Normalized active panel DOM id.
 */
function activatePanel(id) {
	const panelId = typeof id === 'string' ? id.trim() : '';
	if (!panelId) {
		void updateDocumentTitle(undefined);
		return '';
	}

	const tabs = Array.from(document.querySelectorAll('.msghub-tab'));
	for (const tab of tabs) {
		const tabId = getTabTargetId(tab);
		const isActive = tabId === panelId;
		tab.classList.toggle('is-active', isActive);
		tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
		tab.setAttribute('tabindex', isActive ? '0' : '-1');
	}

	const panels = Array.from(document.querySelectorAll('.msghub-panel')).filter(panel => !!panel?.id);
	for (const panel of panels) {
		panel.toggleAttribute('hidden', panel.id !== panelId);
	}

	if (currentActivePanelId && currentActivePanelId !== panelId) {
		try {
			document.dispatchEvent(
				new CustomEvent('msghub:tabSwitch', { detail: { from: currentActivePanelId, to: panelId } }),
			);
		} catch {
			// ignore
		}
	}
	currentActivePanelId = panelId;
	void updateDocumentTitle(panelDescriptors.get(panelId));
	return panelId;
}

/**
 * Initializes tab navigation and synchronizes tabs/panels with `location.hash`.
 *
 * @param {object} [options] - Options for tab initialization.
 * @param {string} [options.defaultPanelId] - Fallback panel id without the `tab-` prefix.
 */
function initTabs({ defaultPanelId = '' } = {}) {
	const tabs = Array.from(document.querySelectorAll('.msghub-tab'));
	if (!tabs.length) {
		return { setActive: activatePanel, initial: null };
	}

	const panels = new Map();
	for (const tab of tabs) {
		const id = getTabTargetId(tab);
		if (!id) {
			continue;
		}
		const el = document.getElementById(id);
		if (el) {
			panels.set(id, el);
		}
	}

	// Returns true if a tab link is marked disabled (e.g. an unhydrated plugin panel tab).
	const isDisabled = tab => tab.getAttribute('aria-disabled') === 'true';

	// Determine initial panel: all levels of the fallback chain skip disabled tabs.
	const initial = (() => {
		const h = String(location.hash || '');
		const candidate = h.startsWith('#') ? h.slice(1) : '';
		if (candidate && panels.has(candidate)) {
			const candidateTab = tabs.find(t => getTabTargetId(t) === candidate);
			if (!candidateTab || !isDisabled(candidateTab)) {
				return candidate;
			}
		}
		const fromMarkup = tabs.find(t => t.classList.contains('is-active') && !isDisabled(t)) || null;
		const fromMarkupId = fromMarkup ? getTabTargetId(fromMarkup) : '';
		if (fromMarkupId && panels.has(fromMarkupId)) {
			return fromMarkupId;
		}
		const fallback = defaultPanelId ? `tab-${String(defaultPanelId)}` : 'tab-plugins';
		if (panels.has(fallback)) {
			const fallbackTab = tabs.find(t => getTabTargetId(t) === fallback);
			if (!fallbackTab || !isDisabled(fallbackTab)) {
				return fallback;
			}
		}
		// Last resort: first non-disabled panel in DOM order.
		for (const id of panels.keys()) {
			const t = tabs.find(tab => getTabTargetId(tab) === id);
			if (!t || !isDisabled(t)) {
				return id;
			}
		}
		return null; // All tabs disabled — boot.js activates after hydration.
	})();

	if (initial) {
		activatePanel(initial);
	}

	for (const tab of tabs) {
		tab.addEventListener('click', e => {
			e.preventDefault();
			// Disabled tabs (e.g. unhydrated plugin panels) must not be activated.
			if (isDisabled(tab)) {
				return;
			}
			const id = getTabTargetId(tab);
			if (!id || !panels.has(id)) {
				return;
			}
			try {
				history.replaceState(null, '', `#${id}`);
			} catch {
				// ignore
			}
			activatePanel(id);
		});
	}

	return { setActive: activatePanel, initial };
}

/**
 * Reacts to theme messages from the admin host window.
 */
window.addEventListener('message', ev => {
	if (urlThemeLocked) {
		return;
	}
	const dataRaw = ev?.data;
	let data = null;
	if (typeof dataRaw === 'string') {
		const s = dataRaw.trim();
		if (s === 'dark' || s === 'light') {
			data = { theme: s };
		} else {
			try {
				data = JSON.parse(s);
			} catch {
				data = null;
			}
		}
	} else if (dataRaw && typeof dataRaw === 'object') {
		data = dataRaw;
	}
	if (!data || typeof data !== 'object') {
		return;
	}
	const t =
		typeof data.theme === 'string'
			? data.theme
			: typeof data.mode === 'string'
				? data.mode
				: typeof data.paletteType === 'string'
					? data.paletteType
					: null;
	if (t === 'dark' || t === 'light') {
		applyTheme(t);
		return;
	}
	const dark =
		data.dark === true ||
		data.isDark === true ||
		data.mode === 'dark' ||
		data.paletteType === 'dark' ||
		data.theme === 'dark';
	const light =
		data.light === true ||
		data.isLight === true ||
		data.mode === 'light' ||
		data.paletteType === 'light' ||
		data.theme === 'light';
	if (dark || light) {
		applyTheme(dark ? 'dark' : 'light');
	}
});

/**
 * Reacts to storage changes (for example a theme switch in another tab or window).
 */
window.addEventListener('storage', () => {
	if (urlThemeLocked) {
		return;
	}
	applyTheme(detectTheme());
});

// Fallback polling when neither message nor storage events are available or trustworthy.
window.setInterval(() => {
	if (urlThemeLocked) {
		return;
	}
	applyTheme(detectTheme());
}, 1500);

try {
	const topDoc = window.top && window.top.document ? window.top.document : null;
	if (topDoc) {
		// Observes host attribute changes to prevent theme drift.
		const observer = new MutationObserver(() => {
			if (urlThemeLocked) {
				return;
			}
			const t = readThemeFromTopWindow();
			if (t) {
				applyTheme(t);
			}
		});
		observer.observe(topDoc.documentElement, {
			attributes: true,
			subtree: true,
			attributeFilter: ['class', 'data-theme', 'data-react-theme'],
		});
	}
} catch {
	// ignore
}

/**
 * Minimal DOM factory helper for simple UI building blocks.
 *
 * @param {string} tag - HTML tag name.
 * @param {object} [attrs] - Attribute and event map.
 * @param {Node|Node[]|string|string[]} [children] - Child nodes or text.
 * @returns {HTMLElement} Created element.
 */
function h(tag, attrs, children) {
	const el = document.createElement(tag);
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			if (v === undefined || v === null) {
				continue;
			}
			if (k === 'class') {
				el.className = v;
			} else if (k === 'html') {
				el.innerHTML = v;
			} else if (k === 'text') {
				el.textContent = v;
			} else if (k.startsWith('on') && typeof v === 'function') {
				el.addEventListener(k.slice(2), v);
			} else {
				el.setAttribute(k, String(v));
			}
		}
	}
	if (children) {
		const list = Array.isArray(children) ? children : [children];
		for (const c of list) {
			if (c === null || c === undefined) {
				continue;
			}
			el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
		}
	}
	return el;
}

/**
 * Returns the global admin registry in normalized form.
 *
 * @returns {object|null} Registry object or `null`.
 */
function getRegistry() {
	const r = win.MsghubAdminTabRegistry;
	return r && typeof r === 'object' ? r : null;
}

/**
 * Resolves the active composition view id from query, markup, and hard fallback.
 *
 * Resolution order:
 * 1. `args.composition` when present and registered.
 * 2. `data-msghub-view` when present and registered.
 * 3. `'adminTab'` hard fallback.
 *
 * @returns {string} Resolved composition view id.
 */
function resolveViewId() {
	const registry = getRegistry();
	const compositions =
		registry && registry.compositions && typeof registry.compositions === 'object' ? registry.compositions : null;
	const fromUrl = typeof args?.composition === 'string' ? args.composition.trim() : '';
	if (fromUrl && compositions && Object.prototype.hasOwnProperty.call(compositions, fromUrl)) {
		return fromUrl;
	}
	const viewIdRaw = document?.documentElement?.getAttribute?.('data-msghub-view') || '';
	const fromMarkup = String(viewIdRaw || '').trim();
	if (fromMarkup && compositions && Object.prototype.hasOwnProperty.call(compositions, fromMarkup)) {
		return fromMarkup;
	}
	return 'adminTab';
}

/**
 * Returns the active composition object for the resolved view id.
 *
 * @returns {object|null} Composition object or `null`.
 */
function getActiveComposition() {
	const registry = getRegistry();
	const viewId = resolveViewId();
	const comp =
		registry && registry.compositions && typeof registry.compositions === 'object'
			? registry.compositions[viewId]
			: null;
	return comp && typeof comp === 'object' ? comp : null;
}

/**
 * Resolves the active single-panel mode from the `panel` URL argument.
 *
 * Returns a result object with one of the following shapes:
 * - `{ active: false }` — no `panel` argument present; normal composition boot applies.
 * - `{ active: true, error: 'unknownTarget', tabId }` — argument present but unresolvable.
 * - `{ active: true, isPlugin: false, descriptor, registryKey }` — core panel resolved.
 * - `{ active: true, isPlugin: true, pluginRef, tabId }` — plugin panel id parsed.
 *
 * @returns {object} Panel mode result.
 */
function resolvePanelMode() {
	const panelArg = typeof args?.panel === 'string' ? args.panel.trim() : '';
	if (!panelArg) {
		return { active: false };
	}
	if (!panelArg.startsWith('tab-')) {
		return { active: true, error: 'unknownTarget', tabId: panelArg };
	}
	const registry = getRegistry();
	const panels = registry?.panels && typeof registry.panels === 'object' ? registry.panels : {};
	// Try to find a core panel entry whose canonical id matches.
	const coreEntry = Object.entries(panels).find(
		([registryKey, def]) => def && `tab-${getCorePanelLocalId(registryKey, def)}` === panelArg,
	);
	if (coreEntry) {
		const [registryKey, def] = coreEntry;
		return { active: true, isPlugin: false, descriptor: normalizeCorePanel(registryKey, def), registryKey };
	}
	// Determine whether the id follows the plugin panel pattern.
	const panelKey = panelArg.slice('tab-'.length);
	if (panelKey.startsWith('plugin-')) {
		const segments = panelKey.slice('plugin-'.length).split('-');
		if (segments.length < 3) {
			return { active: true, error: 'unknownTarget', tabId: panelArg };
		}
		const pluginType = segments[0];
		const instanceId = segments[1];
		const panelId = segments.slice(2).join('-');
		return { active: true, isPlugin: true, pluginRef: { pluginType, instanceId, panelId }, tabId: panelArg };
	}
	return { active: true, error: 'unknownTarget', tabId: panelArg };
}

/**
 * Builds the DOM for a single-panel shell from a canonical PanelDescriptor.
 *
 * Creates a panel container and mount container without a tab strip.
 * Mount container id derivation:
 * - Core panel: `descriptor.id.slice('tab-'.length) + '-root'`  (e.g. `'messages-root'`)
 * - Plugin panel: `descriptor.id.slice('tab-'.length)`          (e.g. `'plugin-IngestStates-0-presets'`)
 *
 * @param {object} descriptor - Canonical PanelDescriptor.
 * @returns {{ layout: string, panelIds: string[], pluginPanelRefs: object[], defaultPanelId: string }} Shell layout descriptor compatible with `setConnLayout`.
 */
function buildSinglePanelShell(descriptor) {
	const layoutHost = document.getElementById('msghub-layout') || document.querySelector('.msghub-root');
	const isPlugin = descriptor?.ui?.kind === 'plugin';
	const panelId = typeof descriptor?.id === 'string' ? descriptor.id : '';
	const panelKey = panelId.startsWith('tab-') ? panelId.slice('tab-'.length) : panelId;
	const mountId = isPlugin ? panelKey : `${panelKey}-root`;
	const panelEl = h('div', { id: panelId, class: `msghub-panel msghub-${panelKey}`, role: 'tabpanel' });
	applyCategoryMarker(panelEl, descriptor?.category);
	panelEl.appendChild(h('div', { id: mountId }));
	if (layoutHost) {
		layoutHost.replaceChildren(panelEl);
	}
	registerPanelDescriptor(descriptor);
	const registryKey = descriptor?._registryKey || '';
	return {
		layout: 'single',
		panelIds: registryKey ? [registryKey] : [],
		pluginPanelRefs: [],
		defaultPanelId: registryKey,
	};
}

/**
 * Renders a hard error state for unresolvable single-panel targets.
 *
 * @param {string} errorKey - i18n key for the error message.
 */
function renderPanelModeError(errorKey) {
	const layoutHost = document.getElementById('msghub-layout') || document.querySelector('.msghub-root');
	if (!layoutHost) {
		return;
	}
	layoutHost.replaceChildren(h('div', { class: 'msghub-panel-mode-error', text: t(errorKey) }));
}

/**
 * Builds the visible layout (tabs/panel containers) from the registry.
 * Handles mixed composition panels: native string IDs and structured plugin panel references.
 * For wildcard compositions (`panels: ['*']`), pass discover contributions via opts.
 *
 * @param {{ contributions?: object[] }} [opts] - Optional settings for wildcard mode.
 *   contributions: discover contributions array; required when composition declares `panels:['*']`.
 * @returns {{ layout: string, panelIds: string[], pluginPanelRefs: object[], defaultPanelId: string }}
 *   layout: 'tabs' or 'single'.
 *   panelIds: native panel string IDs only (for asset loading and panel init).
 *   pluginPanelRefs: structured plugin panel references (for discover hydration in boot.js).
 *   defaultPanelId: default active panel ID.
 */
function buildLayoutFromRegistry({ contributions = [] } = {}) {
	const registry = getRegistry();
	const comp = getActiveComposition() || { layout: 'tabs', panels: [], defaultPanel: '' };
	const layout = comp.layout === 'single' ? 'single' : 'tabs';
	const defaultPanelId = typeof comp.defaultPanel === 'string' ? comp.defaultPanel : '';

	// Wildcard: show all registry native panels first, then all contributions as plugin panels.
	const isWildcard = Array.isArray(comp.panels) && comp.panels.length === 1 && comp.panels[0] === '*';

	/**
	 * Returns the native panel definition for a given ID, or null if not found.
	 *
	 * @param {string} id - Panel ID.
	 * @returns {object|null} Panel definition or null.
	 */
	const getPanelDef = id => {
		const panels = registry?.panels && typeof registry.panels === 'object' ? registry.panels : null;
		const p = panels ? panels[id] : null;
		return p && typeof p === 'object' ? p : null;
	};

	// Build ordered entry list for tab + panel container rendering.
	const panelIds = [];
	const pluginPanelRefs = [];
	const allEntries = [];
	const availableContributions = Array.isArray(contributions) ? contributions : [];

	/**
	 * Finds the matching discover contribution for a structured plugin panel reference.
	 *
	 * @param {object} pluginRef Structured plugin panel reference.
	 * @returns {object|null} Matching discover contribution or null.
	 */
	const findContribution = pluginRef =>
		availableContributions.find(
			contrib =>
				contrib?.pluginType === pluginRef?.pluginType &&
				String(contrib?.instanceId) === String(pluginRef?.instanceId) &&
				contrib?.panelId === pluginRef?.panelId,
		) || null;

	if (isWildcard) {
		const regPanels = registry?.panels && typeof registry.panels === 'object' ? registry.panels : {};
		for (const pid of Object.keys(regPanels)) {
			const def = regPanels[pid];
			if (def && typeof def === 'object') {
				panelIds.push(pid);
				allEntries.push({ kind: 'native', id: pid, def });
			}
		}
		for (const c of availableContributions) {
			if (!c || typeof c !== 'object') {
				continue;
			}
			const ref = Object.freeze({
				type: 'pluginPanel',
				pluginType: c.pluginType,
				instanceId: c.instanceId,
				panelId: c.panelId,
			});
			pluginPanelRefs.push(ref);
			allEntries.push({ kind: 'plugin', ref, contrib: c });
		}
	} else {
		const panels = Array.isArray(comp.panels) ? comp.panels : [];
		for (const entry of panels) {
			if (typeof entry === 'string' && entry) {
				const def = getPanelDef(entry);
				if (def) {
					panelIds.push(entry);
					allEntries.push({ kind: 'native', id: entry, def });
				}
			} else if (entry && typeof entry === 'object' && entry.type === 'pluginPanel') {
				pluginPanelRefs.push(entry);
				allEntries.push({ kind: 'plugin', ref: entry, contrib: findContribution(entry) });
			}
		}
	}

	const root = document.querySelector('.msghub-root');
	const layoutHost = document.getElementById('msghub-layout') || root;
	if (!layoutHost) {
		return { layout, panelIds, pluginPanelRefs, defaultPanelId };
	}

	const fragment = document.createDocumentFragment();

	if (layout === 'tabs') {
		const nav = h('nav', { class: 'msghub-tabs', role: 'tablist', 'aria-label': 'MsgHub' });
		for (const entry of allEntries) {
			if (entry.kind === 'native') {
				const { id, def } = entry;
				const tabId = `tab-${id}`;
				nav.appendChild(
					h('a', {
						class: `msghub-tab${id === defaultPanelId ? ' is-active' : ''}`,
						href: `#${tabId}`,
						role: 'tab',
						'aria-controls': tabId,
						'data-i18n': def.label || '',
						text: id,
					}),
				);
			} else {
				// Plugin panel: starts disabled until discover confirms availability.
				const { ref } = entry;
				const key = `plugin-${ref.pluginType}-${ref.instanceId}-${ref.panelId}`;
				const tabId = `tab-${key}`;
				nav.appendChild(
					h('a', {
						class: 'msghub-tab is-disabled',
						href: `#${tabId}`,
						role: 'tab',
						'aria-controls': tabId,
						'aria-disabled': 'true',
						'data-i18n': 'msghub.i18n.core.admin.ui.panel.loading.text',
						// Keep the first paint neutral until admin i18n has loaded; never expose raw keys.
						text: '...',
					}),
				);
			}
		}
		fragment.appendChild(nav);
		window.MsghubScrollStrip?.initStrip?.(nav);
	}

	for (const entry of allEntries) {
		if (entry.kind === 'native') {
			const { id, def } = entry;
			const tabId = `tab-${id}`;
			// Mount container id is derived deterministically from the canonical panel id.
			const localPanelId = getCorePanelLocalId(String(id || ''), def);
			const mountId = localPanelId ? `${localPanelId}-root` : '';
			const descriptor = normalizeCorePanel(String(id), def);
			const panel = h('div', {
				id: tabId,
				class: `msghub-panel msghub-${id}`,
				role: 'tabpanel',
			});
			applyCategoryMarker(panel, descriptor.category);
			if (mountId) {
				panel.appendChild(h('div', { id: mountId }));
			}
			// Register descriptor so activatePanel and updateDocumentTitle can resolve titles.
			registerPanelDescriptor(descriptor);
			fragment.appendChild(panel);
		} else {
			// Plugin panel: container with data attributes for boot.js discover wiring.
			const { ref, contrib } = entry;
			const key = `plugin-${ref.pluginType}-${ref.instanceId}-${ref.panelId}`;
			const tabId = `tab-${key}`;
			const panel = h('div', {
				id: tabId,
				class: 'msghub-panel',
				role: 'tabpanel',
				'data-plugin-panel': 'true',
				'data-plugin-type': ref.pluginType,
				'data-plugin-instance-id': String(ref.instanceId),
				'data-panel-id': ref.panelId,
			});
			if (contrib) {
				applyCategoryMarker(panel, normalizePluginPanel(contrib, ref).category);
			}
			// Mount container: this element is passed to pluginUiHost.mount().
			panel.appendChild(h('div', { id: key }));
			fragment.appendChild(panel);
		}
	}

	layoutHost.replaceChildren(fragment);
	return { layout, panelIds, pluginPanelRefs, defaultPanelId };
}

/**
 * Loads CSS files with deduplication and soft-failure handling.
 *
 * @param {string[]} files - CSS paths relative to `admin/`.
 * @returns {Promise<{failed:string[]}>} List of files that could not be loaded.
 */
function loadCssFiles(files) {
	const list = (Array.isArray(files) ? files : []).map(x => String(x || '').trim()).filter(Boolean);
	if (list.length === 0) {
		return Promise.resolve({ failed: [] });
	}
	const head = document.head || document.getElementsByTagName('head')[0];
	const existing = new Set(
		Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(l => l.getAttribute('href') || ''),
	);

	const loads = [];
	const failed = [];
	for (const href of list) {
		if (existing.has(href)) {
			continue;
		}
		existing.add(href);
		loads.push(
			new Promise(resolve => {
				const link = document.createElement('link');
				link.rel = 'stylesheet';
				link.href = href;
				link.onload = () => resolve(undefined);
				link.onerror = () => {
					failed.push(href);
					resolve(undefined);
				};
				head.appendChild(link);
			}),
		);
	}
	return Promise.all(loads).then(() => ({ failed }));
}

/**
 * Loads JavaScript files sequentially in deterministic order.
 *
 * @param {string[]} files - JS paths relative to `admin/`.
 * @returns {Promise<void>} Promise for the completed load chain.
 */
function loadJsFilesSequential(files) {
	const list = (Array.isArray(files) ? files : []).map(x => String(x || '').trim()).filter(Boolean);
	if (list.length === 0) {
		return Promise.resolve();
	}
	const head = document.head || document.getElementsByTagName('head')[0];
	const existing = new Set(
		Array.from(document.querySelectorAll('script[src]')).map(s => s.getAttribute('src') || ''),
	);

	/**
	 * Loads exactly one script asset and fails hard on load errors.
	 *
	 * @param {string} src - Script source.
	 * @returns {Promise<void>}
	 */
	const loadOne = src =>
		new Promise((resolve, reject) => {
			if (existing.has(src)) {
				return resolve(undefined);
			}
			existing.add(src);
			const script = document.createElement('script');
			script.src = src;
			script.async = false;
			script.defer = false;
			script.onload = () => resolve(undefined);
			script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
			head.appendChild(script);
		});

	let chain = Promise.resolve();
	for (const src of list) {
		chain = chain.then(() => loadOne(src));
	}
	return chain;
}

/**
 * Computes the deduplicated asset list for one composition.
 *
 * @param {string[]} panelIds - Panels in the composition.
 * @returns {{css:string[],js:string[]}} Deduplicated asset lists.
 */
function computeAssetsForComposition(panelIds) {
	const registry = getRegistry();
	const panels = registry?.panels && typeof registry.panels === 'object' ? registry.panels : null;
	const css = [];
	const js = [];

	for (const pid of panelIds || []) {
		const def = panels ? panels[pid] : null;
		if (!def || typeof def !== 'object') {
			continue;
		}
		const cssList = Array.isArray(def.ui?.css) ? def.ui.css : [];
		const jsList = Array.isArray(def.ui?.js) ? def.ui.js : [];
		for (const c of cssList) {
			const s = String(c || '').trim();
			if (s && !css.includes(s)) {
				css.push(s);
			}
		}
		for (const s0 of jsList) {
			const s = String(s0 || '').trim();
			if (s && !js.includes(s)) {
				js.push(s);
			}
		}
	}

	return { css, js };
}

/**
 * Returns one panel definition from the registry.
 *
 * @param {string} panelId - Panel id.
 * @returns {object|null} Panel definition or `null`.
 */
function getPanelDefinition(panelId) {
	const registry = getRegistry();
	const panels = registry?.panels && typeof registry.panels === 'object' ? registry.panels : null;
	const def = panels ? panels[panelId] : null;
	return def && typeof def === 'object' ? def : null;
}

/**
 * Renders a visible error state directly into the affected panel container.
 *
 * @param {string} panelId - Panel id.
 * @param {any} err - Error object or value.
 */
function renderPanelBootError(panelId, err) {
	const panelEl = document.getElementById(`tab-${panelId}`);
	if (!panelEl) {
		return;
	}
	const msg = String(err?.message || err || 'Unknown error');
	panelEl.replaceChildren(h('div', { class: 'msghub-error', text: `Failed to load panel '${panelId}'.\n${msg}` }));
}

void initTabs;
void activatePanel;
void updateDocumentTitle;
void h;
void resolveViewId;
void buildLayoutFromRegistry;
void loadCssFiles;
void loadJsFilesSequential;
void computeAssetsForComposition;
void getPanelDefinition;
void renderPanelBootError;
void normalizePluginPanel;
void resolvePanelI18nKey;
void resolveIconUrl;
void generateManifest;
void resolvePanelMode;
void buildSinglePanelShell;
void renderPanelModeError;
