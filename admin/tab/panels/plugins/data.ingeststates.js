/// <reference lib="dom" />
/* global window */
(function () {
	'use strict';

	const win = window;

	/**
	 * IngestStates data access module.
	 *
	 * Contains:
	 * - IngestStates constants cache loader.
	 * - IngestStates schema cache loader (promise-based, single-flight).
	 * - Thin wrappers for ctx.api.ingestStates operations:
	 *   presets (list/get/delete/upsert), bulkApply (preview/apply), custom.read.
	 *
	 * Integration:
	 * - Uses shared state from `state.js`.
	 * - Consumed by `index.js` via the ingestStatesDataApi instance.
	 * - Loaded before `index.js` (registry load order).
	 *
	 * Public API:
	 * - `createIngestStatesDataApi(options)`
	 */

	/**
	 * Creates the IngestStates data facade for one panel instance.
	 *
	 * @param {object} options - Factory options.
	 * @param {object} options.state - Shared mutable plugins state (from state.js).
	 * @param {object} options.ingestStatesApi - ctx.api.ingestStates.
	 * @returns {object} Frozen IngestStates data facade.
	 */
	function createIngestStatesDataApi(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const state = opts.state;
		const ingestStatesApi = opts.ingestStatesApi;

		/**
		 * Loads and caches IngestStates constants. Returns null if unavailable.
		 *
		 * @returns {Promise<object|null>} Resolved constants or null.
		 */
		async function ensureIngestStatesConstantsLoaded() {
			if (state.cachedIngestStatesConstants) {
				return state.cachedIngestStatesConstants;
			}
			try {
				if (!ingestStatesApi?.constants?.get) {
					throw new Error('IngestStates constants API is not available');
				}
				state.cachedIngestStatesConstants = await ingestStatesApi.constants.get();
			} catch {
				state.cachedIngestStatesConstants = null;
			}
			return state.cachedIngestStatesConstants;
		}

		/**
		 * Loads and caches the IngestStates JSON schema.
		 *
		 * Uses single-flight promise caching: concurrent callers share the same
		 * in-flight request. Throws if the API is unavailable or the response is invalid.
		 *
		 * @returns {Promise<object>} Resolved schema object.
		 */
		async function ensureIngestStatesSchema() {
			if (state.ingestStatesSchemaPromise) {
				return state.ingestStatesSchemaPromise;
			}
			state.ingestStatesSchemaPromise = (async () => {
				if (!ingestStatesApi?.schema?.get) {
					throw new Error('IngestStates schema API is not available');
				}
				const schema = await ingestStatesApi.schema.get();
				if (!schema || typeof schema !== 'object') {
					throw new Error('Invalid schema response');
				}
				return schema;
			})();
			return state.ingestStatesSchemaPromise;
		}

		/**
		 * Lists all saved presets.
		 *
		 * @returns {Promise<object>} Presets list response.
		 */
		async function listPresets() {
			if (!ingestStatesApi?.presets?.list) {
				throw new Error('IngestStates presets API is not available');
			}
			return ingestStatesApi.presets.list();
		}

		/**
		 * Fetches a single preset by ID.
		 *
		 * @param {object} params - Params: presetId.
		 * @returns {Promise<object>} Preset get response.
		 */
		async function getPreset(params) {
			if (!ingestStatesApi?.presets?.get) {
				throw new Error('IngestStates presets API is not available');
			}
			return ingestStatesApi.presets.get(params);
		}

		/**
		 * Deletes a preset by ID.
		 *
		 * @param {object} params - Params: presetId.
		 * @returns {Promise<void>} Completion promise.
		 */
		async function deletePreset(params) {
			if (!ingestStatesApi?.presets?.delete) {
				throw new Error('IngestStates presets API is not available');
			}
			return ingestStatesApi.presets.delete(params);
		}

		/**
		 * Creates or updates a preset.
		 *
		 * @param {object} params - Params: preset.
		 * @returns {Promise<object>} Upserted preset response.
		 */
		async function upsertPreset(params) {
			if (!ingestStatesApi?.presets?.upsert) {
				throw new Error('IngestStates presets API is not available');
			}
			return ingestStatesApi.presets.upsert(params);
		}

		/**
		 * Previews the result of a bulk-apply operation without committing changes.
		 *
		 * @param {object} params - Bulk apply preview params.
		 * @returns {Promise<object>} Preview response.
		 */
		async function bulkApplyPreview(params) {
			if (!ingestStatesApi?.bulkApply?.preview) {
				throw new Error('IngestStates bulkApply API is not available');
			}
			return ingestStatesApi.bulkApply.preview(params);
		}

		/**
		 * Commits a bulk-apply operation.
		 *
		 * @param {object} params - Bulk apply params.
		 * @returns {Promise<object>} Apply response.
		 */
		async function bulkApplyApply(params) {
			if (!ingestStatesApi?.bulkApply?.apply) {
				throw new Error('IngestStates bulkApply API is not available');
			}
			return ingestStatesApi.bulkApply.apply(params);
		}

		/**
		 * Reads the custom IngestStates configuration for an instance.
		 *
		 * @param {object} params - Read params: id.
		 * @returns {Promise<object>} Custom config response.
		 */
		async function customRead(params) {
			if (!ingestStatesApi?.custom?.read) {
				throw new Error('IngestStates custom API is not available');
			}
			return ingestStatesApi.custom.read(params);
		}

		return Object.freeze({
			ensureIngestStatesConstantsLoaded,
			ensureIngestStatesSchema,
			listPresets,
			getPreset,
			deletePreset,
			upsertPreset,
			bulkApplyPreview,
			bulkApplyApply,
			customRead,
		});
	}

	win.MsghubAdminTabPluginsIngestStatesData = Object.freeze({ createIngestStatesDataApi });
})();
