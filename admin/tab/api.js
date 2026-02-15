/* global window, document, win, hasAdminKey */
'use strict';

/**
 * MsgHub Admin Tab: API-Fassade zwischen UI/Panels und ioBroker-Backend.
 *
 * Inhalt:
 * - Utility-Helfer (`createAsyncCache`, `computeContextMenuPosition`, Icon-Normalisierung).
 * - Aufbau der stabilen `ctx.api`-Oberfläche für Panels.
 * - Kapselung aller `sendTo`-Kommandos in klar benannten API-Gruppen.
 *
 * Systemeinbindung:
 * - `boot.js` erzeugt über `createAdminApi(...)` die einzige erlaubte Backend-Schnittstelle.
 * - Panels arbeiten ausschließlich gegen `ctx.api`, nie direkt gegen Socket oder `sendTo`.
 *
 * Schnittstellen:
 * - `createAdminApi(...)` liefert ein gefrorenes API-Objekt zurück.
 * - Unterstützende Funktionen sind Dateiintern, werden aber bewusst dokumentiert,
 *   damit Wartung und spätere Extraktion in separate Module nachvollziehbar bleibt.
 */

/**
 * Erzeugt einen einheitlichen Fehler für noch nicht unterstützte API-Zweige.
 *
 * @param {string} message - Hinweis, welche Operation nicht unterstützt wird.
 * @returns {Error} Fehlerobjekt mit Name/Code zur gezielten Unterscheidung.
 */
function createNotSupportedError(message) {
	const err = Object.assign(new Error(String(message || 'Not supported')), { code: 'NOT_SUPPORTED' });
	err.name = 'NotSupportedError';
	return err;
}

/**
 * Baut einen asynchronen In-Memory-Cache mit optionalem Ablauf.
 *
 * @param {Function} fetchFn - Funktion, die den Wert bei Cache-Miss lädt.
 * @param {object} [options] - Optionale Cache-Konfiguration.
 * @param {number} [options.maxAgeMs] - Maximales Alter eines Eintrags in Millisekunden.
 * @returns {{get: Function, invalidate: Function}} Cache-API.
 */
function createAsyncCache(fetchFn, { maxAgeMs = Infinity } = {}) {
	let value = undefined;
	let hasValue = false;
	let pending = null;
	let fetchedAt = 0;

	/**
	 * Prüft, ob der aktuelle Cache-Wert noch gültig ist.
	 *
	 * @returns {boolean} `true`, wenn ein frischer Cache-Wert existiert.
	 */
	const isFresh = () => {
		if (!hasValue) {
			return false;
		}
		if (maxAgeMs === Infinity) {
			return true;
		}
		const age = Date.now() - fetchedAt;
		return age >= 0 && age <= maxAgeMs;
	};

	/**
	 * Leert den Cache explizit.
	 */
	const invalidate = () => {
		value = undefined;
		hasValue = false;
		pending = null;
		fetchedAt = 0;
	};

	/**
	 * Liefert den Cache-Wert und lädt bei Bedarf nach.
	 *
	 * @returns {Promise<any>} Aufgelöster Cache-Wert.
	 */
	const get = () => {
		if (isFresh()) {
			return Promise.resolve(value);
		}
		if (pending) {
			return pending;
		}
		pending = Promise.resolve()
			.then(() => fetchFn())
			.then(v => {
				value = v;
				hasValue = true;
				fetchedAt = Date.now();
				pending = null;
				return v;
			})
			.catch(err => {
				// Do not poison the cache on errors; allow retry.
				pending = null;
				throw err;
			});
		return pending;
	};

	return Object.freeze({ get, invalidate });
}

/**
 * Berechnet die Bildschirmposition eines Kontextmenüs inkl. Flip/Clamp-Logik.
 *
 * @param {object} params - Positions- und Viewportparameter.
 * @param {number} params.anchorX - X-Koordinate des Menüsankers.
 * @param {number} params.anchorY - Y-Koordinate des Menüsankers.
 * @param {number} params.menuWidth - Gemessene Breite des Menüs.
 * @param {number} params.menuHeight - Gemessene Höhe des Menüs.
 * @param {number} params.viewportWidth - Breite des sichtbaren Viewports.
 * @param {number} params.viewportHeight - Höhe des sichtbaren Viewports.
 * @param {'cursor'|'anchor'|'submenu'} [params.mode] - Positionierungsmodus.
 * @param {number} [params.alignHeight] - Referenzhöhe für Submenü-Ausrichtung.
 * @param {number} [params.viewportPadding] - Mindestabstand zum Viewportrand.
 * @param {number} [params.cursorOffset] - Offset vom Cursor/Anchor.
 * @returns {{x:number,y:number}} Pixelkoordinaten für CSS `left`/`top`.
 */
