'use strict';

/*
 * Created with @iobroker/create-adapter v3.1.2
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const { MsgArchive } = require(`${__dirname}/src/MsgArchive`);
const { MsgStorage } = require(`${__dirname}/src/MsgStorage`);
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
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
		this.msgConstants = MsgConstants;
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		this.log.debug('config option1: ${this.config.option1}');
		this.log.debug('config option2: ${this.config.option2}');

		// init file storage
		this.msgStorage = new MsgStorage(this, { fileName: 'messages.json' });
		await this.msgStorage.init();

		// init archive
		//this.msgArchive = null;
		this.msgArchive = new MsgArchive(this); // auch null möglich, wenn kein Archiv erwünscht
		await this.msgArchive?.init();

		// init fatory
		this.msgFactory = new MsgFactory(this, this.msgConstants);

		//init store
		this.store = new MsgStore(
			this,
			[], //await this.msgStorage.readJson({}),
			this.msgFactory,
			this.msgStorage,
			this.msgArchive,
		);

		const msg1 = this.msgFactory.createMessage({
			ref: '2438',
			title: 'ein titel-text',
			text: 'lorem ipsum...',
			level: this.msgConstants.level.error,
			kind: this.msgConstants.kind.appointment,
			origin: { type: this.msgConstants.origin.type.import, system: 'alexa', id: 'alexa.0.test' },
			timing: { startAt: 2134928374923, endAt: 2134928374950 },
			details: { location: 'zimmer', tools: ['1', '2'], consumables: 'batterien' },
		});
		this.store.addMessage(msg1);

		const msg2ref = 'pathingthings-3';

		const msg2 = this.msgFactory.createMessage({
			ref: msg2ref,
			title: 'ewefin titel-text',
			text: 'lowefrem ipsum...',
			level: this.msgConstants.level.warning,
			kind: this.msgConstants.kind.task,
			origin: { type: this.msgConstants.origin.type.import, system: 'web', id: '383' },
			timing: { expiresAt: 2134928374923, dueAt: 2134928374924, notifyAt: 2134928374910 },
			details: { consumables: 'Eimer,Lappen,Staubsauger' },
			progress: { percentage: 20, startedAt: Date.now() },
		});

		this.store.addMessage(msg2);

		const patch4msg2 = {
			title: 'ewefin titel-text (this has been updated!)',
			metrics: new Map([
				['temperature', { val: 21.7, unit: 'C', ts: Date.now() }],
				['humidity', { val: 46, unit: '%', ts: Date.now() }],
				['state', { val: 'ok', unit: 'status', ts: Date.now() }],
				['batteryLow', { val: false, unit: 'bool', ts: Date.now() }],
				['lastSeen', { val: null, unit: 'timestamp', ts: Date.now() }],
			]),
		};
		this.store.updateMessage(msg2ref, patch4msg2);

		this.store.updateMessage(msg2ref, {
			metrics: {
				set: { temperature: { val: 22.3, unit: 'C+', ts: Date.now() } },
				delete: ['humidity'],
			},
		});

		this.store.updateMessage(msg2ref, {
			actions: { set: { 'ack-1': { type: 'ack' } } },
		});

		this.log.debug(JSON.stringify(this.store.getMessages(), null, 2));

		this.store.updateMessage(msg2ref, {
			listItems: {
				set: { milk: { name: 'Milk', checked: false } },
				delete: ['oldItemId'],
			},
		});
		this.log.debug(this.msgStorage._serialize(this.store.getMessages(), null, 2));

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
		this.log.info(`check user admin pw iobroker: ${pwdResult}`);

		const groupResult = await this.checkGroupAsync('admin', 'admin');
		this.log.info(`check group user admin group admin: ${groupResult}`);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback - Callback function
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

			this.msgStorage.flushPending();
			this.msgArchive?.flushPending?.();
		} catch (error) {
			this.log.error(`Error during unloading: ${error.message}`);
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
	 * Is called if a subscribed state changes
	 *
	 * @param {string} id - State ID
	 * @param {ioBroker.State | null | undefined} state - State object
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

			if (state.ack === false) {
				// This is a command from the user (e.g., from the UI or other adapter)
				// and should be processed by the adapter
				this.log.info(`User command received for ${id}: ${state.val}`);

				// TODO: Add your control logic here
			}
		} else {
			// The object was deleted or the state value has expired
			this.log.info(`state ${id} deleted`);
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
