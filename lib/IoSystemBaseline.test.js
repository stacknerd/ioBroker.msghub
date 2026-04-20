'use strict';

const crypto = require('node:crypto');
const { expect } = require('chai');
const sinon = require('sinon');

const { IoSystemBaseline } = require('./IoSystemBaseline');

describe('IoSystemBaseline — happy path', () => {
	function createAdapter({ objects = {}, passwordError = null, viewRows = [] } = {}) {
		const writes = [];
		const passwordCalls = [];
		const viewCalls = [];
		const store = new Map(Object.entries(objects));
		return {
			adapter: {
				namespace: 'msghub.0',
				async getForeignObjectAsync(id) {
					return store.get(id) || null;
				},
				async setForeignObjectAsync(id, obj) {
					const clone = JSON.parse(JSON.stringify(obj));
					writes.push([id, clone]);
					store.set(id, clone);
				},
				async setPasswordAsync(user, password) {
					if (passwordError) {
						throw passwordError;
					}
					passwordCalls.push([user, password]);
				},
				async getObjectViewAsync(design, search, params) {
					viewCalls.push([design, search, params]);
					return { rows: viewRows };
				},
			},
			writes,
			passwordCalls,
			viewCalls,
			store,
		};
	}

	it('keeps object writes at no-op when the baseline already matches and still refreshes the password', async () => {
		const { adapter, writes, passwordCalls } = createAdapter({
			objects: {
				'system.user.msghub_webapp_user': {
					type: 'user',
					common: {
						name: 'MessageHub WebApp User',
						desc: 'Built-in MessageHub user for an ioBroker.web instance used by the WebApp.',
						password: 'hashed',
						enabled: true,
						icon: '/adapter/msghub/msghub.png',
					},
					native: {},
				},
				'system.group.msghub_web': {
					type: 'group',
					common: {
						name: 'MessageHub Web',
						desc: 'Built-in MessageHub user group for web access.',
						members: ['system.user.msghub_webapp_user'],
						acl: {
							file: { list: false, read: false, write: false, create: false, delete: false },
							object: { list: false, read: false, write: false, create: false, delete: false },
							users: { list: false, read: false, write: false, create: false, delete: false },
							state: { list: false, read: false, write: false, create: false, delete: false },
							other: { execute: false, http: true, sendto: false },
						},
						enabled: true,
						icon: '/adapter/msghub/msghub.png',
					},
					native: {},
				},
			},
		});

		const baseline = new IoSystemBaseline({ adapter });
		await baseline.ensure();

		expect(writes).to.deep.equal([]);
		expect(passwordCalls).to.have.length(1);
		expect(passwordCalls[0][0]).to.equal('msghub_webapp_user');
	});

	it('creates missing user and group objects with canonical fields', async () => {
		const { adapter, writes, store } = createAdapter();
		const baseline = new IoSystemBaseline({ adapter });

		await baseline.ensure();

		expect(writes.map(([id]) => id)).to.deep.equal([
			'system.user.msghub_webapp_user',
			'system.group.msghub_web',
		]);
		expect(store.get('system.user.msghub_webapp_user')).to.deep.equal({
			_id: 'system.user.msghub_webapp_user',
			type: 'user',
			common: {
				name: 'MessageHub WebApp User',
				desc: 'Built-in MessageHub user for an ioBroker.web instance used by the WebApp.',
				password: '',
				enabled: true,
				icon: '/adapter/msghub/msghub.png',
			},
			native: {},
		});
		expect(store.get('system.group.msghub_web')).to.deep.equal({
			_id: 'system.group.msghub_web',
			type: 'group',
			common: {
				name: 'MessageHub Web',
				desc: 'Built-in MessageHub user group for web access.',
				members: ['system.user.msghub_webapp_user'],
				acl: {
					file: { list: false, read: false, write: false, create: false, delete: false },
					object: { list: false, read: false, write: false, create: false, delete: false },
					users: { list: false, read: false, write: false, create: false, delete: false },
					state: { list: false, read: false, write: false, create: false, delete: false },
					other: { execute: false, http: true, sendto: false },
				},
				enabled: true,
				icon: '/adapter/msghub/msghub.png',
			},
			native: {},
		});
	});
});

