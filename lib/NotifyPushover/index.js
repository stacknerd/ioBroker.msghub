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
	let iobroker = null;
	let o = null;
	let cfg = null;

	const ensureInitialized = ctx => {
		if (initialized) {
			return;
		}

		ensureCtxAvailability('NotifyPushover', ctx, {
			plainObject: ['api', 'meta', 'meta.options', 'api.log', 'api.iobroker'],
			fn: ['api.log.info', 'api.log.warn', 'api.iobroker.sendTo', 'api.iobroker.states.getForeignState'],
		});

		log = ctx.api.log;
		iobroker = ctx.api.iobroker;
		o = ctx.meta.options;

		const kinds = new Set(toCsvList(o.resolveString('kindsCsv', options.kindsCsv)).map(s => s.toLowerCase()));
		const states = new Set(
			toCsvList(o.resolveString('lifecycleStatesCsv', options.lifecycleStatesCsv)).map(s => s.toLowerCase()),
		);
		const audienceTagsAny = toCsvList(o.resolveString('audienceTagsAnyCsv', options.audienceTagsAnyCsv));

		cfg = Object.freeze({
			pushoverInstance: o.resolveString('pushoverInstance', options.pushoverInstance),
			kinds,
			levelMin: o.resolveInt('levelMin', options.levelMin),
			levelMax: o.resolveInt('levelMax', options.levelMax),
			lifecycleStates: states,
			audienceTagsAny,
			priorityByLevel: Object.freeze({
				0: o.resolveInt('priorityNone', options.priorityNone),
				10: o.resolveInt('priorityNotice', options.priorityNotice),
				20: o.resolveInt('priorityWarning', options.priorityWarning),
				30: o.resolveInt('priorityError', options.priorityError),
			}),
			iconByLevel: Object.freeze({
				0: o.resolveString('iconNone', options.iconNone),
				10: o.resolveString('iconNotice', options.iconNotice),
				20: o.resolveString('iconWarning', options.iconWarning),
				30: o.resolveString('iconError', options.iconError),
			}),
			gateStateId: o.resolveString('gateStateId', options.gateStateId),
			gateOp: o.resolveString('gateOp', options.gateOp),
			gateValue: o.resolveString('gateValue', options.gateValue),
			gateBypassFromLevel: o.resolveInt('gateBypassFromLevel', options.gateBypassFromLevel),
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
		if (cfg.priorityByLevel[level] === undefined || cfg.iconByLevel[level] === undefined) {
			return false;
		}

		if (cfg.lifecycleStates.size > 0) {
			const st = typeof msg?.lifecycle?.state === 'string' ? msg.lifecycle.state.trim().toLowerCase() : '';
			if (!st || !cfg.lifecycleStates.has(st)) {
				return false;
			}
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

	const evaluateGate = async () => {
		const gateId = cfg.gateStateId;
		const op = cfg.gateOp;
		if (!gateId || !op) {
			return true;
		}

		const st = await iobroker.states
			.getForeignState(gateId)
			.catch(e => log.warn(`NotifyPushover: gate getForeignState failed: ${e?.message || e}`));
		if (!st) {
			return false;
		}

		const val = st.val;
		if (op === 'true') {
			return val === true;
		}
		if (op === 'false') {
			return val === false;
		}

		const cmp = cfg.gateValue;
		if (op === '>' || op === '<') {
			const a = Number(val);
			const b = Number(cmp);
			if (!Number.isFinite(a) || !Number.isFinite(b)) {
				return false;
			}
			return op === '>' ? a > b : a < b;
		}
		if (op === '=') {
			if (!cmp) {
				return false;
			}
			const a = Number(val);
			const b = Number(cmp);
			if (Number.isFinite(a) && Number.isFinite(b)) {
				return a === b;
			}
			return String(val).trim() === cmp;
		}

		return false;
	};

	const send = payload =>
		iobroker.sendTo(cfg.pushoverInstance, 'send', payload).catch(e => {
			log.warn(`NotifyPushover: sendTo failed: ${e?.message || e}`);
		});

	const sendMessage = msg => {
		const level = typeof msg.level === 'number' ? msg.level : Number(msg.level);
		const priority = cfg.priorityByLevel[level];
		const icon = cfg.iconByLevel[level];
		const title = `${icon} ${String(msg.title || '').trim()}`.trim();

		return send({
			message: stripHtmlTags(msg.text),
			sound: 'incoming',
			priority,
			title,
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
		for (const file of images) {
			send({
				message: '📷',
				priority: -1,
				title: 'neues Foto',
				file,
			});
		}
	};

	const handleBatch = async notifications => {
		const gateOk = await evaluateGate();
		for (const msg of notifications) {
			if (!matchFilters(msg)) {
				continue;
			}
			const level = typeof msg.level === 'number' ? msg.level : Number(msg.level);
			const gateBypass = Number.isFinite(level) && level >= cfg.gateBypassFromLevel;
			if (!gateOk && !gateBypass) {
				continue;
			}
			await sendMessage(msg);
			sendImages(msg);
		}
	};

	return {
		start(ctx) {
			ensureInitialized(ctx);
			log.info('NotifyPushover: started');
		},
		onNotifications(event, notifications, ctx) {
			if (event !== 'due') {
				return;
			}
			ensureInitialized(ctx);

			void handleBatch(notifications).catch(e => {
				log.warn(`NotifyPushover: failed: ${e?.message || e}`);
			});
		},
	};
}

module.exports = { NotifyPushover, manifest };
