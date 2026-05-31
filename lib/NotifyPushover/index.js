/**
 * NotifyPushover
 * =============
 *
 * MsgHub notifier plugin that sends MsgHub `due` notifications to the Pushover adapter via `sendTo()`.
 *
 * Docs: ../../docs/plugins/NotifyPushover.md
 */

'use strict';

const { manifest } = require('./manifest');
const { ensureCtxAvailability } = require('../IoPluginGuards');
const { createDeliveryStore } = require('./DeliveryStore');

const toCsvList = csv =>
	String(csv || '')
		.split(',')
		.map(s => s.trim())
		.filter(Boolean);

const stripHtmlTags = text =>
	String(text || '')
		.replace(/(<([^>]+)>)/gi, '')
		.trim();

/**
 * Create a MsgNotify plugin handler.
 *
 * @param {object} [options] Plugin options (from ioBroker `native`).
 * @returns {{ start?: (ctx: any) => void, stop?: (ctx: any) => void, onNotifications: (event: string, notifications: any[], ctx: any) => void }} Handler object.
 */
function NotifyPushover(options = {}) {
	let initialized = false;
	let log = null;
	let i18n = null;
	let iobroker = null;
	let templates = null;
	let o = null;
	let cfg = null;
	let levels = null;
	let deliveryStore = null;
	let gateHandle = null;
	let gateOpen = null;
	let started = false;

	const ensureInitialized = ctx => {
		if (initialized) {
			return;
		}

		ensureCtxAvailability('NotifyPushover', ctx, {
			plainObject: [
				'api',
				'meta',
				'meta.options',
				'meta.gates',
				'api.log',
				'api.i18n',
				'api.iobroker',
				'api.iobroker.objects',
				'api.iobroker.states',
				'api.templates',
				'api.constants',
				'api.constants.level',
			],
			fn: [
				'api.log.info',
				'api.log.warn',
				'api.i18n.t',
				'api.iobroker.sendTo',
				'api.iobroker.objects.setObjectNotExists',
				'api.iobroker.states.getForeignState',
				'api.iobroker.states.setState',
				'api.templates.renderStates',
				'meta.gates.register',
			],
		});

		log = ctx.api.log;
		i18n = ctx.api.i18n;
		iobroker = ctx.api.iobroker;
		templates = ctx.api.templates;
		o = ctx.meta.options;
		const constants = ctx?.api?.constants;
		levels = constants?.level && typeof constants.level === 'object' ? constants.level : null;

		const kinds = new Set(toCsvList(o.resolveString('kindsCsv', options.kindsCsv)).map(s => s.toLowerCase()));
		const audienceTagsAny = toCsvList(o.resolveString('audienceTagsAnyCsv', options.audienceTagsAnyCsv));

		cfg = Object.freeze({
			pushoverInstance: o.resolveString('pushoverInstance', options.pushoverInstance),
			kinds,
			levelMin: o.resolveInt('levelMin', options.levelMin),
			levelMax: o.resolveInt('levelMax', options.levelMax),
			audienceTagsAny,
			gateStateId: o.resolveString('gateStateId', options.gateStateId),
			gateOp: o.resolveString('gateOp', options.gateOp),
			gateValue: o.resolveString('gateValue', options.gateValue),
			gateBypassFromLevel: o.resolveInt('gateBypassFromLevel', options.gateBypassFromLevel),
			gateCheckinText: o.resolveString('gateCheckinText', options.gateCheckinText),
			gateCheckoutText: o.resolveString('gateCheckoutText', options.gateCheckoutText),
		});

		const baseFullId =
			typeof options.pluginBaseObjectId === 'string' && options.pluginBaseObjectId.trim()
				? options.pluginBaseObjectId.trim()
				: typeof ctx?.meta?.plugin?.baseFullId === 'string'
					? ctx.meta.plugin.baseFullId.trim()
					: '';
		if (!baseFullId) {
			throw new Error('options.pluginBaseObjectId is required');
		}
		deliveryStore = createDeliveryStore({ iobroker, log, baseFullId });

		initialized = true;
	};

	const matchFilters = msg => {
		if (!msg || typeof msg !== 'object') {
			return false;
		}

		if (cfg.kinds.size > 0) {
			const kind = typeof msg.kind === 'string' ? msg.kind.trim().toLowerCase() : '';
			if (!kind || !cfg.kinds.has(kind)) {
				return false;
			}
		}

		const level = typeof msg.level === 'number' ? msg.level : Number(msg.level);
		if (!Number.isFinite(level)) {
			return false;
		}
		if (level < cfg.levelMin || level > cfg.levelMax) {
			return false;
		}

		if (cfg.audienceTagsAny.length > 0) {
			const tags = Array.isArray(msg?.audience?.tags) ? msg.audience.tags.map(String) : [];
			const set = new Set(tags.map(s => s.trim()).filter(Boolean));
			const any = cfg.audienceTagsAny.some(t => set.has(t));
			if (!any) {
				return false;
			}
		}

		return true;
	};

	const send = payload =>
		iobroker.sendTo(cfg.pushoverInstance, 'send', payload).then(
			() => true,
			e => {
				log.warn(`sendTo failed: ${e?.message || e}`);
				return false;
			},
		);

	const computePriority = level => {
		if (level === levels?.none || level === levels?.info) {
			return -2;
		}
		if (level === levels?.notice) {
			return -1;
		}
		if (level === levels?.warning || level === levels?.error) {
			return 0;
		}
		if (level === levels?.critical) {
			return 1;
		}
		return 0;
	};

	const sendMessage = msg => {
		const level = typeof msg.level === 'number' ? msg.level : Number(msg.level);
		const priority = computePriority(level);

		const display = msg && typeof msg.display === 'object' && !Array.isArray(msg.display) ? msg.display : null;
		const displayTitle = typeof display?.title === 'string' ? display.title.trim() : '';
		const displayText = typeof display?.text === 'string' ? display.text.trim() : '';

		const rawIcon = typeof msg?.icon === 'string' ? msg.icon.trim() : '';
		const rawTitle = String(msg.title || '').trim();
		const rawText = String(msg.text || '').trim();

		const outTitle = displayTitle || [rawIcon, rawTitle].filter(Boolean).join(' ').trim();
		const outMessage = displayText || rawText;

		return send({
			message: stripHtmlTags(outMessage),
			sound: 'incoming',
			priority,
			title: outTitle,
		});
	};

	const sendGateMessage = async text => {
		const raw = typeof text === 'string' ? text.trim() : '';
		if (!raw) {
			return;
		}
		let out = raw;
		try {
			out = await templates.renderStates(raw);
		} catch (e) {
			log.warn(`gate renderStates failed: ${e?.message || e}`);
			out = raw;
		}
		const message = stripHtmlTags(out).trim();
		if (!message) {
			return;
		}
		return send({
			message,
			priority: 0,
			sound: 'magic',
			title: '',
		});
	};

	const isLocalPlainPath = value => {
		const v = typeof value === 'string' ? value.trim() : '';
		return !!v && !v.includes('://');
	};

	/**
	 * Extract local image attachment values from a message.
	 *
	 * @param {object} msg MsgHub message.
	 * @returns {string[]} Unique local image paths in attachment order.
	 */
	const getImageAttachmentValues = msg => {
		const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
		const out = [];
		for (const a of attachments) {
			if (!a || a.type !== 'image') {
				continue;
			}
			const value = typeof a.value === 'string' ? a.value.trim() : '';
			if (!isLocalPlainPath(value) || out.includes(value)) {
				continue;
			}
			out.push(value);
		}
		return out;
	};

	/**
	 * Send image attachments that are missing from the delivery record.
	 *
	 * @param {object} msg MsgHub message.
	 * @param {object|null} existing Existing delivery record.
	 * @param {number} [nowMs] Epoch ms used for receipt timestamps.
	 * @returns {Promise<void>} Resolves after best-effort sends.
	 */
	const sendNewImagesForRecord = async (msg, existing, nowMs = Date.now()) => {
		if (!existing) {
			return;
		}
		const ref = typeof existing.ref === 'string' ? existing.ref.trim() : '';
		if (!ref) {
			return;
		}
		const current =
			existing.imagesByValue && typeof existing.imagesByValue === 'object' ? existing.imagesByValue : {};
		const imagesByValue = { ...current };
		const images = getImageAttachmentValues(msg);
		if (images.length === 0) {
			return;
		}

		const title = i18n?.t('msghub.i18n.NotifyPushover.image.title.label');
		let changed = false;
		for (const file of images) {
			if (imagesByValue[file]) {
				continue;
			}
			const ok = await send({
				message: '📷',
				priority: -1,
				title,
				file,
			});
			if (!ok) {
				continue;
			}
			imagesByValue[file] = Object.freeze({ sentAt: nowMs });
			changed = true;
		}

		if (!changed) {
			return;
		}
		deliveryStore.upsert({
			ref,
			imagesByValue,
			createdAt: existing.createdAt,
			updatedAt: nowMs,
		});
		await deliveryStore.save();
	};

	/**
	 * Check filters and gate state for a message.
	 *
	 * @param {object} msg MsgHub message.
	 * @returns {boolean} True when delivery is allowed.
	 */
	const canDeliver = msg => {
		if (!matchFilters(msg)) {
			return false;
		}
		const level = typeof msg.level === 'number' ? msg.level : Number(msg.level);
		const gateBypass = Number.isFinite(level) && level >= cfg.gateBypassFromLevel;
		return gateOpen !== false || gateBypass;
	};

	/**
	 * Handle due notifications as new Pushover delivery cycles.
	 *
	 * @param {object[]} notifications MsgHub notifications.
	 * @returns {Promise<void>} Resolves after processing.
	 */
	const handleDueBatch = async notifications => {
		for (const msg of notifications) {
			if (!canDeliver(msg)) {
				continue;
			}
			const ref = typeof msg?.ref === 'string' ? msg.ref.trim() : '';
			if (!ref) {
				continue;
			}
			const now = Date.now();
			deliveryStore.removeByRef(ref);
			deliveryStore.upsert({ ref, imagesByValue: {}, createdAt: now, updatedAt: now });
			await deliveryStore.save({ prune: false });
			await sendMessage(msg);
			await sendNewImagesForRecord(msg, deliveryStore.getByRef(ref), now);
		}
	};

	/**
	 * Handle update-like notifications by sending only newly added images.
	 *
	 * @param {object[]} notifications MsgHub notifications.
	 * @returns {Promise<void>} Resolves after processing.
	 */
	const handleSyncBatch = async notifications => {
		for (const msg of notifications) {
			if (!canDeliver(msg)) {
				continue;
			}
			const ref = typeof msg?.ref === 'string' ? msg.ref.trim() : '';
			if (!ref) {
				continue;
			}
			await sendNewImagesForRecord(msg, deliveryStore.getByRef(ref));
		}
	};

	/**
	 * Remove delivery receipts for deleted or expired messages.
	 *
	 * @param {object[]} notifications MsgHub notifications.
	 * @returns {Promise<void>} Resolves after cleanup.
	 */
	const handleDeleteBatch = async notifications => {
		let changed = false;
		for (const msg of notifications) {
			const ref = typeof msg?.ref === 'string' ? msg.ref.trim() : '';
			if (ref && deliveryStore.removeByRef(ref)) {
				changed = true;
			}
		}
		if (changed) {
			await deliveryStore.save();
		}
	};

	return {
		async start(ctx) {
			ensureInitialized(ctx);
			if (started) {
				return;
			}
			await deliveryStore.ensureObjects();
			await deliveryStore.load();
			started = true;
			log.info('started');

			const gateId = cfg.gateStateId;
			const gateOp = cfg.gateOp;
			const hasCheckin = typeof cfg.gateCheckinText === 'string' && cfg.gateCheckinText.trim();
			const hasCheckout = typeof cfg.gateCheckoutText === 'string' && cfg.gateCheckoutText.trim();

			if (gateId && gateOp) {
				gateOpen = false;
				gateHandle = ctx.meta.gates.register({
					id: gateId,
					op: gateOp,
					value: cfg.gateValue,
					onChange: info => {
						gateOpen = info.open;
					},
					onOpen: hasCheckin
						? info => {
								if (info?.prevOpen === undefined) {
									return;
								}
								return sendGateMessage(cfg.gateCheckinText);
							}
						: null,
					onClose: hasCheckout
						? info => {
								if (info?.prevOpen === undefined) {
									return;
								}
								return sendGateMessage(cfg.gateCheckoutText);
							}
						: null,
					fireOnInit: true,
				});
			} else {
				gateOpen = true;
			}
		},
		stop() {
			try {
				gateHandle?.dispose?.();
			} catch {
				// ignore
			} finally {
				gateHandle = null;
			}
		},
		onNotifications(event, notifications, ctx) {
			ensureInitialized(ctx);
			const events = ctx.api.constants.notfication.events;
			const list = Array.isArray(notifications) ? notifications : [];
			if (list.length === 0) {
				return;
			}

			let task = null;
			if (event === events.due) {
				task = handleDueBatch(list);
			} else if (event === events.update || event === events.recreated || event === events.recovered) {
				task = handleSyncBatch(list);
			} else if (event === events.deleted || event === events.expired) {
				task = handleDeleteBatch(list);
			}
			if (!task) {
				return;
			}
			void task.catch(e => {
				log.warn(`failed: ${e?.message || e}`);
			});
		},
	};
}

module.exports = { NotifyPushover, manifest };
