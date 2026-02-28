/**
 * ChatRegistry (EngageTelegram)
 * =============================
 *
 * Tracks "who should receive Telegram notifications" independently from the message mapping store.
 *
 * Why this exists:
 * - ioBroker's Telegram adapter can authenticate users and exposes the known user ids via:
 *   `<telegramInstance>.communicate.users` (JSON).
 * - We want to derive private-chat registrations from that source (authoritative allow-list),
 *   and manage group registrations separately via a token flow (added later).
 *
 * Design goals:
 * - Safe sync from `<telegramInstance>.communicate.users` (avoid accidental mass-deletes on transient empties).
 * - Future-proof for: group enrollment tokens, per-chat mute, audit metadata.
 */

'use strict';

const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Create a registry for allowed Telegram chats (private + groups).
 *
 * Persistence:
 * - Stored as a JSON string in a read-only ioBroker state (ack=true).
 *
 * @param {object} deps Dependencies.
 * @param {object} deps.iobroker ioBroker adapter helpers (`objects`, `states`).
 * @param {object} deps.log Logger (`warn`, optional `debug`).
 * @param {string} deps.baseFullId Plugin base object id (e.g. `msghub.0.EngageTelegram.0`).
 * @param {number} [deps.tokenTtlMs] Default token TTL (future group enrollment).
 * @returns {object} ChatRegistry API.
 */
