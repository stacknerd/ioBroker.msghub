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
	let gateHandle = null;
	let gateOpen = null;

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
				'api.templates',
				'api.constants',
				'api.constants.level',
			],
			fn: [
				'api.log.info',
				'api.log.warn',
				'api.i18n.t',
				'api.iobroker.sendTo',
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
		iobroker.sendTo(cfg.pushoverInstance, 'send', payload).catch(e => {
			log.warn(`sendTo failed: ${e?.message || e}`);
		});

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

	const sendImages = msg => {
		const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
		const images = attachments
			.filter(a => a && a.type === 'image')
			.map(a => a.value)
			.filter(isLocalPlainPath);
		const title = i18n?.t('msghub.i18n.NotifyPushover.image.title.label');
		for (const file of images) {
			send({
				message: '📷',
				priority: -1,
				title,
				file,
			});
		}
	};

	const handleBatch = async notifications => {
		for (const msg of notifications) {
			if (!matchFilters(msg)) {
				continue;
			}
			const level = typeof msg.level === 'number' ? msg.level : Number(msg.level);
			const gateBypass = Number.isFinite(level) && level >= cfg.gateBypassFromLevel;
			if (gateOpen === false && !gateBypass) {
				continue;
			}
			await sendMessage(msg);
			sendImages(msg);
		}
	};

	return {
		start(ctx) {
			ensureInitialized(ctx);
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
			if (event !== ctx.api.constants.notfication.events.due) {
				return;
			}
			ensureInitialized(ctx);

			void handleBatch(notifications).catch(e => {
				log.warn(`failed: ${e?.message || e}`);
			});
		},
	};
}

module.exports = { NotifyPushover, manifest };
