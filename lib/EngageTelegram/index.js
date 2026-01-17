/**
 * EngageTelegram
 * =============
 *
 * MsgHub engage plugin for Telegram:
 * - Outgoing: sends notifications to Telegram via `sendTo()` (Pushover-like).
 * - Incoming: handles simple chat commands.
 *
 * Docs: ../../docs/plugins/EngageTelegram.md
 */

'use strict';

const { manifest } = require('./manifest');
const { ensureCtxAvailability } = require('../IoPluginGuards');
const { createStartCommand } = require('./commands/start');
const { createMuteCommand } = require('./commands/mute');
const { createUnmuteCommand } = require('./commands/unmute');
const { createConfigCommand } = require('./commands/config');
const { createStartBotCommand } = require('./commands/startbot');
const { createStopBotCommand } = require('./commands/stopbot');
const { createMappingStore } = require('./MappingStore');
const { createChatRegistry } = require('./ChatRegistry');
const { createTelegramUi } = require('./TelegramUi');
const { createTelegramTransport } = require('./TelegramTransport');
const { createMenuRuntime } = require('./MenuRuntime');

/**
 * Engage plugin factory.
 *
 * @param {object} [options] Plugin options (from ioBroker `native`), plus injected runtime helpers.
 * @returns {{ start?: Function, stop?: Function, onNotifications: Function, onStateChange?: Function }} Engage handler.
 */
