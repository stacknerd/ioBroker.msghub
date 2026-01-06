/**
 * EngageTelegram
 * =============
 *
 * MsgHub engage plugin for Telegram:
 * - Outgoing: sends notifications to Telegram via `sendTo()` (Pushover-like).
 * - Incoming: handles inline button callbacks + simple chat commands.
 *
 * Docs: ../../docs/plugins/EngageTelegram.md
 */

'use strict';

const { manifest } = require('./manifest');
const { ensureCtxAvailability } = require('../IoPluginGuards');
const { createStartCommand } = require('./commands/start');

const CALLBACK_PREFIX = 'opt_';
const COMMANDS_PREFIX = '/';
const DEFAULT_DISABLE_NOTIFICATION_UP_TO_LEVEL = 10;
const HOUR_MS = 60 * 60 * 1000;

const toCsvList = csv =>
	String(csv || '')
		.split(',')
		.map(s => s.trim())
		.filter(Boolean);

const escapeHtml = text =>
	String(text || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

const normalizeTelegramText = text =>
	String(text || '')
		.replace(/\r\n/g, '\n')
		.replace(/\\n/g, '\n');

const parseRequest = raw => {
	const s = typeof raw === 'string' ? raw : '';
	if (!s.startsWith('[')) {
		return null;
	}
	const closeBracket = s.indexOf(']');
	if (closeBracket < 0) {
		return null;
	}
	const userLabel = s.slice(1, closeBracket).trim();
	const payload = s.slice(closeBracket + 1);
	return Object.freeze({ userLabel, payload });
};

const formatDuration = forMs => {
	const ms = Number(forMs);
	if (!Number.isFinite(ms) || ms <= 0) {
		return '';
	}
	const totalMinutes = Math.max(1, Math.round(ms / 60000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours <= 0) {
		return `${minutes}m`;
	}
	if (minutes <= 0) {
		return `${hours}h`;
	}
	return `${hours}h ${minutes}m`;
};

const getSnoozeForMs = action => {
	const p = action?.payload;
	const direct = p?.forMs;
	if (Number.isFinite(direct)) {
		return direct;
	}
	const nested = p?.snooze?.forMs;
	if (Number.isFinite(nested)) {
		return nested;
	}
	return NaN;
};

const buildDefaultSnoozeDurations = defaultForMs => {
	const defaults = [1 * HOUR_MS, 4 * HOUR_MS, 8 * HOUR_MS];
	const baseMs = Number(defaultForMs);
	if (!Number.isFinite(baseMs) || baseMs <= 0) {
		return defaults;
	}

	const niceHours = [1, 2, 3, 4, 8, 12, 24];

	const nextNiceAfter = ms => {
		const h = ms / HOUR_MS;
		const next = niceHours.find(x => x > h);
		return (next || niceHours[niceHours.length - 1]) * HOUR_MS;
	};

	const unique = [];
	const pushUnique = ms => {
		const v = Number(ms);
		if (!Number.isFinite(v) || v <= 0) {
			return;
		}
		if (unique.some(x => Math.abs(x - v) < 1000)) {
			return;
		}
		unique.push(v);
	};

	pushUnique(1 * HOUR_MS);
	pushUnique(baseMs);
	pushUnique(nextNiceAfter(baseMs));

	while (unique.length < 3) {
		pushUnique(nextNiceAfter(unique[unique.length - 1] || baseMs));
	}

	return unique.sort((a, b) => a - b).slice(0, 3);
};

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isPlainObject = v => isObject(v);

/**
 * Engage plugin factory.
 *
 * @param {object} [options] Plugin options (from ioBroker `native`), plus injected runtime helpers.
 * @returns {{ start?: Function, stop?: Function, onNotifications: Function, onStateChange?: Function }} Engage handler.
 */
function EngageTelegram(options = {}) {
	let initialized = false;
	let started = false;

	let log = null;
	let i18n = null;
	let iobroker = null;
	let store = null;
	let action = null;
	let o = null;
	let cfg = null;

	let baseFullId = '';
	let mappingRefStateId = '';
	let mappingShortStateId = '';

	let mappingByRef = Object.create(null);
	let mappingShortToRef = Object.create(null);
	const locks = new Map();

	const commands = [createStartCommand()];

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
				'api.action.execute',
				'api.store.getMessageByRef',
			],
		});

		log = ctx.api.log;
		i18n = ctx.api.i18n || null;
		iobroker = ctx.api.iobroker;
		store = ctx.api.store;
		action = ctx.api.action;
		o = ctx.meta.options;

		baseFullId = typeof options.pluginBaseObjectId === 'string' ? options.pluginBaseObjectId.trim() : '';
		if (!baseFullId) {
			throw new Error('options.pluginBaseObjectId is required');
		}

		mappingRefStateId = `${baseFullId}.mappingByRef`;
		mappingShortStateId = `${baseFullId}.mappingShortToRef`;

		const kinds = new Set(toCsvList(o.resolveString('kindsCsv', options.kindsCsv)).map(s => s.toLowerCase()));
		const states = new Set(
			toCsvList(o.resolveString('lifecycleStatesCsv', options.lifecycleStatesCsv)).map(s => s.toLowerCase()),
		);
		const audienceTagsAny = toCsvList(o.resolveString('audienceTagsAnyCsv', options.audienceTagsAnyCsv));

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
			deleteOldNotificationOnResend: o.resolveBool(
				'deleteOldNotificationOnResend',
				options.deleteOldNotificationOnResend !== undefined ? options.deleteOldNotificationOnResend : true,
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
		});

		initialized = true;
	};

	const debug = msg => {
		if (typeof log?.debug === 'function') {
			log.debug(String(msg));
		}
	};

	const ensureState = (id, name, common) =>
		iobroker.objects
			.setObjectNotExists(id, {
				type: 'state',
				common: {
					name: name || id,
					type: 'string',
					role: 'json',
					read: true,
					write: false,
					...(common || {}),
				},
				native: {},
			})
			.catch(err => log.warn(`failed to create state "${id}": ${err?.message || err}`));

	const writeState = (id, value) =>
		iobroker.states.setState(id, { val: String(value ?? ''), ack: true }).catch(err => {
			log.warn(`failed to write state "${id}": ${err?.message || err}`);
		});

	const loadJsonState = async id => {
		const st = await iobroker.states
			.getForeignState(id)
			.catch(err => log.warn(`failed to read state "${id}": ${err?.message || err}`));
		const raw = typeof st?.val === 'string' ? st.val : '';
		if (!raw.trim()) {
			return null;
		}
		try {
			return JSON.parse(raw);
		} catch (e) {
			log.warn(`failed to parse json state "${id}" - ${e}`);
			return null;
		}
	};

	const saveMappings = async () => {
		await Promise.all([
			writeState(mappingRefStateId, JSON.stringify(mappingByRef)),
			writeState(mappingShortStateId, JSON.stringify(mappingShortToRef)),
		]);
	};

	const matchFilters = msg => {
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

	const parseSendResponse = res => {
		if (isPlainObject(res)) {
			return res;
		}
		if (typeof res === 'string') {
			try {
				const parsed = JSON.parse(res);
				return isPlainObject(parsed) ? parsed : {};
			} catch {
				return {};
			}
		}
		if (Array.isArray(res)) {
			const out = {};
			for (const entry of res) {
				const parsed = parseSendResponse(entry);
				if (!isPlainObject(parsed)) {
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

	const send = payload =>
		iobroker.sendTo(cfg.telegramInstance, 'send', payload).catch(e => {
			log.warn(`sendTo failed: ${e?.message || e}`);
		});

	const generateShortId = () => {
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let attempt = 0; attempt < 50; attempt++) {
			let out = '';
			for (let i = 0; i < 6; i++) {
				out += alphabet[Math.floor(Math.random() * alphabet.length)];
			}
			if (!mappingShortToRef[out]) {
				return out;
			}
		}
		return String(Date.now());
	};

	const buildButtons = ({ msg, shortId }) => {
		const actions = Array.isArray(msg?.actions) ? msg.actions : [];
		const rowMain = [];
		const rowSnooze = [];

		const actionsByType = new Map();
		for (const a of actions) {
			if (!a || typeof a !== 'object') {
				continue;
			}
			const type = typeof a.type === 'string' ? a.type.trim() : '';
			if (!type) {
				continue;
			}
			const id = typeof a.id === 'string' ? a.id.trim() : '';
			if (!id) {
				continue;
			}

			const list = actionsByType.get(type) || [];
			list.push(a);
			actionsByType.set(type, list);
		}

		const add = (row, actionType, label, actionObj = null, callbackArg = '') => {
			const a = actionObj || (actionsByType.get(actionType) || [])[0] || null;
			if (!a || typeof a.id !== 'string' || !a.id.trim()) {
				return;
			}
			const arg = typeof callbackArg === 'string' ? callbackArg.trim() : '';
			row.push({
				text: String(label || actionType),
				callback_data: `${CALLBACK_PREFIX}${shortId}:${a.id}${arg ? `:${arg}` : ''}`,
			});
		};

		add(rowMain, 'ack', t('Got it'));

		const snoozeAction = (actionsByType.get('snooze') || [])[0] || null;
		if (snoozeAction) {
			const defaultForMs = getSnoozeForMs(snoozeAction);
			const durations = buildDefaultSnoozeDurations(defaultForMs);
			for (const forMs of durations) {
				const label = t('Later (%s)', formatDuration(forMs));
				add(rowSnooze, 'snooze', label, snoozeAction, String(forMs));
			}
		}

		add(rowMain, 'close', t('Done'));
		add(rowMain, 'delete', t('Remove'));

		const inline_keyboard = [];
		if (rowMain.length > 0) {
			inline_keyboard.push(rowMain);
		}
		if (rowSnooze.length > 0) {
			inline_keyboard.push(rowSnooze);
		}

		return inline_keyboard.length > 0 ? { inline_keyboard } : null;
	};

	const renderTelegramText = msg => {
		const level = typeof msg.level === 'number' ? msg.level : Number(msg.level);
		const kind = typeof msg.kind === 'string' ? msg.kind.trim().toLowerCase() : '';
		const iconLevel = cfg.iconByLevel[level] || '';
		const iconKind = cfg.iconByKind[kind] || '';
		const rawTitle = normalizeTelegramText(`${iconKind}${iconLevel} ${String(msg.title || '').trim()}`.trim());
		const rawBody = normalizeTelegramText(String(msg.text || '').trim());

		const titleHtml = escapeHtml(rawTitle);
		const bodyHtml = escapeHtml(rawBody);

		const html =
			titleHtml && bodyHtml ? `<b>${titleHtml}</b>\n\n${bodyHtml}` : titleHtml ? `<b>${titleHtml}</b>` : bodyHtml;

		// Plain variant for edits/cleanup to avoid any double-parsing issues when adapters don't forward parse_mode
		// for edit requests consistently. This is intentionally not HTML-escaped.
		const plain = rawTitle && rawBody ? `${rawTitle}\n\n${rawBody}` : rawTitle ? rawTitle : rawBody;

		return Object.freeze({ html, plain });
	};

	const deleteRefMapping = ref => {
		const key = typeof ref === 'string' ? ref : '';
		const entry = mappingByRef[key];
		if (!entry || typeof entry !== 'object') {
			return;
		}
		const shortId = typeof entry.shortId === 'string' ? entry.shortId : '';
		if (shortId && mappingShortToRef[shortId] === key) {
			delete mappingShortToRef[shortId];
		}
		delete mappingByRef[key];
	};

	const deleteTelegramMessage = ({ chatId, messageId }) => {
		const safeChatId = typeof chatId === 'string' || typeof chatId === 'number' ? chatId : '';
		const safeMessageId = typeof messageId === 'number' ? messageId : Number(messageId);
		if (!safeChatId || !Number.isFinite(safeMessageId)) {
			return Promise.resolve();
		}

		return send({
			deleteMessage: {
				options: { chat_id: safeChatId, message_id: safeMessageId },
			},
		});
	};

	const editMessageRemoveButtons = ({ chatId, messageId, text }) => {
		const safeChatId = typeof chatId === 'string' || typeof chatId === 'number' ? chatId : '';
		const safeMessageId = typeof messageId === 'number' ? messageId : Number(messageId);
		if (!safeChatId || !Number.isFinite(safeMessageId)) {
			return Promise.resolve();
		}

		return send({
			chatId: safeChatId,
			text: String(text || '').trim(),
			editMessageText: {
				options: { chat_id: safeChatId, message_id: safeMessageId, parse_mode: 'HTML' },
				reply_markup: { inline_keyboard: [] },
			},
		});
	};

	const cleanupButtonsForRef = async (ref, reason = '') => {
		const entry = mappingByRef[ref];
		if (!entry || typeof entry !== 'object') {
			return;
		}

		const hasReason = typeof reason === 'string' && reason.trim();
		const translatedReason = hasReason ? t(`removed actions due to ${reason}`) : '';
		const htmlReason = translatedReason ? `\n\n<i>(${translatedReason})</i>` : '';

		const baseText = typeof entry.textHtml === 'string' ? entry.textHtml : '';
		const text = htmlReason ? `${baseText}${htmlReason}` : baseText;

		const chatMessages = isObject(entry.chatMessages) ? entry.chatMessages : {};
		const mode = cfg.deleteOldNotificationOnResend ? 'delete' : 'buttons';
		debug(`cleanup: ref='${ref}' chats=${Object.keys(chatMessages).length} mode=${mode}`);
		const tasks = Object.entries(chatMessages).map(([chatId, messageId]) => {
			if (cfg.deleteOldNotificationOnResend) {
				return deleteTelegramMessage({ chatId, messageId: Number(messageId) });
			}
			return editMessageRemoveButtons({ chatId, messageId: Number(messageId), text });
		});
		await Promise.all(tasks);

		deleteRefMapping(ref);
		await saveMappings();
		debug(`cleanup: ref='${ref}' done mapping=removed`);
	};

	const upsertRefMapping = ({ ref, shortId, text, chatMessages }) => {
		mappingByRef[ref] = Object.freeze({
			ref,
			shortId,
			textHtml: text?.html || '',
			textPlain: text?.plain || '',
			chatMessages: { ...(chatMessages || {}) },
			updatedAt: Date.now(),
		});
		mappingShortToRef[shortId] = ref;
	};

	const sendNotification = async msg => {
		if (!matchFilters(msg)) {
			return;
		}
		const okGate = await evaluateGate(msg);
		if (!okGate) {
			return;
		}

		const ref = typeof msg.ref === 'string' ? msg.ref.trim() : '';
		if (!ref) {
			return;
		}

		if (mappingByRef[ref]) {
			debug(`notify: ref='${ref}' has active mapping -> removing old buttons before send`);
			await cleanupButtonsForRef(ref);
		}

		const shortId = generateShortId();
		const text = renderTelegramText(msg);
		const replyMarkup = buildButtons({ msg, shortId });

		const level = typeof msg.level === 'number' ? msg.level : Number(msg.level);
		const silentUpTo = Number.isFinite(cfg.disableNotificationUpToLevel)
			? cfg.disableNotificationUpToLevel
			: DEFAULT_DISABLE_NOTIFICATION_UP_TO_LEVEL;
		const disable_notification = Number.isFinite(level) ? level <= silentUpTo : false;

		// Telegram adapter broadcast path: use explicit `chatId: ''` (as used in reference scripts)
		// so parse_mode handling stays consistent.
		const res = await send({
			chatId: '',
			text: text.html,
			parse_mode: 'HTML',
			reply_markup: replyMarkup,
			disable_notification,
		});

		const chatMessages = parseSendResponse(res);
		if (replyMarkup && Object.keys(chatMessages).length > 0) {
			upsertRefMapping({ ref, shortId, text, chatMessages });
			await saveMappings();
			debug(
				`notify: sent ref='${ref}' shortId='${shortId}' chats=${Object.keys(chatMessages).length} mapping=saved`,
			);
		} else if (replyMarkup) {
			debug(`notify: sent ref='${ref}' shortId='${shortId}' mapping=skipped (no send response mapping)`);
		}
	};

	const acquireLock = ({ shortId, chatId }) => {
		const key = `${shortId}:${String(chatId)}`;
		const now = Date.now();
		const current = locks.get(key) || 0;
		if (current > now) {
			return false;
		}
		locks.set(key, now + 5000);
		return true;
	};

	const releaseLock = ({ shortId, chatId }) => {
		const key = `${shortId}:${String(chatId)}`;
		locks.delete(key);
	};

	const replyUnknownCommand = async chatId => {
		const text = String(t('Unknown command. Try /start.')).trim();
		await send({ chatId, text });
	};

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

	const buildConfirmationHtml = ({ baseHtml, msg, actionId, snoozeForMs = NaN }) => {
		const actions = Array.isArray(msg?.actions) ? msg.actions : [];
		const a =
			actions.find(x => x && typeof x === 'object' && typeof x.id === 'string' && x.id === actionId) || null;
		const type = typeof a?.type === 'string' ? a.type.trim() : '';

		if (type === 'snooze') {
			const forMs = Number.isFinite(snoozeForMs) ? snoozeForMs : getSnoozeForMs(a);
			const d = Number.isFinite(forMs) ? formatDuration(forMs) : '';
			const label = String(d ? t("Alright — I'll remind you in %s.", d) : t("Alright — I'll remind you later."));
			return `${baseHtml}\n\n✅ ${escapeHtml(label)}`;
		}

		if (type === 'ack') {
			return `${baseHtml}\n\n✅ ${escapeHtml(String(t("Got it — I won't bother you with this again.")))}`;
		}
		if (type === 'close') {
			return `${baseHtml}\n\n✅ ${escapeHtml(String(t('Nice — marked as done.')))}`;
		}
		if (type === 'delete') {
			return `${baseHtml}\n\n✅ ${escapeHtml(String(t('Alright — removed.')))}`;
		}

		return `${baseHtml}\n\n✅ ${escapeHtml(String(type || actionId))}`;
	};

	const handleCallback = async ({ chatId, messageId, userLabel, payload }) => {
		const raw = String(payload || '');
		const data = raw.startsWith(CALLBACK_PREFIX) ? raw.slice(CALLBACK_PREFIX.length) : '';
		const idx = data.indexOf(':');
		if (idx < 0) {
			return;
		}
		const shortId = data.slice(0, idx).trim();
		const rest = data.slice(idx + 1).trim();
		const idx2 = rest.indexOf(':');
		const actionId = (idx2 >= 0 ? rest.slice(0, idx2) : rest).trim();
		const arg = idx2 >= 0 ? rest.slice(idx2 + 1).trim() : '';
		if (!shortId || !/^[A-Za-z0-9]+$/.test(shortId)) {
			return;
		}
		if (!actionId) {
			return;
		}

		let snoozeForMs = NaN;
		if (arg) {
			const parsed = Number(arg);
			if (Number.isFinite(parsed) && parsed > 0) {
				snoozeForMs = parsed;
			}
		}

		debug(
			`inbound: callback user='${userLabel || ''}' chatId='${String(chatId || '')}' messageId='${String(messageId || '')}' data='${raw}'`,
		);

		if (!acquireLock({ shortId, chatId })) {
			debug(`action: lock busy shortId='${shortId}' chatId='${String(chatId || '')}' -> ignore`);
			return;
		}

		try {
			const ref = mappingShortToRef[shortId];
			if (!ref) {
				debug(`action: shortId='${shortId}' not mapped -> ignore`);
				return;
			}

			const msg = store.getMessageByRef(ref);
			if (!msg) {
				debug(`action: ref='${ref}' not found -> cleanup mapping/buttons`);
				await cleanupButtonsForRef(ref, 'removed message');
				return;
			}

			const execOptions = {
				ref,
				actionId,
				actor: `telegram:${userLabel || chatId}`,
				...(Number.isFinite(snoozeForMs) ? { snoozeForMs } : {}),
			};
			debug(`action: execute ref='${ref}' actionId='${actionId}' actor='telegram:${userLabel || chatId}'`);
			const okAction = action.execute(execOptions);
			debug(`action: result ref='${ref}' actionId='${actionId}' ok=${String(okAction)}`);
			if (!okAction) {
				return;
			}

			const entry = mappingByRef[ref];
			const baseHtml =
				typeof entry?.textHtml === 'string' && entry.textHtml.trim()
					? entry.textHtml
					: renderTelegramText(msg).html;
			const text = buildConfirmationHtml({ baseHtml, msg, actionId, snoozeForMs });

			const mapped = isObject(entry?.chatMessages) ? entry.chatMessages : {};
			const allChatMessages = Object.keys(mapped).length > 0 ? mapped : { [String(chatId)]: messageId };

			const tasks = Object.entries(allChatMessages).map(([cId, mId]) =>
				editMessageRemoveButtons({ chatId: cId, messageId: Number(mId), text }),
			);
			await Promise.all(tasks);

			debug(`action: edited messages ref='${ref}' chats=${Object.keys(allChatMessages).length} buttons=removed`);

			deleteRefMapping(ref);
			await saveMappings();
		} finally {
			releaseLock({ shortId, chatId });
		}
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

		debug(
			`inbound: request raw='${String(raw)}' user='${parsed.userLabel}' chatId='${String(chatId || '')}' messageId='${String(messageId || '')}'`,
		);

		if (typeof payload === 'string' && payload.trim().startsWith(CALLBACK_PREFIX)) {
			await handleCallback({ chatId, messageId, userLabel: parsed.userLabel, payload: payload.trim() });
			return;
		}

		await handleCommand({ chatId, userLabel: parsed.userLabel, payload });
	};

	return Object.freeze({
		start: async ctx => {
			ensureInitialized(ctx);
			if (started) {
				return;
			}

			await Promise.all([
				ensureState(mappingRefStateId, 'EngageTelegram mapping by ref (json)'),
				ensureState(mappingShortStateId, 'EngageTelegram mapping shortId -> ref (json)'),
			]);

			const loadedByRef = await loadJsonState(mappingRefStateId);
			if (loadedByRef && typeof loadedByRef === 'object') {
				mappingByRef = loadedByRef;
			}
			const loadedShort = await loadJsonState(mappingShortStateId);
			if (loadedShort && typeof loadedShort === 'object') {
				mappingShortToRef = loadedShort;
			}

			const pattern = `${cfg.telegramInstance}.communicate.*`;
			iobroker.subscribe.subscribeForeignStates(pattern);

			started = true;
			log.info('started');
		},
		stop: async ctx => {
			ensureInitialized(ctx);
			if (!started) {
				return;
			}
			const pattern = `${cfg.telegramInstance}.communicate.*`;
			iobroker.subscribe.unsubscribeForeignStates(pattern);
			started = false;
			log.info('stopped');
		},
		onStateChange: (id, state, ctx) => {
			ensureInitialized(ctx);
			const requestId = `${cfg.telegramInstance}.communicate.request`;
			if (id !== requestId) {
				return;
			}
			handleRequestStateChange(id, state).catch(e => log.warn(`handle request failed: ${e?.message || e}`));
		},
		onNotifications: (event, notifications, ctx) => {
			ensureInitialized(ctx);
			const list = Array.isArray(notifications) ? notifications : [];
			if (list.length === 0) {
				return;
			}

			const ev = typeof event === 'string' ? event.trim().toLowerCase() : '';
			const isCleanupEvent = ev === 'deleted' || ev === 'expired' || ev === 'closed';
			const isDueEvent = ev === 'due';

			for (const msg of list) {
				if (!msg || typeof msg !== 'object') {
					continue;
				}
				const ref = typeof msg.ref === 'string' ? msg.ref.trim() : '';
				if (!ref) {
					continue;
				}

				if (isCleanupEvent) {
					const reason = `${ev} message`;
					cleanupButtonsForRef(ref, reason).catch(e => log.warn(`cleanup failed: ${e?.message || e}`));
					continue;
				}

				// Pushover-like behavior: only dispatch Telegram notifications on `due`.
				if (!isDueEvent) {
					continue;
				}

				sendNotification(msg).catch(e => log.warn(`send failed: ${e?.message || e}`));
			}
		},
	});
}

module.exports = { EngageTelegram, manifest };
