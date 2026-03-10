/**
 * IoCoreConnection
 * ================
 * ioBroker/platform-side core-link connection state for MsgHub.
 *
 * Responsibilities
 * - Own the official adapter state `info.connection`.
 * - Provide a small platform-side health contract for the effective core link.
 * - Expose the minimal `runtime.about.connection` payload.
 *
 * Non-responsibilities
 * - No AdminTab socket/ping handling.
 * - No plugin/cloud/fremdsystem aggregation.
 * - No remote-core transport protocol in the current implementation.
 */

'use strict';

/**
 * ioBroker/platform-side core-link connection state owner.
 */
class IoCoreConnection {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { namespace: string }} adapter Adapter instance.
	 */
	constructor(adapter) {
		if (!adapter?.namespace) {
			throw new Error('IoCoreConnection: adapter is required');
		}
		this.adapter = adapter;
		this.stateOwnId = 'info.connection';
		this.stateId = `${this.adapter.namespace}.${this.stateOwnId}`;
		this._connected = false;
		this._mode = 'local';
	}

	/**
	 * Initialize the platform-side connection state and mark it disconnected.
	 *
	 * @returns {Promise<void>} Resolves when the state object exists and the value is initialized.
	 */
	async init() {
		await this.ensureStateObject();
		await this.markDisconnected();
	}

	/**
	 * Ensure the official ioBroker state object exists.
	 *
	 * @returns {Promise<void>} Resolves when the object exists.
	 */
	async ensureStateObject() {
		const obj = {
			type: 'state',
			common: {
				name: 'Core connection',
				type: 'boolean',
				role: 'indicator.connected',
				read: true,
				write: false,
				def: false,
			},
			native: {},
		};
		if (typeof this.adapter.setObjectNotExistsAsync === 'function') {
			// @ts-expect-error adapter-core object union typing is too broad for this plain state literal in JS.
			await this.adapter.setObjectNotExistsAsync(this.stateOwnId, obj);
			return;
		}
		if (typeof this.adapter.setObjectNotExists === 'function') {
			await new Promise((resolve, reject) => {
				// @ts-expect-error adapter-core object union typing is too broad for this plain state literal in JS.
				this.adapter.setObjectNotExists(this.stateOwnId, obj, err => (err ? reject(err) : resolve(undefined)));
			});
		}
	}

	/**
	 * Evaluate the local in-process health contract for the current core runtime.
	 *
	 * The current implementation intentionally keeps this check small and direct instead of simulating
	 * a transport-style ping/pong within the same process.
	 *
	 * @param {{ msgStore?: any }} [runtime] Runtime dependencies.
	 * @returns {{ connected: boolean, mode: 'local' }} Health snapshot.
	 */
	checkHealthLocal(runtime = {}) {
		const msgStore =
			runtime && typeof runtime === 'object' && !Array.isArray(runtime) && runtime.msgStore
				? runtime.msgStore
				: null;
		const connected = Boolean(
			msgStore &&
			typeof msgStore === 'object' &&
			typeof msgStore.getMessages === 'function' &&
			typeof msgStore.addMessage === 'function' &&
			msgStore.msgIngest &&
			typeof msgStore.msgIngest.start === 'function' &&
			msgStore.msgNotify &&
			typeof msgStore.msgNotify === 'object',
		);
		return { connected, mode: 'local' };
	}

	/**
	 * Apply a health snapshot to the official connection state.
	 *
	 * @param {{ connected?: any, mode?: any }} health Health snapshot.
	 * @returns {Promise<void>} Resolves when the state value was written.
	 */
	async markFromHealth(health) {
		const nextConnected = health?.connected === true;
		const nextMode = health?.mode === 'local' ? 'local' : 'local';
		this._connected = nextConnected;
		this._mode = nextMode;
		await this._writeState(nextConnected);
	}

	/**
	 * Mark the core link as disconnected.
	 *
	 * @returns {Promise<void>} Resolves when the state value was written.
	 */
	async markDisconnected() {
		this._connected = false;
		this._mode = 'local';
		await this._writeState(false);
	}

	/**
	 * Build the minimal runtime.about fragment for connection diagnostics.
	 *
	 * @returns {{scope:'core-link',connected:boolean,mode:'local'}} Runtime-about connection payload.
	 */
	getRuntimeAbout() {
		return {
			scope: 'core-link',
			connected: this._connected === true,
			mode: this._mode === 'local' ? 'local' : 'local',
		};
	}

	/**
	 * Write the ioBroker state value with ack=true.
	 *
	 * @param {boolean} connected Connected flag.
	 * @returns {Promise<void>} Resolves when the write finished.
	 */
	async _writeState(connected) {
		const value = connected === true;
		if (typeof this.adapter.setStateAsync === 'function') {
			await this.adapter.setStateAsync(this.stateOwnId, { val: value, ack: true });
			return;
		}
		if (typeof this.adapter.setState === 'function') {
			await new Promise((resolve, reject) => {
				this.adapter.setState(this.stateOwnId, { val: value, ack: true }, err =>
					err ? reject(err) : resolve(undefined),
				);
			});
		}
	}
}

module.exports = { IoCoreConnection };
