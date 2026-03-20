'use strict';

const { expect } = require('chai');
const { format } = require('node:util');
const fs = require('fs');
const path = require('path');
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

	it('does not subscribe state dependencies for unsupported modes', async () => {
		const { ctx, calls, setViewRows } = createCtx();

		setViewRows([
			{
				id: 'dev.0.target',
				value: {
					'msghub.0': {
						enabled: true,
						mode: 'unknown',
					},
				},
			},
		]);

		const engine = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
		engine.start();
		await engine._queue.current;

		expect(calls.subscribeObjects).to.deep.equal(['dev.0.target']);
		expect(calls.subscribeStates).to.deep.equal([]);

		setViewRows([
			{
				id: 'dev.0.target',
				value: {
					'msghub.0': {
						enabled: true,
						mode: 'unknown',
					},
				},
			},
		]);

		await engine._queue(() => engine._rescan('test'));

		expect(calls.subscribeStates).to.deep.equal([]);
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

	it('reports active preset usage counts from the runtime model', async () => {
		const { ctx, setViewRows } = createCtx();

		setViewRows([
			{
				id: 'dev.0.t1',
				value: {
					'msghub.0': {
						enabled: true,
						mode: 'threshold',
						'thr-mode': 'gt',
						'thr-value': 5,
						'fresh-enable': true,
						'fresh-everyValue': 10,
						'fresh-everyUnit': 60,
						'fresh-evaluateBy': 'ts',
						'msg-ThresholdId': 'pUsed',
						'msg-DefaultId': 'pUsed',
						'msg-FreshnessId': 'pOther',
					},
				},
			},
			{
				id: 'dev.0.t2',
				value: {
					'msghub.0': {
						enabled: true,
						mode: 'threshold',
						'thr-mode': 'lt',
						'thr-value': 1,
						'msg-ThresholdId': 'pOther',
					},
				},
			},
		]);

		const engine = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
		engine.start();
		await engine._queue.current;

		expect(engine.getPresetUsageSnapshot()).to.deep.equal([
			{ presetId: 'pOther', usageCount: 2 },
			{ presetId: 'pUsed', usageCount: 2 },
		]);

		engine.stop();
		expect(engine.getPresetUsageSnapshot()).to.deep.equal([]);
	});

	it('ignores preset refs from skipped or invalid runtime configs', async () => {
		const { ctx, setViewRows } = createCtx();

		setViewRows([
			{
				id: 'dev.0.foreignManaged',
				value: {
					'msghub.0': {
						enabled: true,
						mode: 'threshold',
						'thr-mode': 'gt',
						'thr-value': 5,
						'managedMeta-managedBy': 'msghub.0.IngestHue.0',
						'msg-ThresholdId': 'pSkipped',
					},
				},
			},
			{
				id: 'dev.0.valid',
				value: {
					'msghub.0': {
						enabled: true,
						mode: 'threshold',
						'thr-mode': 'gt',
						'thr-value': 7,
						'msg-ThresholdId': '',
						'msg-DefaultId': 'pActive',
					},
				},
			},
			{
				id: 'dev.0.invalidMode',
				value: {
					'msghub.0': {
						enabled: true,
						mode: 'unknown',
						'msg-DefaultId': 'pUnknown',
					},
				},
			},
		]);

		const engine = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
		engine.start();
		await engine._queue.current;

		expect(engine.getPresetUsageSnapshot()).to.deep.equal([{ presetId: 'pActive', usageCount: 1 }]);

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

		it('adds FreshnessRule in addition to selected mode when enabled', async () => {
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
							'fresh-enable': true,
							'fresh-everyValue': 10,
							'fresh-everyUnit': 60,
							'fresh-evaluateBy': 'ts',
						},
					},
				},
			]);

			const engine = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
			engine.start();
			await engine._queue.current;

			expect(calls.subscribeObjects).to.deep.equal(['dev.0.target']);
			expect(calls.subscribeStates).to.deep.equal(['dev.0.target']);

			const rulesByTarget = engine._rulesByTargetId.get('dev.0.target');
			expect(rulesByTarget).to.be.instanceOf(Set);
			expect(Array.from(rulesByTarget).map(r => r?.constructor?.name).sort()).to.deep.equal([
				'FreshnessRule',
				'ThresholdRule',
			]);

			const rulesByState = engine._rulesByStateId.get('dev.0.target');
			expect(rulesByState).to.be.instanceOf(Set);
			expect(rulesByState.size).to.equal(2);

			engine.stop();
		});

		it('creates only a FreshnessRule and no warning when mode is empty but freshness is enabled', async () => {
			const { ctx, calls, setViewRows } = createCtx();

			setViewRows([
				{
					id: 'dev.0.target',
					value: {
						'msghub.0': {
							enabled: true,
							'fresh-enable': true,
							'fresh-everyValue': 10,
							'fresh-everyUnit': 60,
							'fresh-evaluateBy': 'ts',
						},
					},
				},
			]);

			const engine = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
			engine.start();
			await engine._queue.current;

			expect(calls.warn).to.deep.equal([]);

			const rulesByTarget = engine._rulesByTargetId.get('dev.0.target');
			expect(rulesByTarget).to.be.instanceOf(Set);
			expect(Array.from(rulesByTarget).map(r => r?.constructor?.name)).to.deep.equal(['FreshnessRule']);

			engine.stop();
		});

	it('reuses the same rule instance when config is unchanged on rescan', async () => {
		const { ctx, setViewRows } = createCtx();

		const cfg = {
			enabled: true,
			mode: 'session',
			'sess-startThreshold': 50,
			'sess-startMinHoldValue': 0,
			'sess-startMinHoldUnit': 1,
			'sess-stopThreshold': 15,
			'sess-stopDelayValue': 5,
			'sess-stopDelayUnit': 60,
		};
		setViewRows([{ id: 'dev.0.target', value: { 'msghub.0': cfg } }]);

		const engine = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
		engine.start();
		await engine._queue.current;

		const rulesAfterFirst = engine._rulesByTargetId.get('dev.0.target');
		expect(rulesAfterFirst).to.be.instanceOf(Set);

		// Second rescan with identical config — existing rule Set must be reused.
		await engine._queue(() => engine._rescan('test'));

		expect(engine._rulesByTargetId.get('dev.0.target')).to.equal(rulesAfterFirst);

		engine.stop();
	});

	it('disposes the old rule and creates a new one when config changes on rescan', async () => {
		const { ctx, setViewRows } = createCtx();

		const baseCfg = {
			enabled: true,
			mode: 'session',
			'sess-startThreshold': 50,
			'sess-startMinHoldValue': 0,
			'sess-startMinHoldUnit': 1,
			'sess-stopThreshold': 15,
			'sess-stopDelayValue': 5,
			'sess-stopDelayUnit': 60,
		};
		setViewRows([{ id: 'dev.0.target', value: { 'msghub.0': baseCfg } }]);

		const engine = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
		engine.start();
		await engine._queue.current;

		const firstRule = Array.from(engine._rulesByTargetId.get('dev.0.target'))[0];
		let disposed = false;
		const originalDispose = firstRule.dispose?.bind(firstRule);
		firstRule.dispose = () => {
			disposed = true;
			if (originalDispose) {
				originalDispose();
			}
		};

		// Change a config value — fingerprint differs → new rule created, old one disposed.
		setViewRows([{ id: 'dev.0.target', value: { 'msghub.0': { ...baseCfg, 'sess-startThreshold': 75 } } }]);
		await engine._queue(() => engine._rescan('test'));

		expect(disposed).to.equal(true);
		const secondRule = Array.from(engine._rulesByTargetId.get('dev.0.target'))[0];
		expect(secondRule).to.not.equal(firstRule);

		engine.stop();
	});

	it('silently skips foreign configs with no IngestStates mode', async () => {
		const { ctx, calls, setViewRows } = createCtx();

		setViewRows([{ id: 'alexa2.0.Lists.Test', value: { 'msghub.0': { enabled: true } } }]);

		const engine = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
		engine.start();
		await engine._queue.current;

		expect(calls.warn).to.deep.equal([]);
		expect(engine._rulesByTargetId.size).to.equal(0);
		engine.stop();
	});

	it('warns with mode name for non-empty unrecognized modes', async () => {
		const { ctx, calls, setViewRows } = createCtx();

		setViewRows([{ id: 'dev.0.target', value: { 'msghub.0': { enabled: true, mode: 'invalid-mode' } } }]);

		const engine = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
		engine.start();
		await engine._queue.current;

		expect(calls.warn.some(w => w.includes('invalid-mode'))).to.equal(true);
		expect(engine._rulesByTargetId.size).to.equal(0);
		engine.stop();
	});

	});

