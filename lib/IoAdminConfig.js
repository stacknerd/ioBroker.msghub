/**
 * IoAdminConfig
 * =============
 * Adapter-side jsonConfig command facade for MsgHub.
 *
 * Docs: ../docs/io/IoAdminConfig.md
 *
 * Responsibilities
 * - Handle adapter messagebox commands in the `config.*` namespace.
 * - Execute config-facing archive strategy actions (`status`, `retryNative`, `forceIobroker`).
 * - Execute config-facing AI connectivity checks (`config.ai.test`).
 * - Apply strict filtering for `useNative` patch payloads before they reach jsonConfig.
 *
 * Non-responsibilities
 * - Admin tab runtime/read APIs (`admin.*`) -> owned by `IoAdminTab`.
 * - General plugin lifecycle/runtime orchestration -> owned by `IoPlugins` / core runtime.
 * - Archive strategy resolution itself -> owned by `IoArchiveResolver` at startup.
 *
 * Design intent
 * - Keep config command handling isolated from Admin tab command handling.
 * - Expose only a narrow, explicit native patch surface to avoid broad config writes.
 *
 */

'use strict';

const { IoArchiveResolver } = require(`${__dirname}/IoArchiveResolver`);

function isObject(value) {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Handles `config.*` commands from jsonConfig/jsonCustom.
 *
 * This class is separated from `IoAdminTab` to keep Admin-Tab runtime commands and
 * config/native patch commands on distinct routes.
 */
class IoAdminConfig {
	// Native keys that may be patched by `config.*` command responses.
	static CONFIG_NATIVE_ALLOWLIST = new Set([
		'archiveEffectiveStrategyLock',
		'archiveLockReason',
		'archiveLockedAt',
		'archiveRuntimeStrategy',
		'archiveRuntimeReason',
		'archiveRuntimeRoot',
		'aiTestLastResult',
	]);

	/**
	 * Create a config command facade bound to one adapter instance.
	 *
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} adapter
	 *   ioBroker adapter instance.
	 * @param {object} [options] Optional runtime services and test hooks.
	 * @param {import('../src/MsgAi').MsgAi|null} [options.ai]
	 *   Optional shared MsgAi runtime used by `config.ai.test`.
	 * @param {any} [options.msgStore]
	 *   Optional MsgStore runtime used by archive status/probe commands.
	 * @param {(options: object) => Promise<{ok:boolean, reason:string}>} [options.archiveProbeNative]
	 *   Optional native archive probe function (test hook). Defaults to `IoArchiveResolver.probeNativeFor`.
	 */
	constructor(adapter, { ai = null, msgStore = null, archiveProbeNative } = {}) {
		if (!adapter?.namespace) {
			throw new Error('IoAdminConfig: adapter is required');
		}
		this.adapter = adapter;
		this.ai = ai && typeof ai === 'object' ? ai : null;
		this.msgStore = msgStore && typeof msgStore === 'object' ? msgStore : null;
		this._archiveProbeNative = typeof archiveProbeNative === 'function' ? archiveProbeNative : null;
	}

	/**
	 * Build a successful response envelope.
	 *
	 * @param {object} [data] Response payload.
	 * @returns {{ok: true, data: object}} Success envelope.
	 */
	_ok(data) {
		return { ok: true, data: data || {} };
	}

	/**
	 * Build an error response envelope.
	 *
	 * @param {string} code Machine-readable error code.
	 * @param {string} message Human-readable error message.
	 * @returns {{ok: false, error: {code: string, message: string}}} Error envelope.
	 */
	_err(code, message) {
		return { ok: false, error: { code: String(code || 'ERROR'), message: String(message || 'Error') } };
	}

	/**
	 * Restrict `native` patch payloads to the explicit config allowlist.
	 *
	 * Any key not explicitly listed in `CONFIG_NATIVE_ALLOWLIST` is dropped.
	 * This is a hard guardrail against accidental broad writes via `useNative`.
	 *
	 * @param {any} result Raw command result.
	 * @returns {any} Result with filtered `native` payload.
	 */
	_applyNativeAllowlist(result) {
		if (!isObject(result)) {
			return result;
		}
		const resultObj = result;
		if (!isObject(resultObj.native)) {
			return result;
		}

		const allowed = {};
		const dropped = [];
		for (const [key, value] of Object.entries(resultObj.native)) {
			// Keep config channel strictly scoped to a tiny native patch surface.
			if (IoAdminConfig.CONFIG_NATIVE_ALLOWLIST.has(key)) {
				allowed[key] = value;
			} else {
				dropped.push(key);
			}
		}
		if (dropped.length > 0) {
			this.adapter?.log?.warn?.(`IoAdminConfig: dropped disallowed native patch keys: ${dropped.join(', ')}`);
		}
		return {
			...result,
			native: allowed,
		};
	}

	/**
	 * Read a snapshot of archive runtime status.
	 *
	 * This is runtime transparency only (what is currently active), not persisted intent.
	 *
	 * @returns {{
	 *  configuredStrategyLock: string,
	 *  effectiveStrategy: string,
	 *  effectiveStrategyReason: string,
	 *  runtimeRoot: string,
	 *  nativeProbeError: string
	 * }|null} Archive status snapshot or null when runtime is not ready.
	 */
	_archiveStatusSnapshot() {
		const archive = this.msgStore?.msgArchive;
		if (!archive || typeof archive.getStatus !== 'function') {
			return null;
		}
		const status = archive.getStatus();
		return {
			configuredStrategyLock:
				typeof status?.configuredStrategyLock === 'string' ? status.configuredStrategyLock : '',
			effectiveStrategy: typeof status?.effectiveStrategy === 'string' ? status.effectiveStrategy : '',
			effectiveStrategyReason:
				typeof status?.effectiveStrategyReason === 'string' ? status.effectiveStrategyReason : '',
			runtimeRoot: typeof status?.runtimeRoot === 'string' ? status.runtimeRoot : '',
			nativeProbeError: typeof status?.nativeProbeError === 'string' ? status.nativeProbeError : '',
		};
	}

	/**
	 * Build `native` runtime archive fields from current status snapshot.
	 *
	 * These fields are mirrored for visibility in jsonConfig and filtered by allowlist.
	 *
	 * @returns {{
	 *  archiveRuntimeStrategy: string,
	 *  archiveRuntimeReason: string,
	 *  archiveRuntimeRoot: string
	 * }} Runtime archive patch fields.
	 */
	_archiveRuntimeNativePatch() {
		const snap = this._archiveStatusSnapshot();
		return {
			archiveRuntimeStrategy: snap?.effectiveStrategy || '',
			archiveRuntimeReason: snap?.effectiveStrategyReason || '',
			archiveRuntimeRoot: snap?.runtimeRoot || '',
		};
	}

	/**
	 * Handle `config.archive.status`.
	 *
	 * Returns:
	 * - runtime status in `data.archive`
	 * - mirrored runtime fields in `native.*` (still allowlist-filtered by caller)
	 *
	 * @returns {{
	 *  ok: boolean,
	 *  data?: { archive: object },
	 *  native?: { archiveRuntimeStrategy: string, archiveRuntimeReason: string, archiveRuntimeRoot: string },
	 *  error?: { code: string, message: string }
	 * }} Status response.
	 */
	_archiveStatus() {
		const snap = this._archiveStatusSnapshot();
		if (!snap) {
			return this._err('NOT_READY', 'Archive runtime not ready');
		}
		return {
			ok: true,
			data: { archive: snap },
			native: this._archiveRuntimeNativePatch(),
		};
	}

	/**
	 * Handle `config.archive.retryNative`.
	 *
	 * Flow:
	 * 1. Read current archive runtime status.
	 * 2. Probe native storage capability.
	 * 3. On success, return lock patch for next startup.
	 *
	 * Note: strategy switch itself is startup-time behavior; this command only writes intent.
	 *
	 * @returns {Promise<{
	 *  ok: boolean,
	 *  data?: object,
	 *  native?: object,
	 *  error?: { code: string, message: string }
	 * }>} Retry response.
	 */
	async _archiveRetryNative() {
		const archive = this.msgStore?.msgArchive;
		if (!archive || typeof archive !== 'object') {
			return this._err('NOT_READY', 'Archive runtime not ready');
		}
		if (typeof archive.getStatus !== 'function') {
			return this._err('NOT_READY', 'Archive runtime status not available');
		}
		const status = archive.getStatus();
		// Test hook first; production path falls back to resolver probe helper.
		const probeNative =
			typeof this._archiveProbeNative === 'function'
				? this._archiveProbeNative
				: options => IoArchiveResolver.probeNativeFor(options);
		let probe;
		try {
			// Probe against currently known runtime roots/format to validate native viability.
			probe = await probeNative({
				adapter: this.adapter,
				metaId: this.adapter.namespace,
				baseDir:
					typeof status?.baseDir === 'string' && status.baseDir.trim()
						? status.baseDir.trim()
						: 'data/archive',
				fileExtension:
					typeof status?.fileExtension === 'string' && status.fileExtension.trim()
						? status.fileExtension.trim()
						: 'jsonl',
				instanceDataDir:
					typeof status?.nativeRootDir === 'string' && status.nativeRootDir.trim()
						? status.nativeRootDir.trim()
						: '',
			});
		} catch (e) {
			// Normalize unexpected probe exceptions to a structured probe-failed reason.
			probe = { ok: false, reason: `native-probe-failed:${String(e?.message || e)}` };
		}
		if (!probe || probe.ok !== true) {
			const reason =
				typeof probe?.reason === 'string' && probe.reason.trim() ? probe.reason.trim() : 'native-probe-failed';
			return this._err('NATIVE_PROBE_FAILED', reason);
		}

		const lockedAt = Date.now();
		// Return only lock-intent fields; runtime strategy becomes effective after restart.
		return {
			ok: true,
			data: {
				archive: this._archiveStatusSnapshot(),
				nextLock: 'native',
				reason: 'manual-upgrade',
				lockedAt,
				restartRequired: true,
			},
			native: {
				archiveEffectiveStrategyLock: 'native',
				archiveLockReason: 'manual-upgrade',
				archiveLockedAt: lockedAt,
			},
		};
	}

	/**
	 * Handle `config.archive.forceIobroker`.
	 *
	 * Returns an explicit lock-intent patch for iobroker writer strategy.
	 *
	 * @returns {{
	 *  ok: true,
	 *  data: object,
	 *  native: { archiveEffectiveStrategyLock: string, archiveLockReason: string, archiveLockedAt: number }
	 * }} Force-lock response.
	 */
	_archiveForceIobroker() {
		const lockedAt = Date.now();
		return {
			ok: true,
			data: {
				archive: this._archiveStatusSnapshot(),
				nextLock: 'iobroker',
				reason: 'manual-downgrade',
				lockedAt,
				restartRequired: true,
			},
			native: {
				archiveEffectiveStrategyLock: 'iobroker',
				archiveLockReason: 'manual-downgrade',
				archiveLockedAt: lockedAt,
			},
		};
	}

	/**
	 * Handle `config.ai.test`.
	 *
	 * This command is diagnostics-only. It stores a compact human-readable result
	 * in `native.aiTestLastResult` for immediate jsonConfig feedback.
	 *
	 * @param {object|undefined} payload Optional payload with test overrides.
	 * @returns {Promise<{native: {aiTestLastResult: string}}>} AI test summary patch.
	 */
	async _aiTest(payload) {
		const baseAi = this.ai;
		if (!baseAi || typeof baseAi.createCallerApi !== 'function') {
			return { native: { aiTestLastResult: 'ERROR NOT_READY: AI runtime not wired' } };
		}

		const safe = payload && typeof payload === 'object' ? payload : {};
		const purpose = typeof safe.purpose === 'string' && safe.purpose.trim() ? safe.purpose.trim() : 'ai-test';
		const quality = typeof safe.quality === 'string' && safe.quality.trim() ? safe.quality.trim() : 'balanced';
		const prompt =
			typeof safe.prompt === 'string' && safe.prompt.trim()
				? safe.prompt.trim()
				: 'Respond with a short sentence: pong';

		let ai = baseAi;
		const provider = typeof safe.provider === 'string' && safe.provider.trim() ? safe.provider.trim() : '';
		const openai = safe.openai && typeof safe.openai === 'object' ? safe.openai : null;
		const apiKey = typeof openai?.apiKey === 'string' ? openai.apiKey.trim() : '';
		const wantsOverrides = !!(
			provider ||
			apiKey ||
			openai?.baseUrl ||
			(openai?.modelsByQuality && typeof openai.modelsByQuality === 'object') ||
			Array.isArray(openai?.purposeModelOverrides)
		);

		if (wantsOverrides) {
			try {
				// Build an isolated runtime for one-off checks so global adapter config stays untouched.
				const { MsgAi } = require(`${__dirname}/../src/MsgAi`);
				ai = new MsgAi(this.adapter, {
					enabled: true,
					provider: provider || 'openai',
					openai: {
						apiKey,
						baseUrl: openai?.baseUrl,
						modelsByQuality: openai?.modelsByQuality,
						purposeModelOverrides: openai?.purposeModelOverrides,
					},
					timeoutMs: 15000,
					maxConcurrency: 1,
				});
			} catch (e) {
				return {
					native: {
						aiTestLastResult: `ERROR INTERNAL: Failed to build test AI runtime: ${String(e?.message || e)}`,
					},
				};
			}
		}

		// The connectivity probe itself is intentionally minimal and deterministic.
		const api = ai.createCallerApi({ regId: 'Config:jsonConfig' });
		const res = await api.text({
			purpose,
			messages: [
				{ role: 'system', content: 'You are a connectivity test. Reply concisely.' },
				{ role: 'user', content: prompt },
			],
			hints: { quality },
			timeoutMs: 15000,
		});

		const out =
			res?.ok === true
				? String(res.value || '')
				: `ERROR ${String(res?.error?.code || 'ERROR')}: ${String(res?.error?.message || 'Error')}`;

		const meta = res?.meta && typeof res.meta === 'object' ? res.meta : {};
		const summary = [
			`ok=${res?.ok === true ? 'true' : 'false'}`,
			meta.provider ? `provider=${meta.provider}` : null,
			meta.model ? `model=${meta.model}` : null,
			meta.quality ? `quality=${meta.quality}` : null,
			typeof meta.durationMs === 'number' ? `durationMs=${meta.durationMs}` : null,
			meta.cached ? `cached=${meta.cached}` : null,
		]
			.filter(Boolean)
			.join(' ');

		// Keep output stable and compact so admins can compare repeated test runs quickly.
		return { native: { aiTestLastResult: `${summary}\n\n${out}`.trim() } };
	}

	/**
	 * Route and execute one `config.*` command.
	 *
	 * Only explicitly listed commands are accepted.
	 *
	 * @param {string} cmd Command id.
	 * @param {object|undefined} payload Optional payload.
	 * @returns {Promise<any>} Command response.
	 */
	async handleCommand(cmd, payload) {
		const c = typeof cmd === 'string' ? cmd.trim() : '';
		if (!c) {
			return this._err('BAD_REQUEST', 'Missing command');
		}

		// Archive strategy transparency / control commands.
		if (c === 'config.archive.status') {
			return this._applyNativeAllowlist(this._archiveStatus());
		}
		if (c === 'config.archive.retryNative') {
			return this._applyNativeAllowlist(await this._archiveRetryNative());
		}
		if (c === 'config.archive.forceIobroker') {
			return this._applyNativeAllowlist(this._archiveForceIobroker());
		}
		// AI connectivity diagnostics command.
		if (c === 'config.ai.test') {
			return this._applyNativeAllowlist(await this._aiTest(payload));
		}

		return this._err('UNKNOWN_COMMAND', `Unknown config command '${c}'`);
	}
}

module.exports = { IoAdminConfig };
