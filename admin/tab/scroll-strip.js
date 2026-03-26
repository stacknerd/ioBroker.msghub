/* global window, document, MutationObserver, ResizeObserver */
'use strict';

/**
 * MsgHub Admin Tab scroll-strip helper.
 *
 * Docs: ../../docs/ui/tab-scroll-strip.md
 *
 * Contents:
 * - Generic horizontal strip wrapper for compact nav/toolbars.
 * - Overflow state tracking via scroll, resize, and mutation observers.
 *
 * Integration:
 * - Loaded before `layout.js` so the layout builder can initialize tab strips.
 * - Also used by panel renderers to wrap their toolbar hosts.
 *
 * Public API:
 * - `window.MsghubScrollStrip.initStrip(hostEl)`
 */
(function () {
	'use strict';

	const win = window;
	const stripStateByHost = new WeakMap();

	/**
	 * Returns whether a value looks like an element that can host strip content.
	 *
	 * @param {any} value - Candidate host element.
	 * @returns {boolean} True when the value can be initialized as strip host.
	 */
	function isHostElement(value) {
		return !!(
			value &&
			typeof value === 'object' &&
			typeof value.appendChild === 'function' &&
			typeof value.classList === 'object' &&
			typeof value.classList.add === 'function'
		);
	}

	/**
	 * Creates a neutral no-op handle for invalid input.
	 *
	 * @returns {{viewport: null, disconnect: Function}} No-op handle.
	 */
	function createNoopHandle() {
		return Object.freeze({
			viewport: null,
			disconnect: () => undefined,
		});
	}

	/**
	 * Creates a strip edge element.
	 *
	 * @returns {HTMLElement} Edge element.
	 */
	function createEdge() {
		return document.createElement('span');
	}

	/**
	 * Updates the host overflow classes from the current viewport metrics.
	 *
	 * @param {HTMLElement} hostEl - Strip host element.
	 * @param {HTMLElement} viewport - Scrollable viewport element.
	 */
	function updateOverflow(hostEl, viewport) {
		const scrollWidth = Number(viewport?.scrollWidth) || 0;
		const clientWidth = Number(viewport?.clientWidth) || 0;
		const scrollLeft = Number(viewport?.scrollLeft) || 0;
		hostEl.classList.toggle('has-overflow-left', scrollLeft > 0);
		hostEl.classList.toggle('has-overflow-right', scrollWidth > clientWidth + scrollLeft);
	}

	/**
	 * Initializes a horizontal scroll strip on a host element.
	 *
	 * @param {HTMLElement} hostEl - Host element that contains the strip content.
	 * @returns {{viewport: HTMLElement|null, disconnect: Function}} Strip handle.
	 */
	function initStrip(hostEl) {
		if (!isHostElement(hostEl)) {
			return createNoopHandle();
		}
		if (hostEl.classList.contains('msghub-strip-host')) {
			const existing = stripStateByHost.get(hostEl) || null;
			return existing ? existing.handle : createNoopHandle();
		}
		const existing = stripStateByHost.get(hostEl) || null;
		if (existing) {
			return existing.handle;
		}

		hostEl.classList.add('msghub-strip-host');

		const viewport = document.createElement('div');
		viewport.setAttribute('class', 'msghub-strip-viewport');

		while (hostEl.firstChild) {
			viewport.appendChild(hostEl.firstChild);
		}

		hostEl.appendChild(viewport);

		const edgeLeft = createEdge();
		edgeLeft.setAttribute('class', 'msghub-strip-edge msghub-strip-edge--left');
		edgeLeft.setAttribute('aria-hidden', 'true');
		const edgeRight = createEdge();
		edgeRight.setAttribute('class', 'msghub-strip-edge msghub-strip-edge--right');
		edgeRight.setAttribute('aria-hidden', 'true');
		hostEl.appendChild(edgeLeft);
		hostEl.appendChild(edgeRight);

		const checkOverflow = () => updateOverflow(hostEl, viewport);

		const onScroll = () => checkOverflow();
		viewport.addEventListener('scroll', onScroll, { passive: true });

		const ResizeObserverCtor = typeof ResizeObserver === 'function' ? ResizeObserver : win.ResizeObserver || null;
		const MutationObserverCtor =
			typeof MutationObserver === 'function' ? MutationObserver : win.MutationObserver || null;

		const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(checkOverflow) : null;
		if (resizeObserver) {
			resizeObserver.observe(viewport);
		}

		const mutationObserver = MutationObserverCtor ? new MutationObserverCtor(checkOverflow) : null;
		if (mutationObserver) {
			mutationObserver.observe(viewport, {
				subtree: true,
				childList: true,
				characterData: true,
			});
		}

		const handle = Object.freeze({
			viewport,
			disconnect: () => {
				viewport.removeEventListener('scroll', onScroll);
				resizeObserver?.disconnect?.();
				mutationObserver?.disconnect?.();
			},
		});

		stripStateByHost.set(hostEl, {
			handle,
		});

		checkOverflow();
		return handle;
	}

	win.MsghubScrollStrip = Object.freeze({
		initStrip,
	});
})();
