/**
 * IoPluginResources
 * =================
 *
 * Small per-plugin runtime helper to track resources that must be disposed on plugin stop/unregister.
 *
 * Scope (v1)
 * - Timers created via `ctx.meta.resources.*`
 * - ioBroker subscriptions done via `ctx.api.iobroker.subscribe.*` (when wrapped by IoPlugins)
 * - Generic disposers via `ctx.meta.resources.add(disposer)`
 *
 * Design constraints
 * - Best-effort: disposing must never crash the adapter.
 * - Idempotent: dispose can be called multiple times.
 */
'use strict';

/**
 * Per-plugin resource tracker (timers, subscriptions, generic disposers).
 */
class IoPluginResources {
	/**
	 * @param {object} [options] Options.
	 * @param {string} [options.regId] Plugin registration id (for debug logging only).
	 * @param {{ warn?: Function, debug?: Function }|null} [options.log] Optional logger.
	 * @param {object} [options.timers] Optional timer primitives (tests).
	 */
	constructor({ regId = '', log = null, timers } = {}) {
		this._regId = typeof regId === 'string' ? regId.trim() : '';
		this._log = log && typeof log === 'object' ? log : null;
		this._disposed = false;

		const safeTimers = timers && typeof timers === 'object' ? timers : {};
		this._timers = Object.freeze({
			setTimeout: typeof safeTimers.setTimeout === 'function' ? safeTimers.setTimeout : setTimeout,
			clearTimeout: typeof safeTimers.clearTimeout === 'function' ? safeTimers.clearTimeout : clearTimeout,
			setInterval: typeof safeTimers.setInterval === 'function' ? safeTimers.setInterval : setInterval,
			clearInterval: typeof safeTimers.clearInterval === 'function' ? safeTimers.clearInterval : clearInterval,
		});

		this._timerHandles = new Map(); // handle -> { clear: 'clearTimeout'|'clearInterval' }

		this._nextToken = 1;
		this._disposers = new Map(); // token -> disposer
		this._disposersByKey = new Map(); // string key -> Set<token>

		this._wrappedSubscribeApis = new WeakMap(); // subscribeApi -> wrappedApi
	}

	/**
	 * Register a generic disposer to be executed when the plugin stops/unregisters.
	 *
	 * Supported disposer shapes:
	 * - Function: `() => void`
	 * - Object: `{ dispose() }`
	 *
	 * @param {Function|{ dispose: Function }} disposer Disposer callback or object.
	 * @returns {number} Internal token (primarily for tests).
	 */
	add(disposer) {
		return this._addDisposer(disposer, null);
	}

	/**
	 * Best-effort disposal of everything tracked so far.
	 *
	 * @returns {void}
	 */
	disposeAll() {
		if (this._disposed) {
			return;
		}
		this._disposed = true;

		// 1) Timers
		for (const [handle, info] of this._timerHandles.entries()) {
			try {
				this._timers[info.clear]?.(handle);
			} catch (e) {
				this._warn(`disposeAll: ${info.clear} failed (${e?.message || e})`);
			}
		}
		this._timerHandles.clear();

		// 2) Disposers (LIFO)
		const tokens = Array.from(this._disposers.keys()).reverse();
		for (const token of tokens) {
			const disposer = this._disposers.get(token);
			this._disposers.delete(token);
			try {
				this._callDisposer(disposer);
			} catch (e) {
				this._warn(`disposeAll: disposer failed (${e?.message || e})`);
			}
		}
		this._disposersByKey.clear();
	}

	/**
	 * Track a timeout and return its handle (like `setTimeout`).
	 *
	 * @param {Function} fn Callback.
	 * @param {number} delayMs Delay in ms.
	 * @param  {...any} args Optional args.
	 * @returns {any} Timeout handle.
	 */
	setTimeout(fn, delayMs, ...args) {
		const handle = this._timers.setTimeout(fn, delayMs, ...args);
		this._trackTimer(handle, 'clearTimeout');
		return handle;
	}

	/**
	 * Clear a timeout created by `ctx.meta.resources.setTimeout` and forget it.
	 *
	 * @param {any} handle Timeout handle.
	 * @returns {void}
	 */
	clearTimeout(handle) {
		this._timers.clearTimeout(handle);
		this._timerHandles.delete(handle);
	}

	/**
	 * Track an interval and return its handle (like `setInterval`).
	 *
	 * @param {Function} fn Callback.
	 * @param {number} intervalMs Interval in ms.
	 * @param  {...any} args Optional args.
	 * @returns {any} Interval handle.
	 */
	setInterval(fn, intervalMs, ...args) {
		const handle = this._timers.setInterval(fn, intervalMs, ...args);
		this._trackTimer(handle, 'clearInterval');
		return handle;
	}

	/**
	 * Clear an interval created by `ctx.meta.resources.setInterval` and forget it.
	 *
	 * @param {any} handle Interval handle.
	 * @returns {void}
	 */
	clearInterval(handle) {
		this._timers.clearInterval(handle);
		this._timerHandles.delete(handle);
	}

