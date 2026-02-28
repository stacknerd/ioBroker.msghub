/**
 * IoArchiveResolver
 * =================
 * Platform-layer resolver for archive writer strategy.
 *
 * Responsibilities:
 * - Evaluate configured strategy lock + native probe result.
 * - Return a single backend factory for the chosen runtime strategy.
 * - Provide runtime diagnostics metadata for UI/status surfaces.
 */

'use strict';

const path = require('node:path');
const { IoArchiveNative } = require(`${__dirname}/IoArchiveNative`);
const { IoArchiveIobroker } = require(`${__dirname}/IoArchiveIobroker`);

/**
 * Resolve archive backend strategy in the ioBroker/platform layer.
 */
class IoArchiveResolver {
	/**
	 * Resolve archive strategy in one call.
	 *
	 * @param {object} options Resolver options (same as constructor options).
	 * @returns {Promise<{createStorageBackend:(onMutated?: () => void)=>any, archiveRuntime:{configuredStrategyLock:string,effectiveStrategy:'native'|'iobroker',effectiveStrategyReason:string,nativeRootDir:string,nativeProbeError:string,writeDisabled:boolean}}>} Resolved backend factory and runtime strategy metadata.
	 */
	static async resolveFor(options) {
		return await new IoArchiveResolver(options).resolve();
	}

	/**
	 * Probe native archive capability in one call.
	 *
	 * @param {object} options Resolver options (same as constructor options).
	 * @returns {Promise<{ok:boolean, reason:string}>} Probe result.
	 */
	static async probeNativeFor(options) {
		return await new IoArchiveResolver(options)._probeNative();
	}

	/**
	 * @param {object} options Resolver options.
	 * @param {import('@iobroker/adapter-core').AdapterInstance} options.adapter Adapter instance.
	 * @param {object} [options.archiveConfig] Normalized archive config snapshot from MsgConfig.
	 * @param {string} [options.metaId] ioBroker file-api meta id.
	 * @param {string} [options.baseDir] Archive base directory.
	 * @param {string} [options.fileExtension] Archive file extension.
	 * @param {'native'|'iobroker'|''} [options.configuredStrategyLock] Persisted strategy lock.
	 * @param {string} [options.lockReason] Optional lock reason.
	 * @param {string} [options.instanceDataDir] Absolute adapter data dir for native strategy.
	 * @param {string} [options.nativeRelativeDir] Relative folder below `instanceDataDir`.
	 * @param {(ctx: object) => any} [options.createNative] Optional native backend factory override (tests).
	 * @param {(ctx: object) => any} [options.createIobroker] Optional ioBroker backend factory override (tests).
	 */
	constructor(options) {
		const opt = options && typeof options === 'object' && !Array.isArray(options) ? options : null;
		if (!opt) {
			throw new Error('IoArchiveResolver: options are required');
		}
		if (!opt.adapter || typeof opt.adapter !== 'object') {
			throw new Error('IoArchiveResolver: options.adapter is required');
		}
		this.adapter = opt.adapter;
		const archiveConfig =
			opt.archiveConfig && typeof opt.archiveConfig === 'object' && !Array.isArray(opt.archiveConfig)
				? opt.archiveConfig
				: {};
		this.metaId = typeof opt.metaId === 'string' && opt.metaId.trim() ? opt.metaId.trim() : this.adapter.namespace;
		this.baseDir = typeof opt.baseDir === 'string' ? opt.baseDir.replace(/^\/+|\/+$/g, '') : '';
		this.fileExtension =
			typeof opt.fileExtension === 'string' && opt.fileExtension.trim()
				? opt.fileExtension.trim().replace(/^\./, '')
				: 'jsonl';

		const configuredRaw =
			typeof opt.configuredStrategyLock === 'string'
				? opt.configuredStrategyLock
				: typeof archiveConfig.effectiveStrategyLock === 'string'
					? archiveConfig.effectiveStrategyLock
					: '';
		const lockRaw = configuredRaw.trim();
		this.configuredStrategyLock = lockRaw === 'native' || lockRaw === 'iobroker' ? lockRaw : '';
		this.lockReason =
			typeof opt.lockReason === 'string'
				? opt.lockReason.trim()
				: typeof archiveConfig.lockReason === 'string'
					? archiveConfig.lockReason.trim()
					: '';

		const instanceDataDir = typeof opt.instanceDataDir === 'string' ? opt.instanceDataDir.trim() : '';
		this.instanceDataDir = instanceDataDir && path.isAbsolute(instanceDataDir) ? instanceDataDir : '';
		this.nativeRelativeDir =
			typeof opt.nativeRelativeDir === 'string' ? opt.nativeRelativeDir.replace(/^\/+|\/+$/g, '') : '';
		this.nativeRootDir = this.instanceDataDir ? path.join(this.instanceDataDir, this.nativeRelativeDir) : '';

		this._createNative =
			typeof opt.createNative === 'function' ? opt.createNative : ctx => new IoArchiveNative(ctx);
		this._createIobroker =
			typeof opt.createIobroker === 'function' ? opt.createIobroker : ctx => new IoArchiveIobroker(ctx);
	}

