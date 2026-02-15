/* global window, document */
(function () {
	'use strict';

	const win = window;

	/**
	 * Archive timeline overlay module for messages panel.
	 *
	 * Contains:
	 * - Archive overlay shell view.
	 * - Rendering hooks for timeline data, edges, and mode status.
	 * - Contracts prepared for future archive API integration.
	 *
	 * Integration:
	 * - Created by `index.js`.
	 * - Row context menu keeps archive opening disabled in current step.
	 *
	 * Public API:
	 * - `createArchiveOverlay(options)` with open/update/reset methods.
	 */

	/**
	 * Creates archive overlay controller.
	 *
	 * @param {object} options - Factory options.
	 * @param {object} options.ui - UI API (`ctx.api.ui`).
	 * @param {Function} options.t - I18n translation function.
	 * @returns {object} Archive overlay facade.
	 */
	function createArchiveOverlay(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const ui = opts.ui;
		const t = typeof opts.t === 'function' ? opts.t : key => String(key);

		let rootEl = null;
		let titleEl = null;
		let modeEl = null;
		let metaEl = null;
		let listEl = null;
		let infoEl = null;

		/**
		 * Ensures the archive overlay DOM exists.
		 *
		 * @returns {HTMLElement} Overlay root element.
		 */
		function ensureDom() {
			if (rootEl) {
				return rootEl;
			}
			rootEl = document.createElement('div');
			rootEl.className = 'msghub-overlay-pre msghub-messages-archive';

			titleEl = document.createElement('div');
			titleEl.className = 'msghub-messages-archive-title';

			modeEl = document.createElement('div');
			modeEl.className = 'msghub-messages-archive-mode msghub-muted';

			metaEl = document.createElement('div');
			metaEl.className = 'msghub-messages-archive-meta msghub-muted';

			listEl = document.createElement('div');
			listEl.className = 'msghub-messages-archive-list';

			infoEl = document.createElement('div');
			infoEl.className = 'msghub-messages-archive-info msghub-muted';

			rootEl.appendChild(titleEl);
			rootEl.appendChild(modeEl);
			rootEl.appendChild(metaEl);
			rootEl.appendChild(infoEl);
			rootEl.appendChild(listEl);
			return rootEl;
		}

		/**
		 * Renders archive page information into overlay.
		 *
		 * @param {object} view - View model.
		 * @param {string} view.ref - Message ref.
		 * @param {'follow'|'browse'} [view.mode] - Timeline mode.
		 * @param {number} [view.pendingNewCount] - Pending new items count.
		 * @param {boolean} [view.hasMoreBackward] - Older page availability.
		 * @param {boolean} [view.hasMoreForward] - Newer page availability.
		 * @param {Array<object>} [view.items] - Timeline items.
		 */
		function renderArchiveView(view) {
			ensureDom();
			const model = view && typeof view === 'object' ? view : {};
			const ref = typeof model.ref === 'string' ? model.ref : '';
			const mode = model.mode === 'browse' ? 'browse' : 'follow';
			const pending = Number.isFinite(model.pendingNewCount) ? Math.max(0, Math.trunc(model.pendingNewCount)) : 0;
			const hasMoreBackward = model.hasMoreBackward === true;
			const hasMoreForward = model.hasMoreForward === true;
			const items = Array.isArray(model.items) ? model.items : [];

			titleEl.textContent = ref ? `Archive timeline · ${ref}` : 'Archive timeline';
			modeEl.textContent = `mode: ${mode}`;
			metaEl.textContent = `older: ${hasMoreBackward ? 'yes' : 'no'} · newer: ${hasMoreForward ? 'yes' : 'no'}`;
			infoEl.textContent =
				pending > 0
					? `pending new entries: ${pending}`
					: t('msghub.i18n.core.admin.ui.messages.archive.pendingNone.text');

			const fragment = document.createDocumentFragment();
			if (!items.length) {
				const emptyEl = document.createElement('div');
				emptyEl.className = 'msghub-muted';
				emptyEl.textContent = t('msghub.i18n.core.admin.ui.messages.archive.empty.text');
				fragment.appendChild(emptyEl);
			} else {
				for (const item of items) {
					const row = document.createElement('div');
					row.className = 'msghub-messages-archive-item';
					const ts = item && Object.prototype.hasOwnProperty.call(item, 'ts') ? String(item.ts) : 'n/a';
					const event = item && typeof item.event === 'string' ? item.event : 'event';
					row.textContent = `${ts} · ${event}`;
					fragment.appendChild(row);
				}
			}
			listEl.replaceChildren(fragment);
		}

		/**
		 * Opens archive overlay for one message ref.
		 *
		 * @param {string} ref - Message ref.
		 */
		function openArchiveOverlay(ref) {
			const bodyEl = ensureDom();
			renderArchiveView({
				ref,
				mode: 'follow',
				pendingNewCount: 0,
				hasMoreBackward: false,
				hasMoreForward: false,
				items: [],
			});
			ui?.overlayLarge?.open?.({
				title: 'Message Archive',
				bodyEl,
			});
		}

		/**
		 * Clears overlay content cache.
		 */
		function resetArchiveOverlay() {
			if (!rootEl) {
				return;
			}
			try {
				rootEl.remove();
			} catch {
				// Ignore DOM remove failures.
			}
			rootEl = null;
			titleEl = null;
			modeEl = null;
			metaEl = null;
			listEl = null;
			infoEl = null;
		}

		return Object.freeze({
			openArchiveOverlay,
			renderArchiveView,
			resetArchiveOverlay,
		});
	}

	win.MsghubAdminTabMessagesOverlayArchive = Object.freeze({
		createArchiveOverlay,
	});
})();
