const { serializeWithMaps } = require(`${__dirname}/MsgUtils`);
const { MsgStorage } = require(`${__dirname}/MsgStorage`);
const { MsgArchive } = require(`${__dirname}/MsgArchive`);
const { MsgRender } = require(`${__dirname}/MsgRender`);
const { MsgNotify } = require(`${__dirname}/MsgNotify`);

/**
 * MsgStore
 * ========
 * Central in-memory repository for messages in Msghub. It owns the primary list,
 * coordinates persistence, and mediates all mutations through MsgFactory to keep
 * the schema normalized and consistent.
 *
 * Responsibilities:
 * - Persistence: writes the full message list via MsgStorage.
 * - Normalization: delegates create/update validation to MsgFactory.
 * - Rendering: returns display-ready messages via MsgRender.
 * - Lifecycle: prunes expired messages and archives changes in MsgArchive.
 * - Notifications: triggers MsgNotify for due or instant updates.
 *
 * Design notes:
 * - The store keeps the canonical data model; render output is a view-only layer.
 * - Notification scheduling is external; this store only triggers based on
 *   timing.notifyAt or instant-update rules when notifyAt is missing.
 * - "Expired" messages are removed based on timing.expiresAt.
 * - The archive is best-effort and does not block core operations.
 *
 * Notification flow (high level):
 * - notifyAt set: _initiateNotifications() picks due messages on a timer.
 * - notifyAt missing: addMessage() triggers immediate notification for new messages.
 * - notifyAt missing: updateMessage() can trigger immediate notification
 *   when the update is not silent and the message is not expired.
 *
 * Timing:
 * - pruneIntervalMs controls expiration checks.
 * - notifierIntervalMs controls how often due notifications are evaluated.
 */
