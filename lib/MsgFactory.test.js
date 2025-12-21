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
	return { factory: new MsgFactory(adapter), logs };
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
		expect(msg.timing).to.be.an('object');
		expect(msg.timing.createdAt).to.be.a('number');
	});

	describe('required fields', () => {
		it('normalizes ref by removing non-printable characters', () => {
			const { factory } = makeFactory();
			const msg = factory.createMessage(buildBase({ ref: 'ref-\n-1' }));
			expect(msg.ref).to.equal('ref--1');
		});

		it('returns null when title is missing', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ title: undefined }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});

		it('returns null when text is not a string', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ text: 42 }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});

		it('returns null when level is invalid', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ level: 999 }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});

		it('returns null when kind is invalid', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ kind: 'invalid' }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});

		it('returns null when origin is not an object', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ origin: null }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});

	describe('origin', () => {
		it('trims system and id fields', () => {
			const { factory } = makeFactory();
			const origin = { type: MsgConstants.origin.type.manual, system: ' unit ', id: ' 7 ' };
			const msg = factory.createMessage(buildBase({ origin }));
			expect(msg.origin).to.deep.equal({ type: MsgConstants.origin.type.manual, system: 'unit', id: '7' });
		});

		it('returns null when origin.type is missing', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ origin: {} }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});

		it('returns null when origin.type is invalid', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ origin: { type: 'bad' } }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});

	describe('timing', () => {
		it('allows dueAt on tasks', () => {
			const { factory } = makeFactory();
			const dueAt = Date.UTC(2025, 0, 1);
			const msg = factory.createMessage(buildBase({ timing: { dueAt } }));
			expect(msg.timing.dueAt).to.equal(dueAt);
		});

		it('allows startAt and endAt on appointments', () => {
			const { factory } = makeFactory();
			const startAt = Date.UTC(2025, 0, 1, 9);
			const endAt = Date.UTC(2025, 0, 1, 10);
			const msg = factory.createMessage(
				buildBase({ kind: MsgConstants.kind.appointment, timing: { startAt, endAt } }),
			);
			expect(msg.timing.startAt).to.equal(startAt);
			expect(msg.timing.endAt).to.equal(endAt);
		});

		it('omits dueAt on non-task kinds', () => {
			const { factory } = makeFactory();
			const dueAt = Date.UTC(2025, 0, 1);
			const msg = factory.createMessage(
				buildBase({ kind: MsgConstants.kind.appointment, timing: { dueAt } }),
			);
			expect(msg.timing).to.not.have.property('dueAt');
		});

		it('returns null when timing has an implausible timestamp', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ timing: { expiresAt: 1 } }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});

		it('returns null when timing is not an object', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ timing: 'bad' }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
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
				tools: ['mop', 'broom'],
				consumables: ['soap', 'water'],
			});
		});

		it('returns null when details is not an object', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ details: 'bad' }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});

	describe('progress', () => {
		it('normalizes percentage and startedAt', () => {
			const { factory } = makeFactory();
			const startedAt = Date.UTC(2025, 0, 1);
			const msg = factory.createMessage(buildBase({ progress: { percentage: 5.9, startedAt } }));
			expect(msg.progress).to.deep.equal({ percentage: 5, startedAt });
		});

		it('returns null when progress is not an object', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ progress: 'bad' }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});

	describe('dependencies', () => {
		it('normalizes dependencies from a comma-separated string', () => {
			const { factory } = makeFactory();
			const msg = factory.createMessage(buildBase({ dependencies: 'a, b, , c' }));
			expect(msg.dependencies).to.deep.equal(['a', 'b', 'c']);
		});
	});

	describe('metrics', () => {
		it('normalizes valid metrics map entries', () => {
			const { factory } = makeFactory();
			const metrics = new Map([
				['temperature', { val: 21.5, unit: 'C' }],
				['mode', { val: 'auto', unit: 'state' }],
			]);

			const msg = factory.createMessage(buildBase({ metrics }));
			expect(msg.metrics).to.be.instanceOf(Map);
			expect(msg.metrics.get('temperature')).to.deep.equal({ val: 21.5, unit: 'C' });
			expect(msg.metrics.get('mode')).to.deep.equal({ val: 'auto', unit: 'state' });
		});

		it('drops invalid metrics entries and keeps valid ones', () => {
			const { factory } = makeFactory();
			const metrics = new Map([
				['ok', { val: 1, unit: 'C' }],
				['bad', { val: { nested: true }, unit: 'x' }],
			]);

			const msg = factory.createMessage(buildBase({ metrics }));
			expect(msg.metrics).to.be.instanceOf(Map);
			expect(msg.metrics.size).to.equal(1);
			expect(msg.metrics.get('ok')).to.deep.equal({ val: 1, unit: 'C' });
		});

		it('returns null when metrics is not a Map', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ metrics: { temp: { val: 1, unit: 'C' } } }));
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

		it('returns null when attachments is not an array', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ attachments: 'bad' }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});

	describe('shoppinglistItems', () => {
		it('normalizes valid shopping list items', () => {
			const { factory } = makeFactory();
			const shoppinglistItems = [
				{
					name: ' Milk ',
					category: ' Food ',
					quantity: { val: 2, unit: ' l ' },
					checked: false,
				},
			];

			const msg = factory.createMessage(buildBase({ shoppinglistItems }));
			expect(msg.shoppinglistItems).to.deep.equal([
				{ name: 'Milk', category: 'Food', quantity: { val: 2, unit: 'l' }, checked: false },
			]);
		});

		it('drops invalid shopping list items', () => {
			const { factory } = makeFactory();
			const shoppinglistItems = [{ name: '', checked: true }];
			const msg = factory.createMessage(buildBase({ shoppinglistItems }));
			expect(msg).to.not.have.property('shoppinglistItems');
		});

		it('returns null when shoppinglistItems is not an array', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ shoppinglistItems: 'bad' }));
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
					ts: 123.9,
				},
			];

			const msg = factory.createMessage(buildBase({ actions }));
			expect(msg.actions).to.deep.equal([
				{ type: MsgConstants.actions.type.ack, id: 'abc', payload: { foo: 'bar' }, ts: 123 },
			]);
		});

		it('drops invalid actions entries', () => {
			const { factory } = makeFactory();
			const actions = [{ type: 'invalid', id: '1' }];
			const msg = factory.createMessage(buildBase({ actions }));
			expect(msg).to.not.have.property('actions');
		});

		it('returns null when actions is not an array', () => {
			const { factory, logs } = makeFactory();
			const msg = factory.createMessage(buildBase({ actions: 'bad' }));
			expect(msg).to.equal(null);
			expect(logs.error.length).to.be.greaterThan(0);
		});
	});
});
