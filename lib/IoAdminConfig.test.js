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

describe('IoAdminConfig id catalog command', () => {
	function createAdapterWithObjects(objectsByPattern = {}) {
		const calls = [];
		return {
			adapter: {
				namespace: 'msghub.0',
				log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
				async getForeignObjectsAsync(pattern, type) {
					calls.push([pattern, type]);
					return objectsByPattern[pattern] || {};
				},
			},
			calls,
		};
	}

	it('uses filter fallback * and returns only picker-relevant fields', async () => {
		const { adapter, calls } = createAdapterWithObjects({
			'*': {
				'a.0.x': {
					_id: 'a.0.x',
					type: 'state',
					common: {
						name: 'X',
						type: 'number',
						role: 'value',
						unit: 'W',
						read: true,
						write: false,
						custom: { ignored: true },
					},
					native: { secret: true },
					acl: { object: 1 },
					from: 'system.adapter.a.0',
					ts: 123,
				},
				'a.0.channel': {
					_id: 'a.0.channel',
					type: 'channel',
					common: { name: 'Ignore me' },
					native: { ignored: true },
				},
			},
		});
		const capabilities = new IoAdminCapabilities(adapter);
		const config = new IoAdminConfig(adapter, { adminCapabilities: capabilities });

		const res = await config.handleCommand('config.idcatalog.get', {
			token: capabilities.mintToken({ host: 'admin', capability: 'config' }).token,
		});

		expect(calls).to.deep.equal([['*', 'state']]);
		expect(res.ok).to.equal(true);
		expect(res.data.meta.backendDurationMs).to.be.a('number');
		expect(res.data.meta.backendDurationMs).to.be.at.least(0);
		expect(res.data.objects).to.deep.equal({
			'a.0.x': {
				_id: 'a.0.x',
				common: { name: 'X', type: 'number', role: 'value', unit: 'W' },
			},
		});
	});

	it('passes explicit filter through to getForeignObjectsAsync', async () => {
		const { adapter, calls } = createAdapterWithObjects({
			'zigbee.0.*': {
				'zigbee.0.temperature': {
					_id: 'zigbee.0.temperature',
					type: 'state',
					common: { name: 'Temperature', type: 'number' },
				},
			},
		});
		const capabilities = new IoAdminCapabilities(adapter);
		const config = new IoAdminConfig(adapter, { adminCapabilities: capabilities });

		const res = await config.handleCommand('config.idcatalog.get', {
			token: capabilities.mintToken({ host: 'admin', capability: 'config' }).token,
			filter: 'zigbee.0.*',
		});

		expect(calls).to.deep.equal([['zigbee.0.*', 'state']]);
		expect(res.ok).to.equal(true);
		expect(res.data.meta.backendDurationMs).to.be.a('number');
		expect(res.data.objects).to.have.property('zigbee.0.temperature');
	});

	it('openTree on root with depth=1 returns top-level grouped nodes', async () => {
		const { adapter, calls } = createAdapterWithObjects({
			'*': {
				'javascript.0.a.b': {
					_id: 'javascript.0.a.b',
					type: 'state',
					common: { name: 'AB', type: 'boolean', role: 'switch' },
				},
				'system.adapter.web.1.memRss': {
					_id: 'system.adapter.web.1.memRss',
					type: 'state',
					common: { name: 'RSS', type: 'number', unit: 'MB' },
				},
			},
		});
		const capabilities = new IoAdminCapabilities(adapter);
		const config = new IoAdminConfig(adapter, { adminCapabilities: capabilities });

		const res = await config.handleCommand('config.idcatalog.openTree', {
			token: capabilities.mintToken({ host: 'admin', capability: 'config' }).token,
			depth: 1,
		});

		expect(calls).to.deep.equal([['*', 'state']]);
		expect(res.ok).to.equal(true);
		expect(res.data.entry).to.equal('');
		expect(res.data.depth).to.equal(1);
		expect(res.data.meta.backendDurationMs).to.be.a('number');
		expect(res.data.meta.sourcePattern).to.equal('*');
		expect(res.data.nodes).to.deep.equal([
			{
				entry: 'javascript.0',
				parent: '',
				level: 1,
				label: 'javascript.0',
				expandable: true,
			},
			{
				entry: 'system.adapter.web.1',
				parent: '',
				level: 1,
				label: 'system.adapter.web.1',
				expandable: true,
			},
		]);
	});

	it('openTree with explicit entry and depth=3 returns subtree nodes and exact states', async () => {
		const { adapter, calls } = createAdapterWithObjects({
			'javascript.0.*': {
				'javascript.0.foo.bar': {
					_id: 'javascript.0.foo.bar',
					type: 'state',
					common: { name: 'Bar', type: 'number', role: 'value', unit: 'W' },
				},
				'javascript.0.foo.baz.qux': {
					_id: 'javascript.0.foo.baz.qux',
					type: 'state',
					common: { name: 'Qux', type: 'string' },
				},
			},
		});
		const capabilities = new IoAdminCapabilities(adapter);
		const config = new IoAdminConfig(adapter, { adminCapabilities: capabilities });

		const res = await config.handleCommand('config.idcatalog.openTree', {
			token: capabilities.mintToken({ host: 'admin', capability: 'config' }).token,
			entry: 'javascript.0',
			depth: 3,
		});

		expect(calls).to.deep.equal([['javascript.0.*', 'state']]);
		expect(res.ok).to.equal(true);
		expect(res.data.entry).to.equal('javascript.0');
		expect(res.data.depth).to.equal(3);
		expect(res.data.meta.sourcePattern).to.equal('javascript.0.*');
		expect(res.data.nodes).to.deep.equal([
			{
				entry: 'javascript.0.foo',
				parent: 'javascript.0',
				level: 1,
				label: 'foo',
				expandable: true,
			},
			{
				entry: 'javascript.0.foo.bar',
				parent: 'javascript.0.foo',
				level: 2,
				label: 'bar',
				expandable: false,
				_id: 'javascript.0.foo.bar',
				common: { name: 'Bar', type: 'number', role: 'value', unit: 'W' },
			},
			{
				entry: 'javascript.0.foo.baz',
				parent: 'javascript.0.foo',
				level: 2,
				label: 'baz',
				expandable: true,
			},
			{
				entry: 'javascript.0.foo.baz.qux',
				parent: 'javascript.0.foo.baz',
				level: 3,
				label: 'qux',
				expandable: false,
				_id: 'javascript.0.foo.baz.qux',
				common: { name: 'Qux', type: 'string' },
			},
		]);
	});
});
