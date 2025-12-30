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
		api.removeMessage = ref => store.removeMessage(ref);

		// "Shortcut" for Ingest-Plugins to remove Messages that have been "resoved by taking action"
		// on a easy and standardized way.
		api.completeAfterCauseEliminated = (ref, options = {}) => {
			const msgRef = typeof ref === 'string' ? ref.trim() : '';
			if (!msgRef) {
				return false;
			}
			const actor = typeof options?.actor === 'string' && options.actor.trim() ? options.actor.trim() : null;
			const finishedAt =
				typeof options?.finishedAt === 'number' && Number.isFinite(options.finishedAt)
					? Math.trunc(options.finishedAt)
					: Date.now();

			return store.updateMessage(msgRef, {
				lifecycle: {
					state: 'closed',
					stateChangedAt: Date.now(),
					...(actor ? { stateChangedBy: actor } : {}),
				},
				timing: { notifyAt: null },
				progress: { percentage: 100, finishedAt },
			});
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
};
