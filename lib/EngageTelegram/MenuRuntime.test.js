'use strict';

const { expect } = require('chai');

const { createMappingStore } = require('./MappingStore');
const { createTelegramUi } = require('./TelegramUi');
const { createMenuRuntime } = require('./MenuRuntime');

describe('EngageTelegram MenuRuntime', () => {
	it('auto-deletes mapped telegram messages after 46h', async () => {
		const states = new Map();
		const deleted = [];

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

		const mappingStore = createMappingStore({ iobroker, log, baseFullId: 'msghub.0.EngageTelegram.0' });
		await mappingStore.ensureObjects();
		await mappingStore.load();

		mappingStore.upsert({
			purpose: 'due',
			ref: 'm1',
			shortId: 'abc123',
			textHtml: '<b>x</b>',
			textPlain: 'x',
			chatMessages: { '1': 10 },
			createdAt: Date.now() - 46 * 60 * 60 * 1000 - 1000,
			updatedAt: Date.now() - 46 * 60 * 60 * 1000 - 1000,
			shouldHaveButtons: true,
		});
		await mappingStore.save({ prune: false });

		const telegramUi = createTelegramUi({
			callbackPrefix: 'opt_',
			t: s => s,
			iconByLevel: {},
			iconByKind: {},
		});

		const transport = {
			deleteMessage: ({ chatId, messageId }) => {
				deleted.push({ chatId, messageId });
				return Promise.resolve(null);
			},
			editMessage: () => Promise.resolve(null),
			sendBroadcast: () => Promise.resolve({ raw: null, chatMessages: {} }),
			sendImageBroadcast: () => Promise.resolve({ raw: null, chatMessages: {} }),
		};

		const runtime = createMenuRuntime({
			log,
			mappingStore,
			telegramUi,
			transport,
			store: null,
			generateShortId: () => 'abc123',
			cfg: { disableNotificationUpToLevel: 0 },
			defaultDisableNotificationUpToLevel: 0,
			menuTimeoutMs: 30 * 1000,
			autoDeleteAfterMs: 46 * 60 * 60 * 1000,
		});

		await runtime.tick(Date.now());

		expect(deleted).to.have.length(1);
		expect(mappingStore.getByRef('m1')).to.equal(null);
	});

	it('auto-closes open menus after timeout', async () => {
		const states = new Map();
		const edits = [];

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

		const mappingStore = createMappingStore({ iobroker, log, baseFullId: 'msghub.0.EngageTelegram.0' });
		await mappingStore.ensureObjects();
		await mappingStore.load();

		const now = Date.now();
		mappingStore.upsert({
			purpose: 'due',
			ref: 'm1',
			shortId: 'abc123',
			textHtml: '<b>x</b>',
			textPlain: 'x',
			chatMessages: { '1': 10 },
			createdAt: now,
			updatedAt: now,
			shouldHaveButtons: true,
			state: { keyboardMode: 'root', keyboardUntil: now - 1 },
		});
		await mappingStore.save({ prune: false });

		const telegramUi = createTelegramUi({
			callbackPrefix: 'opt_',
			t: s => s,
			iconByLevel: {},
			iconByKind: {},
		});

		const transport = {
			deleteMessage: () => Promise.resolve(null),
			editMessage: ({ chatId, messageId, html, replyMarkup }) => {
				edits.push({ chatId, messageId, html, replyMarkup });
				return Promise.resolve(null);
			},
			sendBroadcast: () => Promise.resolve({ raw: null, chatMessages: {} }),
			sendImageBroadcast: () => Promise.resolve({ raw: null, chatMessages: {} }),
		};

		const runtime = createMenuRuntime({
			log,
			mappingStore,
			telegramUi,
			transport,
			store: null,
			generateShortId: () => 'abc123',
			cfg: { disableNotificationUpToLevel: 0 },
			defaultDisableNotificationUpToLevel: 0,
			menuTimeoutMs: 30 * 1000,
			autoDeleteAfterMs: 46 * 60 * 60 * 1000,
		});

		await runtime.tick(now);

		expect(edits).to.have.length(1);
		expect(edits[0].replyMarkup).to.be.an('object');
		expect(edits[0].replyMarkup.inline_keyboard[0][0]).to.have.property('callback_data', 'opt_abc123:menu');

		const updated = mappingStore.getByRef('m1');
		expect(updated).to.exist;
		expect(updated.state).to.deep.include({ keyboardMode: 'entry' });
	});
});
