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
		let lastJsonFingerprint = '';
		let jsonChangedThisRun = false;
		let connectionOfflineWarned = false;

	let cfg = Object.freeze({
		jsonStateId: 'alexa2.0.Lists.TODO.json',
		audienceTagsCsv: '',
		audienceChannelsIncludeCsv: '',
		audienceChannelsExcludeCsv: '',
		fullSyncIntervalMs: 60 * 60 * 1000,
		pendingMaxJsonMisses: 30,
		aiEnhancedTitle: false,
		outEnabled: true,
		outKindsCsv: 'task',
		outLevelMin: 10,
		outLevelMax: 30,
		outLifecycleStatesCsv: 'open',
		outAudienceTagsAnyCsv: '',
	});

	let mapping = {
		version: 2,
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
				version: 2,
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
			pendingMaxJsonMisses: o.resolveInt('pendingMaxJsonMisses', options.pendingMaxJsonMisses),
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

		// No legacy compatibility: discard persisted mappings with unknown versions.
		if (parsed.version !== 2) {
			return;
		}

		const out = parsed.out && typeof parsed.out === 'object' && !Array.isArray(parsed.out) ? parsed.out : {};
		mapping = {
			version: 2,
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
				return { ok: false, reason: 'missing', items: [], fingerprint: '' };
			}
			const v = typeof raw === 'string' ? raw : JSON.stringify(raw);
			try {
				const items = JSON.parse(v);
				if (!Array.isArray(items)) {
					return { ok: false, reason: 'invalid', items: [], fingerprint: v };
				}
				return { ok: true, items, fingerprint: v };
			} catch {
				return { ok: false, reason: 'invalid', items: [], fingerprint: v };
			}
		};

		const alexaSystemId = () => cfg.jsonStateId.split('.').slice(0, 2).join('.') || 'alexa2';

		const alexaConnectionStateId = () => `${alexaSystemId()}.info.connection`;

		const isAlexaConnected = async ctx => {
			const id = alexaConnectionStateId();
			try {
				const st = await ctx.api.iobroker.states.getForeignState(id);
				if (st?.val === false) {
					if (!connectionOfflineWarned) {
						connectionOfflineWarned = true;
						ctx.api.log.warn(`Alexa connection is false (${id}), pausing BridgeAlexaTasks sync`);
					}
					return false;
				}
				connectionOfflineWarned = false;
				return true;
			} catch (e) {
				ctx.api.log.warn(`getForeignState failed for '${id}': ${e?.message || e}`);
				return true;
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

	const expectedValueLookup = () => {
		normalizeMappingOut();
		const byValue = new Map();
		for (const [ref, info] of Object.entries(mapping.out.pendingCreates || {})) {
			const expectedValue = typeof info?.expectedValue === 'string' ? info.expectedValue.trim() : '';
			if (!ref || !expectedValue) {
				delete mapping.out.pendingCreates[ref];
				continue;
			}
			if (!byValue.has(expectedValue)) {
				byValue.set(expectedValue, []);
			}
			byValue.get(expectedValue).push(ref);
		}
		return byValue;
	};

	const adoptPendingCreates = items => {
		const byValue = expectedValueLookup();
		if (byValue.size === 0) {
			return;
		}

		for (const it of items) {
			const extId = it?.id;
			if (!extId) {
				continue;
			}
			if (mapping.out.externalToMessageRef[extId]) {
				continue;
			}
			const raw = String(it?.value || '').trim();
			if (!raw || !raw.startsWith('~')) {
				continue;
			}
			const list = byValue.get(raw);
			if (!list || list.length === 0) {
				continue;
			}
			const ref = list.shift();
			if (!ref || mapping.out.messageRefToExternal[ref]) {
				continue;
			}
			mapping.out.messageRefToExternal[ref] = extId;
			mapping.out.externalToMessageRef[extId] = ref;
			delete mapping.out.pendingCreates[ref];
		}
	};

	const syncOutbound = async (ctx, items, opts) => {
		const jsonChanged = !!opts?.jsonChanged;
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
				if (!jsonChanged) {
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
				const maxMisses = Math.max(1, Number(cfg.pendingMaxJsonMisses) || 30);
				const pending = mapping.out.pendingCreates?.[ref];
				const prevExpected = typeof pending?.expectedValue === 'string' ? pending.expectedValue : '';
				const prevMisses =
					typeof pending?.misses === 'number' && Number.isFinite(pending.misses) ? pending.misses : 0;
				const prevTries =
					typeof pending?.tries === 'number' && Number.isFinite(pending.tries) ? pending.tries : 0;

				if (!prevExpected || prevExpected !== desiredValue) {
					mapping.out.pendingCreates[ref] = { expectedValue: desiredValue, misses: 0, tries: prevTries + 1 };
					await writeCmd(ctx, cmd.create, desiredValue);
					continue;
				}

				if (jsonChanged) {
					const misses = prevMisses + 1;
					if (misses >= maxMisses) {
						mapping.out.pendingCreates[ref] = {
							expectedValue: desiredValue,
							misses: 0,
							tries: prevTries + 1,
						};
						await writeCmd(ctx, cmd.create, desiredValue);
					} else {
						mapping.out.pendingCreates[ref] = { expectedValue: desiredValue, misses, tries: prevTries };
					}
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
			if (!(await isAlexaConnected(ctx))) {
				return;
			}
			const st = await ctx.api.iobroker.states.getForeignState(cfg.jsonStateId);
			const parsed = parseAlexaItems(st?.val);
			if (!parsed.ok) {
				return;
			}
			const items = parsed.items;
			const fingerprint = parsed.fingerprint;
			jsonChangedThisRun = fingerprint !== lastJsonFingerprint;
			if (jsonChangedThisRun) {
			lastJsonFingerprint = fingerprint;
		}

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
			lastJsonFingerprint = '';
			jsonChangedThisRun = false;
		}
		normalizeMappingOut();

		adoptPendingCreates(items);
		await syncInbound(ctx, items);
		await syncOutbound(ctx, items, { jsonChanged: jsonChangedThisRun });
		await saveMapping(ctx);
	};

		const outboundSyncOnly = async ctx => {
			if (!(await isAlexaConnected(ctx))) {
				return;
			}
			const st = await ctx.api.iobroker.states.getForeignState(cfg.jsonStateId);
			const parsed = parseAlexaItems(st?.val);
			if (!parsed.ok) {
				return;
			}
			const items = parsed.items;
			const fingerprint = parsed.fingerprint;
			jsonChangedThisRun = fingerprint !== lastJsonFingerprint;
			if (jsonChangedThisRun) {
			lastJsonFingerprint = fingerprint;
		}
		adoptPendingCreates(items);
		await syncOutbound(ctx, items, { jsonChanged: jsonChangedThisRun });
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
				lastJsonFingerprint = '';
				jsonChangedThisRun = false;
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
			lastJsonFingerprint = '';
			jsonChangedThisRun = false;
			connectionOfflineWarned = false;
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
