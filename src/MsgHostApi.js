/**
 * MsgHostApi
 * =========
 * Shared API facade builders for plugin hosts (MsgIngest / MsgNotify).
 *
 * Docs: ../../docs/modules/MsgHostApi.md
 *
 *
 * Goal: keep the exposed plugin surface stable and capability-based, while avoiding duplicated
 * adapter wrapper logic across hosts.
 */

'use strict';

/**
 * Build a strict string-only logger facade for plugins.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance & { i18n?: ({ t?: Function, getTranslatedObject?: Function } | null) }} adapter Adapter instance.
 * @param {{ hostName: string }} options Options.
 */
function buildLogApi(adapter, { hostName }) {
	const name = typeof hostName === 'string' && hostName.trim() ? hostName.trim() : 'Host';
	const assertString = (method, message) => {
		if (typeof message !== 'string') {
			throw new TypeError(`${name}: ctx.api.log.${method}(message) expects a string`);
		}
	};
	return Object.freeze({
		silly: message => {
			assertString('silly', message);
			adapter?.log?.silly?.(message);
		},
		debug: message => {
			assertString('debug', message);
			adapter?.log?.debug?.(message);
		},
		info: message => {
			assertString('info', message);
			adapter?.log?.info?.(message);
		},
		warn: message => {
			assertString('warn', message);
			adapter?.log?.warn?.(message);
		},
		error: message => {
			assertString('error', message);
			adapter?.log?.error?.(message);
		},
	});
}

/**
 * Build an optional i18n facade. Returns null when i18n is not wired.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance & { i18n?: ({ t?: Function, getTranslatedObject?: Function } | null) }} adapter Adapter instance.
 */
function buildI18nApi(adapter) {
	if (!adapter?.i18n || typeof adapter.i18n.t !== 'function') {
		return null;
	}
	return Object.freeze({
		t: adapter.i18n.t,
		getTranslatedObject: adapter.i18n.getTranslatedObject,
	});
}

/**
 * Build the MsgStore facade for plugins.
 *
 * Derivation rule:
 * - For ingest hosts (`hostName` contains "Ingest"): expose read + write APIs.
 * - For notify hosts: expose read APIs only.
 *
 * @param {object} store MsgStore instance.
 * @param {{ hostName?: string }} [options] Options.
 */
function buildStoreApi(store, { hostName = 'Host' } = {}) {
	const name = typeof hostName === 'string' && hostName.trim() ? hostName.trim() : 'Host';
	if (!store || typeof store !== 'object') {
		return null;
	}

	const isIngestHost = /Ingest/i.test(name);

	const api = {
		getMessageByRef: ref => store.getMessageByRef(ref),
		getMessages: () => store.getMessages(),
		queryMessages: options => store.queryMessages(options),
	};

	if (isIngestHost) {
		api.addMessage = msg => store.addMessage(msg);
		// Intentional decision: StealthMode is reserved for core-internal housekeeping.
		// External/plugin updates always bump `timing.updatedAt` for every content change.
		// api.updateMessage = (msgOrRef, patch, stealthMode = false) => store.updateMessage(msgOrRef, patch, stealthMode);
		api.updateMessage = (msgOrRef, patch) => store.updateMessage(msgOrRef, patch);
		api.addOrUpdateMessage = msg => store.addOrUpdateMessage(msg);
		api.removeMessage = (ref, options = {}) => {
			const msgRef = typeof ref === 'string' ? ref.trim() : '';
			if (!msgRef) {
				return false;
			}
			const actor = Object.prototype.hasOwnProperty.call(options || {}, 'actor') ? options.actor : undefined;
			return store.removeMessage(msgRef, actor === undefined ? undefined : { actor });
		};

		// "Shortcut" for Ingest-Plugins to remove Messages that have been "resoved by taking action"
		// on a easy and standardized way.
		api.completeAfterCauseEliminated = (ref, options = {}) => {
			const msgRef = typeof ref === 'string' ? ref.trim() : '';
			if (!msgRef) {
				return false;
			}
			const actor = typeof options?.actor === 'string' && options.actor.trim() ? options.actor.trim() : null;

			const msg = store.getMessageByRef(msgRef);
			if (!msg) {
				return false;
			}

			if (msg?.kind === store?.msgConstants?.kind?.status) {
				if (msg?.lifecycle?.state === store?.msgConstants?.lifecycle?.state?.deleted) {
					return true;
				}
				return store.removeMessage(msgRef, actor ? { actor } : undefined);
			}

			if (msg?.kind === store?.msgConstants?.kind?.task) {
				return store.updateMessage(msgRef, {
					lifecycle: {
						state: 'closed',
						...(actor ? { stateChangedBy: actor } : {}),
					},
					timing: { notifyAt: null },
					progress: { percentage: 100 },
				});
			}

			return true;
		};
	}

	return Object.freeze(api);
}

