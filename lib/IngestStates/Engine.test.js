'use strict';

const { expect } = require('chai');
const { format } = require('node:util');
const { IngestStatesEngine } = require('./Engine');

describe('IngestStates Engine (RuleHost)', () => {
	function createCtx() {
		const calls = {
			subscribeStates: [],
			unsubscribeStates: [],
			subscribeObjects: [],
			unsubscribeObjects: [],
			getObjectView: [],
			managedReport: [],
			managedApply: 0,
			warn: [],
		};

		let viewRows = [];

		const ctx = {
			api: {
				log: {
					debug: () => undefined,
					info: () => undefined,
					warn: msg => calls.warn.push(String(msg)),
				},
				i18n: {
					t: (key, ...args) => format(String(key), ...args),
				},
				iobroker: {
					ids: { namespace: 'msghub.0' },
					objects: {
						getObjectView: async () => {
							calls.getObjectView.push(true);
							return { rows: viewRows };
						},
						setObjectNotExists: async () => undefined,
						getForeignObject: async () => ({ common: { name: 'n', unit: 'u' } }),
					},
					states: {
						getForeignState: async () => null,
						setForeignState: async () => undefined,
					},
					subscribe: {
						subscribeForeignStates: id => calls.subscribeStates.push(id),
						unsubscribeForeignStates: id => calls.unsubscribeStates.push(id),
						subscribeForeignObjects: id => calls.subscribeObjects.push(id),
						unsubscribeForeignObjects: id => calls.unsubscribeObjects.push(id),
					},
				},
				store: {
					getMessageByRef: () => null,
					addMessage: () => true,
					addOrUpdateMessage: () => true,
					updateMessage: () => true,
					completeAfterCauseEliminated: () => true,
					removeMessage: () => true,
				},
				factory: { createMessage: msg => msg },
				constants: {
					actions: { type: { close: 'close' } },
					kind: { status: 'status' },
					level: { notice: 10 },
					origin: { type: { automation: 'automation' } },
					lifecycle: {
						state: { open: 'open', acked: 'acked', snoozed: 'snoozed', closed: 'closed', expired: 'expired', deleted: 'deleted' },
					},
				},
			},
			meta: {
				plugin: { baseFullId: 'msghub.0.IngestStates.0', baseOwnId: 'IngestStates.0', instanceId: 0, regId: 'IngestStates:0' },
				options: {
					resolveInt: (_k, v) => (typeof v === 'number' ? v : 0),
					resolveBool: (_k, v) => Boolean(v),
				},
				managedObjects: {
					report: (id, info) => calls.managedReport.push({ id, info }),
					applyReported: () => {
						calls.managedApply += 1;
					},
				},
				resources: {
					setInterval: () => 1,
					setTimeout: () => 1,
					clearTimeout: () => undefined,
					clearInterval: () => undefined,
				},
			},
		};

		return {
			ctx,
			calls,
			setViewRows: rows => {
				viewRows = rows;
			},
		};
	}

	it('subscribes/unsubscribes state dependencies when config changes (diff)', async () => {
		const { ctx, calls, setViewRows } = createCtx();

		setViewRows([
			{
				id: 'dev.0.target',
				value: {
					'msghub.0': {
						enabled: true,
						mode: 'triggered',
						'trg-id': 'dev.0.trg1',
						'trg-operator': 'truthy',
						'trg-windowValue': 5,
						'trg-windowUnit': 1,
						'trg-expectation': 'changed',
					},
				},
			},
		]);

		const engine = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
		engine.start();
		await engine._queue.current;

		expect(new Set(calls.subscribeStates)).to.deep.equal(new Set(['dev.0.target', 'dev.0.trg1']));

		setViewRows([
			{
				id: 'dev.0.target',
				value: {
					'msghub.0': {
						enabled: true,
						mode: 'triggered',
						'trg-id': 'dev.0.trg2',
						'trg-operator': 'truthy',
						'trg-windowValue': 5,
						'trg-windowUnit': 1,
						'trg-expectation': 'changed',
					},
				},
			},
		]);

		await engine._queue(() => engine._rescan('test'));

		expect(calls.unsubscribeStates).to.include('dev.0.trg1');
		expect(calls.subscribeStates).to.include('dev.0.trg2');
		engine.stop();
	});

	it('still watches object ids on invalid rule config, but skips rule subscriptions', async () => {
		const { ctx, calls, setViewRows } = createCtx();

		setViewRows([
			{
				id: 'dev.0.target',
				value: {
					'msghub.0': {
						enabled: true,
						mode: 'triggered',
						'trg-windowValue': 5,
						'trg-windowUnit': 1,
						'trg-expectation': 'changed',
					},
				},
			},
		]);

		const engine = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
		engine.start();
		await engine._queue.current;

		expect(calls.subscribeObjects).to.deep.equal(['dev.0.target']);
		expect(calls.subscribeStates).to.deep.equal([]);
		engine.stop();
	});

	it('skips rules when managedMeta-managedBy belongs to another plugin', async () => {
		const { ctx, calls, setViewRows } = createCtx();

		setViewRows([
			{
				id: 'dev.0.target',
				value: {
					'msghub.0': {
						enabled: true,
						mode: 'threshold',
						'thr-mode': 'gt',
						'thr-value': 5,
						'managedMeta-managedBy': 'msghub.0.IngestHue.0',
					},
				},
			},
		]);

		const engine = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
		engine.start();
		await engine._queue.current;

		expect(calls.subscribeObjects).to.deep.equal(['dev.0.target']);
		expect(calls.subscribeStates).to.deep.equal([]);
		expect(calls.managedReport).to.deep.equal([]);
		expect(calls.warn.join('\n')).to.include('skipping');
		expect(calls.warn.join('\n')).to.include('managed by');
		engine.stop();
	});

});
