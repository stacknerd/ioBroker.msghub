/* global window, document */
(function () {
	'use strict';

	const win = window;

	/**
	 * JSON overlay module for messages panel.
	 *
	 * Contains:
	 * - Annotated JSON renderer for message payloads.
	 * - Timestamp/duration helper comments.
	 * - Timestamp comments in large overlay view.
	 *
	 * Integration:
	 * - Uses `ctx.api.ui.overlayLarge`.
	 * - Created by `index.js` and consumed by table/menu modules.
	 *
	 * Public API:
	 * - `createJsonOverlay(options)` -> `openMessageJson(message)`.
	 */

	/**
	 * Creates the JSON overlay controller for one panel instance.
	 *
	 * @param {object} options - Factory options.
	 * @param {object} options.ui - UI API (`ctx.api.ui`).
	 * @param {Function} options.getServerTimeZone - Getter for server timezone.
	 * @param {Function} options.formatDate - Shared timezone-aware date formatter.
	 * @param {Function} options.getLevelLabel - Resolver for numeric level labels.
	 * @returns {{openMessageJson: Function}} JSON overlay controller.
	 */
	function createJsonOverlay(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const ui = opts.ui;
		const getServerTimeZone = typeof opts.getServerTimeZone === 'function' ? opts.getServerTimeZone : () => '';
		const formatDate = typeof opts.formatDate === 'function' ? opts.formatDate : () => '';
		const getLevelLabel = typeof opts.getLevelLabel === 'function' ? opts.getLevelLabel : value => String(value);

		let jsonPre = null;
		let renderAnnotatedFn = null;

		/**
		 * Creates (lazy) overlay body element and renderer internals.
		 *
		 * @returns {HTMLElement} Overlay body element.
		 */
		function ensureJsonPre() {
			if (jsonPre) {
				return jsonPre;
			}

			// Line-based rendering allows wrapping after key prefixes.
			const pre = document.createElement('div');
			pre.className = 'msghub-overlay-pre msghub-messages-json';

			/**
			 * Safely converts value to string.
			 *
			 * @param {any} value - Input value.
			 * @returns {string} Safe string.
			 */
			function escapeText(value) {
				return typeof value === 'string' ? value : value == null ? '' : String(value);
			}

			/**
			 * Formats date in a specific IANA timezone.
			 *
			 * @param {Date} date - Date object.
			 * @param {string} timeZone - IANA timezone string.
			 * @returns {string} Formatted text.
			 */
			function formatInTimeZone(date, timeZone) {
				const tz = typeof timeZone === 'string' ? timeZone.trim() : '';
				if (!tz) {
					return '';
				}
				try {
					const fmt = new Intl.DateTimeFormat('sv-SE', {
						timeZone: tz,
						year: 'numeric',
						month: '2-digit',
						day: '2-digit',
						hour: '2-digit',
						minute: '2-digit',
						second: '2-digit',
						hour12: false,
					});
					return String(fmt.format(date)).replace('T', ' ');
				} catch {
					return '';
				}
			}

			/**
			 * Parses numeric epoch candidate.
			 *
			 * @param {number} value - Numeric value.
			 * @returns {{ms:number,date:Date}|null} Parsed result.
			 */
			function parseEpochNumber(value) {
				if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
					return null;
				}
				if (Math.trunc(value) !== value) {
					return null;
				}
				const token = String(Math.trunc(value));
				const ms = token.length === 10 ? value * 1000 : value;
				if (ms < 946684800000 || ms > 4102444800000) {
					return null;
				}
				const date = new Date(ms);
				if (Number.isNaN(date.getTime())) {
					return null;
				}
				return { ms, date };
			}

			/**
			 * Builds timestamp comment text.
			 *
			 * @param {number} value - Numeric epoch value.
			 * @returns {string} Comment string.
			 */
			function makeTimestampComment(value) {
				const parsed = parseEpochNumber(value);
				if (!parsed) {
					return '';
				}
				const utc = parsed.date.toISOString();
				const serverTimeZone = String(getServerTimeZone() || '').trim() || 'UTC';
				const server = formatInTimeZone(parsed.date, serverTimeZone) || formatDate(parsed.date);
				if (server) {
					return `${server} (${serverTimeZone}) | ${utc} (UTC)`;
				}
				return `${utc} (UTC)`;
			}

			/**
			 * Checks whether key semantically represents duration in milliseconds.
			 *
			 * @param {string} key - Property key.
			 * @returns {boolean} True for duration-like keys.
			 */
			function isDurationKey(key) {
				if (key === 'forMs') {
					return true;
				}
				return typeof key === 'string' && key.endsWith('Ms');
			}

			/**
			 * Formats milliseconds into a compact duration string.
			 *
			 * @param {number|string} value - Millisecond value.
			 * @returns {string} Formatted duration.
			 */
			function formatDurationMs(value) {
				const num = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
				if (!Number.isFinite(num)) {
					return '';
				}
				const sign = num < 0 ? '-' : '';
				let rest = Math.abs(Math.trunc(num));
				const day = 24 * 60 * 60 * 1000;
				const hour = 60 * 60 * 1000;
				const min = 60 * 1000;
				const sec = 1000;
				const parts = [];

				const d = Math.floor(rest / day);
				if (d) {
					parts.push(`${d}d`);
					rest -= d * day;
				}
				const h = Math.floor(rest / hour);
				if (h) {
					parts.push(`${h}h`);
					rest -= h * hour;
				}
				const m = Math.floor(rest / min);
				if (m) {
					parts.push(`${m}min`);
					rest -= m * min;
				}
				const s = Math.floor(rest / sec);
				if (s) {
					parts.push(`${s}s`);
					rest -= s * sec;
				}
				if (!parts.length) {
					parts.push(`${rest}ms`);
				}
				return `${sign}${parts.join(' ')}`;
			}

			/**
			 * Resolves annotation string for numeric values.
			 *
			 * @param {string[]} pathParts - Parent path segments.
			 * @param {string} key - Current property key.
			 * @param {any} value - Current property value.
			 * @returns {string} Annotation text.
			 */
			function resolveAnnotation(pathParts, key, value) {
				const num = typeof value === 'number' && Number.isFinite(value) ? value : null;
				if (num === null) {
					return '';
				}
				if (key === 'level') {
					const label = getLevelLabel(num);
					if (label && label !== String(num)) {
						return label;
					}
				}
				const parts = Array.isArray(pathParts) ? pathParts : [];
				if (parts.length === 1 && parts[0] === 'timing' && typeof key === 'string' && !key.endsWith('At')) {
					return formatDurationMs(num) || '';
				}
				if (isDurationKey(key)) {
					return formatDurationMs(num) || '';
				}
				return makeTimestampComment(num);
			}

			/**
			 * Appends one styled span.
			 *
			 * @param {HTMLElement} parent - Parent element.
			 * @param {string} className - CSS class.
			 * @param {string} text - Text content.
			 */
			function appendSpan(parent, className, text) {
				const el = document.createElement('span');
				if (className) {
					el.className = className;
				}
				el.textContent = escapeText(text);
				parent.appendChild(el);
			}

			/**
			 * Renders value as annotated JSON into overlay body.
			 *
			 * @param {any} value - Root value.
			 * @param {string[]} [pathParts] - Path parts.
			 * @param {number} [indent] - Base indent.
			 */
			function renderAnnotated(value, pathParts = [], indent = 0) {
				const IND = '  ';

				/**
				 * Creates one output line.
				 *
				 * @param {number} level - Indent level.
				 * @returns {{prefixEl:HTMLElement,valueEl:HTMLElement}} Line slots.
				 */
				const createLine = level => {
					const lineEl = document.createElement('div');
					lineEl.className = 'msghub-json-line';
					const prefixEl = document.createElement('span');
					prefixEl.className = 'msghub-json-prefix';
					const valueEl = document.createElement('span');
					valueEl.className = 'msghub-json-value';
					prefixEl.appendChild(document.createTextNode(IND.repeat(level)));
					lineEl.appendChild(prefixEl);
					lineEl.appendChild(valueEl);
					pre.appendChild(lineEl);
					return { prefixEl, valueEl };
				};

				/**
				 * Recursively renders JSON value.
				 *
				 * @param {any} val - Current value.
				 * @param {string[]} currentPath - Current path.
				 * @param {number} level - Indent level.
				 * @param {HTMLElement} targetEl - Target value element.
				 */
				const renderValue = (val, currentPath, level, targetEl) => {
					if (val === null) {
						appendSpan(targetEl, 'msghub-json-null', 'null');
						return;
					}
					if (typeof val === 'string') {
						appendSpan(targetEl, 'msghub-json-string', JSON.stringify(val));
						return;
					}
					if (typeof val === 'number') {
						appendSpan(targetEl, 'msghub-json-number', String(val));
						return;
					}
					if (typeof val === 'boolean') {
						appendSpan(targetEl, 'msghub-json-bool', val ? 'true' : 'false');
						return;
					}
					if (Array.isArray(val)) {
						if (val.length === 0) {
							appendSpan(targetEl, 'msghub-json-punct', '[]');
							return;
						}
						appendSpan(targetEl, 'msghub-json-punct', '[');
						for (let i = 0; i < val.length; i++) {
							const line = createLine(level + 1);
							renderValue(val[i], currentPath.concat(String(i)), level + 1, line.valueEl);
							if (i < val.length - 1) {
								appendSpan(line.valueEl, 'msghub-json-punct', ',');
							}
						}
						const closeLine = createLine(level);
						appendSpan(closeLine.valueEl, 'msghub-json-punct', ']');
						return;
					}
					if (val && typeof val === 'object') {
						const entries = Object.entries(val);
						if (entries.length === 0) {
							appendSpan(targetEl, 'msghub-json-punct', '{}');
							return;
						}
						appendSpan(targetEl, 'msghub-json-punct', '{');
						for (let i = 0; i < entries.length; i++) {
							const [key, nested] = entries[i];
							const line = createLine(level + 1);
							appendSpan(line.prefixEl, 'msghub-json-key', JSON.stringify(key));
							appendSpan(line.prefixEl, 'msghub-json-punct', ': ');
							renderValue(nested, currentPath.concat(key), level + 1, line.valueEl);
							const comment = resolveAnnotation(currentPath, key, nested);
							if (i < entries.length - 1) {
								appendSpan(line.valueEl, 'msghub-json-punct', ',');
							}
							if (comment) {
								appendSpan(line.valueEl, 'msghub-json-comment', ` // ${comment}`);
							}
						}
						const closeLine = createLine(level);
						appendSpan(closeLine.valueEl, 'msghub-json-punct', '}');
						return;
					}
					appendSpan(targetEl, 'msghub-json-null', JSON.stringify(val));
				};

				pre.replaceChildren();
				const root = createLine(indent);
				renderValue(value, pathParts, indent, root.valueEl);
			}

			renderAnnotatedFn = renderAnnotated;
			jsonPre = pre;
			return jsonPre;
		}

		/**
		 * Opens the large JSON overlay for one message.
		 *
		 * @param {any} msg - Message payload.
		 */
		function openMessageJson(msg) {
			const pre = ensureJsonPre();
			try {
				if (typeof renderAnnotatedFn === 'function') {
					renderAnnotatedFn(msg, [], 0);
				} else {
					pre.textContent = JSON.stringify(msg, null, 2);
				}
			} catch (e) {
				pre.textContent = String(e?.message || e);
			}
			ui?.overlayLarge?.open?.({
				title: 'Message JSON',
				bodyEl: pre,
			});
		}

		return Object.freeze({ openMessageJson });
	}

	win.MsghubAdminTabMessagesOverlayJson = Object.freeze({
		createJsonOverlay,
	});
})();
