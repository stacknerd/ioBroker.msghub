/* global window, document, location, history, MutationObserver, win, applyTheme, detectTheme, readThemeFromTopWindow */
'use strict';

/**
 * MsgHub Admin Tab: Layout-, Asset- und DOM-Orchestrierung.
 *
 * Inhalt:
 * - Tab-Navigation und Panel-Sichtbarkeit.
 * - Dynamischer Layoutaufbau aus der Registry.
 * - Laden von CSS/JS-Assets pro Composition.
 * - Hilfsfunktionen für DOM-Erzeugung und Panel-Fehlerdarstellung.
 *
 * Systemeinbindung:
 * - Verwendet Runtime-Funktionen (`applyTheme`, `detectTheme`, `readThemeFromTopWindow`).
 * - Wird von `boot.js` zur Initialisierung des sichtbaren Admin-Layouts genutzt.
 *
 * Schnittstellen:
 * - Liefert Utility-Funktionen wie `buildLayoutFromRegistry`, `initTabs`,
 *   `computeAssetsForComposition`, `getPanelDefinition`.
 */

/**
 * Initialisiert die Tab-Navigation und synchronisiert Tab/Panels mit `location.hash`.
 *
 * @param {object} [options] - Optionen für die Tab-Initialisierung.
 * @param {string} [options.defaultPanelId] - Fallback-Panel-ID ohne `tab-`-Präfix.
 */
function initTabs({ defaultPanelId = '' } = {}) {
	const tabs = Array.from(document.querySelectorAll('.msghub-tab'));
	if (!tabs.length) {
		return { setActive: () => {} };
	}

	/**
	 * Liest aus einem Tab-Link (`href="#tab-..."`) die Ziel-ID aus.
	 *
	 * @param {Element} tab - Tab-Element.
	 * @returns {string} Ziel-Panel-ID ohne führendes `#`.
	 */
	const getTargetId = tab => {
		const href = tab.getAttribute('href') || '';
		return href.startsWith('#') ? href.slice(1) : '';
	};

	const panels = new Map();
	for (const tab of tabs) {
		const id = getTargetId(tab);
		if (!id) {
			continue;
		}
		const el = document.getElementById(id);
		if (el) {
			panels.set(id, el);
		}
	}

	let activeId = '';

	/**
	 * Aktiviert ein Panel und setzt ARIA-/Sichtbarkeitszustand für Tabs/Panels.
	 *
	 * @param {string} id - Ziel-Panel-ID.
	 */
	const setActive = id => {
		for (const tab of tabs) {
			const tid = getTargetId(tab);
			const isActive = tid === id;
			tab.classList.toggle('is-active', isActive);
			tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
			tab.setAttribute('tabindex', isActive ? '0' : '-1');
		}
		for (const [pid, panel] of panels.entries()) {
			panel.toggleAttribute('hidden', pid !== id);
		}
		if (activeId && activeId !== id) {
			try {
				document.dispatchEvent(new CustomEvent('msghub:tabSwitch', { detail: { from: activeId, to: id } }));
			} catch {
				// ignore
			}
		}
		activeId = id;
	};

	// Returns true if a tab link is marked disabled (e.g. an unhydrated plugin panel tab).
	const isDisabled = tab => tab.getAttribute('aria-disabled') === 'true';

	// Determine initial panel: all levels of the fallback chain skip disabled tabs.
	const initial = (() => {
		const h = String(location.hash || '');
		const candidate = h.startsWith('#') ? h.slice(1) : '';
		if (candidate && panels.has(candidate)) {
			const candidateTab = tabs.find(t => getTargetId(t) === candidate);
			if (!candidateTab || !isDisabled(candidateTab)) {
				return candidate;
			}
		}
		const fromMarkup = tabs.find(t => t.classList.contains('is-active') && !isDisabled(t)) || null;
		const fromMarkupId = fromMarkup ? getTargetId(fromMarkup) : '';
		if (fromMarkupId && panels.has(fromMarkupId)) {
			return fromMarkupId;
		}
		const fallback = defaultPanelId ? `tab-${String(defaultPanelId)}` : 'tab-plugins';
		if (panels.has(fallback)) {
			const fallbackTab = tabs.find(t => getTargetId(t) === fallback);
			if (!fallbackTab || !isDisabled(fallbackTab)) {
				return fallback;
			}
		}
		// Last resort: first non-disabled panel in DOM order.
		for (const id of panels.keys()) {
			const t = tabs.find(tab => getTargetId(tab) === id);
			if (!t || !isDisabled(t)) {
				return id;
			}
		}
		return null; // All tabs disabled — boot.js activates after hydration.
	})();

	if (initial) {
		setActive(initial);
	}

	for (const tab of tabs) {
		tab.addEventListener('click', e => {
			e.preventDefault();
			// Disabled tabs (e.g. unhydrated plugin panels) must not be activated.
			if (isDisabled(tab)) {
				return;
			}
			const id = getTargetId(tab);
			if (!id || !panels.has(id)) {
				return;
			}
			try {
				history.replaceState(null, '', `#${id}`);
			} catch {
				// ignore
			}
			setActive(id);
		});
	}

	return { setActive, initial };
}

