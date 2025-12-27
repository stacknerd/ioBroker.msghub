/**
 * NotifyIoBrokerStates
 * ====================
 * MsgHub notifier plugin that writes notification events into ioBroker states.
 *
 * Docs: ../../docs/plugins/NotifyIoBrokerStates.md
 *
 * Core responsibilities
 * - Validate/normalize incoming `event` names (accepts MsgConstants event keys and values).
 * - Ensure the required ioBroker state objects exist (pre-create at startup, lazy-create on demand).
 * - Serialize notifications as JSON while preserving `Map` values (via `serializeWithMaps`).
 * - Write a small, script-friendly state tree for "latest", "byKind", and "byLevel".
 *
 * State model
 * - Base object id (configured by adapter): `options.pluginBaseObjectId`
 *   - Example: `msghub.0.NotifyIoBrokerStates.0`
 * - The plugin writes three subtrees below the base:
 *   - `<base>.Latest.<eventValue>`
 *   - `<base>.byKind.<kindKey>.<eventValue>`
 *   - `<base>.byLevel.<levelKey>.<eventValue>`
 *
 * Design guidelines / invariants (align with MsgStore / MsgNotify)
 * - Best-effort side-effects: state creation and state writes must never throw back into MsgNotify;
 *   failures are logged and otherwise ignored.
 * - Last-write-wins: each state holds only the most recent notification for that bucket (no history).
 * - No hardcoded enums: routing is derived solely from `MsgConstants` (events/kinds/levels).
 * - Stable payload shape:
 *   - `<base>.Latest.<event>` stores a single object for one notification, otherwise an array.
 *   - byKind/byLevel states always store a single notification object.
 *
 * Performance notes
 * - Parallel state creation is deduplicated via `initPromises` to prevent repeated `setObjectNotExistsAsync` calls.
 * - `ensureAllStates()` is fire-and-forget so adapter startup isn't blocked by admin/UI discoverability.
 */

// serializeWithMaps keeps Map values intact when converting notifications to JSON.
const { serializeWithMaps } = require(`${__dirname}/../../src/MsgUtils`);
// MsgConstants is the single source of truth for allowed kinds/levels.
const { MsgConstants } = require(`${__dirname}/../../src/MsgConstants`);

/**
 * @typedef {object} NotifyIoBrokerStatesOptions
 * @property {string} pluginBaseObjectId Full object id of the plugin base object (e.g. `msghub.0.NotifyIoBrokerStates.0`).
 * @property {string} [mapTypeMarker] Overrides the marker used by `serializeWithMaps` (default: `__msghubType`).
 */

/**
 * @typedef {object} MsgNotifyPluginContext
 * @property {{ constants: import('../../src/MsgConstants').MsgConstants }} [api] Stable API surface from MsgNotify (currently only `constants`).
 * @property {object} [meta] Dispatch metadata (forwarded from the producer, e.g. MsgStore).
 */

/**
 * @typedef {object} MsgNotification
 * A notification object passed through MsgNotify.
 *
 * @property {string} [kind] Kind used for routing (`MsgConstants.kind` key or value).
 * @property {number|string} [level] Level used for routing (`MsgConstants.level` key or value).
 *
 * Notes:
 * - The plugin treats notifications as opaque objects; it only inspects `kind` and `level` for routing.
 * - Any `Map` values inside the object will be preserved by `serializeWithMaps`.
 */

/**
 * Creates a MsgNotify plugin that writes notifications into ioBroker states.
 *
 * Docs: ../../docs/plugins/NotifyIoBrokerStates.md
 *
 * Integration contract
 * - `MsgNotify` calls `onNotifications(event, notifications, ctx)` where:
 *   - `event` is an event *value* (e.g. `"due"`) but this plugin also accepts event *keys* (e.g. `"update"`).
 *   - `notifications` is an array (MsgNotify currently passes `[singleNotification]`).
 *   - `ctx` contains `ctx.api.constants` and an optional `ctx.meta` object.
 *
 * Storage contract
 * - States are created with `setObjectNotExistsAsync` and written with `ack: true`.
 * - Payload is stored as a JSON string (`common.type = "string"`, `role = "json"`).
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance.
 * @param {NotifyIoBrokerStatesOptions} [options] Plugin options.
 * @returns {{ onNotifications: (event: string, notifications: MsgNotification[], ctx?: MsgNotifyPluginContext) => void }} Plugin instance.
 */
