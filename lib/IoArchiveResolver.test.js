'use strict';

const { expect } = require('chai');
const { IoArchiveResolver } = require('./IoArchiveResolver');
const { createAdapterLogger, withTempDir } = require('./_test.utils');

function createBackendFactories({ nativeProbeResult }) {
	let nativeProbeCalls = 0;

	const baseMethods = runtimeRootValue => ({
		async init() {},
		async appendEntries() {},
		async readDir() {
			return [];
		},
		async deleteFile() {},
		async estimateSizeBytes() {
			return { bytes: 0, isComplete: true };
		},
		runtimeRoot() {
			return runtimeRootValue;
		},
	});

	const createNative = () => ({
		...baseMethods('native://archive-root'),
		async probe() {
			nativeProbeCalls += 1;
			if (nativeProbeResult instanceof Error) {
				throw nativeProbeResult;
			}
			if (typeof nativeProbeResult === 'function') {
				return await nativeProbeResult();
			}
			return nativeProbeResult;
		},
	});

	const createIobroker = () => ({
		...baseMethods('iobroker://archive-root'),
		probe() {
			return { ok: false, reason: 'not-native-backend' };
		},
	});

	return {
		createNative,
		createIobroker,
		getNativeProbeCalls() {
			return nativeProbeCalls;
		},
	};
}

