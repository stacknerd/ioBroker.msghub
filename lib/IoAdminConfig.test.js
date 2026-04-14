'use strict';

const { expect } = require('chai');

const { IoAdminCapabilities } = require('./IoAdminCapabilities');
const { IoAdminConfig } = require('./IoAdminConfig');

describe('IoAdminConfig archive strategy commands', () => {
	function createAdapter() {
		return {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
	}

	function createCapabilities() {
		return new IoAdminCapabilities(createAdapter());
	}

	function createAdminConfigWithArchive({ probeResult } = {}) {
		let probeCalls = 0;
		const adapter = createAdapter();
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
		const adminCapabilities = createCapabilities();
		return {
			config: new IoAdminConfig(adapter, { msgStore, archiveProbeNative, adminCapabilities }),
			token: adminCapabilities.mintToken({ host: 'admin', capability: 'config' }).token,
			getProbeCalls: () => probeCalls,
		};
	}

	it('returns native patch for retryNative on successful probe', async () => {
		const { config, token, getProbeCalls } = createAdminConfigWithArchive({ probeResult: { ok: true, reason: 'ok' } });
		const res = await config.handleCommand('config.archive.retryNative', { token });
		expect(getProbeCalls()).to.equal(1);
		expect(res.ok).to.equal(true);
		expect(res.native).to.be.an('object');
		expect(res.native.archiveEffectiveStrategyLock).to.equal('native');
		expect(res.native.archiveLockReason).to.equal('manual-upgrade');
		expect(res.native.archiveLockedAt).to.be.a('number');
	});

	it('returns error without native patch when retryNative probe fails', async () => {
		const { config, token, getProbeCalls } = createAdminConfigWithArchive({
			probeResult: { ok: false, reason: 'missing-instance-data-dir' },
		});
		const res = await config.handleCommand('config.archive.retryNative', { token });
		expect(getProbeCalls()).to.equal(1);
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('NATIVE_PROBE_FAILED');
		expect(res).to.not.have.property('native');
	});

	it('returns native patch for forceIobroker', async () => {
		const { config, token } = createAdminConfigWithArchive({ probeResult: { ok: true, reason: 'ok' } });
		const res = await config.handleCommand('config.archive.forceIobroker', { token });
		expect(res.ok).to.equal(true);
		expect(res.native).to.be.an('object');
		expect(res.native.archiveEffectiveStrategyLock).to.equal('iobroker');
		expect(res.native.archiveLockReason).to.equal('manual-downgrade');
		expect(res.native.archiveLockedAt).to.be.a('number');
	});

	it('returns runtime transparency snapshot for archive.status', async () => {
		const { config, token } = createAdminConfigWithArchive({ probeResult: { ok: true, reason: 'ok' } });
		const res = await config.handleCommand('config.archive.status', { token });
		expect(res.ok).to.equal(true);
		expect(res.data.archive.effectiveStrategy).to.equal('native');
		expect(res.data.archive.effectiveStrategyReason).to.equal('auto-initial');
		expect(res.native.archiveRuntimeStrategy).to.equal('native');
		expect(res.native.archiveRuntimeReason).to.equal('auto-initial');
		expect(res.native.archiveRuntimeRoot).to.equal('/tmp/msghub.0/data/archive');
	});

	it('rejects missing payload.token for config commands', async () => {
		const { config } = createAdminConfigWithArchive({ probeResult: { ok: true, reason: 'ok' } });
		const res = await config.handleCommand('config.archive.status', {});
		expect(res.ok).to.equal(false);
		expect(res.error.code).to.equal('FORBIDDEN');
		expect(res.error.message).to.match(/Missing token/);
	});

	it('strips payload.token before config command execution', async () => {
		const adapter = createAdapter();
		const capabilities = createCapabilities();
		const config = new IoAdminConfig(adapter, {
			adminCapabilities: capabilities,
		});
		let seenPayload = null;
		config._aiTest = async payload => {
			seenPayload = payload;
			return { native: { aiTestLastResult: 'ok=true' } };
		};
		const res = await config.handleCommand('config.ai.test', {
			token: capabilities.mintToken({ host: 'admin', capability: 'config' }).token,
			prompt: 'pong',
		});
		expect(res.native.aiTestLastResult).to.equal('ok=true');
		expect(seenPayload).to.deep.equal({ prompt: 'pong' });
	});

	it('validates config tokens against the passed host hint, not against payload.host', async () => {
		const adapter = createAdapter();
		let seenHost = '';
		const config = new IoAdminConfig(adapter, {
			adminCapabilities: {
				consumePayloadToken({ host }) {
					seenHost = host;
					return {};
				},
			},
		});

		await config.handleCommand('config.archive.status', { token: 'x', host: 'ignored-client' }, { host: 'webExtension' });
		expect(seenHost).to.equal('webExtension');
	});
});

describe('IoAdminConfig native allowlist', () => {
	it('drops unknown native keys from config command responses', async () => {
		const adapter = {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
		const capabilities = new IoAdminCapabilities(adapter);
		const config = new IoAdminConfig(adapter, { adminCapabilities: capabilities });
		config._archiveStatus = () => ({
			ok: true,
			data: {},
			native: {
				archiveRuntimeStrategy: 'native',
				unexpectedKey: 'x',
			},
		});

		const res = await config.handleCommand('config.archive.status', {
			token: capabilities.mintToken({ host: 'admin', capability: 'config' }).token,
		});
		expect(res.native).to.deep.equal({ archiveRuntimeStrategy: 'native' });
	});
});