	/**
	 * Resolve final runtime strategy and return backend factory + status payload.
	 *
	 * Returns a single backend factory for the resolved runtime strategy plus diagnostics metadata.
	 *
	 * @returns {Promise<{createStorageBackend:(onMutated?: () => void)=>any, archiveRuntime:{configuredStrategyLock:string,effectiveStrategy:'native'|'iobroker',effectiveStrategyReason:string,nativeRootDir:string,nativeProbeError:string,writeDisabled:boolean}}>} Resolved backend factory and runtime strategy metadata.
	 */
	async resolve() {
		let effectiveStrategy = 'iobroker';
		let effectiveStrategyReason = 'platform-default';
		let nativeProbeError = '';
		let writeDisabled = false;

		if (this.configuredStrategyLock === 'iobroker') {
			effectiveStrategy = 'iobroker';
			effectiveStrategyReason = this.lockReason || 'manual-downgrade';
		} else if (this.configuredStrategyLock === 'native') {
			const nativeProbe = await this._probeNative();
			if (nativeProbe.ok) {
				effectiveStrategy = 'native';
				effectiveStrategyReason = this.lockReason || 'manual-upgrade';
			} else {
				effectiveStrategy = 'native';
				effectiveStrategyReason = `native-lock-probe-failed:${nativeProbe.reason || 'native-probe-failed'}`;
				nativeProbeError = nativeProbe.reason || 'native-probe-failed';
				writeDisabled = true;
			}
		} else {
			const nativeProbe = await this._probeNative();
			if (nativeProbe.ok) {
				effectiveStrategy = 'native';
				effectiveStrategyReason =
					this.lockReason ||
					(this.configuredStrategyLock === 'native' ? 'manual-upgrade' : 'auto-native-first');
			} else {
				effectiveStrategy = 'iobroker';
				effectiveStrategyReason = nativeProbe.reason || 'native-probe-failed';
				nativeProbeError = nativeProbe.reason || '';
			}
		}

		let createStorageBackend;
		if (effectiveStrategy === 'native' && writeDisabled !== true) {
			createStorageBackend = onMutated => this._createNativeBackend(onMutated);
		} else if (effectiveStrategy === 'native') {
			createStorageBackend = onMutated => this._createDisabledNativeBackend(nativeProbeError, onMutated);
		} else {
			createStorageBackend = onMutated => this._createIobrokerBackend(onMutated);
		}

		return {
			createStorageBackend,
			archiveRuntime: {
				configuredStrategyLock: this.configuredStrategyLock || '',
				effectiveStrategy: effectiveStrategy === 'native' ? 'native' : 'iobroker',
				effectiveStrategyReason,
				nativeRootDir: this.nativeRootDir || '',
				nativeProbeError,
				writeDisabled: writeDisabled === true,
			},
		};
	}

	/**
	 * Probe native backend availability.
	 *
	 * @returns {Promise<{ok:boolean, reason:string}>} Probe result.
	 */
	async _probeNative() {
		const backend = this._createNativeBackend(() => undefined);
		this._assertBackendContract(backend, 'native');
		if (typeof backend.probe !== 'function') {
			return { ok: false, reason: 'native-probe-unsupported' };
		}
		try {
			const result = await backend.probe();
			if (!result || typeof result !== 'object') {
				return { ok: false, reason: 'native-probe-invalid-result' };
			}
			return { ok: result.ok === true, reason: typeof result.reason === 'string' ? result.reason : '' };
		} catch (e) {
			return { ok: false, reason: `native-probe-failed:${String(e?.message || e)}` };
		}
	}

	/**
	 * Create native backend instance.
	 *
	 * @param {() => void} [onMutated] Mutation callback.
	 * @returns {any} Backend instance.
	 */
	_createNativeBackend(onMutated) {
		return this._createNative(this._backendContext(onMutated));
	}

	/**
	 * Create ioBroker backend instance.
	 *
	 * @param {() => void} [onMutated] Mutation callback.
	 * @returns {any} Backend instance.
	 */
	_createIobrokerBackend(onMutated) {
		return this._createIobroker(this._backendContext(onMutated));
	}

	/**
	 * Create disabled-native backend for strict native-lock mode when probe fails.
	 *
	 * This backend intentionally refuses all append operations to avoid silent fallback writes
	 * into a different storage world.
	 *
	 * @param {string} reason Disable reason.
	 * @param {() => void} [onMutated] Mutation callback.
	 * @returns {any} Backend instance.
	 */
	_createDisabledNativeBackend(reason, onMutated) {
		const ctx = this._backendContext(onMutated);
		const disableReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'native-probe-failed';
		const runtimeRoot = ctx.nativeRootDir ? path.join(ctx.nativeRootDir, ctx.baseDir || '') : '';
		return {
			async init() {},
			async probe() {
				return { ok: false, reason: disableReason };
			},
			async appendEntries() {
				throw new Error(
					`native archive writer disabled due to failed native probe (${disableReason}); manual action required`,
				);
			},
			async readDir() {
				return [];
			},
			async deleteFile() {},
			async estimateSizeBytes() {
				return { bytes: null, isComplete: false };
			},
			runtimeRoot() {
				return runtimeRoot;
			},
		};
	}

	/**
	 * Build backend context payload.
	 *
	 * @param {() => void} [onMutated] Mutation callback.
	 * @returns {object} Backend context.
	 */
	_backendContext(onMutated) {
		return {
			adapter: this.adapter,
			metaId: this.metaId,
			baseDir: this.baseDir,
			fileExtension: this.fileExtension,
			nativeRootDir: this.nativeRootDir,
			onMutated: typeof onMutated === 'function' ? onMutated : () => undefined,
		};
	}

	/**
	 * Assert minimal backend contract shape.
	 *
	 * @param {any} backend Backend instance.
	 * @param {string} label Backend label for diagnostics.
	 * @returns {void}
	 */
	_assertBackendContract(backend, label) {
		const required = ['init', 'appendEntries', 'readDir', 'deleteFile', 'estimateSizeBytes', 'runtimeRoot'];
		for (const method of required) {
			if (typeof backend?.[method] !== 'function') {
				throw new Error(`IoArchiveResolver: ${label} backend missing method '${method}'`);
			}
		}
	}
}

module.exports = { IoArchiveResolver };
