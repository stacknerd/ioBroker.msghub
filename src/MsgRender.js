'use strict';

/**
 * MsgRender
 * =========
 * Lightweight template renderer that resolves metric placeholders in message fields.
 *
 * Supported template syntax:
 * - {{m.temperature}}         -> "21.7 C" (value + unit)
 * - {{m.temperature.val}}     -> "21.7"
 * - {{m.temperature.unit}}    -> "C"
 * - {{m.temperature.ts}}      -> unix ms timestamp
 *
 * Supported filters:
 * - {{m.temperature|num:1}}   -> number formatting with max fraction digits
 * - {{m.lastSeen|datetime}}   -> localized date/time output
 * - {{m.flag|bool:yes/no}}    -> boolean to string mapping
 * - {{m.foo|default:--}}      -> fallback when empty
 */
class MsgRender {
	/**
	 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter Adapter instance with msgconst and logging.
	 * @param {object} [options] Configuration options.
	 * @param {string} [options.locale] Default locale for number/date formatting.
	 */
	constructor(adapter, { locale = 'en-US' } = {}) {
		if (!adapter) {
			throw new Error('MsgFactory: adapter is required');
		}
		this.adapter = adapter;
		this.locale = locale;

		if (this.adapter?.log?.info) {
			this.adapter.log.info(`MsgRender initialized: locale='${this.locale}'}`);
		}
	}

	/**
	 * Renders a message and attaches a display view without mutating the input.
	 *
	 * @param {object} msg Message object that may contain "metrics" and displayable fields.
	 * @param {object} [options] Render options.
	 * @param {string} [options.locale] Optional locale override for this render call.
	 * @returns {object} New message object with a "display" section added.
	 */
	renderMessage(msg, { locale } = {}) {
		const lc = locale || this.locale;
		if (!msg || typeof msg !== 'object') {
			return msg;
		}

		// Create a view-only "display" section while keeping the original fields intact.
		return {
			...msg,
			display: {
				title: this.renderTemplate(msg.title, { msg, locale: lc }),
				text: this.renderTemplate(msg.text, { msg, locale: lc }),
				details: this.renderDetails(msg.details, { msg, locale: lc }),
			},
		};
	}

	/**
	 * Renders string fields inside details while preserving non-string values.
	 *
	 * @param {object} details Structured details object to render.
	 * @param {object} ctx Context containing the message and locale.
	 * @param {object} ctx.msg Message object used as the template source.
	 * @param {string} ctx.locale Locale used for formatting.
	 * @returns {object} Rendered details object (shallow clone).
	 */
	renderDetails(details, ctx) {
		if (!details || typeof details !== 'object') {
			return details;
		}
		const out = { ...details };
		const fields = ['location', 'task', 'reason'];

		// Render known scalar fields.
		for (const key of fields) {
			if (typeof out[key] === 'string') {
				out[key] = this.renderTemplate(out[key], ctx);
			}
		}

		// Render array entries if they are provided as strings.
		if (Array.isArray(out.tools)) {
			out.tools = out.tools.map(v => this.renderTemplate(v, ctx));
		}
		if (Array.isArray(out.consumables)) {
			out.consumables = out.consumables.map(v => this.renderTemplate(v, ctx));
		}

		return out;
	}

