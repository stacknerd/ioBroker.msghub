/* global window, document, HTMLElement, HTMLInputElement, HTMLTextAreaElement, hasAdminKey, t, lang, createUi, createAdminApi, msghubRequest, msghubSocket, adapterInstance, args, h, getPanelDefinition, win, loadJsFilesSequential, renderPanelBootError, buildLayoutFromRegistry, getActiveComposition, computeAssetsForComposition, ensureAdminI18nLoaded, loadCssFiles, initTabs, isEmbeddedInAdmin, overrideLang, createMsghubPluginUiHost */
'use strict';

/**
 * MsgHub Admin Tab: Bootstrapping und Runtime-Orchestrierung.
 *
 * Inhalt:
 * - Aufbau von `ui`, `api`, `ctx` und DOM-Elementzugriffen.
 * - Initialisierung und Lifecycle-Verwaltung der Panels.
 * - Connection-Status, i18n-Anwendung und globales Context-Menü für Eingabefelder.
 * - Reconnect-Warmup für verzögert verfügbare Backend-APIs.
 *
 * Systemeinbindung:
 * - Nutzt die zuvor geladenen Module `runtime.js`, `api.js`, `layout.js`, `ui.js`.
 * - Ist das letzte Core-Modul in der Ladereihenfolge und startet den eigentlichen Betrieb.
 *
 * Schnittstellen:
 * - Kein externes Export-Objekt; arbeitet über Event-Handler und globale Boot-Sequenz.
 * - Panels erhalten ihre Runtime über das gefrorene `ctx`.
 */

/**
 * Löst lokalisierbare Textwerte robust auf.
 *
 * Unterstützt:
 * - direkten String (ggf. i18n-Key),
 * - sprachabhängige Objektwerte (`{ en: "...", de: "..." }`).
 *
 * @param {any} value - Quellwert.
 * @returns {string} Aufgelöster Text.
 */
function pickText(value) {
	if (typeof value === 'string') {
		const s = value;
		return s.startsWith('msghub.i18n.') || hasAdminKey(s) ? t(s) : s;
	}
	if (!value || typeof value !== 'object') {
		return '';
	}
	const v = value[lang] ?? value.en ?? value.de;
	if (typeof v === 'string') {
		return v.startsWith('msghub.i18n.') || hasAdminKey(v) ? t(v) : v;
	}
	return '';
}

const elements = Object.freeze({
	get connection() {
		return document.getElementById('msghub-connection');
	},
	get pluginsRoot() {
		return document.getElementById('plugins-root');
	},
	get statsRoot() {
		return document.getElementById('stats-root');
	},
	get messagesRoot() {
		return document.getElementById('messages-root');
	},
});

const ui = createUi();
ui?.contextMenu?.setBrandingText?.('Message Hub');

const api = createAdminApi({ msghubRequest, msghubSocket, adapterInstance, lang, t, pickText, ui });

// `ctx` ist die einzige Runtime-Sicht, die Panels erhalten.
const ctx = Object.freeze({
	args,
	adapterInstance,
	msghubSocket,
	msghubRequest,
	api,
	h,
	ui,
	lang,
	elements,
});

let timezoneFallbackToastShown = false;

/**
 * Applies runtime metadata (branding + timezone policy) from `runtime.about`.
 *
 * @param {any} payload - `runtime.about` response payload.
 */
function applyRuntimeAboutPayload(payload) {
	const data = payload && typeof payload === 'object' ? payload : null;
	const title = typeof data?.title === 'string' ? data.title.trim() : '';
	const version = typeof data?.version === 'string' ? data.version.trim() : '';
	const label = `${title || 'Message Hub'} v${version || '0.0.0'}`;
	ui?.contextMenu?.setBrandingText?.(label);

	const timeData = data?.time && typeof data.time === 'object' ? data.time : null;
	const policy = api?.time?.setPolicy?.({
		timeZone: timeData?.timeZone,
		source: timeData?.source,
	});
	if (policy?.isFallbackUtc && !timezoneFallbackToastShown) {
		timezoneFallbackToastShown = true;
		api?.log?.warn?.(`AdminTab timezone fallback active: ${policy.warning || 'unknown_reason'}`);
		ui?.toast?.({
			text: t('msghub.i18n.core.admin.ui.timezone.fallbackUtc.text', policy.warning || 'unknown_reason'),
			variant: 'warning',
		});
	}

	if (isEmbeddedInAdmin) {
		const remoteLang =
			typeof data?.lang?.backendTextLanguage === 'string'
				? data.lang.backendTextLanguage.trim().toLowerCase()
				: '';
		if (remoteLang) {
			overrideLang(remoteLang);
			void ensureAdminI18nLoaded().then(() => applyStaticI18n());
		}
	}

	// Cache server metadata for the connection panel
	connPanelData = {
		serverTz: typeof data?.time?.timeZone === 'string' ? data.time.timeZone : '',
		coreTextLang: typeof data?.lang?.coreTextLanguage === 'string' ? data.lang.coreTextLanguage : '',
		coreFormatLocale: typeof data?.lang?.coreFormatLocale === 'string' ? data.lang.coreFormatLocale : '',
		backendTextLang: typeof data?.lang?.backendTextLanguage === 'string' ? data.lang.backendTextLanguage : '',
		version: typeof data?.version === 'string' ? data.version.trim() : '',
		coreConnectionConnected: typeof data?.connection?.connected === 'boolean' ? data.connection.connected : null,
	};
	updateConnectionPanel();
}

