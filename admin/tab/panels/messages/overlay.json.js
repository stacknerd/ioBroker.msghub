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
	 * Action types that are executed in core (ack/close/delete/snooze).
	 * open/custom remain intentional no-ops in core and are excluded from action
	 * execution buttons. `link` is handled separately as frontend-only navigation.
	 */
	const CORE_ACTION_TYPES = new Set(['ack', 'close', 'delete', 'snooze']);

	/**
	 * Maps action type to its common admin i18n label key.
	 * Used to translate action button text in the JSON overlay.
	 */
	const ACTION_LABEL_KEYS = Object.freeze({
		ack: 'msghub.i18n.core.admin.common.action.ack.label',
		close: 'msghub.i18n.core.admin.common.action.close.label',
		delete: 'msghub.i18n.core.admin.common.action.delete.label',
		link: 'msghub.i18n.core.admin.common.action.link.label',
		snooze: 'msghub.i18n.core.admin.common.action.snooze.label',
	});

	/**
	 * Creates the JSON overlay controller for one panel instance.
	 *
	 * @param {object} options - Factory options.
	 * @param {object} options.ui - UI API (`ctx.api.ui`).
	 * @param {Function} options.t - I18n translation function.
	 * @param {Function} options.getServerTimeZone - Getter for server timezone.
	 * @param {Function} options.formatDate - Shared timezone-aware date formatter.
	 * @param {Function} options.getLevelLabel - Resolver for numeric level labels.
	 * @param {Function} [options.onActionExecute] - Callback for action execution: (ref, actionId, actionType) => void.
	 * @param {Function} [options.onLinkOpen] - Callback for link navigation: (url) => void.
	 * @returns {{openMessageJson: Function}} JSON overlay controller.
	 */
	function createJsonOverlay(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const ui = opts.ui;
		const t = typeof opts.t === 'function' ? opts.t : key => String(key);
		const getServerTimeZone = typeof opts.getServerTimeZone === 'function' ? opts.getServerTimeZone : () => '';
		const formatDate = typeof opts.formatDate === 'function' ? opts.formatDate : () => '';
		const getLevelLabel = typeof opts.getLevelLabel === 'function' ? opts.getLevelLabel : value => String(value);
		const openCopyContextMenu =
			typeof opts.openCopyContextMenu === 'function' ? opts.openCopyContextMenu : () => undefined;
		const onActionExecute = typeof opts.onActionExecute === 'function' ? opts.onActionExecute : null;
		const onLinkOpen = typeof opts.onLinkOpen === 'function' ? opts.onLinkOpen : null;

		let jsonPre = null;
		let renderAnnotatedFn = null;
		let currentMessage = null;

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
			pre.addEventListener('contextmenu', event => {
				if (event?.ctrlKey === true) {
					return;
				}
				if (!currentMessage || typeof currentMessage !== 'object') {
					return;
				}
				openCopyContextMenu(event, currentMessage);
			});

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
			 * Formats serialized JSON strings for display line breaks.
			 *
			 * Keeps the visible `\n` token and inserts a real newline character
			 * afterwards so CSS `white-space: pre-wrap` renders a line break.
			 *
			 * @param {string} value - Raw string value.
			 * @returns {string} Display string for overlay rendering.
			 */
			function formatStringLiteralForDisplay(value) {
				const serialized = JSON.stringify(value);
				return serialized.replace(/\\n/g, '\\n\n');
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
				 * @returns {{prefixEl:HTMLElement,valueEl:HTMLElement,lineEl:HTMLElement}} Line slots.
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
					return { prefixEl, valueEl, lineEl };
				};

				/**
				 * Returns true when a value is a core-executable action item.
				 * Only ack/close/delete/snooze get execute buttons; open/custom are
				 * core no-ops and excluded, while link is handled separately.
				 *
				 * @param {any} val - Candidate value.
				 * @returns {boolean} True when val is a core action object.
				 */
				const isCoreActionItem = val => {
					if (!val || typeof val !== 'object' || Array.isArray(val)) {
						return false;
					}
					const id = typeof val.id === 'string' ? val.id.trim() : '';
					const type = typeof val.type === 'string' ? val.type.trim() : '';
					return id !== '' && CORE_ACTION_TYPES.has(type);
				};

				/**
				 * Creates a dedicated button line and inserts it before the closing brace
				 * of the current action item object. The line is styled as a JSON comment
				 * so the button reads as an inline annotation (comment-style colour).
				 *
				 * @param {number} level - Indent level matching the action item's properties.
				 * @returns {HTMLElement} The line element; caller appends the button to it.
				 */
				const createButtonLine = level => {
					const lineEl = document.createElement('div');
					lineEl.className = 'msghub-json-line';
					const prefixEl = document.createElement('span');
					prefixEl.className = 'msghub-json-prefix';
					prefixEl.appendChild(document.createTextNode(IND.repeat(level)));
					const commentEl = document.createElement('span');
					commentEl.className = 'msghub-json-comment';
					commentEl.appendChild(document.createTextNode('// '));
					lineEl.appendChild(prefixEl);
					lineEl.appendChild(commentEl);
					// Insert before the last child of pre (the closing '}' of the action item).
					const lastChild = pre.children[pre.children.length - 1];
					if (lastChild) {
						pre.insertBefore(lineEl, lastChild);
					} else {
						pre.appendChild(lineEl);
					}
					return lineEl;
				};

				/**
				 * Inserts a dedicated action execution button line before the closing brace
				 * of the current action item object.
				 *
				 * @param {string} actionId - Action id.
				 * @param {string} actionType - Action type (used as button label).
				 * @param {boolean} disabled - Whether the button is disabled (blocked action).
				 * @param {number} level - Indent level matching the action item's properties.
				 */
				const appendActionButton = (actionId, actionType, disabled, level) => {
					const lineEl = createButtonLine(level);
					const btn = document.createElement('button');
					btn.className = 'msghub-uibutton-iconandtext msghub-json-action-btn';
					btn.textContent = t(ACTION_LABEL_KEYS[actionType] || actionType);
					btn.setAttribute('aria-label', 'Execute action');
					if (disabled) {
						btn.disabled = true;
					} else if (onActionExecute) {
						btn.addEventListener('click', () => {
							const ref =
								currentMessage && typeof currentMessage.ref === 'string' ? currentMessage.ref : '';
							onActionExecute(ref, actionId, actionType);
						});
					}
					lineEl.appendChild(btn);
				};

				/**
				 * Extracts URL from a link action payload, trying url → href → link keys in order.
				 *
				 * @param {any} payload - Action payload.
				 * @returns {string} Extracted URL or empty string.
				 */
				const extractLinkUrl = payload => {
					if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
						return '';
					}
					for (const key of ['url', 'href', 'link']) {
						const v = payload[key];
						if (typeof v === 'string' && v.trim()) {
							return v.trim();
						}
					}
					return '';
				};

				/**
				 * Returns true only for http:// or https:// URLs.
				 *
				 * @param {string} url - URL to check.
				 * @returns {boolean} True when url starts with http:// or https://.
				 */
				const isHttpUrl = url =>
					typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));

				/**
				 * Returns true when val is a link action item with a usable http[s] URL.
				 *
				 * @param {any} val - Candidate value.
				 * @returns {boolean} True when val is a link action with a valid http[s] URL.
				 */
				const isLinkActionItem = val => {
					if (!val || typeof val !== 'object' || Array.isArray(val)) {
						return false;
					}
					const type = typeof val.type === 'string' ? val.type.trim() : '';
					if (type !== 'link') {
						return false;
					}
					return isHttpUrl(extractLinkUrl(val.payload));
				};

				/**
				 * Inserts a dedicated navigation button line before the closing brace
				 * of the current link action item object.
				 * Calls onLinkOpen(url) directly — no confirm dialog, no backend call.
				 *
				 * @param {any} payload - Action payload containing the URL.
				 * @param {number} level - Indent level matching the action item's properties.
				 */
				const appendLinkButton = (payload, level) => {
					const url = extractLinkUrl(payload);
					if (!isHttpUrl(url) || !onLinkOpen) {
						return;
					}
					const lineEl = createButtonLine(level);
					const btn = document.createElement('button');
					btn.className = 'msghub-uibutton-iconandtext msghub-json-action-btn';
					// Use payload.label when present; fall back to i18n key.
					const labelText =
						payload && typeof payload.label === 'string' && payload.label.trim()
							? payload.label.trim()
							: t(ACTION_LABEL_KEYS.link);
					btn.textContent = labelText;
					btn.setAttribute('aria-label', 'Open link');
					btn.addEventListener('click', () => onLinkOpen(url));
					lineEl.appendChild(btn);
				};

				/**
				 * Recursively renders JSON value.
				 *
				 * Returns the trailing value slot so callers can append commas to the
				 * line that actually ends the rendered value (`}` / `]` for nested
				 * objects and arrays).
				 *
				 * @param {any} val - Current value.
				 * @param {string[]} currentPath - Current path.
				 * @param {number} level - Indent level.
				 * @param {HTMLElement} targetEl - Target value element.
				 * @returns {{tailValueEl: HTMLElement}} Trailing render slot.
				 */
				const renderValue = (val, currentPath, level, targetEl) => {
					if (val === null) {
						appendSpan(targetEl, 'msghub-json-null', 'null');
						return { tailValueEl: targetEl };
					}
					if (typeof val === 'string') {
						appendSpan(targetEl, 'msghub-json-string', formatStringLiteralForDisplay(val));
						return { tailValueEl: targetEl };
					}
					if (typeof val === 'number') {
						appendSpan(targetEl, 'msghub-json-number', String(val));
						return { tailValueEl: targetEl };
					}
					if (typeof val === 'boolean') {
						appendSpan(targetEl, 'msghub-json-bool', val ? 'true' : 'false');
						return { tailValueEl: targetEl };
					}
					if (Array.isArray(val)) {
						if (val.length === 0) {
							appendSpan(targetEl, 'msghub-json-punct', '[]');
							return { tailValueEl: targetEl };
						}
						appendSpan(targetEl, 'msghub-json-punct', '[');
						// Detect actions/actionsInactive arrays at root level for action buttons.
						const isActionsArray =
							currentPath.length === 1 &&
							(currentPath[0] === 'actions' || currentPath[0] === 'actionsInactive');
						const isInactiveArray = isActionsArray && currentPath[0] === 'actionsInactive';
						for (let i = 0; i < val.length; i++) {
							const line = createLine(level + 1);
							const rendered = renderValue(
								val[i],
								currentPath.concat(String(i)),
								level + 1,
								line.valueEl,
							);
							if (i < val.length - 1) {
								appendSpan(rendered.tailValueEl, 'msghub-json-punct', ',');
							}
							if (isActionsArray && isCoreActionItem(val[i])) {
								appendActionButton(val[i].id, val[i].type, isInactiveArray, level + 2);
							}
							if (isActionsArray && !isInactiveArray && isLinkActionItem(val[i])) {
								appendLinkButton(val[i].payload, level + 2);
							}
						}
						const closeLine = createLine(level);
						appendSpan(closeLine.valueEl, 'msghub-json-punct', ']');
						return { tailValueEl: closeLine.valueEl };
					}
					if (val && typeof val === 'object') {
						const entries = Object.entries(val);
						if (entries.length === 0) {
							appendSpan(targetEl, 'msghub-json-punct', '{}');
							return { tailValueEl: targetEl };
						}
						appendSpan(targetEl, 'msghub-json-punct', '{');
						for (let i = 0; i < entries.length; i++) {
							const [key, nested] = entries[i];
							const line = createLine(level + 1);
							appendSpan(line.prefixEl, 'msghub-json-key', JSON.stringify(key));
							appendSpan(line.prefixEl, 'msghub-json-punct', ': ');
							const rendered = renderValue(nested, currentPath.concat(key), level + 1, line.valueEl);
							const comment = resolveAnnotation(currentPath, key, nested);
							if (i < entries.length - 1) {
								appendSpan(rendered.tailValueEl, 'msghub-json-punct', ',');
							}
							if (comment) {
								appendSpan(line.valueEl, 'msghub-json-comment', ` // ${comment}`);
							}
						}
						const closeLine = createLine(level);
						appendSpan(closeLine.valueEl, 'msghub-json-punct', '}');
						return { tailValueEl: closeLine.valueEl };
					}
					appendSpan(targetEl, 'msghub-json-null', JSON.stringify(val));
					return { tailValueEl: targetEl };
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
			currentMessage = msg && typeof msg === 'object' ? msg : null;
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
				title: t('msghub.i18n.core.admin.ui.messages.overlay.json.title'),
				bodyEl: pre,
			});
		}

		return Object.freeze({ openMessageJson });
	}

	win.MsghubAdminTabMessagesOverlayJson = Object.freeze({
		createJsonOverlay,
	});
})();
