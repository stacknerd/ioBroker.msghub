/* global window, document, Node, HTMLElement, HTMLButtonElement, computeContextMenuPosition, toContextMenuIconVar */
'use strict';

/**
 * MsgHub Admin Tab: UI-Primitives und globale Interaktionsschicht.
 *
 * Inhalt:
 * - Toast-System.
 * - Kontextmenü-Engine mit Untermenüs, Positionierung und globalen Close-Triggern.
 * - Großes Overlay (Detailansicht) und kleines Bestätigungsdialog-Primitive.
 * - Globale Escape-/TabSwitch-Reaktionen zum konsistenten Schließen von Overlays.
 *
 * Systemeinbindung:
 * - Wird von `boot.js` genau einmal erzeugt (`createUi()`).
 * - Panels nutzen die resultierenden Funktionen über `ctx.api.ui`.
 *
 * Schnittstellen:
 * - Rückgabeobjekt mit `toast`, `contextMenu`, `overlayLarge`, `dialog`, `closeAll`.
 * - Keine direkte Backend-Logik; rein visuelles Verhalten und DOM-Interaktion.
 */

/**
 * Erzeugt alle UI-Primitives und bindet globale Event-Listener.
 *
 * @returns {object} Gefrorenes UI-Objekt für `ctx.api.ui`.
 */