function EngageTelegram(options = {}) {
	const CALLBACK_PREFIX = 'opt_';
	const COMMANDS_PREFIX = '/';
	const DEFAULT_DISABLE_NOTIFICATION_UP_TO_LEVEL = 10;
	const CALLBACK_LOCK_MS = 5 * 1000;

	const toCsvList = csv =>
		String(csv || '')
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);

	const parseRequest = raw => {
		const s = typeof raw === 'string' ? raw : '';
		if (!s.startsWith('[')) {
			return null;
		}
		const closeBracket = s.indexOf(']');
		if (closeBracket < 0) {
			return null;
		}
		return { userLabel: s.slice(1, closeBracket).trim(), payload: s.slice(closeBracket + 1) };
	};

	let initialized = false;
	let started = false;

	let log = null;
	let i18n = null;
	let iobroker = null;
	let templates = null;
	let constants = null;
	let configApi = null;
	let store = null;
	let action = null;
	let o = null;
	let cfg = null;
	let mappingStore = null;
	let chatRegistry = null;
	let telegramUi = null;
	let telegramTransport = null;
	let menuRuntime = null;
	let gateHandle = null;
	let gateOpen = null;

	let baseFullId = '';
	let engineIntervalHandle = null;

	const commands = [
		createStartCommand(),
		createMuteCommand(),
		createUnmuteCommand(),
		createConfigCommand(),
		createStartBotCommand(),
		createStopBotCommand(),
	];
	const callbackLocks = new Map();

	const t = (key, ...args) => {
		if (!i18n || typeof i18n.t !== 'function') {
			return String(key);
		}
		return i18n.t(key, ...args);
	};

	const ensureInitialized = ctx => {
		if (initialized) {
			return;
		}

		ensureCtxAvailability('EngageTelegram', ctx, {
			plainObject: [
				'api',
				'meta',
				'meta.options',
				'meta.gates',
				'api.log',
				'api.constants',
				'api.constants.notfication',
				'api.constants.notfication.events',
				'api.constants.lifecycle',
				'api.iobroker',
				'api.iobroker.subscribe',
				'api.iobroker.objects',
				'api.iobroker.states',
				'api.templates',
				'api.store',
				'api.action',
			],
			fn: [
				'api.log.info',
				'api.log.warn',
				'api.iobroker.sendTo',
				'api.iobroker.states.getForeignState',
				'api.iobroker.states.setState',
				'api.iobroker.objects.setObjectNotExists',
				'api.iobroker.subscribe.subscribeForeignStates',
				'api.iobroker.subscribe.unsubscribeForeignStates',
				'api.constants.lifecycle.isQuasiDeletedState',
				'api.constants.lifecycle.isQuasiOpenState',
				'api.templates.renderStates',
				'api.store.getMessageByRef',
				'api.action.execute',
				'meta.gates.register',
			],
		});

		log = ctx.api.log;
		i18n = ctx.api.i18n || null;
		iobroker = ctx.api.iobroker;
		templates = ctx.api.templates;
		constants = ctx.api.constants || null;
		configApi = ctx.api.config || null;
		store = ctx.api.store;
		action = ctx.api.action;
		o = ctx.meta.options;

		baseFullId = typeof options.pluginBaseObjectId === 'string' ? options.pluginBaseObjectId.trim() : '';
		if (!baseFullId) {
			throw new Error('options.pluginBaseObjectId is required');
		}
		mappingStore = createMappingStore({ iobroker, log, baseFullId });
		chatRegistry = createChatRegistry({ iobroker, log, baseFullId });

		const kinds = new Set(toCsvList(o.resolveString('kindsCsv', options.kindsCsv)).map(s => s.toLowerCase()));
		const audienceTagsAny = toCsvList(o.resolveString('audienceTagsAnyCsv', options.audienceTagsAnyCsv));
		const uiOpts = Object.freeze({
			enableAck: o.resolveBool('enableAck', options.enableAck ?? true),
			enableClose: o.resolveBool('enableClose', options.enableClose ?? true),
			enableSnooze: o.resolveBool('enableSnooze', options.enableSnooze ?? true),
			enableOpen: o.resolveBool('enableOpen', options.enableOpen ?? true),
			enableLink: o.resolveBool('enableLink', options.enableLink ?? true),
		});

		cfg = Object.freeze({
			telegramInstance: o.resolveString('telegramInstance', options.telegramInstance),
			kinds,
			levelMin: o.resolveInt('levelMin', options.levelMin),
			levelMax: o.resolveInt('levelMax', options.levelMax),
			audienceTagsAny,
			disableNotificationUpToLevel: o.resolveInt(
				'disableNotificationUpToLevel',
				Number.isFinite(options.disableNotificationUpToLevel)
					? options.disableNotificationUpToLevel
					: DEFAULT_DISABLE_NOTIFICATION_UP_TO_LEVEL,
			),
			gateStateId: o.resolveString('gateStateId', options.gateStateId),
			gateOp: o.resolveString('gateOp', options.gateOp),
			gateValue: o.resolveString('gateValue', options.gateValue),
			gateBypassFromLevel: o.resolveInt('gateBypassFromLevel', options.gateBypassFromLevel),
			gateCheckinText: o.resolveString('gateCheckinText', options.gateCheckinText),
			gateCheckoutText: o.resolveString('gateCheckoutText', options.gateCheckoutText),
			uiOpts,
		});

		telegramUi = createTelegramUi({
			callbackPrefix: CALLBACK_PREFIX,
			t,
		});

		telegramTransport = createTelegramTransport({
			iobroker,
			log,
			telegramInstance: cfg.telegramInstance,
		});

		menuRuntime = createMenuRuntime({
			log,
			mappingStore,
			chatRegistry,
			telegramUi,
			transport: telegramTransport,
			store,
			generateShortId,
			cfg,
			defaultDisableNotificationUpToLevel: DEFAULT_DISABLE_NOTIFICATION_UP_TO_LEVEL,
			menuTimeoutMs: 30 * 1000,
			autoDeleteAfterMs: 46 * 60 * 60 * 1000,
		});

		initialized = true;
	};

	/**
	 * Sync the private chat registry from telegram adapter's authenticated users list.
	 *
	 * This is the foundation for the "explicit recipient list" design:
	 * - private chats are derived from `telegram.*.communicate.users`
	 * - groups will be added later via a token-confirm flow
	 *
	 * @returns {Promise<void>}
	 */
	const syncChatRegistryFromTelegramUsers = async () => {
		const usersStateId = `${cfg.telegramInstance}.communicate.users`;
		const st = await iobroker.states.getForeignState(usersStateId).catch(() => null);
		const raw = typeof st?.val === 'string' ? st.val : '';
		const summary = chatRegistry.syncPrivateChatsFromUsersState(raw, Date.now());
		if (summary.ignored) {
			return;
		}
		await chatRegistry.save();
		if (summary.added || summary.removed || summary.updated) {
			log.debug(
				`chatRegistry: synced users added=${summary.added} removed=${summary.removed} updated=${summary.updated}`,
			);
		}
	};

	/**
	 * Check whether a MsgHub message exposes an action with the given id.
	 *
	 * @param {object} msg MsgHub message.
	 * @param {string} actionId Action id.
	 * @returns {boolean} True if the action id exists in `msg.actions[]`.
	 */
	const hasActionId = (msg, actionId) => {
		const id = typeof actionId === 'string' ? actionId.trim() : '';
		if (!id) {
			return false;
		}
		const actions = Array.isArray(msg?.actions) ? msg.actions : [];
		return actions.some(a => a && typeof a === 'object' && String(a.id || '') === id);
	};

	/**
	 * Acquire a short-lived lock to avoid double-clicks from Telegram callbacks.
	 *
	 * @param {string} shortId Callback short id.
	 * @param {string|number} chatId Telegram chat id.
	 * @param {number} [nowMs] Epoch ms.
	 * @returns {boolean} True if acquired; false if locked.
	 */
	const tryAcquireCallbackLock = (shortId, chatId, nowMs = Date.now()) => {
		const sid = typeof shortId === 'string' ? shortId.trim() : '';
		const cid = typeof chatId === 'string' || typeof chatId === 'number' ? String(chatId) : '';
		if (!sid || !cid) {
			return true;
		}
		const key = `${sid}:${cid}`;

		// Opportunistic cleanup.
		for (const [k, until] of callbackLocks.entries()) {
			if (!Number.isFinite(until) || until <= nowMs) {
				callbackLocks.delete(k);
			}
		}

		const until = callbackLocks.get(key);
		if (Number.isFinite(until) && until > nowMs) {
			return false;
		}
		callbackLocks.set(key, nowMs + CALLBACK_LOCK_MS);
		return true;
	};

	const matchesNotificationFilters = msg => {
		if (!msg || typeof msg !== 'object') {
			return false;
		}

		if (cfg.kinds.size > 0) {
			const kind = typeof msg.kind === 'string' ? msg.kind.trim().toLowerCase() : '';
			if (!kind || !cfg.kinds.has(kind)) {
				return false;
			}
		}

		const level = typeof msg.level === 'number' ? msg.level : Number(msg.level);
		if (!Number.isFinite(level)) {
			return false;
		}
		if (level < cfg.levelMin || level > cfg.levelMax) {
			return false;
		}

		if (cfg.audienceTagsAny.length > 0) {
			const tags = Array.isArray(msg?.audience?.tags) ? msg.audience.tags.map(String) : [];
			const set = new Set(tags.map(s => s.trim()).filter(Boolean));
			const any = cfg.audienceTagsAny.some(tag => set.has(tag));
			if (!any) {
				return false;
			}
		}

		return true;
	};

	const sendGateMessage = async text => {
		const raw = typeof text === 'string' ? text.trim() : '';
		if (!raw) {
			return;
		}
		let out = raw;
		try {
			out = await templates.renderStates(raw);
		} catch (e) {
			log.warn(`gate renderStates failed: ${e?.message || e}`);
			out = raw;
		}
		const normalized = telegramUi.normalizeTelegramText(out);
		const escaped = telegramUi.escapeHtml(normalized).trim();
		if (!escaped) {
			return;
		}
		await telegramTransport.sendBroadcast({ html: escaped, disableNotification: false });
	};

	function generateShortId() {
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let attempt = 0; attempt < 50; attempt++) {
			let out = '';
			for (let i = 0; i < 6; i++) {
				out += alphabet[Math.floor(Math.random() * alphabet.length)];
			}
			if (!mappingStore.getRefByShortId(out)) {
				return out;
			}
		}
		return String(Date.now());
	}

	/**
	 * Resolve a private chat id for a given Telegram user label.
	 *
	 * Why this exists:
	 * - For `telegram.*.communicate.request` we currently only get a label in the payload prefix:
	 *   `[<Label>]<payload>`
	 * - We do not receive a stable telegram `from.id` here (which would be ideal).
	 *
	 * Approach:
	 * - The telegram adapter exposes its authenticated users list in `telegram.*.communicate.users`.
	 * - EngageTelegram syncs that JSON into ChatRegistry, including user meta fields (name, firstName, ...).
	 * - For `/startbot` we try to map the label to exactly one private chat id.
	 *
	 * Safety:
	 * - Labels are not stable and not unique.
	 * - If the label is missing or ambiguous, we refuse to guess and fail the enrollment request.
	 *
	 * @param {string} userLabel Label from `[Label]...` prefix.
	 * @returns {string} Private chat id or empty string.
	 */
	const resolvePrivateChatIdByLabel = userLabel => {
		const label = typeof userLabel === 'string' ? userLabel.trim() : '';
		if (!label) {
			return '';
		}

		const lower = label.toLowerCase();
		const candidates = chatRegistry
			.listChats(c => c && c.type === 'private')
			.filter(c => {
				const meta = c?.meta && typeof c.meta === 'object' ? c.meta : {};
				const values = [
					String(meta.firstName || ''),
					String(meta.userName || ''),
					String(meta.username || ''),
					String(meta.name || ''),
				]
					.map(s => s.trim())
					.filter(Boolean)
					.map(s => s.toLowerCase());
				return values.includes(lower);
			});

		if (candidates.length === 1) {
			return String(candidates[0].chatId);
		}
		if (candidates.length > 1) {
			log?.warn?.(`startbot: ambiguous userLabel='${label}' matches=${candidates.length}`);
			return '';
		}
		return '';
	};

	/**
	 * Generate a short request id for group enrollment callbacks.
	 *
	 * Similar to message short ids, but with an independent collision check:
	 * - pending enrollment ids
	 * - existing MsgHub message short ids (menu callbacks)
	 *
	 * @returns {string} Request id.
	 */
	const generateRequestId = () => {
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let attempt = 0; attempt < 50; attempt++) {
			let out = '';
			for (let i = 0; i < 6; i++) {
				out += alphabet[Math.floor(Math.random() * alphabet.length)];
			}
			if (chatRegistry.getPending(out)) {
				continue;
			}
			if (mappingStore.getRefByShortId(out)) {
				continue;
			}
			return out;
		}
		return String(Date.now());
	};

	/**
	 * Build the approval keyboard used in the requesting user's private chat.
	 *
	 * @param {string} requestId Pending request id.
	 * @returns {object|null} Telegram reply_markup or null.
	 */
	const buildEnrollApprovalKeyboard = requestId => {
		const id = typeof requestId === 'string' ? requestId.trim() : '';
		if (!id) {
			return null;
		}
		const allow = `opt_${id}:enroll:allow`;
		const deny = `opt_${id}:enroll:deny`;
		// Callback format:
		// - `opt_<requestId>:enroll:allow`
		// - `opt_<requestId>:enroll:deny`
		//
		// This reuses the global callback prefix (`opt_`) but uses a distinct `kind` ("enroll"),
		// so it does not conflict with menu callbacks (`menu/nav/act`).
		return {
			inline_keyboard: [
				[
					{
						text: String(t('msghub.i18n.EngageTelegram.command.startbot.allow.label')).trim(),
						callback_data: allow,
					},
					{
						text: String(t('msghub.i18n.EngageTelegram.command.startbot.deny.label')).trim(),
						callback_data: deny,
					},
				],
			],
		};
	};

	// Outgoing: Telegram-Nachricht senden + Mapping eintragen (createdAt)
	const sendNotification = async msg => {
		if (!matchesNotificationFilters(msg)) {
			return;
		}
		const level = typeof msg?.level === 'number' ? msg.level : Number(msg?.level);
		const gateBypass = Number.isFinite(level) && level >= cfg.gateBypassFromLevel;
		if (gateOpen === false && !gateBypass) {
			return;
		}
		await menuRuntime.onDue(msg, generateShortId);
	};

	const replyUnknownCommand = async chatId => {
		const text = String(t('msghub.i18n.EngageTelegram.command.unknown.text', '/start')).trim();
		await telegramTransport.sendToChat({ chatId, text });
	};

	// Inbound: Actions entgegen nehmen (Commands + Callback Buttons)
	const handleCommand = async ({ chatId, userLabel, payload }) => {
		const raw = String(payload || '').trim();
		if (!raw.startsWith(COMMANDS_PREFIX)) {
			return;
		}

		const cmdLine = raw.slice(COMMANDS_PREFIX.length).trim();
		const cmdToken = cmdLine.split(/\s+/)[0].trim();
		const cmd = cmdToken.split('@')[0].trim().toLowerCase();
		const args = cmdLine.slice(cmdToken.length).trim();

		const matchCtx = { command: cmd, args, userLabel, chatId };
		const runCtx = {
			command: cmd,
			args,
			chatId,
			userLabel,
			telegramInstance: cfg.telegramInstance,
			sendTo: iobroker.sendTo,
			telegramTransport,
			i18n,
			store,
			coreConfig: configApi,
			chatRegistry,
			cfg,
			constants,
			gateOpen,
			baseFullId,
			resolvePrivateChatIdByLabel,
			generateRequestId,
			buildEnrollApprovalKeyboard,
		};

		for (const c of commands) {
			if (!c?.match?.(matchCtx)) {
				continue;
			}
			await c.run(runCtx);
			return;
		}

		await replyUnknownCommand(chatId);
	};

	const handleRequestStateChange = async (_id, state) => {
		const raw = state?.val;
		const parsed = parseRequest(raw);
		if (!parsed) {
			return;
		}

		const chatIdStateId = `${cfg.telegramInstance}.communicate.requestChatId`;
		const messageIdStateId = `${cfg.telegramInstance}.communicate.requestMessageId`;

		const [chat, msg] = await Promise.all([
			iobroker.states.getForeignState(chatIdStateId).catch(() => null),
			iobroker.states.getForeignState(messageIdStateId).catch(() => null),
		]);

		const chatId = chat?.val;
		const messageId = Number(msg?.val);
		const payload = parsed.payload;

		// Ignore everything coming from unregistered group chats, with one explicit exception: `/startbot`.
		//
		// Why this matters:
		// - A bot can be added to groups by others (depending on group permissions).
		// - We therefore treat group chats as "blocked by default".
		// - Until a group is explicitly enrolled, we do not respond, do not execute actions,
		//   and do not leak any information (silent ignore).
		//
		// The only action we allow is to *start* the enrollment flow (`/startbot`), which then
		// requires a confirmation from an authenticated private chat (inline approval buttons).
		//
		const chatIdStr = typeof chatId === 'string' || typeof chatId === 'number' ? String(chatId).trim() : '';
		const chatIdNum = Number(chatIdStr);
		const looksLikeGroup = chatIdStr.startsWith('-') || (Number.isFinite(chatIdNum) && chatIdNum < 0);
		if (looksLikeGroup) {
			const entry = chatRegistry?.getChat?.(chatIdStr);
			const isRegisteredGroup = entry && entry.type === 'group';
			if (!isRegisteredGroup) {
				const rawPayload = typeof payload === 'string' ? payload.trim() : '';
				if (!rawPayload.startsWith('/')) {
					return;
				}
				const cmdLine = rawPayload.slice(1).trim();
				const cmdToken = cmdLine.split(/\s+/)[0].trim();
				const cmd = cmdToken.split('@')[0].trim().toLowerCase();
				if (cmd !== 'startbot') {
					return;
				}
			}
		}

		log.debug(
			`inbound: request raw='${String(raw)}' user='${parsed.userLabel}' chatId='${String(chatId || '')}' messageId='${String(messageId || '')}'`,
		);

		const trimmed = typeof payload === 'string' ? payload.trim() : '';
		if (trimmed.startsWith(CALLBACK_PREFIX)) {
			await handleCallback({ chatId, userLabel: parsed.userLabel, payload: trimmed });
			return;
		}

		await handleCommand({ chatId, userLabel: parsed.userLabel, payload });
	};

	/**
	 * Parse the callback payload format used by TelegramUi.
	 *
	 * Supported shapes:
	 * - `opt_<shortId>:menu`
	 * - `opt_<shortId>:nav:<target>[:<actionId>]`
	 * - `opt_<shortId>:act:<actionId>[:<forMs>]`
	 * - `opt_<requestId>:enroll:(allow|deny)` (group enrollment flow)
	 *
	 * @param {string} payload Callback payload.
	 * @returns {object|null} Parsed callback.
	 */
	const parseCallbackPayload = payload => {
		const raw = typeof payload === 'string' ? payload.trim() : '';
		if (!raw.startsWith(CALLBACK_PREFIX)) {
			return null;
		}
		const data = raw.slice(CALLBACK_PREFIX.length);
		const parts = data
			.split(':')
			.map(s => s.trim())
			.filter(Boolean);
		if (parts.length < 2) {
			return null;
		}
		const shortId = parts[0];
		const kind = parts[1];
		if (!shortId || !/^[A-Za-z0-9]+$/.test(shortId)) {
			return null;
		}
		return { shortId, kind, parts: parts.slice(2) };
	};

	/**
	 * Handle "group enrollment" callbacks (`opt_<requestId>:enroll:(allow|deny)`).
	 *
	 * These callbacks are sent from the requesting user's private chat.
	 * We never show user names in the group chat; group-facing messages are neutral.
	 *
	 * @param {object} params Params.
	 * @param {string|number} params.chatId Current chat id (should be private chat id).
	 * @param {string} params.userLabel Telegram user label.
	 * @param {object} params.parsed Parsed callback payload.
	 */
	const handleEnrollmentCallback = async ({ chatId, userLabel, parsed }) => {
		const requestId = typeof parsed?.shortId === 'string' ? parsed.shortId.trim() : '';
		if (!requestId) {
			return;
		}

		// 1) Resolve the pending request.
		const pending = chatRegistry.getPending(requestId);
		if (!pending) {
			return;
		}

		const kind = pending?.kind === 'unenroll' ? 'unenroll' : 'enroll';

		// 2) Safety check: only the requesting private chat may approve/deny.
		// This prevents other authenticated users from tampering with the enrollment flow.
		const currentChatId = typeof chatId === 'string' || typeof chatId === 'number' ? String(chatId).trim() : '';
		const requestedByChatId =
			typeof pending?.requestedByChatId === 'string' ? pending.requestedByChatId.trim() : '';
		if (!currentChatId || !requestedByChatId || currentChatId !== requestedByChatId) {
			return;
		}

		// 3) Perform the action and update UX in both places:
		// - private chat: update approval message and remove buttons
		// - group chat: update group status message (neutral, no names)
		const actionId = parsed?.parts?.[0] || '';
		const groupChatId = typeof pending?.chatId === 'string' ? pending.chatId.trim() : '';
		const approvalMessageId = Number(pending?.approvalMessageId);
		const groupStatusMessageId = Number(pending?.groupStatusMessageId);

		const clearKeyboard = { inline_keyboard: [] };
		const muteHint = String(t('msghub.i18n.EngageTelegram.command.startbot.muteHint.text')).trim();

		if (actionId === 'allow') {
			if (kind === 'unenroll') {
				// Reverse enrollment: remove the group chat from the registry.
				chatRegistry.removeChat(groupChatId);
			} else {
				chatRegistry.upsertChat(groupChatId, { type: 'group', muted: false });
			}
			chatRegistry.removePending(requestId);
			await chatRegistry.save();

			if (Number.isFinite(approvalMessageId) && approvalMessageId > 0) {
				const base = String(
					t(
						kind === 'unenroll'
							? 'msghub.i18n.EngageTelegram.command.stopbot.allow.private.text'
							: 'msghub.i18n.EngageTelegram.command.startbot.allow.private.text',
					),
				).trim();
				const html = muteHint ? `${base}\n\n${muteHint}` : base;
				await telegramTransport.editMessage({
					chatId: requestedByChatId,
					messageId: approvalMessageId,
					html,
					replyMarkup: clearKeyboard,
				});
			}

			if (groupChatId && Number.isFinite(groupStatusMessageId) && groupStatusMessageId > 0) {
				const html = String(
					t(
						kind === 'unenroll'
							? 'msghub.i18n.EngageTelegram.command.stopbot.allow.group.text'
							: 'msghub.i18n.EngageTelegram.command.startbot.allow.group.text',
					),
				).trim();
				await telegramTransport.editMessage({
					chatId: groupChatId,
					messageId: groupStatusMessageId,
					html,
					replyMarkup: clearKeyboard,
				});
			} else if (groupChatId) {
				const text = String(
					t(
						kind === 'unenroll'
							? 'msghub.i18n.EngageTelegram.command.stopbot.allow.group.text'
							: 'msghub.i18n.EngageTelegram.command.startbot.allow.group.text',
					),
				).trim();
				await telegramTransport.sendToChat({ chatId: groupChatId, text });
			}
			return;
		}

		if (actionId === 'deny') {
			chatRegistry.removePending(requestId);
			await chatRegistry.save();

			if (Number.isFinite(approvalMessageId) && approvalMessageId > 0) {
				const html = String(
					t(
						kind === 'unenroll'
							? 'msghub.i18n.EngageTelegram.command.stopbot.deny.private.text'
							: 'msghub.i18n.EngageTelegram.command.startbot.deny.private.text',
					),
				).trim();
				await telegramTransport.editMessage({
					chatId: requestedByChatId,
					messageId: approvalMessageId,
					html,
					replyMarkup: clearKeyboard,
				});
			}

			if (groupChatId && Number.isFinite(groupStatusMessageId) && groupStatusMessageId > 0) {
				const html = String(
					t(
						kind === 'unenroll'
							? 'msghub.i18n.EngageTelegram.command.stopbot.deny.group.text'
							: 'msghub.i18n.EngageTelegram.command.startbot.deny.group.text',
					),
				).trim();
				await telegramTransport.editMessage({
					chatId: groupChatId,
					messageId: groupStatusMessageId,
					html,
					replyMarkup: clearKeyboard,
				});
			} else if (groupChatId) {
				const text = String(
					t(
						kind === 'unenroll'
							? 'msghub.i18n.EngageTelegram.command.stopbot.deny.group.text'
							: 'msghub.i18n.EngageTelegram.command.startbot.deny.group.text',
					),
				).trim();
				await telegramTransport.sendToChat({ chatId: groupChatId, text });
			}
			return;
		}

		log?.warn?.(`enroll callback ignored: action='${String(actionId)}' user='${String(userLabel || '')}'`);
	};

	/**
	 * Handle callback-based interactions (menu navigation + action execution).
	 *
	 * @param {object} params Params.
	 * @param {string|number} params.chatId Telegram chat id.
	 * @param {string} params.userLabel Telegram user label.
	 * @param {string} params.payload Callback payload (starts with `opt_`).
	 */
	const handleCallback = async ({ chatId, userLabel, payload }) => {
		const parsed = parseCallbackPayload(payload);
		if (!parsed) {
			return;
		}

		if (parsed.kind === 'enroll') {
			await handleEnrollmentCallback({ chatId, userLabel, parsed });
			return;
		}

		const ref = mappingStore.getRefByShortId(parsed.shortId);
		if (!ref) {
			return;
		}

		// Always use store filtering helpers, not lifecycle string comparisons.
		const msgAll = store.getMessageByRef(ref, 'all');
		if (!msgAll) {
			// Mapping exists but message is gone -> cleanup mapped telegram messages.
			await menuRuntime.onDelete(ref);
			return;
		}

		const actor = `telegram:${userLabel || chatId}`;
		const uiOpts = cfg?.uiOpts || {};
		const menuModel = telegramUi.getMenuModel(msgAll, uiOpts);

		const isCallbackActionAllowed = actionId => {
			const id = typeof actionId === 'string' ? actionId.trim() : '';
			if (!id) {
				return false;
			}
			const allow = [
				menuModel?.ack?.id,
				menuModel?.close?.id,
				menuModel?.snooze?.id,
				menuModel?.open?.id,
				menuModel?.link?.id,
			]
				.filter(Boolean)
				.map(String);
			return allow.includes(id);
		};

		if (parsed.kind === 'menu') {
			// Only open the menu if there is at least one enabled menu action.
			if (menuModel.hasAny) {
				await menuRuntime.showMenuRoot(msgAll, Date.now());
			} else {
				await menuRuntime.showMenuEntry(ref, Date.now());
			}
			return;
		}

		if (parsed.kind === 'nav') {
			const target = parsed.parts[0] || '';
			if (target === 'snooze') {
				const menu = telegramUi.getMenuModel(msgAll, uiOpts);
				if (menu.snooze) {
					await menuRuntime.showSnoozeMenu(msgAll, Date.now());
				} else {
					await menuRuntime.showMenuRoot(msgAll, Date.now());
				}
				return;
			}
			if (target === 'root') {
				await menuRuntime.showMenuRoot(msgAll, Date.now());
				return;
			}
			if (target === 'back') {
				await menuRuntime.showMenuEntry(ref, Date.now());
				return;
			}
			// `open`/`link` are navigation-only; best effort: execute the action (noop in core) if present.
			if ((target === 'open' || target === 'link') && parsed.parts[1]) {
				const actionId = parsed.parts[1];
				if (hasActionId(msgAll, actionId) && isCallbackActionAllowed(actionId)) {
					action.execute({ ref, actionId, actor });
				} else {
					log.warn(
						`callback nav:${target} ignored (actionId not present) ref='${ref}' actionId='${actionId}'`,
					);
				}
				await menuRuntime.showMenuEntry(ref, Date.now());
			}
			return;
		}

		if (parsed.kind === 'act') {
			// Guard against double-clicks for lifecycle-changing actions.
			if (!tryAcquireCallbackLock(parsed.shortId, chatId, Date.now())) {
				return;
			}

			const actionId = parsed.parts[0] || '';
			const arg = parsed.parts[1] || '';
			if (!actionId) {
				return;
			}

			const msgActive = store.getMessageByRef(ref, 'quasiOpen');
			if (!msgActive) {
				await menuRuntime.onDelete(ref);
				return;
			}
			if (!hasActionId(msgActive, actionId)) {
				log.warn(`callback act ignored (actionId not present) ref='${ref}' actionId='${actionId}'`);
				await menuRuntime.showMenuEntry(ref, Date.now());
				return;
			}
			if (!isCallbackActionAllowed(actionId)) {
				log.warn(`callback act ignored (action disabled by options) ref='${ref}' actionId='${actionId}'`);
				await menuRuntime.showMenuEntry(ref, Date.now());
				return;
			}

			let snoozeForMs = undefined;
			if (arg) {
				const parsedMs = Number(arg);
				if (Number.isFinite(parsedMs) && parsedMs > 0) {
					snoozeForMs = parsedMs;
				}
			}

			const ok = action.execute({
				ref,
				actionId,
				actor,
				...(snoozeForMs !== undefined ? { snoozeForMs } : {}),
			});

			// Best effort UX: collapse menu after execution attempts.
			if (ok) {
				await menuRuntime.showMenuEntry(ref, Date.now());
			}
			return;
		}
	};

	const start = async ctx => {
		ensureInitialized(ctx);
		if (started) {
			return;
		}

		// Mapping/persistence is centralized in MappingStore (backwards compatible state ids + new uiId state).
		await mappingStore.ensureObjects();
		await mappingStore.load();
		await chatRegistry.ensureObjects();
		await chatRegistry.load();
		await syncChatRegistryFromTelegramUsers();
		menuRuntime.start();
		if (!engineIntervalHandle) {
			engineIntervalHandle = setInterval(
				() => {
					menuRuntime.tick(Date.now()).catch(e => log.warn(`tick failed: ${e?.message || e}`));
				},
				5 * 60 * 1000,
			);
			if (engineIntervalHandle && typeof engineIntervalHandle.unref === 'function') {
				engineIntervalHandle.unref();
			}
		}

		const pattern = `${cfg.telegramInstance}.communicate.*`;
		iobroker.subscribe.subscribeForeignStates(pattern);

		const gateId = cfg.gateStateId;
		const gateOp = cfg.gateOp;
		const hasCheckin = typeof cfg.gateCheckinText === 'string' && cfg.gateCheckinText.trim();
		const hasCheckout = typeof cfg.gateCheckoutText === 'string' && cfg.gateCheckoutText.trim();
		if (gateId && gateOp) {
			gateOpen = false;
			gateHandle = ctx.meta.gates.register({
				id: gateId,
				op: gateOp,
				value: cfg.gateValue,
				onChange: info => {
					gateOpen = info.open;
				},
				onOpen: hasCheckin
					? info => {
							if (info?.prevOpen === undefined) {
								return;
							}
							return sendGateMessage(cfg.gateCheckinText);
						}
					: null,
				onClose: hasCheckout
					? info => {
							if (info?.prevOpen === undefined) {
								return;
							}
							return sendGateMessage(cfg.gateCheckoutText);
						}
					: null,
				fireOnInit: true,
			});
		} else {
			gateOpen = true;
		}

		started = true;
		log.info('started');
	};

	const stop = async ctx => {
		ensureInitialized(ctx);
		if (!started) {
			return;
		}
		const pattern = `${cfg.telegramInstance}.communicate.*`;
		iobroker.subscribe.unsubscribeForeignStates(pattern);
		try {
			gateHandle?.dispose?.();
		} catch {
			// ignore
		} finally {
			gateHandle = null;
		}
		if (engineIntervalHandle) {
			clearInterval(engineIntervalHandle);
		}
		engineIntervalHandle = null;
		menuRuntime.stop();
		started = false;
		log.info('stopped');
	};

	const onStateChange = (id, state, ctx) => {
		ensureInitialized(ctx);
		const usersId = `${cfg.telegramInstance}.communicate.users`;
		if (id === usersId) {
			syncChatRegistryFromTelegramUsers().catch(e => log.warn(`chatRegistry sync failed: ${e?.message || e}`));
			return;
		}
		const requestId = `${cfg.telegramInstance}.communicate.request`;
		if (id !== requestId) {
			return;
		}
		handleRequestStateChange(id, state).catch(e => log.warn(`handle request failed: ${e?.message || e}`));
	};

	const onNotifications = (event, notifications, ctx) => {
		ensureInitialized(ctx);
		const list = Array.isArray(notifications) ? notifications : [];
		if (list.length === 0) {
			return;
		}

		const events = constants?.notfication?.events;
		if (!events || typeof events !== 'object') {
			log.warn('missing ctx.api.constants.notfication.events');
			return;
		}

		for (const msg of list) {
			if (!msg || typeof msg !== 'object') {
				continue;
			}
			const ref = typeof msg.ref === 'string' ? msg.ref.trim() : '';
			if (!ref) {
				continue;
			}
			if (event === events.due) {
				// due: if mapping exists, old telegram message is deleted first and a new one is sent.
				sendNotification(msg).catch(e => log.warn(`send failed: ${e?.message || e}`));
			}
			if (event === events.deleted || event === events.expired) {
				menuRuntime.onDelete(ref).catch(e => log.warn(`delete failed: ${e?.message || e}`));
				continue;
			}
			if (event === events.update || event === events.recreated || event === events.recovered) {
				menuRuntime.onSync(msg, generateShortId).catch(e => log.warn(`sync failed: ${e?.message || e}`));
				continue;
			}
		}
	};

	return Object.freeze({ start, stop, onStateChange, onNotifications });
}

module.exports = { EngageTelegram, manifest };
