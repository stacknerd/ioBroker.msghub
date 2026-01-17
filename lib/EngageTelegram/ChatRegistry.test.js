'use strict';

const { expect } = require('chai');

const { createChatRegistry } = require('./ChatRegistry');

describe('EngageTelegram ChatRegistry', () => {
	const makeIoBroker = () => {
		const states = new Map();
		const objects = [];

		return {
			iobroker: {
				objects: {
					setObjectNotExists: (id, obj) => {
						objects.push({ id, obj });
						return Promise.resolve();
					},
				},
				states: {
					getForeignState: id => Promise.resolve({ val: states.get(id) || '' }),
					setState: (id, st) => {
						states.set(id, String(st?.val || ''));
						return Promise.resolve();
					},
				},
			},
			states,
			objects,
		};
	};

	it('persists and loads registry data', async () => {
		const { iobroker, states } = makeIoBroker();
		const log = { warn: () => undefined, debug: () => undefined };

		const reg = createChatRegistry({ iobroker, log, baseFullId: 'msghub.0.EngageTelegram.0' });
		await reg.ensureObjects();
		await reg.load();

		reg.upsertChat('1', { type: 'private', muted: false });
		reg.upsertChat('-10', { type: 'group', muted: true });
		await reg.save();

		const reg2 = createChatRegistry({ iobroker, log, baseFullId: 'msghub.0.EngageTelegram.0' });
		await reg2.load();

		expect(reg2.getChat('1')).to.deep.include({ chatId: '1', type: 'private', muted: false });
		expect(reg2.getChat('-10')).to.deep.include({ chatId: '-10', type: 'group', muted: true });
		expect(states.get('msghub.0.EngageTelegram.0.chatRegistry')).to.be.a('string').that.includes('"chats"');
	});

	it('syncs private chats from telegram users state and preserves mute', async () => {
		const { iobroker } = makeIoBroker();
		const log = { warn: () => undefined, debug: () => undefined };

		const reg = createChatRegistry({ iobroker, log, baseFullId: 'msghub.0.EngageTelegram.0' });
		await reg.load();

		// Initial sync adds users.
		const users1 = JSON.stringify({ '7652837497': { firstName: 'Ben', sysMessages: false } });
		const s1 = reg.syncPrivateChatsFromUsersState(users1, Date.now());
		expect(s1.ignored).to.equal(false);
		expect(reg.getChat('7652837497')).to.deep.include({ type: 'private', muted: false });

		// Mute is local state and must survive future syncs.
		reg.upsertChat('7652837497', { muted: true });

		const users2 = JSON.stringify({ '7652837497': { firstName: 'Ben', sysMessages: true } });
		reg.syncPrivateChatsFromUsersState(users2, Date.now());
		expect(reg.getChat('7652837497')).to.deep.include({ type: 'private', muted: true });
	});

	it('guards against transient empty user list and only removes after second empty', async () => {
		const { iobroker } = makeIoBroker();
		const log = { warn: () => undefined, debug: () => undefined };

		const reg = createChatRegistry({ iobroker, log, baseFullId: 'msghub.0.EngageTelegram.0' });
		await reg.load();

		reg.syncPrivateChatsFromUsersState(JSON.stringify({ '1': { firstName: 'A' } }), Date.now());
		expect(reg.getChat('1')).to.exist;

		// First empty: guarded -> keeps chat.
		const s1 = reg.syncPrivateChatsFromUsersState(JSON.stringify({}), Date.now());
		expect(s1.ignored).to.equal(false);
		expect(reg.getChat('1')).to.exist;

		// Second empty: apply removals -> removes chat.
		reg.syncPrivateChatsFromUsersState(JSON.stringify({}), Date.now());
		expect(reg.getChat('1')).to.equal(null);
	});
});

