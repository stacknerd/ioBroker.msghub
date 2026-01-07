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
	let lastAlexaJsonTs = 0;
	let countStaleMissingThisRun = false;

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
			missingByRef: {},
		},
	};

	let createCmdId = null;
	let createCmdWarned = false;

	const STALE_DROP_AFTER_UPDATES = 5;

	const normalizeMappingOut = () => {
		if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
			mapping = {
				version: 1,
				jsonStateId: '',
				out: { messageRefToExternal: {}, externalToMessageRef: {}, pendingCreates: {}, missingByRef: {} },
			};
		}
		if (!mapping.out || typeof mapping.out !== 'object' || Array.isArray(mapping.out)) {
			mapping.out = { messageRefToExternal: {}, externalToMessageRef: {}, pendingCreates: {}, missingByRef: {} };
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
		if (!mapping.out.missingByRef || typeof mapping.out.missingByRef !== 'object') {
			mapping.out.missingByRef = {};
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
				missingByRef: out.missingByRef && typeof out.missingByRef === 'object' ? out.missingByRef : {},
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

	const for4hMs = () => 4 * 60 * 60 * 1000;

	const taskRef = (ctx, extId) => `BridgeAlexaTasks.${ctx.meta.plugin.instanceId}.${cfg.jsonStateId}.${extId}`;

	const stripLeadingTildes = value =>
		String(value || '')
			.trim()
			.replace(/^~+/, '')
			.trim();

	const desiredAlexaValue = msg => {
		const dTask = stripLeadingTildes(msg?.details?.task);
		if (dTask) {
			return `~${dTask}`;
		}
		const text = stripLeadingTildes(msg?.text);
		if (text) {
			return `~${text}`;
		}
		const title = stripLeadingTildes(msg?.title);
		return title ? `~${title}` : '';
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
				{
					role: 'system',
					content:
						'Erzeuge einen kurzen Titel in derselben Sprache wie der Input. Nicht übersetzen. Keine neuen Wörter hinzufügen, außer minimalen Artikeln entfernen. Korrigiere nur Groß-/Kleinschreibung. Antworte als Plain Text.',
				},
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
		const now = Date.now();
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
		const whereBase = {};

		const kindsList = toCsvList(cfg.outKindsCsv)
			.map(s => s.toLowerCase())
			.filter(Boolean);
		const wantsTask = kindsList.includes('task');
		const otherKinds = kindsList.filter(k => k !== 'task');

		whereBase.level = { min: cfg.outLevelMin, max: cfg.outLevelMax };

		const states = toCsvList(cfg.outLifecycleStatesCsv)
			.map(s => s.toLowerCase())
			.filter(Boolean);
		if (states.length === 1) {
			whereBase.lifecycle = { state: states[0] };
		} else if (states.length > 1) {
			whereBase.lifecycle = { state: { in: states } };
		}

		const tagsAny = toCsvList(cfg.outAudienceTagsAnyCsv);
		if (tagsAny.length > 0) {
			whereBase.audience = { ...(whereBase.audience || {}), tags: { any: tagsAny, orMissing: true } };
		}

		// Align pull selection with notify-side routing semantics (plugin channel + message audience.channels).
		whereBase.audience = { ...(whereBase.audience || {}), channels: { routeTo: ctx?.meta?.plugin?.channel || '' } };

		const query = where => {
			const r = ctx.api.store.queryMessages({ where });
			return Array.isArray(r?.items) ? r.items : [];
		};

		let desiredMessages = [];
		if (kindsList.length === 0) {
			desiredMessages = query(whereBase);
		} else if (wantsTask) {
			desiredMessages = desiredMessages.concat(
				query({
					...whereBase,
					kind: 'task',
					timing: { startAt: { max: now, orMissing: true } },
				}),
			);
			if (otherKinds.length === 1) {
				desiredMessages = desiredMessages.concat(query({ ...whereBase, kind: otherKinds[0] }));
			} else if (otherKinds.length > 1) {
				desiredMessages = desiredMessages.concat(query({ ...whereBase, kind: { in: otherKinds } }));
			}
		} else if (kindsList.length === 1) {
			desiredMessages = query({ ...whereBase, kind: kindsList[0] });
		} else {
			desiredMessages = query({ ...whereBase, kind: { in: kindsList } });
		}

		// ab hier begintn ein entfernbarer debug-block
		ctx.api.log.silly(`desiredMessages=${JSON.stringify(desiredMessages, null, 2)}`);
		// hier endet der entfernbare debug-block.

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
			delete mapping.out.missingByRef?.[ref];
		}

		// Ensure desired messages exist and are up to date.
		for (const [ref, desiredValue] of desiredByRef.entries()) {
			let extId = mapping.out.messageRefToExternal[ref];
			if (extId && !currentById.has(extId)) {
				if (!countStaleMissingThisRun) {
					continue;
				}
				const missing = mapping.out.missingByRef;
				const prev = missing?.[ref] && typeof missing[ref] === 'object' ? missing[ref] : null;
				const count = prev && prev.extId === extId && Number.isFinite(prev.updates) ? prev.updates + 1 : 1;
				if (missing) {
					missing[ref] = { extId, updates: count };
				}

				if (count < STALE_DROP_AFTER_UPDATES) {
					continue;
				}

				delete mapping.out.missingByRef?.[ref];
				delete mapping.out.messageRefToExternal[ref];
				delete mapping.out.externalToMessageRef[extId];
				delete mapping.out.pendingCreates?.[ref];
				extId = null;
			} else if (extId) {
				delete mapping.out.missingByRef?.[ref];
			}
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
			if (raw.startsWith('~')) {
				// ab hier begintn ein entfernbarer debug-block
				ctx.api.log.debug?.(
					`BridgeAlexaTasks inbound: skip prefixed item extId='${extId}' raw='${raw.length > 120 ? `${raw.slice(0, 119)}…` : raw}'`,
				);
				// hier endet der entfernbare debug-block.
				continue;
			}

			const ref = taskRef(ctx, extId);

			// ab hier begintn ein entfernbarer debug-block
			const existing = ctx.api.store.getMessageByRef(ref);
			const existingState =
				typeof existing?.lifecycle?.state === 'string' ? existing.lifecycle.state.trim().toLowerCase() : '';
			if (existingState === 'closed') {
				ctx.api.log.debug?.(
					`BridgeAlexaTasks inbound: ref='${ref}' exists with lifecycle.state=closed -> update`,
				);
			}
			// hier endet der entfernbare debug-block.

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

			let ok = false;

			const sysString = cfg.jsonStateId.split('.').slice(0, 2).join('.') || 'alexa2';

			if (existing) {
				ok = ctx.api.store.updateMessage(ref, {
					title,
					text: raw,
					origin: {
						type: ctx.api.constants.origin.type.automation,
						system: sysString,
						id: cfg.jsonStateId,
					},
					audience,
					details: { task: raw },
					timing: { startAt: Date.now() },
					actions,
				});
			} else {
				const created = ctx.api.factory.createMessage({
					ref,
					title,
					text: raw,
					level: ctx.api.constants.level.notice,
					kind: ctx.api.constants.kind.task,
					origin: {
						type: ctx.api.constants.origin.type.automation,
						system: sysString,
						id: cfg.jsonStateId,
					},
					audience,
					details: { task: raw },
					timing: { startAt: Date.now() },
					actions,
				});
				ok = created ? ctx.api.store.addOrUpdateMessage(created) : false;
			}

			if (ok) {
				await writeCmd(ctx, cmd.itemDelete(extId), true);
			} else {
				await writeCmd(ctx, cmd.itemCompleted(extId), true);
			}
		}
	};

	const fullSync = async ctx => {
		const st = await ctx.api.iobroker.states.getForeignState(cfg.jsonStateId);
		const ts = typeof st?.ts === 'number' ? st.ts : 0;
		countStaleMissingThisRun = ts > 0 && ts !== lastAlexaJsonTs;
		if (ts > 0) {
			lastAlexaJsonTs = ts;
		}
		const items = parseAlexaItems(st?.val);

		// ab hier begintn ein entfernbarer debug-block
		ctx.api.log.debug?.(`BridgeAlexaTasks: fullSync jsonStateId='${cfg.jsonStateId}' items=${items.length}`);
		// hier endet der entfernbare debug-block.

		if (mapping.jsonStateId && mapping.jsonStateId !== cfg.jsonStateId) {
			// ab hier begintn ein entfernbarer debug-block
			ctx.api.log.debug?.(
				`BridgeAlexaTasks: mapping reset (jsonStateId '${mapping.jsonStateId}' -> '${cfg.jsonStateId}')`,
			);
			// hier endet der entfernbare debug-block.
			mapping.jsonStateId = cfg.jsonStateId;
			mapping.out = { messageRefToExternal: {}, externalToMessageRef: {}, pendingCreates: {}, missingByRef: {} };
		}
		normalizeMappingOut();

		maybeAdoptPendingCreates(items);
		await syncInbound(ctx, items);
		await syncOutbound(ctx, items);
		await saveMapping(ctx);
	};

	const outboundSyncOnly = async ctx => {
		countStaleMissingThisRun = false;
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
				mapping.out = {
					messageRefToExternal: {},
					externalToMessageRef: {},
					pendingCreates: {},
					missingByRef: {},
				};
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
