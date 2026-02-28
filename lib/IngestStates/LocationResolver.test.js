'use strict';

const { expect } = require('chai');
const { LocationResolver } = require('./LocationResolver');

describe('LocationResolver', () => {
	function createCtx({ locale = 'en', getForeignObjects = null } = {}) {
		return {
			api: {
				i18n: { i18nLocale: locale },
				iobroker: {
					objects: { getForeignObjects },
				},
			},
		};
	}

	it('defaults to locale=en when missing', () => {
		const r = new LocationResolver({ api: {} });
		expect(r._translatedObjectString({ en: 'x' })).to.equal('x');
	});

	it('uses i18nLocale and base language for translations', () => {
		const r = new LocationResolver(createCtx({ locale: 'de-DE' }));
		expect(r._translatedObjectString({ de: ' Raum ', en: 'Room' })).to.equal('Raum');
	});

	it('falls back to any non-empty translation value', () => {
		const r = new LocationResolver(createCtx({ locale: 'it' }));
		expect(r._translatedObjectString({ fr: 'Salle' })).to.equal('Salle');
	});

	it('buildCache clears cache when getForeignObjects is missing', async () => {
		const r = new LocationResolver(createCtx());
		expect(r.resolve('a.b.c')).to.equal('');
		const before = r.loadedAt();
		await r.buildCache();
		expect(r.loadedAt()).to.be.a('number');
		expect(r.loadedAt()).to.be.at.least(before);
		expect(r.resolve('a.b.c')).to.equal('');
	});

	it('buildCache indexes enum.rooms members and is deterministic on duplicates', async () => {
		const enums = {
			'enum.rooms.kitchen': {
				_id: 'enum.rooms.kitchen',
				type: 'enum',
				common: { name: { en: 'Kitchen' }, members: ['dev.0.sensor', 'dev.0.shared'] },
			},
			'enum.rooms.living': {
				_id: 'enum.rooms.living',
				type: 'enum',
				common: { name: { en: 'Living' }, members: ['dev.0.shared', 'dev.0.other'] },
			},
		};

		const r = new LocationResolver(
			createCtx({
				locale: 'en',
				getForeignObjects: () => enums,
			}),
		);

		await r.buildCache();

		expect(r.resolve('dev.0.sensor')).to.equal('Kitchen');
		expect(r.resolve('dev.0.other')).to.equal('Living');

		// The shared member appears in both rooms; the first one wins.
		expect(r.resolve('dev.0.shared')).to.equal('Kitchen');
	});

	it('buildCache supports async getForeignObjects results and ignores invalid enums', async () => {
		const enums = {
			'enum.rooms.empty': { _id: 'enum.rooms.empty', type: 'enum', common: { name: { en: 'Empty' }, members: [] } },
			'enum.rooms.ok': {
				_id: 'enum.rooms.ok',
				type: 'enum',
				common: { name: { en: 'Ok' }, members: ['dev.0.a.b.c'] },
			},
			'enum.rooms.bad': { _id: 'enum.rooms.bad', type: 'state', common: { name: { en: 'Bad' }, members: ['dev.0.x'] } },
		};

		const r = new LocationResolver(
			createCtx({
				locale: 'en',
				getForeignObjects: async () => enums,
			}),
		);

		await r.buildCache();
		expect(r.resolve('dev.0.a.b.c')).to.equal('Ok');
		expect(r.resolve('dev.0.x')).to.equal('');
	});

	it('resolve walks up the id hierarchy, but does not check the root segment without dots', async () => {
		const enums = {
			'enum.rooms.top': {
				_id: 'enum.rooms.top',
				type: 'enum',
				common: { name: { en: 'Top' }, members: ['dev'] },
			},
			'enum.rooms.sub': {
				_id: 'enum.rooms.sub',
				type: 'enum',
				common: { name: { en: 'Sub' }, members: ['dev.0'] },
			},
		};

		const r = new LocationResolver(
			createCtx({
				locale: 'en',
				getForeignObjects: () => enums,
			}),
		);

		await r.buildCache();
		expect(r.resolve('dev.0.anything')).to.equal('Sub');
		expect(r.resolve('dev.anything')).to.equal('');
	});
});

