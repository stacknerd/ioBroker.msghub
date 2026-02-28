'use strict';

/**
 * Create the `/mute` command module used by EngageTelegram.
 *
 * This command affects the current chat only:
 * - It updates ChatRegistry (`muted=true`).
 * - Future outgoing notifications skip muted chats.
 *
 * @returns {{ name: string, match: Function, run: Function }} Command module.
 */
function createMuteCommand() {
	return Object.freeze({
		name: 'mute',
		match: ({ command }) => command === 'mute',
		run: async ({ chatId, telegramInstance, sendTo, i18n, chatRegistry }) => {
			const t = i18n?.t || ((s, ..._args) => s);
			const id = typeof chatId === 'string' || typeof chatId === 'number' ? String(chatId).trim() : '';
			if (!id) {
				return;
			}

			// We treat missing entries as private by default.
			// Unregistered group chats are filtered earlier in EngageTelegram's inbound handler.
			const existing = chatRegistry?.getChat?.(id);
			const type = existing?.type === 'group' ? 'group' : 'private';
			chatRegistry?.upsertChat?.(id, { type, muted: true });
			await chatRegistry?.save?.();

			const text = String(t('msghub.i18n.EngageTelegram.command.mute.text')).trim();
			await sendTo(telegramInstance, 'send', { chatId: id, text });
		},
	});
}

module.exports = { createMuteCommand };
