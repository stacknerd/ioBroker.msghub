'use strict';

/**
 * Create the `/start` command module used by EngageTelegram.
 *
 * @returns {{ name: string, match: Function, run: Function }} Command module.
 */
function createStartCommand() {
	return Object.freeze({
		name: 'start',
		match: ({ command }) => command === 'start',
		run: async ({ chatId, telegramInstance, sendTo, i18n }) => {
			const t = i18n?.t || ((s, ..._args) => s);
			const text = String(t('Hi! Try /start to see this message again.')).trim();
			await sendTo(telegramInstance, 'send', { chatId, text });
		},
	});
}

module.exports = { createStartCommand };
