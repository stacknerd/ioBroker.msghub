// serializeWithMaps keeps Map values intact when converting notifications to JSON.
const { serializeWithMaps } = require(`${__dirname}/../src/MsgUtils`);
// MsgConstants is the single source of truth for allowed kinds/levels.
const { MsgConstants } = require(`${__dirname}/../src/MsgConstants`);

/**
 * Create a MsgNotify plugin that writes notifications into ioBroker states.
 *
 * Docs: ../docs/plugins/NotifyIoBrokerState.md
 *
 * The plugin writes:
 * - one "latest" state per event with the most recent notification(s),
 * - one state per kind+event (notifications.byKind.<kindKey>.<event>),
 * - one state per level+event (notifications.byLevel.<levelKey>.<event>).
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance.
 * @param {object} [options] Plugin options.
 * @param {string} [options.stateId] State id prefix relative to the adapter namespace (latest per event).
 * @param {string} [options.kindPrefix] State id prefix for kind+event notifications.
 * @param {string} [options.levelPrefix] State id prefix for level+event notifications.
 * @param {boolean} [options.includeContext] Whether to embed the dispatch context.
 * @param {string} [options.mapTypeMarker] Map marker override for serialization.
 * @returns {{ onNotifications: (event: string, notifications: object[], ctx?: { api?: object, meta?: object }|object) => void }} Plugin instance.
 */
function NotifyIoBrokerState(
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

	// Read allowed kinds/levels/events from MsgConstants to avoid hardcoded lists.
	const kindEntries = Object.entries(MsgConstants?.kind || {});
	const levelEntries = Object.entries(MsgConstants?.level || {});
	const eventEntries = Object.entries(MsgConstants?.notfication?.events || {});
	// Build lookup tables that accept either the key or the stored value.
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
			const eventValueList = eventEntries.map(([, value]) => value);
			for (const eventValue of eventValueList) {
				const id = `${stateId}.${eventValue}`;
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
		}
		// Create one state per kind+event from MsgConstants.kind + MsgConstants.notfication.events.
		const eventValueList = eventEntries.map(([, value]) => value);
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

	const onNotifications = (event, notifications, ctx = {}) => {
		// MsgNotify always calls with an array, but we still guard for safety.
		if (!Array.isArray(notifications) || notifications.length === 0) {
			return;
		}
		// Keep the "latest" state small: write a single item or the list as-is.
		const payload = notifications.length === 1 ? notifications[0] : notifications;
		// Optionally attach context metadata to help downstream consumers.
		const ctxMeta = ctx && typeof ctx === 'object' && 'meta' in ctx ? ctx.meta : ctx;
		const eventName = typeof event === 'string' && event.trim() ? event.trim() : undefined;
		const eventValue = eventName ? resolveEventValue(eventName) : null;
		const value = includeContext
			? eventName
				? { ts: Date.now(), event: eventName, notifications: payload, ctx: ctxMeta }
				: { ts: Date.now(), notifications: payload, ctx: ctxMeta }
			: payload;
		if (!eventValue) {
			return;
		}
		writeState(`${stateId}.${eventValue}`, value);

		// Route each notification to its kind- and level-specific state.
		for (const notification of notifications) {
			// Only process valid notification objects.
			if (!notification || typeof notification !== 'object') {
				continue;
			}
			// Resolve kind and write to the kind-specific state.
			const kindKey = resolveKindKey(notification.kind);
			if (kindKey && eventValue) {
				const kindValue = includeContext
					? eventName
						? { ts: Date.now(), event: eventName, notification, ctx }
						: { ts: Date.now(), notification, ctx }
					: notification;
				writeState(`${kindPrefix}.${kindKey}.${eventValue}`, kindValue);
			}
			// Resolve level and write to the level-specific state.
			const levelKey = resolveLevelKey(notification.level);
			if (levelKey && eventValue) {
				const levelValue = includeContext
					? eventName
						? { ts: Date.now(), event: eventName, notification, ctx }
						: { ts: Date.now(), notification, ctx }
					: notification;
				writeState(`${levelPrefix}.${levelKey}.${eventValue}`, levelValue);
			}
		}
	};

	// Fire-and-forget initialization to create all states once at startup.
	ensureAllStates();

	// MsgNotify expects an object with onNotifications handler.
	return { onNotifications };
}

module.exports = { NotifyIoBrokerState };
