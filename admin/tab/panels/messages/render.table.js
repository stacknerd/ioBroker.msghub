/* global window */
(function () {
	'use strict';

	const win = window;
	void win;

	/**
	 * Messages table renderer module.
	 *
	 * Contains:
	 * - Message row rendering.
	 * - Selection interaction logic for normal/expert mode.
	 * - Row-level mouse interactions and context menu delegation.
	 *
	 * Integration:
	 * - Created by `index.js`.
	 * - Receives context-menu opener from `menus.js`.
	 */

	/**
	 * Creates row renderer for messages table body.
	 *
	 * @param {object} options - Factory options.
	 * @param {Function} options.h - DOM helper factory.
	 * @param {object} options.api - Panel API.
	 * @param {object} options.state - Shared state.
	 * @param {Function} options.safeStr - Safe string helper.
	 * @param {Function} options.pick - Path helper.
	 * @param {Function} options.formatTs - Timestamp formatter.
	 * @param {Function} options.getLevelLabel - Level label resolver.
	 * @param {Function} options.openMessageJson - JSON overlay opener.
	 * @param {Function} options.openRowContextMenu - Row context menu opener.
	 * @param {Function} options.onSelectionChanged - Selection change callback.
	 * @returns {{renderRows: Function}} Row renderer API.
	 */
	function createTableRenderer(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const h = opts.h;
		const api = opts.api;
		const state = opts.state;
		const safeStr = opts.safeStr;
		const pick = opts.pick;
		const formatTs = opts.formatTs;
		const getLevelLabel = opts.getLevelLabel;
		const openMessageJson = opts.openMessageJson;
		const openRowContextMenu = opts.openRowContextMenu;
		const onSelectionChanged =
			typeof opts.onSelectionChanged === 'function' ? opts.onSelectionChanged : () => undefined;

		/**
		 * Applies row selection rules.
		 *
		 * @param {string} ref - Message ref.
		 * @param {'click'|'contextmenu'} mode - Interaction mode.
		 * @returns {boolean} True if selection changed.
		 */
		function applySelection(ref, mode) {
			if (!ref) {
				return false;
			}
			const alreadySelected = state.selectedRefs.has(ref);

			if (!state.expertMode) {
				if (mode === 'contextmenu') {
					// Right-click selects row but never toggles off.
					if (alreadySelected) {
						return false;
					}
					state.selectedRefs.clear();
					state.selectedRefs.add(ref);
					return true;
				}
				if (alreadySelected) {
					state.selectedRefs.clear();
					return true;
				}
				state.selectedRefs.clear();
				state.selectedRefs.add(ref);
				return true;
			}

			if (mode === 'contextmenu') {
				// File-manager style right click selection behavior.
				if (!alreadySelected) {
					state.selectedRefs.clear();
					state.selectedRefs.add(ref);
					return true;
				}
				return false;
			}

			if (alreadySelected) {
				state.selectedRefs.delete(ref);
			} else {
				state.selectedRefs.add(ref);
			}
			return true;
		}

		/**
		 * Renders all table rows.
		 *
		 * @param {object[]} itemsToRender - Message list.
		 * @returns {HTMLTableRowElement[]} Rendered rows.
		 */
		function renderRows(itemsToRender) {
			return (itemsToRender || []).map(msg => {
				const title = safeStr(pick(msg, 'title'));
				const text = safeStr(pick(msg, 'text'));
				const location = safeStr(pick(msg, 'details.location'));
				const kind = safeStr(pick(msg, 'kind'));
				const lifecycle = safeStr(pick(msg, 'lifecycle.state'));
				const icon = safeStr(pick(msg, 'icon'));
				const level = pick(msg, 'level');
				const origin = safeStr(pick(msg, 'origin.system')) || safeStr(pick(msg, 'origin.type'));
				const progressPercentage = pick(msg, 'progress.percentage');
				const createdAt = pick(msg, 'timing.createdAt');
				const updatedAt = pick(msg, 'timing.updatedAt');
				const progressValue =
					typeof progressPercentage === 'number' && Number.isFinite(progressPercentage)
						? Math.max(0, Math.min(100, progressPercentage))
						: null;
				const ref = safeStr(pick(msg, 'ref'));
				const isSelected = !!ref && state.selectedRefs.has(ref);

				const checkboxCell = state.expertMode
					? h('td', { class: 'msghub-messages-select msghub-colCell msghub-colCell--select' }, [
							h('label', { class: 'msghub-uicheckbox' }, [
								h('input', {
									class: 'msghub-uicheckbox__input',
									type: 'checkbox',
									checked: state.selectedRefs.has(ref) ? 'true' : null,
									onchange: e => {
										const on = !!e?.target?.checked;
										if (on) {
											state.selectedRefs.add(ref);
										} else {
											state.selectedRefs.delete(ref);
										}
										onSelectionChanged();
									},
								}),
								h('span', { class: 'msghub-uicheckbox__box', text: '' }),
							]),
						])
					: null;

				return h(
					'tr',
					{
						class: isSelected ? 'is-selected' : '',
						'data-ref': ref || '',
						onclick: e => {
							if (!ref) {
								return;
							}
							if (Date.now() < state.suppressRowClickUntil) {
								return;
							}
							const target = e?.target;
							if (target && typeof target.closest === 'function') {
								if (target.closest('input, button, a, select, textarea, label')) {
									return;
								}
							}
							if (!applySelection(ref, 'click')) {
								return;
							}
							onSelectionChanged();
						},
						oncontextmenu: e => {
							if (!ref) {
								return;
							}
							const target = e?.target;
							if (target && typeof target.closest === 'function') {
								if (target.closest('input, button, a, select, textarea, label')) {
									return;
								}
							}
							state.suppressRowClickUntil = Date.now() + 500;
							if (applySelection(ref, 'contextmenu')) {
								onSelectionChanged();
							}
							e?.preventDefault?.();
							openRowContextMenu(e, msg);
						},
						ondblclick: () => {
							openMessageJson(msg);
						},
					},
					[
						...(checkboxCell ? [checkboxCell] : []),
						h('td', { class: 'msghub-colCell msghub-colCell--icon', text: icon }),
						h('td', { class: 'msghub-colCell msghub-colCell--title', text: title, title }),
						h('td', { class: 'msghub-colCell msghub-colCell--text', text: text, title: text }),
						h('td', { class: 'msghub-colCell msghub-colCell--location', text: location }),
						h('td', {
							class: 'msghub-colCell msghub-colCell--kind',
							text: api.i18n.tOr(
								`msghub.i18n.core.admin.common.MsgConstants.kind.${kind.toLowerCase()}.label`,
								kind,
							),
						}),
						h('td', {
							class: 'msghub-colCell msghub-colCell--level',
							text: api.i18n.tOr(
								`msghub.i18n.core.admin.common.MsgConstants.level.${getLevelLabel(level).toLowerCase()}.label`,
								getLevelLabel(level),
							),
						}),
						h('td', {
							class: 'msghub-colCell msghub-colCell--lifecycle',
							text: api.i18n.tOr(
								`msghub.i18n.core.admin.common.MsgConstants.lifecycle.state.${lifecycle.toLowerCase()}.label`,
								lifecycle,
							),
						}),
						h('td', {
							class: 'msghub-muted msghub-colCell msghub-colCell--created',
							text: formatTs(typeof createdAt === 'number' ? createdAt : NaN),
						}),
						h('td', {
							class: 'msghub-muted msghub-colCell msghub-colCell--updated',
							text: formatTs(typeof updatedAt === 'number' ? updatedAt : NaN),
						}),
						h('td', { class: 'msghub-colCell msghub-colCell--origin', text: origin }),
						h(
							'td',
							{ class: 'msghub-colCell msghub-colCell--progress' },
							progressValue === null
								? []
								: [
										h('progress', {
											class: 'msghub-progress-bar',
											max: '100',
											value: String(progressValue),
											title: `${Math.round(progressValue)}%`,
										}),
										h('span', {
											class: 'msghub-progress-value',
											text: `${Math.round(progressValue)}%`,
										}),
									],
						),
					],
				);
			});
		}

		return Object.freeze({ renderRows });
	}

	win.MsghubAdminTabMessagesRenderTable = Object.freeze({
		createTableRenderer,
	});
})();
