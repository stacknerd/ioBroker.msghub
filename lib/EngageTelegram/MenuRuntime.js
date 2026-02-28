/**
 * MenuRuntime (EngageTelegram)
 * ===========================
 *
 * Coordinates the Telegram UX without mixing concerns:
 * - uses TelegramUi for rendering/keyboard building
 * - uses TelegramTransport for send/edit/delete
 * - uses MappingStore for persistence and future scheduling queries
 *
 * This is intentionally a small "runtime controller":
 * - it does not decide which MsgHub messages should be sent (filters/gates live in EngageTelegram)
 * - it does not implement heavy scheduling yet (but provides `tick()` as a stable entry point)
 */

'use strict';

/**
 * Create a runtime controller for Telegram menu UX.
 *
 * @param {object} deps Dependencies.
 * @param {object} deps.log Logger (`info`, `warn`, optional `debug`).
 * @param {object} deps.mappingStore MappingStore instance.
 * @param {object} deps.chatRegistry ChatRegistry instance (for recipient selection).
 * @param {object} deps.telegramUi TelegramUi instance.
 * @param {object} deps.transport TelegramTransport instance.
 * @param {object} deps.store MsgHub store (needs `getMessageByRef`).
 * @param {Function} deps.generateShortId Short-id generator.
 * @param {object} deps.cfg Minimal config.
 * @param {number} deps.cfg.disableNotificationUpToLevel Threshold for `disable_notification`.
 * @param {object} [deps.cfg.uiOpts] UI options for action filtering (passed through to TelegramUi).
 * @param {number} deps.defaultDisableNotificationUpToLevel Fallback if cfg is missing.
 * @param {number} [deps.menuTimeoutMs] Auto-close open menus after this time (default: 30s).
 * @param {number} [deps.autoDeleteAfterMs] Auto-delete mapped telegram messages after this age (default: 46h).
 * @param {number} [deps.refreshCycleMs] Desired refresh cycle duration (default: 15min).
 * @returns {object} Runtime API.
 */
