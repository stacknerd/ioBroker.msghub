'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const ioPackage = require('./io-package.json');

const { MsgFactory } = require(`${__dirname}/src/MsgFactory`);
const { MsgConstants } = require(`${__dirname}/src/MsgConstants`);
const { MsgConfig } = require(`${__dirname}/src/MsgConfig`);
const { MsgStore } = require(`${__dirname}/src/MsgStore`);
const { MsgAi } = require(`${__dirname}/src/MsgAi`);
const { IoArchiveResolver } = require(`${__dirname}/lib/IoArchiveResolver`);
const { IoStorageIobroker } = require(`${__dirname}/lib/IoStorageIobroker`);

function buildI18nRuntime(params) {
	const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
	const { adapter, baseI18n, locale, i18nlocale, lang, debug } = p;

	const getI18nFns = i18n => {
		const translateFn =
			typeof i18n?.t === 'function'
				? i18n.t
				: typeof i18n?.translate === 'function'
					? i18n.translate
					: typeof i18n?.default?.t === 'function'
						? i18n.default.t
						: typeof i18n?.default?.translate === 'function'
							? i18n.default.translate
							: null;

		const getTranslatedObjectFn =
			typeof i18n?.getTranslatedObject === 'function'
				? i18n.getTranslatedObject
				: typeof i18n?.default?.getTranslatedObject === 'function'
					? i18n.default.getTranslatedObject
					: null;

		return { translateFn, getTranslatedObjectFn };
	};

	const fixTranslatedObject = (getTranslatedObjectFn, text, strings = []) => {
		let obj =
			typeof getTranslatedObjectFn === 'function' ? getTranslatedObjectFn(text, '%s') : { en: String(text) };
		if (!obj || typeof obj !== 'object') {
			obj = { en: String(text) };
		}
		for (const lang of Object.keys(obj)) {
			let s = obj[lang];
			for (const arg of strings) {
				s = s.replace('%s', String(arg));
			}
			obj[lang] = s;
		}
		return obj;
	};

	const { translateFn, getTranslatedObjectFn } = getI18nFns(baseI18n);

	if (!translateFn) {
		adapter?.log?.warn?.(
			'I18n: adapter-core did not provide a translate function (I18n.t/I18n.translate); falling back to identity translation',
		);
	}

	const i18n = baseI18n
		? Object.freeze({
				t: (...args) => {
					const [key, options] = args;
					if (debug === true) {
						adapter?.log?.debug?.(
							`MsgHub main.js: [i18n.t] key=${JSON.stringify(key)} opts=${JSON.stringify(options ?? {})}`,
						);
					}
					if (translateFn) {
						return translateFn(...args);
					}
					return String(key);
				},
				getTranslatedObject: (...args) => {
					const ret = fixTranslatedObject(getTranslatedObjectFn, args[0], args.slice(1));
					if (debug === true) {
						adapter?.log?.debug?.(
							`MsgHub main.js: [i18n.getTranslatedObject] args=${JSON.stringify(args)} ret=${JSON.stringify(ret, null, 2)}`,
						);
					}

					// The real function is currently broken and returns wrong strings in some environments.
					// Until this gets fixed in ioBroker core, we keep using this workaround.
					return ret;
				},
				locale,
				i18nlocale,
				lang,
			})
		: null;

	return { i18n };
}

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

// Load your modules here, e.g.:
// const fs = require('fs');

class Msghub extends utils.Adapter {
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
		// This is the format locale (numbers/date-time), not the i18n text language.
		this.locale = 'en-US';

		// Runtime plugin enable/disable handler  (initialized in onReady)
		this._msgPlugins = null;

		// AdminTab command facade (initialized in onReady)
		this._adminTab = null;
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		/////////////////////////////////////////
		//    Translator Interface
		/////////////////////////////////////////

		const configuredLocale = typeof this.config.locale === 'string' ? this.config.locale.trim() : '';
		if (configuredLocale) {
			this.locale = configuredLocale;
		}
		await this._i18ninit(this.locale);

		/////////////////////////////////////////
		// Message Hub Core
		/////////////////////////////////////////

		this.msgFactory = new MsgFactory(this, this.msgConstants);
		const config = this.config || {};

