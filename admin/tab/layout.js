/* global window, document, location, history, MutationObserver, win, args, applyTheme, detectTheme, readThemeFromTopWindow, urlThemeLocked, t, pickText */
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

/**
 * Builds a canonical PanelDescriptor from a core panel registry entry.
 *
 * @param {string} registryKey - JS object key in registry.panels (e.g. 'messages').
 * @param {object} def - Raw panel definition from registry.panels[registryKey].
 * @returns {object} Canonical PanelDescriptor.
 */
function normalizeCorePanel(registryKey, def) {
	return {
		id: def.id,
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
 * Note: `contrib.title` and `contrib.description` may be `{en, de}` objects from the
 * Altbestand manifest shape — bridged via `pickText()`. New contract requires i18n-key
 * strings; migration to i18n keys in the manifest is deferred.
 *
 * Note: `ui.entry` is not populated because discover returns only `bundle.hash`, not the
 * entry path. Bundle loading uses `admin.pluginUi.bundle.get` RPC. This is a known gap.
 *
 * @param {object} contrib - Discover contribution (`{ pluginType, instanceId, panelId, title, description, bundle, surface?, category?, app? }`).
 * @param {object} pluginRef - Plugin reference (`{ pluginType, instanceId, panelId }`).
 * @returns {object} Canonical PanelDescriptor.
 */
function normalizePluginPanel(contrib, pluginRef) {
	const key = `plugin-${pluginRef.pluginType}-${pluginRef.instanceId}-${pluginRef.panelId}`;
	return {
		id: `tab-${key}`,
		label: contrib.title,
		description: contrib.description,
		surface: contrib.surface,
		category: contrib.category,
		ui: {
			kind: 'plugin',
			loader: 'esm',
			// ui.entry: target-contract field per Concept Doc Appendix C.
			// Not populated: discover returns bundle.hash only, not bundle.entry.
			// Bundle is loaded via admin.pluginUi.bundle.get RPC.
		},
		app: contrib.app,
	};
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
 * Applies PWA/install head meta tags from an `app` descriptor block.
 * Sets or updates each supported tag; removes tags for absent fields so that switching
 * between two panels with different `app` blocks leaves no stale values behind.
 * No link tags — manifest and icon routes are deferred.
 *
 * @param {object} app - Panel app block.
 */
function applyAppHeadMeta(app) {
	/**
	 * Sets the named meta tag to `content` (creating it if absent), or removes it when
	 * `content` is falsy.
	 *
	 * @param {string} name - Meta name attribute value.
	 * @param {string} content - Meta content value; falsy triggers removal.
	 */
	function setOrRemove(name, content) {
		const existing = document.head.querySelector(`meta[name="${name}"]`);
		if (!content) {
			existing?.remove();
			return;
		}
		if (existing) {
			existing.setAttribute('content', content);
		} else {
			const meta = document.createElement('meta');
			meta.setAttribute('name', name);
			meta.setAttribute('content', content);
			document.head.appendChild(meta);
		}
	}
	setOrRemove('theme-color', typeof app.themeColor === 'string' ? app.themeColor : '');
	setOrRemove('application-name', app.name ? pickText(app.name) : '');
	setOrRemove('apple-mobile-web-app-title', (app.shortName ?? app.name) ? pickText(app.shortName ?? app.name) : '');
}

/**
 * Removes PWA/install head meta tags left by a previous panel.
 * Fully removes all three managed meta tags — not just empties them —
 * so no stale meta values override browser defaults after a panel switch.
 */
function resetAppHeadMeta() {
	document.head.querySelector('meta[name="theme-color"]')?.remove();
	document.head.querySelector('meta[name="application-name"]')?.remove();
	document.head.querySelector('meta[name="apple-mobile-web-app-title"]')?.remove();
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
 * @param {object} [descriptor] - PanelDescriptor for the active panel. Defaults to the
 *   descriptor of the currently active panel from `panelDescriptors`.
 */
function updateDocumentTitle(descriptor = panelDescriptors.get(currentActivePanelId)) {
	const label = descriptor ? pickText(descriptor.label) : '';
	document.title = label ? `${label} - MessageHub` : 'MessageHub';
	if (descriptor?.app) {
		applyAppHeadMeta(descriptor.app);
	} else {
		resetAppHeadMeta();
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
		updateDocumentTitle(undefined);
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
	updateDocumentTitle(panelDescriptors.get(panelId));
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
	const coreEntry = Object.entries(panels).find(([, def]) => def && def.id === panelArg);
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
	const panelEl = h('div', { id: panelId, class: 'msghub-panel', role: 'tabpanel' });
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

	if (isWildcard) {
		const regPanels = registry?.panels && typeof registry.panels === 'object' ? registry.panels : {};
		for (const pid of Object.keys(regPanels)) {
			const def = regPanels[pid];
			if (def && typeof def === 'object') {
				panelIds.push(pid);
				allEntries.push({ kind: 'native', id: pid, def });
			}
		}
		const contribs = Array.isArray(contributions) ? contributions : [];
		for (const c of contribs) {
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
			allEntries.push({ kind: 'plugin', ref });
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
				allEntries.push({ kind: 'plugin', ref: entry });
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
						text: t('msghub.i18n.core.admin.ui.panel.loading.text'),
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
			const mountId = def.id ? `${def.id.slice('tab-'.length)}-root` : '';
			const panel = h('div', {
				id: tabId,
				class: `msghub-panel msghub-${id}`,
				role: 'tabpanel',
			});
			if (mountId) {
				panel.appendChild(h('div', { id: mountId }));
			}
			// Register descriptor so activatePanel and updateDocumentTitle can resolve titles.
			const descriptor = normalizeCorePanel(String(id), def);
			registerPanelDescriptor(descriptor);
			fragment.appendChild(panel);
		} else {
			// Plugin panel: container with data attributes for boot.js discover wiring.
			const { ref } = entry;
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
void resolvePanelMode;
void buildSinglePanelShell;
void renderPanelModeError;