/**
 * Refreshes runtime metadata and updates shared UI policy.
 *
 * @returns {Promise<void>}
 */
async function refreshRuntimeAbout() {
	try {
		const about = await api?.runtime?.about?.();
		applyRuntimeAboutPayload(about);
	} catch {
		const policy = api?.time?.setPolicy?.({ timeZone: '', source: 'runtime-about-error' });
		if (policy?.isFallbackUtc && !timezoneFallbackToastShown) {
			timezoneFallbackToastShown = true;
			api?.log?.warn?.(`AdminTab timezone fallback active: ${policy.warning || 'runtime_about_error'}`);
			ui?.toast?.({
				text: t('msghub.i18n.core.admin.ui.timezone.fallbackUtc.text', policy.warning || 'runtime_about_error'),
				variant: 'warning',
			});
		}
	}
}

// Branding and timezone policy are refreshed as soon as runtime data is available.
void refreshRuntimeAbout();

/**
 * Liefert ein editierbares Ziel unterhalb eines Event-Targets.
 *
 * @param {EventTarget|HTMLElement|null} el - Event-Target.
 * @returns {HTMLElement|null} Editierbares Element oder `null`.
 */
function findEditableTarget(el) {
	const node = el instanceof HTMLElement ? el : null;
	if (!node) {
		return null;
	}
	const input = node.closest('input');
	if (input instanceof HTMLInputElement) {
		const type = String(input.type || '').toLowerCase();
		const textLike =
			!type ||
			type === 'text' ||
			type === 'search' ||
			type === 'url' ||
			type === 'tel' ||
			type === 'email' ||
			type === 'password' ||
			type === 'number';
		if (textLike && !input.readOnly && !input.disabled) {
			return input;
		}
	}
	const ta = node.closest('textarea');
	if (ta instanceof HTMLTextAreaElement && !ta.readOnly && !ta.disabled) {
		return ta;
	}
	const ce = node.closest('[contenteditable]');
	if (ce instanceof HTMLElement && ce.isContentEditable) {
		return ce;
	}
	return null;
}

/**
 * Liest den aktuellen Selection-Status für ein editierbares Element.
 *
 * @param {HTMLElement} editable - Ziel-Element.
 * @returns {{hasSelection:boolean,selectedText:string,start:number,end:number}} Selektionsdaten.
 */
function getEditableSelectionInfo(editable) {
	if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
		const start = Number.isFinite(Number(editable.selectionStart)) ? Number(editable.selectionStart) : 0;
		const end = Number.isFinite(Number(editable.selectionEnd)) ? Number(editable.selectionEnd) : 0;
		const hasSelection = end > start;
		const value = String(editable.value || '');
		const selectedText = hasSelection ? value.slice(start, end) : '';
		return { hasSelection, selectedText, start, end };
	}
	if (editable instanceof HTMLElement) {
		const sel = window.getSelection ? window.getSelection() : null;
		if (!sel || sel.rangeCount <= 0) {
			return { hasSelection: false, selectedText: '', start: 0, end: 0 };
		}
		const text = sel.toString();
		const range = sel.getRangeAt(0);
		const inEl = !!range && editable.contains(range.commonAncestorContainer);
		return { hasSelection: inEl && !!text, selectedText: inEl ? text : '', start: 0, end: 0 };
	}
	return { hasSelection: false, selectedText: '', start: 0, end: 0 };
}

