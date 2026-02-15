/* global window, document */
(function () {
	'use strict';

	const win = window;

	/**
	 * Messages lifecycle module.
	 *
	 * Contains:
	 * - Auto-refresh timer scheduling and stop logic.
	 * - Visibility and tab-switch event wiring.
	 * - Follow/browse hook points for future archive integration.
	 *
	 * Integration:
	 * - Uses shared state and panel root visibility.
	 * - Invokes callbacks from `index.js` for refresh behavior.
	 */

	/**
	 * Creates lifecycle controller for one messages panel instance.
	 *
	 * @param {object} options - Factory options.
	 * @param {object} options.state - Shared panel state.
	 * @param {HTMLElement} options.root - Messages panel root.
	 * @param {object} options.ui - UI API.
	 * @param {Function} options.onRefreshFollow - Callback for follow-mode refresh.
	 * @param {Function} options.onRefreshBrowsePending - Callback for browse-mode pending update.
	 * @returns {{scheduleAuto:Function, stopAuto:Function, bindEvents:Function, unbindEvents:Function, canAutoRefresh:Function}} Lifecycle facade.
	 */
	function createLifecycle(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const state = opts.state;
		const root = opts.root;
		const ui = opts.ui;
		const onRefreshFollow =
			typeof opts.onRefreshFollow === 'function' ? opts.onRefreshFollow : () => Promise.resolve(undefined);
		const onRefreshBrowsePending =
			typeof opts.onRefreshBrowsePending === 'function'
				? opts.onRefreshBrowsePending
				: () => Promise.resolve(undefined);

		let isBound = false;
		let visibilityHandler = null;
		let tabSwitchHandler = null;

		/**
		 * Checks whether messages tab is currently visible.
		 *
		 * @returns {boolean} True when panel is visible.
		 */
		function isTabVisible() {
			const tab = root.closest('#tab-messages');
			return !document.hidden && !!tab && tab.offsetParent !== null;
		}

		/**
		 * Stops pending auto-refresh timer.
		 */
		function stopAuto() {
			if (state.autoTimer) {
				clearTimeout(state.autoTimer);
				state.autoTimer = null;
			}
		}

		/**
		 * Checks whether auto-refresh is currently allowed.
		 *
		 * @returns {boolean} True when auto refresh should run now.
		 */
		function canAutoRefresh() {
			if (!isTabVisible()) {
				return false;
			}
			if (ui?.contextMenu?.isOpen?.()) {
				return false;
			}
			if (ui?.overlayLarge?.isOpen?.()) {
				return false;
			}
			return true;
		}

		/**
		 * Executes one auto-refresh cycle based on archive mode.
		 */
		function runAutoCycle() {
			if (state.archiveMode === 'browse') {
				onRefreshBrowsePending().catch(() => undefined);
				return;
			}
			onRefreshFollow().catch(() => undefined);
		}

		/**
		 * Schedules next auto-refresh cycle.
		 */
		function scheduleAuto() {
			stopAuto();
			if (!state.autoRefresh || !isTabVisible()) {
				return;
			}
			state.autoTimer = setTimeout(
				() => {
					state.autoTimer = null;
					if (state.autoRefresh && canAutoRefresh()) {
						runAutoCycle();
					}
					scheduleAuto();
				},
				state.autoRefreshMs + Math.trunc(Math.random() * 1200),
			);
		}

		/**
		 * Binds visibility and tab-switch events.
		 */
		function bindEvents() {
			if (isBound) {
				return;
			}
			isBound = true;

			visibilityHandler = () => {
				if (state.autoRefresh && canAutoRefresh()) {
					runAutoCycle();
				}
				scheduleAuto();
			};
			document.addEventListener('visibilitychange', visibilityHandler);

			tabSwitchHandler = event => {
				if (!(event instanceof CustomEvent)) {
					return;
				}
				const from = String(event.detail?.from || '');
				const to = String(event.detail?.to || '');
				if (from === 'tab-messages' && to && to !== 'tab-messages') {
					stopAuto();
					return;
				}
				if (to === 'tab-messages') {
					if (state.autoRefresh && canAutoRefresh()) {
						runAutoCycle();
					}
					scheduleAuto();
				}
			};
			document.addEventListener('msghub:tabSwitch', tabSwitchHandler);
		}

		/**
		 * Unbinds previously registered lifecycle events.
		 */
		function unbindEvents() {
			if (!isBound) {
				return;
			}
			isBound = false;
			if (visibilityHandler) {
				document.removeEventListener('visibilitychange', visibilityHandler);
				visibilityHandler = null;
			}
			if (tabSwitchHandler) {
				document.removeEventListener('msghub:tabSwitch', tabSwitchHandler);
				tabSwitchHandler = null;
			}
			stopAuto();
		}

		return Object.freeze({
			scheduleAuto,
			stopAuto,
			bindEvents,
			unbindEvents,
			canAutoRefresh,
		});
	}

	win.MsghubAdminTabMessagesLifecycle = Object.freeze({
		createLifecycle,
	});
})();