/**
 * Build the MsgAction facade for plugins.
 *
 * Derivation rule:
 * - For engage hosts (`hostName` contains "Engage"): expose the action executor.
 * - For other hosts: return null.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance.
 * @param {import('./MsgConstants').MsgConstants} msgConstants Centralized constants (actions + lifecycle states).
 * @param {object} store MsgStore instance.
 * @param {{ hostName?: string }} [options] Options.
 */
function buildActionApi(adapter, msgConstants, store, { hostName = 'Host' } = {}) {
	const name = typeof hostName === 'string' && hostName.trim() ? hostName.trim() : 'Host';
	if (!adapter || !msgConstants || !store) {
		return null;
	}

	const isEngageHost = /Engage/i.test(name);
	if (!isEngageHost) {
		return null;
	}

	if (typeof store?.getMessageByRef !== 'function' || typeof store?.updateMessage !== 'function') {
		return null;
	}

	try {
		const { MsgAction } = require(`${__dirname}/MsgAction`);
		const msgAction = new MsgAction(adapter, msgConstants, store);
		return Object.freeze({
			execute: options => msgAction.execute(options),
		});
	} catch (e) {
		adapter?.log?.warn?.(`${name}: failed to build ctx.api.action (${e?.message || e})`);
		return null;
	}
}

/**
 * Build the MsgFactory facade for plugins.
 *
 * Derivation rule:
 * - For ingest hosts (`hostName` contains "Ingest"): expose the normalization gate.
 * - For other hosts: return null.
 *
 * @param {import('./MsgFactory').MsgFactory} msgFactory Factory instance.
 * @param {{ hostName?: string }} [options] Options.
 */
function buildFactoryApi(msgFactory, { hostName = 'Host' } = {}) {
	const name = typeof hostName === 'string' && hostName.trim() ? hostName.trim() : 'Host';
	if (!msgFactory || typeof msgFactory !== 'object' || typeof msgFactory.createMessage !== 'function') {
		return null;
	}

	const isIngestHost = /Ingest/i.test(name);
	if (!isIngestHost) {
		return null;
	}

	// Factory access is intentionally limited:
	// - createMessage() is for "create" paths only (it always sets timing.createdAt = now).
	return Object.freeze({
		createMessage: data => msgFactory.createMessage(data),
	});
}

/**
 * Build the MsgStats facade for plugins.
 *
 * @param {object} store MsgStore instance.
 */
function buildStatsApi(store) {
	if (!store || typeof store !== 'object') {
		return null;
	}
	if (typeof store.getStats !== 'function') {
		return null;
	}

	return Object.freeze({
		getStats: options => store.getStats(options),
	});
}

/**
 * Build the MsgAi facade for plugins.
 *
 * Derivation rule:
 * - When MsgAi is wired: expose `ctx.api.ai.*` as a best-effort helper that never throws/rejects.
 * - When MsgAi is not wired: return null.
 *
 * @param {import('./MsgAi').MsgAi|null} msgAi MsgAi instance.
 */
function buildAiApi(msgAi) {
	if (!msgAi || typeof msgAi !== 'object' || typeof msgAi.getStatus !== 'function') {
		return null;
	}

	const base = Object.freeze({
		getStatus: () => msgAi.getStatus(),
		text: request => msgAi.text(request, null),
		json: request => msgAi.json(request, null),
	});

	// Internal hook: IoPlugins binds per-plugin identity into ctx.api.ai for rate limiting/caching partition.
	return Object.freeze({
		...base,
		__bindCaller: pluginMeta => {
			if (typeof msgAi.createCallerApi !== 'function') {
				return base;
			}
			const regId = typeof pluginMeta?.regId === 'string' ? pluginMeta.regId.trim() : '';
			return msgAi.createCallerApi({ regId });
		},
	});
}

/**
 * Build id helpers for converting between full ids and "own ids".
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance & { i18n?: ({ t?: Function, getTranslatedObject?: Function } | null) }} adapter Adapter instance.
 */
