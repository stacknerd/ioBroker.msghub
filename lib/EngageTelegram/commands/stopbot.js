'use strict';

/**
 * Create the `/stopbot` command module used by EngageTelegram.
 *
 * This is the inverse of `/startbot`:
 * - Triggered from a registered group chat: start a de-registration request.
 * - The requesting user receives a private message with "Allow" / "Deny" buttons.
 * - Group chat receives a neutral status message ("waiting for confirmation").
 *
 * The actual unregister step happens when the user clicks "Allow" in the private chat.
 *
 * @returns {{ name: string, match: Function, run: Function }} Command module.
 */
function createStopBotCommand() {
	return Object.freeze({
		name: 'stopbot',
		match: ({ command }) => command === 'stopbot',
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
				const text = String(t('msghub.i18n.EngageTelegram.command.stopbot.privateOnly.text')).trim();
				await telegramTransport.sendToChat({ chatId: groupChatId, text });
				return;
			}

			const existingGroup = chatRegistry?.getChat?.(groupChatId);
			if (!existingGroup || existingGroup.type !== 'group') {
				// This should only happen if the group is somehow calling us despite the group-gate.
				// Keep it neutral and do nothing else.
				const text = String(t('msghub.i18n.EngageTelegram.command.stopbot.notRegistered.text')).trim();
				await telegramTransport.sendToChat({ chatId: groupChatId, text });
				return;
			}

			const requesterChatId = resolvePrivateChatIdByLabel?.(userLabel || '');
			if (!requesterChatId) {
				const text = String(t('msghub.i18n.EngageTelegram.command.stopbot.cannotResolveUser.text')).trim();
				await telegramTransport.sendToChat({ chatId: groupChatId, text });
				return;
			}

			const requestId = generateRequestId?.();
			if (!requestId) {
				const text = String(t('msghub.i18n.EngageTelegram.command.stopbot.failed.text')).trim();
				await telegramTransport.sendToChat({ chatId: groupChatId, text });
				return;
			}

			// 1) Persist pending request.
			chatRegistry?.upsertPending?.(requestId, {
				chatId: groupChatId,
				kind: 'unenroll',
				requestedByChatId: requesterChatId,
				requestedByLabel: String(userLabel || '').trim(),
			});
			await chatRegistry?.save?.();

			// 2) Send approval prompt to the requesting user (private chat).
			const approvalText = String(t('msghub.i18n.EngageTelegram.command.stopbot.approval.text')).trim();
			const replyMarkup = buildEnrollApprovalKeyboard?.(requestId);
			const approvalRes = await telegramTransport.sendToChat({
				chatId: requesterChatId,
				text: approvalText,
				replyMarkup,
			});
			const approvalMessageId = Number(approvalRes?.chatMessages?.[String(requesterChatId)]);

			// 3) Notify the group (neutral, no user names).
			const groupText = String(t('msghub.i18n.EngageTelegram.command.stopbot.groupStarted.text')).trim();
			const groupRes = await telegramTransport.sendToChat({ chatId: groupChatId, text: groupText });
			const groupStatusMessageId = Number(groupRes?.chatMessages?.[String(groupChatId)]);

			// 4) Update pending record with message ids for later edit/delete.
			chatRegistry?.upsertPending?.(requestId, {
				chatId: groupChatId,
				kind: 'unenroll',
				requestedByChatId: requesterChatId,
				requestedByLabel: String(userLabel || '').trim(),
				...(Number.isFinite(approvalMessageId) && approvalMessageId > 0 ? { approvalMessageId } : {}),
				...(Number.isFinite(groupStatusMessageId) && groupStatusMessageId > 0 ? { groupStatusMessageId } : {}),
			});
			await chatRegistry?.save?.();
		},
	});
}

module.exports = { createStopBotCommand };
