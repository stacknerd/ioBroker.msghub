/**
 * IoAdminCapabilities
 * ===================
 * Central bootstrap/capability builder for host-facing UI entry points.
 *
 * Docs: ../docs/io/IoAdminCapabilities.md
 *
 * System integration:
 * - Used by `main.js` for the admin-host `ui.bootstrap` response.
 * - Intentionally host-aware (`admin` / `webExtension`) without owning host routing.
 * - Does not implement token issuance, TTL, expiry, or command gates in this package.
 *
 * Public contract:
 * - `buildBootstrap({ host })` returns the stable bootstrap payload `{ capabilities, about }`.
 * - `buildAbout()` returns the shared `about` payload currently reused by legacy `runtime.about`.
 */

'use strict';

/**
 * Central bootstrap/capability builder for MsgHub UI hosts.
 */
class IoAdminCapabilities {
	/**
	 * @param {any} adapter
	 *   ioBroker adapter instance.
	 * @param {object} [options] Optional runtime dependencies.
	 * @param {any} [options.ioPackage] Optional parsed io-package metadata.
	 */
	constructor(adapter, { ioPackage = null } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoAdminCapabilities: adapter is required');
		}
		this.adapter = adapter;
		this.ioPackage = ioPackage && typeof ioPackage === 'object' ? ioPackage : null;
	}

	/**
	 * Normalize the host class for bootstrap/capability evaluation.
	 *
	 * @param {string} [host] Requested host class.
	 * @returns {'admin'|'webExtension'} Normalized host class.
	 */
	normalizeHost(host) {
		const value = typeof host === 'string' ? host.trim() : '';
		if (!value || value === 'admin') {
			return 'admin';
		}
		if (value === 'webExtension') {
			return 'webExtension';
		}
		throw new Error(`Unsupported bootstrap host '${value || '<empty>'}'`);
	}

	/**
	 * Build the stable capability block for the requested host.
	 *
	 * AP3 deliberately keeps this block empty. Token issuance, TTL, expiry,
	 * and namespace gates are not introduced in this package.
	 *
	 * @param {object} [options] Capability options.
	 * @param {string} [options.host] Requested host class.
	 * @returns {Record<string, never>} Empty capability block.
	 */
	buildCapabilities({ host = 'admin' } = {}) {
		this.normalizeHost(host);
		return {};
	}

	/**
	 * Build the shared runtime/about payload.
	 *
	 * @returns {{
	 *   title: string,
	 *   version: string,
	 *   time: { timeZone: string, source: string },
	 *   lang: { backendTextLanguage: string, coreTextLanguage: string, coreFormatLocale: string },
	 *   connection: { scope: string, connected: boolean, mode: string }
	 * }} Shared about payload.
	 */
	buildAbout() {
		const adapterVersion = this.ioPackage?.common?.version ?? '0.0.0';
		const adapterTitle =
			this.ioPackage?.common?.titleLang?.de ?? this.ioPackage?.common?.titleLang?.en ?? 'Message Hub';

		let serverTimeZone = '';
		try {
			serverTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
		} catch {
			serverTimeZone = '';
		}
		const timeZone = typeof serverTimeZone === 'string' ? serverTimeZone.trim() : '';

		return {
			title: adapterTitle,
			version: adapterVersion,
			time: {
				timeZone: timeZone || 'UTC',
				source: timeZone ? 'server' : 'fallback-utc',
			},
			lang: {
				backendTextLanguage: this.adapter.i18nBackend?.i18nlocale || 'en',
				coreTextLanguage: this.adapter.i18nCore?.i18nlocale || 'en',
				coreFormatLocale: this.adapter.i18nCore?.locale || 'en',
			},
			connection: this.adapter._coreConnection?.getRuntimeAbout?.() || {
				scope: 'core-link',
				connected: false,
				mode: 'local',
			},
		};
	}

	/**
	 * Build the stable bootstrap payload for the requested host.
	 *
	 * @param {object} [options] Bootstrap options.
	 * @param {string} [options.host] Requested host class.
	 * @returns {{ capabilities: Record<string, never>, about: ReturnType<IoAdminCapabilities['buildAbout']> }}
	 *   Stable bootstrap payload.
	 */
	buildBootstrap({ host = 'admin' } = {}) {
		const normalizedHost = this.normalizeHost(host);
		return {
			capabilities: this.buildCapabilities({ host: normalizedHost }),
			about: this.buildAbout(),
		};
	}
}

module.exports = { IoAdminCapabilities };