function computeContextMenuPosition({
	anchorX,
	anchorY,
	menuWidth,
	menuHeight,
	viewportWidth,
	viewportHeight,
	mode,
	alignHeight,
	viewportPadding,
	cursorOffset,
}) {
	const VIEWPORT_PADDING = Number.isFinite(Number(viewportPadding))
		? Math.max(0, Math.trunc(Number(viewportPadding)))
		: 8;
	const CURSOR_OFFSET = Number.isFinite(Number(cursorOffset)) ? Math.max(0, Math.trunc(Number(cursorOffset))) : 2;

	const vw = Math.max(0, Math.trunc(Number(viewportWidth) || 0));
	const vh = Math.max(0, Math.trunc(Number(viewportHeight) || 0));
	const w = Math.max(0, Math.trunc(Number(menuWidth) || 0));
	const h = Math.max(0, Math.trunc(Number(menuHeight) || 0));

	const ax = Math.max(0, Math.trunc(Number(anchorX) || 0));
	const ay = Math.max(0, Math.trunc(Number(anchorY) || 0));

	const m = mode === 'submenu' ? 'submenu' : mode === 'anchor' ? 'anchor' : 'cursor';
	const ah = Math.max(0, Math.trunc(Number(alignHeight) || 0));

	// Initial preference:
	// - cursor: bottom-right-ish (so the cursor is not "inside" the menu)
	// - anchor: below-start (aligned to anchor left; add a small gap)
	// - submenu: right-start (aligned with parent top)
	let x = m === 'submenu' ? ax : m === 'anchor' ? ax : ax + CURSOR_OFFSET;
	let y = m === 'submenu' ? ay : ay + CURSOR_OFFSET;

	// Flip if we would overflow the viewport.
	if (vw && w && x + w > vw - VIEWPORT_PADDING) {
		x = ax - w - (m === 'cursor' ? CURSOR_OFFSET : 0);
	}
	if (vh && h && y + h > vh - VIEWPORT_PADDING) {
		if (m === 'submenu' && ah > 0) {
			// Align submenu to the parent bottom when flipping up, so it "sticks" to the row.
			y = ay + ah - h;
		} else {
			y = ay - h - CURSOR_OFFSET;
		}
	}

	// Clamp to viewport padding.
	if (vw) {
		x = Math.max(VIEWPORT_PADDING, Math.min(x, Math.max(VIEWPORT_PADDING, vw - VIEWPORT_PADDING - w)));
	} else {
		x = Math.max(VIEWPORT_PADDING, x);
	}
	if (vh) {
		y = Math.max(VIEWPORT_PADDING, Math.min(y, Math.max(VIEWPORT_PADDING, vh - VIEWPORT_PADDING - h)));
	} else {
		y = Math.max(VIEWPORT_PADDING, y);
	}

	return { x, y };
}

/**
 * Wandelt einen Icon-Namen in eine CSS-Variablenreferenz um.
 *
 * @param {string} iconName - Technischer Icon-Key.
 * @returns {string} CSS-Wert (`var(--msghub-icon-...)`) oder leer bei ungültigem Input.
 */
function toContextMenuIconVar(iconName) {
	const name = typeof iconName === 'string' ? iconName.trim() : '';
	if (!/^[a-z0-9-]+$/.test(name)) {
		return '';
	}
	return `var(--msghub-icon-${name})`;
}

/**
 * Erzeugt die stabile API-Fassade für alle Panels.
 *
 * @param {object} deps - Laufzeitabhängigkeiten aus dem Bootstrapping.
 * @param {Function} deps.sendTo - Backend-Brücke für `sendTo`-Kommandos.
 * @param {any} deps.socket - Socket-Instanz zur Verbindungsprüfung.
 * @param {string} deps.adapterInstance - Adapter-Instanzkennung.
 * @param {string} deps.lang - Aktuelle Sprache.
 * @param {Function} deps.t - Übersetzungsfunktion.
 * @param {Function} deps.pickText - Text-Auflöser für mehrsprachige Felder.
 * @param {object} deps.ui - UI-Fassade (`toast`, `contextMenu`, `dialog`, ...).
 * @returns {object} Gefrorene API-Oberfläche (`ctx.api`).
 */
