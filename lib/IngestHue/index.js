/**
 * IngestHue
 * =========
 *
 * Docs: ../../docs/plugins/IngestHue.md
 *
 * Producer plugin that monitors Hue adapter states (battery + reachability) and
 * creates/removes MsgHub messages.
 *
 * Core responsibilities
 * - Discover relevant Hue states (battery + reachability) and subscribe to them as foreign states.
 * - Maintain a `watched` snapshot that maps state ids to stable metadata used for message rendering.
 * - Produce messages via `MsgFactory.createMessage()` and mutate the store via `MsgStore`.
 * - Keep ioBroker object metadata up-to-date to mark monitored states as "managed" by this plugin.
 *
 * Integration contract (MsgIngest)
 * - This plugin is hosted by `MsgIngest` and receives:
 * - a `start(ctx)` call once on startup,
 * - `onStateChange(id, state)` callbacks for subscribed foreign states,
 * - and `stop()` on shutdown/unregister.
 * - The adapter must forward `onStateChange` events into `MsgIngest`, but this plugin owns its own
 * Hue subscriptions via `adapter.subscribeForeignStates(...)`.
 *
 * Message identity / refs
 * - Battery message ref: `hue:battery:<stateId>`
 * - Reachability message ref: `hue:reachable:<stateId>`
 * - These refs are stable across restarts; this allows `MsgStore` hydration to prevent duplicates.
 *
 * Battery semantics (hysteresis)
 * - Create/update when battery level `< batteryCreateBelow`.
 * - Remove when battery level `>= batteryRemoveAbove`.
 * - This hysteresis avoids flapping around a single threshold.
 *
 * Reachability semantics
 * - Create/update when `.reachable` becomes false.
 * - Remove when `.reachable` becomes true again.
 *
 * Discovery / subscriptions
 * - Discovery is snapshot-based:
 * - scan `hue.*` objects for relevant states,
 * - subscribe to new ids, unsubscribe removed ids,
 * - and update the `watched` map in-place.
 * - `onObjectChange` is intentionally a no-op today; discovery happens on startup only to avoid
 * expensive rescans on frequent object changes. If you need dynamic discovery, wire a debounce
 * and call `discover()` from `onObjectChange`.
 *
 * Localization
 * - Uses `adapter.config.locale` (fallback: "de") when picking labels from ioBroker-style i18n maps.
 * - Room names are taken from `enum.rooms.*` and resolved by "longest prefix" matching.
 *
 * Best-effort philosophy
 * - Producer plugins must never crash the adapter: all I/O operations are wrapped and failures are
 * logged and swallowed (similar to MsgStore side-effects philosophy).
 *
 * [monitorBattery=true] Enable battery monitoring.
 *
 * [monitorReachable=true] Enable reachability monitoring.
 *
 * [reachableAllowRoles] Allow-list of parent object roles for reachable states.
 * - `[]` means "allow all roles" (no filtering).
 * - When omitted or invalid, defaults to `["ZLLSwitch","ZLLPresence"]`.
 *
 * [batteryCreateBelow=7] Create/update when battery is below this threshold.
 *
 * [batteryRemoveAbove=30] Remove when battery is at/above this threshold.
 */

/* eslint-disable jsdoc/check-tag-names */

/**
 * Plugin options.
 *
 * @typedef {object} IngestHueOptions
 * @property {boolean} [monitorBattery=true] Enable battery monitoring.
 * @property {boolean} [monitorReachable=true] Enable reachability monitoring.
 * @property {string[]} [reachableAllowRoles] Allow-list of parent object roles for reachable states (`[]` means allow all).
 * @property {number} [batteryCreateBelow=7] Create/update when battery is below this threshold.
 * @property {number} [batteryRemoveAbove=30] Remove when battery is at/above this threshold.
 * @property {string} [pluginBaseObjectId] Full object id of the plugin base object (unused; informational only).
 */

/**
 * Ingest context provided by `MsgIngest`.
 *
 * @typedef {object} IngestHueCtx
 * @property {{ store: import('../../src/MsgStore').MsgStore, factory: import('../../src/MsgFactory').MsgFactory, constants: import('../../src/MsgConstants').MsgConstants }} api API bundle (store/factory/constants).
 */