/**
 * Markiert den gesamten Inhalt eines editierbaren Elements.
 *
 * @param {HTMLElement} editable - Ziel-Element.
 */
function selectAllInEditable(editable) {
	if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
		editable.focus();
		editable.select();
		return;
	}
	if (editable instanceof HTMLElement) {
		editable.focus();
		const sel = window.getSelection ? window.getSelection() : null;
		if (!sel) {
			return;
		}
		const range = document.createRange();
		range.selectNodeContents(editable);
		sel.removeAllRanges();
		sel.addRange(range);
	}
}

/**
 * Führt `document.execCommand` defensiv aus.
 *
 * @param {string} cmd - Command-Name (`copy`, `cut`, ...).
 * @returns {boolean} `true`, wenn der Command erfolgreich war.
 */
function execCommandSafe(cmd) {
	try {
		if (typeof document.execCommand === 'function') {
			return document.execCommand(cmd);
		}
	} catch {
		// ignore
	}
	return false;
}

/**
 * Kopiert die aktuelle Auswahl in die Zwischenablage.
 *
 * @param {HTMLElement} editable - Editierbares Element.
 * @returns {Promise<void>}
 */
async function copySelectionFromEditable(editable) {
	editable.focus();
	if (execCommandSafe('copy')) {
		return;
	}
	const info = getEditableSelectionInfo(editable);
	if (!info.selectedText) {
		return;
	}
	if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
		await navigator.clipboard.writeText(info.selectedText);
		return;
	}
	throw new Error('Copy not supported');
}

/**
 * Schneidet die aktuelle Auswahl aus und schreibt sie in die Zwischenablage.
 *
 * @param {HTMLElement} editable - Editierbares Element.
 * @returns {Promise<void>}
 */
async function cutSelectionFromEditable(editable) {
	editable.focus();
	if (execCommandSafe('cut')) {
		return;
	}
	const info = getEditableSelectionInfo(editable);
	if (!info.selectedText) {
		return;
	}
	if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
		await navigator.clipboard.writeText(info.selectedText);
	}
	if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
		const value = String(editable.value || '');
		const next = value.slice(0, info.start) + value.slice(info.end);
		editable.value = next;
		try {
			editable.setSelectionRange(info.start, info.start);
		} catch {
			// ignore
		}
		return;
	}
	throw new Error('Cut not supported');
}

/**
 * Fügt Clipboard-Text in ein editierbares Element ein.
 *
 * @param {HTMLElement} editable - Editierbares Element.
 * @returns {Promise<void>}
 */
async function pasteIntoEditable(editable) {
	editable.focus();
	if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
		const text = await navigator.clipboard.readText();
		const s = String(text ?? '');
		if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
			const info = getEditableSelectionInfo(editable);
			const value = String(editable.value || '');
			const start = Math.max(0, Math.trunc(Number(info.start) || 0));
			const end = Math.max(start, Math.trunc(Number(info.end) || 0));
			editable.value = value.slice(0, start) + s + value.slice(end);
			const caret = start + s.length;
			try {
				editable.setSelectionRange(caret, caret);
			} catch {
				// ignore
			}
			return;
		}
		if (editable instanceof HTMLElement) {
			const sel = window.getSelection ? window.getSelection() : null;
			if (!sel || sel.rangeCount <= 0) {
				return;
			}
			const range = sel.getRangeAt(0);
			if (!editable.contains(range.commonAncestorContainer)) {
				return;
			}
			range.deleteContents();
			range.insertNode(document.createTextNode(s));
			range.collapse(false);
			sel.removeAllRanges();
			sel.addRange(range);
			return;
		}
		return;
	}
	throw new Error('Paste not supported');
}

/**
 * Baut Standard-Kontextmenüeinträge für Text-Eingabefelder.
 *
 * @param {HTMLElement} editable - Editierbares Element.
 * @returns {Array<object>} Context-Menu-Items.
 */
function buildInputContextMenuItems(editable) {
	const info = getEditableSelectionInfo(editable);
	const canPaste = !!navigator.clipboard && typeof navigator.clipboard.readText === 'function';

	return [
		{
			id: 'cut',
			label: 'Cut',
			disabled: !info.hasSelection,
			onSelect: () => cutSelectionFromEditable(editable),
		},
		{
			id: 'copy',
			label: 'Copy',
			disabled: !info.hasSelection,
			onSelect: () => copySelectionFromEditable(editable),
		},
		{
			id: 'paste',
			label: 'Paste',
			disabled: !canPaste,
			onSelect: () => pasteIntoEditable(editable),
		},
		{
			id: 'selectAll',
			label: 'Select all',
			onSelect: () => selectAllInEditable(editable),
		},
	].map(it => Object.freeze(it));
}