	/**
	 * Wrap `ctx.api.iobroker.subscribe.*` so subscriptions are automatically tracked and cleaned up.
	 *
	 * The wrapper also forgets tracked subscriptions when the plugin manually unsubscribes.
	 *
	 * @param {object} subscribeApi The raw subscribe API (from MsgHostApi).
	 * @returns {object} Wrapped subscribe API (frozen).
	 */
	wrapSubscribeApi(subscribeApi) {
		if (!subscribeApi || typeof subscribeApi !== 'object') {
			return subscribeApi;
		}
		if (this._wrappedSubscribeApis.has(subscribeApi)) {
			return this._wrappedSubscribeApis.get(subscribeApi);
		}

		const wrapPair = (subscribeName, unsubscribeName) => {
			const sub = subscribeApi?.[subscribeName];
			const unsub = subscribeApi?.[unsubscribeName];
			if (typeof sub !== 'function' || typeof unsub !== 'function') {
				return {};
			}
			return Object.freeze({
				[subscribeName]: pattern => {
					sub(pattern);
					const key = this._makeSubscriptionKey(unsubscribeName, pattern);
					if (!key) {
						return;
					}
					this._addDisposer(() => unsub(pattern), key);
				},
				[unsubscribeName]: pattern => {
					unsub(pattern);
					const key = this._makeSubscriptionKey(unsubscribeName, pattern);
					if (!key) {
						return;
					}
					this._forgetKey(key);
				},
			});
		};

		const wrappedPairs = [
			wrapPair('subscribeStates', 'unsubscribeStates'),
			wrapPair('subscribeObjects', 'unsubscribeObjects'),
			wrapPair('subscribeForeignStates', 'unsubscribeForeignStates'),
			wrapPair('subscribeForeignObjects', 'unsubscribeForeignObjects'),
		].reduce((acc, pair) => Object.assign(acc, pair), {});

		const wrapped = Object.freeze({ ...subscribeApi, ...wrappedPairs });
		this._wrappedSubscribeApis.set(subscribeApi, wrapped);
		return wrapped;
	}

	/**
	 * Track a timer handle for later disposal.
	 *
	 * @param {any} handle Timer handle.
	 * @param {'clearTimeout'|'clearInterval'} clearFnName Clear function name.
	 * @returns {void}
	 */
	_trackTimer(handle, clearFnName) {
		if (this._disposed) {
			try {
				this._timers[clearFnName]?.(handle);
			} catch (e) {
				this._warn(`_trackTimer: ${clearFnName} failed (${e?.message || e})`);
			}
			return;
		}
		this._timerHandles.set(handle, { clear: clearFnName });
	}

	/**
	 * Build a stable key for tracking subscriptions (so manual unsubs can be forgotten).
	 *
	 * @param {string} unsubscribeName Unsubscribe method name.
	 * @param {string} pattern Subscription pattern.
	 * @returns {string|null} Tracking key, or null for invalid inputs.
	 */
	_makeSubscriptionKey(unsubscribeName, pattern) {
		const u = typeof unsubscribeName === 'string' ? unsubscribeName.trim() : '';
		const p = typeof pattern === 'string' ? pattern.trim() : '';
		if (!u || !p) {
			return null;
		}
		return `${u}:${p}`;
	}

	/**
	 * Register a disposer and optionally associate it with a tracking key.
	 *
	 * @param {Function|{ dispose: Function }} disposer Disposer callback or object.
	 * @param {string|null} key Optional tracking key.
	 * @returns {number} Token id (or 0 when disposed already).
	 */
	_addDisposer(disposer, key) {
		if (this._disposed) {
			try {
				this._callDisposer(disposer);
			} catch (e) {
				this._warn(`add: disposer failed (${e?.message || e})`);
			}
			return 0;
		}

		const token = this._nextToken++;
		this._disposers.set(token, disposer);

		const k = typeof key === 'string' ? key.trim() : '';
		if (k) {
			const set = this._disposersByKey.get(k) || new Set();
			set.add(token);
			this._disposersByKey.set(k, set);
		}

		return token;
	}

	/**
	 * Forget all disposers registered under the given key (best-effort).
	 *
	 * @param {string} key Tracking key.
	 * @returns {void}
	 */
	_forgetKey(key) {
		const k = typeof key === 'string' ? key.trim() : '';
		if (!k) {
			return;
		}
		const set = this._disposersByKey.get(k);
		if (!set || set.size === 0) {
			return;
		}
		for (const token of set) {
			this._disposers.delete(token);
		}
		this._disposersByKey.delete(k);
	}

	/**
	 * Invoke a disposer in a tolerant way.
	 *
	 * @param {any} disposer Disposer callback or `{ dispose() }` object.
	 * @returns {void}
	 */
	_callDisposer(disposer) {
		if (typeof disposer === 'function') {
			disposer();
			return;
		}
		if (disposer && typeof disposer === 'object' && typeof disposer.dispose === 'function') {
			disposer.dispose();
		}
	}

	/**
	 * Log a warning (best-effort).
	 *
	 * @param {string} message Warning message.
	 * @returns {void}
	 */
	_warn(message) {
		const m = this._regId ? `IoPluginResources(${this._regId}): ${message}` : `IoPluginResources: ${message}`;
		this._log?.warn?.(m);
	}
}

module.exports = { IoPluginResources };