	/**
	 * Renders a template string by resolving {{...}} expressions against metrics.
	 *
	 * @param {string} input Template string.
	 * @param {object} [options] Rendering context options.
	 * @param {object} [options.msg] Message containing the "metrics" Map.
	 * @param {string} [options.locale] Locale override for this render call.
	 * @returns {string} Rendered string with placeholders replaced.
	 */
	renderTemplate(input, { msg, locale } = {}) {
		if (typeof input !== 'string' || input.indexOf('{{') === -1) {
			return input;
		}
		const ctx = {
			metrics: msg && msg.metrics instanceof Map ? msg.metrics : new Map(),
			locale: locale || this.locale,
		};

		// Replace all {{expr}} blocks; unknown values become an empty string.
		return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
			const val = this._evalExpr(expr, ctx);
			return val == null ? '' : String(val);
		});
	}

	/**
	 * Evaluates an expression with optional pipe filters.
	 *
	 * @param {string} expr Expression like "m.temp|num:1|default:--".
	 * @param {object} ctx Render context (metrics + locale).
	 * @returns {any} The evaluated value after all filters are applied.
	 */
	_evalExpr(expr, ctx) {
		const parts = String(expr || '')
			.split('|')
			.map(s => s.trim())
			.filter(Boolean);
		if (parts.length === 0) {
			return '';
		}

		const base = parts.shift();
		if (!base) {
			return '';
		}
		let val = this._resolvePath(base, ctx);

		for (const raw of parts) {
			const idx = raw.indexOf(':');
			const name = idx === -1 ? raw : raw.slice(0, idx).trim();
			const arg = idx === -1 ? undefined : raw.slice(idx + 1).trim();
			val = this._applyFilter(name, arg, val, ctx);
		}

		return val;
	}

	/**
	 * Resolves a template path such as "m.temperature.val".
	 *
	 * @param {string} path Template path.
	 * @param {object} ctx Render context (metrics + locale).
	 * @returns {any} Resolved value or undefined.
	 */
	_resolvePath(path, ctx) {
		const bits = String(path || '').split('.');
		if (bits[0] !== 'm') {
			return undefined;
		}
		return this._resolveMetric(bits.slice(1), ctx);
	}

	/**
	 * Resolves a metric entry by key and optional property.
	 *
	 * @param {string[]} parts Array of [key, prop] (prop is optional).
	 * @param {object} ctx Render context (metrics + locale).
	 * @returns {any} Metric value, unit, timestamp, or formatted string.
	 */
	_resolveMetric([key, prop], ctx) {
		const metrics = ctx.metrics;
		if (!key || !(metrics instanceof Map)) {
			return undefined;
		}
		const entry = metrics.get(key);
		if (!entry || typeof entry !== 'object') {
			return undefined;
		}

		if (!prop) {
			return this._formatMetric(entry, ctx);
		}
		if (prop === 'val') {
			return entry.val;
		}
		if (prop === 'unit') {
			return entry.unit;
		}
		if (prop === 'ts') {
			return entry.ts;
		}
		return undefined;
	}

	/**
	 * Formats a metric as "value unit" with locale-aware number formatting.
	 *
	 * @param {object} entry Metric entry with { val, unit, ts }.
	 * @param {object} ctx Render context (metrics + locale).
	 * @returns {string} Formatted metric string.
	 */
	_formatMetric(entry, ctx) {
		const val = entry.val;
		if (val == null) {
			return '';
		}

		// Numbers get locale formatting, booleans get a stable literal form.
		if (typeof val === 'number') {
			const nf = new Intl.NumberFormat(ctx.locale, { maximumFractionDigits: 2 });
			return `${nf.format(val)} ${entry.unit || ''}`.trim();
		}
		if (typeof val === 'boolean') {
			return val ? 'true' : 'false';
		}
		return `${String(val)} ${entry.unit || ''}`.trim();
	}

	/**
	 * Applies a single filter to a value.
	 *
	 * @param {string} name Filter name (default|num|datetime|bool).
	 * @param {string|undefined} arg Optional filter argument.
	 * @param {any} val Current value to transform.
	 * @param {object} ctx Render context (metrics + locale).
	 * @returns {any} Transformed value.
	 */
	_applyFilter(name, arg, val, ctx) {
		if (name === 'default') {
			return val == null || val === '' ? (arg == null ? '' : arg) : val;
		}
		if (name === 'num') {
			const n = typeof val === 'number' ? val : Number(val);
			if (!Number.isFinite(n)) {
				return val;
			}
			const digits = arg != null ? parseInt(arg, 10) : undefined;
			const nf = new Intl.NumberFormat(
				ctx.locale,
				digits != null && Number.isFinite(digits) ? { maximumFractionDigits: digits } : undefined,
			);
			return nf.format(n);
		}
		if (name === 'datetime') {
			const ts = this._toTimestamp(val);
			if (!Number.isFinite(ts)) {
				return val;
			}
			const df = new Intl.DateTimeFormat(ctx.locale, { dateStyle: 'medium', timeStyle: 'short' });
			return df.format(new Date(ts));
		}
		if (name === 'bool') {
			const [t = 'true', f = 'false'] = String(arg || '').split('/');
			const b = this._toBool(val);
			if (b == null) {
				return val;
			}
			return b ? t : f;
		}
		return val;
	}

	/**
	 * Coerces input into a Unix millisecond timestamp when possible.
	 *
	 * @param {any} val Input to convert.
	 * @returns {number} Unix ms timestamp, or NaN when invalid.
	 */
	_toTimestamp(val) {
		if (typeof val === 'number' && Number.isFinite(val)) {
			return val;
		}
		if (typeof val === 'string' && val.trim()) {
			const n = Number(val);
			if (Number.isFinite(n)) {
				return n;
			}
			const d = Date.parse(val);
			return Number.isFinite(d) ? d : NaN;
		}
		return NaN;
	}

	/**
	 * Coerces common string/number inputs into a boolean.
	 *
	 * @param {any} val Input to convert.
	 * @returns {boolean|null} True/false when recognized, otherwise null.
	 */
	_toBool(val) {
		if (typeof val === 'boolean') {
			return val;
		}
		if (typeof val === 'number') {
			return val !== 0;
		}
		if (typeof val === 'string') {
			const v = val.trim().toLowerCase();
			if (v === 'true' || v === '1' || v === 'yes' || v === 'y') {
				return true;
			}
			if (v === 'false' || v === '0' || v === 'no' || v === 'n') {
				return false;
			}
		}
		return null;
	}
}

module.exports = { MsgRender };