/**
 * Reagiert auf Theme-Nachrichten aus dem Admin-Hostfenster.
 */
window.addEventListener('message', ev => {
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
 * Reagiert auf Storage-Änderungen (z. B. Theme-Wechsel in anderem Tab/Fenster).
 */
window.addEventListener('storage', () => {
	applyTheme(detectTheme());
});

// Fallback polling when neither message nor storage events are available or trustworthy.
window.setInterval(() => {
	applyTheme(detectTheme());
}, 1500);

try {
	const topDoc = window.top && window.top.document ? window.top.document : null;
	if (topDoc) {
		// Observes host attribute changes to prevent theme drift.
		const observer = new MutationObserver(() => {
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
 * Minimaler DOM-Factory-Helper für elementare UI-Bausteine.
 *
 * @param {string} tag - HTML-Tagname.
 * @param {object} [attrs] - Attribut-/Event-Map.
 * @param {Node|Node[]|string|string[]} [children] - Child-Nodes/Text.
 * @returns {HTMLElement} Erzeugtes Element.
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
 * Liefert die globale Admin-Registry in normalisierter Form.
 *
 * @returns {object|null} Registry oder `null`.
 */
function getRegistry() {
	const r = win.MsghubAdminTabRegistry;
	return r && typeof r === 'object' ? r : null;
}

/**
 * Liefert die aktive Composition anhand `data-msghub-view`.
 *
 * @returns {object|null} Composition oder `null`.
 */
function getActiveComposition() {
	const registry = getRegistry();
	const viewIdRaw = document?.documentElement?.getAttribute?.('data-msghub-view') || '';
	const viewId = String(viewIdRaw || '').trim() || 'adminTab';
	const comp =
		registry && registry.compositions && typeof registry.compositions === 'object'
			? registry.compositions[viewId]
			: null;
	return comp && typeof comp === 'object' ? comp : null;
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
						'data-i18n': def.titleKey || '',
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
						text: ref.panelId,
					}),
				);
			}
		}
		fragment.appendChild(nav);
	}

	for (const entry of allEntries) {
		if (entry.kind === 'native') {
			const { id, def } = entry;
			const tabId = `tab-${id}`;
			const mountId = String(def.mountId || '').trim();
			const panel = h('div', {
				id: tabId,
				class: `msghub-panel msghub-${id}`,
				role: 'tabpanel',
			});
			if (mountId) {
				panel.appendChild(h('div', { id: mountId }));
			}
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
 * Lädt CSS-Dateien dedupliziert und fehlertolerant.
 *
 * @param {string[]} files - CSS-Pfade relativ zu `admin/`.
 * @returns {Promise<{failed:string[]}>} Liste nicht ladbarer Dateien.
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
 * Lädt JavaScript-Dateien sequenziell in definierter Reihenfolge.
 *
 * @param {string[]} files - JS-Pfade relativ zu `admin/`.
 * @returns {Promise<void>} Promise auf abgeschlossene Ladefolge.
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
	 * Lädt genau ein Script-Asset und schlägt bei Fehlern hart fehl.
	 *
	 * @param {string} src - Script-Quelle.
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
 * Ermittelt die deduplizierte Asset-Liste für eine Composition.
 *
 * @param {string[]} panelIds - Panels der Composition.
 * @returns {{css:string[],js:string[]}} Deduplizierte Asset-Listen.
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
		const assets = def.assets && typeof def.assets === 'object' ? def.assets : null;
		const cssList = Array.isArray(assets?.css) ? assets.css : [];
		const jsList = Array.isArray(assets?.js) ? assets.js : [];
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
 * Liefert eine einzelne Paneldefinition aus der Registry.
 *
 * @param {string} panelId - Panel-ID.
 * @returns {object|null} Paneldefinition oder `null`.
 */
function getPanelDefinition(panelId) {
	const registry = getRegistry();
	const panels = registry?.panels && typeof registry.panels === 'object' ? registry.panels : null;
	const def = panels ? panels[panelId] : null;
	return def && typeof def === 'object' ? def : null;
}

/**
 * Rendert einen sichtbaren Fehlerzustand direkt im betroffenen Panel-Container.
 *
 * @param {string} panelId - Panel-ID.
 * @param {any} err - Fehlerobjekt/-wert.
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
void h;
void buildLayoutFromRegistry;
void loadCssFiles;
void loadJsFilesSequential;
void computeAssetsForComposition;
void getPanelDefinition;
void renderPanelBootError;