function buildIdsApi(adapter) {
	const namespace = typeof adapter?.namespace === 'string' ? adapter.namespace : '';
	return Object.freeze({
		namespace,
		toOwnId: fullId => {
			const id = typeof fullId === 'string' ? fullId : '';
			if (!namespace) {
				return id;
			}
			const prefix = `${namespace}.`;
			return id === namespace ? '' : id.startsWith(prefix) ? id.slice(prefix.length) : id;
		},
		toFullId: ownId => {
			const id = typeof ownId === 'string' ? ownId : '';
			if (!namespace) {
				return id;
			}
			const prefix = `${namespace}.`;
			if (!id) {
				return namespace;
			}
			return id === namespace ? namespace : id.startsWith(prefix) ? id : `${namespace}.${id}`;
		},
	});
}

/**
 * Build the ioBroker facade (objects/states/subscribe + ids).
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance & { i18n?: ({ t?: Function, getTranslatedObject?: Function } | null) }} adapter Adapter instance.
 * @param {{ hostName: string }} options Options.
 */
function buildIoBrokerApi(adapter, { hostName }) {
	const name = typeof hostName === 'string' && hostName.trim() ? hostName.trim() : 'Host';
	const ids = buildIdsApi(adapter);

	const requireFn = (fn, label) => {
		if (typeof fn !== 'function') {
			throw new Error(`${name}: adapter.${label} is not available`);
		}
		return fn;
	};

	return Object.freeze({
		ids,
		/**
		 * Promisified wrapper for ioBroker messagebox calls via `adapter.sendTo(...)`.
		 *
		 * @param {string} instance Target adapter instance (e.g. "telegram.0").
		 * @param {string} command Command name.
		 * @param {any} [message] Payload passed as `obj.message`.
		 * @param {{ timeoutMs?: number }|number} [options] Optional timeout (ms). Use `<= 0` to disable timeout.
		 * @returns {Promise<any>} Promise that resolves with the callback response.
		 */
		sendTo: (instance, command, message = undefined, options = undefined) => {
			const target = typeof instance === 'string' ? instance.trim() : '';
			const cmd = typeof command === 'string' ? command.trim() : '';
			if (!target) {
				throw new TypeError(
					`${name}: ctx.api.iobroker.sendTo(instance, command, ...) expects instance to be a non-empty string`,
				);
			}
			if (!cmd) {
				throw new TypeError(
					`${name}: ctx.api.iobroker.sendTo(instance, command, ...) expects command to be a non-empty string`,
				);
			}
			if (ids.namespace && target === ids.namespace) {
				throw new Error(
					`${name}: ctx.api.iobroker.sendTo(...) cannot target own namespace ('${ids.namespace}')`,
				);
			}

			const timeoutMsRaw =
				typeof options === 'number'
					? options
					: options && typeof options === 'object' && typeof options.timeoutMs === 'number'
						? options.timeoutMs
						: 10000;
			const timeoutMs =
				typeof timeoutMsRaw === 'number' && Number.isFinite(timeoutMsRaw) ? Math.trunc(timeoutMsRaw) : 10000;

			const fn = requireFn(adapter?.sendTo, 'sendTo');

			const exec = () =>
				new Promise((resolve, reject) => {
					try {
						fn.call(adapter, target, cmd, message, response => resolve(response));
					} catch (e) {
						reject(e);
					}
				});

			if (timeoutMs <= 0) {
				return exec();
			}

			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(
						new Error(`${name}: adapter.sendTo('${target}', '${cmd}', ...) timed out after ${timeoutMs}ms`),
					);
				}, timeoutMs);

				exec().then(
					result => {
						clearTimeout(timer);
						resolve(result);
					},
					err => {
						clearTimeout(timer);
						reject(err);
					},
				);
			});
		},
		objects: Object.freeze({
			setObjectNotExists: (ownId, obj) => {
				if (typeof adapter?.setObjectNotExistsAsync === 'function') {
					return adapter.setObjectNotExistsAsync(ownId, obj).then(() => undefined);
				}
				requireFn(adapter?.setObjectNotExists, 'setObjectNotExists');
				return new Promise((resolve, reject) => {
					adapter.setObjectNotExists(ownId, obj, err => (err ? reject(err) : resolve(undefined)));
				});
			},
			delObject: ownId => {
				if (typeof adapter?.delObjectAsync === 'function') {
					return adapter.delObjectAsync(ownId).then(() => undefined);
				}
				requireFn(adapter?.delObject, 'delObject');
				return new Promise((resolve, reject) => {
					adapter.delObject(ownId, err => (err ? reject(err) : resolve(undefined)));
				});
			},
			getObjectView: (design, search, params) => {
				if (typeof adapter?.getObjectViewAsync === 'function') {
					return adapter.getObjectViewAsync(design, search, params);
				}
				requireFn(adapter?.getObjectView, 'getObjectView');
				return new Promise((resolve, reject) => {
					adapter.getObjectView(design, search, params, (err, res) => (err ? reject(err) : resolve(res)));
				});
			},
			getForeignObjects: (pattern, type = undefined) => {
				if (typeof adapter?.getForeignObjectsAsync === 'function') {
					return type === undefined
						? adapter.getForeignObjectsAsync(pattern)
						: adapter.getForeignObjectsAsync(pattern, type);
				}
				requireFn(adapter?.getForeignObjects, 'getForeignObjects');
				return new Promise((resolve, reject) => {
					if (type === undefined) {
						adapter.getForeignObjects(pattern, (err, objs) => (err ? reject(err) : resolve(objs)));
						return;
					}
					adapter.getForeignObjects(pattern, type, (err, objs) => (err ? reject(err) : resolve(objs)));
				});
			},
			getForeignObject: id => {
				if (typeof adapter?.getForeignObjectAsync === 'function') {
					return adapter.getForeignObjectAsync(id);
				}
				requireFn(adapter?.getForeignObject, 'getForeignObject');
				return new Promise((resolve, reject) => {
					adapter.getForeignObject(id, (err, obj) => (err ? reject(err) : resolve(obj)));
				});
			},
			extendForeignObject: (id, patch) => {
				if (typeof adapter?.extendForeignObjectAsync === 'function') {
					return adapter.extendForeignObjectAsync(id, patch);
				}
				requireFn(adapter?.extendForeignObject, 'extendForeignObject');
				return new Promise((resolve, reject) => {
					adapter.extendForeignObject(id, patch, err => (err ? reject(err) : resolve(undefined)));
				});
			},
		}),
		states: Object.freeze({
			setState: (ownId, state) => {
				if (typeof adapter?.setStateAsync === 'function') {
					return adapter.setStateAsync(ownId, state).then(() => undefined);
				}
				requireFn(adapter?.setState, 'setState');
				return new Promise((resolve, reject) => {
					adapter.setState(ownId, state, err => (err ? reject(err) : resolve(undefined)));
				});
			},
			setForeignState: (id, state) => {
				if (typeof adapter?.setForeignStateAsync === 'function') {
					return adapter.setForeignStateAsync(id, state).then(() => undefined);
				}
				requireFn(adapter?.setForeignState, 'setForeignState');
				return new Promise((resolve, reject) => {
					adapter.setForeignState(id, state, err => (err ? reject(err) : resolve(undefined)));
				});
			},
			getForeignState: id => {
				if (typeof adapter?.getForeignStateAsync === 'function') {
					return adapter.getForeignStateAsync(id);
				}
				requireFn(adapter?.getForeignState, 'getForeignState');
				return new Promise((resolve, reject) => {
					adapter.getForeignState(id, (err, state) => (err ? reject(err) : resolve(state)));
				});
			},
		}),
		subscribe: Object.freeze({
			subscribeStates: pattern => requireFn(adapter?.subscribeStates, 'subscribeStates').call(adapter, pattern),
			unsubscribeStates: pattern =>
				requireFn(adapter?.unsubscribeStates, 'unsubscribeStates').call(adapter, pattern),
			subscribeObjects: pattern =>
				requireFn(adapter?.subscribeObjects, 'subscribeObjects').call(adapter, pattern),
			unsubscribeObjects: pattern =>
				requireFn(adapter?.unsubscribeObjects, 'unsubscribeObjects').call(adapter, pattern),
			subscribeForeignStates: pattern =>
				requireFn(adapter?.subscribeForeignStates, 'subscribeForeignStates').call(adapter, pattern),
			unsubscribeForeignStates: pattern =>
				requireFn(adapter?.unsubscribeForeignStates, 'unsubscribeForeignStates').call(adapter, pattern),
			subscribeForeignObjects: pattern =>
				requireFn(adapter?.subscribeForeignObjects, 'subscribeForeignObjects').call(adapter, pattern),
			unsubscribeForeignObjects: pattern =>
				requireFn(adapter?.unsubscribeForeignObjects, 'unsubscribeForeignObjects').call(adapter, pattern),
		}),
		files: Object.freeze({
			/**
			 * Read a file from ioBroker file storage.
			 *
			 * Return value is passed through as returned by ioBroker (commonly `{ file, mimeType? }`).
			 *
			 * @param {string} metaId File storage root (example: adapter namespace like "msghub.0").
			 * @param {string} filePath File path below metaId (example: "documents/x.pdf").
			 * @returns {Promise<any>} ioBroker readFile result.
			 */
			readFile: (metaId, filePath) => {
				if (typeof adapter?.readFileAsync === 'function') {
					return adapter.readFileAsync(metaId, filePath);
				}
				requireFn(adapter?.readFile, 'readFile');
				return new Promise((resolve, reject) => {
					adapter.readFile(metaId, filePath, (err, res) => (err ? reject(err) : resolve(res)));
				});
			},
			/**
			 * Write a file into ioBroker file storage.
			 *
			 * @param {string} metaId File storage root (example: adapter namespace like "msghub.0").
			 * @param {string} filePath File path below metaId (example: "documents/x.pdf").
			 * @param {Buffer|string} data File content.
			 * @returns {Promise<void>} Resolves when the write completes.
			 */
			writeFile: (metaId, filePath, data) => {
				if (typeof adapter?.writeFileAsync === 'function') {
					return adapter.writeFileAsync(metaId, filePath, data).then(() => undefined);
				}
				requireFn(adapter?.writeFile, 'writeFile');
				return new Promise((resolve, reject) => {
					adapter.writeFile(metaId, filePath, data, err => (err ? reject(err) : resolve(undefined)));
				});
			},
			/**
			 * Create a folder in ioBroker file storage.
			 *
			 * @param {string} metaId File storage root.
			 * @param {string} dirPath Directory path below metaId.
			 * @returns {Promise<void>} Resolves when the directory exists.
			 */
			mkdir: (metaId, dirPath) => {
				if (typeof adapter?.mkdirAsync === 'function') {
					return adapter.mkdirAsync(metaId, dirPath).then(() => undefined);
				}
				requireFn(adapter?.mkdir, 'mkdir');
				return new Promise((resolve, reject) => {
					adapter.mkdir(metaId, dirPath, err => (err ? reject(err) : resolve(undefined)));
				});
			},
			/**
			 * Rename/move a file in ioBroker file storage.
			 *
			 * @param {string} metaId File storage root.
			 * @param {string} oldPath Old path below metaId.
			 * @param {string} newPath New path below metaId.
			 * @returns {Promise<void>} Resolves when the rename completes.
			 */
			renameFile: (metaId, oldPath, newPath) => {
				// @ts-expect-error renameFileAsync may not be available
				if (typeof adapter?.renameFileAsync === 'function') {
					// @ts-expect-error renameFileAsync may not be available
					return adapter.renameFileAsync(metaId, oldPath, newPath).then(() => undefined);
				}
				// @ts-expect-error renameFile may not be available
				requireFn(adapter?.renameFile, 'renameFile');
				return new Promise((resolve, reject) => {
					// @ts-expect-error renameFile may not be available
					adapter.renameFile(metaId, oldPath, newPath, err => (err ? reject(err) : resolve(undefined)));
				});
			},
			/**
			 * Delete a file in ioBroker file storage.
			 *
			 * Adapter API name is `delFile` / `delFileAsync`; this facade uses `deleteFile` for clarity.
			 *
			 * @param {string} metaId File storage root.
			 * @param {string} filePath Path below metaId.
			 * @returns {Promise<void>} Resolves when the delete completes.
			 */
			deleteFile: (metaId, filePath) => {
				if (typeof adapter?.delFileAsync === 'function') {
					return adapter.delFileAsync(metaId, filePath).then(() => undefined);
				}
				requireFn(adapter?.delFile, 'delFile');
				return new Promise((resolve, reject) => {
					adapter.delFile(metaId, filePath, err => (err ? reject(err) : resolve(undefined)));
				});
			},
		}),
	});
}

module.exports = {
	buildLogApi,
	buildI18nApi,
	buildIoBrokerApi,
	buildIdsApi,
	buildStoreApi,
	buildActionApi,
	buildFactoryApi,
	buildStatsApi,
	buildAiApi,
};
