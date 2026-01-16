'use strict';

const { expect } = require('chai');

const {
	createTelegramUi,
} = require('./TelegramUi');

describe('EngageTelegram TelegramUi', () => {
	const ui = createTelegramUi({
		callbackPrefix: 'opt_',
		t: s => s,
	});

	it('normalizes telegram text (CRLF and literal \\\\n)', () => {
		expect(ui.normalizeTelegramText('a\r\nb')).to.equal('a\nb');
		expect(ui.normalizeTelegramText('a\\nb')).to.equal('a\nb');
	});

	it('escapes html special chars', () => {
		expect(ui.escapeHtml('<&>"')).to.equal('&lt;&amp;&gt;&quot;');
	});

	it('renders notification text with escaped HTML', () => {
		const msg = { title: '<hi>', text: 'a&b', kind: 'task', level: 10 };
		const out = ui.renderNotificationText(msg);
		expect(out.html).to.contain('<b>');
		expect(out.html).to.contain('&lt;hi&gt;');
		expect(out.html).to.contain('a&amp;b');
	});

	it('detects actions loosely', () => {
		expect(ui.hasAnyActions({ actions: [] })).to.equal(false);
		expect(ui.hasAnyActions({ actions: [{}] })).to.equal(true);
	});

	it('filters menu actions based on options', () => {
		const msg = { actions: [{ type: 'ack', id: 'ack1' }] };
		expect(ui.hasAnyMenuActions(msg, { enableAck: true })).to.equal(true);
		expect(ui.hasAnyMenuActions(msg, { enableAck: false })).to.equal(false);
	});

	it('builds a single menu-entry keyboard', () => {
		const reply = ui.buildMenuEntryKeyboard('Abc123');
		expect(reply).to.have.property('inline_keyboard');
		expect(reply.inline_keyboard).to.have.length(1);
		expect(reply.inline_keyboard[0]).to.have.length(1);
		expect(reply.inline_keyboard[0][0]).to.have.property('callback_data', 'opt_Abc123:menu');
	});

	it('returns null for invalid shortId', () => {
		expect(ui.buildMenuEntryKeyboard('')).to.equal(null);
	});

	it('builds a root menu keyboard with act and nav callbacks', () => {
		const msg = {
			actions: [
				{ type: 'ack', id: 'ack1' },
				{ type: 'close', id: 'close1' },
				{ type: 'snooze', id: 'snooze1' },
			],
		};
		const reply = ui.buildMenuRootKeyboard({ shortId: 'Abc123', msg });
		expect(reply).to.exist;
		const callbacks = reply.inline_keyboard.flat().map(b => b.callback_data).filter(Boolean);
		expect(callbacks).to.include('opt_Abc123:act:ack1');
		expect(callbacks).to.include('opt_Abc123:act:close1');
		expect(callbacks).to.include('opt_Abc123:nav:snooze');
		expect(callbacks).to.include('opt_Abc123:nav:back');
	});

	it('builds snooze submenu with fixed durations and back navigation', () => {
		const msg = { actions: [{ type: 'snooze', id: 'snooze1' }] };
		const reply = ui.buildSnoozeKeyboard({ shortId: 'Abc123', msg });
		expect(reply).to.exist;
		const callbacks = reply.inline_keyboard.flat().map(b => b.callback_data).filter(Boolean);
		expect(callbacks.some(c => c === 'opt_Abc123:nav:root')).to.equal(true);
		expect(callbacks.some(c => c === 'opt_Abc123:nav:back')).to.equal(true);
		// One representative snooze callback.
		expect(callbacks.some(c => c === 'opt_Abc123:act:snooze1:3600000')).to.equal(true);
	});
});