// Global context menu replaces the browser right-click within the MsgHub root.
document.addEventListener('contextmenu', e => {
	try {
		if (!e || typeof e !== 'object') {
			return;
		}
		// Hidden bypass: Ctrl+right-click intentionally opens the native browser menu.
		if (e.ctrlKey === true) {
			try {
				ctx.api.ui.contextMenu.close();
			} catch {
				// ignore
			}
			return;
		}
		const target = e.target instanceof HTMLElement ? e.target : null;
		if (!target) {
			return;
		}
		const rootEl = target.closest('.msghub-root');
		if (!rootEl) {
			return;
		}
		if (target.closest('.msghub-spinner-host.is-blocking')) {
			e.preventDefault();
			return;
		}
		if (target.closest('.msghub-dialog-backdrop')) {
			e.preventDefault();
			return;
		}
		if (target.closest('.msghub-overlay-backdrop') && !target.closest('.msghub-overlay')) {
			e.preventDefault();
			return;
		}
		const insideMenu = target.closest('.msghub-contextmenu');
		if (insideMenu) {
			// Always block the native menu when inside the custom context menu UI.
			e.preventDefault();
			return;
		}
		// Panels may handle the event themselves (`preventDefault()`).
		if (e.defaultPrevented) {
			return;
		}

		const editable = findEditableTarget(target);

		e.preventDefault();

		const items = editable ? buildInputContextMenuItems(editable) : [];
		const anchorPoint = { x: e.clientX, y: e.clientY };
		ctx.api.ui.contextMenu.open({ items, anchorPoint, ariaLabel: 'Context menu', placement: 'bottom-start' });
	} catch {
		// ignore
	}
});

/**
 * Schreibt Layout-/Device-Infos als Root-Attribute.
 *
 * @param {'tabs'|'single'} layout - Aktive Layoutart.
 * @param {'pc'|'mobile'|'screenOnly'} deviceMode - Geräteprofil.
 */
const setConnLayout = (layout, deviceMode) => {
	const el = elements.connection;
	const l = layout === 'single' ? 'single' : 'tabs';
	const d = deviceMode === 'mobile' || deviceMode === 'screenOnly' ? deviceMode : 'pc';
	try {
		document.documentElement.setAttribute('data-msghub-layout', l);
		document.documentElement.setAttribute('data-msghub-device', d);
	} catch {
		// ignore
	}
	if (el) {
		el.removeAttribute('data-msghub-layout');
		el.removeAttribute('data-msghub-device');
	}
};

/**
 * Aktualisiert die Online/Offline-Klassen am Verbindungsbalken.
 *
 * @param {boolean} isOnline - Neuer Verbindungszustand.
 */
const setConnStatus = isOnline => {
	if (!elements.connection) {
		return;
	}
	elements.connection.classList.remove('online', 'offline');
	elements.connection.classList.add(isOnline ? 'online' : 'offline');
};

let connOnline = false;
/** RTT of the last successful ping in milliseconds, or null if unknown. */
let lastPingLatencyMs = null;
/** Cached server-side metadata for the connection panel. */
let connPanelData = {};
/** Shared toast ID for connection-status toasts (disconnect → reconnect). */
const CONN_TOAST_ID = 'msghub-connection-status';
/** True while the "connection lost" toast is active; guards the reconnect toast. */
let connLostToastActive = false;

/**
 * Wendet `data-i18n`-Texte für statische DOM-Knoten an.
 */
function applyStaticI18n() {
	for (const el of document.querySelectorAll('[data-i18n]')) {
		const key = String(el.getAttribute('data-i18n') || '').trim();
		if (!key) {
			continue;
		}
		el.textContent = pickText(key);
	}
}

/**
 * Fills all connection-panel value spans with current state.
 * Safe to call before the panel exists in the DOM.
 */