describe('IoSystemBaseline — boundary and correction paths', () => {
	function createAdapter({ objects = {}, viewRows = [] } = {}) {
		const writes = [];
		const passwordCalls = [];
		const store = new Map(Object.entries(objects));
		return {
			adapter: {
				namespace: 'msghub.0',
				async getForeignObjectAsync(id) {
					return store.get(id) || null;
				},
				async setForeignObjectAsync(id, obj) {
					const clone = JSON.parse(JSON.stringify(obj));
					writes.push([id, clone]);
					store.set(id, clone);
				},
				async setPasswordAsync(user, password) {
					passwordCalls.push([user, password]);
				},
				async getObjectViewAsync() {
					return { rows: viewRows };
				},
			},
			writes,
			passwordCalls,
			store,
		};
	}

	it('corrects divergent user fields without dropping unrelated metadata', async () => {
		const { adapter, writes, store } = createAdapter({
			objects: {
				'system.user.msghub_webapp_user': {
					type: 'user',
					common: {
						name: 'Wrong Name',
						password: 'hashed',
						enabled: false,
						icon: '/wrong/icon.png',
						desc: 'wrong description',
					},
					native: { keep: true },
				},
				'system.group.msghub_web': {
					type: 'group',
					common: {
						name: 'MessageHub Web',
						members: ['system.user.msghub_webapp_user'],
						acl: {
							file: { list: false, read: false, write: false, create: false, delete: false },
							object: { list: false, read: false, write: false, create: false, delete: false },
							users: { list: false, read: false, write: false, create: false, delete: false },
							state: { list: false, read: false, write: false, create: false, delete: false },
							other: { execute: false, http: true, sendto: false },
						},
						enabled: true,
						icon: '/adapter/msghub/msghub.png',
					},
					native: {},
				},
			},
		});

		const baseline = new IoSystemBaseline({ adapter });
		await baseline.ensure();

		expect(writes[0][0]).to.equal('system.user.msghub_webapp_user');
		expect(store.get('system.user.msghub_webapp_user')).to.deep.equal({
			_id: 'system.user.msghub_webapp_user',
			type: 'user',
			common: {
				name: 'MessageHub WebApp User',
				desc: 'Built-in MessageHub user for an ioBroker.web instance used by the WebApp.',
				password: 'hashed',
				enabled: true,
				icon: '/adapter/msghub/msghub.png',
			},
			native: { keep: true },
		});
	});

	it('resets ACL and membership to the canonical group baseline', async () => {
		const { adapter, writes, store } = createAdapter({
			objects: {
				'system.user.msghub_webapp_user': {
					type: 'user',
			common: {
				name: 'MessageHub WebApp User',
				desc: 'Built-in MessageHub user for an ioBroker.web instance used by the WebApp.',
				password: 'hashed',
				enabled: true,
				icon: '/adapter/msghub/msghub.png',
					},
					native: {},
				},
				'system.group.msghub_web': {
					type: 'group',
					common: {
						name: 'Wrong Group',
						members: ['system.user.msghub_webapp_user', 'system.user.other'],
						acl: {
							file: { list: true, read: true, write: true, create: true, delete: true },
							object: { list: true, read: true, write: true, create: true, delete: true },
							users: { list: true, read: true, write: true, create: true, delete: true },
							state: { list: true, read: true, write: true, create: true, delete: true },
							other: { execute: true, http: false, sendto: true },
						},
						enabled: false,
						icon: '/wrong/icon.png',
					},
					native: { keep: true },
				},
			},
		});

		const baseline = new IoSystemBaseline({ adapter });
		await baseline.ensure();

		expect(writes.map(([id]) => id)).to.deep.equal(['system.group.msghub_web']);
		expect(store.get('system.group.msghub_web')).to.deep.equal({
			_id: 'system.group.msghub_web',
			type: 'group',
			common: {
				name: 'MessageHub Web',
				desc: 'Built-in MessageHub user group for web access.',
				members: ['system.user.msghub_webapp_user'],
				acl: {
					file: { list: false, read: false, write: false, create: false, delete: false },
					object: { list: false, read: false, write: false, create: false, delete: false },
					users: { list: false, read: false, write: false, create: false, delete: false },
					state: { list: false, read: false, write: false, create: false, delete: false },
					other: { execute: false, http: true, sendto: false },
				},
				enabled: true,
				icon: '/adapter/msghub/msghub.png',
			},
			native: { keep: true },
		});
	});

	it('normalizes and reads web instances through the verified object view path', async () => {
		const { adapter } = createAdapter({
			viewRows: [
				{
					id: 'system.adapter.web.0',
					value: {
						common: { enabled: true },
						native: { defaultUser: 'msghub_webapp_user' },
					},
				},
				{
					id: 'system.adapter.web.1',
					value: {
						common: { enabled: false },
						native: { defaultUser: 'admin' },
					},
				},
			],
		});

		const baseline = new IoSystemBaseline({ adapter });
		const rows = await baseline._readWebInstances();

		expect(rows).to.deep.equal([
			{
				id: 'system.adapter.web.0',
				value: 'web.0',
				defaultUser: 'msghub_webapp_user',
				enabled: true,
				usesReferenceUser: true,
			},
			{
				id: 'system.adapter.web.1',
				value: 'web.1',
				defaultUser: 'admin',
				enabled: false,
				usesReferenceUser: false,
			},
		]);
	});
});

