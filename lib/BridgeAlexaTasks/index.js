/**
 * BridgeAlexaTasks
 * ================
 *
 * Bidirectional sync between an Alexa TODO list (alexa2) and MsgHub task messages.
 *
 * Semantics:
 * - Inbound (Alexa -> MsgHub): import new Alexa items as tasks.
 *   - If import succeeds: delete the Alexa item.
 *   - If import fails: mark the Alexa item as completed (so it is not re-imported).
 * - Outbound (MsgHub -> Alexa): mirror a filtered set of MsgHub messages into the Alexa TODO list.
 *   - Source of truth: Message Hub (outbound is enforced; no reverse sync for projected items).
 */

'use strict';

const { manifest } = require('./manifest');

/**
 * Create a BridgeAlexaTasks plugin instance.
 *
 * @param {object} [options] Optional initial options (may be overridden by manifest-bound options at runtime).
 * @returns {{ start: Function, stop: Function, onStateChange: Function, onNotifications: Function }} Plugin handlers.
 */
function BridgeAlexaTasks(options = {}) {
	let running = false;
	let ctxIngestRef = null;
	let ctxNotifyRef = null;

	let cfg = Object.freeze({
		jsonStateId: 'alexa2.0.Lists.TODO.json',
		audienceTagsCsv: '',
		audienceChannelsIncludeCsv: '',
		audienceChannelsExcludeCsv: '',
		fullSyncIntervalMs: 60 * 60 * 1000,
		aiEnhancedTitle: false,
		outEnabled: true,
		outKindsCsv: 'task',
		outLevelMin: 10,
		outLevelMax: 30,
		outLifecycleStatesCsv: 'open',
		outAudienceTagsAnyCsv: '',
	});

	let mapping = {
		version: 1,
		jsonStateId: '',
		out: {
			messageRefToExternal: {},
			externalToMessageRef: {},
			pendingCreates: {},
		},
	};

	let createCmdId = null;
	let createCmdWarned = false;

	const normalizeMappingOut = () => {
		if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
			mapping = {
				version: 1,
				jsonStateId: '',
				out: { messageRefToExternal: {}, externalToMessageRef: {}, pendingCreates: {} },
			};
		}
		if (!mapping.out || typeof mapping.out !== 'object' || Array.isArray(mapping.out)) {
			mapping.out = { messageRefToExternal: {}, externalToMessageRef: {}, pendingCreates: {} };
		}
		if (!mapping.out.messageRefToExternal || typeof mapping.out.messageRefToExternal !== 'object') {
			mapping.out.messageRefToExternal = {};
		}
		if (!mapping.out.externalToMessageRef || typeof mapping.out.externalToMessageRef !== 'object') {
			mapping.out.externalToMessageRef = {};
		}
		if (!mapping.out.pendingCreates || typeof mapping.out.pendingCreates !== 'object') {
			mapping.out.pendingCreates = {};
		}

		// Keep both maps consistent even if older/corrupted state missed one side.
		for (const [ref, extId] of Object.entries(mapping.out.messageRefToExternal)) {
			if (!ref || typeof extId !== 'string' || !extId.trim()) {
				continue;
			}
			if (!mapping.out.externalToMessageRef[extId]) {
				mapping.out.externalToMessageRef[extId] = ref;
			}
		}
	};

	const applyResolvedOptions = ctx => {
		const o = ctx?.meta?.options;
		cfg = Object.freeze({
			jsonStateId: o.resolveString('jsonStateId', options.jsonStateId),
			audienceTagsCsv: o.resolveString('audienceTagsCsv', options.audienceTagsCsv),
			audienceChannelsIncludeCsv: o.resolveString(
				'audienceChannelsIncludeCsv',
				options.audienceChannelsIncludeCsv,
			),
			audienceChannelsExcludeCsv: o.resolveString(
				'audienceChannelsExcludeCsv',
				options.audienceChannelsExcludeCsv,
			),
			fullSyncIntervalMs: o.resolveInt('fullSyncIntervalMs', options.fullSyncIntervalMs),
			aiEnhancedTitle: o.resolveBool('aiEnhancedTitle', options.aiEnhancedTitle),
			outEnabled: o.resolveBool('outEnabled', options.outEnabled),
			outKindsCsv: o.resolveString('outKindsCsv', options.outKindsCsv),
			outLevelMin: o.resolveInt('outLevelMin', options.outLevelMin),
			outLevelMax: o.resolveInt('outLevelMax', options.outLevelMax),
			outLifecycleStatesCsv: o.resolveString('outLifecycleStatesCsv', options.outLifecycleStatesCsv),
			outAudienceTagsAnyCsv: o.resolveString('outAudienceTagsAnyCsv', options.outAudienceTagsAnyCsv),
		});
	};

	const toCsvList = csv =>
		String(csv || '')
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);

	const mappingOwnId = ctx => `${ctx.meta.plugin.baseOwnId}.mapping`;
	const mappingFullId = ctx => `${ctx.meta.plugin.baseFullId}.mapping`;

	const ensureMappingState = async ctx => {
		await ctx.api.iobroker.objects.setObjectNotExists(mappingOwnId(ctx), {
			type: 'state',
			common: {
				name: 'BridgeAlexaTasks mapping',
				type: 'string',
				role: 'json',
				read: true,
				write: false,
				def: '{}',
			},
			native: {},
		});
		await ctx.api.iobroker.objects.extendForeignObject(mappingFullId(ctx), {
			common: { read: true, write: false },
		});
	};

	const loadMapping = async ctx => {
		const st = await ctx.api.iobroker.states.getForeignState(mappingFullId(ctx));
		if (!st?.val) {
			return;
		}
		let parsed;
		try {
			parsed = JSON.parse(String(st.val));
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return;
		}
		const out = parsed.out && typeof parsed.out === 'object' && !Array.isArray(parsed.out) ? parsed.out : {};
		mapping = {
			version: 1,
			jsonStateId: typeof parsed.jsonStateId === 'string' ? parsed.jsonStateId : '',
			out: {
				messageRefToExternal:
					out.messageRefToExternal && typeof out.messageRefToExternal === 'object'
						? out.messageRefToExternal
						: {},
				externalToMessageRef:
					out.externalToMessageRef && typeof out.externalToMessageRef === 'object'
						? out.externalToMessageRef
						: {},
				pendingCreates: out.pendingCreates && typeof out.pendingCreates === 'object' ? out.pendingCreates : {},
			},
		};
		normalizeMappingOut();
	};

	const saveMapping = async ctx => {
		await ctx.api.iobroker.states.setState(mappingOwnId(ctx), { val: JSON.stringify(mapping), ack: true });
	};

	const deriveAlexaBaseId = jsonStateId => {
		const id = String(jsonStateId || '').trim();
		return id.endsWith('.json') ? id.slice(0, -'.json'.length) : id;
	};

	const ids = () => {
		const base = deriveAlexaBaseId(cfg.jsonStateId);
		return {
			json: cfg.jsonStateId,
			create: createCmdId,
			itemValue: extId => `${base}.items.${extId}.value`,
			itemCompleted: extId => `${base}.items.${extId}.completed`,
			itemDelete: extId => `${base}.items.${extId}.#delete`,
		};
	};

	const resolveCreateCmdId = async ctx => {
		if (createCmdId) {
			return createCmdId;
		}
		const base = deriveAlexaBaseId(cfg.jsonStateId);
		const candidates = [`${base}.#New`, `${base}.#create`, `${base}.items.#create`];
		for (const id of candidates) {
			try {
				const obj = await ctx.api.iobroker.objects.getForeignObject(id);
				if (obj) {
					createCmdId = id;
					return createCmdId;
				}
			} catch {
				// ignore and try next candidate
			}
		}
		if (!createCmdWarned) {
			createCmdWarned = true;
			ctx.api.log.warn(
				`no create command state found for '${cfg.jsonStateId}' (tried: ${candidates.join(', ')})`,
			);
		}
		return null;
	};

	const parseAlexaItems = raw => {
		if (raw == null || raw === '') {
			return [];
		}
		const v = typeof raw === 'string' ? raw : JSON.stringify(raw);
		try {
			const items = JSON.parse(v);
			return Array.isArray(items) ? items : [];
		} catch {
			return [];
		}
	};

	const farFutureNotifyAt = () => Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
	const for4hMs = () => 4 * 60 * 60 * 1000;

	const taskRef = (ctx, extId) => `BridgeAlexaTasks.${ctx.meta.plugin.instanceId}.${cfg.jsonStateId}.${extId}`;

	const desiredAlexaValue = msg => {
		const dTask = msg?.details?.task ? String(msg.details.task).trim() : '';
		if (dTask) {
			return dTask;
		}
		const text = msg?.text ? String(msg.text).trim() : '';
		if (text) {
			return text;
		}
		const title = msg?.title ? String(msg.title).trim() : '';
		return title;
	};

	const matchOutboundFilter = msg => {
		if (!cfg.outEnabled) {
			return false;
		}
		if (!msg || typeof msg !== 'object') {
			return false;
		}

		const kinds = new Set(toCsvList(cfg.outKindsCsv).map(s => s.toLowerCase()));
		if (kinds.size > 0) {
			const k = typeof msg.kind === 'string' ? msg.kind.trim().toLowerCase() : '';
			if (!k || !kinds.has(k)) {
				return false;
			}
		}

		const level = typeof msg.level === 'number' ? msg.level : Number(msg.level);
		if (Number.isFinite(level)) {
			if (level < cfg.outLevelMin || level > cfg.outLevelMax) {
				return false;
			}
		} else {
			return false;
		}

		const states = new Set(toCsvList(cfg.outLifecycleStatesCsv).map(s => s.toLowerCase()));
		if (states.size > 0) {
			const st = typeof msg?.lifecycle?.state === 'string' ? msg.lifecycle.state.trim().toLowerCase() : '';
			if (!st || !states.has(st)) {
				return false;
			}
		}

		const tagFilter = toCsvList(cfg.outAudienceTagsAnyCsv);
		if (tagFilter.length > 0) {
			const tags = Array.isArray(msg?.audience?.tags) ? msg.audience.tags.map(String) : [];
			const set = new Set(tags.map(s => s.trim()).filter(Boolean));
			const any = tagFilter.some(t => set.has(t));
			if (!any) {
				return false;
			}
		}

		return true;
	};

	const reportManagedState = async ctx => {
		const reporter = ctx?.meta?.managedObjects;
		if (!reporter || typeof reporter.report !== 'function' || typeof reporter.applyReported !== 'function') {
			return;
		}
		try {
			await reporter.report(cfg.jsonStateId, {
				managedText:
					'This state is monitored by the BridgeAlexaTasks plugin.\nIt is used as the source for importing Alexa TODO items into Message Hub.',
			});
			await reporter.applyReported();
		} catch (e) {
			ctx.api.log.warn(`reportManagedState failed: ${e?.message || e}`);
		}
	};

	const writeCmd = (ctx, id, val) =>
		ctx.api.iobroker.states
			.setForeignState(id, { val, ack: false })
			.catch(e => ctx.api.log.warn(`setForeignState failed: ${e?.message || e}`));

	const aiMaybeEnhanceTitle = async (ctx, rawText) => {
		if (!cfg.aiEnhancedTitle) {
			return rawText;
		}
		const ai = ctx.api.ai;
		const status = ai?.getStatus?.();
		if (!status?.enabled) {
			return rawText;
		}

		const res = await ai.text({
			purpose: 'title.task',
			messages: [
				{ role: 'system', content: 'Create a concise task title. Keep it short. Reply with plain text only.' },
				{ role: 'user', content: String(rawText || '') },
			],
			hints: { quality: 'fast', temperature: 0 },
			timeoutMs: 15000,
			cache: {
				key: `title:${String(rawText || '')
					.trim()
					.toLowerCase()}`,
				ttlMs: 7 * 24 * 60 * 60 * 1000,
			},
		});
		if (res?.ok !== true) {
			return rawText;
		}
		const out = String(res.value || '').trim();
		return out || rawText;
	};

	const maybeAdoptPendingCreates = items => {
		const pending =
			mapping?.out?.pendingCreates && typeof mapping.out.pendingCreates === 'object'
				? mapping.out.pendingCreates
				: {};
		const entries = Object.entries(pending);
		if (entries.length === 0) {
			return;
		}

		const seen = new Set(items.map(it => it?.id).filter(Boolean));
		for (const [ref, info] of entries) {
			const desired = typeof info?.value === 'string' ? info.value : '';
			const requestedAt = typeof info?.requestedAt === 'number' ? info.requestedAt : 0;
			if (!ref || !desired) {
				delete pending[ref];
				continue;
			}
			if (mapping.out.messageRefToExternal[ref]) {
				delete pending[ref];
				continue;
			}

			let best = null;
			let bestDelta = Infinity;
			for (const it of items) {
				const extId = it?.id;
				if (!extId || seen.has(extId) === false) {
					continue;
				}
				if (mapping.out.externalToMessageRef[extId]) {
					continue;
				}
				if (String(it?.value || '').trim() !== desired) {
					continue;
				}
				const created = typeof it?.createdDateTime === 'number' ? it.createdDateTime : 0;
				if (requestedAt && created && created + 2000 < requestedAt) {
					continue;
				}
				const delta = requestedAt && created ? Math.abs(created - requestedAt) : 0;
				if (delta < bestDelta) {
					best = it;
					bestDelta = delta;
				}
			}

			if (best?.id) {
				mapping.out.messageRefToExternal[ref] = best.id;
				mapping.out.externalToMessageRef[best.id] = ref;
				delete pending[ref];
			}
		}
	};

	const syncOutbound = async (ctx, items) => {
		const cmd = ids();
		const currentById = new Map(items.map(it => [it?.id, it]).filter(([id]) => !!id));

		if (!cfg.outEnabled) {
			for (const [ref, extId] of Object.entries(mapping.out.messageRefToExternal || {})) {
				if (typeof extId === 'string' && extId.trim() && currentById.has(extId)) {
					await writeCmd(ctx, cmd.itemDelete(extId), true);
				}
				if (typeof extId === 'string' && extId.trim()) {
					delete mapping.out.externalToMessageRef[extId];
				}
				delete mapping.out.messageRefToExternal[ref];
				delete mapping.out.pendingCreates?.[ref];
			}
			return;
		}

		if (!cmd.create) {
			cmd.create = await resolveCreateCmdId(ctx);
		}
		const where = {};
		const kindsList = toCsvList(cfg.outKindsCsv);
		if (kindsList.length === 1) {
			where.kind = kindsList[0];
		} else if (kindsList.length > 1) {
			where.kind = { in: kindsList };
		}
		where.level = { min: cfg.outLevelMin, max: cfg.outLevelMax };

		const states = toCsvList(cfg.outLifecycleStatesCsv);
		if (states.length === 1) {
			where.lifecycle = { state: states[0] };
		} else if (states.length > 1) {
			where.lifecycle = { state: { in: states } };
		}

		const tagsAny = toCsvList(cfg.outAudienceTagsAnyCsv);
		if (tagsAny.length > 0) {
			where.audience = { ...(where.audience || {}), tags: { any: tagsAny } };
		}

		// Align pull selection with notify-side routing semantics (plugin channel + message audience.channels).
		where.audience = { ...(where.audience || {}), channels: { routeTo: ctx?.meta?.plugin?.channel || '' } };

		const queried = ctx.api.store.queryMessages({ where });
		const desiredMessages = (queried?.items || []).filter(m => matchOutboundFilter(m));
		const desiredByRef = new Map();
		for (const m of desiredMessages) {
			const ref = typeof m?.ref === 'string' ? m.ref : '';
			if (!ref) {
				continue;
			}
			const value = desiredAlexaValue(m);
			if (!value) {
				continue;
			}
			desiredByRef.set(ref, value);
		}

		// Remove mapped items that are no longer desired.
		for (const [ref, extId] of Object.entries(mapping.out.messageRefToExternal || {})) {
			if (desiredByRef.has(ref)) {
				continue;
			}
			if (typeof extId === 'string' && extId.trim()) {
				await writeCmd(ctx, cmd.itemDelete(extId), true);
				delete mapping.out.externalToMessageRef[extId];
			}
			delete mapping.out.messageRefToExternal[ref];
			delete mapping.out.pendingCreates?.[ref];
		}

		// Ensure desired messages exist and are up to date.
		for (const [ref, desiredValue] of desiredByRef.entries()) {
			const extId = mapping.out.messageRefToExternal[ref];
			if (!extId) {
				if (!cmd.create) {
					continue;
				}
				const now = Date.now();
				const pending = mapping.out.pendingCreates?.[ref];
				const retry =
					!pending ||
					pending.value !== desiredValue ||
					(typeof pending.requestedAt === 'number' &&
						pending.requestedAt > 0 &&
						now - pending.requestedAt > 60 * 1000);
				if (retry) {
					mapping.out.pendingCreates[ref] = { value: desiredValue, requestedAt: now };
					await writeCmd(ctx, cmd.create, desiredValue);
				}
				continue;
			}

			const current = currentById.get(extId);
			const currentValue = current?.value != null ? String(current.value).trim() : '';
			if (currentValue !== desiredValue) {
				await writeCmd(ctx, cmd.itemValue(extId), desiredValue);
			}
		}
	};

	const syncInbound = async (ctx, items) => {
		const cmd = ids();
		if (!ctx?.api?.factory || typeof ctx.api.factory.createMessage !== 'function') {
			ctx.api.log.warn('inbound sync skipped (ctx.api.factory is not available)');
			return;
		}

		// Import only "foreign" (not projected by this plugin) and not completed items.
		const owned = new Set(Object.keys(mapping.out.externalToMessageRef || {}));
		for (const it of items) {
			const extId = it?.id;
			if (!extId) {
				continue;
			}
			if (owned.has(extId)) {
				continue;
			}

			const completed = !!it?.completed;
			if (completed) {
				continue;
			}

			const raw = String(it?.value || '').trim();
			if (!raw) {
				continue;
			}

			const ref = taskRef(ctx, extId);
			const title = await aiMaybeEnhanceTitle(ctx, raw);
			const tags = toCsvList(cfg.audienceTagsCsv);
			const chInclude = toCsvList(cfg.audienceChannelsIncludeCsv);
			const chExclude = toCsvList(cfg.audienceChannelsExcludeCsv);
			const audience =
				tags.length > 0 || chInclude.length > 0 || chExclude.length > 0
					? {
							...(tags.length > 0 ? { tags } : {}),
							...(chInclude.length > 0 || chExclude.length > 0
								? {
										channels: {
											...(chInclude.length > 0 ? { include: chInclude } : {}),
											...(chExclude.length > 0 ? { exclude: chExclude } : {}),
										},
									}
								: {}),
						}
					: undefined;
			const actions = [
				{ type: ctx.api.constants.actions.type.ack, id: 'ack' },
				{ type: ctx.api.constants.actions.type.snooze, id: 'snooze4h', payload: { forMs: for4hMs() } },
				{ type: ctx.api.constants.actions.type.close, id: 'close' },
			];

			const created = ctx.api.factory.createMessage({
				ref,
				title,
				text: raw,
				level: ctx.api.constants.level.notice,
				kind: ctx.api.constants.kind.task,
				origin: { type: ctx.api.constants.origin.type.automation, system: 'Amazon Alexa', id: cfg.jsonStateId },
				audience,
				details: { task: raw },
				timing: { notifyAt: farFutureNotifyAt() },
				actions,
			});

			const ok = created ? ctx.api.store.addOrUpdateMessage(created) : false;
			if (ok) {
				await writeCmd(ctx, cmd.itemDelete(extId), true);
			} else {
				await writeCmd(ctx, cmd.itemCompleted(extId), true);
			}
		}
	};

	const fullSync = async ctx => {
		const st = await ctx.api.iobroker.states.getForeignState(cfg.jsonStateId);
		const items = parseAlexaItems(st?.val);

		if (mapping.jsonStateId && mapping.jsonStateId !== cfg.jsonStateId) {
			mapping.jsonStateId = cfg.jsonStateId;
			mapping.out = { messageRefToExternal: {}, externalToMessageRef: {}, pendingCreates: {} };
		}
		normalizeMappingOut();

		maybeAdoptPendingCreates(items);
		await syncInbound(ctx, items);
		await syncOutbound(ctx, items);
		await saveMapping(ctx);
	};

	const outboundSyncOnly = async ctx => {
		const st = await ctx.api.iobroker.states.getForeignState(cfg.jsonStateId);
		const items = parseAlexaItems(st?.val);
		maybeAdoptPendingCreates(items);
		await syncOutbound(ctx, items);
		await saveMapping(ctx);
	};

	let fullSyncTimer = null;
	let outboundTimer = null;

	const scheduleFullSync = (ctx, delayMs = 250) => {
		if (!running) {
			return;
		}
		if (fullSyncTimer) {
			ctx.meta.resources.clearTimeout(fullSyncTimer);
			fullSyncTimer = null;
		}
		fullSyncTimer = ctx.meta.resources.setTimeout(
			() => {
				fullSyncTimer = null;
				fullSync(ctxIngestRef || ctx).catch(e => ctx.api.log.warn(`fullSync failed: ${e?.message || e}`));
			},
			Math.max(0, delayMs),
		);
	};

	const scheduleOutboundSync = (ctx, delayMs = 250) => {
		if (!running) {
			return;
		}
		if (outboundTimer) {
			ctx.meta.resources.clearTimeout(outboundTimer);
			outboundTimer = null;
		}
		outboundTimer = ctx.meta.resources.setTimeout(
			() => {
				outboundTimer = null;
				outboundSyncOnly(ctxNotifyRef || ctx).catch(e =>
					ctx.api.log.warn(`outbound sync failed: ${e?.message || e}`),
				);
			},
			Math.max(0, delayMs),
		);
	};

	const start = ctx => {
		if (running) {
			return;
		}
		running = true;
		ctxIngestRef = ctx;
		applyResolvedOptions(ctx);

		(async () => {
			await ensureMappingState(ctx);
			await loadMapping(ctx);
			await reportManagedState(ctx);
			await resolveCreateCmdId(ctx);

			normalizeMappingOut();
			if (mapping.jsonStateId && mapping.jsonStateId !== cfg.jsonStateId) {
				mapping.out = { messageRefToExternal: {}, externalToMessageRef: {}, pendingCreates: {} };
			}
			normalizeMappingOut();

			mapping.jsonStateId = cfg.jsonStateId;
			await saveMapping(ctx);

			ctx.api.iobroker.subscribe.subscribeForeignStates(cfg.jsonStateId);
			await fullSync(ctx);

			if (cfg.fullSyncIntervalMs > 0) {
				ctx.meta.resources.setInterval(
					() => fullSync(ctxIngestRef).catch(e => ctx.api.log.warn(`fullSync failed: ${e?.message || e}`)),
					cfg.fullSyncIntervalMs,
				);
			}
		})().catch(e => ctx.api.log.warn(`start failed: ${e?.message || e}`));
	};

	const stop = ctx => {
		running = false;
		if (fullSyncTimer) {
			ctx.meta.resources.clearTimeout(fullSyncTimer);
			fullSyncTimer = null;
		}
		if (outboundTimer) {
			ctx.meta.resources.clearTimeout(outboundTimer);
			outboundTimer = null;
		}
		(async () => {
			await saveMapping(ctx);
		})().catch(() => {});
	};

	const onStateChange = (id, _state, ctx) => {
		if (!running || id !== cfg.jsonStateId) {
			return;
		}
		ctxIngestRef = ctx;
		scheduleFullSync(ctx, 250);
	};

	const onNotifications = (_event, _notifications, ctx) => {
		if (!running) {
			return;
		}
		ctxNotifyRef = ctx;
		scheduleOutboundSync(ctx, 250);
	};

	return { start, stop, onStateChange, onNotifications };
}

module.exports = { BridgeAlexaTasks, manifest };
