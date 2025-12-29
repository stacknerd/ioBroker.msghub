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

		this.msgStore = new MsgStore(this, this.msgConstants, this.msgFactory);
		await this.msgStore.init();

		/////////////////////////////////////////
		// Message Hub Plugins
		/////////////////////////////////////////

		try {
			const { IoPlugins } = require(`${__dirname}/lib/IoPlugins`);
			if (typeof IoPlugins?.create !== 'function') {
				throw new Error('IoPlugins.create is not a function');
			}
			this._msgPlugins = await IoPlugins.create(this, this.msgStore);
		} catch (e) {
			this.log?.error?.(`Plugin wiring failed: ${e?.message || e}`);
		}
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
			this.log?.info?.(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

			if (state.ack === false) {
				// This is a command from the user (e.g., from the UI or other adapter)
				// and should be processed by the adapter
				this.log?.info?.(`User command received for ${id}: ${state.val}`);
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

		this.log?.debug?.(`onMessage: '${cmd}' ${JSON.stringify(payload, null, 2)}`);
		let result;

		try {
			result = await this._msgPlugins?.dispatchMessagebox?.(obj);
			if (result == null) {
				result = { ok: false, error: { code: 'NOT_READY', message: 'No messagebox handler registered' } };
			}
		} catch (e) {
			this.log?.error?.(`onMessage error: ${e?.message || e}`);
			result = { ok: false, error: { code: 'INTERNAL', message: String(e?.message || e) } };
		}

		if (obj.callback) {
			this.sendTo(obj.from, obj.command, result, obj.callback);
		}
	}

	async _i18ninit(locale) {
		const _i18ndebug = false;
		// decide on locale for translation
		const i18nSupport = new Set(['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn']);
		const lang = locale.split('-')[0].trim().toLowerCase();
		const i18nlocale = i18nSupport.has(lang) ? lang : locale;

		await utils.I18n.init(__dirname, i18nlocale);
		this.log?.debug?.(`config locale: ${locale} (time and date) / ${i18nlocale} (i18n)`);

		const baseI18n = utils.I18n;
		this.i18n = baseI18n //would be the real way, if iobroker would not be broken at this point and return wrong string on getTranslatedObject
			? Object.freeze({
					t: (...args) => {
						const [key, options] = args;
						if (_i18ndebug) {
							this.log?.debug?.(
								`[i18n.t] key=${JSON.stringify(key)} opts=${JSON.stringify(options ?? {})}`,
							);
						}
						// @ts-expect-error TS2556 (checkJs): spreading any[] into tuple/rest typed function
						return baseI18n.t(...args);
					},
					getTranslatedObject: (...args) => {
						if (_i18ndebug) {
							this.log?.debug?.(
								`[i18n.getTranslatedObject] args=${JSON.stringify(args)} ret=${JSON.stringify(fixTranslatedObject(args[0], args.slice(1)), null, 2)}`,
							);
						}
						// the real function as of right now is broken and returns wrong strings
						// return baseI18n.getTranslatedObject?.(...args);
						// until this gets fixed, i will use this patch
						return fixTranslatedObject(args[0], args.slice(1));
					},
				})
			: null;

		// a workaround for a current bug
		const fixTranslatedObject = (text, strings = []) => {
			let obj = utils.I18n.getTranslatedObject(text, '%s');
			for (const lang of Object.keys(obj)) {
				let s = obj[lang];
				for (const arg of strings) {
					s = s.replace('%s', String(arg));
				}
				obj[lang] = s;
			}
			return obj;
		};
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
