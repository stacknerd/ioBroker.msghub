'use strict';

const { expect } = require('chai');
const { IngestRandomDemo } = require('./');
const { MsgConstants } = require('../../src/MsgConstants');

function makeAdapter() {
	const logs = { warn: [], info: [], debug: [] };
	const adapter = {
		name: 'msghub',
		instance: 0,
		namespace: 'msghub.0',
		log: {
			warn: msg => logs.warn.push(msg),
			info: msg => logs.info.push(msg),
			debug: msg => logs.debug.push(msg),
		},
	};
	return { adapter, logs };
}

function makeCtx() {
	const messages = new Map();
	const calls = { addMessage: [], updateMessage: [], getMessageByRef: [], createMessage: [] };

	const store = {
		getMessageByRef: ref => {
			calls.getMessageByRef.push([ref]);
			return messages.get(ref) ?? null;
		},
		addMessage: msg => {
			calls.addMessage.push([msg]);
			if (msg?.ref) {
				messages.set(msg.ref, msg);
			}
		},
		updateMessage: (ref, patch) => {
			calls.updateMessage.push([ref, patch]);
			const current = messages.get(ref) || { ref };
			messages.set(ref, { ...current, ...patch });
		},
	};

	const factory = {
		createMessage: data => {
			calls.createMessage.push([data]);
			return { ...data };
		},
	};

	const ctx = { api: { constants: MsgConstants, store, factory }, meta: { source: 'unit' } };
	return { ctx, calls, messages };
}

function withPatchedGlobals(patches, fn) {
	const originals = {};
	for (const [key, value] of Object.entries(patches)) {
		originals[key] = global[key];
		global[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of Object.entries(originals)) {
			global[key] = value;
		}
	}
}

describe('IngestRandomDemo', () => {
	it('requires adapter', () => {
		expect(() => IngestRandomDemo()).to.throw('IngestRandomDemo: adapter is required');
	});

	it('requires ctx.api.store/factory/constants on start', () => {
		const { adapter } = makeAdapter();
		const plugin = IngestRandomDemo(adapter, { pluginBaseObjectId: 'msghub.0.IngestRandomDemo.0' });
		expect(() => plugin.start()).to.throw('IngestRandomDemo.start: ctx.api.store/factory/constants are required');
		expect(() => plugin.start({ api: {} })).to.throw('IngestRandomDemo.start: ctx.api.store/factory/constants are required');
	});

	it('creates a first message immediately and schedules interval', () => {
		const { adapter } = makeAdapter();
		const { ctx, calls } = makeCtx();
		const plugin = IngestRandomDemo(adapter, {
			pluginBaseObjectId: 'msghub.0.IngestRandomDemo.0',
			intervalMs: 1234,
			ttlMs: 60000,
			ttlJitter: 0,
			refPoolSize: 1,
		});

		let intervalCb = null;
		const intervalHandle = { id: 't1' };

		withPatchedGlobals(
			{
				setInterval: (cb, ms) => {
					intervalCb = cb;
					expect(ms).to.equal(1234);
					return intervalHandle;
				},
				clearInterval: () => {},
			},
			() => {
				const originalNow = Date.now;
				const originalRandom = Math.random;
				Date.now = () => 1000;
				Math.random = () => 0;
				try {
					plugin.start(ctx);
				} finally {
					Date.now = originalNow;
					Math.random = originalRandom;
				}
			},
		);

		expect(intervalCb).to.be.a('function');
		expect(calls.createMessage).to.have.length(1);
		expect(calls.addMessage).to.have.length(1);

		const createdInput = calls.createMessage[0][0];
		expect(createdInput.ref).to.equal('msghub.0.IngestRandomDemo.0.ingestRandomDemo.01');
		expect(createdInput.origin).to.deep.equal({
			type: MsgConstants.origin.type.automation,
			system: 'IngestRandomDemo',
		});
		expect(createdInput.timing.expiresAt).to.equal(61000);
	});

	it('updates an existing ref on subsequent ticks', () => {
		const { adapter } = makeAdapter();
		const { ctx, calls, messages } = makeCtx();
		const plugin = IngestRandomDemo(adapter, {
			pluginBaseObjectId: 'msghub.0.IngestRandomDemo.0',
			intervalMs: 10,
			ttlMs: 5000,
			ttlJitter: 0,
			refPoolSize: 1,
		});

		let intervalCb = null;
		let cleared = null;
		const intervalHandle = { id: 't2' };

		withPatchedGlobals(
			{
				setInterval: cb => {
					intervalCb = cb;
					return intervalHandle;
				},
				clearInterval: handle => {
					cleared = handle;
				},
			},
			() => {
				const originalNow = Date.now;
				const originalRandom = Math.random;
				Date.now = () => 2000;
				Math.random = () => 0;
				try {
					plugin.start(ctx);
				} finally {
					Date.now = originalNow;
					Math.random = originalRandom;
				}
			},
		);

		expect(messages.has('msghub.0.IngestRandomDemo.0.ingestRandomDemo.01')).to.equal(true);
		expect(calls.updateMessage).to.have.length(0);

		const originalNow = Date.now;
		const originalRandom = Math.random;
		Date.now = () => 3000;
		Math.random = () => 0;
		try {
			intervalCb();
		} finally {
			Date.now = originalNow;
			Math.random = originalRandom;
		}

		expect(calls.updateMessage).to.have.length(1);
		expect(calls.updateMessage[0][0]).to.equal('msghub.0.IngestRandomDemo.0.ingestRandomDemo.01');
		expect(calls.updateMessage[0][1].timing.expiresAt).to.equal(8000);

		withPatchedGlobals(
			{
				clearInterval: handle => {
					cleared = handle;
				},
			},
			() => plugin.stop(),
		);
		expect(cleared).to.equal(intervalHandle);
	});

	it('logs and continues when tick throws', () => {
		const { adapter, logs } = makeAdapter();
		const plugin = IngestRandomDemo(adapter, { pluginBaseObjectId: 'msghub.0.IngestRandomDemo.0', intervalMs: 10 });

		let intervalCb = null;
		withPatchedGlobals(
			{
				setInterval: cb => {
					intervalCb = cb;
					return { id: 't3' };
				},
				clearInterval: () => {},
			},
			() => {
				const ctx = {
					api: {
						constants: MsgConstants,
						factory: { createMessage: () => ({ ref: 'x' }) },
						store: {
							getMessageByRef: () => {
								throw new Error('boom');
							},
							addMessage: () => {},
							updateMessage: () => {},
						},
					},
				};

				expect(() => plugin.start(ctx)).to.not.throw();
				expect(typeof intervalCb).to.equal('function');
				expect(() => intervalCb()).to.not.throw();
			},
		);

		expect(logs.warn.length).to.be.greaterThan(0);
		expect(logs.warn[0]).to.include('IngestRandomDemo: tick failed');
	});

	it('does not schedule twice and stop is idempotent', () => {
		const { adapter } = makeAdapter();
		const { ctx } = makeCtx();
		const plugin = IngestRandomDemo(adapter, {
			pluginBaseObjectId: 'msghub.0.IngestRandomDemo.0',
			intervalMs: 10,
			refPoolSize: 1,
		});

		let intervalCount = 0;
		withPatchedGlobals(
			{
				setInterval: () => {
					intervalCount += 1;
					return { id: `t${intervalCount}` };
				},
				clearInterval: () => {},
			},
			() => {
				plugin.start(ctx);
				plugin.start(ctx);
				plugin.stop();
				plugin.stop();
			},
		);

		expect(intervalCount).to.equal(1);
	});
});