function NotifyIoBrokerStates(adapter, options = {}) {
	if (!adapter) {
		throw new Error('MsgNotifyStatePlugin: adapter is required');
	}

	const { pluginBaseObjectId, mapTypeMarker } = options;

	// Normalize and validate the configured base id early.
	// This plugin is intentionally strict here: without a base object id it cannot safely create/write states.
	const baseFullId = typeof pluginBaseObjectId === 'string' ? pluginBaseObjectId.trim() : '';
	if (!baseFullId) {
		throw new Error('NotifyIoBrokerStates: options.pluginBaseObjectId is required');
	}
	// ioBroker adapter APIs typically expect ids *without* the namespace prefix.
	// We accept both forms (`msghub.0.X` and `X`) and strip the namespace when present.
	const ns = typeof adapter?.namespace === 'string' ? adapter.namespace.trim() : '';
	const baseId = ns && baseFullId.startsWith(`${ns}.`) ? baseFullId.slice(ns.length + 1) : baseFullId;
	if (!baseId) {
		throw new Error('NotifyIoBrokerStates: invalid options.pluginBaseObjectId');
	}

	// These prefixes match the documented state tree under `pluginBaseObjectId`.
	const latestPrefix = `${baseId}.Latest`;
	const kindPrefix = `${baseId}.byKind`;
	const levelPrefix = `${baseId}.byLevel`;

	// Read allowed kinds/levels/events from MsgConstants to avoid hardcoded lists.
	const kindEntries = Object.entries(MsgConstants?.kind || {});
	const levelEntries = Object.entries(MsgConstants?.level || {});
	const eventEntries = Object.entries(MsgConstants?.notfication?.events || {});
	// Build lookup tables that accept either the key or the stored value.
	// This supports flexible inputs from different call sites / older integrations.
	const kindValueToKey = new Map(kindEntries.map(([key, value]) => [value, key]));
	const levelValueToKey = new Map(levelEntries.map(([key, value]) => [value, key]));
	const eventKeyToValue = new Map(eventEntries);
	const kindKeys = new Set(kindEntries.map(([key]) => key));
	const levelKeys = new Set(levelEntries.map(([key]) => key));
	const eventValues = new Set(eventEntries.map(([, value]) => value));

	// Cache in-flight state creations to avoid parallel setObject calls.
	const initPromises = new Map();
	// Track per-state display names for lazy creation in writeState.
	const stateNames = new Map();

	/**
	 * Ensure a single ioBroker state exists.
	 *
	 * This is safe to call repeatedly. Concurrent callers share one in-flight promise.
	 *
	 * @param {string} id Object id without adapter namespace prefix.
	 * @param {string|Record<string,string>} [stateName] Translated name (preferred) or string fallback.
	 * @returns {Promise<void>} Resolves when the object exists (or when creation failed but was handled).
	 */
	const ensureState = (id, stateName) => {
		// No id means nothing to create.
		if (!id) {
			return Promise.resolve();
		}
		// Reuse an existing creation promise if already started.
		if (initPromises.has(id)) {
			return initPromises.get(id);
		}
		const promise = adapter
			.setObjectNotExistsAsync(id, {
				type: 'state',
				common: {
					// Use translated name when provided, fallback to the id itself.
					name: stateName || id,
					type: 'string',
					role: 'json',
					read: true,
					write: false,
				},
				native: {},
			})
			.catch(err => {
				// On failure, drop the cached promise to allow retry later.
				initPromises.delete(id);
				adapter?.log?.warn?.(`MsgNotifyStatePlugin: failed to create state "${id}": ${err?.message || err}`);
			});
		initPromises.set(id, promise);
		return promise;
	};

	const ensureAllStates = () => {
		// Pre-create all states at startup for discoverability in admin UI.
		const promises = [];
		const eventValueList = eventEntries.map(([, value]) => value);
		for (const eventValue of eventValueList) {
			const id = `${latestPrefix}.${eventValue}`;
			const eventLabel = eventValue;
			const stateName = {
				en: `latest notification for event '${eventLabel}'`,
				de: `letzte Meldung für Ereignis '${eventLabel}'`,
				ru: `последнее уведомление для события '${eventLabel}'`,
				pt: `última notificação para o evento '${eventLabel}'`,
				nl: `laatste melding voor event '${eventLabel}'`,
				fr: `dernière notification pour l'événement '${eventLabel}'`,
				it: `ultima notifica per l'evento '${eventLabel}'`,
				es: `última notificación para el evento '${eventLabel}'`,
				pl: `najnowsze powiadomienie dla zdarzenia '${eventLabel}'`,
				uk: `останнє повідомлення для події '${eventLabel}'`,
				'zh-cn': `latest notification for event '${eventLabel}'`,
			};
			stateNames.set(id, stateName);
			promises.push(ensureState(id, stateName));
		}
		// Create one state per kind+event from MsgConstants.kind + MsgConstants.notfication.events.
		for (const [kindKey] of kindEntries) {
			// Use the kind key itself as the user-facing label.
			const kindLabel = kindKey;
			for (const eventValue of eventValueList) {
				const id = `${kindPrefix}.${kindKey}.${eventValue}`;
				const eventLabel = eventValue;
				const stateName = {
					en: `latest notification of kind '${kindLabel}' for event '${eventLabel}'`,
					de: `letzte Meldung der Art '${kindLabel}' für Ereignis '${eventLabel}'`,
					ru: `последнее уведомление вида '${kindLabel}' для события '${eventLabel}'`,
					pt: `última notificação do tipo '${kindLabel}' para o evento '${eventLabel}'`,
					nl: `laatste melding van type '${kindLabel}' voor event '${eventLabel}'`,
					fr: `dernière notification du type '${kindLabel}' pour l'événement '${eventLabel}'`,
					it: `ultima notifica del tipo '${kindLabel}' per l'evento '${eventLabel}'`,
					es: `última notificación de tipo '${kindLabel}' para el evento '${eventLabel}'`,
					pl: `najnowsze powiadomienie typu '${kindLabel}' dla zdarzenia '${eventLabel}'`,
					uk: `останнє повідомлення виду '${kindLabel}' для події '${eventLabel}'`,
					'zh-cn': `latest notification of kind '${kindLabel}' for event '${eventLabel}'`,
				};
				stateNames.set(id, stateName);
				promises.push(ensureState(id, stateName));
			}
		}
		// Create one state per level+event from MsgConstants.level + MsgConstants.notfication.events.
		const levelEventValueList = eventEntries.map(([, value]) => value);
		for (const [levelKey] of levelEntries) {
			// Use the level key itself as the user-facing label.
			const levelLabel = levelKey;
			for (const eventValue of levelEventValueList) {
				const id = `${levelPrefix}.${levelKey}.${eventValue}`;
				const eventLabel = eventValue;
				const stateName = {
					en: `latest notification of level '${levelLabel}' for event '${eventLabel}'`,
					de: `letzte Meldung der Stufe '${levelLabel}' für Ereignis '${eventLabel}'`,
					ru: `последнее уведомление уровня '${levelLabel}' для события '${eventLabel}'`,
					pt: `última notificação do nível '${levelLabel}' para o evento '${eventLabel}'`,
					nl: `laatste melding van niveau '${levelLabel}' voor event '${eventLabel}'`,
					fr: `dernière notification du niveau '${levelLabel}' pour l'événement '${eventLabel}'`,
					it: `ultima notifica del livello '${levelLabel}' per l'evento '${eventLabel}'`,
					es: `última notificación de nivel '${levelLabel}' para el evento '${eventLabel}'`,
					pl: `najnowsze powiadomienie poziomu '${levelLabel}' dla zdarzenia '${eventLabel}'`,
					uk: `останнє повідомлення про рівень '${levelLabel}' для події '${eventLabel}'`,
					'zh-cn': `latest notification of level '${levelLabel}' for event '${eventLabel}'`,
				};
				stateNames.set(id, stateName);
				promises.push(ensureState(id, stateName));
			}
		}
		return Promise.all(promises);
	};

	/**
	 * Write a JSON value into a state (best-effort).
	 *
	 * - Ensures the state exists first (lazy fallback when pre-creation didn't happen or failed).
	 * - Uses `serializeWithMaps` to preserve Map values in the notification payload.
	 * - Writes `ack: true` because these states are outputs of the adapter, not user inputs.
	 *
	 * @param {string} id Object id without adapter namespace prefix.
	 * @param {any} value Payload (object or array) to serialize and store.
	 */
	const writeState = (id, value) => {
		// Skip invalid ids to avoid accidental root writes.
		if (!id) {
			return;
		}
		// Serialize while preserving Map values from the message model.
		const serialized = serializeWithMaps(value, mapTypeMarker);
		// Ensure the target state exists before writing.
		const writePromise = ensureState(id, stateNames.get(id) || id).then(() => {
			// Prefer async API when available.
			if (typeof adapter.setStateAsync === 'function') {
				return adapter.setStateAsync(id, { val: serialized, ack: true });
			}
			// Fallback to callback-style API and wrap in a Promise.
			return new Promise((resolve, reject) => {
				adapter.setState(id, { val: serialized, ack: true }, err => {
					if (err) {
						reject(err);
					} else {
						resolve(undefined);
					}
				});
			});
		});

		writePromise.catch(err => {
			// Log but do not throw; notifications should not crash the adapter.
			adapter?.log?.warn?.(`MsgNotifyStatePlugin: failed to write state "${id}": ${err?.message || err}`);
		});
	};

	const resolveKindKey = kind => {
		// Accept only string kinds.
		if (typeof kind !== 'string') {
			return null;
		}
		// If the value is already a MsgConstants.kind value, map it to its key.
		if (kindValueToKey.has(kind)) {
			return kindValueToKey.get(kind);
		}
		// If the value is already a key, accept it.
		if (kindKeys.has(kind)) {
			return kind;
		}
		// Unknown kind -> no routing.
		return null;
	};

	const resolveLevelKey = level => {
		// Allow numeric levels and numeric strings like "10".
		const numericLevel = typeof level === 'string' && level.trim() !== '' ? Number(level) : level;
		// If the numeric value matches a MsgConstants.level entry, use its key.
		if (levelValueToKey.has(numericLevel)) {
			return levelValueToKey.get(numericLevel);
		}
		// If a string key was passed directly, accept it.
		if (typeof level === 'string' && levelKeys.has(level)) {
			return level;
		}
		// Unknown level -> no routing.
		return null;
	};

	const resolveEventValue = event => {
		if (typeof event !== 'string') {
			return null;
		}
		const trimmed = event.trim();
		if (!trimmed) {
			return null;
		}
		if (eventValues.has(trimmed)) {
			return trimmed;
		}
		if (eventKeyToValue.has(trimmed)) {
			return eventKeyToValue.get(trimmed);
		}
		return null;
	};

	const onNotifications = (event, notifications, _ctx = {}) => {
		// MsgNotify always calls with an array, but we still guard for safety.
		if (!Array.isArray(notifications) || notifications.length === 0) {
			return;
		}
		// Keep the "latest" state small: write a single item or the list as-is.
		const payload = notifications.length === 1 ? notifications[0] : notifications;
		const eventName = typeof event === 'string' && event.trim() ? event.trim() : undefined;
		const eventValue = eventName ? resolveEventValue(eventName) : null;
		if (!eventValue) {
			return;
		}
		writeState(`${latestPrefix}.${eventValue}`, payload);

		// Route each notification to its kind- and level-specific state.
		for (const notification of notifications) {
			// Only process valid notification objects.
			if (!notification || typeof notification !== 'object') {
				continue;
			}
			// Resolve kind and write to the kind-specific state.
			const kindKey = resolveKindKey(notification.kind);
			if (kindKey && eventValue) {
				writeState(`${kindPrefix}.${kindKey}.${eventValue}`, notification);
			}
			// Resolve level and write to the level-specific state.
			const levelKey = resolveLevelKey(notification.level);
			if (levelKey && eventValue) {
				writeState(`${levelPrefix}.${levelKey}.${eventValue}`, notification);
			}
		}
	};

	// Fire-and-forget initialization to create all states once at startup.
	ensureAllStates();

	// MsgNotify expects an object with onNotifications handler.
	return { onNotifications };
}

module.exports = { NotifyIoBrokerStates };
