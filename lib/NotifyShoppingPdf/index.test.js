'use strict';

const { expect } = require('chai');

const { NotifyShoppingPdf } = require('./index');
const { MsgConstants } = require('../../src/MsgConstants');

const flush = () => new Promise(resolve => setImmediate(resolve));

function makeI18n() {
	const format = (template, args) => {
		if (typeof template !== 'string') {
			return '';
		}
		let i = 0;
		return template.replace(/%s/g, () => String(args?.[i++] ?? ''));
	};
	return { t: (s, ...args) => format(String(s), args) };
}

function makeOptionsResolver(values) {
	const get = (key, fallback) => (Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback);
	return {
		resolveBool: (key, fallback) => Boolean(get(key, fallback)),
		resolveInt: (key, fallback) => Number(get(key, fallback)),
		resolveString: (key, fallback) => String(get(key, fallback) ?? ''),
	};
}

function makeResources() {
	const calls = { setTimeout: [], clearTimeout: [], spawnSync: [] };
	let timerSeq = 0;
	return {
		calls,
		resources: {
			setTimeout(fn, delay) {
				const t = { id: ++timerSeq };
				calls.setTimeout.push([fn, delay, t]);
				return t;
			},
			clearTimeout(t) {
				calls.clearTimeout.push(t);
			},
			spawnSync(cmd, args, opts) {
				calls.spawnSync.push([cmd, args, opts]);
				return { status: 0, stdout: '', stderr: '' };
			},
		},
	};
}

function makeIoBroker() {
	const calls = { setObjectNotExists: [], setState: [] };
	return {
		calls,
		iobroker: {
			ids: { namespace: 'msghub.0' },
			objects: {
				setObjectNotExists(id, obj) {
					calls.setObjectNotExists.push([id, obj]);
					return Promise.resolve();
				},
				getForeignObject() {
					return Promise.resolve(null);
				},
			},
			states: {
				setState(id, st) {
					calls.setState.push([id, st]);
					return Promise.resolve();
				},
			},
			files: {
				mkdir() {
					return Promise.resolve();
				},
				writeFile() {
					return Promise.resolve();
				},
			},
		},
	};
}

function makeLog() {
	const calls = { info: [], warn: [], debug: [] };
	return {
		calls,
		log: {
			info: msg => calls.info.push(msg),
			warn: msg => calls.warn.push(msg),
			debug: msg => calls.debug.push(msg),
		},
	};
}

function makeStore() {
	return {
		queryMessages() {
			return { items: [] };
		},
	};
}

function makeCtx({ optionsValues } = {}) {
	const { calls: resCalls, resources } = makeResources();
	const { calls: brokerCalls, iobroker } = makeIoBroker();
	const { log, calls: logCalls } = makeLog();
	const i18n = makeI18n();
	const store = makeStore();
	const options = makeOptionsResolver(optionsValues || {});

	return {
		ctx: {
			api: { log, i18n, iobroker, store, constants: MsgConstants },
			meta: {
				plugin: { baseOwnId: 'NotifyShoppingPdf.0', type: 'NotifyShoppingPdf', instanceId: 0 },
				options,
				resources,
			},
		},
		resCalls,
		brokerCalls,
		logCalls,
	};
}

