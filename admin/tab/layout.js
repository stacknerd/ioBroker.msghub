/* global window, document, location, history, MutationObserver, win, applyTheme, detectTheme, readThemeFromTopWindow, socket, adapterInstance */
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
		return;
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

	// Initiales Tab wird aus URL, Markup oder Default ermittelt.
	const initial = (() => {
		const h = String(location.hash || '');
		const candidate = h.startsWith('#') ? h.slice(1) : '';
		if (candidate && panels.has(candidate)) {
			return candidate;
		}
		const fromMarkup = tabs.find(t => t.classList.contains('is-active')) || null;
		const fromMarkupId = fromMarkup ? getTargetId(fromMarkup) : '';
		if (fromMarkupId && panels.has(fromMarkupId)) {
			return fromMarkupId;
		}
		const fallback = defaultPanelId ? `tab-${String(defaultPanelId)}` : 'tab-plugins';
		return panels.has(fallback) ? fallback : panels.keys().next().value;
	})();

	setActive(initial);

	for (const tab of tabs) {
		tab.addEventListener('click', e => {
			e.preventDefault();
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

// Fallback-Polling, falls weder Message noch Storage-Event verfügbar/trustworthy sind.
window.setInterval(() => {
	applyTheme(detectTheme());
}, 1500);

try {
	const topDoc = window.top && window.top.document ? window.top.document : null;
	if (topDoc) {
		// Beobachtet Host-Attributänderungen, um Theme-Drift zu vermeiden.
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
 * Sendet einen Admin-Befehl über socket.io an das Backend.
 *
 * @param {string} command - Backend-Kommando (z. B. `admin.stats.get`).
 * @param {object} message - Payload für das Kommando.
 * @returns {Promise<any>} Aufgelöste Backend-Daten oder Fehler.
 */
function sendTo(command, message) {
	return new Promise((resolve, reject) => {
		socket.emit('sendTo', adapterInstance, command, message, res => {
			if (!res) {
				return reject(new Error('No response'));
			}
			if (res.ok) {
				return resolve(res.data);
			}
			const msg = res?.error?.message || res?.error || 'Unknown error';
			return reject(new Error(String(msg)));
		});
	});
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
 * Baut das sichtbare Layout (Tabs/Panel-Container) vollständig aus der Registry.
 *
 * @returns {{layout:string,panelIds:string[],defaultPanelId:string}} Layout-Metadaten.
 */
function buildLayoutFromRegistry() {
	const registry = getRegistry();
	const comp = getActiveComposition() || { layout: 'tabs', panels: [], defaultPanel: '' };
	const layout = comp.layout === 'single' ? 'single' : 'tabs';
	const panelIds = Array.isArray(comp.panels) ? comp.panels.map(v => String(v)) : [];
	const defaultPanelId = typeof comp.defaultPanel === 'string' ? comp.defaultPanel : '';

	const root = document.querySelector('.msghub-root');
	const layoutHost = document.getElementById('msghub-layout') || root;
	if (!layoutHost) {
		return { layout, panelIds, defaultPanelId };
	}

	/**
	 * Interner Guard für Paneldefinitionen der aktuellen Registry.
	 *
	 * @param {string} id - Panel-ID.
	 * @returns {object|null} Panel-Definition oder `null`.
	 */
	const getPanelDef = id => {
		const panels = registry?.panels && typeof registry.panels === 'object' ? registry.panels : null;
		const p = panels ? panels[id] : null;
		return p && typeof p === 'object' ? p : null;
	};

	const fragment = document.createDocumentFragment();

	if (layout === 'tabs') {
		const nav = h('nav', { class: 'msghub-tabs', role: 'tablist', 'aria-label': 'MsgHub' });
		for (const pid of panelIds) {
			const def = getPanelDef(pid);
			if (!def) {
				continue;
			}
			const tabId = `tab-${pid}`;
			nav.appendChild(
				h('a', {
					class: `msghub-tab${pid === defaultPanelId ? ' is-active' : ''}`,
					href: `#${tabId}`,
					role: 'tab',
					'aria-controls': tabId,
					'data-i18n': def.titleKey || '',
					text: pid,
				}),
			);
		}
		fragment.appendChild(nav);
	}

	for (const pid of panelIds) {
		const def = getPanelDef(pid);
		if (!def) {
			continue;
		}
		const tabId = `tab-${pid}`;
		const mountId = String(def.mountId || '').trim();
		const panel = h('div', {
			id: tabId,
			class: `msghub-panel msghub-${pid}`,
			role: 'tabpanel',
		});
		if (mountId) {
			panel.appendChild(h('div', { id: mountId }));
		}
		fragment.appendChild(panel);
	}

	layoutHost.replaceChildren(fragment);
	return { layout, panelIds, defaultPanelId };
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
void sendTo;
void h;
void buildLayoutFromRegistry;
void loadCssFiles;
void loadJsFilesSequential;
void computeAssetsForComposition;
void getPanelDefinition;
void renderPanelBootError;
