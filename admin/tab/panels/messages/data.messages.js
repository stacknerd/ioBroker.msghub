/* global window */
(function () {
	'use strict';

	const win = window;

	/**
	 * Messages data access and query-shaping module.
	 *
	 * Contains:
	 * - Constants enum resolution.
	 * - Filter/sort query payload shaping.
	 * - Backend calls for messages query/delete.
	 * - Label mapping for filter UI and level conversion.
	 *
	 * Integration:
	 * - Uses shared state from `state.js`.
	 * - Consumed by render/menu/lifecycle modules through explicit methods.
	 *
	 * Public API:
	 * - `createMessagesDataApi(options)` returns a stable data facade.
	 */

	/**
	 * Creates the messages data facade for one panel instance.
	 *
	 * @param {object} options - Factory options.
	 * @param {object} options.api - Panel API (`ctx.api`).
	 * @param {object} options.state - Shared mutable messages state.
	 * @param {Function} options.pick - Dotted path accessor.
	 * @param {Function} options.safeStr - Safe string converter.
	 * @param {Function} options.isObject - Plain object checker.
	 * @returns {object} Data facade.
	 */
	function createMessagesDataApi(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const api = opts.api;
		const state = opts.state;
		const pick = opts.pick;
		const safeStr = opts.safeStr;
		const isObject = opts.isObject;
		const messagesApi = api?.messages;
		const constantsApi = api?.constants;

		/**
		 * Reads a filter set by key.
		 *
		 * @param {string} key - Filter key.
		 * @returns {Set<string>|null} Active filter set.
		 */
		function getFilterSet(key) {
			const set = state.columnFilters[key];
			return set instanceof Set ? set : null;
		}

		/**
		 * Writes a filter set by key.
		 *
		 * @param {string} key - Filter key.
		 * @param {Set<string>} nextSet - New set value.
		 */
		function setFilterSet(key, nextSet) {
			state.columnFilters[key] = nextSet instanceof Set ? nextSet : new Set();
		}

		/**
		 * Resolves an enum object from cached constants.
		 *
		 * @param {string} path - Constants path.
		 * @returns {object|null} Enum object or null.
		 */
		function getConstantsEnum(path) {
			const obj = state.constants && typeof state.constants === 'object' ? pick(state.constants, path) : null;
			return isObject(obj) ? obj : null;
		}

		/**
		 * Returns unique enum values preserving natural discovery order.
		 *
		 * @param {object} enumObj - Source enum object.
		 * @returns {string[]} Unique stringified values.
		 */
		function listEnumValues(enumObj) {
			const values = [];
			const seen = new Set();
			for (const value of Object.values(enumObj || {})) {
				if (typeof value === 'string' && value.trim()) {
					const next = value.trim();
					if (!seen.has(next)) {
						seen.add(next);
						values.push(next);
					}
				}
				if (typeof value === 'number' && Number.isFinite(value)) {
					const next = String(value);
					if (!seen.has(next)) {
						seen.add(next);
						values.push(next);
					}
				}
			}
			return values;
		}

		/**
		 * Returns unique enum keys.
		 *
		 * @param {object} enumObj - Source enum object.
		 * @returns {string[]} Unique keys.
		 */
		function listEnumKeys(enumObj) {
			const keys = [];
			const seen = new Set();
			for (const key of Object.keys(enumObj || {})) {
				if (typeof key !== 'string' || !key.trim()) {
					continue;
				}
				const next = key.trim();
				if (seen.has(next)) {
					continue;
				}
				seen.add(next);
				keys.push(next);
			}
			return keys;
		}

		/**
		 * Maps numeric level to canonical enum key.
		 *
		 * @param {number|string} level - Message level.
		 * @returns {string} Level label or numeric fallback.
		 */
		function getLevelLabel(level) {
			const map = getConstantsEnum('level');
			if (!map) {
				return typeof level === 'number' && Number.isFinite(level) ? String(level) : '';
			}
			const number = typeof level === 'number' && Number.isFinite(level) ? level : Number(level);
			if (!Number.isFinite(number)) {
				return '';
			}
			for (const [key, value] of Object.entries(map)) {
				if (typeof value === 'number' && Number.isFinite(value) && value === number) {
					return key;
				}
			}
			return String(number);
		}

		/**
		 * Maps enum key or numeric string to level number.
		 *
		 * @param {string} label - Level label or number.
		 * @returns {number} Parsed level number.
		 */
		function getLevelNumber(label) {
			const map = getConstantsEnum('level');
			if (!map || typeof label !== 'string' || !label.trim()) {
				return Number(label);
			}
			const value = map[label.trim()];
			return typeof value === 'number' && Number.isFinite(value) ? value : Number(label);
		}

		/**
		 * Returns distinct values for a dotted item path from loaded messages.
		 *
		 * @param {string} path - Item path.
		 * @returns {string[]} Sorted distinct values.
		 */
		function listDistinctFromItems(path) {
			const out = new Set();
			for (const msg of state.items) {
				const value = pick(msg, path);
				if (typeof value === 'string' && value.trim()) {
					out.add(value.trim());
				} else if (typeof value === 'number' && Number.isFinite(value)) {
					out.add(String(value));
				}
			}
			return Array.from(out).sort((a, b) => String(a).localeCompare(String(b)));
		}

		/**
		 * Creates backend where-clause from active column filters.
		 *
		 * @returns {object} Query where object.
		 */
		function buildWhereFromFilters() {
			const where = {};

			const kind = getFilterSet('kind');
			if (kind && kind.size > 0) {
				where.kind = { in: Array.from(kind) };
			}

			const lifecycle = getFilterSet('lifecycle.state');
			if (lifecycle && lifecycle.size > 0) {
				where.lifecycle = { state: { in: Array.from(lifecycle) } };
			} else if (lifecycle && lifecycle.size === 0) {
				const enumStates = getConstantsEnum('lifecycle.state');
				const all =
					enumStates && typeof enumStates === 'object'
						? listEnumValues(enumStates)
						: ['open', 'acked', 'closed', 'snoozed', 'deleted', 'expired'];
				where.lifecycle = { state: { in: all } };
			}

			const level = getFilterSet('level');
			if (level && level.size > 0) {
				where.level = {
					in: Array.from(level)
						.map(x => getLevelNumber(x))
						.filter(n => Number.isFinite(n)),
				};
			}

			const origin = getFilterSet('origin.system');
			if (origin && origin.size > 0) {
				where.origin = { system: { in: Array.from(origin) } };
			}

			const location = getFilterSet('details.location');
			if (location && location.size > 0) {
				where.details = { location: { in: Array.from(location) } };
			}

			return where;
		}

		/**
		 * Renders user-facing labels for filter values.
		 *
		 * @param {string} filterKey - Filter key.
		 * @param {any} value - Raw filter value.
		 * @returns {string} Localized value label.
		 */
		function renderFilterValueLabel(filterKey, value) {
			const raw = safeStr(value);
			if (!raw) {
				return '';
			}
			if (filterKey === 'kind') {
				return api.i18n.tOr(`msghub.i18n.core.admin.common.MsgConstants.kind.${raw.toLowerCase()}.label`, raw);
			}
			if (filterKey === 'level') {
				return api.i18n.tOr(`msghub.i18n.core.admin.common.MsgConstants.level.${raw}.label`, raw);
			}
			if (filterKey === 'lifecycle.state') {
				return api.i18n.tOr(
					`msghub.i18n.core.admin.common.MsgConstants.lifecycle.state.${raw.toLowerCase()}.label`,
					raw,
				);
			}
			return raw;
		}

		/**
		 * Loads constants and applies canonical default lifecycle filter if available.
		 */
		async function loadConstants() {
			try {
				if (!constantsApi?.get) {
					throw new Error('Constants API is not available');
				}
				state.constants = await constantsApi.get();
				const enumStates = getConstantsEnum('lifecycle.state');
				if (enumStates) {
					const canonical = ['acked', 'closed', 'open', 'snoozed']
						.map(key => enumStates[key])
						.filter(value => typeof value === 'string' && value.trim());
					if (canonical.length > 0) {
						setFilterSet('lifecycle.state', new Set(canonical));
					}
				}
			} catch {
				state.constants = null;
			}
		}

		/**
		 * Queries the messages backend for the current state window.
		 *
		 * @returns {Promise<object>} Raw backend response.
		 */
		async function queryMessagesPage() {
			if (!messagesApi?.query) {
				throw new Error('Messages API is not available');
			}
			return messagesApi.query({
				query: {
					where: buildWhereFromFilters(),
					page: { index: state.pageIndex, size: state.pageSize },
					sort: [{ field: state.sortField, dir: state.sortDir }],
				},
			});
		}

		/**
		 * Deletes message refs in bulk.
		 *
		 * @param {string[]} refs - Message refs to remove.
		 * @returns {Promise<void>} Completion promise.
		 */
		async function deleteMessages(refs) {
			if (!messagesApi?.delete) {
				throw new Error('Messages API is not available');
			}
			await messagesApi.delete(refs);
		}

		return Object.freeze({
			getFilterSet,
			setFilterSet,
			getConstantsEnum,
			listEnumValues,
			listEnumKeys,
			getLevelLabel,
			getLevelNumber,
			listDistinctFromItems,
			buildWhereFromFilters,
			renderFilterValueLabel,
			loadConstants,
			queryMessagesPage,
			deleteMessages,
		});
	}

	win.MsghubAdminTabMessagesDataMessages = Object.freeze({
		createMessagesDataApi,
	});
})();
