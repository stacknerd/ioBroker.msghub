/**
 * IoUiCatalog
 * ===========
 * Backend view resolver for MsgHub shell consumers.
 *
 * Docs: ../docs/io/IoUiCatalog.md
 *
 * Responsibilities
 * - Validate `web.view.get` request payloads.
 * - Resolve composition requests against the backend-owned UI registry.
 * - Build synthetic single-panel compositions for `panel=` requests without mirroring plugin-owned metadata.
 *
 * Non-responsibilities
 * - No command transport or envelope handling -> owned by `IoWebUi`.
 * - No browser/global state handling -> owned by the AdminTab shell.
 * - No plugin discovery or plugin bundle metadata enrichment.
 */

'use strict';

const { uiRegistry } = require('./IoUiRegistry');

/**
 * Default composition used when `web.view.get` requests composition mode without `targetId`.
 */
const DEFAULT_COMPOSITION_ID = 'adminTab';

/**
 * Resolves backend-owned UI views for shell consumers.
 */
class IoUiCatalog {
	/**
	 * @param {object} [options] Optional dependencies.
	 * @param {object} [options.registry] Backend UI registry with `panels` and `compositions`.
	 */
	constructor({ registry = uiRegistry } = {}) {
		const safeRegistry = registry && typeof registry === 'object' ? registry : null;
		if (!safeRegistry?.panels || !safeRegistry?.compositions) {
			throw new Error('IoUiCatalog: registry with panels and compositions is required');
		}
		this.registry = safeRegistry;
	}

	/**
	 * Resolve one normalized view payload for `web.view.get`.
	 *
	 * @param {any} request Raw request payload (`{ mode, targetId? }`).
	 * @returns {{ composition: object, corePanels: Record<string, object>, request: { mode: string, targetId: string } }}
	 *   Canonical backend view payload.
	 */
	getView(request) {
		const normalizedRequest = this._normalizeRequest(request);
		if (normalizedRequest.mode === 'panel') {
			return this._buildPanelView(normalizedRequest);
		}
		return this._buildCompositionView(normalizedRequest);
	}

	/**
	 * Validate and normalize the incoming view request.
	 *
	 * Composition mode defaults to `DEFAULT_COMPOSITION_ID` when `targetId` is omitted.
	 * Panel mode requires a formally valid `tab-...` target but does not perform runtime availability checks.
	 *
	 * @param {any} request Raw request payload.
	 * @returns {{ mode: 'composition'|'panel', targetId: string }} Normalized request object.
	 */
	_normalizeRequest(request) {
		const safeRequest = request && typeof request === 'object' ? request : null;
		const mode = typeof safeRequest?.mode === 'string' ? safeRequest.mode.trim() : '';
		const targetIdRaw = typeof safeRequest?.targetId === 'string' ? safeRequest.targetId.trim() : '';
		if (mode !== 'composition' && mode !== 'panel') {
			throw this._badRequest("mode must be 'composition' or 'panel'");
		}
		if (mode === 'composition') {
			const targetId = targetIdRaw || DEFAULT_COMPOSITION_ID;
			if (!Object.prototype.hasOwnProperty.call(this.registry.compositions, targetId)) {
				throw this._badRequest(`Unknown composition '${targetId}'`);
			}
			return { mode, targetId };
		}
		if (!targetIdRaw) {
			throw this._badRequest('targetId is required for panel mode');
		}
		if (!this._isValidPanelTargetId(targetIdRaw)) {
			throw this._badRequest(`Invalid panel target '${targetIdRaw}'`);
		}
		return { mode, targetId: targetIdRaw };
	}

	/**
	 * Build the view payload for a composition request.
	 *
	 * @param {{ mode: 'composition', targetId: string }} request Normalized composition request.
	 * @returns {{ composition: object, corePanels: Record<string, object>, request: { mode: string, targetId: string } }}
	 *   View payload backed directly by the registry composition.
	 */
	_buildCompositionView(request) {
		const composition = this.registry.compositions[request.targetId];
		return {
			composition,
			corePanels: this._extractCorePanels(composition),
			request,
		};
	}

	/**
	 * Build the view payload for a single-panel request.
	 *
	 * The returned composition is synthetic and intentionally contains only the requested panel target.
	 *
	 * @param {{ mode: 'panel', targetId: string }} request Normalized panel request.
	 * @returns {{ composition: object, corePanels: Record<string, object>, request: { mode: string, targetId: string } }}
	 *   View payload with a synthetic single composition.
	 */
	_buildPanelView(request) {
		const panelTarget = this._parsePanelTarget(request.targetId);
		const composition = this._buildSyntheticComposition(request.targetId, panelTarget);
		return {
			composition,
			corePanels: this._extractCorePanels(composition),
			request,
		};
	}

