/**
 * BridgeAlexaShopping
 * ===================
 *
 * Bidirectional sync between an Alexa list (alexa2) and a MsgHub shoppinglist message.
 *
 * Source of truth: Message Hub (with explicit exception: Alexa delete removes MsgHub items).
 */

'use strict';

const { manifest } = require('./manifest');

/**
 * Create a BridgeAlexaShopping plugin instance.
 *
 * @param {object} [options] Optional initial options (may be overridden by manifest-bound options at runtime).
 * @returns {{ start: Function, stop: Function, onStateChange: Function, onNotifications: Function }} Plugin handlers.
 */
function BridgeAlexaShopping(options = {}) {
	let running = false;
	let ctxRef = null;

	let cfg = Object.freeze({
		jsonStateId: 'alexa2.0.Lists.SHOP.json',
		listTitle: 'Alexa shopping list',
		location: 'Supermarket',
		audienceTagsCsv: '',
		fullSyncIntervalMs: 60 * 60 * 1000,
		conflictWindowMs: 5000,
		keepCompleted: true,
		aiEnhancement: true,
		categoriesCsv: 'Produce,Bakery,Dairy,Meat,Frozen,Pantry,Drinks,Household,Hygiene,Other',
		aiMinConfidencePct: 80,
	});

	let mapping = {
		version: 2,
		messageRef: '',
		jsonStateId: '',
		localToExternal: {},
		externalToLocal: {},
		pendingCreates: {},
		categories: { signature: '', learned: {} },
	};

	let lastExternalIds = new Set();
	let lastExternal = new Map(); // extId -> { value, completed, createdDateTime }
	let lastWrites = new Map(); // extId -> { valueAt?, completedAt?, deleteAt? }
	let lastMsgInternalIds = new Set();
	let enforceTimers = new Map(); // extId -> timeout handle
	let categorizeTimer = null;

	const applyResolvedOptions = ctx => {
		const o = ctx?.meta?.options;
		cfg = Object.freeze({
			jsonStateId: o.resolveString('jsonStateId', options.jsonStateId),
			listTitle: o.resolveString('listTitle', options.listTitle),
			location: o.resolveString('location', options.location),
			audienceTagsCsv: o.resolveString('audienceTagsCsv', options.audienceTagsCsv),
			fullSyncIntervalMs: o.resolveInt('fullSyncIntervalMs', options.fullSyncIntervalMs),
			conflictWindowMs: o.resolveInt('conflictWindowMs', options.conflictWindowMs),
			keepCompleted: o.resolveBool('keepCompleted', options.keepCompleted),
			aiEnhancement: o.resolveBool('aiEnhancement', options.aiEnhancement),
			categoriesCsv: o.resolveString('categoriesCsv', options.categoriesCsv),
			aiMinConfidencePct: o.resolveInt('aiMinConfidencePct', options.aiMinConfidencePct),
		});
	};

	const t = (ctx, key, ...args) => ctx.api.i18n.t(key, ...args);

	const toTags = csv =>
		String(csv || '')
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);

	const toCsvList = csv => toTags(csv);

	const mappingOwnId = ctx => `${ctx.meta.plugin.baseOwnId}.mapping`;
	const mappingFullId = ctx => `${ctx.meta.plugin.baseFullId}.mapping`;

	const ensureMappingState = async ctx => {
		await ctx.api.iobroker.objects.setObjectNotExists(mappingOwnId(ctx), {
			type: 'state',
			common: {
				name: 'BridgeAlexaShopping mapping',
				type: 'string',
				role: 'json',
				read: true,
				write: true,
				def: '{}',
			},
			native: {},
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
		const cats =
			parsed.categories && typeof parsed.categories === 'object' && !Array.isArray(parsed.categories)
				? parsed.categories
				: {};
		const learned =
			cats.learned && typeof cats.learned === 'object' && !Array.isArray(cats.learned) ? cats.learned : {};
		mapping = {
			version: 2,
			messageRef: typeof parsed.messageRef === 'string' ? parsed.messageRef : '',
			jsonStateId: typeof parsed.jsonStateId === 'string' ? parsed.jsonStateId : '',
			localToExternal:
				parsed.localToExternal && typeof parsed.localToExternal === 'object' ? parsed.localToExternal : {},
			externalToLocal:
				parsed.externalToLocal && typeof parsed.externalToLocal === 'object' ? parsed.externalToLocal : {},
			pendingCreates:
				parsed.pendingCreates && typeof parsed.pendingCreates === 'object' ? parsed.pendingCreates : {},
			categories: {
				signature: typeof cats.signature === 'string' ? cats.signature : '',
				learned,
			},
		};
	};

	const saveMapping = async ctx => {
		await ctx.api.iobroker.states.setState(mappingOwnId(ctx), { val: JSON.stringify(mapping), ack: true });
	};

	const messageRef = ctx => `BridgeAlexaShopping.${ctx.meta.plugin.instanceId}.${cfg.jsonStateId}`;

	const deriveAlexaBaseId = jsonStateId => {
		const id = String(jsonStateId || '').trim();
		return id.endsWith('.json') ? id.slice(0, -'.json'.length) : id;
	};

	const ids = () => {
		const base = deriveAlexaBaseId(cfg.jsonStateId);
		return {
			json: cfg.jsonStateId,
			create: `${base}.#create`,
			itemValue: extId => `${base}.items.${extId}.value`,
			itemCompleted: extId => `${base}.items.${extId}.completed`,
			itemDelete: extId => `${base}.items.${extId}.#delete`,
		};
	};

	const categoryList = () => {
		const list = toCsvList(cfg.categoriesCsv);
		const seen = new Set();
		const unique = [];
		for (const c of list) {
			if (seen.has(c)) {
				continue;
			}
			seen.add(c);
			unique.push(c);
		}
		return unique;
	};

	const categorySignature = cats =>
		cats
			.map(s => String(s).trim().toLowerCase())
			.filter(Boolean)
			.join('|');

	const ensureCategoryContext = () => {
		if (!mapping.categories || typeof mapping.categories !== 'object' || Array.isArray(mapping.categories)) {
			mapping.categories = { signature: '', learned: {} };
		}
		const cats = categoryList();
		const sig = categorySignature(cats);
		if (mapping.categories.signature !== sig) {
			mapping.categories.signature = sig;
			mapping.categories.learned = {};
		}
	};

	const normalizeItemKey = name =>
		String(name || '')
			.trim()
			.toLowerCase()
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/ß/g, 'ss')
			.replace(/[^a-z0-9\s]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();

	const scheduleCategorize = ctx => {
		if (!running) {
			return;
		}
		if (categorizeTimer) {
			ctx.meta.resources.clearTimeout(categorizeTimer);
			categorizeTimer = null;
		}
		categorizeTimer = ctx.meta.resources.setTimeout(() => {
			categorizeTimer = null;
			categorizeNow(ctxRef || ctx).catch(e =>
				ctx.api.log.warn(`BridgeAlexaShopping: categorize failed: ${e?.message || e}`),
			);
		}, 600);
	};

	const categorizeNow = async ctx => {
		const ref = mapping.messageRef || messageRef(ctx);
		const msg = ctx.api.store.getMessageByRef(ref);
		if (!msg) {
			return;
		}

		const cats = categoryList();
		if (!cfg.aiEnhancement || cats.length === 0) {
			const set = {};
			for (const it of msg.listItems || []) {
				if (!it || typeof it !== 'object') {
					continue;
				}
				if (!it.category) {
					continue;
				}
				set[it.id] = { name: it.name, checked: !!it.checked };
			}
			if (Object.keys(set).length) {
				ctx.api.store.updateMessage(ref, { listItems: { set } }, true);
			}
			return;
		}

		const ai = ctx.api.ai;
		const status = ai?.getStatus?.();
		if (!status?.enabled) {
			return;
		}

		ensureCategoryContext();
		const allowed = cats;
		const fallbackCategory = allowed[allowed.length - 1];
		const threshold = Math.max(0, Math.min(1, Number(cfg.aiMinConfidencePct) / 100));

		const byKey = mapping.categories.learned || {};
		const patchSet = {};
		const toClassify = [];

		for (const it of msg.listItems || []) {
			if (!it || typeof it !== 'object') {
				continue;
			}
			const name = String(it.name || '').trim();
			if (!name) {
				continue;
			}

			const key = normalizeItemKey(name);
			if (!key) {
				continue;
			}

			const currentCategory = it.category ? String(it.category).trim() : '';
			const hasAllowedCategory = currentCategory && allowed.includes(currentCategory);

			const learned = byKey[key] && typeof byKey[key] === 'object' ? byKey[key] : null;
			const learnedCat = learned && typeof learned.category === 'string' ? learned.category : '';
			const learnedAllowed = learnedCat && allowed.includes(learnedCat);

			if (learnedAllowed) {
				if (currentCategory !== learnedCat) {
					patchSet[it.id] = { name, checked: !!it.checked, category: learnedCat };
				}
				continue;
			}

			if (!hasAllowedCategory) {
				toClassify.push({ id: it.id, key, name, checked: !!it.checked });
			}
		}

		if (Object.keys(patchSet).length) {
			ctx.api.store.updateMessage(ref, { listItems: { set: patchSet } }, true);
		}

		if (toClassify.length === 0) {
			return;
		}

		const batch = toClassify.slice(0, 25);
		const req = {
			purpose: 'categorize.shoppinglist',
			messages: [
				{
					role: 'system',
					content:
						'Categorize shopping list items into exactly one of the allowed categories. ' +
						'Return JSON: {"results":[{"key":"...","category":"...","confidence":0.0}]}. ' +
						'category must be one of allowedCategories. confidence is 0..1.',
				},
				{
					role: 'user',
					content: JSON.stringify({
						allowedCategories: allowed,
						fallbackCategory,
						items: batch.map(b => ({ key: b.key, text: b.name })),
					}),
				},
			],
			hints: { quality: 'fast', temperature: 0 },
		};

		const res = await ai.json(req);
		if (!res?.ok) {
			return;
		}

		const list = Array.isArray(res.value?.results) ? res.value.results : [];
		const byResultKey = new Map();
		for (const r of list) {
			const k = typeof r?.key === 'string' ? r.key : '';
			const c = typeof r?.category === 'string' ? r.category : '';
			const confidence = typeof r?.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : 0;
			if (!k) {
				continue;
			}
			byResultKey.set(k, { category: c, confidence });
		}

		const patchSet2 = {};
		let mappingChanged = false;

		for (const b of batch) {
			const r = byResultKey.get(b.key);
			let cat = r?.category && allowed.includes(r.category) ? r.category : fallbackCategory;
			const confidence = r?.confidence ?? 0;
			if (typeof confidence === 'number' && Number.isFinite(confidence) && confidence < threshold) {
				cat = fallbackCategory;
			}

			const prev = byKey[b.key] && typeof byKey[b.key] === 'object' ? byKey[b.key] : null;
			if (!prev || prev.category !== cat || prev.confidence !== confidence) {
				byKey[b.key] = { category: cat, confidence, updatedAt: Date.now() };
				mappingChanged = true;
			}

			patchSet2[b.id] = { name: b.name, checked: b.checked, category: cat };
		}

		if (Object.keys(patchSet2).length) {
			ctx.api.store.updateMessage(ref, { listItems: { set: patchSet2 } }, true);
		}

		if (mappingChanged) {
			mapping.categories.learned = byKey;
			await saveMapping(ctx);
		}

		if (toClassify.length > batch.length) {
			scheduleCategorize(ctx);
		}
	};

	const recordWrite = (extId, key) => {
		const now = Date.now();
		const entry = lastWrites.get(extId) || {};
		entry[key] = now;
		lastWrites.set(extId, entry);
	};

	const isRecentWrite = (extId, key) => {
		const entry = lastWrites.get(extId);
		if (!entry || typeof entry[key] !== 'number') {
			return false;
		}
		return Date.now() - entry[key] <= cfg.conflictWindowMs;
	};

	const scheduleEnforce = (extId, ctx) => {
		if (cfg.conflictWindowMs <= 0) {
			return;
		}
		if (enforceTimers.has(extId)) {
			ctx.meta.resources.clearTimeout(enforceTimers.get(extId));
			enforceTimers.delete(extId);
		}
		const handle = ctx.meta.resources.setTimeout(() => {
			enforceTimers.delete(extId);
			enforceOne(extId, ctx).catch(e =>
				ctx.api.log.warn(`BridgeAlexaShopping: enforce failed: ${e?.message || e}`),
			);
		}, cfg.conflictWindowMs);
		enforceTimers.set(extId, handle);
	};

	const farFutureNotifyAt = () => Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;

	const ensureMessage = ctx => {
		const ref = messageRef(ctx);
		const tags = toTags(cfg.audienceTagsCsv);
		const base = {
			ref,
			title: cfg.listTitle,
			text: t(ctx, 'Automatically synchronized shopping list based on the Alexa list "%s".', cfg.listTitle),
			level: ctx.api.constants.level.notice,
			kind: ctx.api.constants.kind.shoppinglist,
			origin: { type: ctx.api.constants.origin.type.automation, system: 'Amazon Alexa', id: cfg.jsonStateId },
			audience: tags.length ? { tags } : undefined,
			details: cfg.location ? { location: cfg.location } : undefined,
			timing: { notifyAt: farFutureNotifyAt() },
		};

		const listChanged = mapping.jsonStateId && mapping.jsonStateId !== cfg.jsonStateId;
		if (mapping.messageRef && mapping.messageRef !== ref) {
			const existing = ctx.api.store.getMessageByRef(mapping.messageRef);
			const copyItems = Array.isArray(existing?.listItems) ? existing.listItems : undefined;
			const created = ctx.api.factory.createMessage({ ...base, ...(copyItems ? { listItems: copyItems } : {}) });
			if (created) {
				ctx.api.store.addMessage(created);
				ctx.api.store.removeMessage(mapping.messageRef);
			}
			mapping.messageRef = ref;
			mapping.jsonStateId = cfg.jsonStateId;
			if (listChanged) {
				mapping.localToExternal = {};
				mapping.externalToLocal = {};
				mapping.pendingCreates = {};
				lastExternalIds = new Set();
				lastExternal = new Map();
				lastWrites = new Map();
				lastMsgInternalIds = new Set();
			}
			return;
		}

		const existing = ctx.api.store.getMessageByRef(ref);
		if (!existing) {
			const created = ctx.api.factory.createMessage(base);
			if (created) {
				ctx.api.store.addMessage(created);
			}
			mapping.messageRef = ref;
			mapping.jsonStateId = cfg.jsonStateId;
			return;
		}

		const timing = !Number.isFinite(existing?.timing?.notifyAt) ? base.timing : undefined;
		ctx.api.store.updateMessage(ref, {
			title: cfg.listTitle,
			text: base.text,
			audience: base.audience || null,
			details: base.details || null,
			...(timing ? { timing } : {}),
		});
		mapping.messageRef = ref;
		mapping.jsonStateId = cfg.jsonStateId;
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

	const findInternalIdForExternal = extId => {
		const fromMap = mapping.externalToLocal[extId];
		if (fromMap) {
			return fromMap;
		}
		const internalId = `a:${extId}`;
		mapping.localToExternal[internalId] = extId;
		mapping.externalToLocal[extId] = internalId;
		return internalId;
	};

	const maybeAdoptPendingCreates = items => {
		const pending = Object.entries(mapping.pendingCreates || {});
		if (pending.length === 0) {
			return;
		}

		for (const [internalId, info] of pending) {
			const name = typeof info?.name === 'string' ? info.name : '';
			const requestedAt = typeof info?.requestedAt === 'number' ? info.requestedAt : 0;
			if (!name) {
				delete mapping.pendingCreates[internalId];
				continue;
			}

			let best = null;
			let bestDelta = Infinity;
			for (const it of items) {
				const extId = it?.id;
				if (!extId) {
					continue;
				}
				if (mapping.externalToLocal[extId]) {
					continue;
				}
				if (String(it?.value || '').trim() !== name) {
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
				mapping.localToExternal[internalId] = best.id;
				mapping.externalToLocal[best.id] = internalId;
				delete mapping.pendingCreates[internalId];
			}
		}
	};

	const syncFromAlexa = async (raw, ctx) => {
		const ref = mapping.messageRef || messageRef(ctx);
		const msg = ctx.api.store.getMessageByRef(ref);
		if (!msg) {
			return;
		}
		const byInternal = new Map((msg.listItems || []).map(it => [it.id, it]));

		const items = parseAlexaItems(raw);
		maybeAdoptPendingCreates(items);

		const currentExtIds = new Set(items.map(it => it?.id).filter(Boolean));
		const removedExtIds = Array.from(lastExternalIds).filter(extId => !currentExtIds.has(extId));

		const patchSet = {};
		const patchDelete = [];

		for (const extId of removedExtIds) {
			const internalId = mapping.externalToLocal[extId];
			if (internalId) {
				patchDelete.push(internalId);
				delete mapping.externalToLocal[extId];
				delete mapping.localToExternal[internalId];
			}
			lastExternal.delete(extId);
			lastWrites.delete(extId);
		}

		for (const it of items) {
			const extId = it?.id;
			if (!extId) {
				continue;
			}
			const internalId = findInternalIdForExternal(extId);
			const name = String(it?.value || '').trim();
			const checked = !!it?.completed;

			const created = typeof it?.createdDateTime === 'number' ? it.createdDateTime : undefined;
			lastExternal.set(extId, { value: name, completed: checked, createdDateTime: created });

			if (!cfg.keepCompleted && checked) {
				patchDelete.push(internalId);
				continue;
			}

			const desired = byInternal.get(internalId);
			if (desired) {
				const valueMismatch = desired.name !== name;
				const completedMismatch = desired.checked !== checked;
				const conflict =
					(valueMismatch && isRecentWrite(extId, 'valueAt')) ||
					(completedMismatch && isRecentWrite(extId, 'completedAt'));
				if (conflict) {
					scheduleEnforce(extId, ctx);
					continue;
				}
			}

			patchSet[internalId] = { name, checked };
		}

		if (Object.keys(patchSet).length || patchDelete.length) {
			ctx.api.store.updateMessage(ref, {
				listItems: { set: patchSet, delete: patchDelete },
			});
		}

		lastExternalIds = currentExtIds;
		await saveMapping(ctx);
		scheduleCategorize(ctx);
	};

	const enforceOne = async (extId, ctx) => {
		const ref = mapping.messageRef || messageRef(ctx);
		const msg = ctx.api.store.getMessageByRef(ref);
		if (!msg) {
			return;
		}

		const internalId = mapping.externalToLocal[extId];
		if (!internalId) {
			return;
		}

		const item = (msg.listItems || []).find(it => it.id === internalId);
		if (!item) {
			return;
		}

		const cmd = ids();
		const write = (id, val) =>
			ctx.api.iobroker.states
				.setForeignState(id, { val, ack: true })
				.catch(e => ctx.api.log.warn(`BridgeAlexaShopping: setForeignState failed: ${e?.message || e}`));

		if (!cfg.keepCompleted && item.checked) {
			recordWrite(extId, 'deleteAt');
			await write(cmd.itemDelete(extId), true);
			return;
		}

		const ext = lastExternal.get(extId);
		if (!ext || ext.value !== item.name) {
			recordWrite(extId, 'valueAt');
			await write(cmd.itemValue(extId), item.name);
		}
		if (!ext || ext.completed !== item.checked) {
			recordWrite(extId, 'completedAt');
			await write(cmd.itemCompleted(extId), item.checked);
		}
	};

	const syncToAlexa = async (msg, ctx) => {
		const cmd = ids();
		const write = (id, val) =>
			ctx.api.iobroker.states
				.setForeignState(id, { val, ack: true })
				.catch(e => ctx.api.log.warn(`BridgeAlexaShopping: setForeignState failed: ${e?.message || e}`));

		const items = Array.isArray(msg?.listItems) ? msg.listItems : [];
		const currentInternalIds = new Set(items.map(it => it.id));

		const removedInternalIds = Array.from(lastMsgInternalIds).filter(id => !currentInternalIds.has(id));
		lastMsgInternalIds = currentInternalIds;

		for (const internalId of removedInternalIds) {
			const extId = mapping.localToExternal[internalId];
			if (!extId) {
				continue;
			}
			recordWrite(extId, 'deleteAt');
			await write(cmd.itemDelete(extId), true);
			delete mapping.localToExternal[internalId];
			delete mapping.externalToLocal[extId];
			lastExternal.delete(extId);
			lastWrites.delete(extId);
		}

		for (const it of items) {
			const internalId = it.id;
			const name = String(it.name || '').trim();
			const checked = !!it.checked;

			if (!name) {
				continue;
			}

			const extId = mapping.localToExternal[internalId];
			if (!extId) {
				const pending = mapping.pendingCreates?.[internalId];
				const now = Date.now();
				const retry =
					!pending ||
					pending.name !== name ||
					(typeof pending.requestedAt === 'number' &&
						pending.requestedAt > 0 &&
						now - pending.requestedAt > 60 * 1000);
				if (retry) {
					mapping.pendingCreates[internalId] = { name, requestedAt: now };
					await write(cmd.create, name);
				}
				continue;
			}

			if (enforceTimers.has(extId)) {
				continue;
			}

			if (!cfg.keepCompleted && checked) {
				if (!isRecentWrite(extId, 'deleteAt')) {
					recordWrite(extId, 'deleteAt');
					await write(cmd.itemDelete(extId), true);
				}
				continue;
			}

			const ext = lastExternal.get(extId);
			if (!ext || ext.value !== name) {
				recordWrite(extId, 'valueAt');
				await write(cmd.itemValue(extId), name);
			}
			if (!ext || ext.completed !== checked) {
				recordWrite(extId, 'completedAt');
				await write(cmd.itemCompleted(extId), checked);
			}
		}

		await saveMapping(ctx);
		scheduleCategorize(ctx);
	};

	const fullSync = async ctx => {
		const st = await ctx.api.iobroker.states.getForeignState(cfg.jsonStateId);
		await syncFromAlexa(st?.val, ctx);
		const ref = mapping.messageRef || messageRef(ctx);
		const msg = ctx.api.store.getMessageByRef(ref);
		if (msg) {
			await syncToAlexa(msg, ctx);
		}
	};

	const start = ctx => {
		if (running) {
			return;
		}
		running = true;
		ctxRef = ctx;
		applyResolvedOptions(ctx);

		(async () => {
			await ensureMappingState(ctx);
			await loadMapping(ctx);
			ensureCategoryContext();
			ensureMessage(ctx);
			await saveMapping(ctx);

			ctx.api.iobroker.subscribe.subscribeForeignStates(cfg.jsonStateId);
			await fullSync(ctx);

			if (cfg.fullSyncIntervalMs > 0) {
				ctx.meta.resources.setInterval(
					() =>
						fullSync(ctxRef).catch(e =>
							ctx.api.log.warn(`BridgeAlexaShopping: fullSync failed: ${e?.message || e}`),
						),
					cfg.fullSyncIntervalMs,
				);
			}
		})().catch(e => ctx.api.log.warn(`BridgeAlexaShopping: start failed: ${e?.message || e}`));
	};

	const stop = ctx => {
		running = false;
		if (categorizeTimer) {
			ctx.meta.resources.clearTimeout(categorizeTimer);
			categorizeTimer = null;
		}
		enforceTimers = new Map();
		lastExternalIds = new Set();
		lastExternal = new Map();
		lastWrites = new Map();
		lastMsgInternalIds = new Set();

		(async () => {
			const st = await ctx.api.iobroker.states.getForeignState(`${ctx.meta.plugin.baseFullId}.enable`);
			if (st?.val !== false) {
				return;
			}
			const ref = mapping.messageRef || messageRef(ctx);
			const existing = ctx.api.store.getMessageByRef(ref);
			if (!existing) {
				return;
			}
			ctx.api.store.updateMessage(ref, {
				title: `${cfg.listTitle} (${t(ctx, 'Connection to Alexa service lost')})`,
			});
		})().catch(e => ctx.api.log.warn(`BridgeAlexaShopping: stop failed: ${e?.message || e}`));
	};

	const onStateChange = (id, state, ctx) => {
		if (!running || id !== cfg.jsonStateId) {
			return;
		}
		ctxRef = ctx;
		syncFromAlexa(state?.val, ctx).catch(e =>
			ctx.api.log.warn(`BridgeAlexaShopping: sync failed: ${e?.message || e}`),
		);
	};

	const onNotifications = (_event, notifications, ctx) => {
		if (!running) {
			return;
		}
		const ref = mapping.messageRef || messageRef(ctxRef || ctx);
		const list = Array.isArray(notifications) ? notifications : [];
		for (const msg of list) {
			if (msg?.ref !== ref) {
				continue;
			}
			syncToAlexa(msg, ctx).catch(e =>
				ctx.api.log.warn(`BridgeAlexaShopping: syncToAlexa failed: ${e?.message || e}`),
			);
		}
	};

	return { start, stop, onStateChange, onNotifications };
}

module.exports = { BridgeAlexaShopping, manifest };
