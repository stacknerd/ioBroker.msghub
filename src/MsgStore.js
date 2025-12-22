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
	 * @param {import('./MsgArchive').MsgArchive} [msgArchive] Archive sink for lifecycle events.
	 */
	constructor(adapter, messages = [], msgFactory, msgStorage, msgArchive) {
		if (!adapter) {
			throw new Error('MsgStore: adapter is required');
		}
		this.adapter = adapter;

		if (!msgFactory) {
			throw new Error('MsgStore: msgFactory is required');
		}
		if (!msgStorage) {
			throw new Error('MsgStore: msgStorage is required');
		}
		this.msgFactory = msgFactory;
		this.msgStorage = msgStorage;
		this.msgArchive = msgArchive;
		this.lastPruneAt = 0;
		this.pruneIntervalMs = 30000;

		this.fullList = messages;

		if (this.adapter?.log?.info) {
			this.adapter.log.info(
				`MsgStore initialized: pruneInterval=${this.pruneIntervalMs}ms, ${!msgArchive ? 'msgArchive not available' : 'msgArchive connected'}`,
			);
		}
	}

	/**
	 * Adds a new message if it does not exist yet.
	 * Returns false when ref already exists or level is not an integer.
	 *
	 * @param {object} msg Normalized message object.
	 * @returns {boolean} True when added.
	 */
	addMessage(msg) {
		this.pruneOldMessages();

		if (msg.level !== parseInt(msg.level, 10)) {
			return false;
		}
		if (this.getMessageByRef(msg.ref) != null) {
			return false;
		}

		this.fullList.push(msg);
		this.msgStorage.writeJson(this.fullList);

		this.msgArchive?.appendSnapshot?.(msg);
		this.adapter?.log?.debug?.(`added Message '${msg.ref}'`);

		//if (!silent) setState(this.msgStorage + '.Latest', JSON.stringify(msg), true);
		//if (!silent) setState(this.getStorageSubId(msg.level), JSON.stringify(msg), true);
		return true;
	}

	/**
	 * Updates an existing message by applying a patch via MsgFactory.
	 * Accepts either a full patch object (with `ref`) or a (ref, patch) pair.
	 *
	 * @param {object|string} msgOrRef Patch object that includes a ref, or a ref string.
	 * @param {object} [patch] Patch object when ref is provided separately.
	 * @returns {boolean} True when updated.
	 */
	updateMessage(msgOrRef, patch = undefined) {
		this.pruneOldMessages();

		const msg = typeof msgOrRef === 'string' ? { ...(patch || {}), ref: msgOrRef } : msgOrRef;

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

		const existing = this.fullList[index];
		const factory = this.msgFactory;
		if (!factory || typeof factory.applyPatch !== 'function') {
			this.adapter?.log?.warn?.('MsgStore.updateMessage: msgFactory not available');
			return false;
		}

		// Delegate validation + normalization to the factory.
		const updated = factory.applyPatch(existing, msg);
		if (!updated) {
			return false;
		}

		this.fullList[index] = updated;
		this.msgStorage.writeJson(this.fullList);

		this.msgArchive?.appendPatch?.(msg.ref, msg, existing, updated);
		this.adapter?.log?.debug?.(`updated Message '${msg.ref}'`);

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
		this.pruneOldMessages();
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
		this.pruneOldMessages();
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
		this.pruneOldMessages();
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
		this.pruneOldMessages();
		return this.fullList;
	}

	/**
	 * Removes a message by ref.
	 *
	 * @param {string} reference Message ref.
	 * @returns {void}
	 */
	removeMessage(reference) {
		this.pruneOldMessages();

		var remove = this.getMessageByRef(reference);
		if (remove == null) {
			return;
		}

		this.fullList = this.fullList.filter(item => item.ref !== reference);
		this.msgArchive?.appendDelete?.(remove);

		this.msgStorage.writeJson(this.fullList);
		this.adapter?.log?.debug?.(`removed Message '${reference}'`);

		//setState(this.msgStorage + '.Removed', JSON.stringify(remove), true);
		//setState(this.msgStorage, JSON.stringify(this.fullList), true);
	}

	/**
	 * Removes expired messages based on their expires time.
	 *
	 * @returns {void}
	 */
	pruneOldMessages() {
		const now = Date.now();
		if (now - this.lastPruneAt < this.pruneIntervalMs) {
			return;
		}
		this.lastPruneAt = now;

		const isExpired = item => typeof item?.timing?.expiresAt === 'number' && item.timing.expiresAt < now;
		const removals = this.fullList.filter(isExpired);

		if (removals.length === 0) {
			return;
		}

		this.fullList = this.fullList.filter(item => !isExpired(item));
		this.msgStorage.writeJson(this.fullList);

		for (const msg of removals) {
			this.msgArchive?.appendDelete?.(msg, { event: 'expired' });
			this.adapter?.log?.debug?.(`remoed expired Message '${msg.ref}'`);
		}
	}
}

module.exports = { MsgStore };
