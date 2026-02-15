/* global window */
(function () {
	'use strict';

	const win = window;

	/**
	 * Archive paging contract module for messages panel.
	 *
	 * Contains:
	 * - Wrapper for archive page requests.
	 * - Cursor edge normalization (`ts` + `tie`).
	 * - Response normalization for future archive timeline overlay integration.
	 *
	 * Integration:
	 * - This module is intentionally archive-ready but inactive in current UX.
	 * - Row menu keeps archive action disabled until backend/UI integration is enabled.
	 *
	 * Public API:
	 * - `createArchiveDataApi(options)` with `pageArchive(...)`.
	 */

	/**
	 * Coerces value to finite integer timestamp.
	 *
	 * @param {any} value - Timestamp candidate.
	 * @returns {number|null} Normalized timestamp.
	 */
	function toFiniteTs(value) {
		const num = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(num)) {
			return null;
		}
		return Math.trunc(num);
	}

	/**
	 * Normalizes one archive cursor edge.
	 *
	 * @param {any} edge - Raw cursor edge.
	 * @returns {{ts:number,tie:string}|null} Normalized cursor edge.
	 */
	function normalizeCursorEdge(edge) {
		if (!edge || typeof edge !== 'object') {
			return null;
		}
		const ts = toFiniteTs(edge.ts);
		if (ts === null) {
			return null;
		}
		const tie = typeof edge.tie === 'string' ? edge.tie : edge.tie == null ? '' : String(edge.tie);
		return { ts, tie };
	}

	/**
	 * Normalizes one archive item to include normalized cursor edge.
	 *
	 * @param {any} item - Raw archive item.
	 * @returns {object|null} Normalized item.
	 */
	function normalizeArchiveItem(item) {
		if (!item || typeof item !== 'object') {
			return null;
		}
		const cursor = normalizeCursorEdge(item.__cursor);
		const ts = toFiniteTs(item.ts);
		return Object.assign({}, item, {
			ts: ts === null ? item.ts : ts,
			__cursor: cursor || item.__cursor || null,
		});
	}

	/**
	 * Normalizes page response payload to the agreed contract shape.
	 *
	 * @param {any} response - Raw backend response.
	 * @returns {object} Normalized response.
	 */
	function normalizePageResponse(response) {
		const raw = response && typeof response === 'object' ? response : {};
		const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
		const rawItems = Array.isArray(data.items) ? data.items : [];
		const items = rawItems.map(normalizeArchiveItem).filter(Boolean);

		return {
			ok: raw.ok === false ? false : true,
			data: {
				items,
				hasMoreBackward: data.hasMoreBackward === true,
				hasMoreForward: data.hasMoreForward === true,
				edgeOldest: normalizeCursorEdge(data.edgeOldest),
				edgeNewest: normalizeCursorEdge(data.edgeNewest),
			},
			error: raw.ok === false ? raw.error || { code: 'UNKNOWN', message: 'Unknown archive error' } : null,
		};
	}

	/**
	 * Creates archive data facade for one panel instance.
	 *
	 * @param {object} options - Factory options.
	 * @param {object} options.api - Panel API (`ctx.api`).
	 * @returns {{pageArchive: Function, normalizeCursorEdge: Function}} Archive facade.
	 */
	function createArchiveDataApi(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const api = opts.api;

		/**
		 * Resolves the active archive page function from available APIs.
		 *
		 * @returns {Function|null} Archive page function.
		 */
		function resolvePageFn() {
			if (typeof api?.archive?.page === 'function') {
				return api.archive.page.bind(api.archive);
			}
			if (typeof api?.messages?.archivePage === 'function') {
				return api.messages.archivePage.bind(api.messages);
			}
			return null;
		}

		/**
		 * Requests one archive page and normalizes output.
		 *
		 * @param {object} params - Archive page parameters.
		 * @param {string} params.ref - Message ref.
		 * @param {'backward'|'forward'} [params.direction] - Paging direction.
		 * @param {{ts:number,tie:string}} [params.before] - Older-than edge.
		 * @param {{ts:number,tie:string}} [params.after] - Newer-than edge.
		 * @param {number} [params.limit] - Page size limit.
		 * @param {boolean} [params.includeRaw] - Include raw lines when supported.
		 * @returns {Promise<object>} Normalized page response.
		 */
		async function pageArchive(params) {
			const pageFn = resolvePageFn();
			if (!pageFn) {
				if (typeof api?.notSupported === 'function') {
					api.notSupported('messages.archive.page');
				}
				throw new Error('Archive paging API is not available');
			}

			const payload = params && typeof params === 'object' ? params : {};
			const raw = await pageFn({
				ref: typeof payload.ref === 'string' ? payload.ref : '',
				direction: payload.direction === 'forward' ? 'forward' : 'backward',
				before: normalizeCursorEdge(payload.before) || undefined,
				after: normalizeCursorEdge(payload.after) || undefined,
				limit:
					typeof payload.limit === 'number' && Number.isFinite(payload.limit)
						? Math.trunc(payload.limit)
						: undefined,
				includeRaw: payload.includeRaw === true,
			});

			return normalizePageResponse(raw);
		}

		return Object.freeze({
			pageArchive,
			normalizeCursorEdge,
		});
	}

	win.MsghubAdminTabMessagesDataArchive = Object.freeze({
		createArchiveDataApi,
		normalizeCursorEdge,
	});
})();
