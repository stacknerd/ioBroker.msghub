'use strict';

const { expect } = require('chai');

const { IoAdminConfig } = require('./IoAdminConfig');

describe('IoAdminConfig archive strategy commands', () => {
	function createAdminConfigWithArchive({ probeResult } = {}) {
		let probeCalls = 0;
		const adapter = {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
		const archive = {
			getStatus() {
				return {
					configuredStrategyLock: 'native',
					effectiveStrategy: 'native',
					effectiveStrategyReason: 'auto-initial',
					baseDir: 'data/archive',
					fileExtension: 'jsonl',
					nativeRootDir: '/tmp/msghub.0',
					runtimeRoot: '/tmp/msghub.0/data/archive',
					nativeProbeError: '',
				};
			},
		};
		const msgStore = { msgArchive: archive };
		const archiveProbeNative = async () => {
			probeCalls += 1;
			return probeResult || { ok: true, reason: 'ok' };
		};
		return {
			config: new IoAdminConfig(adapter, { msgStore, archiveProbeNative }),
			getProbeCalls: () => probeCalls,
		};
	}

	it('returns native patch for retryNative on successful probe', async () => {
		const { config, getProbeCalls } = createAdminConfigWithArchive({ probeResult: { ok: true, reason: 'ok' } });
		const res = await config.handleCommand('config.archive.retryNative', {});
		expect(getProbeCalls()).to.equal(1);
		expect(res.ok).to.equal(true);
		expect(res.native).to.be.an('object');
		expect(res.native.archiveEffectiveStrategyLock).to.equal('native');
		expect(res.native.archiveLockReason).to.equal('manual-upgrade');
		expect(res.native.archiveLockedAt).to.be.a('number');
	});

	it('returns error without native patch when retryNative probe fails', async () => {
		const { config, getProbeCalls } = createAdminConfigWithArchive({
			probeResult: { ok: false, reason: 'missing-instance-data-dir' },
		});
		const res = await config.handleCommand('config.archive.retryNative', {});
		expect(getProbeCalls()).to.equal(1);
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NATIVE_PROBE_FAILED');
		expect(res).to.not.have.property('native');
	});

	it('returns native patch for forceIobroker', async () => {
		const { config } = createAdminConfigWithArchive({ probeResult: { ok: true, reason: 'ok' } });
		const res = await config.handleCommand('config.archive.forceIobroker', {});
		expect(res.ok).to.equal(true);
		expect(res.native).to.be.an('object');
		expect(res.native.archiveEffectiveStrategyLock).to.equal('iobroker');
		expect(res.native.archiveLockReason).to.equal('manual-downgrade');
		expect(res.native.archiveLockedAt).to.be.a('number');
	});

	it('returns runtime transparency snapshot for archive.status', async () => {
		const { config } = createAdminConfigWithArchive({ probeResult: { ok: true, reason: 'ok' } });
		const res = await config.handleCommand('config.archive.status', {});
		expect(res.ok).to.equal(true);
		expect(res.data.archive.effectiveStrategy).to.equal('native');
		expect(res.data.archive.effectiveStrategyReason).to.equal('auto-initial');
		expect(res.native.archiveRuntimeStrategy).to.equal('native');
		expect(res.native.archiveRuntimeReason).to.equal('auto-initial');
		expect(res.native.archiveRuntimeRoot).to.equal('/tmp/msghub.0/data/archive');
	});
});

describe('IoAdminConfig native allowlist', () => {
	it('drops unknown native keys from config command responses', async () => {
		const adapter = {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
		const config = new IoAdminConfig(adapter, {});
		config._archiveStatus = () => ({
			ok: true,
			data: {},
			native: {
				archiveRuntimeStrategy: 'native',
				unexpectedKey: 'x',
			},
		});

		const res = await config.handleCommand('config.archive.status', {});
		expect(res.native).to.deep.equal({ archiveRuntimeStrategy: 'native' });
	});
});