		const msgCfg = MsgConfig.normalize({
			adapterConfig: config,
			decrypted: { aiOpenAiApiKey: decryptIfPossible(this, config?.aiOpenAiApiKey) },
			msgConstants: this.msgConstants,
			log: this.log,
		});
		// Expose the plugin-facing config snapshot via adapter for `ctx.api.config`.
		// This is intentionally read-only and schema-versioned.
		this._msgConfigPublic = Object.freeze({ schemaVersion: MsgConfig.schemaVersion, ...msgCfg.pluginPublic });

		const msgAi = new MsgAi(this, msgCfg.corePrivate.ai);
		this.msgAi = msgAi;
		let instanceDataDir = '';
		try {
			if (typeof utils.getAbsoluteInstanceDataDir === 'function') {
				instanceDataDir = String(utils.getAbsoluteInstanceDataDir(this) || '').trim();
			}
		} catch (e) {
			this.log?.warn?.(`Could not resolve instance data dir for native archive mode: ${e?.message || e}`);
		}
		const archiveResolved = await IoArchiveResolver.resolveFor({
			adapter: this,
			archiveConfig: msgCfg.corePrivate.archive,
			metaId: this.namespace,
			baseDir: 'data/archive',
			fileExtension: 'jsonl',
			instanceDataDir,
		});

		this.msgStore = new MsgStore(this, this.msgConstants, this.msgFactory, {
			store: msgCfg.corePrivate.store,
			storage: {
				...msgCfg.corePrivate.storage,
				createStorageBackend: () =>
					new IoStorageIobroker({
						adapter: this,
						metaId: this.namespace,
						baseDir: 'data',
					}),
			},
			archive: {
				...msgCfg.corePrivate.archive,
				createStorageBackend: archiveResolved.createStorageBackend,
				archiveRuntime: archiveResolved.archiveRuntime,
			},
			stats: msgCfg.corePrivate.stats,
			quietHours: msgCfg.corePrivate.quietHours,
			render: msgCfg.corePrivate.render,
			ai: msgAi,
		});
		await this.msgStore.init();
		await this._syncArchiveRuntimeNativeFields();

		/////////////////////////////////////////
		// Message Hub Plugins
		/////////////////////////////////////////

