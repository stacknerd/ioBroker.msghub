// serializeWithMaps keeps Map values intact when converting notifications to JSON.
const { serializeWithMaps } = require(`${__dirname}/../src/MsgUtils`);
// MsgConstants is the single source of truth for allowed kinds/levels.
const { MsgConstants } = require(`${__dirname}/../src/MsgConstants`);

/**
 * Create a MsgNotify plugin that writes notifications into ioBroker states.
 * The plugin writes:
 * - one "latest" state with the most recent notification(s),
 * - one state per kind (notifications.kind.<kindKey>),
 * - one state per level (notifications.level.<levelKey>).
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance.
 * @param {object} [options] Plugin options.
 * @param {string} [options.stateId] State id relative to the adapter namespace (latest notification).
 * @param {string} [options.kindPrefix] State id prefix for kind-specific notifications.
 * @param {string} [options.levelPrefix] State id prefix for level-specific notifications.
 * @param {boolean} [options.includeContext] Whether to embed the dispatch context.
 * @param {string} [options.mapTypeMarker] Map marker override for serialization.
 * @returns {{ onNotifications: (event: string, notifications: object[], ctx?: object) => void }} Plugin instance.
 */
function createNotifyIoBrokerState(
	adapter,
	{
		stateId = 'notifications.latest',
		kindPrefix = 'notifications.byKind',
		levelPrefix = 'notifications.byLevel',
		includeContext = false,
		mapTypeMarker,
	} = {},
) {
	if (!adapter) {
		throw new Error('MsgNotifyStatePlugin: adapter is required');
	}

	// Read allowed kinds/levels from MsgConstants to avoid hardcoded lists.
	const kindEntries = Object.entries(MsgConstants?.kind || {});
	const levelEntries = Object.entries(MsgConstants?.level || {});
	// Build lookup tables that accept either the key or the stored value.
	const kindValueToKey = new Map(kindEntries.map(([key, value]) => [value, key]));
	const levelValueToKey = new Map(levelEntries.map(([key, value]) => [value, key]));
	const kindKeys = new Set(kindEntries.map(([key]) => key));
	const levelKeys = new Set(levelEntries.map(([key]) => key));

	// Cache in-flight state creations to avoid parallel setObject calls.
	const initPromises = new Map();
	// Track per-state display names for lazy creation in writeState.
	const stateNames = new Map();
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
		if (stateId) {
			// Localized display name for the "latest" state.
			const stateName = {
				en: 'latest notification',
				de: 'letzte Meldung',
				ru: 'последнее уведомление',
				pt: 'última notificação',
				nl: 'laatste kennisgeving',
				fr: 'dernière notification',
				it: 'ultima notifica',
				es: 'última notificación',
				pl: 'najnowsze powiadomienie',
				uk: 'останнє повідомлення',
				'zh-cn': 'latest notification',
			};
			stateNames.set(stateId, stateName);
			promises.push(ensureState(stateId, stateName));
		}
		// Create one state per kind key from MsgConstants.kind.
		for (const [kindKey] of kindEntries) {
			const id = `${kindPrefix}.${kindKey}`;
			// Use the kind key itself as the user-facing label.
			const kindLabel = kindKey;
			// Localized display name for the kind-specific state.
			const stateName = {
				en: `latest notification of kind '${kindLabel}'`,
				de: `letzte Meldung der Art '${kindLabel}'`,
				ru: `последнее уведомление вида '${kindLabel}'`,
				pt: `última notificação do tipo '${kindLabel}'`,
				nl: `laatste mededeling van het type '${kindLabel}'`,
				fr: `dernière notification du type '${kindLabel}'`,
				it: `ultima notifica del tipo '${kindLabel}'`,
				es: `última notificación del tipo '${kindLabel}'`,
				pl: `najnowsze powiadomienie typu '${kindLabel}'`,
				uk: `останнє повідомлення виду '${kindLabel}'`,
				'zh-cn': `latest notification of kind '${kindLabel}'`,
			};
			stateNames.set(id, stateName);
			promises.push(ensureState(id, stateName));
		}
		// Create one state per level key from MsgConstants.level.
		for (const [levelKey] of levelEntries) {
			const id = `${levelPrefix}.${levelKey}`;
			// Use the level key itself as the user-facing label.
			const levelLabel = levelKey;
			// Localized display name for the level-specific state.
			const stateName = {
				en: `latest notification of level '${levelLabel}'`,
				de: `letzte Meldung der Stufe '${levelLabel}'`,
				ru: `последнее уведомление уровня '${levelLabel}'`,
				pt: `última notificação do nível '${levelLabel}'`,
				nl: `laatste melding van niveau '${levelLabel}'`,
				fr: `dernière notification du niveau '${levelLabel}'`,
				it: `ultima notifica del livello '${levelLabel}'`,
				es: `última notificación de nivel '${levelLabel}'`,
				pl: `najnowsze powiadomienie poziomu '${levelLabel}'`,
				uk: `останнє повідомлення про рівень '${levelLabel}'`,
				'zh-cn': `latest notification of level '${levelLabel}'`,
			};
			stateNames.set(id, stateName);
			promises.push(ensureState(id, stateName));
		}
		return Promise.all(promises);
	};

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

	const onNotifications = (event, notifications, ctx = {}) => {
		// MsgNotify always calls with an array, but we still guard for safety.
		if (!Array.isArray(notifications) || notifications.length === 0) {
			return;
		}
		// Keep the "latest" state small: write a single item or the list as-is.
		const payload = notifications.length === 1 ? notifications[0] : notifications;
		// Optionally attach context metadata to help downstream consumers.
		const eventName = typeof event === 'string' && event.trim() ? event.trim() : undefined;
		const value = includeContext
			? eventName
				? { ts: Date.now(), event: eventName, notifications: payload, ctx }
				: { ts: Date.now(), notifications: payload, ctx }
			: payload;
		writeState(stateId, value);

		// Route each notification to its kind- and level-specific state.
		for (const notification of notifications) {
			// Only process valid notification objects.
			if (!notification || typeof notification !== 'object') {
				continue;
			}
			// Resolve kind and write to the kind-specific state.
			const kindKey = resolveKindKey(notification.kind);
			if (kindKey) {
				const kindValue = includeContext
					? eventName
						? { ts: Date.now(), event: eventName, notification, ctx }
						: { ts: Date.now(), notification, ctx }
					: notification;
				writeState(`${kindPrefix}.${kindKey}`, kindValue);
			}
			// Resolve level and write to the level-specific state.
			const levelKey = resolveLevelKey(notification.level);
			if (levelKey) {
				const levelValue = includeContext
					? eventName
						? { ts: Date.now(), event: eventName, notification, ctx }
						: { ts: Date.now(), notification, ctx }
					: notification;
				writeState(`${levelPrefix}.${levelKey}`, levelValue);
			}
		}
	};

	// Fire-and-forget initialization to create all states once at startup.
	ensureAllStates();

	// MsgNotify expects an object with onNotifications handler.
	return { onNotifications };
}

module.exports = { createNotifyIoBrokerState };
