'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

const { MsgFactory } = require(`${__dirname}/src/MsgFactory`);
const { MsgConstants } = require(`${__dirname}/src/MsgConstants`);
const { MsgStore } = require(`${__dirname}/src/MsgStore`);
const { MsgAi } = require(`${__dirname}/src/MsgAi`);
const { createI18nReporter, buildI18nRuntime } = require(`${__dirname}/i18nReporter`);

function decryptIfPossible(adapter, value) {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw || typeof adapter?.decrypt !== 'function') {
		return raw;
	}

	const hasControlChars = s => {
		const str = typeof s === 'string' ? s : '';
		for (let i = 0; i < str.length; i++) {
			const code = str.charCodeAt(i);
			if (code <= 31 || code === 127) {
				return true;
			}
		}
		return false;
	};

	// Avoid "double decrypt" when a value is already plain text (this can happen depending on controller/core versions).
	// Also prevents invalid header values (control chars) from accidentally reaching fetch().
	const looksLikeOpenAiKey = /^sk-(?:proj-)?[A-Za-z0-9_-]{10,}$/.test(raw);
	if (looksLikeOpenAiKey) {
		return raw;
	}

	try {
		const decrypted = String(adapter.decrypt(raw) || '').trim();
		if (!decrypted) {
			return raw;
		}
		if (hasControlChars(decrypted) || /\s/.test(decrypted)) {
			return raw;
		}
		return decrypted;
	} catch {
		return raw;
	}
}

function parseJsonArrayWithWarn(adapter, value, label) {
	const text = typeof value === 'string' ? value.trim() : '';
	if (!text) {
		return [];
	}
	try {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed) ? parsed : [];
	} catch (e) {
		adapter?.log?.warn?.(`MsgAi config: invalid JSON for ${label} (${e?.message || e})`);
		return [];
	}
}

const REDACT_KEYS = new Set(['apiKey', 'token', 'password', 'aiOpenAiApiKey']);
function sanitizeForLog(value) {
	const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
	if (!isObject(value)) {
		return value;
	}
	const out = Array.isArray(value) ? value.slice(0, 50) : { ...value };
	for (const k of Object.keys(out)) {
		if (REDACT_KEYS.has(k)) {
			out[k] = '***';
		} else if (isObject(out[k])) {
			out[k] = sanitizeForLog(out[k]);
		}
	}
	return out;
}

function createMsgAiFromConfig(adapter, config) {
	const c = config && typeof config === 'object' ? config : {};
	return new MsgAi(adapter, {
		enabled: c.aiEnabled === true,
		provider: c.aiProvider,
		openai: {
			apiKey: decryptIfPossible(adapter, c.aiOpenAiApiKey),
			baseUrl: c.aiOpenAiBaseUrl,
			model: c.aiOpenAiModelBalanced || c.aiOpenAiModel,
			modelsByQuality: {
				fast: c.aiOpenAiModelFast,
				balanced: c.aiOpenAiModelBalanced || c.aiOpenAiModel,
				best: c.aiOpenAiModelBest,
			},
			purposeModelOverrides: parseJsonArrayWithWarn(
				adapter,
				c.aiPurposeModelOverrides,
				'aiPurposeModelOverrides',
			),
		},
		timeoutMs: c.aiTimeoutMs,
		maxConcurrency: c.aiMaxConcurrency,
		rpm: c.aiRpm,
		cacheTtlMs: c.aiCacheTtlMs,
	});
}

// Load your modules here, e.g.:
// const fs = require('fs');