function updateConnectionPanel() {
	const set = (id, val) => {
		const el = document.getElementById(id);
		if (el) {
			el.textContent = val;
		}
	};
	const dash = '—';
	set(
		'msghub-conn-status',
		t(
			connOnline
				? 'msghub.i18n.core.admin.ui.connection.panel.connected.text'
				: 'msghub.i18n.core.admin.ui.connection.panel.disconnected.text',
		),
	);
	set(
		'msghub-conn-core-connection',
		typeof connPanelData.coreConnectionConnected === 'boolean'
			? t(
					connPanelData.coreConnectionConnected
						? 'msghub.i18n.core.admin.ui.connection.panel.connected.text'
						: 'msghub.i18n.core.admin.ui.connection.panel.disconnected.text',
				)
			: dash,
	);
	const rawHostUrl = msghubSocket?.url || msghubSocket?.io?.uri;
	let hostDisplay = dash;
	if (rawHostUrl) {
		try {
			hostDisplay = new URL(rawHostUrl).origin;
		} catch {
			hostDisplay = rawHostUrl;
		}
	}
	set('msghub-conn-host', hostDisplay);
	set('msghub-conn-adapter', adapterInstance || dash);
	set(
		'msghub-conn-latency',
		lastPingLatencyMs != null
			? t('msghub.i18n.core.admin.ui.connection.panel.value.latencyMs', lastPingLatencyMs)
			: dash,
	);
	set('msghub-conn-server-tz', connPanelData.serverTz || dash);
	set('msghub-conn-core-lang', connPanelData.coreTextLang || dash);
	set('msghub-conn-core-fmt', connPanelData.coreFormatLocale || dash);
	set('msghub-conn-backend-lang', connPanelData.backendTextLang || dash);
	set('msghub-conn-version', connPanelData.version || dash);
	set('msghub-conn-fe-tz', Intl.DateTimeFormat().resolvedOptions().timeZone || dash);
	set('msghub-conn-fe-lang', lang || dash);
	set('msghub-conn-fe-fmt', navigator.language || dash);
	// Timezone hint: visible only when server TZ differs from browser TZ
	const tzHint = document.getElementById('msghub-conn-tz-hint');
	if (tzHint) {
		const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const differ = Boolean(connPanelData.serverTz && browserTz && connPanelData.serverTz !== browserTz);
		tzHint.classList.toggle('is-hidden', !differ);
		tzHint.setAttribute('aria-hidden', differ ? 'false' : 'true');
	}
}

/**
 * Registers hover and touch interaction for the connection info panel.
 * Desktop: 400 ms delay to open on mouseenter; 300 ms grace on mouseleave.
 * Touch: tap on the trigger toggles open/closed.
 */
function initConnectionPanelInteraction() {
	const host = document.querySelector('.msghub-connpanel-host');
	const trigger = document.getElementById('msghub-connection-trigger');
	const pill = document.getElementById('msghub-connection');
	const panel = document.getElementById('msghub-connection-panel');
	if (!host || !trigger || !pill || !panel) {
		return;
	}

	/** @param {boolean} open - true to show the panel, false to hide it */
	const setPanelOpen = open => {
		panel.classList.toggle('is-open', open);
		panel.setAttribute('aria-hidden', open ? 'false' : 'true');
		trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
		if (open) {
			updateConnectionPanel();
		}
	};

	const isOpen = () => panel.classList.contains('is-open');

	/** Timer handles for hover open/close delays. */
	let hoverOpenTimer;
	let hoverCloseTimer;

	// Pill: open after 400 ms hover; cancel on quick leave
	pill.addEventListener('mouseenter', () => {
		clearTimeout(hoverCloseTimer);
		hoverOpenTimer = setTimeout(() => setPanelOpen(true), 400);
	});
	pill.addEventListener('mouseleave', () => {
		clearTimeout(hoverOpenTimer);
		hoverCloseTimer = setTimeout(() => setPanelOpen(false), 300);
	});

	// Panel: keep open while hovering (panel overflows the pill bounds)
	panel.addEventListener('mouseenter', () => clearTimeout(hoverCloseTimer));
	panel.addEventListener('mouseleave', () => {
		hoverCloseTimer = setTimeout(() => setPanelOpen(false), 300);
	});

	// Touch: tap trigger toggles
	trigger.addEventListener('touchstart', e => {
		e.preventDefault();
		setPanelOpen(!isOpen());
	});

	// Outside click closes
	document.addEventListener(
		'click',
		e => {
			if (isOpen() && e.target instanceof window.HTMLElement && !host.contains(e.target)) {
				setPanelOpen(false);
			}
		},
		true,
	);
}

const panelSections = new Map();

/**
 * Initialisiert ein Panel anhand seiner Registry-ID.
 *
 * @param {string} panelId - Panel-ID.
 * @returns {object|null} Panel-Handle (optional mit `onConnect` etc.).
 */
