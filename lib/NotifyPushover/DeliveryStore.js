/**
 * NotifyPushover DeliveryStore
 * ===========================
 *
 * Plugin-owned persistence for Pushover delivery receipts.
 *
 * Docs: ../../docs/plugins/NotifyPushover.md
 */

'use strict';

const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Create a persistent delivery store for NotifyPushover.
 *
 * The store tracks which image attachment values have already been sent for
 * the current due-cycle of a message ref. A new due notification resets the
 * record, while update-like notifications add only previously unseen images.
 *
 * @param {object} deps Dependencies.
 * @param {object} deps.iobroker ioBroker facade with `objects` and `states`.
 * @param {object} deps.log Logger with optional `warn` and `debug`.
 * @param {string} deps.baseFullId Plugin base object id.
 * @param {number} [deps.retentionMs] Retention for stale records.
 * @returns {object} Store API.
 */
function createDeliveryStore({ iobroker, log, baseFullId, retentionMs = DEFAULT_RETENTION_MS }) {
	const stateId = `${String(baseFullId || '').trim()}.deliveryByRef`;

	let deliveryByRef = Object.create(null);

	/**
	 * Write a debug log message when available.
	 *
	 * @param {string} msg Message.
	 * @returns {void}
	 */
	const debug = msg => {
		if (typeof log?.debug === 'function') {
			log.debug(String(msg));
		}
	};

	/**
	 * Ensure the JSON state exists.
	 *
	 * @returns {Promise<void>} Resolves when the object exists.
	 */
	const ensureObjects = () =>
		iobroker.objects
			.setObjectNotExists(stateId, {
				type: 'state',
				common: {
					name: 'NotifyPushover delivery by ref (json)',
					type: 'string',
					role: 'json',
					read: true,
					write: false,
				},
				native: {},
			})
			.catch(err => log?.warn?.(`failed to create state "${stateId}": ${err?.message || err}`));

	/**
	 * Read and parse the persisted delivery state.
	 *
	 * @returns {Promise<object|null>} Parsed value or null.
	 */
	const readJsonState = async () => {
		const st = await iobroker.states
			.getForeignState(stateId)
			.catch(err => log?.warn?.(`failed to read state "${stateId}": ${err?.message || err}`));
		const raw = typeof st?.val === 'string' ? st.val : '';
		if (!raw.trim()) {
			return null;
		}
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
		} catch (e) {
			log?.warn?.(`failed to parse json state "${stateId}": ${e?.message || e}`);
			return null;
		}
	};

	/**
	 * Persist the current delivery state.
	 *
	 * @param {object} value JSON-serializable value.
	 * @returns {Promise<void>} Resolves when written.
	 */
	const writeJsonState = value =>
		iobroker.states.setState(stateId, { val: JSON.stringify(value || {}), ack: true }).catch(err => {
			log?.warn?.(`failed to write state "${stateId}": ${err?.message || err}`);
		});

	/**
	 * Load persisted delivery records.
	 *
	 * @returns {Promise<void>} Resolves after load.
	 */
	const load = async () => {
		const parsed = await readJsonState();
		if (parsed && typeof parsed === 'object') {
			deliveryByRef = parsed;
		}
	};

	/**
	 * Remove stale records with no recent update.
	 *
	 * @param {number} [nowMs] Epoch ms.
	 * @returns {void}
	 */
	const prune = (nowMs = Date.now()) => {
		const cutoff = nowMs - Number(retentionMs);
		const removed = [];
		for (const [ref, record] of Object.entries(deliveryByRef)) {
			const updatedAt = Number(record?.updatedAt);
			if (Number.isFinite(updatedAt) && updatedAt <= cutoff) {
				removed.push(ref);
			}
		}
		for (const ref of removed) {
			delete deliveryByRef[ref];
		}
		if (removed.length > 0) {
			debug(`delivery: pruned stale refs=${removed.length}`);
		}
	};

	/**
	 * Save delivery records.
	 *
	 * @param {object} [opts] Options.
	 * @param {boolean} [opts.prune] Whether to prune before saving.
	 * @param {number} [opts.nowMs] Epoch ms used for pruning.
	 * @returns {Promise<void>} Resolves after save.
	 */
	const save = async (opts = {}) => {
		if (opts.prune !== false) {
			prune(Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now());
		}
		await writeJsonState(deliveryByRef);
	};

	/**
	 * Get a delivery record by ref.
	 *
	 * @param {string} ref Message ref.
	 * @returns {object|null} Delivery record or null.
	 */
	const getByRef = ref => {
		const key = typeof ref === 'string' ? ref.trim() : '';
		return key && deliveryByRef[key] ? deliveryByRef[key] : null;
	};

	/**
	 * Remove a delivery record by ref.
	 *
	 * @param {string} ref Message ref.
	 * @returns {boolean} True when a record was removed.
	 */
	const removeByRef = ref => {
		const key = typeof ref === 'string' ? ref.trim() : '';
		if (!key || !deliveryByRef[key]) {
			return false;
		}
		delete deliveryByRef[key];
		return true;
	};

	/**
	 * Create or replace a delivery record.
	 *
	 * @param {object} record Delivery record.
	 * @param {string} record.ref Message ref.
	 * @param {object} [record.imagesByValue] Sent image receipt map.
	 * @param {number} [record.createdAt] Epoch ms.
	 * @param {number} [record.updatedAt] Epoch ms.
	 * @returns {object|null} Stored record or null.
	 */
	const upsert = record => {
		const ref = typeof record?.ref === 'string' ? record.ref.trim() : '';
		if (!ref) {
			return null;
		}
		const now = Date.now();
		const createdAt = Number.isFinite(record?.createdAt) ? record.createdAt : now;
		const updatedAt = Number.isFinite(record?.updatedAt) ? record.updatedAt : createdAt;
		const stored = {
			ref,
			imagesByValue:
				record?.imagesByValue && typeof record.imagesByValue === 'object' ? { ...record.imagesByValue } : {},
			createdAt,
			updatedAt,
		};
		deliveryByRef[ref] = stored;
		return stored;
	};

	return Object.freeze({
		ensureObjects,
		load,
		save,
		prune,
		getByRef,
		removeByRef,
		upsert,
		ids: Object.freeze({ stateId }),
	});
}

module.exports = { createDeliveryStore };
