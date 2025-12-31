'use strict';

const { expect } = require('chai');
const { MsgFactory } = require('./MsgFactory');
const { MsgConstants } = require('./MsgConstants');

function makeFactory() {
	const logs = { warn: [], error: [] };
	const adapter = {
		log: {
			warn: msg => logs.warn.push(msg),
			error: msg => logs.error.push(msg),
		},
	};
	return { factory: new MsgFactory(adapter, MsgConstants), logs };
}

function buildBase(overrides = {}) {
	return {
		ref: 'ref-1',
		title: 'Test title',
		text: 'Test text',
		level: MsgConstants.level.notice,
		kind: MsgConstants.kind.task,
		origin: { type: MsgConstants.origin.type.manual, system: 'unit', id: '1' },
		...overrides,
	};
}

	describe('MsgFactory.createMessage', () => {
		it('creates a minimal valid message', () => {
			const { factory } = makeFactory();
			const msg = factory.createMessage(buildBase());

			expect(msg).to.be.an('object');
			expect(msg.ref).to.equal('ref-1');
			expect(msg.level).to.equal(MsgConstants.level.notice);
			expect(msg.kind).to.equal(MsgConstants.kind.task);
			expect(msg.origin).to.deep.equal({ type: MsgConstants.origin.type.manual, system: 'unit', id: '1' });
			expect(msg.lifecycle).to.deep.equal({ state: MsgConstants.lifecycle.state.open });
			expect(msg.timing).to.be.an('object');
			expect(msg.timing.createdAt).to.be.a('number');
		});

	describe('required fields', () => {
		it('normalizes ref by URL-encoding unsafe characters', () => {
			const { factory } = makeFactory();
			const msg = factory.createMessage(buildBase({ ref: 'ref-\n-1' }));
			expect(msg.ref).to.equal('ref-%0A-1');
		});

		it('does not double-encode already URL-encoded refs', () => {
			const { factory } = makeFactory();
			const msg = factory.createMessage(buildBase({ ref: 'ref-%0A-1' }));
			expect(msg.ref).to.equal('ref-%0A-1');
		});

		it('rejects missing title', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ title: undefined }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});

		it('rejects non-string text', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ text: 42 }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});

		it('rejects invalid level', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ level: 999 }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});

		it('rejects invalid kind', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ kind: 'invalid' }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});

		it('rejects non-object origin', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ origin: null }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});

	describe('ref auto-generation', () => {
		it('auto-generates a stable ref for manual tasks when origin.id is provided', () => {
			const { factory } = makeFactory();
			const origin = { type: MsgConstants.origin.type.manual, system: 'ui', id: 'series-1' };
			const msg1 = factory.createMessage(buildBase({ ref: undefined, origin }));
			const msg2 = factory.createMessage(buildBase({ ref: undefined, origin }));

			expect(msg1.ref).to.equal(msg2.ref);
			expect(msg1.ref).to.match(/^manual-task-ui-/);
		});

		it('auto-generates a ref for manual appointments when origin.id is missing', () => {
			const { factory } = makeFactory();
			const origin = { type: MsgConstants.origin.type.manual, system: 'ui' };
			const msg = factory.createMessage(
				buildBase({ ref: undefined, kind: MsgConstants.kind.appointment, origin }),
			);

			expect(msg.ref).to.be.a('string');
			expect(msg.ref).to.match(/^manual-appointment-ui-/);
		});

		it('logs a warning when an import message is missing ref', () => {
			const { factory, logs } = makeFactory();
			const origin = { type: MsgConstants.origin.type.import, system: 'alexa', id: 'series-1' };
			const msg = factory.createMessage(buildBase({ ref: undefined, origin }));

			expect(msg).to.be.an('object');
			expect(msg.ref).to.match(/^import-task-alexa-/);
			expect(logs.warn.length).to.be.greaterThan(0);
		});

		it('logs an error when an automation message is missing ref', () => {
			const { factory, logs } = makeFactory();
			const origin = { type: MsgConstants.origin.type.automation, system: 'rule' };
			const msg = factory.createMessage(buildBase({ ref: undefined, origin }));

			expect(msg).to.be.an('object');
			expect(msg.ref).to.match(/^automation-task-rule-/);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});

		describe('origin', () => {
		it('trims origin system and id', () => {
			const { factory } = makeFactory();
			const origin = { type: MsgConstants.origin.type.manual, system: ' unit ', id: ' 7 ' };
			const msg = factory.createMessage(buildBase({ origin }));
			expect(msg.origin).to.deep.equal({ type: MsgConstants.origin.type.manual, system: 'unit', id: '7' });
		});

		it('rejects missing origin.type', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ origin: {} }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});

		it('rejects invalid origin.type', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ origin: { type: 'bad' } }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
		});

		describe('lifecycle', () => {
			it('defaults lifecycle.state to open', () => {
				const { factory } = makeFactory();
				const msg = factory.createMessage(buildBase({ lifecycle: undefined }));
				expect(msg.lifecycle).to.deep.equal({ state: MsgConstants.lifecycle.state.open });
			});

			it('rejects non-object lifecycle', () => {
				const { factory, logs } = makeFactory();
				const msg = factory.createMessage(buildBase({ lifecycle: 'bad' }));
				expect(msg).to.equal(null);
				expect(logs.error.length).to.be.greaterThan(0);
			});
		});

		describe('timing', () => {
			it('allows dueAt for task kind', () => {
				const { factory } = makeFactory();
				const dueAt = Date.UTC(2025, 0, 1);
			const msg = factory.createMessage(buildBase({ timing: { dueAt } }));
			expect(msg.timing.dueAt).to.equal(dueAt);
		});

		it('allows startAt/endAt for appointment kind', () => {
			const { factory } = makeFactory();
			const startAt = Date.UTC(2025, 0, 1, 9);
			const endAt = Date.UTC(2025, 0, 1, 10);
			const msg = factory.createMessage(
				buildBase({ kind: MsgConstants.kind.appointment, timing: { startAt, endAt } }),
			);
			expect(msg.timing.startAt).to.equal(startAt);
			expect(msg.timing.endAt).to.equal(endAt);
		});

		it('omits dueAt for non-task kinds', () => {
			const { factory } = makeFactory();
			const dueAt = Date.UTC(2025, 0, 1);
			const msg = factory.createMessage(
				buildBase({ kind: MsgConstants.kind.appointment, timing: { dueAt } }),
			);
			expect(msg.timing).to.not.have.property('dueAt');
		});

		it('rejects implausible timing timestamp', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ timing: { expiresAt: 1 } }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});

			it('rejects non-object timing', () => {
				const { factory, logs } = makeFactory();
				const msg = factory.createMessage(buildBase({ timing: 'bad' }));
				expect(msg).to.equal(null);
				expect(logs.error.length).to.be.greaterThan(0);
			});

			it('normalizes remindEvery', () => {
				const { factory } = makeFactory();
				const msg = factory.createMessage(buildBase({ timing: { remindEvery: 60000.9 } }));
				expect(msg.timing.remindEvery).to.equal(60000);
			});

			it('normalizes timeBudget', () => {
				const { factory } = makeFactory();
				const msg = factory.createMessage(buildBase({ timing: { timeBudget: 900000.9 } }));
				expect(msg.timing.timeBudget).to.equal(900000);
			});
		});

	describe('details', () => {
		it('normalizes details fields', () => {
			const { factory } = makeFactory();
			const details = {
				location: ' Room ',
				task: ' Clean ',
				tools: 'mop, broom, , ',
				consumables: [' soap ', '', 'water'],
			};
			const msg = factory.createMessage(buildBase({ details }));
			expect(msg.details).to.deep.equal({
				location: 'Room',
				task: 'Clean',
				tools: ['mop, broom, ,'],
				consumables: ['soap', 'water'],
			});
		});

		it('rejects non-object details', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ details: 'bad' }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});

	describe('audience', () => {
		it('normalizes audience tags and channels', () => {
			const { factory } = makeFactory();
			const audience = {
				tags: ' admin, , family ',
				channels: {
					include: ['telegram', ''],
					exclude: 'sms, , ',
				},
			};
			const msg = factory.createMessage(buildBase({ audience }));
			expect(msg.audience).to.deep.equal({
				tags: ['admin', 'family'],
				channels: { include: ['telegram'], exclude: ['sms'] },
			});
		});

		it('rejects non-object audience', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ audience: 'bad' }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});

	describe('progress', () => {
		it('normalizes progress percentage and startedAt', () => {
			const { factory } = makeFactory();
			const startedAt = Date.UTC(2025, 0, 1);
			const msg = factory.createMessage(buildBase({ progress: { percentage: 5.9, startedAt } }));
			expect(msg.progress).to.deep.equal({ percentage: 5, startedAt });
		});

		it('rejects non-object progress', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ progress: 'bad' }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});

	describe('dependencies', () => {
		it('normalizes dependencies from a CSV string', () => {
			const { factory } = makeFactory();
			const msg = factory.createMessage(buildBase({ dependencies: 'a, b, , c' }));
			expect(msg.dependencies).to.deep.equal(['a', 'b', 'c']);
		});
	});

	describe('metrics', () => {
		it('normalizes valid metrics map entries', () => {
			const { factory } = makeFactory();
			const metrics = new Map([
				['temperature', { val: 21.5, unit: 'C', ts: Date.UTC(2025, 0, 1) }],
				['mode', { val: 'auto', unit: 'state', ts: Date.UTC(2025, 0, 2) }],
			]);

			const msg = factory.createMessage(buildBase({ metrics }));
			expect(msg.metrics).to.be.instanceOf(Map);
			expect(msg.metrics.get('temperature')).to.deep.equal({ val: 21.5, unit: 'C', ts: Date.UTC(2025, 0, 1) });
			expect(msg.metrics.get('mode')).to.deep.equal({ val: 'auto', unit: 'state', ts: Date.UTC(2025, 0, 2) });
		});

		it('drops invalid metrics entries', () => {
			const { factory } = makeFactory();
			const metrics = new Map([
				['ok', { val: 1, unit: 'C', ts: Date.UTC(2025, 0, 1) }],
				['bad', { val: { nested: true }, unit: 'x' }],
			]);

			const msg = factory.createMessage(buildBase({ metrics }));
			expect(msg.metrics).to.be.instanceOf(Map);
			expect(msg.metrics.size).to.equal(1);
			expect(msg.metrics.get('ok')).to.deep.equal({ val: 1, unit: 'C', ts: Date.UTC(2025, 0, 1) });
		});

		it('rejects non-Map metrics', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(
				buildBase({ metrics: { temp: { val: 1, unit: 'C', ts: Date.UTC(2025, 0, 1) } } }),
			);
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});

	describe('attachments', () => {
		it('normalizes valid attachments', () => {
			const { factory } = makeFactory();
			const attachments = [
				{ type: MsgConstants.attachments.type.image, value: 'https://example.com/a.png' },
				{ type: MsgConstants.attachments.type.ssml, value: '<speak>Hello</speak>' },
			];

			const msg = factory.createMessage(buildBase({ attachments }));
			expect(msg.attachments).to.deep.equal(attachments);
		});

		it('drops invalid attachments entries', () => {
			const { factory } = makeFactory();
			const attachments = [{ type: 'invalid', value: 'x' }];
			const msg = factory.createMessage(buildBase({ attachments }));
			expect(msg).to.not.have.property('attachments');
		});

		it('rejects non-array attachments', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ attachments: 'bad' }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});

		describe('actions', () => {
			it('normalizes valid actions', () => {
				const { factory } = makeFactory();
				const actions = [
					{
						type: MsgConstants.actions.type.ack,
						id: ' abc ',
						payload: { foo: 'bar' },
					},
					{
						type: MsgConstants.actions.type.snooze,
						id: ' snooze-1 ',
						payload: null,
					},
				];

				const msg = factory.createMessage(buildBase({ actions }));
				expect(msg.actions).to.deep.equal([
					{ type: MsgConstants.actions.type.ack, id: 'abc', payload: { foo: 'bar' } },
					{ type: MsgConstants.actions.type.snooze, id: 'snooze-1', payload: null },
				]);
			});

			it('auto-generates ids for actions without id', () => {
				const { factory } = makeFactory();
				const actions = [{ type: MsgConstants.actions.type.ack }];
				const msg = factory.createMessage(buildBase({ actions }));
				expect(msg.actions).to.deep.equal([{ type: MsgConstants.actions.type.ack, id: 'action_0' }]);
			});

		it('drops invalid actions entries', () => {
			const { factory } = makeFactory();
			const actions = [{ type: 'invalid', id: '1' }];
			const msg = factory.createMessage(buildBase({ actions }));
			expect(msg).to.not.have.property('actions');
		});

		it('rejects non-array actions', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ actions: 'bad' }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});
});