function initPanelById(panelId) {
	const id = String(panelId || '').trim();
	if (!id) {
		return null;
	}
	if (panelSections.has(id)) {
		return panelSections.get(id) || null;
	}

	const def = getPanelDefinition(id);
	if (!def) {
		throw new Error(`Unknown panel '${id}'`);
	}
	const initGlobal = String(def.initGlobal || '').trim();
	if (!initGlobal) {
		throw new Error(`Panel '${id}' is missing initGlobal`);
	}

	const panelApi = win[initGlobal];
	if (!panelApi?.init) {
		throw new Error(`Panel '${id}' did not register '${initGlobal}.init'`);
	}

	const mountId = String(def.mountId || '').trim();
	const mountEl = mountId ? document.getElementById(mountId) : null;
	if (mountId && !mountEl) {
		throw new Error(`Panel '${id}' mountId '${mountId}' is missing in DOM`);
	}

	const section = panelApi.init(ctx);
	panelSections.set(id, section || null);
	return section || null;
}

/**
 * Initialisiert alle Panels der aktuellen Composition inklusive Asset-Ladung.
 *
 * @param {string[]} panelIds - Panel-IDs der Composition.
 * @returns {Promise<void>}
 */
async function initPanelsForComposition(panelIds) {
	const list = Array.isArray(panelIds) ? panelIds : [];
	for (const panelId of list) {
		const def = getPanelDefinition(panelId);
		if (!def) {
			continue;
		}
		const assets = def.assets && typeof def.assets === 'object' ? def.assets : null;
		const jsList = Array.isArray(assets?.js) ? assets.js : [];

		try {
			await loadJsFilesSequential(jsList);
		} catch (err) {
			renderPanelBootError(panelId, err);
			try {
				ui?.toast?.({ text: String(err?.message || err), variant: 'danger' });
			} catch {
				// ignore
			}
			continue;
		}

		try {
			const section = initPanelById(panelId);
			if (section && msghubSocket?.connected) {
				section?.onConnect?.();
			}
		} catch (err) {
			renderPanelBootError(panelId, err);
			try {
				ui?.toast?.({ text: String(err?.message || err), variant: 'danger' });
			} catch {
				// ignore
			}
		}
	}
}

/** Tracks enabled plugin panel tabs for lazy-load mounting. Map<tabDomId, entry>. */
const pluginPanelTabMap = new Map();

/**
 * Discovers available plugin panel contributions and enables matching tab slots.
 * Enables tabs, updates their text labels, and registers entries in `pluginPanelTabMap`.
 * Per-slot failures are isolated so other slots continue unaffected.
 *
 * @param {object[]} refs - Structured plugin panel references from buildLayoutFromRegistry.
 * @param {object} host - Plugin UI host instance (from createMsghubPluginUiHost).
 * @param {object[]|null} knownContributions - Pre-fetched discover contributions, or null to fetch now.
 * @returns {Promise<string[]>} DOM tab IDs of successfully enabled plugin panel tabs.
 */
async function hydratePluginPanels(refs, host, knownContributions = null) {
	let contributions;
	if (knownContributions !== null) {
		contributions = knownContributions;
	} else {
		const r = await msghubRequest('admin.pluginUi.discover', {}).catch(() => null);
		contributions = Array.isArray(r) ? r : [];
	}

	const enabledTabIds = [];
	for (const ref of refs) {
		try {
			const key = `plugin-${ref.pluginType}-${ref.instanceId}-${ref.panelId}`;
			const tabId = `tab-${key}`;
			const container = document.getElementById(key);
			const contrib = Array.isArray(contributions)
				? contributions.find(
						c =>
							c.pluginType === ref.pluginType &&
							c.instanceId === ref.instanceId &&
							c.panelId === ref.panelId,
					)
				: null;
			if (!container || !contrib) {
				continue;
			}

			// Enable tab: remove disabled state and update label.
			const tabEl = document.querySelector(`a.msghub-tab[href="#${tabId}"]`);
			if (tabEl) {
				tabEl.removeAttribute('aria-disabled');
				tabEl.classList.remove('is-disabled');
				const label = api.i18n.pickText(contrib.title);
				if (label) {
					tabEl.textContent = label;
				}
			}

			pluginPanelTabMap.set(tabId, {
				ref,
				hash: String(contrib.bundle?.hash ?? ''),
				container,
				host,
				mountHandle: null,
			});
			enabledTabIds.push(tabId);
		} catch {
			// Isolate per-slot failures — other slots continue.
		}
	}

	return enabledTabIds;
}