function createUi() {
	const root = document.querySelector('.msghub-root');

	const toastHost =
		document.getElementById('msghub-toast-host') ||
		(() => {
			const el = document.createElement('div');
			el.id = 'msghub-toast-host';
			el.className = 'msghub-toast-host is-hidden';
			el.setAttribute('aria-hidden', 'true');
			el.setAttribute('aria-live', 'polite');
			el.setAttribute('aria-atomic', 'true');
			el.setAttribute('aria-relevant', 'additions text');
			(root || document.body).appendChild(el);
			return el;
		})();

	const overlayBackdrop =
		document.getElementById('msghub-overlay-large') ||
		(() => {
			const el = document.createElement('div');
			el.id = 'msghub-overlay-large';
			el.className = 'msghub-overlay-backdrop is-hidden';
			el.setAttribute('aria-hidden', 'true');
			(root || document.body).appendChild(el);
			return el;
		})();
	const overlayTitle = document.getElementById('msghub-overlay-large-title');
	const overlayBody = document.getElementById('msghub-overlay-large-body');
	const overlayClose = document.getElementById('msghub-overlay-large-close');

	const dialogBackdrop =
		document.getElementById('msghub-dialog-small') ||
		(() => {
			const el = document.createElement('div');
			el.id = 'msghub-dialog-small';
			el.className = 'msghub-dialog-backdrop is-hidden';
			el.setAttribute('aria-hidden', 'true');
			(root || document.body).appendChild(el);
			return el;
		})();
	const dialogTitle = document.getElementById('msghub-dialog-small-title');
	const dialogBody = document.getElementById('msghub-dialog-small-body');
	const dialogBtnCancel = document.getElementById('msghub-dialog-small-cancel');
	const dialogBtnConfirm = document.getElementById('msghub-dialog-small-confirm');

	/**
	 * Schaltet die Root-CSS-Klasse für aktiven Modalzustand.
	 *
	 * @param {boolean} isOpen - `true`, wenn ein Modal offen ist.
	 */
	const setRootModalOpen = isOpen => {
		if (root) {
			root.classList.toggle('is-modal-open', isOpen);
		}
	};

	/**
	 * Zeigt eine kurze Toast-Nachricht an.
	 *
	 * @param {string|object} opts - Text oder Optionen mit `text`/`timeoutMs`.
	 */
	const toast = opts => {
		const text = typeof opts === 'string' ? opts : String(opts?.text ?? opts?.html ?? '');
		const timeoutMsRaw = typeof opts === 'object' && opts ? opts.timeoutMs : undefined;
		const timeoutMs = Number.isFinite(Number(timeoutMsRaw))
			? Math.max(250, Math.trunc(Number(timeoutMsRaw)))
			: 2500;
		if (!text.trim()) {
			return;
		}

		const el = document.createElement('div');
		el.className = 'msghub-toast';
		el.textContent = text;
		toastHost.appendChild(el);
		toastHost.classList.remove('is-hidden');
		toastHost.setAttribute('aria-hidden', 'false');

		window.setTimeout(() => {
			try {
				el.remove();
				if (!toastHost.childElementCount) {
					toastHost.classList.add('is-hidden');
					toastHost.setAttribute('aria-hidden', 'true');
				}
			} catch {
				// ignore
			}
		}, timeoutMs);
	};

	// Context menu (Phase 2: DOM + minimal CSS; always in DOM, default-hidden)
	const hideTimers = new WeakMap();

	const contextMenuHost =
		document.getElementById('msghub-contextmenu') ||
		(() => {
			const el = document.createElement('div');
			el.id = 'msghub-contextmenu';
			el.className = 'msghub-contextmenu-host is-hidden';
			el.setAttribute('aria-hidden', 'true');
			(root || document.body).appendChild(el);
			return el;
		})();

	const contextMenuEl = document.createElement('div');
	contextMenuEl.className = 'msghub-contextmenu';
	contextMenuHost.appendChild(contextMenuEl);

	const contextMenuList = document.createElement('ul');
	contextMenuList.className = 'msghub-contextmenu-list';
	contextMenuList.setAttribute('role', 'menu');
	contextMenuEl.appendChild(contextMenuList);

	let contextMenuBrandingText = 'Message Hub v0.0.1';

	let contextMenuIsOpen = false;
	let contextMenuState = null;
	const contextMenuStack = [];

	/**
	 * Schaltet Sichtbarkeit/ARIA-Zustand des Kontextmenü-Hosts.
	 *
	 * @param {boolean} isOpen - Zielzustand.
	 */
	const contextMenuSetOpen = isOpen => {
		contextMenuIsOpen = !!isOpen;
		contextMenuHost.classList.toggle('is-hidden', !contextMenuIsOpen);
		contextMenuHost.setAttribute('aria-hidden', contextMenuIsOpen ? 'false' : 'true');
	};

	/**
	 * Stellt sicher, dass das Root-Menü als erstes Stack-Element existiert.
	 *
	 * @param {HTMLElement} menuEl - Menü-Container.
	 * @param {HTMLElement} listEl - Menü-Liste.
	 * @param {HTMLElement|null} parentButton - Trigger-Button bei Submenüs.
	 */
	const ensureMenuInStack = (menuEl, listEl, parentButton) => {
		if (!contextMenuStack.length) {
			contextMenuStack.push({ menuEl, listEl, parentButton: parentButton || null });
		}
	};

	/**
	 * Schließt Submenüs bis zur gewünschten Tiefe.
	 *
	 * @param {number} depth - Zieltiefe, die erhalten bleiben soll.
	 */
	const closeContextMenuLevel = depth => {
		const d = Math.max(0, Math.trunc(Number(depth) || 0));
		while (contextMenuStack.length > d + 1) {
			const last = contextMenuStack.pop();
			try {
				last?.parentButton?.classList?.remove?.('is-submenu-open');
			} catch {
				// ignore
			}
			try {
				last?.menuEl?.remove?.();
			} catch {
				// ignore
			}
		}
	};

	/**
	 * Schließt alle Menüebenen und leert den transienten Zustand.
	 */
	const closeAllContextMenus = () => {
		closeContextMenuLevel(0);
		contextMenuState = null;
		contextMenuSetOpen(false);
	};

	/**
	 * Rendert Menüeinträge einer Ebene inkl. Sondertypen und Footer.
	 *
	 * @param {HTMLElement} listEl - Ziel-Liste.
	 * @param {Array<object>} items - Menüeinträge.
	 * @param {number} depth - Tiefe (0 = Root-Menü).
	 */
	const renderContextMenuItems = (listEl, items, depth = 0) => {
		const hoverEnabled = (() => {
			try {
				return window.matchMedia && !window.matchMedia('(pointer: coarse)').matches;
			} catch {
				return true;
			}
		})();
		const HOVER_DELAY_MS = 150;
		let hoverTimer = null;
		let hoverBtn = null;

		const list = Array.isArray(items) ? items : [];
		const nodes = [];

		for (const item of list) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const type = typeof item.type === 'string' ? item.type : 'item';

			if (type === 'separator') {
				const li = document.createElement('li');
				li.setAttribute('role', 'none');
				const sep = document.createElement('div');
				sep.className = 'msghub-contextmenu-separator';
				sep.setAttribute('aria-hidden', 'true');
				li.appendChild(sep);
				nodes.push(li);
				continue;
			}

			if (type === 'label') {
				const label = typeof item.label === 'string' ? item.label : '';
				if (!label) {
					continue;
				}
				const li = document.createElement('li');
				li.setAttribute('role', 'none');

				const heading = document.createElement('div');
				heading.className = 'msghub-contextmenu-heading';

				const slot = document.createElement('span');
				slot.className = 'msghub-contextmenu-icon-slot';
				heading.appendChild(slot);

				const text = document.createElement('span');
				text.className = 'msghub-contextmenu-heading-text';
				text.textContent = label;
				heading.appendChild(text);

				li.appendChild(heading);
				nodes.push(li);
				continue;
			}

			if (type === 'checkbox') {
				const label = typeof item.label === 'string' ? item.label : '';
				const shortcut = typeof item.shortcut === 'string' ? item.shortcut : '';
				const disabled = !!item.disabled;
				const danger = item.danger === true;
				const primary = item.primary === true;
				const checked = item.checked === true;
				const id = typeof item.id === 'string' ? item.id.trim() : '';

				const li = document.createElement('li');
				li.setAttribute('role', 'none');

				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'msghub-contextmenu-item';
				btn.classList.add('msghub-contextmenu-item--checkbox');
				btn.setAttribute('role', 'menuitemcheckbox');
				btn.setAttribute('aria-checked', checked ? 'true' : 'false');
				if (id) {
					btn.setAttribute('data-msghub-contextmenu-id', id);
				}
				btn.disabled = disabled;
				if (disabled) {
					btn.setAttribute('aria-disabled', 'true');
				}
				if (danger) {
					btn.classList.add('is-danger');
				}
				if (primary) {
					btn.classList.add('is-primary');
				}

				const row = document.createElement('span');
				row.className = 'msghub-contextmenu-row';

				let checkIconEl = null;
				{
					const slot = document.createElement('span');
					slot.className = 'msghub-contextmenu-icon-slot';
					const iconEl = document.createElement('span');
					iconEl.className = 'msghub-contextmenu-icon';
					iconEl.setAttribute('aria-hidden', 'true');
					iconEl.style.setProperty('--msghub-contextmenu-icon', toContextMenuIconVar('check'));
					slot.appendChild(iconEl);
					checkIconEl = iconEl;
					row.appendChild(slot);
				}

				const labelEl = document.createElement('span');
				labelEl.className = 'msghub-contextmenu-label';
				labelEl.textContent = label;
				row.appendChild(labelEl);

				const meta = document.createElement('span');
				meta.className = 'msghub-contextmenu-meta';
				if (shortcut) {
					const s = document.createElement('span');
					s.className = 'msghub-contextmenu-shortcut';
					s.textContent = shortcut;
					meta.appendChild(s);
				}
				row.appendChild(meta);

				btn.appendChild(row);

				/**
				 * Aktualisiert Checkmark und ARIA-State für Checkbox-Menüeinträge.
				 *
				 * @param {boolean} isChecked - Neuer Zustand.
				 */
				const setCheckedUI = isChecked => {
					btn.setAttribute('aria-checked', isChecked ? 'true' : 'false');
					if (checkIconEl) {
						checkIconEl.style.opacity = isChecked ? '1' : '0';
					}
				};

				setCheckedUI(checked);

				if (!disabled && typeof item.onToggle === 'function') {
					btn.addEventListener('click', () => {
						const next = btn.getAttribute('aria-checked') !== 'true';
						setCheckedUI(next);
						Promise.resolve()
							.then(() => item.onToggle(next))
							.catch(() => {
								// On error: revert optimistic UI.
								setCheckedUI(!next);
							});
					});
				} else if (!disabled && typeof item.onSelect === 'function') {
					btn.addEventListener('click', () => {
						Promise.resolve()
							.then(() => item.onSelect())
							.catch(() => undefined);
					});
				}

				li.appendChild(btn);
				nodes.push(li);
				continue;
			}

			const label = typeof item.label === 'string' ? item.label : '';
			const shortcut = typeof item.shortcut === 'string' ? item.shortcut : '';
			const hasSubmenu = Array.isArray(item.items) && item.items.length > 0;
			const disabled = !!item.disabled;
			const danger = item.danger === true;
			const primary = item.primary === true;
			const icon = toContextMenuIconVar(item.icon);
			const id = typeof item.id === 'string' ? item.id.trim() : '';

			const li = document.createElement('li');
			li.setAttribute('role', 'none');

			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'msghub-contextmenu-item';
			btn.setAttribute('role', 'menuitem');
			if (id) {
				btn.setAttribute('data-msghub-contextmenu-id', id);
			}
			btn.disabled = disabled;
			if (disabled) {
				btn.setAttribute('aria-disabled', 'true');
			}
			if (danger) {
				btn.classList.add('is-danger');
			}
			if (primary) {
				btn.classList.add('is-primary');
			}
			if (hasSubmenu) {
				btn.classList.add('has-submenu');
			}

			const row = document.createElement('span');
			row.className = 'msghub-contextmenu-row';

			{
				const slot = document.createElement('span');
				slot.className = 'msghub-contextmenu-icon-slot';
				if (icon) {
					const iconEl = document.createElement('span');
					iconEl.className = 'msghub-contextmenu-icon';
					iconEl.setAttribute('aria-hidden', 'true');
					iconEl.style.setProperty('--msghub-contextmenu-icon', icon);
					slot.appendChild(iconEl);
				}
				row.appendChild(slot);
			}

			const labelEl = document.createElement('span');
			labelEl.className = 'msghub-contextmenu-label';
			labelEl.textContent = label;
			row.appendChild(labelEl);

			const meta = document.createElement('span');
			meta.className = 'msghub-contextmenu-meta';

			if (shortcut) {
				const s = document.createElement('span');
				s.className = 'msghub-contextmenu-shortcut';
				s.textContent = shortcut;
				meta.appendChild(s);
			}

			if (hasSubmenu) {
				const arrow = document.createElement('span');
				arrow.className = 'msghub-contextmenu-submenu';
				arrow.setAttribute('aria-hidden', 'true');
				arrow.textContent = '›';
				meta.appendChild(arrow);
			}

			row.appendChild(meta);
			btn.appendChild(row);

			if (!disabled && hasSubmenu) {
				btn.addEventListener('click', () => {
					openSubmenu(depth + 1, btn, item.items);
				});

				if (hoverEnabled) {
					btn.addEventListener('pointerenter', () => {
						try {
							if (hoverTimer != null) {
								window.clearTimeout(hoverTimer);
							}
						} catch {
							// ignore
						}
						hoverBtn = btn;
						try {
							hoverTimer = window.setTimeout(() => {
								if (hoverBtn === btn) {
									openSubmenu(depth + 1, btn, item.items);
								}
							}, HOVER_DELAY_MS);
						} catch {
							// ignore
						}
					});
					btn.addEventListener('pointerleave', () => {
						try {
							if (hoverTimer != null) {
								window.clearTimeout(hoverTimer);
							}
						} catch {
							// ignore
						}
						hoverTimer = null;
						if (hoverBtn === btn) {
							hoverBtn = null;
						}
					});
				}
			} else if (!disabled && typeof item.onSelect === 'function') {
				btn.addEventListener('click', () => {
					Promise.resolve()
						.then(() => item.onSelect())
						.catch(() => undefined);
				});
			}

			li.appendChild(btn);
			nodes.push(li);
		}

		if (depth === 0) {
			// Branding footer (always present on root, disabled/non-interactive).
			const footerLi = document.createElement('li');
			footerLi.setAttribute('role', 'none');

			const footer = document.createElement('div');
			footer.className = 'msghub-contextmenu-footer';

			const slot = document.createElement('span');
			slot.className = 'msghub-contextmenu-icon-slot';
			footer.appendChild(slot);

			const text = document.createElement('span');
			text.className = 'msghub-contextmenu-footer-text';
			text.textContent = String(contextMenuBrandingText || '').trim() || 'Message Hub';
			footer.appendChild(text);

			footerLi.appendChild(footer);
			nodes.push(footerLi);
		}

		listEl.replaceChildren(...nodes);
	};

	/**
	 * Ermittelt den effektiven Ankerpunkt aus explizitem Punkt oder Anchor-Element.
	 *
	 * @param {object} state - Kontextmenüzustand.
	 * @returns {{x:number,y:number}} Aufgelöster Pixelanker.
	 */
	const applyContextMenuAnchor = state => {
		const s = state && typeof state === 'object' ? state : {};
		const p = s.anchorPoint && typeof s.anchorPoint === 'object' ? s.anchorPoint : null;
		const el = s.anchorEl instanceof HTMLElement ? s.anchorEl : null;

		let x = 0;
		let y = 0;
		if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
			x = Math.max(0, Math.trunc(Number(p.x)));
			y = Math.max(0, Math.trunc(Number(p.y)));
		} else if (el) {
			try {
				const r = el.getBoundingClientRect();
				x = Math.max(0, Math.trunc(r.left));
				y = Math.max(0, Math.trunc(r.bottom));
			} catch {
				// ignore
			}
		}
		return { x, y };
	};

	/**
	 * Positioniert ein Menüelement anhand der Clamp/Flip-Logik.
	 *
	 * @param {HTMLElement} menuEl - Zu positionierendes Menü.
	 * @param {number} anchorX - X-Anker.
	 * @param {number} anchorY - Y-Anker.
	 * @param {object} [options] - Positionierungsoptionen.
	 * @param {'cursor'|'anchor'|'submenu'} [options.mode] - Positionierungsmodus.
	 * @param {number} [options.alignHeight] - Referenzhöhe für Submenü-Ausrichtung.
	 * @param {number} [options.cursorOffset] - Offset vom Cursor/Anchor.
	 */
	const positionMenuWithClamp = (
		menuEl,
		anchorX,
		anchorY,
		{ mode = 'cursor', alignHeight = 0, cursorOffset = 2 } = {},
	) => {
		// Force layout: measure menu after it's in DOM and visible (visibility:hidden is fine).
		let rect;
		try {
			rect = menuEl.getBoundingClientRect();
		} catch {
			rect = null;
		}
		const w = rect ? Math.max(0, Math.ceil(rect.width)) : 0;
		const h = rect ? Math.max(0, Math.ceil(rect.height)) : 0;
		const vw = Math.max(0, Math.trunc(Number(window.innerWidth) || 0));
		const vh = Math.max(0, Math.trunc(Number(window.innerHeight) || 0));

		const pos = computeContextMenuPosition({
			anchorX,
			anchorY,
			menuWidth: w,
			menuHeight: h,
			viewportWidth: vw,
			viewportHeight: vh,
			mode,
			alignHeight,
			viewportPadding: 8,
			cursorOffset,
		});

		menuEl.style.left = `${pos.x}px`;
		menuEl.style.top = `${pos.y}px`;
	};

	/**
	 * Schließt das Kontextmenü bei Pointerdown außerhalb des Menühosts.
	 *
	 * @param {Event} ev - Pointer-Event.
	 */
	const onContextMenuDocPointerDown = ev => {
		if (!contextMenuIsOpen) {
			return;
		}
		const target = ev?.target instanceof Node ? ev.target : null;
		if (target && contextMenuHost.contains(target)) {
			return;
		}
		contextMenuClose();
	};

	document.addEventListener('pointerdown', onContextMenuDocPointerDown, true);

	/**
	 * Schließt das Kontextmenü bei Scroll-Wheel außerhalb.
	 *
	 * @param {Event} ev - Wheel-Event.
	 */
	const onContextMenuWheel = ev => {
		if (!contextMenuIsOpen) {
			return;
		}
		const target = ev?.target instanceof Node ? ev.target : null;
		if (target && contextMenuHost.contains(target)) {
			return;
		}
		contextMenuClose();
	};
	document.addEventListener('wheel', onContextMenuWheel, { capture: true, passive: true });

	/**
	 * Schließt das Kontextmenü bei Container-Scroll außerhalb.
	 *
	 * @param {Event} ev - Scroll-Event.
	 */
	const onContextMenuScroll = ev => {
		if (!contextMenuIsOpen) {
			return;
		}
		const target = ev?.target instanceof Node ? ev.target : null;
		if (target && contextMenuHost.contains(target)) {
			return;
		}
		contextMenuClose();
	};
	// Use capture to also catch scroll on nested containers (scroll doesn't bubble).
	window.addEventListener('scroll', onContextMenuScroll, true);

	/**
	 * Schließt das Kontextmenü bei Fenster-Resize.
	 */
	const onContextMenuResize = () => {
		if (!contextMenuIsOpen) {
			return;
		}
		contextMenuClose();
	};
	window.addEventListener('resize', onContextMenuResize, { passive: true });

	/**
	 * Schließt das Kontextmenü, wenn das Dokument in den Hintergrund wechselt.
	 */
	const onContextMenuVisibility = () => {
		if (!contextMenuIsOpen) {
			return;
		}
		if (document.visibilityState === 'hidden') {
			contextMenuClose();
		}
	};
	document.addEventListener('visibilitychange', onContextMenuVisibility);

	/**
	 * Öffnet das Root-Kontextmenü mit neuem Zustand und positioniert es.
	 *
	 * @param {object} opts - Menüoptionen.
	 */
	const contextMenuOpen = opts => {
		const o = opts && typeof opts === 'object' ? opts : {};
		const items = Array.isArray(o.items) ? o.items : [];
		const anchorPoint = o.anchorPoint && typeof o.anchorPoint === 'object' ? o.anchorPoint : null;
		const anchorEl = o.anchorEl instanceof HTMLElement ? o.anchorEl : null;
		const placement = typeof o.placement === 'string' ? o.placement : '';
		const ariaLabel = typeof o.ariaLabel === 'string' ? o.ariaLabel : '';

		contextMenuState = Object.freeze({ items, anchorPoint, anchorEl, placement, ariaLabel });
		contextMenuList.setAttribute('aria-label', ariaLabel || 'Context menu');
		ensureMenuInStack(contextMenuEl, contextMenuList, null);
		closeContextMenuLevel(0);
		renderContextMenuItems(contextMenuList, items, 0);
		contextMenuSetOpen(true);

		// Positioning (Phase 3): measure, flip/clamp to viewport, avoid cursor-on-item.
		const anchor = applyContextMenuAnchor(contextMenuState);
		contextMenuEl.style.visibility = 'hidden';
		const mode = placement === 'anchor' || placement === 'below-start' ? 'anchor' : 'cursor';
		positionMenuWithClamp(contextMenuEl, anchor.x, anchor.y, { mode, cursorOffset: mode === 'anchor' ? 4 : 2 });
		contextMenuEl.style.visibility = '';

		try {
			document.dispatchEvent(new CustomEvent('msghub:contextMenuOpen', { detail: contextMenuState }));
		} catch {
			// ignore
		}
	};

	/**
	 * Schließt das Root-Kontextmenü und feuert das Close-Event.
	 */
	const contextMenuClose = () => {
		if (!contextMenuIsOpen) {
			return;
		}
		closeAllContextMenus();
		try {
			document.dispatchEvent(new CustomEvent('msghub:contextMenuClose'));
		} catch {
			// ignore
		}
	};

	/**
	 * Öffnet ein Submenü relativ zu einem Parent-Button.
	 *
	 * @param {number} depth - Zieltiefe.
	 * @param {HTMLElement} parentButton - Trigger-Button.
	 * @param {Array<object>} items - Submenü-Items.
	 */
	const openSubmenu = (depth, parentButton, items) => {
		if (!contextMenuIsOpen) {
			return;
		}
		const d = Math.max(1, Math.trunc(Number(depth) || 1));
		if (!(parentButton instanceof HTMLButtonElement)) {
			return;
		}
		const childItems = Array.isArray(items) ? items : [];

		closeContextMenuLevel(d - 1);

		// Mark the triggering item as active while its submenu is open.
		try {
			for (const entry of contextMenuStack) {
				entry?.parentButton?.classList?.remove?.('is-submenu-open');
			}
		} catch {
			// ignore
		}
		try {
			parentButton.classList.add('is-submenu-open');
		} catch {
			// ignore
		}

		const menuEl = document.createElement('div');
		menuEl.className = 'msghub-contextmenu';
		contextMenuHost.appendChild(menuEl);

		const listEl = document.createElement('ul');
		listEl.className = 'msghub-contextmenu-list';
		listEl.setAttribute('role', 'menu');
		menuEl.appendChild(listEl);

		contextMenuStack.push({ menuEl, listEl, parentButton });

		menuEl.style.visibility = 'hidden';
		renderContextMenuItems(listEl, childItems, d);
		try {
			const r = parentButton.getBoundingClientRect();
			positionMenuWithClamp(menuEl, r.right, r.top, { mode: 'submenu', alignHeight: Math.ceil(r.height) });
		} catch {
			// ignore
		}
		menuEl.style.visibility = '';
	};

	// Kontextmenü-Primitive für Panels und Core.
	const contextMenu = Object.freeze({
		open: contextMenuOpen,
		close: contextMenuClose,
		isOpen: () => contextMenuIsOpen,
		setBrandingText: text => {
			contextMenuBrandingText = String(text ?? '').trim() || contextMenuBrandingText;
		},
	});

	// Large overlay (viewer)
	let overlayIsOpen = false;
	let overlayPrevActive = null;

	/**
	 * Parsiert CSS-Zeitwerte (`ms`/`s`) in Millisekunden.
	 *
	 * @param {string} s - CSS-Zeitwert.
	 * @returns {number} Millisekunden.
	 */
	const parseCssTimeToMs = s => {
		const str = String(s || '').trim();
		if (!str) {
			return 0;
		}
		if (str.endsWith('ms')) {
			const n = Number(str.slice(0, -2).trim());
			return Number.isFinite(n) ? n : 0;
		}
		if (str.endsWith('s')) {
			const n = Number(str.slice(0, -1).trim());
			return Number.isFinite(n) ? n * 1000 : 0;
		}
		const n = Number(str);
		return Number.isFinite(n) ? n : 0;
	};

	/**
	 * Ermittelt die längste effektive Transitiondauer eines Elements.
	 *
	 * @param {HTMLElement} el - Ziel-Element.
	 * @returns {number} Maximaldauer in Millisekunden.
	 */
	const getMaxTransitionMs = el => {
		try {
			const cs = window.getComputedStyle(el);
			const durs = String(cs.transitionDuration || '0s')
				.split(',')
				.map(x => parseCssTimeToMs(x));
			const delays = String(cs.transitionDelay || '0s')
				.split(',')
				.map(x => parseCssTimeToMs(x));
			const n = Math.max(durs.length, delays.length);
			let max = 0;
			for (let i = 0; i < n; i++) {
				const dur = durs[i % durs.length] || 0;
				const delay = delays[i % delays.length] || 0;
				max = Math.max(max, dur + delay);
			}
			return Number.isFinite(max) ? max : 0;
		} catch {
			return 0;
		}
	};

	/**
	 * Öffnet/schließt Backdrops mit CSS-Transitionen.
	 *
	 * @param {HTMLElement} el - Backdrop-Element.
	 * @param {boolean} isOpen - Zielzustand.
	 */
	const setBackdropOpenAnimated = (el, isOpen) => {
		if (!el) {
			return;
		}
		try {
			const oldTimer = hideTimers.get(el);
			if (oldTimer) {
				clearTimeout(oldTimer);
			}
		} catch {
			// ignore
		}

		if (isOpen) {
			el.classList.remove('is-hidden');
			el.classList.remove('is-closing');
			el.classList.remove('is-open');
			window.requestAnimationFrame(() => {
				el.classList.add('is-open');
			});
			return;
		}

		el.classList.remove('is-open');
		el.classList.add('is-closing');

		const ms = getMaxTransitionMs(el);
		const timer = window.setTimeout(
			() => {
				el.classList.add('is-hidden');
				el.classList.remove('is-closing');
				hideTimers.delete(el);
			},
			Math.max(0, ms) + 30,
		);
		hideTimers.set(el, timer);
	};

	/**
	 * Schaltet den großen Overlay-Dialog.
	 *
	 * @param {boolean} isOpen - Zielzustand.
	 */
	const overlaySetOpen = isOpen => {
		overlayIsOpen = isOpen;
		overlayBackdrop.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
		setBackdropOpenAnimated(overlayBackdrop, isOpen);
		setRootModalOpen(isOpen || dialogIsOpen);
	};

	/**
	 * Schließt den großen Overlay-Dialog und stellt Fokus wieder her.
	 */
	const overlayCloseFn = () => {
		if (!overlayIsOpen) {
			return;
		}
		overlaySetOpen(false);
		if (overlayBody) {
			overlayBody.replaceChildren();
		}
		try {
			overlayPrevActive?.focus?.();
		} catch {
			// ignore
		}
		overlayPrevActive = null;
	};

	/**
	 * Öffnet den großen Overlay-Dialog mit Titel und Inhalt.
	 *
	 * @param {object} opts - Overlay-Optionen (`title`, `bodyEl`, `bodyText`).
	 */
	const overlayOpen = opts => {
		const title = typeof opts?.title === 'string' ? opts.title : '';
		const bodyEl = opts?.bodyEl;

		overlayPrevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (overlayTitle) {
			overlayTitle.textContent = title || '';
		}
		if (overlayBody) {
			if (bodyEl instanceof Node) {
				overlayBody.replaceChildren(bodyEl);
			} else if (typeof opts?.bodyText === 'string') {
				overlayBody.textContent = opts.bodyText;
			} else {
				overlayBody.replaceChildren();
			}
		}
		overlaySetOpen(true);
		try {
			overlayClose?.focus?.();
		} catch {
			// ignore
		}
	};

	if (overlayClose) {
		overlayClose.addEventListener('click', () => overlayCloseFn());
	}
	overlayBackdrop.addEventListener('click', e => {
		if (e?.target === overlayBackdrop) {
			overlayCloseFn();
		}
	});

	// Small dialog (confirm/prompt)
	let dialogIsOpen = false;
	let dialogPrevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	let dialogPendingResolve = undefined;

	/**
	 * Schaltet den kleinen Confirm-Dialog.
	 *
	 * @param {boolean} isOpen - Zielzustand.
	 */
	const dialogSetOpen = isOpen => {
		dialogIsOpen = isOpen;
		dialogBackdrop.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
		setBackdropOpenAnimated(dialogBackdrop, isOpen);
		setRootModalOpen(isOpen || overlayIsOpen);
	};

	/**
	 * Schließt den Dialog, resolved ggf. das offene Confirm-Promise
	 * und restauriert den Fokus.
	 *
	 * @param {boolean} ok - Nutzerentscheidung.
	 */
	const dialogCloseFn = ok => {
		if (!dialogIsOpen) {
			return;
		}
		dialogSetOpen(false);
		if (typeof dialogPendingResolve === 'function') {
			const r = dialogPendingResolve;
			dialogPendingResolve = undefined;
			r(ok === true);
		}
		if (dialogBody) {
			dialogBody.replaceChildren();
		}
		try {
			dialogPrevActive?.focus?.();
		} catch {
			// ignore
		}
		dialogPrevActive = null;
	};

	if (dialogBtnCancel) {
		dialogBtnCancel.addEventListener('click', () => dialogCloseFn(false));
	}
	if (dialogBtnConfirm) {
		dialogBtnConfirm.addEventListener('click', () => dialogCloseFn(true));
	}
	dialogBackdrop.addEventListener('click', e => {
		if (e?.target === dialogBackdrop) {
			dialogCloseFn(false);
		}
	});

	// Einheitliches Escape-Handling für alle Modal-/Menüzustände.
	document.addEventListener('keydown', e => {
		if (e.key !== 'Escape' && e.key !== 'Esc') {
			return;
		}
		if (dialogIsOpen) {
			e.preventDefault();
			dialogCloseFn(false);
			return;
		}
		if (contextMenuIsOpen) {
			e.preventDefault();
			// Erst Submenüs schließen, danach Root-Menü.
			if (Array.isArray(contextMenuStack) && contextMenuStack.length > 1) {
				closeContextMenuLevel(contextMenuStack.length - 2);
			} else {
				contextMenuClose();
			}
			return;
		}
		if (overlayIsOpen) {
			e.preventDefault();
			overlayCloseFn();
		}
	});

	document.addEventListener('msghub:tabSwitch', () => {
		overlayCloseFn();
		dialogCloseFn(false);
		contextMenuClose();
	});

	/**
	 * Öffnet den Confirm-Dialog und liefert die Nutzerentscheidung.
	 *
	 * @param {object} opts - Dialogoptionen (`title`, `text`, `danger`, ...).
	 * @returns {Promise<boolean>} `true` bei Bestätigung.
	 */
	const confirm = opts =>
		new Promise(resolve => {
			if (typeof dialogPendingResolve === 'function') {
				resolve(false);
				return;
			}

			dialogPrevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;

			const title = typeof opts?.title === 'string' ? opts.title : '';
			const text = typeof opts?.text === 'string' ? opts.text : '';
			const bodyEl = opts?.bodyEl;
			const confirmText = typeof opts?.confirmText === 'string' ? opts.confirmText : 'OK';
			const cancelText = typeof opts?.cancelText === 'string' ? opts.cancelText : 'Cancel';
			const isDanger = opts?.danger === true;

			if (dialogTitle) {
				dialogTitle.textContent = title || '';
			}
			if (dialogBody) {
				if (bodyEl instanceof Node) {
					dialogBody.replaceChildren(bodyEl);
				} else {
					dialogBody.textContent = text;
				}
			}
			if (dialogBtnConfirm) {
				dialogBtnConfirm.textContent = confirmText;
				dialogBtnConfirm.classList.toggle('msghub-danger', isDanger);
			}
			if (dialogBtnCancel) {
				dialogBtnCancel.textContent = cancelText;
			}

			dialogPendingResolve = resolve;
			dialogSetOpen(true);
			try {
				dialogBtnCancel?.blur?.();
				dialogBtnConfirm?.focus?.();
			} catch {
				// ignore
			}
		});

	/**
	 * Schließt alle offenen UI-Primitives in definierter Reihenfolge.
	 */
	const closeAll = () => {
		overlayCloseFn();
		dialogCloseFn(false);
		contextMenuClose();
	};

	return Object.freeze({
		toast,
		contextMenu,
		overlayLarge: Object.freeze({
			open: overlayOpen,
			close: overlayCloseFn,
			isOpen: () => overlayIsOpen,
		}),
		dialog: Object.freeze({
			confirm,
			close: dialogCloseFn,
			isOpen: () => dialogIsOpen,
		}),
		closeAll,
	});
}

void createUi;