describe('IoSystemBaseline — invalid input and error paths', () => {
	it('rejects missing adapters', () => {
		expect(() => new IoSystemBaseline()).to.throw('IoSystemBaseline: adapter is required');
	});

	it('generates 16-character passwords with upper, lower, digit, and safe special characters', () => {
		const baseline = new IoSystemBaseline({
			adapter: {
				namespace: 'msghub.0',
				getForeignObjectAsync: async () => null,
				setForeignObjectAsync: async () => undefined,
				setPasswordAsync: async () => undefined,
				getObjectViewAsync: async () => ({ rows: [] }),
			},
		});

		for (let index = 0; index < 25; index += 1) {
			const password = baseline._generatePassword();
			expect(password).to.have.length(16);
			expect(password).to.match(/[A-Z]/);
			expect(password).to.match(/[a-z]/);
			expect(password).to.match(/[0-9]/);
			expect(password).to.match(/[!#$%&()*+,\-./:;=?@\[\]^_{|}~]/);
			expect(password).to.not.match(/["'\\\s]/);
		}
	});

	it('uses crypto.randomInt for both character selection and shuffling', () => {
		const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
		const lower = 'abcdefghijklmnopqrstuvwxyz';
		const digits = '0123456789';
		const special = '!#$%&()*+,-./:;=?@[]^_{|}~';
		const all = `${upper}${lower}${digits}${special}`;
		const baseline = new IoSystemBaseline({
			adapter: {
				namespace: 'msghub.0',
				getForeignObjectAsync: async () => null,
				setForeignObjectAsync: async () => undefined,
				setPasswordAsync: async () => undefined,
				getObjectViewAsync: async () => ({ rows: [] }),
			},
		});
		const randomInt = sinon.stub(crypto, 'randomInt').returns(0);

		try {
			const password = baseline._generatePassword();

			expect(password).to.have.length(16);
			expect(randomInt.callCount).to.equal(31);
			expect(randomInt.getCalls().map(call => call.args[0])).to.deep.equal([
				upper.length,
				lower.length,
				digits.length,
				special.length,
				all.length,
				all.length,
				all.length,
				all.length,
				all.length,
				all.length,
				all.length,
				all.length,
				all.length,
				all.length,
				all.length,
				all.length,
				16,
				15,
				14,
				13,
				12,
				11,
				10,
				9,
				8,
				7,
				6,
				5,
				4,
				3,
				2,
			]);
		} finally {
			randomInt.restore();
		}
	});

	it('propagates password-set failures to the caller', async () => {
		const adapter = {
			namespace: 'msghub.0',
			async getForeignObjectAsync() {
				return null;
			},
			async setForeignObjectAsync() {},
			async setPasswordAsync() {
				throw new Error('password failed');
			},
			async getObjectViewAsync() {
				return { rows: [] };
			},
		};
		const baseline = new IoSystemBaseline({ adapter });

		let caught = null;
		try {
			await baseline.ensure();
		} catch (error) {
			caught = error;
		}

		expect(caught).to.be.instanceOf(Error);
		expect(caught.message).to.equal('password failed');
	});
});