let bootPromise = null;

/**
 * Führt den kompletten Bootprozess idempotent aus.
 *
 * @returns {Promise<void>} Promise auf den Bootstatus.
 */
function ensureBooted() {
	if (bootPromise) {
		return bootPromise;
	}
	bootPromise = Promise.resolve()
		.then(async () => {
			// Wildcard: discover must run before buildLayoutFromRegistry so tab list is known.
			const comp = getActiveComposition();
			const isWildcard = Array.isArray(comp?.panels) && comp.panels.length === 1 && comp.panels[0] === '*';
			let prefetchedContributions = null;
			if (isWildcard) {
				const r = await msghubRequest('admin.pluginUi.discover', {}).catch(() => null);
				prefetchedContributions = Array.isArray(r) ? r : [];
			}

			const { layout, panelIds, pluginPanelRefs, defaultPanelId } = buildLayoutFromRegistry({
				contributions: prefetchedContributions ?? [],
			});
			setConnLayout(layout, comp?.deviceMode);
			const assets = computeAssetsForComposition(panelIds);

			await ensureAdminI18nLoaded();
			const cssRes = await loadCssFiles(assets.css);
			if (cssRes?.failed?.length) {
				ui?.toast?.({ text: `Failed to load CSS: ${cssRes.failed.join(', ')}`, variant: 'danger' });
			}

			applyStaticI18n();
			updateConnectionPanel();
			initConnectionPanelInteraction();

			let tabSetActive = null;
			let initialTabId = null;
			if (layout === 'tabs') {
				const tabs = initTabs({ defaultPanelId });
				tabSetActive = tabs?.setActive ?? null;
				initialTabId = tabs?.initial ?? null;
			}

			await initPanelsForComposition(panelIds);

			if (pluginPanelRefs.length > 0) {
				const pluginUiHost = createMsghubPluginUiHost({ request: msghubRequest, api });

				// Show blocking spinner only when no panel was activated (plugin-only composition).
				const needsSpinner = initialTabId === null;
				if (needsSpinner) {
					ui?.spinner?.show?.({ blocking: true });
				}

				const enabledTabIds = await hydratePluginPanels(pluginPanelRefs, pluginUiHost, prefetchedContributions);

				if (needsSpinner) {
					// Plugin-only composition: no tab was active pre-hydration.
					// Prefer defaultPanel tab if available; fall back to first enabled tab.
					const wantedTabId = defaultPanelId ? `tab-${defaultPanelId}` : null;
					const chosenTabId =
						wantedTabId && enabledTabIds.includes(wantedTabId) ? wantedTabId : (enabledTabIds[0] ?? null);

					if (chosenTabId && tabSetActive) {
						tabSetActive(chosenTabId);
						ui?.spinner?.hide?.();
					} else {
						// All plugin panels unavailable — keep spinner; show persistent toast.
						ui?.toast?.({
							text: t('msghub.i18n.core.admin.ui.panel.unavailable.text'),
							variant: 'danger',
							persist: true,
						});
					}
				} else {
					// Mixed composition: a native panel is already active.
					// If defaultPanel is a plugin panel that was just hydrated, switch to it now.
					const wantedTabId = defaultPanelId ? `tab-${defaultPanelId}` : null;
					if (wantedTabId && enabledTabIds.includes(wantedTabId) && tabSetActive) {
						tabSetActive(wantedTabId);
					}
				}

				// Lazy-load: mount plugin bundle on first tab activation.
				document.addEventListener('msghub:tabSwitch', ({ detail }) => {
					const entry = pluginPanelTabMap.get(detail?.to);
					if (!entry || entry.mountHandle) {
						return; // Not a plugin panel tab, or already mounted.
					}
					entry.mountHandle = pluginUiHost.mount({
						container: entry.container,
						pluginType: entry.ref.pluginType,
						instanceId: String(entry.ref.instanceId),
						panelId: entry.ref.panelId,
						hash: entry.hash,
					});
				});
			}
		})
		.catch(err => {
			try {
				ui?.toast?.({ text: String(err?.message || err), variant: 'danger' });
			} catch {
				// ignore
			}
		});
	return bootPromise;
}

// Initialer Boot direkt nach DOM-Bereitschaft.
window.addEventListener('DOMContentLoaded', () => {
	void ensureBooted();
});

let connectWarmupToken = 0;
let connectWarmupPromise = null;

