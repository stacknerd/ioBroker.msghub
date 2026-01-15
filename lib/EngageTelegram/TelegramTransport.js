/**
 * TelegramTransport (EngageTelegram)
 * =================================
 *
 * Small adapter wrapper around `sendTo(telegramInstance, 'send', ...)`.
 *
 * Responsibilities:
 * - Provide a stable API for sending/editing/deleting Telegram messages.
 * - Normalize send responses into `{ [chatId]: messageId }`.
 * - Keep all Telegram adapter payload quirks in one place.
 *
 * Non-responsibilities:
 * - No mapping persistence (MappingStore does that)
 * - No menu logic (TelegramUi does that)
 * - No business decisions (MenuRuntime/engine does that)
 */

'use strict';

/**
 * Create a Telegram transport wrapper.
 *
 * @param {object} deps Dependencies.
 * @param {object} deps.iobroker ioBroker adapter helpers (needs `sendTo`).
 * @param {object} deps.log Logger (`warn`, optional `debug`).
 * @param {string} deps.telegramInstance Target telegram adapter instance (e.g. `telegram.0`).
 * @returns {object} Transport API.
 */
function createTelegramTransport({ iobroker, log, telegramInstance }) {
	const instance = typeof telegramInstance === 'string' ? telegramInstance.trim() : '';

	const warn = msg => {
		if (typeof log?.warn === 'function') {
			log.warn(String(msg));
		}
	};

	/**
	 * Send a raw payload to the Telegram adapter.
	 *
	 * Note: we keep this "best effort" and do not throw on send failures.
	 *
	 * @param {object} payload Telegram adapter payload.
	 * @returns {Promise<any>} Adapter response or `null` on error.
	 */
	const send = payload => {
		if (!instance) {
			warn('telegramInstance is empty');
			return Promise.resolve(null);
		}
		return iobroker.sendTo(instance, 'send', payload).catch(e => {
			warn(`sendTo failed: ${e?.message || e}`);
			return null;
		});
	};

	/**
	 * Normalize different adapter response shapes into `{ [chatId]: messageId }`.
	 *
	 * Known patterns:
	 * - object: `{ "123": 42 }`
	 * - json string: `'{"123":42}'`
	 * - list of partial objects: `[{ "123": 42 }, { "999": 7 }]`
	 *
	 * @param {any} res Adapter response.
	 * @returns {object} Map-like object.
	 */
	const parseSendResponse = res => {
		if (res && typeof res === 'object' && !Array.isArray(res)) {
			return res;
		}
		if (typeof res === 'string') {
			try {
				const parsed = JSON.parse(res);
				return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
			} catch {
				return {};
			}
		}
		if (Array.isArray(res)) {
			const out = {};
			for (const entry of res) {
				const parsed = parseSendResponse(entry);
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					continue;
				}
				for (const [k, v] of Object.entries(parsed)) {
					out[k] = v;
				}
			}
			return out;
		}
		return {};
	};

	/**
	 * Send a message via telegram adapter "broadcast" (chatId='').
	 *
	 * @param {object} params Params.
	 * @param {string} params.html HTML text.
	 * @param {object|null} [params.replyMarkup] Telegram `reply_markup`.
	 * @param {boolean} [params.disableNotification] Telegram `disable_notification`.
	 * @returns {Promise<{ chatMessages: object, raw: any }>} Parsed chat-id -> message-id mapping and raw adapter response.
	 */
	const sendBroadcast = async ({ html, replyMarkup = null, disableNotification = false }) => {
		const payload = {
			chatId: '',
			text: String(html || '').trim(),
			parse_mode: 'HTML',
			disable_notification: !!disableNotification,
			...(replyMarkup ? { reply_markup: replyMarkup } : {}),
		};

		const raw = await send(payload);
		return { raw, chatMessages: parseSendResponse(raw) };
	};

	/**
	 * Send an image as a separate Telegram message (best effort).
	 *
	 * Note: This relies on the ioBroker Telegram adapter supporting photo messages via `photo`.
	 * If your adapter does not support this payload shape, image attachments will not work.
	 *
	 * @param {object} params Params.
	 * @param {string} params.image Attachment value (path or URL).
	 * @param {string} [params.caption] Optional caption (plain text).
	 * @param {boolean} [params.disableNotification] Telegram `disable_notification`.
	 * @returns {Promise<{ chatMessages: object, raw: any }>} Parsed chat-id -> message-id mapping and raw adapter response.
	 */
	const sendImageBroadcast = async ({ image, caption = '', disableNotification = true }) => {
		const payload = {
			chatId: '',
			photo: String(image || '').trim(),
			...(caption ? { caption: String(caption) } : {}),
			...(disableNotification ? { disable_notification: true } : {}),
		};

		const raw = await send(payload);
		return { raw, chatMessages: parseSendResponse(raw) };
	};

	/**
	 * Send a message to a specific chat (best effort).
	 *
	 * @param {object} params Params.
	 * @param {string|number} params.chatId Telegram chat id.
	 * @param {string} params.text Message text.
	 * @param {string} [params.parseMode] Telegram parse mode (e.g. `HTML`).
	 * @param {object|null} [params.replyMarkup] Telegram `reply_markup`.
	 * @param {boolean} [params.disableNotification] Telegram `disable_notification`.
	 * @returns {Promise<any>} Adapter response.
	 */
	const sendToChat = ({ chatId, text, parseMode = '', replyMarkup = null, disableNotification = false }) => {
		const safeChatId = typeof chatId === 'string' || typeof chatId === 'number' ? chatId : '';
		if (!safeChatId) {
			return Promise.resolve(null);
		}
		const safeParseMode = typeof parseMode === 'string' ? parseMode.trim() : '';

		return send({
			chatId: safeChatId,
			text: String(text || '').trim(),
			...(safeParseMode ? { parse_mode: safeParseMode } : {}),
			...(replyMarkup ? { reply_markup: replyMarkup } : {}),
			...(disableNotification ? { disable_notification: true } : {}),
		});
	};

	/**
	 * Edit an existing message text (best effort).
	 *
	 * @param {object} params Params.
	 * @param {string|number} params.chatId Telegram chat id.
	 * @param {number} params.messageId Telegram message id.
	 * @param {string} params.html HTML text.
	 * @param {object|null} [params.replyMarkup] Telegram `reply_markup` (inline keyboard).
	 * @returns {Promise<any>} Adapter response.
	 */
	const editMessage = ({ chatId, messageId, html, replyMarkup = null }) => {
		const safeChatId = typeof chatId === 'string' || typeof chatId === 'number' ? chatId : '';
		const safeMessageId = typeof messageId === 'number' ? messageId : Number(messageId);
		if (!safeChatId || !Number.isFinite(safeMessageId)) {
			return Promise.resolve(null);
		}

		return send({
			chatId: safeChatId,
			text: String(html || '').trim(),
			editMessageText: {
				options: { chat_id: safeChatId, message_id: safeMessageId, parse_mode: 'HTML' },
				reply_markup: replyMarkup || { inline_keyboard: [] },
			},
		});
	};

	/**
	 * Delete an existing message (best effort).
	 *
	 * @param {object} params Params.
	 * @param {string|number} params.chatId Telegram chat id.
	 * @param {number} params.messageId Telegram message id.
	 * @returns {Promise<any>} Adapter response.
	 */
	const deleteMessage = ({ chatId, messageId }) => {
		const safeChatId = typeof chatId === 'string' || typeof chatId === 'number' ? chatId : '';
		const safeMessageId = typeof messageId === 'number' ? messageId : Number(messageId);
		if (!safeChatId || !Number.isFinite(safeMessageId)) {
			return Promise.resolve(null);
		}

		return send({
			deleteMessage: {
				options: { chat_id: safeChatId, message_id: safeMessageId },
			},
		});
	};

	return Object.freeze({
		sendBroadcast,
		sendImageBroadcast,
		sendToChat,
		editMessage,
		deleteMessage,
		parseSendResponse,
	});
}

module.exports = { createTelegramTransport };
