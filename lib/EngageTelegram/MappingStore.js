/**
 * MappingStore (EngageTelegram)
 * ============================
 *
 * Keeps Telegram-related mapping data persistent in ioBroker states.
 *
 * Why this exists:
 * - `EngageTelegram` has a lot of flow/UX logic (send, commands, callbacks, timeouts).
 * - Mapping/persistence is its own concern (records, indexes, pruning, queries).
 *
 * Design goals:
 * - Small surface area (clear API).
 * - Human-readable code flow (explicit helpers and naming).
 * - Future-proof: records can represent due-notifications *and* user chat UI messages.
 */

'use strict';

const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Create a persistent mapping store for EngageTelegram.
 *
 * @param {object} deps Dependencies.
 * @param {object} deps.iobroker ioBroker adapter helpers (`objects`, `states`).
 * @param {object} deps.log Logger (`warn`, optional `debug`).
 * @param {string} deps.baseFullId Plugin base object id (e.g. `msghub.0.EngageTelegram.0`).
 * @param {number} [deps.retentionMs] Retention for stale records (GC), default 90 days.
 * @returns {object} Mapping store API.
 */
function createMappingStore({ iobroker, log, baseFullId, retentionMs = DEFAULT_RETENTION_MS }) {
	const mappingRefStateId = `${baseFullId}.mappingByRef`;
	const mappingUiStateId = `${baseFullId}.mappingByUiId`;
	const mappingShortStateId = `${baseFullId}.mappingShortToRef`;

	let mappingByRef = Object.create(null);
	let mappingByUiId = Object.create(null);
	let mappingShortToRef = Object.create(null);

	const debug = msg => {
		if (typeof log?.debug === 'function') {
			log.debug(String(msg));
		}
	};

	/**
	 * Ensure a JSON state exists (read-only for users).
	 *
	 * @param {string} id State id.
	 * @param {string} name Human label.
	 * @returns {Promise<void>}
	 */
	const ensureJsonState = (id, name) =>
		iobroker.objects
			.setObjectNotExists(id, {
				type: 'state',
				common: {
					name: name || id,
					type: 'string',
					role: 'json',
					read: true,
					write: false,
				},
				native: {},
			})
			.catch(err => log?.warn?.(`failed to create state "${id}": ${err?.message || err}`));

	/**
	 * Read a JSON state and parse it. Returns `null` on empty/unreadable/invalid content.
	 *
	 * @param {string} id State id.
	 * @returns {Promise<object|null>} Parsed JSON object or null.
	 */
	const readJsonState = async id => {
		const st = await iobroker.states
			.getForeignState(id)
			.catch(err => log?.warn?.(`failed to read state "${id}": ${err?.message || err}`));
		const raw = typeof st?.val === 'string' ? st.val : '';
		if (!raw.trim()) {
			return null;
		}
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? parsed : null;
		} catch (e) {
			log?.warn?.(`failed to parse json state "${id}": ${e}`);
			return null;
		}
	};

	/**
	 * Write JSON state (ack=true).
	 *
	 * @param {string} id State id.
	 * @param {object} value JSON-serializable value.
	 * @returns {Promise<void>}
	 */
	const writeJsonState = (id, value) =>
		iobroker.states.setState(id, { val: JSON.stringify(value || {}), ack: true }).catch(err => {
			log?.warn?.(`failed to write state "${id}": ${err?.message || err}`);
		});

	/**
	 * Remove a `ref` record and cleanup its short-id index entry (if it matches).
	 *
	 * @param {string} ref Message ref.
	 * @returns {boolean} `true` if removed, else `false`.
	 */
	const removeByRef = ref => {
		const key = typeof ref === 'string' ? ref.trim() : '';
		if (!key) {
			return false;
		}
		const entry = mappingByRef[key];
		if (!entry || typeof entry !== 'object') {
			return false;
		}
		const shortId = typeof entry.shortId === 'string' ? entry.shortId : '';
		if (shortId && mappingShortToRef[shortId] === key) {
			delete mappingShortToRef[shortId];
		}
		delete mappingByRef[key];
		return true;
	};

	/**
	 * Remove a UI record (e.g. `/tasks` list message) by `uiId`.
	 *
	 * @param {string} uiId UI record id.
	 * @returns {boolean} `true` if removed, else `false`.
	 */
	const removeByUiId = uiId => {
		const key = typeof uiId === 'string' ? uiId.trim() : '';
		if (!key) {
			return false;
		}
		if (!mappingByUiId[key]) {
			return false;
		}
		delete mappingByUiId[key];
		return true;
	};

	/**
	 * Create or update a record.
	 *
	 * Notes:
	 * - Provide either `ref` OR `uiId`.
	 * - `shortId` is only indexed for `ref`-records (`shortId -> ref`).
	 *
	 * @param {object} record Record to upsert.
	 * @param {string} [record.purpose] Free-form purpose label (e.g. `due`, `tasks`).
	 * @param {string} [record.ref] MsgHub message ref (stable identity).
	 * @param {string} [record.uiId] UI record id (e.g. `<chatId>:tasks`).
	 * @param {string} [record.shortId] Short id for callback routing.
	 * @param {string} [record.textHtml] Telegram text snapshot (HTML).
	 * @param {string} [record.textPlain] Telegram text snapshot (plain).
	 * @param {object} [record.chatMessages] Mapping `{ [chatId]: messageId }`.
	 * @param {object} [record.imagesByValue] Mapping `{ [attachmentValue]: { chatMessages: object, createdAt: number } }`.
	 * @param {number} [record.createdAt] Epoch ms when telegram message was created.
	 * @param {number} [record.updatedAt] Epoch ms for last record update.
	 * @param {boolean} [record.shouldHaveButtons] UX hint; used for GC of inactive entries.
	 * @param {object} [record.state] Optional UI/timeout state for future features.
	 * @returns {object|null} The stored record (by reference) or `null` if input is invalid.
	 */
	const upsert = record => {
		const ref = typeof record?.ref === 'string' ? record.ref.trim() : '';
		const uiId = typeof record?.uiId === 'string' ? record.uiId.trim() : '';
		if (!ref && !uiId) {
			return null;
		}
		if (ref && uiId) {
			return null;
		}

		const now = Date.now();
		const createdAt = Number.isFinite(record?.createdAt) ? record.createdAt : now;
		const updatedAt = Number.isFinite(record?.updatedAt) ? record.updatedAt : createdAt;

		const stored = {
			purpose: typeof record?.purpose === 'string' ? record.purpose.trim() : '',
			...(ref ? { ref } : {}),
			...(uiId ? { uiId } : {}),
			shortId: typeof record?.shortId === 'string' ? record.shortId.trim() : '',
			textHtml: typeof record?.textHtml === 'string' ? record.textHtml : '',
			textPlain: typeof record?.textPlain === 'string' ? record.textPlain : '',
			chatMessages:
				record?.chatMessages && typeof record.chatMessages === 'object' ? { ...record.chatMessages } : {},
			imagesByValue:
				record?.imagesByValue && typeof record.imagesByValue === 'object' ? { ...record.imagesByValue } : {},
			createdAt,
			updatedAt,
			shouldHaveButtons: record?.shouldHaveButtons === false ? false : true,
			state: record?.state && typeof record.state === 'object' ? { ...record.state } : undefined,
		};

		// Ref-record: keep short-id index consistent.
		if (ref) {
			const previous = mappingByRef[ref];
			const oldShortId = typeof previous?.shortId === 'string' ? previous.shortId : '';
			if (oldShortId && mappingShortToRef[oldShortId] === ref) {
				delete mappingShortToRef[oldShortId];
			}

			mappingByRef[ref] = stored;
			if (stored.shortId) {
				mappingShortToRef[stored.shortId] = ref;
			}
			return stored;
		}

		// UI-record: currently no short-id index (callbacks map to refs, not uiIds).
		mappingByUiId[uiId] = stored;
		return stored;
	};

	/**
	 * Get a ref record by MsgHub `ref`.
	 *
	 * @param {string} ref MsgHub ref.
	 * @returns {object|null} Record or null.
	 */
	const getByRef = ref => {
		const key = typeof ref === 'string' ? ref.trim() : '';
		return key && mappingByRef[key] ? mappingByRef[key] : null;
	};

	/**
	 * Get a UI record by `uiId`.
	 *
	 * @param {string} uiId UI id.
	 * @returns {object|null} Record or null.
	 */
	const getByUiId = uiId => {
		const key = typeof uiId === 'string' ? uiId.trim() : '';
		return key && mappingByUiId[key] ? mappingByUiId[key] : null;
	};

	/**
	 * Resolve a ref from a callback `shortId`.
	 *
	 * @param {string} shortId Short id.
	 * @returns {string} Ref or empty string.
	 */
	const getRefByShortId = shortId => {
		const key = typeof shortId === 'string' ? shortId.trim() : '';
		return key && typeof mappingShortToRef[key] === 'string' ? mappingShortToRef[key] : '';
	};

	/**
	 * Query all records (ref + ui) using a predicate.
	 *
	 * This intentionally pushes "job selection logic" into the engine:
	 * - "auto-delete after 46h"
	 * - "revert keyboard after timeout"
	 * - "list all due records for a chat"
	 *
	 * @param {Function} predicate `(record) => boolean`.
	 * @returns {object[]} Matching records.
	 */
	const query = predicate => {
		const fn = typeof predicate === 'function' ? predicate : null;
		const out = [];
		for (const entry of Object.values(mappingByRef)) {
			if (!entry || typeof entry !== 'object') {
				continue;
			}
			if (!fn || fn(entry)) {
				out.push(entry);
			}
		}
		for (const entry of Object.values(mappingByUiId)) {
			if (!entry || typeof entry !== 'object') {
				continue;
			}
			if (!fn || fn(entry)) {
				out.push(entry);
			}
		}
		return out;
	};

	/**
	 * GC old, inactive records to prevent unbounded growth.
	 *
	 * Current rule (keeps compatibility with the previous implementation):
	 * - If `shouldHaveButtons === false` and `updatedAt` is older than retention -> delete.
	 *
	 * @param {number} nowMs Epoch ms.
	 */
	const prune = (nowMs = Date.now()) => {
		const cutoff = nowMs - Number(retentionMs);
		const deleteRefs = [];
		const deleteUiIds = [];

		for (const [ref, entry] of Object.entries(mappingByRef)) {
			const updatedAt = Number(entry?.updatedAt);
			if (entry && entry.shouldHaveButtons === false && Number.isFinite(updatedAt) && updatedAt <= cutoff) {
				deleteRefs.push(ref);
			}
		}

		for (const [uiId, entry] of Object.entries(mappingByUiId)) {
			const updatedAt = Number(entry?.updatedAt);
			if (entry && entry.shouldHaveButtons === false && Number.isFinite(updatedAt) && updatedAt <= cutoff) {
				deleteUiIds.push(uiId);
			}
		}

		for (const ref of deleteRefs) {
			removeByRef(ref);
		}
		for (const uiId of deleteUiIds) {
			removeByUiId(uiId);
		}

		if (deleteRefs.length > 0 || deleteUiIds.length > 0) {
			debug(`mappings: pruned stale refs=${deleteRefs.length} ui=${deleteUiIds.length} retentionDays=90`);
		}
	};

	/**
	 * Ensure all required states exist.
	 *
	 * @returns {Promise<void>}
	 */
	const ensureObjects = async () => {
		await Promise.all([
			ensureJsonState(mappingRefStateId, 'EngageTelegram mapping by ref (json)'),
			ensureJsonState(mappingUiStateId, 'EngageTelegram mapping by uiId (json)'),
			ensureJsonState(mappingShortStateId, 'EngageTelegram mapping shortId -> ref (json)'),
		]);
	};

	/**
	 * Load mappings from ioBroker states into memory.
	 *
	 * @returns {Promise<void>}
	 */
	const load = async () => {
		const [byRef, byUiId, shortToRef] = await Promise.all([
			readJsonState(mappingRefStateId),
			readJsonState(mappingUiStateId),
			readJsonState(mappingShortStateId),
		]);

		// Keep previously stored values even if one state is missing/invalid.
		if (byRef && typeof byRef === 'object') {
			mappingByRef = byRef;
		}
		if (byUiId && typeof byUiId === 'object') {
			mappingByUiId = byUiId;
		}
		if (shortToRef && typeof shortToRef === 'object') {
			mappingShortToRef = shortToRef;
		}
	};

	/**
	 * Persist all mappings to ioBroker states.
	 *
	 * @param {object} [opts] Options.
	 * @param {boolean} [opts.prune] Whether to run GC before saving, default `true`.
	 * @param {number} [opts.nowMs] Epoch ms used for pruning.
	 * @returns {Promise<void>}
	 */
	const save = async (opts = {}) => {
		const doPrune = opts.prune !== false;
		if (doPrune) {
			prune(Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now());
		}

		await Promise.all([
			writeJsonState(mappingRefStateId, mappingByRef),
			writeJsonState(mappingUiStateId, mappingByUiId),
			writeJsonState(mappingShortStateId, mappingShortToRef),
		]);
	};

	return Object.freeze({
		ensureObjects,
		load,
		save,
		prune,

		upsert,
		removeByRef,
		removeByUiId,

		getByRef,
		getByUiId,
		getRefByShortId,
		query,

		// Expose state ids for tests/debug (read-only).
		ids: Object.freeze({
			mappingRefStateId,
			mappingUiStateId,
			mappingShortStateId,
		}),
	});
}

module.exports = { createMappingStore };