describe('MsgFactory.applyPatch', () => {
	it('preserves createdAt and sets updatedAt on patch', () => {
		const { factory } = makeFactory();
		const originalNow = Date.now;
		Date.now = () => 1000;
		const msg = factory.createMessage(buildBase());

		Date.now = () => 2000;
		const updated = factory.applyPatch(msg, { title: 'New title' });
		Date.now = originalNow;

		expect(updated.timing.createdAt).to.equal(1000);
		expect(updated.timing.updatedAt).to.equal(2000);
		expect(updated.title).to.equal('New title');
	});

	it('does not set updatedAt on patch when stealthMode=true', () => {
		const { factory } = makeFactory();
		const originalNow = Date.now;
		Date.now = () => 1000;
		const msg = factory.createMessage(buildBase());

		Date.now = () => 2000;
		const updated = factory.applyPatch(msg, { title: 'New title' }, true);
		Date.now = originalNow;

		expect(updated.timing.createdAt).to.equal(1000);
		expect(updated.timing.updatedAt).to.equal(undefined);
		expect(updated.title).to.equal('New title');
	});

	it('sets updatedAt for title-only patch', () => {
		const { factory } = makeFactory();
		const originalNow = Date.now;
		Date.now = () => 1111;
		const msg = factory.createMessage(buildBase());

		Date.now = () => 2222;
		const updated = factory.applyPatch(msg, { title: 'Another title' });
		Date.now = originalNow;

		expect(updated.timing.updatedAt).to.equal(2222);
	});

	it('sets updatedAt when timing.endAt changes', () => {
		const { factory } = makeFactory();
		const originalNow = Date.now;
		Date.now = () => 3000;
		const msg = factory.createMessage(buildBase({ kind: MsgConstants.kind.appointment }));

		const endAt = Date.UTC(2025, 0, 1, 10);
		Date.now = () => 4000;
		const updated = factory.applyPatch(msg, { timing: { endAt: endAt } });
		Date.now = originalNow;

		expect(updated.timing.endAt).to.equal(endAt);
		expect(updated.timing.updatedAt).to.equal(4000);
	});

	it('sets updatedAt when timing.timeBudget changes', () => {
		const { factory } = makeFactory();
		const originalNow = Date.now;
		Date.now = () => 3000;
		const msg = factory.createMessage(buildBase());

		Date.now = () => 4000;
		const updated = factory.applyPatch(msg, { timing: { timeBudget: 900000 } });
		Date.now = originalNow;

		expect(updated.timing.timeBudget).to.equal(900000);
		expect(updated.timing.updatedAt).to.equal(4000);
	});

	it('rejects ref changes but allows same ref', () => {
		const { factory, logs } = makeFactory();
		const msg = factory.createMessage(buildBase());

		const changed = factory.applyPatch(msg, { ref: 'other-ref' });
		expect(changed).to.equal(null);
		expect(logs.error.length).to.be.greaterThan(0);

		const updated = factory.applyPatch(msg, { ref: msg.ref, title: 'Same ref ok' });
		expect(updated).to.be.an('object');
		expect(updated.ref).to.equal(msg.ref);
		expect(updated.title).to.equal('Same ref ok');
	});

	it('accepts patches that include an already normalized ref', () => {
		const { factory, logs } = makeFactory();
		const msg = factory.createMessage(buildBase({ ref: 'ref-\n-1' }));

		const updated = factory.applyPatch(msg, { ref: msg.ref, title: 'Same ref ok' });
		expect(updated).to.be.an('object');
		expect(updated.ref).to.equal(msg.ref);
		expect(updated.title).to.equal('Same ref ok');
		expect(logs.error).to.deep.equal([]);
	});

	it('rejects kind changes', () => {
		const { factory, logs } = makeFactory();
		const msg = factory.createMessage(buildBase());

		const updated = factory.applyPatch(msg, { kind: MsgConstants.kind.status });
		expect(updated).to.equal(null);
		expect(logs.error.length).to.be.greaterThan(0);
	});

	it('rejects origin changes', () => {
		const { factory, logs } = makeFactory();
		const msg = factory.createMessage(buildBase());

		const updated = factory.applyPatch(msg, { origin: { type: MsgConstants.origin.type.import } });
		expect(updated).to.equal(null);
		expect(logs.error.length).to.be.greaterThan(0);
	});

	it('rejects timing.createdAt changes', () => {
		const { factory, logs } = makeFactory();
		const originalNow = Date.now;
		Date.now = () => 1000;
		const msg = factory.createMessage(buildBase());
		Date.now = originalNow;

		const updated = factory.applyPatch(msg, { timing: { createdAt: 2000 } });
		expect(updated).to.equal(null);
		expect(logs.error.length).to.be.greaterThan(0);
	});

	it('does not set updatedAt for metrics-only patch', () => {
		const { factory } = makeFactory();
		const originalNow = Date.now;
		Date.now = () => 1000;
		const msg = factory.createMessage(buildBase());

		const metrics = new Map([['temp', { val: 1, unit: 'C', ts: Date.UTC(2025, 0, 1) }]]);
		Date.now = () => 2000;
		const updated = factory.applyPatch(msg, { metrics });
		Date.now = originalNow;

		expect(updated.metrics).to.be.instanceOf(Map);
		expect(updated.metrics.get('temp')).to.deep.equal({ val: 1, unit: 'C', ts: Date.UTC(2025, 0, 1) });
		expect(updated.timing.updatedAt).to.equal(undefined);
		expect(updated.timing.createdAt).to.equal(1000);
	});

	it('merges timing patches', () => {
		const { factory } = makeFactory();
		const originalNow = Date.now;
		Date.now = () => 1000;
		const msg = factory.createMessage(
			buildBase({ timing: { notifyAt: Date.UTC(2025, 0, 1) } }),
		);

		Date.now = () => 2000;
		const updated = factory.applyPatch(msg, { timing: { expiresAt: Date.UTC(2025, 0, 2) } });
		Date.now = originalNow;

		expect(updated.timing.notifyAt).to.equal(Date.UTC(2025, 0, 1));
		expect(updated.timing.expiresAt).to.equal(Date.UTC(2025, 0, 2));
	});

	it('patches audience partially', () => {
		const { factory } = makeFactory();
		const msg = factory.createMessage(
			buildBase({
				audience: {
					tags: ['ops'],
					channels: { include: ['telegram'], exclude: ['email'] },
				},
			}),
		);

		const updated = factory.applyPatch(msg, { audience: { tags: ['admin'] } });
		expect(updated.audience).to.deep.equal({
			tags: ['admin'],
			channels: { include: ['telegram'], exclude: ['email'] },
		});

		const updatedChannels = factory.applyPatch(updated, { audience: { channels: { include: null } } });
		expect(updatedChannels.audience).to.deep.equal({
			tags: ['admin'],
			channels: { exclude: ['email'] },
		});

		const cleared = factory.applyPatch(updatedChannels, { audience: null });
		expect(cleared).to.not.have.property('audience');
	});

	it('removes timing fields when set to null', () => {
		const { factory } = makeFactory();
		const msg = factory.createMessage(
			buildBase({ timing: { notifyAt: Date.UTC(2025, 0, 1) } }),
		);

		const updated = factory.applyPatch(msg, { timing: { notifyAt: null } });
		expect(updated.timing).to.not.have.property('notifyAt');
	});

	it('removes timing.timeBudget when set to null', () => {
		const { factory } = makeFactory();
		const msg = factory.createMessage(buildBase({ timing: { timeBudget: 900000 } }));

		const updated = factory.applyPatch(msg, { timing: { timeBudget: null } });
		expect(updated.timing).to.not.have.property('timeBudget');
	});

	it('clears attachments when set to null', () => {
		const { factory } = makeFactory();
		const attachments = [{ type: MsgConstants.attachments.type.image, value: 'https://x' }];
		const msg = factory.createMessage(buildBase({ attachments }));

		const updated = factory.applyPatch(msg, { attachments: null });
		expect(updated).to.not.have.property('attachments');
	});

	it('patches metrics with set/delete', () => {
		const { factory } = makeFactory();
		const metrics = new Map([
			['temperature', { val: 21, unit: 'C', ts: Date.UTC(2025, 0, 1) }],
			['humidity', { val: 50, unit: '%', ts: Date.UTC(2025, 0, 1) }],
		]);
		const msg = factory.createMessage(buildBase({ metrics }));

		const updated = factory.applyPatch(msg, {
			metrics: { set: { temperature: { val: 22, unit: 'C', ts: Date.UTC(2025, 0, 2) } }, delete: ['humidity'] },
		});

		expect(updated.metrics).to.be.instanceOf(Map);
		expect(updated.metrics.get('temperature')).to.deep.equal({ val: 22, unit: 'C', ts: Date.UTC(2025, 0, 2) });
		expect(updated.metrics.has('humidity')).to.equal(false);
	});

	it('patches attachments by index', () => {
		const { factory } = makeFactory();
		const attachments = [
			{ type: MsgConstants.attachments.type.image, value: 'a' },
			{ type: MsgConstants.attachments.type.image, value: 'b' },
			{ type: MsgConstants.attachments.type.image, value: 'c' },
		];
		const msg = factory.createMessage(buildBase({ attachments }));

		const updated = factory.applyPatch(msg, { attachments: { delete: [1] } });
		expect(updated.attachments).to.deep.equal([
			{ type: MsgConstants.attachments.type.image, value: 'a' },
			{ type: MsgConstants.attachments.type.image, value: 'c' },
		]);
	});

	it('patches listItems by id', () => {
		const { factory } = makeFactory();
		const listItems = [
			{ id: 'milk', name: 'Milk', checked: false },
			{ id: 'bread', name: 'Bread', checked: false },
		];
		const msg = factory.createMessage(buildBase({ kind: MsgConstants.kind.shoppinglist, listItems }));

		const updated = factory.applyPatch(msg, {
			listItems: { set: { milk: { name: 'Milk', checked: true } }, delete: ['bread'] },
		});

		expect(updated.listItems).to.deep.equal([{ id: 'milk', name: 'Milk', checked: true }]);
	});

	it('patches actions by id', () => {
		const { factory } = makeFactory();
		const actions = [
			{ id: 'a1', type: MsgConstants.actions.type.ack },
			{ id: 'a2', type: MsgConstants.actions.type.close },
		];
		const msg = factory.createMessage(buildBase({ actions }));

		const updated = factory.applyPatch(msg, {
			actions: { set: { a1: { type: MsgConstants.actions.type.open } }, delete: ['a2'] },
		});

		expect(updated.actions).to.deep.equal([{ id: 'a1', type: MsgConstants.actions.type.open }]);
	});

	it('patches dependencies with set/delete', () => {
		const { factory } = makeFactory();
		const msg = factory.createMessage(buildBase({ dependencies: ['a', 'b', 'c'] }));

		const updated = factory.applyPatch(msg, { dependencies: { set: ['a', 'b', 'c'], delete: ['b'] } });
		expect(updated.dependencies).to.deep.equal(['a', 'c']);
	});

	it('patches progress with set/delete', () => {
		const { factory } = makeFactory();
		const msg = factory.createMessage(buildBase({ progress: { percentage: 10, finishedAt: Date.UTC(2025, 0, 1) } }));

		const updated = factory.applyPatch(msg, { progress: { set: { percentage: 50 }, delete: ['finishedAt'] } });
		expect(updated.progress.percentage).to.equal(50);
		expect(updated.progress).to.not.have.property('finishedAt');
	});

	it('rejects non-object patch input', () => {
		const { factory, logs } = makeFactory();
		const updated = factory.applyPatch('string');
		expect(updated).to.equal(null);
		expect(logs.error.length).to.be.greaterThan(0);
	});

	it('rejects invalid existing message', () => {
		const { factory, logs } = makeFactory();
		const updated = factory.applyPatch({ test: 'fail', data: 2432134 });
		expect(updated).to.equal(null);
		expect(logs.error.length).to.be.greaterThan(0);
	});
});
