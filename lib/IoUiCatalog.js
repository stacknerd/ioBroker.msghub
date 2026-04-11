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
	 * @param {import('./IoPluginPanelResolver').IoPluginPanelResolver|null} [options.pluginPanelResolver]
	 *   Optional canonical runtime resolver for plugin-owned panels.
	 */
	constructor({ registry = uiRegistry, pluginPanelResolver = null } = {}) {
		const safeRegistry = registry && typeof registry === 'object' ? registry : null;
		if (!safeRegistry?.panels || !safeRegistry?.compositions) {
			throw new Error('IoUiCatalog: registry with panels and compositions is required');
		}
		this.registry = safeRegistry;
		this.pluginPanelResolver =
			pluginPanelResolver && typeof pluginPanelResolver === 'object' ? pluginPanelResolver : null;
	}

	/**
	 * Resolve one normalized view payload for `web.view.get`.
	 *
	 * @param {any} request Raw request payload (`{ mode, targetId? }`).
	 * @returns {Promise<{ composition: object, corePanels: Record<string, object>, pluginPanels: Record<string, object>, request: { mode: string, targetId: string } }>}
	 *   Canonical backend view payload.
	 */
	async getView(request) {
		const normalizedRequest = this._normalizeRequest(request);
		const runtimePluginPanels = await this._getRuntimePluginPanels();
		if (normalizedRequest.mode === 'panel') {
			return this._buildPanelView(normalizedRequest, runtimePluginPanels);
		}
		return this._buildCompositionView(normalizedRequest, runtimePluginPanels);
	}

	/**
	 * Validate and normalize the incoming view request.
	 *
	 * Composition mode defaults to `DEFAULT_COMPOSITION_ID` when `targetId` is omitted.
	 * Panel mode requires a formally valid `tab-...` target but does not perform runtime availability checks.
	 *
	 * @param {any} request Raw request payload.
	 * @returns {{ mode: 'composition', targetId: string } | { mode: 'panel', targetId: string }}
	 *   Normalized request object.
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
	 * @param {{ mode: string, targetId: string }} request Normalized composition request.
	 * @param {Record<string, object>} runtimePluginPanels Plugin panels keyed by runtime panel id.
	 * @returns {{ composition: object, corePanels: Record<string, object>, pluginPanels: Record<string, object>, request: { mode: string, targetId: string } }}
	 *   View payload backed directly by the registry composition.
	 */
	_buildCompositionView(request, runtimePluginPanels) {
		const composition = this._materializeComposition(
			this.registry.compositions[request.targetId],
			runtimePluginPanels,
		);
		return {
			composition,
			corePanels: this._extractCorePanels(composition),
			pluginPanels: this._extractPluginPanels(composition, runtimePluginPanels),
			request,
		};
	}

	/**
	 * Build the view payload for a single-panel request.
	 *
	 * The returned composition is synthetic and intentionally contains only the requested panel target.
	 *
	 * @param {{ mode: string, targetId: string }} request Normalized panel request.
	 * @param {Record<string, object>} runtimePluginPanels Plugin panels keyed by runtime panel id.
	 * @returns {{ composition: object, corePanels: Record<string, object>, pluginPanels: Record<string, object>, request: { mode: string, targetId: string } }}
	 *   View payload with a synthetic single composition.
	 */
	_buildPanelView(request, runtimePluginPanels) {
		const panelTarget = this._parsePanelTarget(request.targetId);
		const composition = this._buildSyntheticComposition(request.targetId, panelTarget);
		return {
			composition,
			corePanels: this._extractCorePanels(composition),
			pluginPanels: this._extractPluginPanels(composition, runtimePluginPanels),
			request,
		};
	}

	/**
	 * Resolve the current runtime plugin panels through the canonical backend resolver.
	 *
	 * `web.view.get` tolerates an unavailable runtime by treating it as "no running plugin panels"
	 * so core-only views stay consumable during startup or reconnect gaps.
	 *
	 * @returns {Promise<Record<string, object>>} Plugin panels keyed by runtime panel id.
	 */
	async _getRuntimePluginPanels() {
		if (!this.pluginPanelResolver || typeof this.pluginPanelResolver.getPanelsByRuntimeId !== 'function') {
			return {};
		}
		try {
			return await this.pluginPanelResolver.getPanelsByRuntimeId();
		} catch (e) {
			if (e?.code === 'NOT_READY') {
				return {};
			}
			throw e;
		}
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
	 * Materialize wildcard compositions backend-side and keep explicit plugin refs stable.
	 *
	 * @param {any} composition Source composition.
	 * @param {Record<string, object>} runtimePluginPanels Plugin panels keyed by runtime panel id.
	 * @returns {object} Materialized composition payload.
	 */
	_materializeComposition(composition, runtimePluginPanels) {
		const safeComposition = composition && typeof composition === 'object' ? composition : {};
		const sourcePanels = Array.isArray(safeComposition.panels) ? safeComposition.panels : [];
		const isWildcard = sourcePanels.length === 1 && sourcePanels[0] === '*';
		const panels = [];

		if (isWildcard) {
			for (const panelId of Object.keys(this.registry.panels)) {
				panels.push(panelId);
			}
			for (const panel of Object.values(runtimePluginPanels)) {
				panels.push(this._buildPluginRef(panel));
			}
		} else {
			for (const entry of sourcePanels) {
				if (typeof entry === 'string' && entry) {
					panels.push(entry);
					continue;
				}
				if (entry && typeof entry === 'object' && entry.type === 'pluginPanel') {
					panels.push({
						type: 'pluginPanel',
						pluginType: entry.pluginType,
						instanceId: entry.instanceId,
						panelId: entry.panelId,
					});
				}
			}
		}

		return {
			...safeComposition,
			panels,
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
	 * Extract only resolved plugin panel definitions referenced by one composition.
	 *
	 * Explicit refs that are currently unavailable stay in `composition.panels` but are omitted here.
	 *
	 * @param {any} composition Composition candidate.
	 * @param {Record<string, object>} runtimePluginPanels Plugin panels keyed by runtime panel id.
	 * @returns {Record<string, object>} View-safe plugin panel map.
	 */
	_extractPluginPanels(composition, runtimePluginPanels) {
		const pluginPanels = {};
		if (!composition || typeof composition !== 'object') {
			return pluginPanels;
		}
		const panelEntries = Array.isArray(composition.panels) ? composition.panels : [];
		for (const entry of panelEntries) {
			if (!entry || typeof entry !== 'object' || entry.type !== 'pluginPanel') {
				continue;
			}
			const runtimePanelId = this._toRuntimePanelId(entry);
			const panel = runtimePluginPanels[runtimePanelId];
			if (panel) {
				pluginPanels[runtimePanelId] = this._toViewPluginPanel(panel);
			}
		}
		return pluginPanels;
	}

	/**
	 * Convert one resolver panel into the view-safe `pluginPanels[*]` DTO.
	 *
	 * @param {object} panel Resolved runtime panel.
	 * @returns {object} View-safe plugin panel payload.
	 */
	_toViewPluginPanel(panel) {
		return {
			id: panel.id,
			label: panel.label,
			description: panel.description,
			...(typeof panel.category === 'string' ? { category: panel.category } : {}),
			ui: {
				kind: 'plugin',
				loader: 'esm',
				apiVersion: panel.ui?.apiVersion || '1',
				bundle: {
					hash: typeof panel.ui?.bundle?.hash === 'string' ? panel.ui.bundle.hash : '',
				},
			},
			...(panel.app && typeof panel.app === 'object' ? { app: panel.app } : {}),
		};
	}

	/**
	 * Build a structured plugin ref from a resolved runtime panel.
	 *
	 * @param {object} panel Resolved runtime panel.
	 * @returns {{ type: 'pluginPanel', pluginType: string, instanceId: number, panelId: string }} Structured plugin ref.
	 */
	_buildPluginRef(panel) {
		return {
			type: 'pluginPanel',
			pluginType: panel.pluginType,
			instanceId: panel.instanceId,
			panelId: panel.panelId,
		};
	}

	/**
	 * Build the canonical runtime panel id for one structured plugin ref.
	 *
	 * @param {{ pluginType?: string, instanceId?: number, panelId?: string }} panelRef Structured plugin ref.
	 * @returns {string} Canonical runtime panel id.
	 */
	_toRuntimePanelId(panelRef) {
		return `plugin-${panelRef.pluginType}-${panelRef.instanceId}-${panelRef.panelId}`;
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
	 * @returns {Error & { code: string }} Structured validation error.
	 */
	_badRequest(message) {
		return Object.assign(new Error(String(message || 'Bad request')), { code: 'BAD_REQUEST' });
	}
}

module.exports = { DEFAULT_COMPOSITION_ID, IoUiCatalog };