describe('IngestStates jsonCustom coverage', () => {
	function readJson(relPath) {
		return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8'));
	}

	function readText(relPath) {
		return fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
	}

	function extractUiKeys(jsonCustom) {
		const keys = [];

		for (const tab of Object.values(jsonCustom?.items || {})) {
			const items = tab?.items || {};
			for (const key of Object.keys(items)) {
				if (key.startsWith('_')) {
					continue;
				}
				keys.push(key);
			}
		}

		return keys.sort();
	}

		function consumerForKey(key) {
			if (key === 'mode') {
				return { file: 'lib/IngestStates/Engine.js', prop: 'mode' };
			}

			if (key === 'fresh-enable') {
				return {
					file: 'lib/IngestStates/Engine.js',
					match: /\bcfg\?\.\s*fresh\?\.\s*enable\s*===\s*true\b/u,
				};
			}

			// Message preset references are intentionally "field-neutral" in the engine:
			// jsonCustom uses flat keys like `msg-DefaultId`, but the engine consumes them via
			// normalization (`cfg.msg.DefaultId`) and collects all `*Id` keys dynamically.
			if (key.startsWith('msg-') && key.endsWith('Id')) {
			return {
				file: 'lib/IngestStates/Engine.js',
				match: /\b_extractPreset(?:Ids|Refs)\s*\(/u,
			};
		}

		const idx = key.indexOf('-');
		if (idx <= 0) {
			return null;
		}

		const prefix = key.slice(0, idx);
		const prop = key.slice(idx + 1);
		if (prefix === 'thr') {
			return { file: 'lib/IngestStates/rules/Threshold.js', prop };
		}
		if (prefix === 'fresh') {
			return { file: 'lib/IngestStates/rules/Freshness.js', prop };
		}
		if (prefix === 'cyc') {
			return { file: 'lib/IngestStates/rules/Cycle.js', prop };
		}
		if (prefix === 'trg') {
			return { file: 'lib/IngestStates/rules/Triggered.js', prop };
		}
		if (prefix === 'nonset') {
			return { file: 'lib/IngestStates/rules/NonSettling.js', prop };
		}
		if (prefix === 'sess') {
			return { file: 'lib/IngestStates/rules/Session.js', prop };
		}
		if (prefix === 'msg') {
			return { file: 'lib/IngestStates/MessageWriter.js', prop };
		}
		if (prefix === 'managedMeta') {
			// managed-meta fields are stored as flat keys and are used as string keys in IoManagedMeta
			return { file: 'lib/IoManagedMeta.js', prop: key };
		}

		return null;
	}

	function hasPropUsage(source, prop) {
		// Prefer a somewhat specific match to avoid false positives in random text:
		// - `.prop`, `?.prop`, `['prop']`, `"prop"` (for dynamic key access)
		const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = new RegExp(
			`(?:\\?\\.|\\.)${escaped}\\b|\\[['"]${escaped}['"]\\]|['"]${escaped}['"]`,
			'u',
		);
		return re.test(source);
	}

	function hasMatchUsage(source, match) {
		if (match instanceof RegExp) {
			return match.test(source);
		}
		if (typeof match === 'string' && match) {
			return source.includes(match);
		}
		return false;
	}

	it('wires all non-underscore jsonCustom keys in code', () => {
		const jsonCustom = readJson('admin/jsonCustom.json');
		const keys = extractUiKeys(jsonCustom);
		expect(keys).to.have.length.greaterThan(0);

		const failures = [];

		for (const key of keys) {
			const consumer = consumerForKey(key);
			if (!consumer) {
				failures.push({ key, reason: 'no consumer mapping' });
				continue;
			}

			const source = readText(consumer.file);
			if (consumer.match) {
				if (!hasMatchUsage(source, consumer.match)) {
					failures.push({ key, reason: `pattern '${consumer.match}' not found in ${consumer.file}` });
				}
			} else if (!hasPropUsage(source, consumer.prop)) {
				failures.push({ key, reason: `prop '${consumer.prop}' not found in ${consumer.file}` });
			}
		}

		expect(
			failures,
			failures.map(f => `${f.key}: ${f.reason}`).join('\n'),
		).to.deep.equal([]);
	});
});

describe('IngestStates integration: scan → create → update → close across restart', () => {
	function createIntegrationCtx() {
		const calls = {
			setForeignState: [],
			completeAfterCauseEliminated: [],
		};

		const stateById = new Map();
		const byRef = {};

		let viewRows = [];

		function applyMetricsPatch(msg, patch) {
			const prev = msg.metrics instanceof Map ? msg.metrics : new Map();
			const next = new Map(prev);
			const set = patch?.set && typeof patch.set === 'object' ? patch.set : null;
			const del = Array.isArray(patch?.delete) ? patch.delete : [];
			if (set) {
				for (const [k, v] of Object.entries(set)) {
					next.set(k, v);
				}
			}
			for (const k of del) {
				next.delete(k);
			}
			msg.metrics = next;
		}

		const ctx = {
			api: {
				log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
				i18n: { t: (key, ...args) => format(String(key), ...args) },
				iobroker: {
					ids: { namespace: 'msghub.0' },
					objects: {
						getObjectView: async () => ({ rows: viewRows }),
						setObjectNotExists: async () => undefined,
						getForeignObject: async () => ({ common: { name: 'My Sensor', unit: 'W' } }),
					},
					states: {
						getForeignState: async id => stateById.get(id) || null,
						setForeignState: async (id, state) => {
							calls.setForeignState.push({ id, state });
							stateById.set(id, state);
						},
					},
					subscribe: {
						subscribeForeignStates: () => undefined,
						unsubscribeForeignStates: () => undefined,
						subscribeForeignObjects: () => undefined,
						unsubscribeForeignObjects: () => undefined,
					},
				},
				constants: {
					actions: { type: { close: 'close' } },
					kind: { status: 'status' },
					level: { notice: 10 },
					origin: { type: { automation: 'automation' } },
					lifecycle: {
						state: {
							open: 'open',
							acked: 'acked',
							snoozed: 'snoozed',
							closed: 'closed',
							expired: 'expired',
							deleted: 'deleted',
						},
					},
				},
				factory: {
					createMessage: msg => ({ ...msg, metrics: new Map() }),
				},
				store: {
					getMessageByRef: ref => byRef[ref] || null,
					addMessage: msg => {
						byRef[msg.ref] = msg;
						return true;
					},
					addOrUpdateMessage: msg => {
						byRef[msg.ref] = msg;
						return true;
					},
					updateMessage: (ref, patch) => {
						const msg = byRef[ref];
						if (!msg) {
							throw new Error('missing');
						}
						if (patch?.metrics) {
							applyMetricsPatch(msg, patch.metrics);
						}
						for (const [k, v] of Object.entries(patch || {})) {
							if (k === 'metrics') {
								continue;
							}
							msg[k] = v;
						}
						return true;
					},
					completeAfterCauseEliminated: (ref, info) => {
						calls.completeAfterCauseEliminated.push({ ref, info });
						const msg = byRef[ref];
						if (!msg) {
							return false;
						}
						msg.lifecycle = {
							state: ctx.api.constants.lifecycle.state.closed,
							stateChangedAt: Date.now(),
							stateChangedBy: info?.actor || '',
						};
						return true;
					},
					removeMessage: ref => {
						delete byRef[ref];
						return true;
					},
				},
			},
			meta: {
				plugin: {
					baseFullId: 'msghub.0.IngestStates.0',
					baseOwnId: 'IngestStates.0',
					instanceId: 0,
					regId: 'IngestStates:0',
				},
				options: {
					resolveInt: (_k, v) => (typeof v === 'number' ? v : 0),
					resolveBool: (_k, v) => Boolean(v),
				},
				managedObjects: { report: () => undefined, applyReported: () => undefined },
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
			stateById,
			byRef,
			setViewRows: rows => {
				viewRows = rows;
			},
		};
	}

	it('survives restart for Threshold minDuration (TimerService) and then closes on recovery', async () => {
		const { ctx, byRef, stateById, setViewRows } = createIntegrationCtx();

		const presetId = 'preset1';
		const presetStateId = `msghub.0.IngestStates.0.presets.${presetId}`;
		stateById.set(presetStateId, {
			val: JSON.stringify({
					schema: 'msghub.IngestStatesMessagePreset.v1',
					presetId,
					description: 'test preset',
					ownedBy: null,
					message: {
						kind: 'status',
						level: 20,
					title: 't',
					text: 'x',
					timing: { remindEvery: 0, cooldown: 0, timeBudget: 0, dueInMs: 0 },
					details: { task: '', reason: '', tools: [], consumables: [] },
					audience: { tags: [], channels: { include: [], exclude: [] } },
					actions: [],
				},
				policy: { resetOnNormal: true },
			}),
		});

		const originalNow = Date.now;
		const baseNow = Date.UTC(2025, 0, 1, 12, 0, 0);
		Date.now = () => baseNow;
		try {
			setViewRows([
				{
					id: 'dev.0.target',
					value: {
						'msghub.0': {
							enabled: true,
							mode: 'threshold',
							'thr-mode': 'lt',
							'thr-value': 10,
							'thr-hysteresis': 0,
							'thr-minDurationValue': 5,
							'thr-minDurationUnit': 1,
							'msg-DefaultId': presetId,
						},
					},
				},
			]);

			const engine1 = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
			engine1.start();
			await engine1._queue.current;

			// Condition becomes active -> schedules a persistent timer, but does not create a message yet.
			engine1.onStateChange('dev.0.target', { val: 9 }, ctx);
			stateById.set('dev.0.target', { val: 9 });

			// Persist timers state immediately for the test.
			engine1._timers._flushNow();

			const timersState = stateById.get('msghub.0.IngestStates.0.timers');
			expect(timersState).to.be.ok;

			engine1.stop();

			// Restart: create a new engine that loads the persisted timers json.
			const engine2 = new IngestStatesEngine(ctx, { rescanIntervalMs: 0, evaluateIntervalMs: 0 });
			engine2.start();
			await engine2._queue.current;
			await new Promise(resolve => setImmediate(resolve));

			const tid = 'thr:dev.0.target';
			const pending = engine2._timers.get(tid);
			expect(pending).to.be.ok;
			expect(pending.kind).to.equal('threshold.minDuration');

			// Simulate a due timer: TimerService normally deletes it before routing.
			engine2._timers.delete(tid);
			engine2._timers._flushNow();

			engine2._onTimer({ id: tid, ...pending });
			await engine2._queue.current;

			const ref = 'IngestStates.0.threshold.dev.0.target';
			expect(byRef[ref]).to.be.ok;
			expect(byRef[ref].lifecycle.state).to.equal(ctx.api.constants.lifecycle.state.open);

			// Recovery -> close immediately.
			engine2.onStateChange('dev.0.target', { val: 10 }, ctx);
			expect(byRef[ref].lifecycle.state).to.equal(ctx.api.constants.lifecycle.state.closed);

			engine2.stop();
		} finally {
			Date.now = originalNow;
		}
	});
});