/** @typedef {'battery'|'reachable'} IngestHueWatchType */

/**
 * In-memory snapshot entry for one watched state id.
 *
 * @typedef {object} IngestHueWatchedState
 * @property {IngestHueWatchType} type State type handled by this plugin.
 * @property {string} name Localized display name of the state/device.
 * @property {string} room Resolved room name (may be empty).
 * @property {string} parentRole Role of the parent object (used for filtering/labels).
 * @property {string} model Hue model id (battery only; may be empty).
 */

/**
 * Plugin instance exported to the host (MsgIngest).
 *
 * @typedef {object} IngestHuePluginInstance
 * @property {(ctx: IngestHueCtx) => void} start Start the plugin (async work is done fire-and-forget).
 * @property {() => void} stop Stop the plugin and unsubscribe from foreign states.
 * @property {(id: string, state: ioBroker.State|null|undefined) => void} onStateChange Handle subscribed state updates.
 * @property {(id: string, obj: ioBroker.Object|null|undefined) => void} onObjectChange Handle object changes (no-op today).
 */

/* eslint-enable jsdoc/check-tag-names */

/**
 * Create the Hue ingest plugin.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance.
 * @param {IngestHueOptions} [options] Plugin options.
 * @returns {IngestHuePluginInstance} Plugin instance.
 */
