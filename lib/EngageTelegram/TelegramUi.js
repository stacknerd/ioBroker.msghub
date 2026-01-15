/**
 * TelegramUi (EngageTelegram)
 * ==========================
 *
 * Pure helpers for Telegram message rendering and inline keyboard building.
 *
 * This module is intentionally side-effect free:
 * - No ioBroker access
 * - No MappingStore access
 * - No network calls
 *
 * The goal is readable, testable UI construction that the engine can use for:
 * - due notification send
 * - menu navigation (menu -> actions -> back)
 * - future chat commands like `/tasks`
 */

'use strict';

/**
 * Create a Telegram UI helper with bound configuration.
 *
 * Why a factory:
 * - keeps call sites small (`ui.render...`, `ui.build...`)
 * - reduces parameter plumbing across the code base
 * - keeps helpers private (better reading flow)
 *
 * @param {object} deps Dependencies (pure values/functions only).
 * @param {string} deps.callbackPrefix Prefix used for callback_data (usually `opt_`).
 * @param {Function} deps.t Translation function `(key, ...args) => string`.
 * @param {object} deps.iconByLevel Mapping `level -> icon`.
 * @param {object} deps.iconByKind Mapping `kind -> icon`.
 * @returns {object} UI API.
 */
function createTelegramUi({ callbackPrefix, t, iconByLevel, iconByKind }) {
	const prefix = typeof callbackPrefix === 'string' ? callbackPrefix : '';
	const translate = typeof t === 'function' ? t : s => s;
	const iconsLevel = iconByLevel && typeof iconByLevel === 'object' ? iconByLevel : {};
	const iconsKind = iconByKind && typeof iconByKind === 'object' ? iconByKind : {};

	// Default snooze choices (UX proposal). The engine can choose to override this later.
	const HOUR_MS = 60 * 60 * 1000;
	const DEFAULT_SNOOZE_CHOICES_MS = Object.freeze([1, 4, 8, 12, 24].map(h => h * HOUR_MS));

	/**
	 * Normalize a MsgHub actions list.
	 *
	 * @param {object} msg MsgHub message.
	 * @returns {Array<{ type: string, id: string, payload: any }>} Normalized actions list.
	 */
	const readActions = msg => {
		const actions = Array.isArray(msg?.actions) ? msg.actions : [];
		const out = [];
		for (const a of actions) {
			if (!a || typeof a !== 'object') {
				continue;
			}
			const type = typeof a.type === 'string' ? a.type.trim().toLowerCase() : '';
			const id = typeof a.id === 'string' ? a.id.trim() : '';
			if (!type || !id) {
				continue;
			}
			out.push({ type, id, payload: a.payload });
		}
		return out;
	};

	/**
	 * Pick the first action id for a given type.
	 *
	 * @param {Array<{ type: string, id: string, payload: any }>} actions Normalized actions list.
	 * @param {string} type Action type.
	 * @returns {string} actionId or empty string.
	 */
	const findActionId = (actions, type) => {
		const t = typeof type === 'string' ? type.trim().toLowerCase() : '';
		if (!t) {
			return '';
		}
		const entry = actions.find(a => a.type === t);
		return entry ? entry.id : '';
	};

	/**
	 * Extract an URL from a navigation payload.
	 *
	 * The MessageModel does not enforce a strict schema for `open/link` payloads.
	 * We therefore support a small set of common keys.
	 *
	 * @param {object|null|undefined} payload Action payload.
	 * @returns {string} URL or empty string.
	 */
	const extractUrl = payload => {
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
			return '';
		}
		const candidates = ['url', 'href', 'link'];
		for (const k of candidates) {
			const v = Reflect.get(payload, k);
			if (typeof v === 'string' && v.trim()) {
				return v.trim();
			}
		}
		return '';
	};

	/**
	 * Normalize text for Telegram:
	 * - normalize CRLF to LF
	 * - interpret literal "\\n" as newline (some sources store text that way)
	 *
	 * @param {string} text Raw input.
	 * @returns {string} Normalized text.
	 */
	const normalizeTelegramText = text =>
		String(text || '')
			.replace(/\r\n/g, '\n')
			.replace(/\\n/g, '\n');

	/**
	 * Escape plain text for usage inside Telegram HTML mode.
	 *
	 * @param {string} text Raw input.
	 * @returns {string} Escaped string.
	 */
	const escapeHtml = text =>
		String(text || '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');

	/**
	 * Render a MsgHub message as Telegram text.
	 *
	 * Output:
	 * - `html`: safe HTML string for `parse_mode: 'HTML'` (escapes title/body)
	 * - `plain`: non-escaped variant (useful for debugging or adapters with odd HTML handling)
	 *
	 * @param {object} msg MsgHub message.
	 * @returns {{ html: string, plain: string }} Rendered text variants.
	 */
	const renderNotificationText = msg => {
		const level = typeof msg?.level === 'number' ? msg.level : Number(msg?.level);
		const kind = typeof msg?.kind === 'string' ? msg.kind.trim().toLowerCase() : '';

		const iconLevel = iconsLevel[level] || '';
		const iconKind = iconsKind[kind] || '';

		const rawTitle = normalizeTelegramText(`${iconKind}${iconLevel} ${String(msg?.title || '').trim()}`.trim());
		const rawBody = normalizeTelegramText(String(msg?.text || '').trim());

		// Telegram HTML is not Markdown; we treat incoming text as plain text and escape it.
		const titleHtml = escapeHtml(rawTitle);
		const bodyHtml = escapeHtml(rawBody);

		const html =
			titleHtml && bodyHtml ? `<b>${titleHtml}</b>\n\n${bodyHtml}` : titleHtml ? `<b>${titleHtml}</b>` : bodyHtml;
		const plain = rawTitle && rawBody ? `${rawTitle}\n\n${rawBody}` : rawTitle ? rawTitle : rawBody;

		return { html, plain };
	};

	/**
	 * Determine if a message exposes any actions at all.
	 *
	 * We keep this very forgiving: any object entry counts as "an action exists".
	 * The engine / later UI can do strict allow-listing by `type` / `id`.
	 *
	 * @param {object} msg MsgHub message.
	 * @returns {boolean} True if any action object exists.
	 */
	const hasAnyActions = msg => Array.isArray(msg?.actions) && msg.actions.some(a => a && typeof a === 'object');

	/**
	 * Compute the action set that is eligible to show up in the menu.
	 *
	 * This is where we apply the allow-list:
	 * - must exist in `msg.actions[]` (core allow-list)
	 * - must be enabled by plugin options (UI allow-list)
	 *
	 * @param {object} msg MsgHub message.
	 * @param {object} [opts] Options.
	 * @param {boolean} [opts.enableAck] Enable showing `ack` actions in the menu.
	 * @param {boolean} [opts.enableClose] Enable showing `close` actions in the menu.
	 * @param {boolean} [opts.enableSnooze] Enable showing `snooze` submenu in the menu.
	 * @param {boolean} [opts.enableOpen] Enable showing `open` navigation action in the menu.
	 * @param {boolean} [opts.enableLink] Enable showing `link` navigation action in the menu.
	 * @returns {object} Menu model.
	 */
	const getMenuModel = (msg, opts = {}) => {
		const actions = readActions(msg);

		const enableAck = opts.enableAck !== false;
		const enableClose = opts.enableClose !== false;
		const enableSnooze = opts.enableSnooze !== false;
		const enableOpen = opts.enableOpen !== false;
		const enableLink = opts.enableLink !== false;

		const ackId = enableAck ? findActionId(actions, 'ack') : '';
		const closeId = enableClose ? findActionId(actions, 'close') : '';
		const snoozeId = enableSnooze ? findActionId(actions, 'snooze') : '';
		const openId = enableOpen ? findActionId(actions, 'open') : '';
		const linkId = enableLink ? findActionId(actions, 'link') : '';

		// For navigation actions, prefer URL buttons if possible.
		const openUrl = openId ? extractUrl(actions.find(a => a.id === openId)?.payload) : '';
		const linkUrl = linkId ? extractUrl(actions.find(a => a.id === linkId)?.payload) : '';

		const hasAny = Boolean(ackId) || Boolean(closeId) || Boolean(snoozeId) || Boolean(openId) || Boolean(linkId);

		return Object.freeze({
			hasAny,
			ack: ackId ? { id: ackId } : null,
			close: closeId ? { id: closeId } : null,
			snooze: snoozeId ? { id: snoozeId, choicesMs: DEFAULT_SNOOZE_CHOICES_MS } : null,
			open: openId ? { id: openId, url: openUrl } : null,
			link: linkId ? { id: linkId, url: linkUrl } : null,
		});
	};

	/**
	 * Determine if a message should show a "Menu" entry button.
	 *
	 * Unlike `hasAnyActions`, this respects the menu allow-list (`ack/close/snooze/open/link`).
	 *
	 * @param {object} msg MsgHub message.
	 * @param {object} [opts] See `getMenuModel`.
	 * @returns {boolean} True if at least one menu-eligible action exists.
	 */
	const hasAnyMenuActions = (msg, opts) => getMenuModel(msg, opts).hasAny;

	/**
	 * Build the minimal "menu entry" keyboard:
	 * - exactly one button
	 * - callback payload only signals the desire to open the menu (no actions executed here)
	 *
	 * Callback format:
	 * - `<prefix><shortId>:menu`
	 *
	 * @param {string} shortId Short id (must be non-empty).
	 * @returns {object|null} Telegram `reply_markup` or null if `shortId` is invalid.
	 */
	const buildMenuEntryKeyboard = shortId => {
		const sid = typeof shortId === 'string' ? shortId.trim() : '';
		if (!sid) {
			return null;
		}
		return {
			inline_keyboard: [
				[
					{
						text: String(translate('msghub.i18n.EngageTelegram.ui.menuEntry.label')),
						callback_data: `${prefix}${sid}:menu`,
					},
				],
			],
		};
	};

	/**
	 * Build the root menu keyboard (first-level menu).
	 *
	 * Callback format (engine-interpreted):
	 * - Execute core action: `<prefix><shortId>:act:<actionId>`
	 * - Navigate to snooze submenu: `<prefix><shortId>:nav:snooze`
	 * - Back to message (menu entry): `<prefix><shortId>:nav:back`
	 *
	 * For `open/link`, we prefer URL buttons if a URL is present. Otherwise we emit a callback:
	 * - `<prefix><shortId>:nav:open:<actionId>`
	 * - `<prefix><shortId>:nav:link:<actionId>`
	 *
	 * @param {object} params Params.
	 * @param {string} params.shortId Short id.
	 * @param {object} params.msg MsgHub message.
	 * @param {object} [params.opts] See `getMenuModel`.
	 * @returns {object|null} Telegram `reply_markup` or null if no menu actions exist.
	 */
	const buildMenuRootKeyboard = ({ shortId, msg, opts }) => {
		const sid = typeof shortId === 'string' ? shortId.trim() : '';
		if (!sid) {
			return null;
		}

		const menu = getMenuModel(msg, opts);
		if (!menu.hasAny) {
			return null;
		}

		const rows = [];
		const rowMain = [];

		if (menu.ack) {
			rowMain.push({
				text: String(translate('msghub.i18n.EngageTelegram.ui.action.ack.label')),
				callback_data: `${prefix}${sid}:act:${menu.ack.id}`,
			});
		}
		if (menu.close) {
			rowMain.push({
				text: String(translate('msghub.i18n.EngageTelegram.ui.action.close.label')),
				callback_data: `${prefix}${sid}:act:${menu.close.id}`,
			});
		}
		if (rowMain.length > 0) {
			rows.push(rowMain);
		}

		// Navigation-only actions.
		const navRow = [];
		if (menu.open) {
			if (menu.open.url) {
				navRow.push({ text: String(translate('msghub.i18n.EngageTelegram.ui.action.open.label')), url: menu.open.url });
			} else {
				navRow.push({
					text: String(translate('msghub.i18n.EngageTelegram.ui.action.open.label')),
					callback_data: `${prefix}${sid}:nav:open:${menu.open.id}`,
				});
			}
		} else if (menu.link) {
			if (menu.link.url) {
				navRow.push({ text: String(translate('msghub.i18n.EngageTelegram.ui.action.open.label')), url: menu.link.url });
			} else {
				navRow.push({
					text: String(translate('msghub.i18n.EngageTelegram.ui.action.open.label')),
					callback_data: `${prefix}${sid}:nav:link:${menu.link.id}`,
				});
			}
		}
		if (navRow.length > 0) {
			rows.push(navRow);
		}

		// Snooze entry goes into its own row for visual focus.
		if (menu.snooze) {
			rows.push([
				{
					text: String(translate('msghub.i18n.EngageTelegram.ui.action.snooze.label')),
					callback_data: `${prefix}${sid}:nav:snooze`,
				},
			]);
		}

		// Back to message (collapses to the entry keyboard).
		rows.push([
			{
				text: String(translate('msghub.i18n.EngageTelegram.ui.nav.back.label')),
				callback_data: `${prefix}${sid}:nav:back`,
			},
		]);

		return { inline_keyboard: rows };
	};

	/**
	 * Build the snooze submenu keyboard.
	 *
	 * Callback format:
	 * - Execute snooze action with override: `<prefix><shortId>:act:<snoozeActionId>:<forMs>`
	 * - Back to root menu: `<prefix><shortId>:nav:root`
	 * - Back to message: `<prefix><shortId>:nav:back`
	 *
	 * @param {object} params Params.
	 * @param {string} params.shortId Short id.
	 * @param {object} params.msg MsgHub message.
	 * @param {object} [params.opts] See `getMenuModel`.
	 * @returns {object|null} Telegram `reply_markup` or null if snooze is not available.
	 */
	const buildSnoozeKeyboard = ({ shortId, msg, opts }) => {
		const sid = typeof shortId === 'string' ? shortId.trim() : '';
		if (!sid) {
			return null;
		}

		const menu = getMenuModel(msg, opts);
		if (!menu.snooze) {
			return null;
		}

		const rows = [];
		for (const ms of menu.snooze.choicesMs || []) {
			const hours = Math.round(Number(ms) / HOUR_MS);
			if (!Number.isFinite(hours) || hours <= 0) {
				continue;
			}
			rows.push([
				{
					text: String(translate('msghub.i18n.EngageTelegram.ui.snooze.hours.format', String(hours))),
					callback_data: `${prefix}${sid}:act:${menu.snooze.id}:${String(ms)}`,
				},
			]);
		}

		rows.push([
			{
				text: String(translate('msghub.i18n.EngageTelegram.ui.nav.back.label')),
				callback_data: `${prefix}${sid}:nav:root`,
			},
		]);
		rows.push([
			{
				text: String(translate('msghub.i18n.EngageTelegram.ui.nav.message.label')),
				callback_data: `${prefix}${sid}:nav:back`,
			},
		]);

		return { inline_keyboard: rows };
	};

	return Object.freeze({
		normalizeTelegramText,
		escapeHtml,
		renderNotificationText,
		hasAnyActions,
		hasAnyMenuActions,
		getMenuModel,
		buildMenuEntryKeyboard,
		buildMenuRootKeyboard,
		buildSnoozeKeyboard,
	});
}

module.exports = { createTelegramUi };
