'use strict';

const { expect } = require('chai');

const { IngestRandomChaos } = require('./index');
const { MsgConstants } = require('../../src/MsgConstants');

function makeLog() {
	const calls = { info: [] };
	return { calls, log: { info: msg => calls.info.push(msg) } };
}

function makeResources() {
	const calls = { setTimeout: [], clearTimeout: [] };
	let timerSeq = 0;
	const timers = new Map();
	return {
		calls,
		resources: {
			setTimeout(fn, delay) {
				const id = ++timerSeq;
				const t = { id };
				timers.set(id, { fn, delay });
				calls.setTimeout.push([fn, delay, t]);
				return t;
			},
			clearTimeout(t) {
				calls.clearTimeout.push(t);
				timers.delete(t?.id);
			},
		},
		getLast() {
			const last = calls.setTimeout.at(-1);
			return last ? { fn: last[0], delay: last[1], timer: last[2] } : null;
		},
	};
}

function makeStore() {
	const calls = { addMessage: [], updateMessage: [], removeMessage: [] };
	const byRef = new Map();
	return {
		calls,
		addMessage(msg) {
			calls.addMessage.push(msg);
			byRef.set(msg.ref, msg);
			return true;
		},
		updateMessage(ref, patch) {
			calls.updateMessage.push([ref, patch]);
			const cur = byRef.get(ref);
			if (!cur) {
				return false;
			}
			byRef.set(ref, { ...cur, ...patch });
			return true;
		},
		getMessageByRef(ref) {
			return byRef.get(ref);
		},
		removeMessage(ref) {
			calls.removeMessage.push(ref);
			byRef.delete(ref);
		},
	};
}

function makeFactory() {
	const calls = { createMessage: [] };
	return {
		calls,
		createMessage(msg) {
			calls.createMessage.push(msg);
			return { ...msg };
		},
	};
}

function makeOptionsResolver(values) {
	return {
		resolveInt(key, fallback) {
			if (values && Object.prototype.hasOwnProperty.call(values, key)) {
				return values[key];
			}
			return fallback;
		},
	};
}

function makeCtx({ log, store, factory, resources, options, baseOwnId = 'IngestRandomChaos.0' } = {}) {
	return {
		api: { log, constants: MsgConstants, store, factory },
		meta: {
			options,
			resources,
			plugin: { baseOwnId },
		},
	};
}

describe('IngestRandomChaos', () => {
	let originalRandom;
	beforeEach(() => {
		originalRandom = Math.random;
		Math.random = () => 0.5;
	});
	afterEach(() => {
		Math.random = originalRandom;
	});

	it('schedules ticks and performs create+update without throwing', () => {
		const { log } = makeLog();
		const { resources, calls: resourceCalls, getLast } = makeResources();
		const store = makeStore();
		const factory = makeFactory();
		const options = makeOptionsResolver({ intervalMinMs: 10, intervalMaxMs: 20, maxPool: 1 });

		const h = IngestRandomChaos({ intervalMinMs: 10, intervalMaxMs: 20, maxPool: 1 });
		h.start(makeCtx({ log, store, factory, resources, options }));

		const first = getLast();
		expect(first).to.be.an('object');
		expect(first.delay).to.be.within(10, 20);

			first.fn();
			expect(store.calls.addMessage.length).to.equal(1);
			const createdRef = store.calls.addMessage[0].ref;
			expect(String(createdRef).startsWith('IngestRandomChaos.0.')).to.equal(true);

		const second = getLast();
		expect(resourceCalls.setTimeout.length).to.be.greaterThanOrEqual(2);
		second.fn();
		expect(store.calls.updateMessage.length).to.be.greaterThanOrEqual(1);

		h.stop();
		expect(resourceCalls.clearTimeout.length).to.be.greaterThanOrEqual(1);
		expect(store.calls.removeMessage).to.include(createdRef);
	});

	it('validates required ctx members', () => {
		const h = IngestRandomChaos();
		let err = null;
		try {
			h.start({});
		} catch (e) {
			err = e;
		}
		expect(err).to.be.an('error');
		expect(err.message).to.include('IngestRandomChaos.start');
	});
});