describe('NotifyShoppingPdf', () => {
	it('checks pdflatex (injectable), ensures own states and schedules a render', async () => {
		const { ctx, resCalls, brokerCalls } = makeCtx({
			optionsValues: {
				renderDebounceMs: 123,
				pdfTitle: 'Shopping',
				design: 'screen',
				notesLines: 0,
				includeChecked: false,
				includeEmptyCategories: false,
				printRoomLabelsFromItems: 0,
				uncategorizedLabel: 'x',
				refsWhitelistCsv: '',
				refsBlacklistCsv: '',
			},
		});

		const h = NotifyShoppingPdf();
		h.start(ctx);

		expect(resCalls.spawnSync).to.have.length(1);
		expect(resCalls.setTimeout).to.have.length(1);
		expect(resCalls.setTimeout[0][1]).to.equal(123);

		await flush();
		expect(brokerCalls.setObjectNotExists.map(([id]) => id)).to.include('NotifyShoppingPdf.0.pdfPath');
		expect(brokerCalls.setObjectNotExists.map(([id]) => id)).to.include('NotifyShoppingPdf.0.pdfUrl');
	});

	it('schedules renders only for shoppinglist notifications and supported events', () => {
		const { ctx, resCalls } = makeCtx({
			optionsValues: {
				renderDebounceMs: 0,
				pdfTitle: 'Shopping',
				design: 'screen',
				notesLines: 0,
				includeChecked: false,
				includeEmptyCategories: false,
				printRoomLabelsFromItems: 0,
				uncategorizedLabel: 'x',
				refsWhitelistCsv: '',
				refsBlacklistCsv: '',
			},
		});

		const h = NotifyShoppingPdf();
		h.start(ctx);
		expect(resCalls.setTimeout).to.have.length(1);

		h.onNotifications('due', [{ kind: MsgConstants.kind.shoppinglist, ref: 'list:1' }], ctx);
		expect(resCalls.setTimeout).to.have.length(1);

		h.onNotifications(MsgConstants.notfication.events.update, [{ kind: 'task', ref: 'x' }], ctx);
		expect(resCalls.setTimeout).to.have.length(1);

		h.onNotifications(MsgConstants.notfication.events.update, [{ kind: MsgConstants.kind.shoppinglist, ref: 'list:1' }], ctx);
		expect(resCalls.clearTimeout).to.have.length(1);
		expect(resCalls.setTimeout).to.have.length(2);
	});

	it('applies whitelist/blacklist for shoppinglist refs', () => {
		const { ctx, resCalls } = makeCtx({
			optionsValues: {
				renderDebounceMs: 0,
				pdfTitle: 'Shopping',
				design: 'screen',
				notesLines: 0,
				includeChecked: false,
				includeEmptyCategories: false,
				printRoomLabelsFromItems: 0,
				uncategorizedLabel: 'x',
				refsWhitelistCsv: 'list:1',
				refsBlacklistCsv: 'list:2',
			},
		});

		const h = NotifyShoppingPdf();
		h.start(ctx);
		expect(resCalls.setTimeout).to.have.length(1);

		h.onNotifications(MsgConstants.notfication.events.added, [{ kind: MsgConstants.kind.shoppinglist, ref: 'list:3' }], ctx);
		expect(resCalls.setTimeout).to.have.length(1);

		h.onNotifications(MsgConstants.notfication.events.added, [{ kind: MsgConstants.kind.shoppinglist, ref: 'list:2' }], ctx);
		expect(resCalls.setTimeout).to.have.length(1);

		h.onNotifications(MsgConstants.notfication.events.added, [{ kind: MsgConstants.kind.shoppinglist, ref: 'list:1' }], ctx);
		expect(resCalls.setTimeout).to.have.length(2);
	});

	it('clears pending render timer on stop', () => {
		const { ctx, resCalls, logCalls } = makeCtx({
			optionsValues: {
				renderDebounceMs: 1000,
				pdfTitle: 'Shopping',
				design: 'screen',
				notesLines: 0,
				includeChecked: false,
				includeEmptyCategories: false,
				printRoomLabelsFromItems: 0,
				uncategorizedLabel: 'x',
				refsWhitelistCsv: '',
				refsBlacklistCsv: '',
			},
		});

		const h = NotifyShoppingPdf();
		h.start(ctx);
		expect(resCalls.setTimeout).to.have.length(1);

		h.stop(ctx);
		expect(resCalls.clearTimeout).to.have.length(1);
		expect(logCalls.info.join('\n')).to.include('NotifyShoppingPdf: stopped');
	});
});

