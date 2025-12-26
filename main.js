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
//const { serializeWithMaps } = require(`${__dirname}/src/MsgUtils`);

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

		//todo: config for these values
		this.locale = 'de-DE';
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		this.log?.debug?.(`config option1: ${this.config.option1}`);
		this.log?.debug?.(`config option2: ${this.config.option2}`);

		// init fatory
		this.msgFactory = new MsgFactory(this, this.msgConstants);

		//init store
		this.msgStore = new MsgStore(this, this.msgConstants, this.msgFactory);
		await this.msgStore.init();

		//this.log?.info?.(`${serializeWithMaps(this.customMap)}`);

		////////////////////////////////////
		// Notify Plugins

		const { NotifyIoBrokerState } = require(`${__dirname}/lib`);
		this.msgStore.msgNotify.registerPlugin('ioBrokerState', NotifyIoBrokerState(this));

		////////////////////////////
		// Ingest Plugins

		const { IngestRandomDemo, IngestIoBrokerStates } = require(`${__dirname}/lib`);
		this.msgStore.msgIngest.registerPlugin('iobroker-states', IngestIoBrokerStates(this, { traceEvents: true }));
		this.msgStore.msgIngest.registerPlugin('random-demo', IngestRandomDemo(this));
		this.msgStore.msgIngest.start();

		/*
		For every state in the system there has to be also an object of type state
		Here a simple template for a boolean variable named "testVariable"
		Because every adapter instance uses its own unique namespace variable names can't collide with other adapters variables

		IMPORTANT: State roles should be chosen carefully based on the state's purpose. 
		           Please refer to the state roles documentation for guidance:
		           https://www.iobroker.net/#en/documentation/dev/stateroles.md
		*/
		await this.setObjectNotExistsAsync('testVariable', {
			type: 'state',
			common: {
				name: 'testVariable',
				type: 'boolean',
				role: 'indicator',
				read: true,
				write: true,
			},
			native: {},
		});

		// In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
		this.subscribeStates('testVariable');
		// You can also add a subscription for multiple states. The following line watches all states starting with "lights."
		// this.subscribeStates('lights.*');
		// Or, if you really must, you can also watch all states. Don't do this if you don't need to. Otherwise this will cause a lot of unnecessary load on the system:
		// this.subscribeStates('*');

		/*
			setState examples
			you will notice that each setState will cause the stateChange event to fire (because of above subscribeStates cmd)
		*/
		// the variable testVariable is set to true as command (ack=false)
		await this.setState('testVariable', true);

		// same thing, but the value is flagged "ack"
		// ack should be always set to true if the value is received from or acknowledged from the target system
		await this.setState('testVariable', { val: true, ack: true });

		// same thing, but the state is deleted after 30s (getState will return null afterwards)
		await this.setState('testVariable', { val: true, ack: true, expire: 30 });

		// examples for the checkPassword/checkGroup functions
		const pwdResult = await this.checkPasswordAsync('admin', 'iobroker');
		this.log?.info?.(`check user admin pw iobroker: ${pwdResult}`);

		const groupResult = await this.checkGroupAsync('admin', 'admin');
		this.log?.info?.(`check group user admin group admin: ${groupResult}`);
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
	 * @param {string} id
	 * @param {ioBroker.Object | null | undefined} obj
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
		if (state) {
			// Forward the raw event to producer plugins (they decide what to do with ack/val changes).
			this.msgStore?.msgIngest?.dispatchStateChange?.(id, state, { source: 'iobroker.stateChange' });

			// The state was changed
			this.log?.info?.(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

			if (state.ack === false) {
				// This is a command from the user (e.g., from the UI or other adapter)
				// and should be processed by the adapter
				this.log?.info?.(`User command received for ${id}: ${state.val}`);

				// TODO: Add your control logic here
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
	onMessage(obj) {
		if (!obj || !obj.command) {
			return;
		}

		const cmd = obj.command;
		const payload = obj.message;

		this.log?.debug?.(`onMessage: '${cmd}' ${JSON.stringify(payload, null, 2)}`);
		let result;

		try {
			switch (cmd) {
				case 'create': {
					break;
				}
				case 'update': {
					break;
				}
				case 'remove': {
					break;
				}
				default:
					this.log?.debug?.(`onMessage: unknown command '${cmd}' ${JSON.stringify(payload, null, 2)}`);
			}
		} catch (e) {
			this.log?.error?.(`onMessage error: ${String(e)}`);
		}

		if (obj.callback) {
			this.sendTo(obj.from, obj.command, result, obj.callback);
		}
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
