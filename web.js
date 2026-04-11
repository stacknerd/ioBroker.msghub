'use strict';

/**
 * web.js
 * ======
 * Root entry for the MsgHub ioBroker web extension.
 *
 * Responsibilities
 * - Export the class that the ioBroker `web` adapter loads via `common.webExtension`.
 * - Wire the production mount prefix (`/MessageHub/<instance>/test/`) into the shared route host.
 * - Expose optional lifecycle hooks expected by the web adapter (`waitForReady`, `unload`).
 *
 * Non-responsibilities
 * - No route parsing or HTML serving logic directly in this file.
 * - No adapter runtime/bootstrap logic outside the web-extension entry contract.
 */

const { IoWebExtension } = require(`${__dirname}/lib/IoWebExtension`);

const PRODUCT_MOUNT_SEGMENT = 'MessageHub';

/**
 * MsgHub root web-extension entry loaded by the ioBroker `web` adapter.
 */
class WebExtensionEntry {
	/**
	 * @param {any} _server Underlying HTTP(S) server instance provided by `iobroker.web`.
	 * @param {{ secure?: boolean, port?: number, language?: string, defaultUser?: string, auth?: boolean }|null} _settings
	 *   Web-adapter runtime settings (unused by the minimal implementation for now).
	 * @param {{ log?: { info?: Function, warn?: Function, error?: Function, debug?: Function } }|null} webAdapter
	 *   Running `web` adapter instance used only for logging.
	 * @param {{ _id?: string, native?: Record<string, any> }|null} instanceObject
	 *   Current MsgHub instance object that owns this web extension.
	 * @param {{ use?: Function }} app Express application owned by the `web` adapter.
	 */
	constructor(_server, _settings, webAdapter, instanceObject, app) {
		/**
		 * Deferred ready callback handed in by `iobroker.web`.
		 *
		 */
		this.readyCallback = null;

		/**
		 * Whether route installation finished successfully.
		 *
		 */
		this.isReady = false;

		/**
		 * Shared route host that owns the actual request handling.
		 *
		 */
		this.extension = new IoWebExtension({
			instanceObject,
			log: webAdapter?.log || null,
			mountSegment: PRODUCT_MOUNT_SEGMENT,
		});
		this.isReady = this.extension.attach(app);
		this._markReady();
	}

	/**
	 * Optional ioBroker web-extension hook.
	 *
	 * The web adapter calls this when it wants to wait for asynchronous route
	 * installation. Our current setup is synchronous, so the callback can be
	 * invoked immediately once `attach(...)` succeeded.
	 *
	 * @param {(entry: WebExtensionEntry) => void} cb Ready callback supplied by `iobroker.web`.
	 * @returns {void}
	 */
	waitForReady(cb) {
		if (typeof cb !== 'function') {
			return;
		}
		if (this.isReady) {
			cb(this);
			return;
		}
		this.readyCallback = cb;
	}

	/**
	 * Optional ioBroker web-extension hook.
	 *
	 * Called by the web adapter before unloading or reloading the extension so
	 * the registered middleware can be removed from the Express stack.
	 *
	 * @returns {Promise<void>} Settles once teardown is complete.
	 */
	unload() {
		this.extension?.detach?.();
		return Promise.resolve();
	}

	/**
	 * Resolve the deferred ready callback once route installation completed.
	 *
	 * @returns {void}
	 */
	_markReady() {
		if (!this.isReady || typeof this.readyCallback !== 'function') {
			return;
		}
		const callback = this.readyCallback;
		this.readyCallback = null;
		callback(this);
	}
}

/**
 * Default export expected by `common.webExtension`.
 */
module.exports = WebExtensionEntry;
module.exports.web = WebExtensionEntry;
module.exports.IoWebExtension = IoWebExtension;