class Msghub extends utils.Adapter {
	static eLevel = Object.freeze({ none: 0, notice: 1, warning: 2, error: 3 });
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	constructor(options) {
		super({
			...options,
			name: 'msghub',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('objectChange', this.onObjectChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
		this.msgConstants = MsgConstants;

		// Default locale (overridden via instance config in onReady)
		this.locale = 'en-US';

		// Runtime plugin enable/disable handler  (initialized in onReady)
		this._msgPlugins = null;

		// AdminTab command facade (initialized in onReady)
		this._adminTab = null;

		// Optional i18n runtime reporter (initialized in _i18ninit)
		this._i18nReporter = null;
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		/////////////////////////////////////////
		//    Translator Interface
		/////////////////////////////////////////

		this.locale = typeof this.config.locale === 'string' ? this.config.locale.trim() : this.locale;
		await this._i18ninit(this.locale);

		/////////////////////////////////////////
		// Message Hub Core
		/////////////////////////////////////////

		this.msgFactory = new MsgFactory(this, this.msgConstants);

		const msgAi = createMsgAiFromConfig(this, this.config);
		this.msgAi = msgAi;

		const keepPreviousWeeksRaw = this.config?.keepPreviousWeeks;
		const keepPreviousWeeksParsed =
			typeof keepPreviousWeeksRaw === 'number' ? keepPreviousWeeksRaw : Number(keepPreviousWeeksRaw);
		const keepPreviousWeeks = Number.isFinite(keepPreviousWeeksParsed)
			? Math.max(0, Math.trunc(keepPreviousWeeksParsed))
			: undefined;

		const pruneIntervalSecRaw = this.config?.pruneIntervalSec;
		const pruneIntervalSecParsed =
			typeof pruneIntervalSecRaw === 'number' ? pruneIntervalSecRaw : Number(pruneIntervalSecRaw);
		const pruneIntervalMs = Number.isFinite(pruneIntervalSecParsed)
			? Math.max(0, Math.trunc(pruneIntervalSecParsed)) * 1000
			: undefined;

		const hardDeleteAfterHoursRaw = this.config?.hardDeleteAfterHours;
		const hardDeleteAfterHoursParsed =
			typeof hardDeleteAfterHoursRaw === 'number' ? hardDeleteAfterHoursRaw : Number(hardDeleteAfterHoursRaw);
		const hardDeleteAfterMs = Number.isFinite(hardDeleteAfterHoursParsed)
			? Math.max(0, Math.trunc(hardDeleteAfterHoursParsed)) * 60 * 60 * 1000
			: undefined;

		const hardDeleteBatchSizeRaw = this.config?.hardDeleteBatchSize;
		const hardDeleteBatchSizeParsed =
			typeof hardDeleteBatchSizeRaw === 'number' ? hardDeleteBatchSizeRaw : Number(hardDeleteBatchSizeRaw);
		const hardDeleteBatchSize = Number.isFinite(hardDeleteBatchSizeParsed)
			? Math.max(1, Math.trunc(hardDeleteBatchSizeParsed))
			: undefined;

		const hardDeleteStartupDelaySecRaw = this.config?.hardDeleteStartupDelaySec;
		const hardDeleteStartupDelaySecParsed =
			typeof hardDeleteStartupDelaySecRaw === 'number'
				? hardDeleteStartupDelaySecRaw
				: Number(hardDeleteStartupDelaySecRaw);
		const hardDeleteStartupDelayMs = Number.isFinite(hardDeleteStartupDelaySecParsed)
			? Math.max(0, Math.trunc(hardDeleteStartupDelaySecParsed)) * 1000
			: undefined;

		const archiveFlushIntervalSecRaw = this.config?.archiveFlushIntervalSec;
		const archiveFlushIntervalSecParsed =
			typeof archiveFlushIntervalSecRaw === 'number'
				? archiveFlushIntervalSecRaw
				: Number(archiveFlushIntervalSecRaw);
		const flushIntervalMs = Number.isFinite(archiveFlushIntervalSecParsed)
			? Math.max(0, Math.trunc(archiveFlushIntervalSecParsed)) * 1000
			: undefined;

		const archiveMaxBatchSizeRaw = this.config?.archiveMaxBatchSize;
		const archiveMaxBatchSizeParsed =
			typeof archiveMaxBatchSizeRaw === 'number' ? archiveMaxBatchSizeRaw : Number(archiveMaxBatchSizeRaw);
		const maxBatchSize = Number.isFinite(archiveMaxBatchSizeParsed)
			? Math.max(1, Math.trunc(archiveMaxBatchSizeParsed))
			: undefined;

		const rollupKeepDaysRaw = this.config?.rollupKeepDays;
		const rollupKeepDaysParsed =
			typeof rollupKeepDaysRaw === 'number' ? rollupKeepDaysRaw : Number(rollupKeepDaysRaw);
		const rollupKeepDays = Number.isFinite(rollupKeepDaysParsed)
			? Math.max(1, Math.trunc(rollupKeepDaysParsed))
			: undefined;

		const writeIntervalMsRaw = this.config?.writeIntervalMs;
		const writeIntervalMsParsed =
			typeof writeIntervalMsRaw === 'number' ? writeIntervalMsRaw : Number(writeIntervalMsRaw);
		const writeIntervalMs = Number.isFinite(writeIntervalMsParsed)
			? Math.max(0, Math.trunc(writeIntervalMsParsed))
			: undefined;

		this.msgStore = new MsgStore(this, this.msgConstants, this.msgFactory, {
			pruneIntervalMs,
			hardDeleteAfterMs,
			hardDeleteBatchSize,
			hardDeleteStartupDelayMs,
			archive: { keepPreviousWeeks, flushIntervalMs, maxBatchSize },
			storage: { writeIntervalMs },
			stats: { rollupKeepDays },
			ai: msgAi,
		});
		await this.msgStore.init();

		/////////////////////////////////////////
		// Message Hub Plugins
		/////////////////////////////////////////

		const { IoAdminTab } = require(`${__dirname}/lib/IoAdminTab`);

		try {
			const { IoPlugins } = require(`${__dirname}/lib/IoPlugins`);
			if (typeof IoPlugins?.create !== 'function') {
				throw new Error('IoPlugins.create is not a function');
			}
			this._msgPlugins = await IoPlugins.create(this, this.msgStore);
		} catch (e) {
			this.log?.error?.(`Plugin wiring failed: ${e?.message || e}`);
		}

		// Keep AdminTab operational even if plugin wiring fails,
		// so Stats/Messages diagnostics remain available.
		this._adminTab = new IoAdminTab(this, this._msgPlugins, { ai: msgAi, msgStore: this.msgStore });

		// Always start ingestion (even when some plugins failed to wire),
		// otherwise timer-based producers (e.g. IngestRandomChaos) never run.
		const ingestMeta = this._msgPlugins?.getIngestMeta?.() || {};
		this.msgStore?.msgIngest?.start?.(ingestMeta);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback - Callback function
	 */
	onUnload(callback) {
		try {
			this.msgStore?.onUnload();
		} catch (error) {
			this.log?.error?.(`Error during unloading: ${error.message}`);
		} finally {
			try {
				this._i18nReporter?.dispose?.();
				this._i18nReporter?.flush?.().catch(() => undefined);
			} catch {
				// ignore
			}
			// Best-effort cleanup (compact mode): drop any direct messagebox handler.
			try {
				this._msgPlugins?.clearMessageboxHandler?.();
			} catch {
				// swallow
			}
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed object changes
	 *
	 * @param {string} id Object id.
	 * @param {ioBroker.Object | null | undefined} obj Object, or `null`/`undefined` when deleted.
	 */
	onObjectChange(id, obj) {
		this.msgStore?.msgIngest?.dispatchObjectChange?.(id, obj, { source: 'iobroker.objectChange' });
	}

	/**
	 * Is called if a subscribed state changes
	 *
	 * @param {string} id - State ID
	 * @param {ioBroker.State | null | undefined} state - State object
	 */
	onStateChange(id, state) {
		// Intercept plugin enable/disable switches (source of truth).
		if (this._msgPlugins?.handleStateChange?.(id, state)) {
			return;
		}

		if (state) {
			// Forward the raw event to producer plugins (they decide what to do with ack/val changes).
			this.msgStore?.msgIngest?.dispatchStateChange?.(id, state, { source: 'iobroker.stateChange' });

			// The state was changed
			this.log?.silly?.(`MsgHub main.js: state ${id} changed: ${state.val} (ack = ${state.ack})`);

			if (state.ack === false) {
				// This is a command from the user (e.g., from the UI or other adapter)
				// and should be processed by the adapter
				this.log?.info?.(`MsgHub main.js: User command received for ${id}: ${state.val}`);
			}
		} else {
			// The object was deleted or the state value has expired
			this.log?.info?.(`state ${id} deleted`);
		}
	}
	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === 'object' && obj.message) {
	// 		if (obj.command === 'send') {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info('send command');

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
	// 		}
	// 	}
	// }
	async onMessage(obj) {
		if (!obj || !obj.command) {
			return;
		}

		const cmd = obj.command;
		const payload = obj.message;

		this.log?.silly?.(`MsgHub main.js onMessage: '${cmd}' ${JSON.stringify(sanitizeForLog(payload), null, 2)}`);
		let result;

		try {
			if (typeof cmd === 'string' && cmd.startsWith('admin.')) {
				result = await this._handleAdminCommand(cmd, payload);
			} else {
				result = await this._msgPlugins?.dispatchMessagebox?.(obj);
				if (result == null) {
					result = { ok: false, error: { code: 'NOT_READY', message: 'No messagebox handler registered' } };
				}
			}
		} catch (e) {
			this.log?.error?.(`onMessage error: ${e?.message || e}`);
			result = { ok: false, error: { code: 'INTERNAL', message: String(e?.message || e) } };
		}

		if (obj.callback) {
			this.sendTo(obj.from, obj.command, result, obj.callback);
		}
	}

	async _handleAdminCommand(cmd, payload) {
		if (!this._adminTab) {
			if (cmd === 'admin.ai.test') {
				return { native: { aiTestLastResult: 'ERROR NOT_READY: AdminTab runtime not ready' } };
			}
			return { ok: false, error: { code: 'NOT_READY', message: 'AdminTab runtime not ready' } };
		}
		return await this._adminTab.handleCommand(cmd, payload);
	}

	async _i18ninit(locale) {
		const _i18ndebug = false;
		// decide on locale for translation
		const i18nSupport = new Set(['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn']);
		const lang = locale.split('-')[0].trim().toLowerCase();
		const i18nlocale = i18nSupport.has(lang) ? lang : locale;

		await utils.I18n.init(__dirname, i18nlocale);
		this.log?.debug?.(`MsgHub main.js config locale: ${locale} (time and date) / ${i18nlocale} (i18n)`);

		const { i18n, reporter } = buildI18nRuntime({
			adapter: this,
			baseI18n: utils.I18n,
			locale,
			i18nlocale,
			lang,
			createReport: this.config?.createI18nReport === true,
			createI18nReporter,
			debug: _i18ndebug,
		});
		this._i18nReporter = reporter;
		this.i18n = i18n;
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	module.exports = options => new Msghub(options);
} else {
	// otherwise start the instance directly
	new Msghub();
}
