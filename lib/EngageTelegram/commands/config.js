'use strict';

/**
 * Create the `/config` command module used by EngageTelegram.
 *
 * This is a lightweight "self documentation" entry point:
 * - It explains (in human terms) how EngageTelegram decides where it sends notifications.
 * - It points developers/admins to the relevant ioBroker states.
 *
 * We intentionally keep this command read-only and simple:
 * - no mutations
 * - no sensitive details
 *
 * @returns {{ name: string, match: Function, run: Function }} Command module.
 */
function createConfigCommand() {
	/**
	 * Escape text for usage inside Telegram HTML mode.
	 *
	 * Notes:
	 * - `/config` supports HTML formatting in i18n strings.
	 * - Dynamic values must be escaped to avoid malformed markup or injection.
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
	 * Wrap plain text in `<i>...</i>` (safe HTML).
	 *
	 * We keep `/config` intentionally low-tech:
	 * - Use only mild markup (underline + italics).
	 * - Rely on Telegram to highlight bot commands (`/mute`, `/start`, ...).
	 *
	 * @param {string} text Raw input.
	 * @returns {string} Safe italic string.
	 */
	const italics = text => `<i>${escapeHtml(text)}</i>`;

	/**
	 * Render a comma-separated list of italic tokens.
	 *
	 * @param {Array<string>} tokens Input tokens.
	 * @param {string} emptyText Plain fallback text.
	 * @returns {string} Safe HTML string.
	 */
	const renderItalicCsv = (tokens, emptyText) => {
		const list = Array.isArray(tokens) ? tokens.map(s => String(s || '').trim()).filter(Boolean) : [];
		if (list.length === 0) {
			return italics(String(emptyText || '').trim());
		}
		return list.map(s => italics(s)).join(', ');
	};

	/**
	 * Resolve the symbolic MsgConstants level key for a numeric value.
	 *
	 * Example: 20 => "notice" (if `constants.level.notice === 20`)
	 *
	 * @param {object} constants MsgConstants object.
	 * @param {number} value Numeric level value.
	 * @returns {string} Level key (e.g. "notice") or empty string.
	 */
	const resolveLevelKey = (constants, value) => {
		const map = constants?.level && typeof constants.level === 'object' ? constants.level : null;
		if (!map || !Number.isFinite(value)) {
			return '';
		}
		for (const [k, v] of Object.entries(map)) {
			if (Number(v) === Number(value)) {
				return String(k || '').trim();
			}
		}
		return '';
	};

	/**
	 * Resolve a localized level label from a numeric value.
	 *
	 * @param {Function} t i18n translate.
	 * @param {object} constants MsgConstants object.
	 * @param {number} value Numeric level value.
	 * @returns {string} Plain label (no HTML).
	 */
	const resolveLevelLabel = (t, constants, value) => {
		const key = resolveLevelKey(constants, value);
		if (!key) {
			return String(value);
		}
		const labelKey = `msghub.i18n.core.common.MsgConstants.level.${key}.label`;
		const label = String(t(labelKey)).trim();
		return label && label !== labelKey ? label : key;
	};

	/**
	 * Resolve the next higher configured MsgConstants level label.
	 *
	 * This is used for human-friendly wording like:
	 * - "Up to Info: silent"
	 * - "From Notice: with sound"
	 *
	 * @param {Function} t i18n translate.
	 * @param {object} constants MsgConstants object.
	 * @param {number} value Numeric level value.
	 * @returns {string} Plain label (no HTML) or empty string.
	 */
	const resolveNextHigherLevelLabel = (t, constants, value) => {
		const map = constants?.level && typeof constants.level === 'object' ? constants.level : null;
		if (!map || !Number.isFinite(value)) {
			return '';
		}
		const levels = Object.entries(map)
			.map(([k, v]) => [String(k || '').trim(), Number(v)])
			.filter(([k, v]) => k && Number.isFinite(v))
			.sort((a, b) => Number(a[1]) - Number(b[1]));

		const next = levels.find(([_k, v]) => Number(v) > value);
		return next ? resolveLevelLabel(t, constants, Number(next[1])) : '';
	};

	return Object.freeze({
		name: 'config',
		match: ({ command }) => command === 'config',
		run: async ({ chatId, telegramInstance, sendTo, i18n, cfg, chatRegistry, constants, gateOpen, coreConfig }) => {
			const t = i18n?.t || ((s, ..._args) => s);
			const id = typeof chatId === 'string' || typeof chatId === 'number' ? String(chatId).trim() : '';
			if (!id) {
				return;
			}

			// ----- Dynamic config snapshot (escaped) -----
			const kinds = cfg?.kinds instanceof Set ? Array.from(cfg.kinds).sort() : [];
			const kindLabels = kinds
				.map(kindId => {
					const id = String(kindId || '').trim();
					if (!id) {
						return '';
					}
					const labelKey = `msghub.i18n.core.common.MsgConstants.kind.${id}.label`;
					const label = String(t(labelKey)).trim();
					return label && label !== labelKey ? label : id;
				})
				.filter(Boolean);
			const kindFilterText = renderItalicCsv(
				kindLabels,
				String(t('msghub.i18n.EngageTelegram.command.config.common.all.text')).trim(),
			);

			const minLevel = Number.isFinite(cfg?.levelMin) ? Number(cfg.levelMin) : NaN;
			const maxLevel = Number.isFinite(cfg?.levelMax) ? Number(cfg.levelMax) : NaN;
			const silentUpTo = Number.isFinite(cfg?.disableNotificationUpToLevel)
				? Number(cfg.disableNotificationUpToLevel)
				: NaN;

			const minLevelLabel = resolveLevelLabel(t, constants, minLevel);
			const maxLevelLabel = resolveLevelLabel(t, constants, maxLevel);
			const silentUpToLabel = resolveLevelLabel(t, constants, silentUpTo);
			const nextAfterSilentLabel = resolveNextHigherLevelLabel(t, constants, silentUpTo);

			const audienceTagsAny = Array.isArray(cfg?.audienceTagsAny) ? cfg.audienceTagsAny : [];
			const audienceTagsAnyText = renderItalicCsv(
				audienceTagsAny,
				String(t('msghub.i18n.EngageTelegram.command.config.common.none.text')).trim(),
			);

			// Gate configuration: show in a human readable way, but without leaking state values.
			const gateConfigured = Boolean(cfg?.gateStateId) && Boolean(cfg?.gateOp);
			const gateStatusText = gateConfigured
				? gateOpen === true
					? String(t('msghub.i18n.EngageTelegram.command.config.section.gate.status.open.text')).trim()
					: gateOpen === false
						? String(t('msghub.i18n.EngageTelegram.command.config.section.gate.status.closed.text')).trim()
						: String(t('msghub.i18n.EngageTelegram.command.config.section.gate.status.unknown.text')).trim()
				: '';
			const gateBypassFromLabel = resolveLevelLabel(t, constants, Number(cfg?.gateBypassFromLevel));

			// Recipient registry stats (private/group + mute).
			const reg = typeof chatRegistry?.getAll === 'function' ? chatRegistry.getAll() : { chats: {} };
			const chats = reg?.chats && typeof reg.chats === 'object' ? reg.chats : {};
			let privateCount = 0;
			let groupCount = 0;
			let mutedCount = 0;
			for (const c of Object.values(chats)) {
				if (!c || typeof c !== 'object') {
					continue;
				}
				if (c.type === 'group') {
					groupCount += 1;
				} else {
					privateCount += 1;
				}
				if (c.muted === true) {
					mutedCount += 1;
				}
			}

			// Menu actions (what this plugin is willing to expose via the inline menu).
			const ui = cfg?.uiOpts && typeof cfg.uiOpts === 'object' ? cfg.uiOpts : {};
			const allowedActions = [];
			const disabledActions = [];
			const pushAction = (optEnabled, labelKey, fallback) => {
				const label = String(t(labelKey)).trim() || String(fallback || '').trim();
				const safe = italics(label);
				(optEnabled ? allowedActions : disabledActions).push(safe);
			};
			pushAction(ui.enableAck !== false, 'msghub.i18n.EngageTelegram.ui.action.ack.label', 'Ack');
			pushAction(ui.enableClose !== false, 'msghub.i18n.EngageTelegram.ui.action.close.label', 'Close');
			pushAction(ui.enableSnooze !== false, 'msghub.i18n.EngageTelegram.ui.action.snooze.label', 'Snooze');
			// "Open" is shown for `open` and (if enabled) `link` actions.
			pushAction(
				ui.enableOpen !== false || ui.enableLink !== false,
				'msghub.i18n.EngageTelegram.ui.action.open.label',
				'Open',
			);

			const allowedActionsText = allowedActions.length
				? allowedActions.join(', ')
				: italics(String(t('msghub.i18n.EngageTelegram.command.config.common.none.text')).trim());
			const disabledActionsText = disabledActions.length
				? disabledActions.join(', ')
				: italics(String(t('msghub.i18n.EngageTelegram.command.config.common.none.text')).trim());

			// ----- Reference lists (server-defined kinds/levels) -----
			const allKinds = constants?.kind && typeof constants.kind === 'object' ? Object.values(constants.kind) : [];
			const knownKindLabels = allKinds
				.map(k => {
					const kindId = String(k || '').trim();
					if (!kindId) {
						return '';
					}
					const labelKey = `msghub.i18n.core.common.MsgConstants.kind.${kindId}.label`;
					const label = String(t(labelKey)).trim();
					return label && label !== labelKey ? label : kindId;
				})
				.filter(Boolean);
			const knownKindsText = renderItalicCsv(
				knownKindLabels,
				String(t('msghub.i18n.EngageTelegram.command.config.common.none.text')).trim(),
			);

			const allLevels =
				constants?.level && typeof constants.level === 'object' ? Object.entries(constants.level) : [];
			allLevels.sort((a, b) => Number(a[1]) - Number(b[1]));
			const levelScaleLines = allLevels
				.map(([key]) => {
					const k = String(key || '').trim();
					if (!k) {
						return '';
					}
					const labelKey = `msghub.i18n.core.common.MsgConstants.level.${k}.label`;
					const longKey = `msghub.i18n.core.common.MsgConstants.level.${k}Long.label`;

					const label = String(t(labelKey)).trim();
					const long = String(t(longKey)).trim();

					const labelResolved = label && label !== labelKey ? label : k;
					const longResolved = long && long !== longKey ? long : '';

					// If long label follows "<short> — <desc>", only show the description part.
					let desc = '';
					const prefix = `${labelResolved} — `;
					if (longResolved.startsWith(prefix)) {
						desc = longResolved.slice(prefix.length).trim();
					} else if (longResolved && longResolved !== labelResolved) {
						desc = longResolved;
					}
					return desc ? `${italics(labelResolved)} — ${escapeHtml(desc)}` : `${italics(labelResolved)}`;
				})
				.filter(Boolean);

			// ----- Assemble message with i18n headings/labels -----
			const lines = [];
			lines.push(String(t('msghub.i18n.EngageTelegram.command.config.title')).trim());
			lines.push(String(t('msghub.i18n.EngageTelegram.command.config.intro.text')).trim());
			lines.push(String(t('msghub.i18n.EngageTelegram.command.config.tip.text')).trim());
			lines.push('');

			lines.push(
				`<u>${escapeHtml(String(t('msghub.i18n.EngageTelegram.command.config.section.filter.title')).trim())}</u>`,
			);
			lines.push(
				String(t('msghub.i18n.EngageTelegram.command.config.section.filter.kinds.text', kindFilterText)).trim(),
			);
			lines.push(
				String(
					t(
						'msghub.i18n.EngageTelegram.command.config.section.filter.levelRange.text',
						italics(minLevelLabel),
						italics(maxLevelLabel),
					),
				).trim(),
			);
			if (silentUpToLabel && nextAfterSilentLabel) {
				lines.push(
					String(
						t(
							'msghub.i18n.EngageTelegram.command.config.section.filter.silent.text',
							italics(silentUpToLabel),
							italics(nextAfterSilentLabel),
						),
					).trim(),
				);
			} else if (silentUpToLabel) {
				lines.push(
					String(
						t(
							'msghub.i18n.EngageTelegram.command.config.section.filter.silentFallback.text',
							italics(silentUpToLabel),
						),
					).trim(),
				);
			}
			lines.push(
				String(
					t(
						'msghub.i18n.EngageTelegram.command.config.section.filter.audienceTagsAny.text',
						audienceTagsAnyText,
					),
				).trim(),
			);
			lines.push('');

			lines.push(
				`<u>${escapeHtml(String(t('msghub.i18n.EngageTelegram.command.config.section.quietHours.title')).trim())}</u>`,
			);
			// Quiet hours are a *core feature* and must be read from the host-provided effective config snapshot.
			// This avoids leaking core internals (store private fields) into plugins.
			const quietHours = coreConfig?.quietHours || null;
			if (!quietHours) {
				lines.push(
					String(t('msghub.i18n.EngageTelegram.command.config.section.quietHours.disabled.text')).trim(),
				);
			} else {
				const toHm = min => {
					const total = Number(min);
					if (!Number.isFinite(total)) {
						return '';
					}
					const h = Math.floor(total / 60) % 24;
					const m = Math.floor(total % 60);
					const hh = String(h).padStart(2, '0');
					const mm = String(m).padStart(2, '0');
					return `${hh}:${mm}`;
				};
				const start = toHm(quietHours.startMin);
				const end = toHm(quietHours.endMin);
				const maxLevel = Number.isFinite(quietHours.maxLevel) ? quietHours.maxLevel : NaN;
				const maxLabel = resolveLevelLabel(t, constants, maxLevel);
				const exceptionLabel = resolveNextHigherLevelLabel(t, constants, maxLevel) || maxLabel;

				lines.push(
					String(
						t(
							'msghub.i18n.EngageTelegram.command.config.section.quietHours.enabled.text',
							italics(start),
							italics(end),
							italics(exceptionLabel),
						),
					).trim(),
				);
			}
			lines.push('');

			lines.push(
				`<u>${escapeHtml(
					String(t('msghub.i18n.EngageTelegram.command.config.section.gate.title')).trim(),
				)}</u>`,
			);
			lines.push(String(t('msghub.i18n.EngageTelegram.command.config.section.gate.explain.text')).trim());
			if (!gateConfigured) {
				lines.push(String(t('msghub.i18n.EngageTelegram.command.config.section.gate.disabled.text')).trim());
			} else {
				lines.push(
					String(
						t(
							'msghub.i18n.EngageTelegram.command.config.section.gate.enabled.text',
							italics(gateStatusText),
							italics(gateBypassFromLabel),
						),
					).trim(),
				);
			}
			lines.push('');

			lines.push(
				`<u>${escapeHtml(
					String(t('msghub.i18n.EngageTelegram.command.config.section.chats.title')).trim(),
				)}</u>`,
			);
			lines.push(
				String(
					t(
						'msghub.i18n.EngageTelegram.command.config.section.chats.private.text',
						italics(String(privateCount)),
					),
				).trim(),
			);
			lines.push(
				String(
					t(
						'msghub.i18n.EngageTelegram.command.config.section.chats.groups.text',
						italics(String(groupCount)),
					),
				).trim(),
			);
			lines.push(
				String(
					t(
						'msghub.i18n.EngageTelegram.command.config.section.chats.muted.text',
						italics(String(mutedCount)),
					),
				).trim(),
			);
			lines.push('');

			lines.push(
				`<u>${escapeHtml(String(t('msghub.i18n.EngageTelegram.command.config.section.actions.title')).trim())}</u>`,
			);
			lines.push(
				String(
					t('msghub.i18n.EngageTelegram.command.config.section.actions.allowed.text', allowedActionsText),
				).trim(),
			);
			lines.push(
				String(
					t('msghub.i18n.EngageTelegram.command.config.section.actions.disabled.text', disabledActionsText),
				).trim(),
			);
			lines.push('');

			lines.push(
				`<u>${escapeHtml(String(t('msghub.i18n.EngageTelegram.command.config.section.info.kinds.title')).trim())}</u>`,
			);
			lines.push(
				String(t('msghub.i18n.EngageTelegram.command.config.section.info.kinds.text', knownKindsText)).trim(),
			);
			lines.push('');

			lines.push(
				`<u>${escapeHtml(String(t('msghub.i18n.EngageTelegram.command.config.section.info.levels.title')).trim())}</u>`,
			);
			lines.push(levelScaleLines.length ? levelScaleLines.join('\n') : '-');

			// Keep the final output stable:
			// - trim trailing whitespace
			// - avoid sending empty-only messages
			const text = lines.join('\n').trim();
			if (!text) {
				return;
			}

			await sendTo(telegramInstance, 'send', { chatId: id, text, parse_mode: 'HTML' });
		},
	});
}

module.exports = { createConfigCommand };