class MsgStore {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance & { locale?: string }} adapter Adapter instance for logging and utilitys.
	 * @param {Array<object>} messages Initial message list (use [] if no data).
	 * @param {import('./MsgConstants').MsgConstants} msgConstants Centralized enum-like constants.
	 * @param {import('./MsgFactory').MsgFactory} msgFactory Factory used for patching/validation.
	 * @param {object} [options] Optional configuration.
	 * @param {number} [options.pruneIntervalMs] Prune interval in ms.
	 * @param {number} [options.notifierIntervalMs] Notification polling interval in ms.
	 */
	constructor(
		adapter,
		messages = [],
		msgConstants,
		msgFactory,
		{ pruneIntervalMs = 30000, notifierIntervalMs = 10000 } = {},
	) {
		if (!adapter) {
			throw new Error('MsgStore: adapter is required');
		}
		this.adapter = adapter;

		if (!msgConstants) {
			throw new Error('MsgStore: msgConstants is required');
		}
		this.msgConstants = msgConstants;

		if (!msgFactory) {
			throw new Error('MsgStore: msgFactory is required');
		}
		this.msgFactory = msgFactory;

		// init file storage
		this.msgStorage = new MsgStorage(this.adapter, { baseDir: 'data', fileName: 'messages.json' });
		this.msgStorage.init();

		//init archive
		this.msgArchive = new MsgArchive(this.adapter, { baseDir: 'data/archive' });
		this.msgArchive?.init();

		// init render
		this.msgRender = new MsgRender(this.adapter, { locale: this.adapter?.locale });

		//init notify
		this.msgNotify = new MsgNotify(this.adapter, this.msgConstants);

		this.fullList = messages;

		this.lastPruneAt = 0;
		this.pruneIntervalMs = pruneIntervalMs;
		this.notifierIntervalMs = notifierIntervalMs;
		this._notifyTimer = null;

		if (this.notifierIntervalMs > 0) {
			this._notifyTimer = setInterval(() => this._initiateNotifications(), this.notifierIntervalMs);
		}

		if (this.adapter?.log?.info) {
			this.adapter.log.info(
				`MsgStore initialized: pruneInterval=${this.pruneIntervalMs}ms, notifierIntervalMs=$this.{notifierIntervalMs}ms'}`,
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
		this._pruneOldMessages();

		if (msg.level !== parseInt(msg.level, 10)) {
			return false;
		}
		if (this.getMessageByRef(msg.ref) != null) {
			return false;
		}

		this.fullList.push(msg);
		this.msgStorage.writeJson(this.fullList);

		if (!Number.isFinite(msg?.timing?.notifyAt)) {
			this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.due, msg);
		}

		this.msgArchive?.appendSnapshot?.(msg);
		this.adapter?.log?.debug?.(`MsgStore: added Message '${msg.ref}'`);
		this.adapter?.log?.silly?.(`MsgStore: added Message '${serializeWithMaps(msg)}'`);

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
		this._pruneOldMessages();

		const msg = typeof msgOrRef === 'string' ? { ...(patch || {}), ref: msgOrRef } : msgOrRef;

		if (!msg || typeof msg !== 'object') {
			return false;
		}
		if (typeof msg.ref !== 'string' || !msg.ref.trim()) {
			return false;
		}

		const index = this.fullList.findIndex(item => item.ref === msg.ref);
		if (index === -1) {
			this.adapter?.log?.warn?.(`MsgStore: '${msg.ref}' could not be updated (not found)`);
			return false;
		}

		const existing = this.fullList[index];
		const factory = this.msgFactory;
		if (!factory || typeof factory.applyPatch !== 'function') {
			this.adapter?.log?.warn?.('MsgStore: msgFactory not available to update Message');
			return false;
		}

		// Delegate validation + normalization to the factory.
		const updated = factory.applyPatch(existing, msg);
		if (!updated) {
			this.adapter?.log?.warn?.(`MsgStore: '${msg.ref}' could not be updated (vaildation failed)`);
			return false;
		}

		this.fullList[index] = updated;
		this.msgStorage.writeJson(this.fullList);

		const now = Date.now();
		const t = updated?.timing;
		const hadUpdate = Number.isFinite(t?.updatedAt) && t.updatedAt !== existing?.timing?.updatedAt;
		const notExpired = typeof t?.expiresAt !== 'number' || t.expiresAt > now;

		if (!Number.isFinite(t?.notifyAt) && hadUpdate && notExpired) {
			this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.update, updated);
		}

		this.msgArchive?.appendPatch?.(msg.ref, msg, existing, updated);
		this.adapter?.log?.debug?.(`MsgStore: updated Message '${updated.ref}'`);
		this.adapter?.log?.silly?.(`MsgStore: updated Message '${serializeWithMaps(updated)}'`);

		return true;
	}

	/**
	 * Adds a message or updates it when the ref already exists.
	 *
	 * @param {object} msg Message or patch payload.
	 * @returns {boolean} True when added or updated.
	 */
	addOrUpdateMessage(msg) {
		this._pruneOldMessages();
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
		this._pruneOldMessages();
		const msg = this.fullList.filter(obj => {
			return obj.ref === reference;
		})[0];
		return this.msgRender?.renderMessage(msg) || msg;
	}

	/**
	 * Returns all messages with a given level.
	 *
	 * @param {number} level Message level to filter on.
	 * @returns {Array<object>} Matching messages.
	 */
	getMessagesByLevel(level) {
		this._pruneOldMessages();
		const levelList = this.fullList.filter(obj => {
			return obj.level == level;
		});

		return levelList.map(msg => this.msgRender?.renderMessage(msg) || msg);
	}

	/**
	 * Returns the current message list.
	 *
	 * @returns {Array<object>} All messages.
	 */
	getMessages() {
		this._pruneOldMessages();
		return this.fullList.map(msg => this.msgRender?.renderMessage(msg) || msg);
	}

	/**
	 * Removes a message by ref.
	 *
	 * @param {string} reference Message ref.
	 * @returns {void}
	 */
	removeMessage(reference) {
		this._pruneOldMessages();

		const remove = this.fullList.filter(obj => {
			return obj.ref === reference;
		})[0];
		if (remove == null) {
			return;
		}

		this.fullList = this.fullList.filter(item => item.ref !== reference);
		this.msgArchive?.appendDelete?.(remove);
		this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.deleted, remove);

		this.msgStorage.writeJson(this.fullList);
		this.adapter?.log?.debug?.(`MsgStore: removed Message '${reference}'`);
		this.adapter?.log?.silly?.(`MsgStore: removed Message '${serializeWithMaps(remove)}'`);

	}

	/**
	 * to be called on Adapter unload
	 *
	 * @returns {void}
	 */
	onUnload() {
		if (this._notifyTimer) {
			clearInterval(this._notifyTimer);
			this._notifyTimer = null;
		}

		this.msgStorage.flushPending();
		this.msgArchive?.flushPending?.();
	}

	/**
	 * Removes expired messages based on their expires time.
	 *
	 * @returns {void}
	 */
	_pruneOldMessages() {
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

		this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.expired, removals);

		for (const msg of removals) {
			this.msgArchive?.appendDelete?.(msg, { event: 'expired' });
		}

		this.adapter?.log?.debug?.(`MsgStore: removed expired Message(s) '${removals.map(msg => msg.ref).join(', ')}'`);
		this.adapter?.log?.silly?.(`MsgStore: removed expired Message(s) '${serializeWithMaps(removals)}'`);
	}

	/**
	 * hands Messages due for Notification over to msgNotify
	 *
	 * @returns {void}
	 */
	_initiateNotifications() {
		const now = Date.now();

		const isDue = item =>
			typeof item?.timing?.notifyAt === 'number' &&
			item.timing.notifyAt <= now &&
			(typeof item?.timing?.expiresAt !== 'number' || item.timing.expiresAt > now);
		const notifications = this.fullList.filter(isDue);

		if (notifications.length === 0) {
			return;
		}

		this.msgNotify?.dispatch?.(this.msgConstants.notfication.events.due, notifications);

		this.adapter?.log?.debug?.(
			`MsgStore: initiated Notification for Message(s) '${notifications.map(msg => msg.ref).join(', ')}'`,
		);
		this.adapter?.log?.silly?.(
			`MsgStore: initiated Notification for Message(s) '${serializeWithMaps(notifications)}'`,
		);
	}
}

module.exports = { MsgStore };
