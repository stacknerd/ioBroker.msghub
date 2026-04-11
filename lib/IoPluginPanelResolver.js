/**
 * IoPluginPanelResolver
 * =====================
 * Canonical backend resolver for running plugin-owned panels.
 *
 * Docs: ../docs/io/IoPluginPanelResolver.md
 *
 * Responsibilities
 * - Resolve currently running plugin-owned panels from `IoPlugins`.
 * - Project raw plugin runtime/package data into one host-safe runtime DTO.
 *
 * Non-responsibilities
 * - No public command ownership -> owned by `IoWebUi` / `IoAdminTab`.
 * - No view assembly -> owned by `IoUiCatalog`.
 * - No bundle transport or RPC dispatch -> owned by `IoWebUi` / `IoPluginUiRpc`.
 */

'use strict';

/**
 * Canonical backend resolver for running plugin-owned panels.
 */
class IoPluginPanelResolver {
	/**
	 * @param {{ ioPlugins?: import('./IoPlugins').IoPlugins|null, log?: { warn?: Function }|null }} [options]
	 *   Optional runtime services.
	 */
	constructor({ ioPlugins = null, log = null } = {}) {
		this.ioPlugins = ioPlugins && typeof ioPlugins === 'object' ? ioPlugins : null;
		this.log = log && typeof log === 'object' ? log : null;
	}

	/**
	 * Return whether the plugin runtime dependencies are wired.
	 *
	 * @returns {boolean} True when the resolver can query running plugin panels.
	 */
	isReady() {
		return !!(
			this.ioPlugins &&
			typeof this.ioPlugins.getAdminUiContributions === 'function' &&
			typeof this.ioPlugins.computeAdminUiBundleHash === 'function'
		);
	}

	/**
	 * Resolve all running plugin panels indexed by canonical runtime panel id.
	 *
	 * @returns {Promise<Record<string, object>>} Panels keyed by runtime panel id.
	 */
	async getPanelsByRuntimeId() {
		this._assertReady();
		const ioPlugins = this._getIoPlugins();
		const contributions = ioPlugins.getAdminUiContributions();
		const hashes = await Promise.all(
			contributions.map(async contribution => await this._computeBundleHash(contribution)),
		);

		const out = {};
		for (const [index, contribution] of contributions.entries()) {
			const panel = this._toResolvedPanel(contribution, { hash: hashes[index] });
			out[panel.id] = panel;
		}
		return out;
	}

	/**
	 * Resolve one running plugin panel by canonical runtime panel id.
	 *
	 * @param {{ runtimePanelId?: string }} [options] Resolver options.
	 * @returns {Promise<object|null>} Resolved panel or null.
	 */
	async getPanelByRuntimeId({ runtimePanelId } = {}) {
		const rawRuntimePanelId = typeof runtimePanelId === 'string' ? runtimePanelId.trim() : '';
		const match = /^plugin-([A-Za-z][A-Za-z0-9]*)-(\d+)-([a-z0-9][a-z0-9-]*)$/.exec(rawRuntimePanelId);
		if (!match) {
			return null;
		}
		return await this.getPanelByRef({
			pluginType: match[1],
			instanceId: Number.parseInt(match[2], 10),
			panelId: match[3],
		});
	}

	/**
	 * Resolve one running plugin panel by structured runtime ref.
	 *
	 * @param {{ pluginType?: string, instanceId?: number, panelId?: string }} [options] Resolver options.
	 * @returns {Promise<object|null>} Resolved panel or null.
	 */
	async getPanelByRef({ pluginType, instanceId = 0, panelId } = {}) {
		this._assertReady();
		const ioPlugins = this._getIoPlugins();
		const type = typeof pluginType === 'string' ? pluginType.trim() : '';
		const resolvedPanelId = typeof panelId === 'string' ? panelId.trim() : '';
		const resolvedInstanceId =
			typeof instanceId === 'number' && Number.isFinite(instanceId) ? Math.trunc(instanceId) : 0;
		if (!type || !resolvedPanelId) {
			return null;
		}

		const contribution = ioPlugins
			.getAdminUiContributions()
			.find(
				c => c?.pluginType === type && c?.instanceId === resolvedInstanceId && c?.panelId === resolvedPanelId,
			);
		if (!contribution) {
			return null;
		}

		return this._toResolvedPanel(contribution, { hash: await this._computeBundleHash(contribution) });
	}

	/**
	 * Convert one raw runtime contribution into the canonical resolver DTO.
	 *
	 * @param {object} contribution Raw contribution.
	 * @param {{ hash?: string }} [options] Enriched runtime metadata.
	 * @returns {object} Resolved panel.
	 */
	_toResolvedPanel(contribution, { hash = '' } = {}) {
		const pluginType = typeof contribution?.pluginType === 'string' ? contribution.pluginType.trim() : '';
		const instanceId =
			typeof contribution?.instanceId === 'number' && Number.isFinite(contribution.instanceId)
				? Math.trunc(contribution.instanceId)
				: 0;
		const panelId = typeof contribution?.panelId === 'string' ? contribution.panelId.trim() : '';
		const runtimePanelId = `plugin-${pluginType}-${instanceId}-${panelId}`;
		return {
			id: runtimePanelId,
			pluginType,
			instanceId,
			panelId,
			label: typeof contribution?.label === 'string' ? contribution.label : '',
			description: typeof contribution?.description === 'string' ? contribution.description : '',
			...(typeof contribution?.category === 'string' ? { category: contribution.category } : {}),
			ui: {
				kind: 'plugin',
				loader: 'esm',
				apiVersion: typeof contribution?.apiVersion === 'string' ? contribution.apiVersion : '1',
				bundle: {
					hash: typeof hash === 'string' ? hash : '',
				},
			},
			...(contribution?.app && typeof contribution.app === 'object' ? { app: contribution.app } : {}),
		};
	}

	/**
	 * Compute the advisory bundle hash for one contribution, degrading softly on failure.
	 *
	 * @param {object} contribution Raw contribution.
	 * @returns {Promise<string>} Advisory hash or empty string.
	 */
	async _computeBundleHash(contribution) {
		const ioPlugins = this._getIoPlugins();
		try {
			return await ioPlugins.computeAdminUiBundleHash({
				type: contribution.pluginType,
				panelId: contribution.panelId,
			});
		} catch (e) {
			this.log?.warn?.(
				`PluginPanelResolver: failed to compute hash for '${contribution?.pluginType}/${contribution?.panelId}': ${e?.message || e}`,
			);
			return '';
		}
	}

	/**
	 * Ensure the runtime dependencies are wired before resolving panels.
	 *
	 * @returns {void}
	 */
	_assertReady() {
		if (!this.isReady()) {
			throw Object.assign(new Error('Plugin runtime not ready'), { code: 'NOT_READY' });
		}
	}

	/**
	 * Return the wired `IoPlugins` dependency after readiness has been checked.
	 *
	 * @returns {import('./IoPlugins').IoPlugins} Runtime/package source.
	 */
	_getIoPlugins() {
		this._assertReady();
		const ioPlugins = this.ioPlugins;
		if (!ioPlugins) {
			throw Object.assign(new Error('Plugin runtime not ready'), { code: 'NOT_READY' });
		}
		return ioPlugins;
	}
}

module.exports = { IoPluginPanelResolver };
