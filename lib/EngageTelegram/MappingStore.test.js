'use strict';

const { expect } = require('chai');

const { createMappingStore } = require('./MappingStore');

describe('EngageTelegram MappingStore', () => {
	it('upserts ref records and maintains shortId index', async () => {
		const states = new Map();
		const iobroker = {
			objects: { setObjectNotExists: () => Promise.resolve() },
			states: {
				getForeignState: id => Promise.resolve({ val: states.get(id) || '' }),
				setState: (id, st) => {
					states.set(id, String(st?.val || ''));
					return Promise.resolve();
				},
			},
		};
		const log = { warn: () => undefined, debug: () => undefined };

		const store = createMappingStore({ iobroker, log, baseFullId: 'msghub.0.EngageTelegram.0' });
		await store.ensureObjects();
		await store.load();

		store.upsert({
			purpose: 'due',
			ref: 'm1',
			shortId: 'abc123',
			textHtml: '<b>x</b>',
			textPlain: 'x',
			chatMessages: { '1': 10 },
			createdAt: 1,
			updatedAt: 1,
			shouldHaveButtons: true,
		});
		await store.save({ prune: false });

		expect(store.getRefByShortId('abc123')).to.equal('m1');
		expect(store.getByRef('m1')).to.have.property('purpose', 'due');

		// Change shortId should drop the old index entry.
		store.upsert({ ref: 'm1', shortId: 'def456', updatedAt: 2 });
		expect(store.getRefByShortId('abc123')).to.equal('');
		expect(store.getRefByShortId('def456')).to.equal('m1');
	});

	it('stores ui records separately and supports query()', async () => {
		const states = new Map();
		const iobroker = {
			objects: { setObjectNotExists: () => Promise.resolve() },
			states: {
				getForeignState: id => Promise.resolve({ val: states.get(id) || '' }),
				setState: (id, st) => {
					states.set(id, String(st?.val || ''));
					return Promise.resolve();
				},
			},
		};
		const log = { warn: () => undefined, debug: () => undefined };

		const store = createMappingStore({ iobroker, log, baseFullId: 'msghub.0.EngageTelegram.0' });
		await store.ensureObjects();

		store.upsert({ purpose: 'tasks', uiId: '765:tasks', createdAt: 10, updatedAt: 10, shouldHaveButtons: false });
		store.upsert({ purpose: 'due', ref: 'm1', createdAt: 11, updatedAt: 11, shouldHaveButtons: true });

		const tasks = store.query(r => r.purpose === 'tasks');
		expect(tasks).to.have.length(1);
		expect(tasks[0]).to.have.property('uiId', '765:tasks');

		expect(store.getByUiId('765:tasks')).to.exist;
		expect(store.removeByUiId('765:tasks')).to.equal(true);
		expect(store.getByUiId('765:tasks')).to.equal(null);
	});

	it('rebuilds shortId index from mappingByRef on load (drops stale entries)', async () => {
		const states = new Map();
		const iobroker = {
			objects: { setObjectNotExists: () => Promise.resolve() },
			states: {
				getForeignState: id => Promise.resolve({ val: states.get(id) || '' }),
				setState: (id, st) => {
					states.set(id, String(st?.val || ''));
					return Promise.resolve();
				},
			},
		};
		const log = { warn: () => undefined, debug: () => undefined };

		const store1 = createMappingStore({ iobroker, log, baseFullId: 'msghub.0.EngageTelegram.0' });
		await store1.ensureObjects();
		await store1.load();

		store1.upsert({ purpose: 'due', ref: 'm1', shortId: 'abc123', createdAt: 1, updatedAt: 1, shouldHaveButtons: true });
		await store1.save({ prune: false });

		// Simulate drift: persist an extra shortId pointing to the same ref.
		const shortIdStateId = store1.ids.mappingShortStateId;
		const storedIndex = JSON.parse(states.get(shortIdStateId) || '{}');
		storedIndex.zzz999 = 'm1';
		states.set(shortIdStateId, JSON.stringify(storedIndex));

		const store2 = createMappingStore({ iobroker, log, baseFullId: 'msghub.0.EngageTelegram.0' });
		await store2.load();

		expect(store2.getRefByShortId('abc123')).to.equal('m1');
		expect(store2.getRefByShortId('zzz999')).to.equal('');
	});
});
