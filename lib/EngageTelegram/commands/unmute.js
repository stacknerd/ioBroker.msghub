'use strict';

/**
 * Create the `/unmute` command module used by EngageTelegram.
 *
 * This command affects the current chat only:
 * - It updates ChatRegistry (`muted=false`).
 * - Outgoing notifications start flowing again to this chat.
 *
 * @returns {{ name: string, match: Function, run: Function }} Command module.
 */
function createUnmuteCommand() {
	return Object.freeze({
		name: 'unmute',
		match: ({ command }) => command === 'unmute',
		run: async ({ chatId, telegramInstance, sendTo, i18n, chatRegistry }) => {
			const t = i18n?.t || ((s, ..._args) => s);
			const id = typeof chatId === 'string' || typeof chatId === 'number' ? String(chatId).trim() : '';
			if (!id) {
				return;
			}

			const existing = chatRegistry?.getChat?.(id);
			const type = existing?.type === 'group' ? 'group' : 'private';
			chatRegistry?.upsertChat?.(id, { type, muted: false });
			await chatRegistry?.save?.();

			const text = String(t('msghub.i18n.EngageTelegram.command.unmute.text')).trim();
			await sendTo(telegramInstance, 'send', { chatId: id, text });
		},
	});
}

module.exports = { createUnmuteCommand };
