/* global window, document, HTMLElement, HTMLInputElement, HTMLTextAreaElement, hasAdminKey, t, lang, createUi, createAdminApi, sendTo, socket, adapterInstance, args, h, getPanelDefinition, win, loadJsFilesSequential, renderPanelBootError, buildLayoutFromRegistry, getActiveComposition, computeAssetsForComposition, ensureAdminI18nLoaded, loadCssFiles, initTabs */
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

const api = createAdminApi({ sendTo, socket, adapterInstance, lang, t, pickText, ui });

// `ctx` ist die einzige Runtime-Sicht, die Panels erhalten.
const ctx = Object.freeze({
	args,
	adapterInstance,
	socket,
	sendTo,
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
		ui?.toast?.(t('msghub.i18n.core.admin.ui.timezone.fallbackUtc.text', policy.warning || 'unknown_reason'));
	}
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
			ui?.toast?.(
				t('msghub.i18n.core.admin.ui.timezone.fallbackUtc.text', policy.warning || 'runtime_about_error'),
			);
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

// Globales Context-Menü ersetzt Browser-Right-Click innerhalb der MsgHub-Root.
document.addEventListener('contextmenu', e => {
	try {
		if (!e || typeof e !== 'object') {
			return;
		}
		// Versteckter Bypass: Ctrl+Right-Click öffnet bewusst das native Browser-Menü.
		if (e.ctrlKey === true) {
			try {
				ctx.api.ui.contextMenu.close();
			} catch {
				// ignore
			}
			return;
		}
		if (ctx.api.ui.dialog?.isOpen?.()) {
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
		const insideMenu = target.closest('.msghub-contextmenu');
		if (insideMenu) {
			// Auf eigener Menü-UI immer das native Menü blocken.
			e.preventDefault();
			return;
		}
		// Panels dürfen das Event selbst übernehmen (`preventDefault()`).
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
 * Setzt den Verbindungsstatus-Text.
 *
 * @param {string} text - Sichtbarer Status-Text.
 */
const setConnText = text => {
	if (elements.connection) {
		elements.connection.textContent = text;
	}
};

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
 * Setzt den Connection-Text basierend auf dem aktuellen Online-Status.
 */
function setConnTextFromState() {
	const key = connOnline
		? 'msghub.i18n.core.admin.ui.connection.connected.text'
		: 'msghub.i18n.core.admin.ui.connection.disconnected.text';
	setConnText(t(key, adapterInstance));
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
				ui?.toast?.(String(err?.message || err));
			} catch {
				// ignore
			}
			continue;
		}

		try {
			const section = initPanelById(panelId);
			if (section && socket?.connected) {
				section?.onConnect?.();
			}
		} catch (err) {
			renderPanelBootError(panelId, err);
			try {
				ui?.toast?.(String(err?.message || err));
			} catch {
				// ignore
			}
		}
	}
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
			const { layout, panelIds, defaultPanelId } = buildLayoutFromRegistry();
			const comp = getActiveComposition();
			setConnLayout(layout, comp?.deviceMode);
			const assets = computeAssetsForComposition(panelIds);

			await ensureAdminI18nLoaded();
			const cssRes = await loadCssFiles(assets.css);
			if (cssRes?.failed?.length) {
				ui?.toast?.(`Failed to load CSS: ${cssRes.failed.join(', ')}`);
			}

			applyStaticI18n();
			setConnTextFromState();

			if (layout === 'tabs') {
				initTabs({ defaultPanelId });
			}

			await initPanelsForComposition(panelIds);
		})
		.catch(err => {
			try {
				ui?.toast?.(String(err?.message || err));
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

	while (socket?.connected && connectWarmupToken === token && Date.now() - startedAt <= maxWaitMs) {
		try {
			await api.constants.get();
			await api.ingestStates?.constants?.get?.();
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
			if (!ok || !socket?.connected) {
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

socket.on('connect', () => {
	connOnline = true;
	setConnStatus(true);
	void ensureBooted().then(() => {
		void refreshRuntimeAbout();
		applyStaticI18n();
		setConnTextFromState();
		for (const section of panelSections.values()) {
			section?.onConnect?.();
		}
		void triggerWarmupReconnect();
	});
});

socket.on('disconnect', () => {
	connOnline = false;
	setConnStatus(false);
	connectWarmupToken++;
	connectWarmupPromise = null;
	void ensureAdminI18nLoaded().then(() => {
		applyStaticI18n();
		setConnTextFromState();
	});
});
