'use strict';

/**
 * Create the `/startbot` command module used by EngageTelegram.
 *
 * UX goal:
 * - Triggered from a group chat: start a registration request.
 * - The requesting user receives a private message with "Allow" / "Deny" buttons.
 * - Group chat receives a neutral status message ("waiting for confirmation").
 *
 * Security note:
 * - EngageTelegram ignores all inbound traffic from unregistered groups, *except* `/startbot`.
 * - The telegram adapter's authenticated users list (`communicate.users`) is used as source of truth
 *   for which private chats exist and how we can reach the requesting user.
 *
 * @returns {{ name: string, match: Function, run: Function }} Command module.
 */
function createStartBotCommand() {
	return Object.freeze({
		name: 'startbot',
		match: ({ command }) => command === 'startbot',
		run: async ({
			chatId,
			userLabel,
			telegramTransport,
			i18n,
			chatRegistry,
			resolvePrivateChatIdByLabel,
			generateRequestId,
			buildEnrollApprovalKeyboard,
		}) => {
			const t = i18n?.t || ((s, ..._args) => s);
			const groupChatId = typeof chatId === 'string' || typeof chatId === 'number' ? String(chatId).trim() : '';
			if (!groupChatId) {
				return;
			}

			const chatIdNum = Number(groupChatId);
			const looksLikeGroup = groupChatId.startsWith('-') || (Number.isFinite(chatIdNum) && chatIdNum < 0);
			if (!looksLikeGroup) {
				const text = String(t('msghub.i18n.EngageTelegram.command.startbot.privateOnly.text')).trim();
				await telegramTransport.sendToChat({ chatId: groupChatId, text });
				return;
			}

			const existingGroup = chatRegistry?.getChat?.(groupChatId);
			if (existingGroup?.type === 'group') {
				const text = String(t('msghub.i18n.EngageTelegram.command.startbot.alreadyRegistered.text')).trim();
				await telegramTransport.sendToChat({ chatId: groupChatId, text });
				return;
			}

			const requesterChatId = resolvePrivateChatIdByLabel?.(userLabel || '');
			if (!requesterChatId) {
				const text = String(t('msghub.i18n.EngageTelegram.command.startbot.cannotResolveUser.text')).trim();
				await telegramTransport.sendToChat({ chatId: groupChatId, text });
				return;
			}

			const requestId = generateRequestId?.();
			if (!requestId) {
				const text = String(t('msghub.i18n.EngageTelegram.command.startbot.failed.text')).trim();
				await telegramTransport.sendToChat({ chatId: groupChatId, text });
				return;
			}

			// 1) Persist the pending request first, so callbacks can be handled even if sending fails.
			chatRegistry?.upsertPending?.(requestId, {
				chatId: groupChatId,
				kind: 'enroll',
				requestedByChatId: requesterChatId,
				requestedByLabel: String(userLabel || '').trim(),
			});
			await chatRegistry?.save?.();

			// 2) Send approval prompt to the requesting user (private chat).
			const approvalText = String(t('msghub.i18n.EngageTelegram.command.startbot.approval.text')).trim();
			const replyMarkup = buildEnrollApprovalKeyboard?.(requestId);
			const approvalRes = await telegramTransport.sendToChat({
				chatId: requesterChatId,
				text: approvalText,
				replyMarkup,
			});
			const approvalMessageId = Number(approvalRes?.chatMessages?.[String(requesterChatId)]);

			// 3) Notify the group (neutral, no user names).
			const groupText = String(t('msghub.i18n.EngageTelegram.command.startbot.groupStarted.text')).trim();
			const groupRes = await telegramTransport.sendToChat({ chatId: groupChatId, text: groupText });
			const groupStatusMessageId = Number(groupRes?.chatMessages?.[String(groupChatId)]);

			// 4) Update pending record with message ids for later edit/delete.
			chatRegistry?.upsertPending?.(requestId, {
				chatId: groupChatId,
				kind: 'enroll',
				requestedByChatId: requesterChatId,
				requestedByLabel: String(userLabel || '').trim(),
				...(Number.isFinite(approvalMessageId) && approvalMessageId > 0 ? { approvalMessageId } : {}),
				...(Number.isFinite(groupStatusMessageId) && groupStatusMessageId > 0 ? { groupStatusMessageId } : {}),
			});
			await chatRegistry?.save?.();
		},
	});
}

module.exports = { createStartBotCommand };