function createAdminApi({ sendTo, socket, adapterInstance, lang, t, pickText, ui }) {
	const registry = win.MsghubAdminTabRegistry || null;
	const viewIdRaw = document?.documentElement?.getAttribute?.('data-msghub-view') || '';
	const viewId = String(viewIdRaw || '').trim() || 'adminTab';
	const composition =
		registry && registry.compositions && typeof registry.compositions === 'object'
			? registry.compositions[viewId]
			: null;
	const panelIds = Array.isArray(composition?.panels) ? composition.panels.filter(Boolean).map(v => String(v)) : [];
	const defaultPanelId = typeof composition?.defaultPanel === 'string' ? composition.defaultPanel : '';

	const logPrefix = `msghub:${viewId}`;
	const log = Object.freeze({
		debug: (...args) => console.debug(logPrefix, ...args),
		info: (...args) => console.info(logPrefix, ...args),
		warn: (...args) => console.warn(logPrefix, ...args),
		error: (...args) => console.error(logPrefix, ...args),
	});

	const i18n = Object.freeze({
		lang: () => String(lang || 'en'),
		has: key => hasAdminKey(String(key ?? '')),
		t: (key, ...args) => t(String(key ?? ''), ...args),
		tOr: (key, fallback, ...args) => {
			const k = String(key ?? '');
			const out = t(k, ...args);
			return out === k ? String(fallback ?? '') : out;
		},
		pickText: value => pickText(value),
	});

	const rawContextMenu =
		ui?.contextMenu ||
		Object.freeze({
			open: () => {},
			close: () => {},
			isOpen: () => false,
		});

	/**
	 * Packt Kontextmenü-Items rekursiv, damit Select-Aktionen robust beendet
	 * und Fehlerszenarien sichtbar an den Nutzer zurückgemeldet werden.
	 *
	 * @param {Array<any>} items - Rohes Item-Array aus dem aufrufenden Panel.
	 * @returns {Array<any>} Defensiv verpacktes Item-Array.
	 */
	const wrapContextMenuItems = items => {
		const list = Array.isArray(items) ? items : [];
		return list.filter(Boolean).map(item => {
			const it = item && typeof item === 'object' ? item : {};
			const children = it.items ? wrapContextMenuItems(it.items) : undefined;
			const onSelectRaw = typeof it.onSelect === 'function' ? it.onSelect : null;

			const onSelect =
				onSelectRaw &&
				(() => {
					try {
						rawContextMenu.close();
					} catch {
						// ignore
					}

					let waitShown = false;
					let waitTimer = null;

					try {
						waitTimer = window.setTimeout(() => {
							waitShown = true;
							try {
								ui?.toast?.({ text: t('msghub.i18n.core.admin.ui.contextMenu.wait.text') });
							} catch {
								// ignore
							}
						}, 100);
					} catch {
						// ignore
					}

					/**
					 * Räumt den "Warten..."-Timer auf, sobald eine Aktion endet.
					 */
					const clearWaitTimer = () => {
						if (waitTimer == null) {
							return;
						}
						try {
							window.clearTimeout(waitTimer);
						} catch {
							// ignore
						}
						waitTimer = null;
					};

					return Promise.resolve()
						.then(() => onSelectRaw())
						.then(result => {
							clearWaitTimer();
							if (waitShown) {
								try {
									ui?.toast?.({ text: t('msghub.i18n.core.admin.ui.contextMenu.done.text') });
								} catch {
									// ignore
								}
							}
							return result;
						})
						.catch(err => {
							clearWaitTimer();
							const msg =
								typeof err?.message === 'string' && err.message.trim()
									? err.message.trim()
									: typeof err === 'string' && err.trim()
										? err.trim()
										: 'Error';
							try {
								ui?.toast?.({ text: t('msghub.i18n.core.admin.ui.contextMenu.failed.text', msg) });
							} catch {
								// ignore
							}
							throw err;
						});
				});

			return Object.freeze({
				...it,
				...(children ? { items: children } : {}),
				...(onSelect ? { onSelect } : {}),
			});
		});
	};

	// `uiApi` ist der einzige UI-Einstiegspunkt für Panels.
	const uiApi = Object.freeze({
		toast: opts => ui?.toast?.(opts),
		contextMenu: Object.freeze({
			open: opts => {
				const o = opts && typeof opts === 'object' ? opts : {};
				const items = wrapContextMenuItems(o.items);
				return rawContextMenu.open({ ...o, items });
			},
			close: () => rawContextMenu.close(),
			isOpen: () => rawContextMenu.isOpen(),
		}),
		overlayLarge: ui?.overlayLarge || Object.freeze({ open: () => {}, close: () => {}, isOpen: () => false }),
		dialog:
			ui?.dialog ||
			Object.freeze({ confirm: () => Promise.resolve(false), close: () => {}, isOpen: () => false }),
		closeAll: () => ui?.closeAll?.(),
	});

	// Host-Metadaten geben Panels Kontext über laufende Composition und Verbindungszustand.
	const host = Object.freeze({
		viewId,
		layout: composition?.layout || 'tabs',
		deviceMode: composition?.deviceMode || 'pc',
		panels: Object.freeze(panelIds),
		defaultPanel: defaultPanelId,
		adapterInstance,
		isConnected: () => !!socket?.connected,
	});

	/**
	 * Hilfsfunktion für absichtlich deaktivierte API-Zweige.
	 *
	 * @param {string} method - Name der angeforderten Operation.
	 * @throws {Error} Immer.
	 */
	const notSupported = method => {
		throw createNotSupportedError(method);
	};

	// Konstanten werden stark gecacht, da sie sich zur Laufzeit selten ändern.
	const constantsCache = createAsyncCache(() => sendTo('admin.constants.get', {}), { maxAgeMs: Infinity });
	const ingestStatesConstantsCache = createAsyncCache(() => sendTo('admin.ingestStates.constants.get', {}), {
		maxAgeMs: Infinity,
	});

	const constants = Object.freeze({
		get: () => constantsCache.get(),
		invalidate: () => constantsCache.invalidate(),
	});

	const stats = Object.freeze({
		get: params => sendTo('admin.stats.get', params || {}),
	});

	const messages = Object.freeze({
		query: params => sendTo('admin.messages.query', params || {}),
		delete: refs => sendTo('admin.messages.delete', { refs }),
	});

	const plugins = Object.freeze({
		getCatalog: () => sendTo('admin.plugins.getCatalog', {}),
		listInstances: () => sendTo('admin.plugins.listInstances', {}),
		createInstance: params => sendTo('admin.plugins.createInstance', params || {}),
		updateInstance: params => sendTo('admin.plugins.updateInstance', params || {}),
		setEnabled: params => sendTo('admin.plugins.setEnabled', params || {}),
		deleteInstance: params => sendTo('admin.plugins.deleteInstance', params || {}),
	});

	const ingestStates = Object.freeze({
		constants: Object.freeze({
			get: () => ingestStatesConstantsCache.get(),
			invalidate: () => ingestStatesConstantsCache.invalidate(),
		}),
		schema: Object.freeze({
			get: () => sendTo('admin.ingestStates.schema.get', {}),
		}),
		custom: Object.freeze({
			read: params => sendTo('admin.ingestStates.custom.read', params || {}),
		}),
		bulkApply: Object.freeze({
			preview: params => sendTo('admin.ingestStates.bulkApply.preview', params || {}),
			apply: params => sendTo('admin.ingestStates.bulkApply.apply', params || {}),
		}),
		presets: Object.freeze({
			list: () => sendTo('admin.ingestStates.presets.list', {}),
			get: params => sendTo('admin.ingestStates.presets.get', params || {}),
			delete: params => sendTo('admin.ingestStates.presets.delete', params || {}),
			upsert: params => sendTo('admin.ingestStates.presets.upsert', params || {}),
		}),
	});

	const runtime = Object.freeze({
		about: () => sendTo('runtime.about', {}),
	});

	// Stabile API-Oberfläche: Panels sprechen ausschließlich mit `ctx.api`.
	return Object.freeze({
		i18n,
		ui: uiApi,
		log,
		host,
		constants,
		runtime,
		stats,
		messages,
		plugins,
		ingestStates,
		notSupported,
	});
}

void computeContextMenuPosition;
void toContextMenuIconVar;
void createAdminApi;
