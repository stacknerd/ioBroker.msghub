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
 * - Owns capability-token issuance, validation, TTL/expiry, and the canonical payload token contract.
 *
 * Public contract:
 * - `buildBootstrap({ host })` returns the stable bootstrap payload `{ capabilities, about }`.
 * - `buildAbout()` returns the shared `about` payload currently reused by legacy `runtime.about`.
 * - `validateToken(...)` validates minted capability tokens against host/scope/expiry.
 * - `consumePayloadToken(...)` enforces the canonical `payload.token` contract and strips the token from the payload.
 */

'use strict';

const crypto = require('crypto');

/**
 * Central bootstrap/capability builder for MsgHub UI hosts.
 */
class IoAdminCapabilities {
	static TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

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
		this._issuedTokens = new Map();
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
	 * Return the canonical capability grants for one host class.
	 *
	 * @param {'admin'|'webExtension'} host Normalized host class.
	 * @returns {Array<'admin'|'config'|'web'>} Capability names granted to that host.
	 */
	getGrantedCapabilities(host) {
		if (host === 'admin') {
			return ['admin', 'config', 'web'];
		}
		if (host === 'webExtension') {
			return ['web'];
		}
		throw new Error(`Unsupported bootstrap host '${host || '<empty>'}'`);
	}

	/**
	 * Normalize the capability name for token issuance/validation.
	 *
	 * @param {string} capability Requested capability.
	 * @returns {'admin'|'config'|'web'} Normalized capability.
	 */
	normalizeCapability(capability) {
		const value = typeof capability === 'string' ? capability.trim() : '';
		if (value === 'admin' || value === 'config' || value === 'web') {
			return value;
		}
		throw new Error(`Unsupported capability '${value || '<empty>'}'`);
	}

	/**
	 * Return the current wall-clock time in milliseconds.
	 *
	 * @returns {number} Current timestamp.
	 */
	getNow() {
		return Date.now();
	}

	/**
	 * Remove expired tokens from the in-memory authority cache.
	 *
	 * @param {number} now Current timestamp.
	 * @returns {void} Nothing.
	 */
	pruneExpiredTokens(now) {
		for (const [token, record] of this._issuedTokens.entries()) {
			if (!record || record.expiresAt <= now) {
				this._issuedTokens.delete(token);
			}
		}
	}

	/**
	 * Generate a cryptographically strong opaque token string.
	 *
	 * @returns {string} Opaque token.
	 */
	createOpaqueToken() {
		return crypto.randomBytes(24).toString('base64url');
	}

	/**
	 * Mint one host- and capability-bound token.
	 *
	 * @param {object} options Minting options.
	 * @param {string} options.host Requested host class.
	 * @param {string} options.capability Requested capability.
	 * @returns {{ token: string, expiresAt: string }} Capability grant.
	 */
	mintToken({ host, capability }) {
		const normalizedHost = this.normalizeHost(host);
		const normalizedCapability = this.normalizeCapability(capability);
		const granted = this.getGrantedCapabilities(normalizedHost);
		if (!granted.includes(normalizedCapability)) {
			throw new Error(`Capability '${normalizedCapability}' is not available for host '${normalizedHost}'`);
		}
		const now = this.getNow();
		this.pruneExpiredTokens(now);
		const expiresAtMs = now + IoAdminCapabilities.TOKEN_TTL_MS;
		const token = this.createOpaqueToken();
		this._issuedTokens.set(token, {
			host: normalizedHost,
			capability: normalizedCapability,
			expiresAt: expiresAtMs,
		});
		return {
			token,
			expiresAt: new Date(expiresAtMs).toISOString(),
		};
	}

	/**
	 * Build the stable capability block for the requested host.
	 *
	 * @param {object} [options] Capability options.
	 * @param {string} [options.host] Requested host class.
	 * @returns {Partial<Record<'admin'|'config'|'web', { token: string, expiresAt: string }>>}
	 *   Capability grants for the requested host.
	 */
	buildCapabilities({ host = 'admin' } = {}) {
		const normalizedHost = this.normalizeHost(host);
		const capabilities = {};
		for (const capability of this.getGrantedCapabilities(normalizedHost)) {
			capabilities[capability] = this.mintToken({
				host: normalizedHost,
				capability,
			});
		}
		return capabilities;
	}

	/**
	 * Validate a host- and capability-bound token.
	 *
	 * @param {object} options Validation options.
	 * @param {string} options.host Requested host class.
	 * @param {string} options.capability Requested capability.
	 * @param {string} options.token Opaque capability token.
	 * @returns {{ token: string, expiresAt: string }} Validated token metadata.
	 */
	validateToken({ host, capability, token }) {
		const normalizedHost = this.normalizeHost(host);
		const normalizedCapability = this.normalizeCapability(capability);
		const normalizedToken = typeof token === 'string' ? token.trim() : '';
		if (!normalizedToken) {
			throw new Error(`Missing token for capability '${normalizedCapability}'`);
		}
		const now = this.getNow();
		this.pruneExpiredTokens(now);
		const record = this._issuedTokens.get(normalizedToken);
		if (!record) {
			throw new Error('Invalid or expired token');
		}
		if (record.host !== normalizedHost) {
			throw new Error(`Token host mismatch: expected '${normalizedHost}', got '${record.host}'`);
		}
		if (record.capability !== normalizedCapability) {
			throw new Error(
				`Token capability mismatch: expected '${normalizedCapability}', got '${record.capability}'`,
			);
		}
		if (record.expiresAt <= now) {
			this._issuedTokens.delete(normalizedToken);
			throw new Error('Invalid or expired token');
		}
		return {
			token: normalizedToken,
			expiresAt: new Date(record.expiresAt).toISOString(),
		};
	}

	/**
	 * Read and validate the canonical `payload.token`, then strip it from the
	 * business payload before a facade continues command execution.
	 *
	 * @param {object} options Contract options.
	 * @param {string} options.host Requested host class.
	 * @param {string} options.capability Requested capability.
	 * @param {any} options.payload Raw command payload.
	 * @returns {Record<string, any>} Payload without `token`.
	 */
	consumePayloadToken({ host, capability, payload }) {
		const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
		this.validateToken({
			host,
			capability,
			token: safePayload.token,
		});
		const { token: _ignoredToken, ...restPayload } = safePayload;
		return restPayload;
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
	 * @returns {{
	 *   capabilities: Partial<Record<'admin'|'config'|'web', { token: string, expiresAt: string }>>,
	 *   about: ReturnType<IoAdminCapabilities['buildAbout']>
	 * }} Stable bootstrap payload.
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