	/**
	 * Create the synthetic single composition used for `panel=` requests.
	 *
	 * Core-panel targets become a single string panel entry.
	 * Plugin-panel targets become a single structured plugin ref so plugin-owned metadata stays outside the registry.
	 *
	 * @param {string} targetId Canonical `tab-...` target id from the request.
	 * @param {{ kind: 'core', tabId: string, panelId: string } | { kind: 'plugin', tabId: string, pluginType: string, instanceId: number, panelId: string }} panelTarget
	 *   Parsed panel target descriptor.
	 * @returns {{ id: string, layout: 'single', panels: Array<any>, defaultPanel: string, deviceMode: 'pc' }}
	 *   Synthetic single-panel composition.
	 */
	_buildSyntheticComposition(targetId, panelTarget) {
		const compositionId = `comp-${targetId}`;
		if (panelTarget.kind === 'plugin') {
			const ref = Object.freeze({
				type: 'pluginPanel',
				pluginType: panelTarget.pluginType,
				instanceId: panelTarget.instanceId,
				panelId: panelTarget.panelId,
			});
			return {
				id: compositionId,
				layout: 'single',
				panels: [ref],
				defaultPanel: `plugin-${panelTarget.pluginType}-${panelTarget.instanceId}-${panelTarget.panelId}`,
				deviceMode: 'pc',
			};
		}
		return {
			id: compositionId,
			layout: 'single',
			panels: [panelTarget.panelId],
			defaultPanel: panelTarget.panelId,
			deviceMode: 'pc',
		};
	}

	/**
	 * Extract only core/native panel definitions referenced by one composition.
	 *
	 * Plugin-panel refs are skipped intentionally because plugin-owned metadata must not be mirrored here.
	 * Wildcard compositions expand to every core panel registered in `this.registry.panels`.
	 *
	 * @param {any} composition Composition candidate.
	 * @returns {Record<string, object>} Map of resolved core panel definitions.
	 */
	_extractCorePanels(composition) {
		const corePanels = {};
		if (!composition || typeof composition !== 'object') {
			return corePanels;
		}
		const panelEntries = Array.isArray(composition.panels) ? composition.panels : [];
		if (panelEntries.length === 1 && panelEntries[0] === '*') {
			for (const [panelId, panelDef] of Object.entries(this.registry.panels)) {
				corePanels[panelId] = panelDef;
			}
			return corePanels;
		}
		for (const entry of panelEntries) {
			if (typeof entry !== 'string' || !entry) {
				continue;
			}
			const panelDef = this.registry.panels[entry];
			if (panelDef && typeof panelDef === 'object') {
				corePanels[entry] = panelDef;
			}
		}
		return corePanels;
	}

	/**
	 * Parse a canonical `tab-...` panel target into either a core or plugin descriptor.
	 *
	 * @param {string} targetId Canonical request target id.
	 * @returns {{ kind: 'core', tabId: string, panelId: string } | { kind: 'plugin', tabId: string, pluginType: string, instanceId: number, panelId: string }}
	 *   Parsed panel target descriptor.
	 */
	_parsePanelTarget(targetId) {
		const tabId = targetId.slice('tab-'.length);
		if (!tabId.startsWith('plugin-')) {
			return { kind: 'core', tabId, panelId: tabId };
		}
		const pluginMatch = /^plugin-([A-Za-z][A-Za-z0-9]*)-(\d+)-([a-z0-9][a-z0-9-]*)$/.exec(tabId);
		if (!pluginMatch) {
			throw this._badRequest(`Invalid panel target '${targetId}'`);
		}
		return {
			kind: 'plugin',
			tabId,
			pluginType: pluginMatch[1],
			instanceId: Number.parseInt(pluginMatch[2], 10),
			panelId: pluginMatch[3],
		};
	}

	/**
	 * Check whether a panel target is formally valid for `panel=` requests.
	 *
	 * This is a syntax-only check. Existence and runtime availability are resolved separately.
	 *
	 * @param {string} targetId Candidate target id.
	 * @returns {boolean} True when the target is formally valid.
	 */
	_isValidPanelTargetId(targetId) {
		return /^tab-[A-Za-z0-9][A-Za-z0-9-]*$/.test(targetId);
	}

	/**
	 * Create a stable bad-request error with the canonical `BAD_REQUEST` code.
	 *
	 * @param {string} message Human-readable validation error.
	 * @returns {Error & { code: 'BAD_REQUEST' }} Structured validation error.
	 */
	_badRequest(message) {
		return Object.assign(new Error(String(message || 'Bad request')), { code: 'BAD_REQUEST' });
	}
}

module.exports = { DEFAULT_COMPOSITION_ID, IoUiCatalog };
