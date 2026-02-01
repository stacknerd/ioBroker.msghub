/**
 * MsgConfig
 * =========
 *
 * Centralized configuration normalization for MsgHub.
 *
 * Why this exists
 * ---------------
 * `main.js` (ioBroker adapter wiring) consumes raw `adapter.config` and currently performs some
 * normalization inline (e.g. quiet hours). Over time, this tends to scatter parsing/validation logic
 * and makes it harder to:
 * - reuse the *effective* configuration in plugins (diagnostics like EngageTelegram `/config`)
 * - keep a single source of truth for config rules
 * - document the effective config model
 *
 * Design goals
 * ------------
 * - Normalize once, then pass normalized config to core constructors (core-private view).
 * - Expose a whitelisted, read-only snapshot for plugins (plugin-public view).
 * - Keep this module pure: no ioBroker access, no file I/O, no timers.
 *
 * Notes
 * -----
 * The repo is shipped as a whole, but we still keep an explicit schema version for the normalized
 * config model so plugins can reason about shape changes intentionally.
 */

'use strict';

const MsgConfig = Object.freeze({
	/**
	 * Normalized config schema version.
	 *
	 * This is intentionally separate from the adapter/package version:
	 * - it documents the shape of the normalized config model
	 * - it allows deliberate, explicit evolution of the plugin-facing config snapshot
	 */
	schemaVersion: 1,

	/**
	 * Normalize the raw adapter configuration into a stable, internal config model.
	 *
	 * Contract
	 * --------
	 * - Returns both a core-private and a plugin-public view.
	 * - Both views are deep-frozen at the top-level (and on nested objects created here).
	 * - `pluginPublic` must not be the same object reference as `corePrivate` (separate copies),
	 *   even if the current field set matches.
	 *
	 * @param {object} params Params.
	 * @param {object} [params.adapterConfig] Raw ioBroker adapter config (`this.config` in `main.js`).
	 * @param {object} [params.decrypted] Optional decrypted secrets (main.js handles decryption).
	 * @param {string} [params.decrypted.aiOpenAiApiKey] Decrypted OpenAI API key.
	 * @param {object} [params.msgConstants] MsgConstants (levels/kinds); used for normalization later.
	 * @param {object} [params.log] Optional logger facade (supports `error|warn|info|debug`).
	 * @returns {{ corePrivate: object, pluginPublic: object, errors: ReadonlyArray<string> }} Normalized config bundle.
	 */
	normalize(params = {}) {
		const errors = [];
		const { adapterConfig: _adapterConfig, decrypted: _decrypted, msgConstants: _msgConstants, log: _log } = params;
		const adapterConfig = _adapterConfig && typeof _adapterConfig === 'object' ? _adapterConfig : {};
		const decrypted = _decrypted && typeof _decrypted === 'object' ? _decrypted : {};
		const msgConstants = _msgConstants && typeof _msgConstants === 'object' ? _msgConstants : null;
		const log = _log && typeof _log === 'object' ? _log : null;

		/**
		 * Record a normalization issue.
		 *
		 * We keep these as stable "codes" (plain strings) so callers/tests can reason about outcomes
		 * without parsing log messages.
		 *
		 * @param {string} code Stable error code.
		 * @param {string} [message] Optional human hint (best-effort logged).
		 * @returns {void}
		 */
		const pushError = (code, message) => {
			const c = typeof code === 'string' ? code.trim() : '';
			if (!c) {
				return;
			}
			errors.push(c);
			if (message && typeof log?.error === 'function') {
				log.error(String(message));
			}
		};

		/**
		 * Parse "HH:MM" into minutes since midnight.
		 *
		 * This intentionally mirrors `main.js` behavior: strict and predictable.
		 *
		 * @param {any} value Raw input.
		 * @param {string} label Field label (for error codes).
		 * @returns {number|null} Minutes since midnight or null on invalid.
		 */
		const parseTimeStringToMinutesStrict = (value, label) => {
			const raw = typeof value === 'string' ? value.trim() : '';
			const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(raw);
			if (!m) {
				pushError(
					`quietHours.disabled.invalidTime.${label}`,
					`MsgConfig: invalid ${label} time '${raw || String(value)}' (expected HH:MM)`,
				);
				return null;
			}
			return Number(m[1]) * 60 + Number(m[2]);
		};

		const safeTrunc = value => {
			const n = typeof value === 'number' ? value : Number(value);
			return Number.isFinite(n) ? Math.trunc(n) : null;
		};

		/**
		 * Normalize store configuration.
		 *
		 * This intentionally centralizes the effective defaults (single source of truth).
		 *
		 * @returns {{ pruneIntervalMs: number, notifierIntervalMs: number, hardDeleteAfterMs: number, hardDeleteIntervalMs: number, hardDeleteBacklogIntervalMs: number, hardDeleteBatchSize: number, hardDeleteStartupDelayMs: number, deleteClosedIntervalMs: number }} Store config.
		 */
		const normalizeStore = () => {
			const pruneIntervalSec = Math.max(0, safeTrunc(adapterConfig?.pruneIntervalSec) ?? 30);
			const notifierIntervalSec = Math.max(0, safeTrunc(adapterConfig?.notifierIntervalSec) ?? 10);
			const hardDeleteAfterHours = Math.max(0, safeTrunc(adapterConfig?.hardDeleteAfterHours) ?? 72);
			const hardDeleteIntervalMs = Math.max(
				0,
				safeTrunc(adapterConfig?.hardDeleteIntervalMs) ?? 1000 * 60 * 60 * 4,
			);
			const hardDeleteBacklogIntervalMs = Math.max(
				0,
				safeTrunc(adapterConfig?.hardDeleteBacklogIntervalMs) ?? 1000 * 5,
			);
			const hardDeleteBatchSize = Math.max(1, safeTrunc(adapterConfig?.hardDeleteBatchSize) ?? 50);
			const hardDeleteStartupDelaySec = Math.max(0, safeTrunc(adapterConfig?.hardDeleteStartupDelaySec) ?? 60);
			const deleteClosedIntervalMs = Math.max(0, safeTrunc(adapterConfig?.deleteClosedIntervalMs) ?? 1000 * 10);

			return Object.freeze({
				pruneIntervalMs: pruneIntervalSec * 1000,
				notifierIntervalMs: notifierIntervalSec * 1000,
				hardDeleteAfterMs: hardDeleteAfterHours * 60 * 60 * 1000,
				hardDeleteIntervalMs,
				hardDeleteBacklogIntervalMs,
				hardDeleteBatchSize,
				hardDeleteStartupDelayMs: hardDeleteStartupDelaySec * 1000,
				deleteClosedIntervalMs,
			});
		};

		/**
		 * Normalize storage configuration.
		 *
		 * @returns {{ writeIntervalMs: number }} Storage config.
		 */
		const normalizeStorage = () => {
			const writeIntervalMs = Math.max(0, safeTrunc(adapterConfig?.writeIntervalMs) ?? 10_000);
			return Object.freeze({ writeIntervalMs });
		};

		/**
		 * Normalize archive configuration.
		 *
		 * @returns {{ keepPreviousWeeks: number, flushIntervalMs: number, maxBatchSize: number }} Archive config.
		 */
		const normalizeArchive = () => {
			const keepPreviousWeeks = Math.max(0, safeTrunc(adapterConfig?.keepPreviousWeeks) ?? 3);
			const archiveFlushIntervalSec = Math.max(0, safeTrunc(adapterConfig?.archiveFlushIntervalSec) ?? 10);
			const archiveMaxBatchSize = Math.max(1, safeTrunc(adapterConfig?.archiveMaxBatchSize) ?? 200);

			return Object.freeze({
				keepPreviousWeeks,
				flushIntervalMs: archiveFlushIntervalSec * 1000,
				maxBatchSize: archiveMaxBatchSize,
			});
		};

		/**
		 * Normalize stats configuration.
		 *
		 * @returns {{ rollupKeepDays: number }} Stats config.
		 */
		const normalizeStats = () => {
			const rollupKeepDays = Math.max(1, safeTrunc(adapterConfig?.rollupKeepDays) ?? 400);
			return Object.freeze({ rollupKeepDays });
		};

		/**
		 * Normalize AI configuration (best-effort; secrets are provided via `params.decrypted`).
		 *
		 * @returns {object} AI config for MsgAi constructor.
		 */
		const normalizeAi = () => {
			const c = adapterConfig && typeof adapterConfig === 'object' ? adapterConfig : {};
			const apiKeyRaw =
				typeof decrypted?.aiOpenAiApiKey === 'string'
					? decrypted.aiOpenAiApiKey
					: typeof c.aiOpenAiApiKey === 'string'
						? c.aiOpenAiApiKey
						: '';

			const parseJsonArray = (value, label) => {
				const text = typeof value === 'string' ? value.trim() : '';
				if (!text) {
					return [];
				}
				try {
					const parsed = JSON.parse(text);
					if (Array.isArray(parsed)) {
						return parsed;
					}
					pushError(`ai.invalidJson.${label}`, `MsgConfig: AI config ${label} is not an array (ignored)`);
					return [];
				} catch {
					pushError(`ai.invalidJson.${label}`, `MsgConfig: AI config invalid JSON for ${label} (ignored)`);
					return [];
				}
			};

			const normalizePurposeModelOverrides = list => {
				if (!Array.isArray(list)) {
					return [];
				}
				const out = [];
				for (const row of list) {
					const purpose = typeof row?.purpose === 'string' ? row.purpose.trim().toLowerCase() : '';
					const model = typeof row?.model === 'string' ? row.model.trim() : '';
					if (!purpose || !model) {
						continue;
					}
					const qualityRaw = typeof row?.quality === 'string' ? row.quality.trim().toLowerCase() : '';
					const quality =
						qualityRaw === 'fast' || qualityRaw === 'balanced' || qualityRaw === 'best' ? qualityRaw : null;
					out.push(Object.freeze({ purpose, quality, model }));
				}
				return out;
			};

			const rawOverrides = parseJsonArray(c.aiPurposeModelOverrides, 'aiPurposeModelOverrides');
			const purposeModelOverrides = Object.freeze(normalizePurposeModelOverrides(rawOverrides));

			return Object.freeze({
				enabled: c.aiEnabled === true,
				provider: c.aiProvider,
				openai: Object.freeze({
					apiKey: String(apiKeyRaw || '').trim(),
					baseUrl: c.aiOpenAiBaseUrl,
					model: c.aiOpenAiModelBalanced || c.aiOpenAiModel,
					modelsByQuality: Object.freeze({
						fast: c.aiOpenAiModelFast,
						balanced: c.aiOpenAiModelBalanced || c.aiOpenAiModel,
						best: c.aiOpenAiModelBest,
					}),
					purposeModelOverrides,
				}),
				timeoutMs: c.aiTimeoutMs,
				maxConcurrency: c.aiMaxConcurrency,
				rpm: c.aiRpm,
				cacheTtlMs: c.aiCacheTtlMs,
			});
		};

		const store = normalizeStore();
		const storage = normalizeStorage();
		const archive = normalizeArchive();
		const stats = normalizeStats();
		const ai = normalizeAi();

		/**
		 * Normalize quiet hours configuration (effective config).
		 *
		 * Rules are mirrored from `main.js`:
		 * - Feature is disabled when notifier polling is disabled (`notifierIntervalMs <= 0`).
		 * - Times must be strict "HH:MM", start != end.
		 * - `maxLevel` and `spreadMin` must be numeric.
		 * - Quiet window must leave >= 4h outside, spread must fit the outside window.
		 *
		 * @returns {{ enabled: true, startMin: number, endMin: number, maxLevel: number, spreadMs: number }|null} Quiet-hours config or null when disabled.
		 */
		const normalizeQuietHours = () => {
			const enabled = adapterConfig?.quietHoursEnabled !== false;
			if (!enabled) {
				return null;
			}
			if (!Number.isFinite(store.notifierIntervalMs) || store.notifierIntervalMs <= 0) {
				pushError(
					'quietHours.disabled.notifierIntervalMs',
					'MsgConfig: quiet hours require notifierIntervalMs > 0 (feature disabled)',
				);
				return null;
			}

			const startMin = parseTimeStringToMinutesStrict(adapterConfig?.quietHoursStart, 'quietHoursStart');
			const endMin = parseTimeStringToMinutesStrict(adapterConfig?.quietHoursEnd, 'quietHoursEnd');
			if (startMin == null || endMin == null) {
				return null;
			}
			if (startMin === endMin) {
				pushError(
					'quietHours.disabled.startEqualsEnd',
					'MsgConfig: quiet hours start == end is not allowed (feature disabled)',
				);
				return null;
			}

			const maxLevelRaw = adapterConfig?.quietHoursMaxLevel;
			const maxLevelParsed = typeof maxLevelRaw === 'number' ? maxLevelRaw : Number(maxLevelRaw);
			const spreadMinRaw = adapterConfig?.quietHoursSpreadMin;
			const spreadMinParsed = typeof spreadMinRaw === 'number' ? spreadMinRaw : Number(spreadMinRaw);

			if (!Number.isFinite(maxLevelParsed) || !Number.isFinite(spreadMinParsed)) {
				pushError(
					'quietHours.disabled.invalidMaxLevelOrSpreadMin',
					'MsgConfig: quiet hours require numeric maxLevel and spreadMin (feature disabled)',
				);
				return null;
			}

			const maxLevel = Math.trunc(maxLevelParsed);
			const spreadMin = Math.max(0, Math.trunc(spreadMinParsed));

			const quietDurationMin = startMin < endMin ? endMin - startMin : 24 * 60 - startMin + endMin;
			const freeMin = 24 * 60 - quietDurationMin;
			if (freeMin < 240) {
				pushError(
					'quietHours.disabled.tooLittleFreeTime',
					'MsgConfig: quiet hours must leave at least 4 hours outside the quiet window (feature disabled)',
				);
				return null;
			}
			if (spreadMin > freeMin) {
				pushError(
					'quietHours.disabled.spreadDoesNotFit',
					'MsgConfig: quiet hours spread window must fit into non-quiet time (feature disabled)',
				);
				return null;
			}

			return Object.freeze({
				enabled: true,
				startMin,
				endMin,
				maxLevel,
				spreadMs: spreadMin * 60 * 1000,
			});
		};

		/**
		 * Normalize render configuration.
		 *
		 * Notes:
		 * - Prefix tokens are normalized as trimmed strings; empty strings disable a prefix.
		 * - Templates are normalized as trimmed strings; empty strings fall back to defaults.
		 *
		 * @returns {object} Render config (core-private).
		 */
		const normalizeRender = () => {
			const normalizeToken = value => {
				if (value == null) {
					return '';
				}
				const s = typeof value === 'string' ? value : String(value);
				return s.trim();
			};

			const normalizeTemplate = (value, fallback) => {
				if (value == null) {
					return fallback;
				}
				const s = typeof value === 'string' ? value : String(value);
				const t = s.trim();
				return t || fallback;
			};

			const titleTemplateDefault = '{{icon}} {{title}}';
			const textTemplateDefault = '{{levelPrefix}} {{text}}';
			const iconTemplateDefault = '{{icon}}';

			const prefixes = Object.freeze({
				level: Object.freeze({
					none: normalizeToken(adapterConfig?.prefixLevelNone),
					info: normalizeToken(adapterConfig?.prefixLevelInfo),
					notice: normalizeToken(adapterConfig?.prefixLevelNotice),
					warning: normalizeToken(adapterConfig?.prefixLevelWarning),
					error: normalizeToken(adapterConfig?.prefixLevelError),
					critical: normalizeToken(adapterConfig?.prefixLevelCritical),
				}),
				kind: Object.freeze({
					task: normalizeToken(adapterConfig?.prefixKindTask),
					status: normalizeToken(adapterConfig?.prefixKindStatus),
					appointment: normalizeToken(adapterConfig?.prefixKindAppointment),
					shoppinglist: normalizeToken(adapterConfig?.prefixKindShoppinglist),
					inventorylist: normalizeToken(adapterConfig?.prefixKindInventorylist),
				}),
			});

			const templates = Object.freeze({
				titleTemplate: normalizeTemplate(adapterConfig?.renderTitleTemplate, titleTemplateDefault),
				textTemplate: normalizeTemplate(adapterConfig?.renderTextTemplate, textTemplateDefault),
				iconTemplate: normalizeTemplate(adapterConfig?.renderIconTemplate, iconTemplateDefault),
				helpText:
					typeof adapterConfig?.renderTemplateHelpText === 'string'
						? adapterConfig.renderTemplateHelpText
						: '',
			});

			const kinds = msgConstants?.kind && typeof msgConstants.kind === 'object' ? msgConstants.kind : null;
			const levels = msgConstants?.level && typeof msgConstants.level === 'object' ? msgConstants.level : null;

			return Object.freeze({
				prefixes,
				templates,
				// Include constants snapshots so downstream code can build derived tokens (kindPrefix/levelPrefix).
				// This is intentionally shallow and stable.
				...(kinds ? { kind: Object.freeze({ ...kinds }) } : {}),
				...(levels ? { level: Object.freeze({ ...levels }) } : {}),
			});
		};

		const quietHours = normalizeQuietHours();
		const render = normalizeRender();

		const corePrivate = Object.freeze({
			store,
			storage,
			archive,
			stats,
			ai,
			quietHours,
			render,
		});

		// Separate copy to keep the plugin-facing snapshot isolated from core-private objects.
		const pluginPublic = Object.freeze({
			quietHours: quietHours ? Object.freeze({ ...quietHours }) : null,
			render: Object.freeze({
				// Whitelist-only: allow plugins to read the effective presentation config.
				prefixes: render?.prefixes || null,
				templates: render?.templates || null,
			}),
			ai: Object.freeze({
				enabled: ai?.enabled === true,
				provider: ai?.provider,
				openai: Object.freeze({
					model: ai?.openai?.model,
					modelsByQuality: ai?.openai?.modelsByQuality,
					purposeModelOverrides: ai?.openai?.purposeModelOverrides,
				}),
				timeoutMs: ai?.timeoutMs,
				maxConcurrency: ai?.maxConcurrency,
				rpm: ai?.rpm,
				cacheTtlMs: ai?.cacheTtlMs,
			}),
		});

		return Object.freeze({ corePrivate, pluginPublic, errors: Object.freeze(errors) });
	},
});

module.exports = { MsgConfig };