function createChatRegistry({ iobroker, log, baseFullId, tokenTtlMs = DEFAULT_TOKEN_TTL_MS }) {
	const registryStateId = `${baseFullId}.chatRegistry`;

	/**
	 * Internal persisted shape.
	 *
	 * - `chats`: `{ [chatId]: { chatId, type, muted, createdAt, updatedAt, meta } }`
	 * - `pending`: `{ [token]: { token, chatId, createdAt, expiresAt } }`
	 */
	let data = Object.freeze({ chats: Object.create(null), pending: Object.create(null) });

	// In-memory sync guard against transient empties in telegram's user list state.
	let usersEmptyStreak = 0;

	const debug = msg => {
		if (typeof log?.debug === 'function') {
			log.debug(String(msg));
		}
	};

	const warn = msg => {
		if (typeof log?.warn === 'function') {
			log.warn(String(msg));
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
			.catch(err => warn(`failed to create state "${id}": ${err?.message || err}`));

	/**
	 * Read a JSON state and parse it. Returns `null` on empty/unreadable/invalid content.
	 *
	 * @param {string} id State id.
	 * @returns {Promise<object|null>} Parsed JSON object or null.
	 */
	const readJsonState = async id => {
		const st = await iobroker.states
			.getForeignState(id)
			.catch(err => warn(`failed to read state "${id}": ${err?.message || err}`));
		const raw = typeof st?.val === 'string' ? st.val : '';
		if (!raw.trim()) {
			return null;
		}
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === 'object' ? parsed : null;
		} catch (e) {
			warn(`failed to parse json state "${id}": ${e}`);
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
			warn(`failed to write state "${id}": ${err?.message || err}`);
		});

	/**
	 * Normalize raw persisted JSON into a strict internal shape.
	 *
	 * Why this exists:
	 * - The registry lives in a user-visible JSON state.
	 * - We want robust parsing that survives partial data, old versions, or manual edits.
	 * - The rest of the code should be able to rely on safe defaults.
	 *
	 * @param {any} raw Parsed JSON (or null-ish).
	 * @returns {{ chats: object, pending: object }} Frozen internal data object.
	 */
	const normalizeData = raw => {
		const chatsRaw = raw?.chats && typeof raw.chats === 'object' ? raw.chats : {};
		const pendingRaw = raw?.pending && typeof raw.pending === 'object' ? raw.pending : {};
		const chats = Object.create(null);
		const pending = Object.create(null);

		for (const [chatId, entry] of Object.entries(chatsRaw)) {
			if (!entry || typeof entry !== 'object') {
				continue;
			}
			const id = String(entry.chatId ?? chatId).trim();
			if (!id) {
				continue;
			}
			const type = entry.type === 'group' ? 'group' : 'private';
			const muted = entry.muted === true;
			const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now();
			const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : createdAt;
			const meta = entry.meta && typeof entry.meta === 'object' ? { ...entry.meta } : undefined;
			chats[id] = { chatId: id, type, muted, createdAt, updatedAt, ...(meta ? { meta } : {}) };
		}

		for (const [token, entry] of Object.entries(pendingRaw)) {
			if (!entry || typeof entry !== 'object') {
				continue;
			}
			const t = String(entry.token ?? token).trim();
			const chatId = String(entry.chatId ?? '').trim();
			const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now();
			const expiresAt = Number.isFinite(entry.expiresAt) ? entry.expiresAt : createdAt + Number(tokenTtlMs);
			if (!t || !chatId) {
				continue;
			}
			const requestedByChatId =
				typeof entry.requestedByChatId === 'string' || typeof entry.requestedByChatId === 'number'
					? String(entry.requestedByChatId).trim()
					: '';
			const requestedByLabel = typeof entry.requestedByLabel === 'string' ? entry.requestedByLabel.trim() : '';
			const kind = entry.kind === 'unenroll' ? 'unenroll' : 'enroll';
			const approvalMessageId = Number.isFinite(Number(entry.approvalMessageId))
				? Number(entry.approvalMessageId)
				: 0;
			const groupStatusMessageId = Number.isFinite(Number(entry.groupStatusMessageId))
				? Number(entry.groupStatusMessageId)
				: 0;

			pending[t] = {
				token: t,
				chatId,
				kind,
				createdAt,
				expiresAt,
				...(requestedByChatId ? { requestedByChatId } : {}),
				...(requestedByLabel ? { requestedByLabel } : {}),
				...(approvalMessageId ? { approvalMessageId } : {}),
				...(groupStatusMessageId ? { groupStatusMessageId } : {}),
			};
		}

		return Object.freeze({ chats: Object.freeze(chats), pending: Object.freeze(pending) });
	};

	/**
	 * Ensure the registry state exists.
	 *
	 * State is read-only for users (write=false) because it is treated as internal storage.
	 * Changes should go through ChatRegistry to keep the shape consistent.
	 *
	 * @returns {Promise<void>}
	 */
	const ensureObjects = async () => {
		await ensureJsonState(registryStateId, 'EngageTelegram chat registry');
	};

	/**
	 * Load registry state from ioBroker.
	 *
	 * @returns {Promise<void>}
	 */
	const load = async () => {
		const raw = await readJsonState(registryStateId);
		data = normalizeData(raw || {});
	};

	/**
	 * Persist the current registry state to ioBroker (ack=true).
	 *
	 * @returns {Promise<void>}
	 */
	const save = async () => {
		await writeJsonState(registryStateId, data);
	};

	/**
	 * Return the current internal snapshot.
	 *
	 * @returns {{ chats: object, pending: object }} Frozen data snapshot.
	 */
	const getAll = () => data;

	/**
	 * Read one chat entry.
	 *
	 * @param {string|number} chatId Telegram chat id.
	 * @returns {object|null} Chat entry or null.
	 */
	const getChat = chatId => {
		const id = typeof chatId === 'string' || typeof chatId === 'number' ? String(chatId).trim() : '';
		return id && data.chats[id] ? data.chats[id] : null;
	};

	/**
	 * Create or update a chat entry.
	 *
	 * Notes:
	 * - `type` should be explicit: 'private' or 'group'.
	 * - `muted` is a user-controlled local preference and is preserved unless explicitly overwritten.
	 *
	 * @param {string|number} chatId Telegram chat id.
	 * @param {object} patch Patch fields.
	 * @returns {object|null} Stored chat entry or null.
	 */
	const upsertChat = (chatId, patch) => {
		const id = typeof chatId === 'string' || typeof chatId === 'number' ? String(chatId).trim() : '';
		if (!id) {
			return null;
		}
		const now = Date.now();
		const current = data.chats[id];
		const createdAt = Number.isFinite(current?.createdAt) ? current.createdAt : now;
		const type =
			patch?.type === 'group' ? 'group' : patch?.type === 'private' ? 'private' : current?.type || 'private';
		const muted = typeof patch?.muted === 'boolean' ? patch.muted : current?.muted === true;
		const meta = patch?.meta && typeof patch.meta === 'object' ? { ...patch.meta } : current?.meta;

		const nextChats = { ...data.chats };
		nextChats[id] = Object.freeze({
			chatId: id,
			type,
			muted,
			createdAt,
			updatedAt: now,
			...(meta ? { meta } : {}),
		});

		data = Object.freeze({ chats: Object.freeze(nextChats), pending: data.pending });
		return data.chats[id];
	};

	/**
	 * Remove a chat entry (private or group).
	 *
	 * This is used for:
	 * - removing private chats when an authenticated user disappears from telegram adapter state.
	 * - cleanup tasks in future enrollment flows.
	 *
	 * @param {string|number} chatId Telegram chat id.
	 * @returns {boolean} True if removed.
	 */
	const removeChat = chatId => {
		const id = typeof chatId === 'string' || typeof chatId === 'number' ? String(chatId).trim() : '';
		if (!id || !data.chats[id]) {
			return false;
		}
		const nextChats = { ...data.chats };
		delete nextChats[id];
		data = Object.freeze({ chats: Object.freeze(nextChats), pending: data.pending });
		return true;
	};

	const listChats = predicate => {
		const fn = typeof predicate === 'function' ? predicate : () => true;
		return Object.values(data.chats).filter(fn);
	};

	/**
	 * Get a pending enrollment request.
	 *
	 * Pending requests are created by `/startbot` and consumed by inline callbacks.
	 *
	 * @param {string} token Request id (short token).
	 * @returns {object|null} Pending record or null.
	 */
	const getPending = token => {
		const t = typeof token === 'string' ? token.trim() : '';
		return t && data.pending[t] ? data.pending[t] : null;
	};

	/**
	 * Create/update a pending enrollment request.
	 *
	 * We persist message ids (private approval message + group status message) so we can:
	 * - edit the messages on "allow/deny"
	 * - delete them later when we add timeouts/cleanup
	 *
	 * @param {string} token Request id (short token).
	 * @param {object} record Request record.
	 * @param {string|number} record.chatId Group chat id.
	 * @param {'enroll'|'unenroll'} [record.kind] Request kind.
	 * @param {number} [record.expiresAt] Expiry timestamp (epoch ms).
	 * @param {string|number} [record.requestedByChatId] Requester private chat id (derived from telegram users list).
	 * @param {string} [record.requestedByLabel] Requester label as seen in telegram adapter payload.
	 * @param {number} [record.approvalMessageId] Telegram message id of the private approval prompt.
	 * @param {number} [record.groupStatusMessageId] Telegram message id of the neutral group status message.
	 * @returns {object|null} Stored record or null.
	 */
	const upsertPending = (token, record) => {
		const t = typeof token === 'string' ? token.trim() : '';
		if (!t) {
			return null;
		}
		const groupChatId =
			typeof record?.chatId === 'string' || typeof record?.chatId === 'number'
				? String(record.chatId).trim()
				: '';
		if (!groupChatId) {
			return null;
		}

		const now = Date.now();
		const current = data.pending[t];
		const createdAt = Number.isFinite(current?.createdAt) ? current.createdAt : now;
		const expiresAt = Number.isFinite(record?.expiresAt) ? record.expiresAt : createdAt + Number(tokenTtlMs);
		const requestedByChatId =
			typeof record?.requestedByChatId === 'string' || typeof record?.requestedByChatId === 'number'
				? String(record.requestedByChatId).trim()
				: '';
		const requestedByLabel = typeof record?.requestedByLabel === 'string' ? record.requestedByLabel.trim() : '';
		const kind = record?.kind === 'unenroll' ? 'unenroll' : 'enroll';
		const approvalMessageId = Number.isFinite(Number(record?.approvalMessageId))
			? Number(record.approvalMessageId)
			: 0;
		const groupStatusMessageId = Number.isFinite(Number(record?.groupStatusMessageId))
			? Number(record.groupStatusMessageId)
			: 0;

		const nextPending = { ...data.pending };
		nextPending[t] = Object.freeze({
			token: t,
			chatId: groupChatId,
			kind,
			createdAt,
			expiresAt,
			...(requestedByChatId ? { requestedByChatId } : {}),
			...(requestedByLabel ? { requestedByLabel } : {}),
			...(approvalMessageId ? { approvalMessageId } : {}),
			...(groupStatusMessageId ? { groupStatusMessageId } : {}),
		});

		data = Object.freeze({ chats: data.chats, pending: Object.freeze(nextPending) });
		return data.pending[t];
	};

	/**
	 * Remove a pending enrollment request.
	 *
	 * @param {string} token Request id (short token).
	 * @returns {boolean} True if removed.
	 */
	const removePending = token => {
		const t = typeof token === 'string' ? token.trim() : '';
		if (!t || !data.pending[t]) {
			return false;
		}
		const nextPending = { ...data.pending };
		delete nextPending[t];
		data = Object.freeze({ chats: data.chats, pending: Object.freeze(nextPending) });
		return true;
	};

	/**
	 * Prune expired pending tokens.
	 *
	 * @param {number} [nowMs] Epoch ms.
	 * @returns {number} Number of removed tokens.
	 */
	const pruneExpiredTokens = (nowMs = Date.now()) => {
		const now = Number.isFinite(nowMs) ? nowMs : Date.now();
		const entries = Object.entries(data.pending);
		if (entries.length === 0) {
			return 0;
		}
		let removed = 0;
		const nextPending = { ...data.pending };
		for (const [token, entry] of entries) {
			const expiresAt = Number(entry?.expiresAt);
			if (Number.isFinite(expiresAt) && expiresAt <= now) {
				delete nextPending[token];
				removed++;
			}
		}
		if (removed > 0) {
			data = Object.freeze({ chats: data.chats, pending: Object.freeze(nextPending) });
		}
		return removed;
	};

	/**
	 * Synchronize private chat registrations from the telegram adapter's `communicate.users` JSON.
	 *
	 * Expected input shape:
	 * `{"7652837497":{"firstName":"Ben","sysMessages":false}}`
	 *
	 * Rules:
	 * - Every key becomes a `type='private'` chat (chatId = userId).
	 * - `muted` is preserved for existing entries.
	 * - Removals are guarded to avoid accidental mass-delete on transient empty lists:
	 *   - a non-empty user list always applies removals
	 *   - an empty list only applies removals after it was seen twice in a row
	 *
	 * @param {string} raw JSON string from `<telegramInstance>.communicate.users`.
	 * @param {number} [nowMs] Epoch ms.
	 * @returns {{ added: number, removed: number, updated: number, ignored: boolean }} Change summary.
	 */
	const syncPrivateChatsFromUsersState = (raw, nowMs = Date.now()) => {
		const now = Number.isFinite(nowMs) ? nowMs : Date.now();
		const s = typeof raw === 'string' ? raw.trim() : '';
		if (!s) {
			usersEmptyStreak++;
			return { added: 0, removed: 0, updated: 0, ignored: true };
		}

		let parsed = null;
		try {
			parsed = JSON.parse(s);
		} catch (e) {
			warn(`chatRegistry: users state parse failed: ${e?.message || e}`);
			return { added: 0, removed: 0, updated: 0, ignored: true };
		}

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { added: 0, removed: 0, updated: 0, ignored: true };
		}

		const userIds = Object.keys(parsed)
			.map(k => String(k).trim())
			.filter(Boolean);
		const userSet = new Set(userIds);

		if (userIds.length === 0) {
			usersEmptyStreak++;
		} else {
			usersEmptyStreak = 0;
		}

		// Guard: ignore a single transient empty list (common during adapter restarts).
		const allowRemoval = userIds.length > 0 || usersEmptyStreak >= 2;
		if (!allowRemoval) {
			debug('chatRegistry: users list empty (guarded), skipping removals');
		}

		let added = 0;
		let removed = 0;
		let updated = 0;

		const nextChats = { ...data.chats };

		// 1) Upsert all users as private chats.
		for (const userId of userIds) {
			const user = parsed && typeof parsed === 'object' ? parsed[userId] : null;
			const firstName = typeof user?.firstName === 'string' ? user.firstName.trim() : '';
			const userName = typeof user?.userName === 'string' ? user.userName.trim() : '';
			const username = typeof user?.username === 'string' ? user.username.trim() : '';
			const name = typeof user?.name === 'string' ? user.name.trim() : '';

			const existing = nextChats[userId];
			const createdAt = Number.isFinite(existing?.createdAt) ? existing.createdAt : now;
			const muted = existing?.muted === true;
			const previousMeta = existing?.meta && typeof existing.meta === 'object' ? existing.meta : undefined;
			const meta = {
				...(previousMeta ? previousMeta : {}),
				...(firstName ? { firstName } : {}),
				...(userName ? { userName } : {}),
				...(username ? { username } : {}),
				...(name ? { name } : {}),
			};

			const next = Object.freeze({
				chatId: userId,
				type: 'private',
				muted,
				createdAt,
				updatedAt: now,
				...(Object.keys(meta).length > 0 ? { meta } : {}),
			});
			if (!existing) {
				added++;
			} else if (existing.type !== 'private') {
				updated++;
			}
			nextChats[userId] = next;
		}

		// 2) Remove private chats that no longer exist in the telegram user list.
		if (allowRemoval) {
			for (const chat of Object.values(nextChats)) {
				if (!chat || typeof chat !== 'object') {
					continue;
				}
				if (chat.type !== 'private') {
					continue;
				}
				if (!userSet.has(chat.chatId)) {
					delete nextChats[chat.chatId];
					removed++;
				}
			}
		}

		data = Object.freeze({ chats: Object.freeze(nextChats), pending: data.pending });
		return { added, removed, updated, ignored: false };
	};

	return Object.freeze({
		ensureObjects,
		load,
		save,
		getAll,
		getChat,
		upsertChat,
		removeChat,
		listChats,
		getPending,
		upsertPending,
		removePending,
		pruneExpiredTokens,
		syncPrivateChatsFromUsersState,
	});
}

module.exports = { createChatRegistry };
