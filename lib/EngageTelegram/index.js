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
const { createMappingStore } = require('./MappingStore');
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
	let constants = null;
	let store = null;
	let action = null;
	let o = null;
	let cfg = null;
	let mappingStore = null;
	let telegramUi = null;
	let telegramTransport = null;
	let menuRuntime = null;

	let baseFullId = '';
	let engineIntervalHandle = null;

	const commands = [createStartCommand()];
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
				'api.log',
				'api.constants',
				'api.constants.notfication',
				'api.constants.notfication.events',
				'api.constants.lifecycle',
				'api.constants.lifecycle.state',
				'api.iobroker',
				'api.iobroker.subscribe',
				'api.iobroker.objects',
				'api.iobroker.states',
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
				'api.store.getMessageByRef',
				'api.action.execute',
			],
		});

		log = ctx.api.log;
		i18n = ctx.api.i18n || null;
		iobroker = ctx.api.iobroker;
		constants = ctx.api.constants || null;
		store = ctx.api.store;
		action = ctx.api.action;
		o = ctx.meta.options;

		baseFullId = typeof options.pluginBaseObjectId === 'string' ? options.pluginBaseObjectId.trim() : '';
		if (!baseFullId) {
			throw new Error('options.pluginBaseObjectId is required');
		}
		mappingStore = createMappingStore({ iobroker, log, baseFullId });

		const kinds = new Set(toCsvList(o.resolveString('kindsCsv', options.kindsCsv)).map(s => s.toLowerCase()));
		const states = new Set(
			toCsvList(o.resolveString('lifecycleStatesCsv', options.lifecycleStatesCsv)).map(s => s.toLowerCase()),
		);
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
			lifecycleStates: states,
			audienceTagsAny,
			disableNotificationUpToLevel: o.resolveInt(
				'disableNotificationUpToLevel',
				Number.isFinite(options.disableNotificationUpToLevel)
					? options.disableNotificationUpToLevel
					: DEFAULT_DISABLE_NOTIFICATION_UP_TO_LEVEL,
			),
			iconByLevel: Object.freeze({
				0: o.resolveString('iconNone', options.iconNone),
				10: o.resolveString('iconNotice', options.iconNotice),
				20: o.resolveString('iconWarning', options.iconWarning),
				30: o.resolveString('iconError', options.iconError),
			}),
			iconByKind: Object.freeze({
				task: o.resolveString('iconTask', options.iconTask),
				status: o.resolveString('iconStatus', options.iconStatus),
				appointment: o.resolveString('iconAppointment', options.iconAppointment),
				shoppinglist: o.resolveString('iconShoppinglist', options.iconShoppinglist),
				inventorylist: o.resolveString('iconInventorylist', options.iconInventorylist),
			}),
			gateStateId: o.resolveString('gateStateId', options.gateStateId),
			gateOp: o.resolveString('gateOp', options.gateOp),
			gateValue: o.resolveString('gateValue', options.gateValue),
			gateBypassFromLevel: o.resolveInt('gateBypassFromLevel', options.gateBypassFromLevel),
			uiOpts,
		});

		telegramUi = createTelegramUi({
			callbackPrefix: CALLBACK_PREFIX,
			t,
			iconByLevel: cfg.iconByLevel,
			iconByKind: cfg.iconByKind,
		});

		telegramTransport = createTelegramTransport({
			iobroker,
			log,
			telegramInstance: cfg.telegramInstance,
		});

		menuRuntime = createMenuRuntime({
			log,
			mappingStore,
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
		if (cfg.iconByLevel[level] === undefined) {
			return false;
		}

		if (cfg.lifecycleStates.size > 0) {
			const st = typeof msg?.lifecycle?.state === 'string' ? msg.lifecycle.state.trim().toLowerCase() : '';
			if (!st || !cfg.lifecycleStates.has(st)) {
				return false;
			}
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

	const evaluateGate = async msg => {
		const level = typeof msg?.level === 'number' ? msg.level : Number(msg?.level);
		if (Number.isFinite(level) && level >= cfg.gateBypassFromLevel) {
			return true;
		}

		const gateId = cfg.gateStateId;
		const op = cfg.gateOp;
		if (!gateId || !op) {
			return true;
		}

		const st = await iobroker.states
			.getForeignState(gateId)
			.catch(e => log.warn(`gate getForeignState failed: ${e?.message || e}`));
		if (!st) {
			return false;
		}

		const val = st.val;
		if (op === 'true') {
			return val === true;
		}
		if (op === 'false') {
			return val === false;
		}

		const cmp = cfg.gateValue;
		if (op === '>' || op === '<') {
			const a = Number(val);
			const b = Number(cmp);
			if (!Number.isFinite(a) || !Number.isFinite(b)) {
				return false;
			}
			return op === '>' ? a > b : a < b;
		}
		if (op === '=') {
			if (!cmp) {
				return false;
			}
			const a = Number(val);
			const b = Number(cmp);
			if (Number.isFinite(a) && Number.isFinite(b)) {
				return a === b;
			}
			return String(val).trim() === cmp;
		}

		return false;
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

	// Outgoing: Telegram-Nachricht senden + Mapping eintragen (createdAt)
	const sendNotification = async msg => {
		if (!matchesNotificationFilters(msg)) {
			return;
		}
		const okGate = await evaluateGate(msg);
		if (!okGate) {
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
		const cmd = cmdLine.split(/\s+/)[0].trim().toLowerCase();
		const args = cmdLine.slice(cmd.length).trim();

		const matchCtx = { command: cmd, args, userLabel, chatId };
		const runCtx = {
			command: cmd,
			args,
			chatId,
			userLabel,
			telegramInstance: cfg.telegramInstance,
			sendTo: iobroker.sendTo,
			i18n,
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