describe('IoArchiveResolver', () => {
	it('resolves native on auto-native-first when probe succeeds', async () => {
		const { adapter } = createAdapterLogger();
		const factories = createBackendFactories({ nativeProbeResult: { ok: true, reason: 'ok' } });

		const resolved = await IoArchiveResolver.resolveFor({
			adapter,
			baseDir: 'data/archive',
			fileExtension: 'jsonl',
			instanceDataDir: '/tmp/msghub-resolver-auto-native',
			createNative: factories.createNative,
			createIobroker: factories.createIobroker,
		});

		expect(resolved.archiveRuntime.effectiveStrategy).to.equal('native');
		expect(resolved.archiveRuntime.effectiveStrategyReason).to.equal('auto-native-first');
		expect(resolved.archiveRuntime.nativeProbeError).to.equal('');
		expect(factories.getNativeProbeCalls()).to.equal(1);

		const backend = resolved.createStorageBackend();
		expect(backend.runtimeRoot()).to.equal('native://archive-root');
	});

	it('keeps iobroker strategy when lock is iobroker (downgrade) and skips native probe', async () => {
		const { adapter } = createAdapterLogger();
		const factories = createBackendFactories({ nativeProbeResult: { ok: true, reason: 'ok' } });

		const resolved = await IoArchiveResolver.resolveFor({
			adapter,
			configuredStrategyLock: 'iobroker',
			lockReason: 'manual-downgrade',
			baseDir: 'data/archive',
			fileExtension: 'jsonl',
			instanceDataDir: '/tmp/msghub-resolver-locked-iobroker',
			createNative: factories.createNative,
			createIobroker: factories.createIobroker,
		});

		expect(resolved.archiveRuntime.configuredStrategyLock).to.equal('iobroker');
		expect(resolved.archiveRuntime.effectiveStrategy).to.equal('iobroker');
		expect(resolved.archiveRuntime.effectiveStrategyReason).to.equal('manual-downgrade');
		expect(factories.getNativeProbeCalls()).to.equal(0);

		const backend = resolved.createStorageBackend();
		expect(backend.runtimeRoot()).to.equal('iobroker://archive-root');
	});

	it('applies manual-upgrade lock after reboot and resolves native', async () => {
		const { adapter } = createAdapterLogger();
		const factories = createBackendFactories({ nativeProbeResult: { ok: true, reason: 'ok' } });

		const downgraded = await IoArchiveResolver.resolveFor({
			adapter,
			configuredStrategyLock: 'iobroker',
			lockReason: 'manual-downgrade',
			instanceDataDir: '/tmp/msghub-resolver-reboot',
			createNative: factories.createNative,
			createIobroker: factories.createIobroker,
		});
		expect(downgraded.archiveRuntime.effectiveStrategy).to.equal('iobroker');
		expect(factories.getNativeProbeCalls()).to.equal(0);

		const afterRebootStillDowngraded = await IoArchiveResolver.resolveFor({
			adapter,
			configuredStrategyLock: 'iobroker',
			lockReason: 'manual-downgrade',
			instanceDataDir: '/tmp/msghub-resolver-reboot',
			createNative: factories.createNative,
			createIobroker: factories.createIobroker,
		});
		expect(afterRebootStillDowngraded.archiveRuntime.effectiveStrategy).to.equal('iobroker');
		expect(factories.getNativeProbeCalls()).to.equal(0);

		const afterManualUpgrade = await IoArchiveResolver.resolveFor({
			adapter,
			configuredStrategyLock: 'native',
			lockReason: 'manual-upgrade',
			instanceDataDir: '/tmp/msghub-resolver-reboot',
			createNative: factories.createNative,
			createIobroker: factories.createIobroker,
		});
		expect(afterManualUpgrade.archiveRuntime.effectiveStrategy).to.equal('native');
		expect(afterManualUpgrade.archiveRuntime.effectiveStrategyReason).to.equal('manual-upgrade');
		expect(factories.getNativeProbeCalls()).to.equal(1);
	});

	it('falls back to iobroker and propagates probe failure reason when native probe fails', async () => {
		const { adapter } = createAdapterLogger();
		const factories = createBackendFactories({
			nativeProbeResult: { ok: false, reason: 'native-probe-failed:EACCES' },
		});

		const resolved = await IoArchiveResolver.resolveFor({
			adapter,
			configuredStrategyLock: 'native',
			instanceDataDir: '/tmp/msghub-resolver-fallback',
			createNative: factories.createNative,
			createIobroker: factories.createIobroker,
		});

		expect(resolved.archiveRuntime.effectiveStrategy).to.equal('iobroker');
		expect(resolved.archiveRuntime.effectiveStrategyReason).to.equal('native-probe-failed:EACCES');
		expect(resolved.archiveRuntime.nativeProbeError).to.equal('native-probe-failed:EACCES');
		expect(factories.getNativeProbeCalls()).to.equal(1);
	});

	it('falls back when native fs is technically unavailable (missing or non-absolute instance data dir)', async () => {
		const { adapter } = createAdapterLogger();

		const missingDir = await IoArchiveResolver.resolveFor({
			adapter,
			configuredStrategyLock: 'native',
			instanceDataDir: '',
			baseDir: 'data/archive',
			fileExtension: 'jsonl',
		});
		expect(missingDir.archiveRuntime.effectiveStrategy).to.equal('iobroker');
		expect(missingDir.archiveRuntime.effectiveStrategyReason).to.equal('missing-instance-data-dir');
		expect(missingDir.archiveRuntime.nativeProbeError).to.equal('missing-instance-data-dir');

		const relativeDir = await IoArchiveResolver.resolveFor({
			adapter,
			configuredStrategyLock: 'native',
			instanceDataDir: 'relative/path/not-absolute',
			baseDir: 'data/archive',
			fileExtension: 'jsonl',
		});
		expect(relativeDir.archiveRuntime.effectiveStrategy).to.equal('iobroker');
		expect(relativeDir.archiveRuntime.effectiveStrategyReason).to.equal('missing-instance-data-dir');
		expect(relativeDir.archiveRuntime.nativeProbeError).to.equal('missing-instance-data-dir');
	});

	it('handles invalid/throwing native probe fallback cases', async () => {
		const { adapter } = createAdapterLogger();

		const invalidResultFactories = createBackendFactories({ nativeProbeResult: null });
		const invalidResult = await IoArchiveResolver.resolveFor({
			adapter,
			configuredStrategyLock: 'native',
			instanceDataDir: '/tmp/msghub-resolver-invalid-probe',
			createNative: invalidResultFactories.createNative,
			createIobroker: invalidResultFactories.createIobroker,
		});
		expect(invalidResult.archiveRuntime.effectiveStrategy).to.equal('iobroker');
		expect(invalidResult.archiveRuntime.effectiveStrategyReason).to.equal('native-probe-invalid-result');

		const throwFactories = createBackendFactories({ nativeProbeResult: new Error('permission denied') });
		const thrown = await IoArchiveResolver.resolveFor({
			adapter,
			configuredStrategyLock: 'native',
			instanceDataDir: '/tmp/msghub-resolver-throwing-probe',
			createNative: throwFactories.createNative,
			createIobroker: throwFactories.createIobroker,
		});
		expect(thrown.archiveRuntime.effectiveStrategy).to.equal('iobroker');
		expect(thrown.archiveRuntime.effectiveStrategyReason).to.equal('native-probe-failed:permission denied');
	});

	it('probes native capability via static probeNativeFor helper', async () => {
		const { adapter } = createAdapterLogger();

		await withTempDir('msghub-resolver-probe-static-', async instanceDataDir => {
			const ok = await IoArchiveResolver.probeNativeFor({
				adapter,
				instanceDataDir,
				baseDir: 'data/archive',
				fileExtension: 'jsonl',
			});
			expect(ok.ok).to.equal(true);
		});

		const fail = await IoArchiveResolver.probeNativeFor({
			adapter,
			instanceDataDir: '',
			baseDir: 'data/archive',
			fileExtension: 'jsonl',
		});
		expect(fail.ok).to.equal(false);
		expect(fail.reason).to.equal('missing-instance-data-dir');
	});
});