function createMenuRuntime(deps) {
	const safeDeps = deps && typeof deps === 'object' ? deps : {};
	const {
		log,
		mappingStore,
		chatRegistry,
		telegramUi,
		transport,
		store,
		generateShortId,
		cfg,
		defaultDisableNotificationUpToLevel,
		menuTimeoutMs = 30 * 1000,
		autoDeleteAfterMs = 46 * 60 * 60 * 1000,
		refreshCycleMs = 15 * 60 * 1000,
	} = safeDeps;

	let refreshTimeoutHandle = null;
	let refreshCursor = 0;
	const uiOpts = cfg?.uiOpts || {};

	const debug = msg => {
		if (typeof log?.debug === 'function') {
			log.debug(String(msg));
		}
	};

	/**
	 * List the currently allowed recipient chats for outgoing notifications.
	 *
	 * Note:
	 * - This intentionally uses ChatRegistry as the source of truth.
	 * - `muted` is respected here (Etappe 3 adds `/mute` & `/unmute`).
	 *
	 * @returns {{ chatId: string, type: string, muted: boolean }[]} Recipient chat entries.
	 */
	const listRecipientChats = () => {
		if (!chatRegistry || typeof chatRegistry.listChats !== 'function') {
			return [];
		}
		return chatRegistry.listChats(c => c && c.muted !== true);
	};

	/**
	 * Return the record key used for deletion.
	 *
	 * @param {object} record Mapping record.
	 * @returns {{ kind: 'ref'|'uiId', key: string }|null} Record key or null.
	 */
	const getRecordKey = record => {
		const ref = typeof record?.ref === 'string' ? record.ref.trim() : '';
		if (ref) {
			return { kind: 'ref', key: ref };
		}
		const uiId = typeof record?.uiId === 'string' ? record.uiId.trim() : '';
		if (uiId) {
			return { kind: 'uiId', key: uiId };
		}
		return null;
	};

	/**
	 * Remove a record from the mapping store by its key.
	 *
	 * @param {object} record Mapping record.
	 * @returns {boolean} True if removed.
	 */
	const removeRecord = record => {
		const k = getRecordKey(record);
		if (!k) {
			return false;
		}
		return k.kind === 'ref' ? mappingStore.removeByRef(k.key) : mappingStore.removeByUiId(k.key);
	};

	/**
	 * Delete all mapped Telegram messages for a record.
	 *
	 * This is best-effort: failures are ignored and only logged by the transport.
	 *
	 * @param {object} record MappingStore record.
	 * @returns {Promise<void>}
	 */
	const deleteMappedTelegramMessages = async record => {
		const chatMessages = record?.chatMessages && typeof record.chatMessages === 'object' ? record.chatMessages : {};
		const tasks = Object.entries(chatMessages).map(([chatId, messageId]) =>
			transport.deleteMessage({ chatId, messageId: Number(messageId) }),
		);
		await Promise.allSettled(tasks);
	};

	/**
	 * Delete all mapped image messages for a record.
	 *
	 * @param {object} record MappingStore record.
	 * @returns {Promise<void>}
	 */
	const deleteMappedImageMessages = async record => {
		const imagesByValue =
			record?.imagesByValue && typeof record.imagesByValue === 'object' ? record.imagesByValue : {};
		const tasks = [];
		for (const entry of Object.values(imagesByValue)) {
			const chatMessages =
				entry?.chatMessages && typeof entry.chatMessages === 'object' ? entry.chatMessages : {};
			for (const [chatId, messageId] of Object.entries(chatMessages)) {
				tasks.push(transport.deleteMessage({ chatId, messageId: Number(messageId) }));
			}
		}
		await Promise.allSettled(tasks);
	};

	/**
	 * Delete all mapped Telegram messages for a record (main text + images).
	 *
	 * @param {object} record MappingStore record.
	 * @returns {Promise<void>}
	 */
	const deleteAllTelegramMessagesForRecord = async record => {
		await Promise.allSettled([deleteMappedTelegramMessages(record), deleteMappedImageMessages(record)]);
	};

	/**
	 * Extract image attachment values from a message.
	 *
	 * Identity rule: `attachment.value` is stable and used as key.
	 *
	 * @param {object} msg MsgHub message.
	 * @returns {string[]} Values (deduped, stable order).
	 */
	const getImageAttachmentValues = msg => {
		const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
		const out = [];
		for (const a of attachments) {
			if (!a || typeof a !== 'object') {
				continue;
			}
			if (a.type !== 'image') {
				continue;
			}
			const v = typeof a.value === 'string' ? a.value.trim() : '';
			if (!v) {
				continue;
			}
			if (!out.includes(v)) {
				out.push(v);
			}
		}
		return out;
	};

	/**
	 * Send missing image attachments for a record and persist them in `imagesByValue`.
	 *
	 * @param {object} msg MsgHub message.
	 * @param {object} existing Existing ref record.
	 * @param {number} nowMs Epoch ms.
	 * @returns {Promise<void>}
	 */
	const sendNewImagesForRecord = async (msg, existing, nowMs = Date.now()) => {
		if (!existing) {
			return;
		}

		const current =
			existing.imagesByValue && typeof existing.imagesByValue === 'object' ? existing.imagesByValue : {};
		const imagesByValue = { ...current };
		const values = getImageAttachmentValues(msg);
		if (values.length === 0) {
			return;
		}

		const caption = `📷 ${String(msg?.title || '').trim()}`.trim();
		let changed = false;

		// Only send attachments to chats that have the main message.
		const recipientChatIds =
			existing?.chatMessages && typeof existing.chatMessages === 'object'
				? Object.keys(existing.chatMessages)
				: [];

		if (recipientChatIds.length === 0) {
			return;
		}

		for (const value of values) {
			if (imagesByValue[value]) {
				continue;
			}

			const chatMessages = {};
			const tasks = recipientChatIds.map(async chatId => {
				const res = await transport.sendImageToChat({
					chatId,
					image: value,
					caption,
					disableNotification: true,
				});
				const mapping = res?.chatMessages && typeof res.chatMessages === 'object' ? res.chatMessages : {};
				for (const [k, v] of Object.entries(mapping)) {
					chatMessages[k] = v;
				}
			});
			await Promise.allSettled(tasks);

			if (Object.keys(chatMessages).length === 0) {
				continue;
			}
			imagesByValue[value] = Object.freeze({ chatMessages, createdAt: nowMs });
			changed = true;
		}

		if (!changed) {
			return;
		}

		upsertFromExisting(existing, { imagesByValue, updatedAt: nowMs });
		await mappingStore.save();
		debug(
			`images: sent new images ref='${String(existing?.ref || '')}' count=${Object.keys(imagesByValue).length}`,
		);
	};

	/**
	 * Edit all mapped Telegram messages for a record.
	 *
	 * @param {object} record MappingStore record.
	 * @param {string} html HTML text to set.
	 * @param {object|null} replyMarkup Telegram reply_markup or null to clear.
	 * @returns {Promise<void>}
	 */
	const editMappedTelegramMessages = async (record, html, replyMarkup) => {
		const chatMessages = record?.chatMessages && typeof record.chatMessages === 'object' ? record.chatMessages : {};
		const tasks = Object.entries(chatMessages).map(([chatId, messageId]) =>
			transport.editMessage({ chatId, messageId: Number(messageId), html, replyMarkup }),
		);
		await Promise.allSettled(tasks);
	};

	/**
	 * Edit exactly one Telegram message in a specific chat.
	 *
	 * Why this exists:
	 * - A message (ref) can be delivered to multiple recipient chats.
	 * - Menu interactions should apply only to the triggering chat, not to all mapped messages.
	 *
	 * Notes:
	 * - We prefer the `messageId` provided by the inbound callback context (most reliable).
	 * - If not provided, we fall back to MappingStore's `chatMessages[chatId]`.
	 *
	 * @param {object} params Params.
	 * @param {object} params.record MappingStore record.
	 * @param {string|number} params.chatId Telegram chat id.
	 * @param {number} [params.messageId] Telegram message id.
	 * @param {string} params.html HTML text to set.
	 * @param {object|null} params.replyMarkup Telegram reply_markup or null to clear.
	 * @returns {Promise<void>}
	 */
	const editTelegramMessageInChat = async ({ record, chatId, messageId, html, replyMarkup }) => {
		const id = typeof chatId === 'string' || typeof chatId === 'number' ? String(chatId).trim() : '';
		if (!id) {
			return;
		}
		const msgId = Number.isFinite(Number(messageId))
			? Number(messageId)
			: Number(record?.chatMessages && typeof record.chatMessages === 'object' ? record.chatMessages[id] : NaN);
		if (!Number.isFinite(msgId) || msgId <= 0) {
			return;
		}
		await transport.editMessage({ chatId: id, messageId: msgId, html, replyMarkup });
	};

	/**
	 * Upsert while preserving existing record fields.
	 *
	 * MappingStore.upsert() replaces the record, therefore we always start from `existing`.
	 *
	 * @param {object} existing Existing record (required).
	 * @param {object} patch Patch fields to overwrite.
	 */
	const upsertFromExisting = (existing, patch) => {
		const key = getRecordKey(existing);
		if (!key) {
			return;
		}
		mappingStore.upsert({
			...(key.kind === 'ref' ? { ref: key.key } : { uiId: key.key }),
			purpose: existing.purpose,
			shortId: existing.shortId,
			textHtml: existing.textHtml,
			textPlain: existing.textPlain,
			chatMessages: existing.chatMessages,
			imagesByValue: existing.imagesByValue,
			createdAt: existing.createdAt,
			updatedAt: existing.updatedAt,
			shouldHaveButtons: existing.shouldHaveButtons,
			state: existing.state,
			...(patch || {}),
		});
	};

	/**
	 * Compute Telegram `disable_notification` based on message level and configured threshold.
	 *
	 * @param {object} msg MsgHub message.
	 * @returns {boolean} True if notifications should be silent.
	 */
	const computeDisableNotification = msg => {
		const level = typeof msg?.level === 'number' ? msg.level : Number(msg?.level);
		const silentUpTo = Number.isFinite(cfg?.disableNotificationUpToLevel)
			? cfg.disableNotificationUpToLevel
			: defaultDisableNotificationUpToLevel;
		return Number.isFinite(level) ? level <= silentUpTo : false;
	};

	/**
	 * Handle an outbound `due` notification (already filter/gate-checked).
	 *
	 * Responsibilities:
	 * - render text
	 * - decide whether to include the menu entry button
	 * - send broadcast via transport
	 * - persist mapping record (createdAt, chatMessages, shortId)
	 *
	 * @param {object} msg MsgHub message.
	 * @param {Function} generateShortId Short-id generator (should avoid collisions via MappingStore index).
	 * @returns {Promise<void>}
	 */
	const onDue = async (msg, generateShortId) => {
		const ref = typeof msg?.ref === 'string' ? msg.ref.trim() : '';
		if (!ref) {
			return;
		}

		// If there is an existing notification for this ref, delete it first (always).
		const existing = mappingStore.getByRef(ref);
		if (existing) {
			await deleteAllTelegramMessagesForRecord(existing);
			mappingStore.removeByRef(ref);
			await mappingStore.save();
			debug(`due: deleted previous telegram messages ref='${ref}'`);
		}

		const createdAt = Date.now();
		const text = telegramUi.renderNotificationText(msg);

		// The entry button only appears if at least one *menu-eligible* action exists.
		const shortId = telegramUi.hasAnyMenuActions(msg, uiOpts) ? String(generateShortId?.() || '') : '';
		const replyMarkup = shortId ? telegramUi.buildMenuEntryKeyboard(shortId) : null;

		const disableNotification = computeDisableNotification(msg);
		const recipientChats = listRecipientChats();
		const chatMessages = {};
		for (const chat of recipientChats) {
			const chatId = typeof chat?.chatId === 'string' ? chat.chatId.trim() : '';
			if (!chatId) {
				continue;
			}
			const res = await transport.sendToChat({
				chatId,
				text: text.html,
				parseMode: 'HTML',
				replyMarkup,
				disableNotification,
			});
			const mapping = res?.chatMessages && typeof res.chatMessages === 'object' ? res.chatMessages : {};
			for (const [k, v] of Object.entries(mapping)) {
				chatMessages[k] = v;
			}
		}

		if (!chatMessages || Object.keys(chatMessages).length === 0) {
			debug(`due: sent ref='${ref}' shortId='${shortId}' mapping=skipped (no recipients or no mapping)`);
			return;
		}

		mappingStore.upsert({
			purpose: 'due',
			ref,
			shortId,
			textHtml: text.html,
			textPlain: text.plain,
			chatMessages,
			imagesByValue: {},
			createdAt,
			updatedAt: createdAt,
			shouldHaveButtons: !!shortId,
			state: Object.freeze({ keyboardMode: 'entry' }),
		});

		await mappingStore.save();
		await sendNewImagesForRecord(msg, mappingStore.getByRef(ref), createdAt);
		debug(`due: sent ref='${ref}' shortId='${shortId}' chats=${Object.keys(chatMessages).length} mapping=saved`);
	};

	/**
	 * Sync an existing Telegram notification for a ref.
	 *
	 * Triggered by `updated`/`recreated`/`recovered` events:
	 * - update text
	 * - add/remove menu entry button depending on current actions/options
	 *
	 * @param {object} msg MsgHub message.
	 * @param {Function} generateShortId Short-id generator (needed when menu becomes available).
	 * @returns {Promise<void>}
	 */
	const onSync = async (msg, generateShortId) => {
		const ref = typeof msg?.ref === 'string' ? msg.ref.trim() : '';
		if (!ref) {
			return;
		}

		const existing = mappingStore.getByRef(ref);
		if (!existing) {
			return;
		}

		const updatedAt = Date.now();
		const text = telegramUi.renderNotificationText(msg);

		// Menu entry may appear/disappear when actions change.
		const shouldHaveMenu = telegramUi.hasAnyMenuActions(msg, uiOpts);
		const hadMenu = typeof existing.shortId === 'string' && existing.shortId.trim();
		const shortId = shouldHaveMenu ? (hadMenu ? existing.shortId : String(generateShortId?.() || '')) : '';
		const mode = existing?.state?.keyboardMode;
		const replyMarkup =
			shortId && mode === 'root'
				? telegramUi.buildMenuRootKeyboard({ shortId, msg, opts: uiOpts })
				: shortId && mode === 'snooze'
					? telegramUi.buildSnoozeKeyboard({ shortId, msg, opts: uiOpts })
					: shortId
						? telegramUi.buildMenuEntryKeyboard(shortId)
						: null;

		const currentHtml = typeof existing.textHtml === 'string' ? existing.textHtml : '';
		const textChanged = currentHtml !== text.html;
		const menuChanged = Boolean(hadMenu) !== Boolean(shortId);

		if (textChanged || menuChanged) {
			await editMappedTelegramMessages(existing, text.html, replyMarkup);
			upsertFromExisting(existing, {
				shortId,
				textHtml: text.html,
				textPlain: text.plain,
				updatedAt,
				shouldHaveButtons: !!shortId,
			});
			await mappingStore.save();
		}

		// Images are handled independently from text updates.
		await sendNewImagesForRecord(msg, mappingStore.getByRef(ref), updatedAt);
		debug(`sync: updated telegram messages ref='${ref}' menu=${String(!!shortId)}`);
	};

	/**
	 * Delete an existing Telegram notification for a ref.
	 *
	 * Triggered by `deleted`/`expired` events (always delete; no options).
	 *
	 * @param {string} ref MsgHub ref.
	 * @returns {Promise<void>}
	 */
	const onDelete = async ref => {
		const key = typeof ref === 'string' ? ref.trim() : '';
		if (!key) {
			return;
		}

		const existing = mappingStore.getByRef(key);
		if (!existing) {
			return;
		}

		await deleteAllTelegramMessagesForRecord(existing);
		mappingStore.removeByRef(key);
		await mappingStore.save();
		debug(`delete: removed telegram messages ref='${key}'`);
	};

	/**
	 * Show the entry keyboard (collapsed state).
	 *
	 * @param {string} ref MsgHub ref.
	 * @param {number} [nowMs] Epoch ms.
	 * @returns {Promise<void>}
	 */
	const showMenuEntry = async (ref, nowMs = Date.now()) => {
		const key = typeof ref === 'string' ? ref.trim() : '';
		if (!key) {
			return;
		}
		const existing = mappingStore.getByRef(key);
		if (!existing) {
			return;
		}
		const shortId = typeof existing.shortId === 'string' ? existing.shortId.trim() : '';
		const replyMarkup = shortId ? telegramUi.buildMenuEntryKeyboard(shortId) : null;
		await editMappedTelegramMessages(existing, existing.textHtml || '', replyMarkup);
		upsertFromExisting(existing, { updatedAt: nowMs, state: Object.freeze({ keyboardMode: 'entry' }) });
		await mappingStore.save();
	};

	/**
	 * Show the entry keyboard (collapsed state) in exactly one chat.
	 *
	 * This is used for per-chat menu UX: only the triggering chat should change.
	 *
	 * @param {string} ref MsgHub ref.
	 * @param {string|number} chatId Telegram chat id.
	 * @param {number} messageId Telegram message id.
	 * @returns {Promise<void>}
	 */
	const showMenuEntryInChat = async (ref, chatId, messageId) => {
		const key = typeof ref === 'string' ? ref.trim() : '';
		if (!key) {
			return;
		}
		const existing = mappingStore.getByRef(key);
		if (!existing) {
			return;
		}
		const shortId = typeof existing.shortId === 'string' ? existing.shortId.trim() : '';
		const replyMarkup = shortId ? telegramUi.buildMenuEntryKeyboard(shortId) : null;
		await editTelegramMessageInChat({
			record: existing,
			chatId,
			messageId,
			html: existing.textHtml || '',
			replyMarkup,
		});
	};

	/**
	 * Show the root menu keyboard.
	 *
	 * @param {object} msg MsgHub message (used to render the action ids into callbacks).
	 * @param {number} [nowMs] Epoch ms.
	 * @returns {Promise<void>}
	 */
	const showMenuRoot = async (msg, nowMs = Date.now()) => {
		const ref = typeof msg?.ref === 'string' ? msg.ref.trim() : '';
		if (!ref) {
			return;
		}
		const existing = mappingStore.getByRef(ref);
		if (!existing) {
			return;
		}
		const shortId = typeof existing.shortId === 'string' ? existing.shortId.trim() : '';
		if (!shortId) {
			return;
		}
		const replyMarkup = telegramUi.buildMenuRootKeyboard({ shortId, msg, opts: uiOpts });
		if (!replyMarkup) {
			return;
		}
		await editMappedTelegramMessages(existing, existing.textHtml || '', replyMarkup);
		upsertFromExisting(existing, {
			updatedAt: nowMs,
			state: Object.freeze({ keyboardMode: 'root', keyboardUntil: nowMs + Number(menuTimeoutMs) }),
		});
		await mappingStore.save();
	};

	/**
	 * Show the root menu keyboard in exactly one chat.
	 *
	 * Important:
	 * - This intentionally does *not* persist `state.keyboardMode` in MappingStore.
	 * - Persisting a global keyboard state would make menu actions show up in all chats again
	 *   (because refresh/tick operate on the record and would edit all mapped messages).
	 *
	 * Trade-off:
	 * - The per-chat menu mode is not persisted. A later `sync`/refresh may collapse the menu.
	 *
	 * @param {object} msg MsgHub message.
	 * @param {string|number} chatId Telegram chat id.
	 * @param {number} messageId Telegram message id.
	 * @returns {Promise<void>}
	 */
	const showMenuRootInChat = async (msg, chatId, messageId) => {
		const ref = typeof msg?.ref === 'string' ? msg.ref.trim() : '';
		if (!ref) {
			return;
		}
		const existing = mappingStore.getByRef(ref);
		if (!existing) {
			return;
		}
		const shortId = typeof existing.shortId === 'string' ? existing.shortId.trim() : '';
		if (!shortId) {
			return;
		}
		const replyMarkup = telegramUi.buildMenuRootKeyboard({ shortId, msg, opts: uiOpts });
		if (!replyMarkup) {
			return;
		}
		await editTelegramMessageInChat({
			record: existing,
			chatId,
			messageId,
			html: existing.textHtml || '',
			replyMarkup,
		});
	};

	/**
	 * Show the snooze submenu keyboard.
	 *
	 * @param {object} msg MsgHub message (used to find snooze action id).
	 * @param {number} [nowMs] Epoch ms.
	 * @returns {Promise<void>}
	 */
	const showSnoozeMenu = async (msg, nowMs = Date.now()) => {
		const ref = typeof msg?.ref === 'string' ? msg.ref.trim() : '';
		if (!ref) {
			return;
		}
		const existing = mappingStore.getByRef(ref);
		if (!existing) {
			return;
		}
		const shortId = typeof existing.shortId === 'string' ? existing.shortId.trim() : '';
		if (!shortId) {
			return;
		}
		const replyMarkup = telegramUi.buildSnoozeKeyboard({ shortId, msg, opts: uiOpts });
		if (!replyMarkup) {
			return;
		}
		await editMappedTelegramMessages(existing, existing.textHtml || '', replyMarkup);
		upsertFromExisting(existing, {
			updatedAt: nowMs,
			state: Object.freeze({ keyboardMode: 'snooze', keyboardUntil: nowMs + Number(menuTimeoutMs) }),
		});
		await mappingStore.save();
	};

	/**
	 * Show the snooze submenu keyboard in exactly one chat.
	 *
	 * See `showMenuRootInChat()` for details about why we avoid persisting the keyboard mode globally.
	 *
	 * @param {object} msg MsgHub message.
	 * @param {string|number} chatId Telegram chat id.
	 * @param {number} messageId Telegram message id.
	 * @returns {Promise<void>}
	 */
	const showSnoozeMenuInChat = async (msg, chatId, messageId) => {
		const ref = typeof msg?.ref === 'string' ? msg.ref.trim() : '';
		if (!ref) {
			return;
		}
		const existing = mappingStore.getByRef(ref);
		if (!existing) {
			return;
		}
		const shortId = typeof existing.shortId === 'string' ? existing.shortId.trim() : '';
		if (!shortId) {
			return;
		}
		const replyMarkup = telegramUi.buildSnoozeKeyboard({ shortId, msg, opts: uiOpts });
		if (!replyMarkup) {
			return;
		}
		await editTelegramMessageInChat({
			record: existing,
			chatId,
			messageId,
			html: existing.textHtml || '',
			replyMarkup,
		});
	};

	/**
	 * Refresh the rendered text for one mapped record (worker step).
	 *
	 * Strategy:
	 * - Only purpose='due'
	 * - Use `store.getMessageByRef(ref, 'all')` to get the rendered view (metrics integrated).
	 * - Only edit Telegram when the resulting rendered HTML differs from the mapped one
	 *   (or when menu eligibility changed and buttons need to be added/removed).
	 *
	 * @returns {Promise<void>}
	 */
	const refreshOne = async () => {
		if (!store || typeof store.getMessageByRef !== 'function') {
			return;
		}

		const records = mappingStore
			.query(r => r && r.purpose === 'due' && typeof r.ref === 'string' && r.ref.trim())
			.sort((a, b) => String(a.ref).localeCompare(String(b.ref)));

		const count = records.length;
		if (count <= 0) {
			return;
		}

		const idx = refreshCursor % count;
		refreshCursor = (refreshCursor + 1) % count;

		const record = records[idx];
		const ref = String(record.ref).trim();

		// If the message disappeared from the store, clean up Telegram and mapping.
		const msg = store.getMessageByRef(ref, 'all');
		if (!msg) {
			await onDelete(ref);
			return;
		}

		// Compute desired text and menu eligibility.
		const desired = telegramUi.renderNotificationText(msg);
		const desiredHtml = desired.html;

		const currentHtml = typeof record.textHtml === 'string' ? record.textHtml : '';
		const menuDesired = telegramUi.hasAnyMenuActions(msg, uiOpts);
		const menuCurrent = typeof record.shortId === 'string' && record.shortId.trim();
		const images = getImageAttachmentValues(msg);
		const existingImages =
			record?.imagesByValue && typeof record.imagesByValue === 'object' ? Object.keys(record.imagesByValue) : [];
		const hasNewImages = images.some(v => !existingImages.includes(v));

		if (currentHtml === desiredHtml && Boolean(menuCurrent) === Boolean(menuDesired) && !hasNewImages) {
			return;
		}

		await onSync(msg, generateShortId);
	};

	/**
	 * Schedule the next refresh step based on the number of mapped records.
	 *
	 * Target:
	 * - complete one full pass in ~15 minutes
	 * - max 1 update per (15min / N)
	 *
	 */
	const scheduleNextRefresh = () => {
		if (refreshTimeoutHandle) {
			return;
		}

		const count = mappingStore.query(
			r => r && r.purpose === 'due' && typeof r.ref === 'string' && r.ref.trim(),
		).length;
		const base = Number(refreshCycleMs);
		const intervalMs = count > 0 ? Math.max(1000, Math.floor(base / count)) : Math.max(60 * 1000, base);

		refreshTimeoutHandle = setTimeout(async () => {
			refreshTimeoutHandle = null;
			try {
				await refreshOne();
			} catch (e) {
				log?.warn?.(`refresh failed: ${e?.message || e}`);
			} finally {
				scheduleNextRefresh();
			}
		}, intervalMs);

		if (refreshTimeoutHandle && typeof refreshTimeoutHandle.unref === 'function') {
			refreshTimeoutHandle.unref();
		}
	};

	/**
	 * Start the internal refresh worker loop.
	 */
	const start = () => {
		scheduleNextRefresh();
	};

	/**
	 * Stop the internal refresh worker loop.
	 */
	const stop = () => {
		if (refreshTimeoutHandle) {
			clearTimeout(refreshTimeoutHandle);
		}
		refreshTimeoutHandle = null;
	};

	/**
	 * Periodic housekeeping hook.
	 *
	 * Responsibilities:
	 * - Close open menus after timeout (30s).
	 * - Auto-delete mapped telegram messages after 46h.
	 *
	 * @param {number} nowMs Epoch ms.
	 */
	const tick = async (nowMs = Date.now()) => {
		const now = Number.isFinite(nowMs) ? nowMs : Date.now();

		// 1) Auto-delete: everything the mapping store knows, regardless of purpose.
		const cutoff = now - Number(autoDeleteAfterMs);
		const toDelete = mappingStore.query(
			r => Number.isFinite(Number(r?.createdAt)) && Number(r.createdAt) <= cutoff,
		);
		for (const record of toDelete) {
			await deleteAllTelegramMessagesForRecord(record);
			removeRecord(record);
		}
		if (toDelete.length > 0) {
			await mappingStore.save();
			debug(`tick: auto-deleted records=${toDelete.length} cutoffHours=46`);
		}

		// 2) Auto-close menus: revert any open menus to entry after timeout.
		const toClose = mappingStore.query(r => {
			const mode = r?.state?.keyboardMode;
			const until = Number(r?.state?.keyboardUntil);
			return mode && mode !== 'entry' && Number.isFinite(until) && until <= now;
		});
		for (const record of toClose) {
			const ref = typeof record?.ref === 'string' ? record.ref.trim() : '';
			if (!ref) {
				continue;
			}
			// Best-effort: if the record has no shortId, we can only clear reply_markup.
			await showMenuEntry(ref, now);
		}
	};

	return Object.freeze({
		start,
		stop,
		tick,
		onDue,
		onSync,
		onDelete,
		showMenuEntry,
		showMenuEntryInChat,
		showMenuRoot,
		showMenuRootInChat,
		showSnoozeMenu,
		showSnoozeMenuInChat,
	});
}

module.exports = { createMenuRuntime };
