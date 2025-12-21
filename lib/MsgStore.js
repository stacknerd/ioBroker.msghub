/**
 * In-memory message repository with persistence hooks.
 * Keeps the list in memory and delegates schema-aware changes to MsgFactory.
 */
class MsgStore {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance for logging.
	 * @param {Array<object>} messages Initial message list (use [] if no data).
	 * @param {import('./MsgFactory').MsgFactory} msgFactory Factory used for patching/validation.
	 * @param {import('./MsgStorage').MsgStorage} msgStorage Storage used for persistence.
	 */
	constructor(adapter, messages = [], msgFactory, msgStorage) {
		if (!adapter) {
			throw new Error('MsgStore: adapter is required');
		}
		if (!msgFactory) {
			throw new Error('MsgStore: msgFactory is required');
		}
		if (!msgStorage) {
			throw new Error('MsgStore: msgStorage is required');
		}
		this.adapter = adapter;
		this.msgFactory = msgFactory;
		this.msgStorage = msgStorage;

		this.fullList = messages;
	}

	/**
	 * Adds a new message if it does not exist yet.
	 * Returns false when ref already exists or level is not an integer.
	 *
	 * @param {object} msg Normalized message object.
	 * @returns {boolean} True when added.
	 */
	addMessage(msg) {
		this.deleteOldMessages();
		if (msg.level !== parseInt(msg.level, 10)) {
			return false;
		}
		if (this.getMessageByRef(msg.ref) != null) {
			return false;
		}

		this.fullList.push(msg);
		this.msgStorage.writeJson(this.fullList);
		//if (!silent) setState(this.msgStorage + '.Latest', JSON.stringify(msg), true);
		//if (!silent) setState(this.getStorageSubId(msg.level), JSON.stringify(msg), true);
		return true;
	}

	/**
	 * Updates an existing message by applying a patch via MsgFactory.
	 * The patch object must include the message ref to locate the target entry.
	 *
	 * @param {object} msg Patch object that includes a ref and fields to update.
	 * @returns {boolean} True when updated.
	 */
	updateMessage(msg) {
		this.deleteOldMessages();

		if (!msg || typeof msg !== 'object') {
			return false;
		}
		if (typeof msg.ref !== 'string' || !msg.ref.trim()) {
			return false;
		}

		const index = this.fullList.findIndex(item => item.ref === msg.ref);
		if (index === -1) {
			return false;
		}

		const factory = this.msgFactory;
		if (!factory || typeof factory.applyPatch !== 'function') {
			this.adapter?.log?.warn?.('MsgStore.updateMessage: msgFactory not available');
			return false;
		}

		// Delegate validation + normalization to the factory.
		const updated = factory.applyPatch(this.fullList[index], msg);
		if (!updated) {
			return false;
		}
		this.fullList[index] = updated;
		this.msgStorage.writeJson(this.fullList);
		//setState(this.msgStorage, JSON.stringify(this.fullList), true);
		//if (!silent) setState(this.msgStorage + '.Latest', JSON.stringify(msg), true);
		//if (!silent) setState(this.getStorageSubId(msg.level), JSON.stringify(msg), true);
		return true;
	}

	/**
	 * Adds a message or updates it when the ref already exists.
	 *
	 * @param {object} msg Message or patch payload.
	 * @returns {boolean} True when added or updated.
	 */
	addOrUpdateMessage(msg) {
		this.deleteOldMessages();
		if (this.getMessageByRef(msg.ref) != null) {
			return this.updateMessage(msg);
		}
		return this.addMessage(msg);
	}

	/**
	 * Returns the first message that matches a ref.
	 *
	 * @param {string} reference Message ref.
	 * @returns {object|undefined} Matching message, if found.
	 */
	getMessageByRef(reference) {
		this.deleteOldMessages();
		return this.fullList.filter(obj => {
			return obj.ref === reference;
		})[0];
	}

	/**
	 * Returns all messages with a given level.
	 *
	 * @param {number} level Message level to filter on.
	 * @returns {Array<object>} Matching messages.
	 */
	getMessagesByLevel(level) {
		this.deleteOldMessages();
		return this.fullList.filter(obj => {
			return obj.level == level;
		});
	}

	/**
	 * Returns the current message list.
	 *
	 * @returns {Array<object>} All messages.
	 */
	getMessages() {
		this.deleteOldMessages();
		return this.fullList;
	}

	/**
	 * Removes a message by ref.
	 *
	 * @param {string} reference Message ref.
	 * @returns {void}
	 */
	removeMessage(reference) {
		this.deleteOldMessages();
		var remove = this.getMessageByRef(reference);
		if (remove == null) {
			return;
		}
		this.fullList = this.fullList.filter(item => item.ref !== reference);
		//setState(this.msgStorage + '.Removed', JSON.stringify(remove), true);
		//setState(this.msgStorage, JSON.stringify(this.fullList), true);
	}

	/**
	 * Removes expired messages based on their end time.
	 * Currently disabled because the old filter does not fit the new model.
	 *
	 * @returns {void}
	 */
	deleteOldMessages() {
		// Disabled for the new message model; keep hook for future pruning.
		return; // old filter does not work on new model
		if (this.fullList.filter(item => item.end < new Date().getTime()).length === 0) {
			return;
		}
		this.fullList = this.fullList.filter(item => item.end >= new Date().getTime());
		//setState(this.msgStorage, JSON.stringify(this.fullList), true);
	}
}

module.exports = { MsgStore };