/**
 * Async-Sleep mit defensiver ms-Normalisierung.
 *
 * @param {number} ms - Wartedauer in Millisekunden.
 * @returns {Promise<void>}
 */
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.trunc(Number(ms) || 0))));

/**
 * Warmup-Loop: wartet auf verfügbare API-Konstanten nach Reconnect.
 *
 * @returns {Promise<boolean>} `true`, wenn Warmup erfolgreich war.
 */
async function warmupAdminApis() {
	const token = ++connectWarmupToken;
	const startedAt = Date.now();
	const maxWaitMs = 30000;
	let delayMs = 200;

	while (msghubSocket?.connected && connectWarmupToken === token && Date.now() - startedAt <= maxWaitMs) {
		try {
			await api.constants.get();
			return true;
		} catch {
			await sleepMs(delayMs + Math.trunc(Math.random() * 250));
			delayMs = Math.min(2000, Math.trunc(delayMs * 1.5));
		}
	}
	return false;
}

/**
 * Startet (oder re-used) den Warmup-Reconnect-Prozess.
 *
 * @returns {Promise<void>} Promise auf den laufenden Warmup.
 */
function triggerWarmupReconnect() {
	if (connectWarmupPromise) {
		return connectWarmupPromise;
	}
	connectWarmupPromise = Promise.resolve()
		.then(async () => {
			const ok = await warmupAdminApis();
			if (!ok || !msghubSocket?.connected) {
				return;
			}
			for (const section of panelSections.values()) {
				try {
					await section?.onConnect?.();
				} catch {
					// Panel-Fehler werden lokal behandelt und blockieren keinen Reconnect.
				}
			}
		})
		.finally(() => {
			connectWarmupPromise = null;
		});
	return connectWarmupPromise;
}

const PING_INTERVAL_MS = 15_000;
const PING_TIMEOUT_MS = 5_000;
let pingToken = 0;

/**
 * Transitions to online state and notifies all panels.
 */
function onBecomeOnline() {
	connOnline = true;
	setConnStatus(true);
	void ensureBooted().then(() => {
		void refreshRuntimeAbout();
		applyStaticI18n();
		updateConnectionPanel();
		if (connLostToastActive) {
			connLostToastActive = false;
			ui.toast({
				id: CONN_TOAST_ID,
				text: t('msghub.i18n.core.admin.ui.connection.toast.connected.text'),
				variant: 'ok',
			});
		}
		for (const section of panelSections.values()) {
			section?.onConnect?.();
		}
		void triggerWarmupReconnect();
	});
}

/**
 * Transitions to offline state and cancels any running warmup.
 */
function onBecomeOffline() {
	connOnline = false;
	setConnStatus(false);
	connectWarmupToken++;
	connectWarmupPromise = null;
	void ensureAdminI18nLoaded().then(() => {
		applyStaticI18n();
		updateConnectionPanel();
		connLostToastActive = true;
		ui.toast({
			id: CONN_TOAST_ID,
			text: t('msghub.i18n.core.admin.ui.connection.toast.disconnected.text'),
			variant: 'danger',
			persist: true,
		});
	});
}

/**
 * Sends a single ping and updates connection state based on the result.
 *
 * A response within the timeout window marks the connection as online.
 * A timeout or error marks it as offline. A superseded token (new ping
 * started) causes this ping to be silently discarded.
 *
 * @returns {Promise<void>}
 */
async function sendPing() {
	const token = ++pingToken;
	const t0 = Date.now();
	try {
		await Promise.race([
			msghubRequest('admin.ping', null),
			new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT_MS)),
		]);
		if (pingToken !== token) {
			return;
		}
		lastPingLatencyMs = Date.now() - t0;
		if (!connOnline) {
			onBecomeOnline();
		}
	} catch {
		if (pingToken !== token) {
			return;
		}
		lastPingLatencyMs = null;
		if (connOnline) {
			onBecomeOffline();
		}
	}
	// Keep the connection panel fresh after every non-superseded ping
	updateConnectionPanel();
}

// Transport-level reconnect: verify health with a ping before declaring online.
msghubSocket.on('connect', () => {
	void sendPing();
});

// Transport-level disconnect: go offline immediately, keep pinging for recovery.
msghubSocket.on('disconnect', () => {
	pingToken++;
	if (connOnline) {
		onBecomeOffline();
	}
});

// Periodic health check — catches backend-dead / silently-broken socket scenarios.
setInterval(() => void sendPing(), PING_INTERVAL_MS);

// Initial check: socket may already be connected when this script loads.
void sendPing();