function IngestHue(adapter, options = {}) {
	if (!adapter) {
		throw new Error('IngestHue: adapter is required');
	}

	const { pickI18n, formatI18n, isObject } = require(`${__dirname}/../../src/MsgUtils`);
	const { HUE_MODELS } = require('./models');

	// ---------------------------------------------------------------------------
	// Input normalization helpers
	// ---------------------------------------------------------------------------
	// Plugin options may come from ioBroker objects (`native`) and are therefore untyped.
	// These helpers provide small "accept a few shapes, return a strict value" conversions.

	/**
	 * Parse a value into a finite number.
	 *
	 * @param {unknown} v Candidate value.
	 * @returns {number|null} Number when parseable, otherwise `null`.
	 */
	const toNum = v => {
		if (typeof v === 'number' && Number.isFinite(v)) {
			return v;
		}
		if (typeof v === 'string' && v.trim() !== '') {
			const n = Number(v);
			return Number.isFinite(n) ? n : null;
		}
		return null;
	};

	/**
	 * Parse a value into a boolean.
	 *
	 * Accepted inputs:
	 * - boolean: returned as-is
	 * - number: 0 => false, otherwise true
	 * - string: "true|1|on" => true, "false|0|off" => false (case-insensitive)
	 *
	 * @param {unknown} v Candidate value.
	 * @returns {boolean|null} Boolean when parseable, otherwise `null`.
	 */
	const toBool = v => {
		if (typeof v === 'boolean') {
			return v;
		}
		if (typeof v === 'number') {
			return v !== 0;
		}
		if (typeof v === 'string') {
			const s = v.trim().toLowerCase();
			if (s === 'true' || s === '1' || s === 'on') {
				return true;
			}
			if (s === 'false' || s === '0' || s === 'off') {
				return false;
			}
		}
		return null;
	};

	/**
	 * Split a comma separated list and trim parts.
	 *
	 * @param {unknown} s CSV string.
	 * @returns {string[]} Clean string list.
	 */
	const splitCsv = s =>
		typeof s === 'string'
			? s
					.split(',')
					.map(p => p.trim())
					.filter(Boolean)
			: [];

	/**
	 * Normalize a string list from either an array of strings or a CSV string.
	 *
	 * @param {unknown} v Candidate input.
	 * @returns {string[]|null} Normalized string array, or `null` when not representable.
	 */
	const normalizeStringArray = v => {
		if (Array.isArray(v)) {
			return v
				.filter(x => typeof x === 'string')
				.map(x => x.trim())
				.filter(Boolean);
		}
		if (typeof v === 'string') {
			return splitCsv(v);
		}
		return null;
	};

	// ---------------------------------------------------------------------------
	// Configuration
	// ---------------------------------------------------------------------------
	// Normalize options into a single config object used throughout the plugin.
	const reachableAllowRolesOpt = normalizeStringArray(options.reachableAllowRoles);
	const cfg = {
		monitorBattery: options.monitorBattery !== false,
		monitorReachable: options.monitorReachable !== false,
		// Empty list => allow all roles (no filtering).
		reachableAllowRoles: reachableAllowRolesOpt ? reachableAllowRolesOpt : ['ZLLSwitch', 'ZLLPresence'],
		batteryCreateBelow: Number.isFinite(Number(options.batteryCreateBelow))
			? Number(options.batteryCreateBelow)
			: 7,
		batteryRemoveAbove: Number.isFinite(Number(options.batteryRemoveAbove))
			? Number(options.batteryRemoveAbove)
			: 30,
	};

	// Locale can be updated during discovery; it is used by the i18n helper `t(...)`.
	let localeRef = adapter?.config?.locale || 'de';
	const t = (i18nValue, params = {}) => formatI18n(pickI18n(i18nValue, localeRef), params);

	// Small, plugin-scoped i18n dictionary. Keep it here so the plugin is self-contained.
	const I18N = Object.freeze({
		unknownDeviceLabel: Object.freeze({ en: 'Hue device', de: 'Hue Gerät' }),
		meta: Object.freeze({
			battery: Object.freeze({
				en: 'This state is monitored by the IngestHue plugin.\nA message is created when the battery level drops below {createBelow}% and removed when it rises to {removeAbove}% or higher.',
				de: 'Dieser State wird vom IngestHue-Plugin überwacht.\nEine Meldung wird erstellt, wenn der Batteriestand unter {createBelow}% fällt, und entfernt, sobald er wieder {removeAbove}% oder höher ist.',
			}),
			reachable: Object.freeze({
				en: 'This state is monitored by the IngestHue plugin.\nA message is created when the device becomes unreachable and removed once it is reachable again.',
				de: 'Dieser State wird vom IngestHue-Plugin überwacht.\nEine Meldung wird erstellt, sobald das Gerät nicht erreichbar ist, und entfernt, sobald es wieder erreichbar ist.',
			}),
		}),
		msg: Object.freeze({
			batteryTextWithBattery: Object.freeze({
				en: 'Battery level is {val}%.\nReplace batteries ({battery}).',
				de: 'Batteriestand ist {val}%.\nBitte Batterien ({battery}) ersetzen.',
			}),
			batteryTextNoBattery: Object.freeze({
				en: 'Battery level is {val}%.\nReplace the batteries.',
				de: 'Batteriestand ist {val}%.\nBitte Batterien ersetzen.',
			}),
			batteryTask: Object.freeze({
				en: 'Replace batteries in "{name}"',
				de: 'Batterien in "{name}" ersetzen',
			}),
			batteryReason: Object.freeze({
				en: 'Battery level is {val}%',
				de: 'Batteriestand ist {val}%',
			}),
			reachableText: Object.freeze({ en: 'Device is not reachable.', de: 'Gerät ist nicht erreichbar.' }),
			reachableReason: Object.freeze({ en: 'Device is not reachable', de: 'Gerät ist nicht erreichbar' }),
		}),
		reachableRoleLabels: Object.freeze({
			ZLLPresence: Object.freeze({ en: 'Motion sensor', de: 'Bewegungsmelder' }),
			ZLLSwitch: Object.freeze({ en: 'Light switch', de: 'Lichtschalter' }),
		}),
	});

	let ctxRef = null;
	let running = false;

	const watched = new Map();
	const subscribed = new Set();
	let roomsByMember = new Map();

	// ---------------------------------------------------------------------------
	// ioBroker API wrappers
	// ---------------------------------------------------------------------------
	// The adapter-core API exposes both callback and Async variants. These wrappers normalize both into Promises.
	const getForeignObjectsAsync = pattern =>
		typeof adapter.getForeignObjectsAsync === 'function'
			? adapter.getForeignObjectsAsync(pattern)
			: new Promise((resolve, reject) => {
					adapter.getForeignObjects(pattern, (err, objs) => (err ? reject(err) : resolve(objs)));
				});

	const getForeignObjectAsync = id =>
		typeof adapter.getForeignObjectAsync === 'function'
			? adapter.getForeignObjectAsync(id)
			: new Promise((resolve, reject) => {
					adapter.getForeignObject(id, (err, obj) => (err ? reject(err) : resolve(obj)));
				});

	const getForeignStateAsync = id =>
		typeof adapter.getForeignStateAsync === 'function'
			? adapter.getForeignStateAsync(id)
			: new Promise((resolve, reject) => {
					adapter.getForeignState(id, (err, state) => (err ? reject(err) : resolve(state)));
				});

	/**
	 * Extend a foreign object using the best available adapter API.
	 *
	 * Note: `extendForeignObject` performs a deep merge for `common/native`.
	 * We keep patches minimal to avoid accidentally overwriting unrelated data.
	 *
	 * @param {string} id Foreign object id.
	 * @param {object} patch Partial object payload to merge.
	 * @returns {Promise<void>}
	 */
	const safeExtendForeignObjectAsync = async (id, patch) => {
		if (typeof adapter.extendForeignObjectAsync === 'function') {
			return adapter.extendForeignObjectAsync(id, patch);
		}
		return new Promise((resolve, reject) => {
			adapter.extendForeignObject(id, patch, err => (err ? reject(err) : resolve(undefined)));
		});
	};

	/**
	 * Mark a Hue state as managed by this plugin by writing a small metadata block.
	 *
	 * Why this exists:
	 * - Users often look at a `.battery`/`.reachable` state and wonder why it exists / what monitors it.
	 * - Tagging states helps discoverability and makes cleanup/ownership explicit.
	 *
	 * Where the metadata is stored:
	 * - `obj.native.meta` (works for most adapters)
	 * - `obj.common.custom[adapter.namespace].meta` (visible in custom settings UIs)
	 *
	 * The operation is best-effort and must not block message processing.
	 *
	 * @param {string} id State object id.
	 * @param {IngestHueWatchType} type Logical state type ("battery"|"reachable").
	 * @returns {Promise<void>}
	 */
	const ensureManagedMeta = async (id, type) => {
		const obj = await getForeignObjectAsync(id);
		if (!obj) {
			return;
		}

		const nowIso = new Date().toISOString();
		const managedBy = 'IngestHue Plugin';
		const desiredText =
			type === 'battery'
				? t(I18N.meta.battery, { createBelow: cfg.batteryCreateBelow, removeAbove: cfg.batteryRemoveAbove })
				: t(I18N.meta.reachable);

		const existingNativeMeta = isObject(obj.native) && isObject(obj.native.meta) ? obj.native.meta : {};
		const nativeNeedsUpdate =
			existingNativeMeta.managedBy !== managedBy ||
			typeof existingNativeMeta.managedText !== 'string' ||
			existingNativeMeta.managedText !== desiredText ||
			typeof existingNativeMeta.managedSince !== 'string';

		const customKey = adapter.namespace;
		const existingCustom =
			isObject(obj.common) && isObject(obj.common.custom) ? obj.common.custom[customKey] : null;
		const existingCustomMeta =
			isObject(existingCustom) && (isObject(existingCustom.meta) || isObject(existingCustom['meta']))
				? existingCustom.meta || existingCustom['meta']
				: null;
		const customNeedsUpdate =
			existingCustom &&
			(!existingCustomMeta ||
				existingCustomMeta.managedBy !== managedBy ||
				existingCustomMeta.managedText !== desiredText ||
				typeof existingCustomMeta.managedSince !== 'string');

		if (!nativeNeedsUpdate && !customNeedsUpdate) {
			return;
		}

		const patch = {};
		if (nativeNeedsUpdate) {
			patch.native = {
				meta: {
					...existingNativeMeta,
					managedBy,
					managedText: desiredText,
					managedSince:
						typeof existingNativeMeta.managedSince === 'string' ? existingNativeMeta.managedSince : nowIso,
				},
			};
		}
		if (customNeedsUpdate) {
			patch.common = {
				custom: {
					[customKey]: {
						meta: {
							...(isObject(existingCustomMeta) ? existingCustomMeta : {}),
							managedBy,
							managedText: desiredText,
							managedSince:
								isObject(existingCustomMeta) && typeof existingCustomMeta.managedSince === 'string'
									? existingCustomMeta.managedSince
									: nowIso,
						},
					},
				},
			};
		}

		try {
			await safeExtendForeignObjectAsync(id, patch);
		} catch (e) {
			adapter?.log?.warn?.(`IngestHue: failed to set managed meta on '${id}': ${e?.message || e}`);
		}
	};

	/**
	 * Resolve the best room label for a state id using the "longest prefix match" strategy.
	 *
	 * Reasoning:
	 * - Many Hue installations use a hierarchy like `hue.0.<bridge>.<device>.<state>`.
	 * - Enums are often attached to device-level or channel-level objects, not directly to the state.
	 * - By checking `id`, then its parent, then its grand-parent, we usually find a usable room.
	 *
	 * @param {string} id State id.
	 * @returns {string} Resolved room name or empty string.
	 */
	const resolveRoomName = id => {
		const candidates = [];
		let cur = id;
		while (cur && cur.includes('.')) {
			candidates.push(cur);
			cur = cur.slice(0, cur.lastIndexOf('.'));
		}
		for (const cand of candidates) {
			if (roomsByMember.has(cand)) {
				return roomsByMember.get(cand);
			}
		}
		return '';
	};

	/**
	 * Load room enums (`enum.rooms.*`) and build a fast lookup map from member id -> localized room name.
	 *
	 * @param {string} locale Locale key (e.g. "de", "en").
	 * @returns {Promise<void>}
	 */
	const buildRoomsIndex = async locale => {
		localeRef = locale || localeRef;
		const next = new Map();
		let enums = {};
		try {
			enums = (await getForeignObjectsAsync('enum.rooms.*')) || {};
		} catch (e) {
			adapter?.log?.debug?.(`IngestHue: failed to load room enums: ${e?.message || e}`);
		}

		for (const obj of Object.values(enums)) {
			if (!obj || obj.type !== 'enum') {
				continue;
			}
			const members = obj?.common?.members;
			if (!Array.isArray(members) || members.length === 0) {
				continue;
			}
			const roomName = pickI18n(obj.common?.name, localeRef) || obj._id;
			for (const member of members) {
				if (typeof member !== 'string' || !member) {
					continue;
				}
				if (!next.has(member)) {
					next.set(member, roomName);
				}
			}
		}
		roomsByMember = next;
	};

	/**
	 * Discover relevant Hue state ids, update subscriptions, and refresh the `watched` metadata snapshot.
	 *
	 * Discovery rules:
	 * - Battery states end with `.battery` (creates "task" messages with model-specific consumables/tools).
	 * - Reachability states end with `.reachable` (creates "status" messages).
	 * - Reachability is optionally filtered by the parent object role to avoid noisy/irrelevant channels.
	 *
	 * Side-effects:
	 * - Calls `adapter.subscribeForeignStates(id)` for newly discovered state ids.
	 * - Calls `adapter.unsubscribeForeignStates(id)` for ids that no longer match the rules.
	 * - Best-effort updates "managed" metadata on all watched ids.
	 *
	 * @returns {Promise<void>}
	 */
	const discover = async () => {
		const locale = adapter?.config?.locale || 'de';
		localeRef = locale || localeRef;
		await buildRoomsIndex(localeRef);

		let objects = {};
		try {
			objects = (await getForeignObjectsAsync('hue.*')) || {};
		} catch (e) {
			adapter?.log?.warn?.(`IngestHue: failed to read hue objects: ${e?.message || e}`);
			return;
		}

		const nextWatched = new Map();
		for (const [id, obj] of Object.entries(objects)) {
			if (!obj || obj.type !== 'state') {
				continue;
			}
			const isBattery = cfg.monitorBattery && id.endsWith('.battery');
			const isReachable = cfg.monitorReachable && id.endsWith('.reachable');
			if (!isBattery && !isReachable) {
				continue;
			}

			const parentId = id.slice(0, id.lastIndexOf('.'));
			let parentRole = '';
			try {
				const parentObj = objects[parentId] || (await getForeignObjectAsync(parentId));
				parentRole = parentObj?.common?.role || '';
			} catch {
				// ignore
			}

			if (isBattery) {
				if (parentRole === 'ZLLLightLevel' || parentRole === 'ZLLTemperature') {
					continue; // avoid multiple messages for presence sensors with integrated lightlevel and temperature sensors
				}
			}

			if (isReachable) {
				if (cfg.reachableAllowRoles.length > 0 && !cfg.reachableAllowRoles.includes(parentRole)) {
					continue;
				}
			}

			const name = pickI18n(obj.common?.name, localeRef) || id;
			const room = resolveRoomName(id);

			let model = '';
			if (isBattery) {
				const baseId = id.slice(0, -'.battery'.length);
				try {
					const baseObj = objects[baseId] || (await getForeignObjectAsync(baseId));
					model = baseObj?.native?.modelid || '';
				} catch {
					// ignore
				}
			}

			nextWatched.set(id, { type: isBattery ? 'battery' : 'reachable', name, room, parentRole, model });
		}

		for (const id of subscribed) {
			if (!nextWatched.has(id)) {
				try {
					adapter.unsubscribeForeignStates(id);
				} catch {
					// ignore (best-effort)
				}
				subscribed.delete(id);
				watched.delete(id);
			}
		}

		for (const [id, info] of nextWatched.entries()) {
			if (!subscribed.has(id)) {
				try {
					adapter.subscribeForeignStates(id);
					subscribed.add(id);
				} catch (e) {
					adapter?.log?.warn?.(`IngestHue: subscribeForeignStates('${id}') failed: ${e?.message || e}`);
					continue;
				}
			}
			watched.set(id, info);
		}

		for (const [id, info] of watched.entries()) {
			await ensureManagedMeta(id, info.type);
		}
	};

	/**
	 * Build a stable message ref for a Hue state id.
	 *
	 * @param {IngestHueWatchType} type State type.
	 * @param {string} id State id.
	 * @returns {string} MsgHub ref.
	 */
	const makeRef = (type, id) => `hue:${type}:${id}`;

	/**
	 * Process a battery update and apply create/update/remove logic.
	 *
	 * Notes:
	 * - Battery is expected in percent.
	 * - The message uses a "task" kind and "warning" level.
	 * - Model-specific labels/consumables/tools come from `./models` (`HUE_MODELS`).
	 *
	 * @param {string} id State id.
	 * @param {unknown} val State value.
	 * @returns {void}
	 */
	const emitBattery = (id, val) => {
		if (!ctxRef?.api?.factory || !ctxRef?.api?.store || !ctxRef?.api?.constants) {
			return;
		}
		const info = watched.get(id);
		if (!info) {
			return;
		}
		const num = toNum(val);
		if (num == null) {
			return;
		}

		const ref = makeRef('battery', id);
		if (num < cfg.batteryCreateBelow) {
			const modelInfo = HUE_MODELS[info.model] || { label: I18N.unknownDeviceLabel, battery: '', tools: '' };
			const deviceLabel =
				pickI18n(modelInfo.label || I18N.unknownDeviceLabel, localeRef) ||
				pickI18n(I18N.unknownDeviceLabel, localeRef);
			const title = `${deviceLabel}: ${info.name}`;

			const batteryText = typeof modelInfo.battery === 'string' ? modelInfo.battery.trim() : '';
			const text = batteryText
				? t(I18N.msg.batteryTextWithBattery, { val: num, battery: batteryText })
				: t(I18N.msg.batteryTextNoBattery, { val: num });

			const toolText = pickI18n(modelInfo.tools || '', localeRef);
			const tools = splitCsv(toolText);

			const created = ctxRef.api.factory.createMessage({
				ref,
				title,
				text,
				level: ctxRef.api.constants.level.warning,
				kind: ctxRef.api.constants.kind.task,
				origin: { type: ctxRef.api.constants.origin.type.automation, system: 'IngestHue', id },
				details: {
					location: info.room || undefined,
					task: t(I18N.msg.batteryTask, { name: info.name }),
					reason: t(I18N.msg.batteryReason, { val: num }),
					tools: tools.length > 0 ? tools : undefined,
					consumables: batteryText ? [batteryText] : [],
				},
			});
			if (created) {
				ctxRef.api.store.addOrUpdateMessage(created);
			}
			return;
		}

		if (num >= cfg.batteryRemoveAbove) {
			ctxRef.api.store.removeMessage(ref);
		}
	};

	/**
	 * Process a reachability update and apply create/update/remove logic.
	 *
	 * Notes:
	 * - The message uses a "status" kind and "error" level.
	 *
	 * @param {string} id State id.
	 * @param {unknown} val State value.
	 * @returns {void}
	 */
	const emitReachable = (id, val) => {
		if (!ctxRef?.api?.factory || !ctxRef?.api?.store || !ctxRef?.api?.constants) {
			return;
		}
		const info = watched.get(id);
		if (!info) {
			return;
		}
		const reachable = toBool(val);
		if (reachable == null) {
			return;
		}

		const ref = makeRef('reachable', id);
		if (reachable === false) {
			const label =
				pickI18n(I18N.reachableRoleLabels[info.parentRole], localeRef) ||
				pickI18n(I18N.unknownDeviceLabel, localeRef);
			const title = `${label}: ${info.name}`;
			const text = t(I18N.msg.reachableText);
			const created = ctxRef.api.factory.createMessage({
				ref,
				title,
				text,
				level: ctxRef.api.constants.level.error,
				kind: ctxRef.api.constants.kind.status,
				origin: { type: ctxRef.api.constants.origin.type.automation, system: 'IngestHue', id },
				details: {
					location: info.room || undefined,
					reason: t(I18N.msg.reachableReason),
				},
			});
			if (created) {
				ctxRef.api.store.addOrUpdateMessage(created);
			}
			return;
		}

		ctxRef.api.store.removeMessage(ref);
	};

	/**
	 * Evaluate the currently watched states once (synchronous snapshot) and emit messages accordingly.
	 *
	 * This is called on startup after `discover()` so the system reflects the current Hue state immediately
	 * and does not have to wait for the next state change event.
	 *
	 * @returns {Promise<void>}
	 */
	const evaluateNow = async () => {
		for (const [id, info] of watched.entries()) {
			try {
				const st = await getForeignStateAsync(id);
				if (!st) {
					continue;
				}
				if (info.type === 'battery') {
					emitBattery(id, st.val);
				} else {
					emitReachable(id, st.val);
				}
			} catch {
				// ignore (best-effort)
			}
		}
	};

	/**
	 * Start the plugin.
	 *
	 * Contract:
	 * - Must be idempotent (safe to call multiple times).
	 * - Must throw when required APIs are missing (wiring/config error).
	 * - Must not block adapter startup: async work is scheduled and errors are logged best-effort.
	 *
	 * @param {IngestHueCtx} ctx Ingest context with store/factory/constants.
	 * @returns {void}
	 */
	const start = ctx => {
		if (running) {
			return;
		}
		if (!ctx?.api?.store || !ctx?.api?.factory || !ctx?.api?.constants) {
			throw new Error('IngestHue.start: ctx.api.store/factory/constants are required');
		}
		ctxRef = ctx;
		running = true;

		(async () => {
			try {
				await discover();
				await evaluateNow();
			} catch (e) {
				adapter?.log?.warn?.(`IngestHue: startup failed: ${e?.message || e}`);
			}
		})().catch(() => {});
	};

	/**
	 * Stop the plugin and clean up subscriptions.
	 *
	 * Notes:
	 * - This does not remove produced messages; it only stops producing/updating them.
	 * - Messages will remain in the store until something else removes them (battery recovery / reachable / user action / expiry).
	 *
	 * @returns {void}
	 */
	const stop = () => {
		running = false;
		ctxRef = null;

		for (const id of subscribed) {
			try {
				adapter.unsubscribeForeignStates(id);
			} catch {
				// ignore
			}
		}
		subscribed.clear();
		watched.clear();
	};

	/**
	 * Handle state changes forwarded by the adapter via MsgIngest.
	 *
	 * This handler must be cheap: it only processes ids that are currently in the `watched` map.
	 * Unknown ids are ignored to avoid accidental cross-adapter pollution.
	 *
	 * @param {string} id State id (full, foreign).
	 * @param {ioBroker.State|null|undefined} state State object.
	 * @returns {void}
	 */
	const onStateChange = (id, state) => {
		if (!running || !state) {
			return;
		}
		const info = watched.get(id);
		if (!info) {
			return;
		}
		if (info.type === 'battery') {
			emitBattery(id, state.val);
		} else {
			emitReachable(id, state.val);
		}
	};

	/**
	 * Handle object changes.
	 *
	 * Currently intentionally unused (see module header, "Discovery / subscriptions").
	 *
	 * @returns {void}
	 */
	const onObjectChange = () => {};

	return { start, stop, onStateChange, onObjectChange };
}

module.exports = { IngestHue };