		const { IoAdminTab } = require(`${__dirname}/lib/IoAdminTab`);
		const { IoAdminConfig } = require(`${__dirname}/lib/IoAdminConfig`);

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
		this._adminTab = new IoAdminTab(this, this._msgPlugins, { msgStore: this.msgStore });
		this._adminConfig = new IoAdminConfig(this, {
			ai: msgAi,
			msgStore: this.msgStore,
		});

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
			// Best-effort cleanup (compact mode): drop any direct messagebox handler.
			try {
				this._msgPlugins?.clearMessageboxHandler?.();
			} catch {
				// swallow
			}
			callback();
		}
	}

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
			this._msgPlugins?.handleGateStateChange?.(id, state);
			// Forward the raw event to producer plugins (they decide what to do with ack/val changes).
			this.msgStore?.msgIngest?.dispatchStateChange?.(id, state, { source: 'iobroker.stateChange' });

			// The state was changed
			this.log?.silly?.(`MsgHub main.js: state ${id} changed: ${state.val} (ack = ${state.ack})`);

			if (state.ack === false) {
				// This is a command from the user (e.g., from the UI or other adapter)
				// and should be processed by the adapter
				const ts = typeof state.ts === 'number' && Number.isFinite(state.ts) ? Math.trunc(state.ts) : null;
				const lc = typeof state.lc === 'number' && Number.isFinite(state.lc) ? Math.trunc(state.lc) : null;
				const from = typeof state.from === 'string' ? state.from : '';
				const user = typeof state.user === 'string' ? state.user : '';
				let shownVal;
				try {
					shownVal = JSON.stringify(state.val);
				} catch {
					shownVal = String(state.val);
				}
				this.log?.info?.(
					`MsgHub main.js: User command received for ${id}: ${shownVal} (ts=${ts} lc=${lc} from='${from}' user='${user}')`,
				);
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
			} else if (typeof cmd === 'string' && cmd.startsWith('config.')) {
				result = await this._handleConfigCommand(cmd, payload);
			} else if (cmd === 'runtime.about') {
				const adapterVersion = ioPackage?.common?.version ?? '0.0.0';
				const adapterTitle =
					ioPackage?.common?.titleLang?.de ?? ioPackage?.common?.titleLang?.en ?? 'Message Hub';
				let serverTimeZone = '';
				try {
					serverTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
				} catch {
					serverTimeZone = '';
				}
				const timeZone = typeof serverTimeZone === 'string' ? serverTimeZone.trim() : '';
				result = {
					ok: true,
					data: {
						title: adapterTitle,
						version: adapterVersion,
						time: {
							timeZone: timeZone || 'UTC',
							source: timeZone ? 'server' : 'fallback-utc',
						},
					},
				};
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
		this.log?.silly?.(
			`MsgHub main.js onMessage: this.sendTo(${obj.from}, ${obj.command}, ${JSON.stringify(result)}, ${obj.callback})`,
		);
	}

	async _handleAdminCommand(cmd, payload) {
		if (!this._adminTab) {
			return { ok: false, error: { code: 'NOT_READY', message: 'AdminTab runtime not ready' } };
		}
		return await this._adminTab.handleCommand(cmd, payload);
	}

	async _handleConfigCommand(cmd, payload) {
		if (!this._adminConfig) {
			return { ok: false, error: { code: 'NOT_READY', message: 'Config runtime not ready' } };
		}
		return await this._adminConfig.handleCommand(cmd, payload);
	}

	/**
	 * Persist current archive runtime status into instance native config fields for jsonConfig visibility.
	 *
	 * This does not influence runtime behavior; it only mirrors diagnostics into read-only UI fields.
	 *
	 * @returns {Promise<void>}
	 */
	async _syncArchiveRuntimeNativeFields() {
		const archive = this.msgStore?.msgArchive;
		if (!archive || typeof archive.getStatus !== 'function') {
			return;
		}

		const status = archive.getStatus();
		const strategy = typeof status?.effectiveStrategy === 'string' ? status.effectiveStrategy : '';
		const reason = typeof status?.effectiveStrategyReason === 'string' ? status.effectiveStrategyReason : '';
		const root = typeof status?.runtimeRoot === 'string' ? status.runtimeRoot : '';

		const id = `system.adapter.${this.namespace}`;
		const obj = await this.getForeignObjectAsync(id);
		if (!obj || typeof obj !== 'object') {
			return;
		}
		const next = JSON.parse(JSON.stringify(obj));
		if (!next.native || typeof next.native !== 'object') {
			next.native = {};
		}

		const changed =
			next.native.archiveRuntimeStrategy !== strategy ||
			next.native.archiveRuntimeReason !== reason ||
			next.native.archiveRuntimeRoot !== root;
		if (!changed) {
			return;
		}

		next.native.archiveRuntimeStrategy = strategy;
		next.native.archiveRuntimeReason = reason;
		next.native.archiveRuntimeRoot = root;
		await this.setForeignObjectAsync(id, next);
	}

	async _i18ninit(locale) {
		const _i18ndebug = false;
		const normalizeLangTag = value =>
			String(value || '')
				.trim()
				.replace(/_/g, '-')
				.toLowerCase();
		const splitBaseLang = value => {
			const normalized = normalizeLangTag(value);
			return normalized ? normalized.split('-')[0] : '';
		};

		const formatLocale = typeof locale === 'string' && locale.trim() ? locale.trim() : this.locale || 'en-US';

		// Text language must follow ioBroker's system language, not the adapter's format locale config.
		let systemLanguage = '';
		try {
			const sys = await this.getForeignObjectAsync('system.config');
			const raw = typeof sys?.common?.language === 'string' ? sys.common.language : '';
			systemLanguage = normalizeLangTag(raw);
		} catch (e) {
			this.log?.warn?.(`MsgHub main.js: failed to read system language from system.config: ${e?.message || e}`);
		}
		if (!systemLanguage) {
			systemLanguage = splitBaseLang(this.language) || 'en';
		}

		// Initialize adapter-core i18n from adapter context, so translate() follows system.config.common.language.
		await utils.I18n.init(__dirname, this);
		const lang = splitBaseLang(systemLanguage) || 'en';
		const i18nlocale = systemLanguage;

		this.log?.debug?.(
			`MsgHub main.js locale policy: formatLocale=${formatLocale} / systemLanguage=${i18nlocale} (i18n)`,
		);

		const { i18n } = buildI18nRuntime({
			adapter: this,
			baseI18n: utils.I18n,
			locale: formatLocale,
			i18nlocale,
			lang,
			debug: _i18ndebug,
		});
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
