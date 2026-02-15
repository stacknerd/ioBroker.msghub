/* global window, document, Node, HTMLButtonElement, requestAnimationFrame */
(function () {
	'use strict';

	const win = window;
	let formatTsFormatter = null;

	function isObject(v) {
		return !!v && typeof v === 'object' && !Array.isArray(v);
	}

	function safeStr(v) {
		return typeof v === 'string' ? v : v == null ? '' : String(v);
	}

	function pick(obj, path) {
		const parts = typeof path === 'string' ? path.split('.') : [];
		let cur = obj;
		for (const key of parts) {
			if (!cur || typeof cur !== 'object') {
				return undefined;
			}
			cur = cur[key];
		}
		return cur;
	}

	function formatTs(ts) {
		if (typeof ts !== 'number' || !Number.isFinite(ts)) {
			return '';
		}
		try {
			if (!formatTsFormatter) {
				formatTsFormatter = new Intl.DateTimeFormat(undefined, {
					year: 'numeric',
					month: '2-digit',
					day: '2-digit',
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit',
				});
			}
			return formatTsFormatter.format(new Date(ts));
		} catch {
			return String(ts);
		}
	}

	function initMessagesSection(ctx) {
		const { api, h, elements } = ctx;
		const messagesApi = api?.messages;
		const constantsApi = api?.constants;
		const ui = api?.ui || ctx.ui;
		const root = elements.messagesRoot;
		if (!root) {
			throw new Error('MsghubAdminTabMessages: missing messagesRoot element');
		}

		const AUTO_REFRESH_MS = 15000;

		const t = api.i18n.t;

		let loading = false;
		let silentLoading = false;
		let autoRefresh = true;
		let autoTimer = null;
		let requestSeq = 0;
		let hasLoadedOnce = false;
		let lastError = null;
		let constants = null;
		let items = [];
		let total = 0;
		let pages = 1;
		let lastMeta = null;
		let serverTz = null;

		let pageIndex = 1;
		let pageSize = 50;

		let sortField = 'timing.createdAt';
		let sortDir = 'desc';

		let expertMode = false;
		const selectedRefs = new Set();
		let syncSelectionUI = () => undefined;
		let suppressRowClickUntil = 0;
		let headerSelectAllInput = null;

		const columnFilters = Object.create(null);
		// Default lifecycle filter:
		// acked=true, closed=true, deleted=false, expired=false, open=true, snoozed=true
		setFilterSet('lifecycle.state', new Set(['acked', 'closed', 'open', 'snoozed']));

		const detectExpertMode = () => {
			try {
				const s = win.sessionStorage;
				if (s && typeof s.getItem === 'function') {
					if (s.getItem('App.expertMode') === 'true') {
						return true;
					}
				}
			} catch {
				// ignore
			}
			try {
				const sys = win._system || win.top?._system;
				return !!sys?.expertMode;
			} catch {
				return false;
			}
		};

		const toast = message => {
			try {
				ui?.toast?.(String(message));
			} catch {
				// ignore
			}
		};

		let jsonPre = null;
		function ensureJsonPre() {
			if (jsonPre) {
				return jsonPre;
			}

			// Line-based JSON viewer: allows wrapping after the "key": prefix without horizontal scrolling.
			const pre = h('div', { class: 'msghub-overlay-pre msghub-messages-json' });

			function escapeText(s) {
				return typeof s === 'string' ? s : s == null ? '' : String(s);
			}

			function pad2(n) {
				return String(n).padStart(2, '0');
			}

			function formatLocal(d) {
				try {
					const y = d.getFullYear();
					const m = pad2(d.getMonth() + 1);
					const day = pad2(d.getDate());
					const hh = pad2(d.getHours());
					const mm = pad2(d.getMinutes());
					const ss = pad2(d.getSeconds());
					return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
				} catch {
					return '';
				}
			}

			function formatInTimeZone(d, tz) {
				const tzSafe = typeof tz === 'string' ? tz.trim() : '';
				if (!tzSafe) {
					return '';
				}
				try {
					const fmt = new Intl.DateTimeFormat('sv-SE', {
						timeZone: tzSafe,
						year: 'numeric',
						month: '2-digit',
						day: '2-digit',
						hour: '2-digit',
						minute: '2-digit',
						second: '2-digit',
						hour12: false,
					});
					return String(fmt.format(d)).replace('T', ' ');
				} catch {
					return '';
				}
			}

			function parseTimestampToken(token) {
				if (typeof token !== 'string' || !token) {
					return null;
				}
				if (token.length < 10 || token.length > 17) {
					return null;
				}
				if (!/^\d+$/.test(token)) {
					return null;
				}
				const n = Number(token);
				if (!Number.isFinite(n) || n <= 0) {
					return null;
				}

				// Heuristic: 10 digits => unix seconds, otherwise treat as unix ms.
				const ms = token.length === 10 ? n * 1000 : n;

				// Plausibility window: 2000-01-01 .. 2100-01-01 (keeps false positives low).
				if (ms < 946684800000 || ms > 4102444800000) {
					return null;
				}

				const d = new Date(ms);
				if (Number.isNaN(d.getTime())) {
					return null;
				}
				return { ms, date: d };
			}

			function parseEpochNumber(n) {
				if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
					return null;
				}
				if (Math.trunc(n) !== n) {
					return null;
				}
				const s = String(Math.trunc(n));
				// Heuristic: 10 digits => unix seconds, otherwise treat as unix ms.
				const ms = s.length === 10 ? n * 1000 : n;
				if (ms < 946684800000 || ms > 4102444800000) {
					return null;
				}
				const d = new Date(ms);
				if (Number.isNaN(d.getTime())) {
					return null;
				}
				return { ms, date: d };
			}

			function makeTimestampComment(n) {
				const parsed = parseEpochNumber(n);
				if (!parsed) {
					return '';
				}
				const local = formatLocal(parsed.date);
				const utc = parsed.date.toISOString();
				const server = serverTz ? formatInTimeZone(parsed.date, serverTz) : '';
				if (server) {
					return `${server} (${serverTz}) | ${utc} (UTC)`;
				}
				return `${local} (local) | ${utc} (UTC)`;
			}

			function isDurationKey(key) {
				if (key === 'forMs') {
					return true;
				}
				return typeof key === 'string' && key.endsWith('Ms');
			}

			function formatDurationMs(ms) {
				const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : Number(ms);
				if (!Number.isFinite(n)) {
					return '';
				}
				const sign = n < 0 ? '-' : '';
				let rest = Math.abs(Math.trunc(n));
				const parts = [];
				const day = 24 * 60 * 60 * 1000;
				const hour = 60 * 60 * 1000;
				const min = 60 * 1000;
				const sec = 1000;

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

			function resolveAnnotation(pathParts, key, value) {
				const vNum = typeof value === 'number' && Number.isFinite(value) ? value : null;
				if (vNum === null) {
					return '';
				}
				if (key === 'level') {
					const label = getLevelLabel(vNum);
					if (label && label !== String(vNum)) {
						return label;
					}
				}

				// Timing block: anything not ending in "At" is treated as duration (ms).
				const parts = Array.isArray(pathParts) ? pathParts : [];
				if (parts.length === 1 && parts[0] === 'timing' && typeof key === 'string' && !key.endsWith('At')) {
					const d = formatDurationMs(vNum);
					return d || '';
				}

				// Generic duration keys
				if (isDurationKey(key)) {
					const d = formatDurationMs(vNum);
					return d || '';
				}

				// Otherwise: treat plausible epoch as timestamp
				return makeTimestampComment(vNum);
			}

			function appendSpan(parent, className, text) {
				const el = document.createElement('span');
				if (className) {
					el.className = className;
				}
				el.textContent = escapeText(text);
				parent.appendChild(el);
			}

			function renderAnnotated(value, pathParts = [], indent = 0) {
				const IND = '  ';

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

				const renderValue = (val, p, level, targetEl) => {
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
							renderValue(val[i], p.concat(String(i)), level + 1, line.valueEl);
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
							const [k, v] = entries[i];
							const line = createLine(level + 1);
							appendSpan(line.prefixEl, 'msghub-json-key', JSON.stringify(k));
							appendSpan(line.prefixEl, 'msghub-json-punct', ': ');
							renderValue(v, p.concat(k), level + 1, line.valueEl);

							const comment = resolveAnnotation(p, k, v);
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

				// reset target and render
				pre.replaceChildren();
				const root = createLine(indent);
				renderValue(value, pathParts, indent, root.valueEl);
			}

			function getNumberTokenAtPoint(rootEl, x, y) {
				const doc = rootEl?.ownerDocument || document;

				const pos = doc.caretPositionFromPoint?.(x, y);
				if (pos && pos.offsetNode && typeof pos.offset === 'number') {
					const node = pos.offsetNode;
					if (!node || node.nodeType !== Node.TEXT_NODE || typeof node.textContent !== 'string') {
						return '';
					}
					const text = node.textContent;
					let i = Math.max(0, Math.min(pos.offset, text.length));
					if (i > 0 && i === text.length) {
						i -= 1;
					}

					const isDigit = ch => ch >= '0' && ch <= '9';
					if (!isDigit(text[i]) && i > 0 && isDigit(text[i - 1])) {
						i -= 1;
					}
					if (!isDigit(text[i])) {
						return '';
					}

					let start = i;
					let end = i + 1;
					while (start > 0 && isDigit(text[start - 1])) {
						start -= 1;
					}
					while (end < text.length && isDigit(text[end])) {
						end += 1;
					}
					return text.slice(start, end);
				}

				const range = doc.caretRangeFromPoint?.(x, y);
				const node = range?.startContainer;
				const offset = range?.startOffset;
				if (!node || node.nodeType !== Node.TEXT_NODE || typeof node.textContent !== 'string') {
					return '';
				}
				if (typeof offset !== 'number') {
					return '';
				}
				const text = node.textContent;
				let i = Math.max(0, Math.min(offset, text.length));
				if (i > 0 && i === text.length) {
					i -= 1;
				}
				const isDigit = ch => ch >= '0' && ch <= '9';
				if (!isDigit(text[i]) && i > 0 && isDigit(text[i - 1])) {
					i -= 1;
				}
				if (!isDigit(text[i])) {
					return '';
				}
				let start = i;
				let end = i + 1;
				while (start > 0 && isDigit(text[start - 1])) {
					start -= 1;
				}
				while (end < text.length && isDigit(text[end])) {
					end += 1;
				}
				return text.slice(start, end);
			}

			let lastTooltipToken = '';
			let rafPending = false;
			let pendingEvent = null;

			const applyTooltip = e => {
				rafPending = false;
				const ev = e || pendingEvent;
				pendingEvent = null;
				if (!ev || !ui?.overlayLarge?.isOpen?.()) {
					return;
				}

				const token = getNumberTokenAtPoint(pre, ev.clientX, ev.clientY);
				if (token === lastTooltipToken) {
					return;
				}
				lastTooltipToken = token;

				const parsed = parseTimestampToken(token);
				if (!parsed) {
					pre.removeAttribute('title');
					return;
				}

				const local = parsed.date.toLocaleString();
				const iso = parsed.date.toISOString();
				pre.setAttribute('title', `${local}\n${iso}`);
			};

			pre.addEventListener('mousemove', e => {
				pendingEvent = e;
				if (rafPending) {
					return;
				}
				rafPending = true;
				requestAnimationFrame(() => applyTooltip());
			});
			pre.addEventListener('mouseleave', () => {
				lastTooltipToken = '';
				pendingEvent = null;
				rafPending = false;
				pre.removeAttribute('title');
			});

			pre.__msghubRenderAnnotated = renderAnnotated;

			jsonPre = pre;
			return jsonPre;
		}

		function openMessageJson(msg) {
			const pre = ensureJsonPre();
			try {
				if (typeof pre.__msghubRenderAnnotated === 'function') {
					pre.__msghubRenderAnnotated(msg, [], 0);
				} else {
					pre.textContent = JSON.stringify(msg, null, 2);
				}
			} catch (e) {
				pre.textContent = String(e?.message || e);
			}
			ui?.overlayLarge?.open?.({ title: 'Message JSON', bodyEl: pre });
		}

		async function copyTextToClipboard(text) {
			const s = typeof text === 'string' ? text : text == null ? '' : String(text);
			if (!s) {
				return;
			}
			if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
				await navigator.clipboard.writeText(s);
				return;
			}

			// Fallback: execCommand('copy') using a hidden textarea.
			const ta = document.createElement('textarea');
			ta.value = s;
			ta.setAttribute('readonly', 'true');
			ta.setAttribute('aria-hidden', 'true');
			ta.style.position = 'fixed';
			ta.style.left = '-9999px';
			ta.style.top = '0';
			document.body.appendChild(ta);
			try {
				ta.focus();
				ta.select();
				const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
				if (!ok) {
					throw new Error('Copy not supported');
				}
			} finally {
				try {
					ta.remove();
				} catch {
					// ignore
				}
			}
		}

		function getConstantsEnum(path) {
			const o = constants && typeof constants === 'object' ? pick(constants, path) : null;
			return isObject(o) ? o : null;
		}

		function listEnumValues(enumObj) {
			const vals = [];
			const seen = new Set();
			for (const v of Object.values(enumObj || {})) {
				if (typeof v === 'string' && v.trim()) {
					const s = v.trim();
					if (!seen.has(s)) {
						seen.add(s);
						vals.push(s);
					}
				}
				if (typeof v === 'number' && Number.isFinite(v)) {
					const s = String(v);
					if (!seen.has(s)) {
						seen.add(s);
						vals.push(s);
					}
				}
			}
			return vals;
		}

		function listEnumKeys(enumObj) {
			const keys = [];
			const seen = new Set();
			for (const k of Object.keys(enumObj || {})) {
				if (typeof k === 'string' && k.trim()) {
					const s = k.trim();
					if (!seen.has(s)) {
						seen.add(s);
						keys.push(s);
					}
				}
			}
			return keys;
		}

		function getLevelLabel(level) {
			const map = getConstantsEnum('level');
			if (!map) {
				return typeof level === 'number' && Number.isFinite(level) ? String(level) : '';
			}
			const n = typeof level === 'number' && Number.isFinite(level) ? level : Number(level);
			if (!Number.isFinite(n)) {
				return '';
			}
			for (const [k, v] of Object.entries(map)) {
				if (typeof v === 'number' && Number.isFinite(v) && v === n) {
					return k;
				}
			}
			return String(n);
		}

		function getLevelNumber(label) {
			const map = getConstantsEnum('level');
			if (!map || typeof label !== 'string' || !label.trim()) {
				return Number(label);
			}
			const v = map[label.trim()];
			return typeof v === 'number' && Number.isFinite(v) ? v : Number(label);
		}

		function listDistinctFromItems(path) {
			const out = new Set();
			for (const msg of items) {
				const v = pick(msg, path);
				if (typeof v === 'string' && v.trim()) {
					out.add(v.trim());
				} else if (typeof v === 'number' && Number.isFinite(v)) {
					out.add(String(v));
				}
			}
			return Array.from(out).sort((a, b) => String(a).localeCompare(String(b)));
		}

		function getFilterSet(key) {
			const s = columnFilters[key];
			return s instanceof Set ? s : null;
		}

		function setFilterSet(key, nextSet) {
			columnFilters[key] = nextSet instanceof Set ? nextSet : new Set();
		}

		function buildWhereFromFilters() {
			const where = {};

			const kind = getFilterSet('kind');
			if (kind && kind.size > 0) {
				where.kind = { in: Array.from(kind) };
			}

			const lifecycle = getFilterSet('lifecycle.state');
			if (lifecycle && lifecycle.size > 0) {
				where.lifecycle = { state: { in: Array.from(lifecycle) } };
			} else if (lifecycle && lifecycle.size === 0) {
				const enumStates = getConstantsEnum('lifecycle.state');
				const all =
					enumStates && typeof enumStates === 'object'
						? listEnumValues(enumStates)
						: ['open', 'acked', 'closed', 'snoozed', 'deleted', 'expired'];
				where.lifecycle = { state: { in: all } };
			}

			const level = getFilterSet('level');
			if (level && level.size > 0) {
				where.level = {
					in: Array.from(level)
						.map(x => getLevelNumber(x))
						.filter(n => Number.isFinite(n)),
				};
			}

			const origin = getFilterSet('origin.system');
			if (origin && origin.size > 0) {
				where.origin = { system: { in: Array.from(origin) } };
			}

			const location = getFilterSet('details.location');
			if (location && location.size > 0) {
				where.details = { location: { in: Array.from(location) } };
			}

			return where;
		}

		const renderFilterValueLabel = (filterKey, value) => {
			const raw = safeStr(value);
			if (!raw) {
				return '';
			}
			if (filterKey === 'kind') {
				return api.i18n.tOr(`msghub.i18n.core.admin.common.MsgConstants.kind.${raw.toLowerCase()}.label`, raw);
			}
			if (filterKey === 'level') {
				return api.i18n.tOr(`msghub.i18n.core.admin.common.MsgConstants.level.${raw}.label`, raw);
			}
			if (filterKey === 'lifecycle.state') {
				return api.i18n.tOr(
					`msghub.i18n.core.admin.common.MsgConstants.lifecycle.state.${raw.toLowerCase()}.label`,
					raw,
				);
			}
			return raw;
		};

		const openHeaderSortMenu = (anchor, options) => {
			const field = options && typeof options === 'object' ? options.field : undefined;
			const sortableField = typeof field === 'string' && field.trim() ? field.trim() : '';
			if (!sortableField) {
				return;
			}
			if (!ui?.contextMenu?.open) {
				return;
			}
			const isSorted = sortField === sortableField;
			const applySort = dir => {
				sortField = sortableField;
				sortDir = dir === 'desc' ? 'desc' : 'asc';
				pageIndex = 1;
				updateHeaderButtons?.();
				ui?.contextMenu?.close?.();
				loadMessages({ silent: false }).catch(() => undefined);
			};
			ui.contextMenu.open({
				anchorEl: anchor,
				placement: 'below-start',
				ariaLabel: 'Messages sort menu',
				items: [
					{
						label: t('msghub.i18n.core.admin.ui.messages.filter.sort.asc.action'),
						icon: 'sort-asc',
						primary: isSorted && sortDir === 'asc',
						onSelect: () => applySort('asc'),
					},
					{
						label: t('msghub.i18n.core.admin.ui.messages.filter.sort.desc.action'),
						icon: 'sort-desc',
						primary: isSorted && sortDir === 'desc',
						onSelect: () => applySort('desc'),
					},
				],
			});
		};

		const openHeaderFilterMenu = (anchor, options) => {
			const opts = options && typeof options === 'object' ? options : {};
			const key = opts.key;
			const title = opts.title;
			const optionsList = opts.options;
			const selectedOverride = opts.selected;
			const autoOpenSubmenu = opts.autoOpenSubmenu === true;
			void title;
			const filterKey = typeof key === 'string' ? key : '';
			if (!filterKey) {
				return;
			}
			if (!ui?.contextMenu?.open) {
				return;
			}
			const list = Array.isArray(optionsList) ? optionsList : [];
			const selected =
				selectedOverride instanceof Set ? selectedOverride : new Set(getFilterSet(filterKey) || []);
			const sortableField =
				filterKey === 'kind' ||
				filterKey === 'lifecycle.state' ||
				filterKey === 'level' ||
				filterKey === 'origin.system' ||
				filterKey === 'details.location'
					? filterKey
					: null;

			const applyAndReload = () => {
				setFilterSet(filterKey, new Set(selected));
				pageIndex = 1;
				updateHeaderButtons?.();
				ui?.contextMenu?.close?.();
				loadMessages({ silent: false }).catch(() => undefined);
			};

			const applySort = dir => {
				if (!sortableField) {
					return;
				}
				sortField = sortableField;
				sortDir = dir === 'desc' ? 'desc' : 'asc';
				pageIndex = 1;
				updateHeaderButtons?.();
				ui?.contextMenu?.close?.();
				loadMessages({ silent: false }).catch(() => undefined);
			};

			const submenuId = `messages-filter:${filterKey}`;
			const reopenSubmenu = () =>
				openHeaderFilterMenu(anchor, { key: filterKey, options: list, selected, autoOpenSubmenu: true });

			const filterItems = [];
			for (const v of list) {
				const label = renderFilterValueLabel(filterKey, v) || String(v);
				filterItems.push({
					type: 'checkbox',
					label,
					checked: selected.has(v),
					onToggle: isChecked => {
						if (isChecked) {
							selected.add(v);
						} else {
							selected.delete(v);
						}
					},
				});
			}

			filterItems.push(
				{ type: 'separator' },
				{
					label: t('msghub.i18n.core.admin.ui.messages.filter.selectAll.action'),
					onSelect: () => {
						for (const v of list) {
							selected.add(v);
						}
						reopenSubmenu();
					},
				},
				{
					label: t('msghub.i18n.core.admin.ui.messages.filter.selectNone.action'),
					onSelect: () => {
						selected.clear();
						reopenSubmenu();
					},
				},
				{
					label: t('msghub.i18n.core.admin.ui.messages.filter.apply.action'),
					icon: 'filter',
					primary: true,
					onSelect: applyAndReload,
				},
			);

			const items = [];
			if (sortableField) {
				const isSorted = sortField === sortableField;
				items.push(
					{
						label: t('msghub.i18n.core.admin.ui.messages.filter.sort.asc.action'),
						icon: 'sort-asc',
						primary: isSorted && sortDir === 'asc',
						onSelect: () => applySort('asc'),
					},
					{
						label: t('msghub.i18n.core.admin.ui.messages.filter.sort.desc.action'),
						icon: 'sort-desc',
						primary: isSorted && sortDir === 'desc',
						onSelect: () => applySort('desc'),
					},
					{ type: 'separator' },
				);
			}
			items.push({
				id: submenuId,
				label: t('msghub.i18n.core.admin.ui.messages.filter.submenu.label'),
				primary: selected.size > 0,
				items: filterItems,
			});

			ui.contextMenu.open({
				anchorEl: anchor,
				placement: 'below-start',
				ariaLabel: 'Messages filter menu',
				items,
			});

			if (autoOpenSubmenu) {
				window.setTimeout(() => {
					try {
						const btn = Array.from(document.querySelectorAll('button[role="menuitem"]')).find(
							node =>
								node instanceof HTMLButtonElement && node.dataset?.msghubContextmenuId === submenuId,
						);
						if (btn instanceof HTMLButtonElement) {
							btn.click();
						}
					} catch {
						// ignore
					}
				}, 0);
			}
		};

		function renderTable(itemsToRender) {
			const rows = itemsToRender.map(msg => {
				const title = safeStr(pick(msg, 'title'));
				const text = safeStr(pick(msg, 'text'));
				const location = safeStr(pick(msg, 'details.location'));
				const kind = safeStr(pick(msg, 'kind'));
				const lifecycle = safeStr(pick(msg, 'lifecycle.state'));
				const icon = safeStr(pick(msg, 'icon'));
				const level = pick(msg, 'level');
				const origin = safeStr(pick(msg, 'origin.system')) || safeStr(pick(msg, 'origin.type'));
				const progressPercentage = pick(msg, 'progress.percentage');
				const createdAt = pick(msg, 'timing.createdAt');
				const updatedAt = pick(msg, 'timing.updatedAt');
				const progressValue =
					typeof progressPercentage === 'number' && Number.isFinite(progressPercentage)
						? Math.max(0, Math.min(100, progressPercentage))
						: null;

				const ref = safeStr(pick(msg, 'ref'));
				const isSelected = !!ref && selectedRefs.has(ref);
				const checkboxCell = expertMode
					? h('td', { class: 'msghub-messages-select msghub-colCell msghub-colCell--select' }, [
							h('label', { class: 'msghub-uicheckbox' }, [
								h('input', {
									class: 'msghub-uicheckbox__input',
									type: 'checkbox',
									checked: selectedRefs.has(ref) ? 'true' : null,
									onchange: e => {
										const on = !!e?.target?.checked;
										if (on) {
											selectedRefs.add(ref);
										} else {
											selectedRefs.delete(ref);
										}
										syncSelectionUI();
										updateDeleteButton();
									},
								}),
								h('span', { class: 'msghub-uicheckbox__box', text: '' }),
							]),
						])
					: null;

				const applySelection = mode => {
					if (!ref) {
						return false;
					}

					const alreadySelected = selectedRefs.has(ref);

					if (!expertMode) {
						if (mode === 'contextmenu') {
							// Right-click selects the row (never deselects), to make context menus act on selection.
							if (alreadySelected) {
								return false;
							}
							selectedRefs.clear();
							selectedRefs.add(ref);
							return true;
						}
						if (alreadySelected) {
							selectedRefs.clear();
							return true;
						}
						selectedRefs.clear();
						selectedRefs.add(ref);
						return true;
					}

					if (mode === 'contextmenu') {
						// File-manager-like: right-click selects the row (and clears others) if it wasn't selected yet.
						if (!alreadySelected) {
							selectedRefs.clear();
							selectedRefs.add(ref);
							return true;
						}
						return false;
					}

					// Expert mode click toggles the row (multi-select).
					if (alreadySelected) {
						selectedRefs.delete(ref);
					} else {
						selectedRefs.add(ref);
					}
					return true;
				};

				return h(
					'tr',
					{
						class: isSelected ? 'is-selected' : '',
						'data-ref': ref || '',
						onclick: e => {
							if (!ref) {
								return;
							}
							if (Date.now() < suppressRowClickUntil) {
								return;
							}
							const target = e?.target;
							if (target && typeof target.closest === 'function') {
								if (target.closest('input, button, a, select, textarea, label')) {
									return;
								}
							}

							const didChange = applySelection('click');
							if (!didChange) {
								return;
							}

							syncSelectionUI();
							updateDeleteButton();
						},
						oncontextmenu: e => {
							if (!ref) {
								return;
							}
							const target = e?.target;
							if (target && typeof target.closest === 'function') {
								if (target.closest('input, button, a, select, textarea, label')) {
									return;
								}
							}
							suppressRowClickUntil = Date.now() + 500;
							const didChange = applySelection('contextmenu');
							if (didChange) {
								syncSelectionUI();
								updateDeleteButton();
							}

							if (typeof e?.preventDefault === 'function') {
								e.preventDefault();
							}

							const msgJson = () => {
								try {
									return JSON.stringify(msg, null, 2);
								} catch {
									return String(msg);
								}
							};

							const openArchiveDisabled = true;

							ui?.contextMenu?.open?.({
								anchorPoint: { x: e.clientX, y: e.clientY },
								ariaLabel: 'Message actions',
								placement: 'bottom-start',
								items: [
									{
										id: 'openJson',
										label: t('msghub.i18n.core.admin.ui.messages.contextMenu.openJson.action'),
										icon: 'open-json',
										onSelect: () => openMessageJson(msg),
									},
									{
										id: 'openArchive',
										label: t('msghub.i18n.core.admin.ui.messages.contextMenu.openArchive.action'),
										disabled: openArchiveDisabled,
										icon: 'open-archive',
									},
									{ type: 'separator' },
									{
										id: 'copy',
										label: t('msghub.i18n.core.admin.ui.messages.contextMenu.copy.submenu.label'),
										items: [
											{
												id: 'copyJson',
												label: t(
													'msghub.i18n.core.admin.ui.messages.contextMenu.copyJson.action',
												),
												onSelect: () => copyTextToClipboard(msgJson()),
											},
											{
												id: 'copyRef',
												label: t(
													'msghub.i18n.core.admin.ui.messages.contextMenu.copyRef.action',
												),
												onSelect: () => copyTextToClipboard(ref),
											},
											{
												id: 'copyTitle',
												label: t(
													'msghub.i18n.core.admin.ui.messages.contextMenu.copyTitle.action',
												),
												onSelect: () => copyTextToClipboard(safeStr(pick(msg, 'title'))),
											},
											{
												id: 'copyText',
												label: t(
													'msghub.i18n.core.admin.ui.messages.contextMenu.copyText.action',
												),
												onSelect: () => copyTextToClipboard(safeStr(pick(msg, 'text'))),
											},
										],
									},
								],
							});
						},
						ondblclick: () => {
							openMessageJson(msg);
						},
					},
					[
						...(checkboxCell ? [checkboxCell] : []),
						h('td', { class: 'msghub-colCell msghub-colCell--icon', text: icon }),
						h('td', { class: 'msghub-colCell msghub-colCell--title', text: title, title }),
						h('td', { class: 'msghub-colCell msghub-colCell--text', text: text, title: text }),
						h('td', { class: 'msghub-colCell msghub-colCell--location', text: location }),
						h('td', {
							class: 'msghub-colCell msghub-colCell--kind',
							text: api.i18n.tOr(
								`msghub.i18n.core.admin.common.MsgConstants.kind.${kind.toLowerCase()}.label`,
								kind,
							),
						}),
						h('td', {
							class: 'msghub-colCell msghub-colCell--level',
							text: api.i18n.tOr(
								`msghub.i18n.core.admin.common.MsgConstants.level.${getLevelLabel(level).toLowerCase()}.label`,
								getLevelLabel(level),
							),
						}),
						h('td', {
							class: 'msghub-colCell msghub-colCell--lifecycle',
							text: api.i18n.tOr(
								`msghub.i18n.core.admin.common.MsgConstants.lifecycle.state.${lifecycle.toLowerCase()}.label`,
								lifecycle,
							),
						}),
						h('td', {
							class: 'msghub-muted msghub-colCell msghub-colCell--created',
							text: formatTs(typeof createdAt === 'number' ? createdAt : NaN),
						}),
						h('td', {
							class: 'msghub-muted msghub-colCell msghub-colCell--updated',
							text: formatTs(typeof updatedAt === 'number' ? updatedAt : NaN),
						}),
						h('td', { class: 'msghub-colCell msghub-colCell--origin', text: origin }),
						h(
							'td',
							{ class: 'msghub-colCell msghub-colCell--progress' },
							progressValue === null
								? []
								: [
										h('progress', {
											class: 'msghub-progress-bar',
											max: '100',
											value: String(progressValue),
											title: `${Math.round(progressValue)}%`,
										}),
										h('span', {
											class: 'msghub-progress-value',
											text: `${Math.round(progressValue)}%`,
										}),
									],
						),
					],
				);
			});

			return rows;
		}

		const actions = h('div', { class: 'msghub-actions' });
		const refreshBtn = h('button', { type: 'button', text: 'Refresh' });
		const deleteBtn = h('button', { class: 'msghub-danger', type: 'button', text: 'Delete' });
		const autoBtn = h('button', { type: 'button', text: 'Auto: on' });
		actions.appendChild(refreshBtn);
		actions.appendChild(deleteBtn);
		actions.appendChild(autoBtn);

		const sizeOptions = [10, 25, 50, 100, 250];
		const prevBtn = h('button', { type: 'button', text: 'Prev' });
		const nextBtn = h('button', { type: 'button', text: 'Next' });
		const pageInfoEl = h('div', {
			class: 'msghub-muted',
			text: t('msghub.i18n.core.admin.ui.pagination.pageOf.text', 1, 1),
		});
		const pageSizeSelect = h(
			'select',
			{
				onchange: e => {
					const n = Number(e?.target?.value);
					pageSize = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 50;
					pageIndex = 1;
					loadMessages({ silent: false }).catch(() => undefined);
				},
			},
			sizeOptions.map(n => h('option', { value: String(n), text: String(n) })),
		);

		const paging = h('div', { class: 'msghub-messages-paging' }, [
			prevBtn,
			pageInfoEl,
			nextBtn,
			h('div', { class: 'msghub-field msghub-messages-pagesize' }, [
				h('label', { class: 'msghub-muted', text: 'Items / page' }),
				pageSizeSelect,
			]),
		]);

		const head = h('div', { class: 'msghub-messages-head' }, [actions, paging]);
		const progress = h(
			'div',
			{ class: 'msghub-progress is-hidden' },
			h('div', { class: 'msghub-muted', text: t('msghub.i18n.core.admin.ui.loading.text') }),
		);
		const errorEl = h('div', { class: 'msghub-error is-hidden' });
		const metaEl = h('div', { class: 'msghub-muted msghub-messages-meta' });
		const emptyEl = h('div', {
			class: 'msghub-muted is-hidden',
			text: t('msghub.i18n.core.admin.ui.messages.empty.text'),
		});

		const tableWrap = h('div', { class: 'msghub-table-wrap' });
		const tableEl = h('table', { class: 'msghub-table' });
		const colgroupEl = h('colgroup');
		const theadEl = h('thead');
		const tbodyEl = h('tbody');
		tableEl.appendChild(colgroupEl);
		tableEl.appendChild(theadEl);
		tableEl.appendChild(tbodyEl);
		tableWrap.appendChild(tableEl);

		const headerBtns = Object.create(null);

		const clearHeaderBtns = () => {
			for (const k of Object.keys(headerBtns)) {
				delete headerBtns[k];
			}
		};

		let tableColCount = 11;
		const updateTableColCount = () => {
			tableColCount = expertMode ? 12 : 11;
		};

		const makeSortBtn = (field, title, label) => {
			const btn = h('button', {
				class: 'msghub-th-sort msghub-thBtn msghub-thBtn--sort',
				type: 'button',
				onclick: e => {
					e.preventDefault();
					const anchor = e?.currentTarget?.closest?.('th') || e?.currentTarget || e?.target;
					openHeaderSortMenu(anchor, { field, title });
				},
			});
			btn.appendChild(
				h('span', {
					class: 'msghub-th-icon msghub-th-icon-sort msghub-thIcon msghub-thIcon--sort',
					'aria-hidden': 'true',
				}),
			);
			btn.appendChild(h('span', { class: 'msghub-th-label', text: label }));
			headerBtns[`sort:${field}`] = btn;
			return btn;
		};

		const makeFilterBtn = (key, title, label, getOptions) => {
			const btn = h('button', {
				class: 'msghub-th-filter msghub-thBtn msghub-thBtn--filter',
				type: 'button',
				onclick: e => {
					e.preventDefault();
					const options = typeof getOptions === 'function' ? getOptions() : [];
					const anchor = e?.currentTarget?.closest?.('th') || e?.currentTarget || e?.target;
					openHeaderFilterMenu(anchor, { key, title, options });
				},
			});
			btn.appendChild(
				h('span', {
					class: 'msghub-th-icon msghub-th-icon-sort msghub-thIcon msghub-thIcon--sort',
					'aria-hidden': 'true',
				}),
			);
			btn.appendChild(
				h('span', {
					class: 'msghub-th-icon msghub-th-icon-filter msghub-thIcon msghub-thIcon--filter',
					'aria-hidden': 'true',
				}),
			);
			btn.appendChild(h('span', { class: 'msghub-th-label', text: label }));
			btn.appendChild(h('span', { class: 'msghub-th-badge', text: '' }));
			headerBtns[`filter:${key}`] = btn;
			return btn;
		};

		const renderThead = () => {
			clearHeaderBtns();
			updateTableColCount();
			headerSelectAllInput = null;
			const renderColgroup = () => {
				const cols = [
					...(expertMode ? [{ key: 'select', cls: 'msghub-col--select' }] : []),
					{ key: 'icon', cls: 'msghub-col--icon' },
					{ key: 'title', cls: 'msghub-col--title' },
					{ key: 'text', cls: 'msghub-col--text' },
					{ key: 'location', cls: 'msghub-col--location' },
					{ key: 'kind', cls: 'msghub-col--kind' },
					{ key: 'level', cls: 'msghub-col--level' },
					{ key: 'lifecycle', cls: 'msghub-col--lifecycle' },
					{ key: 'created', cls: 'msghub-col--created' },
					{ key: 'updated', cls: 'msghub-col--updated' },
					{ key: 'origin', cls: 'msghub-col--origin' },
					{ key: 'progress', cls: 'msghub-col--progress' },
				];
				colgroupEl.replaceChildren(
					...cols.map(c => h('col', { class: `msghub-col ${c.cls}`, 'data-msghub-col': c.key })),
				);
			};
			renderColgroup();

			const makeThClickTarget = (btn, colKey) =>
				h(
					'th',
					{
						class: `msghub-th msghub-colCell msghub-colCell--${colKey}`,
						onclick: e => {
							const t = e?.target;
							if (t && btn && typeof btn.contains === 'function' && btn.contains(t)) {
								return;
							}
							btn?.click?.();
						},
					},
					[btn],
				);
			const labelKind = t('msghub.i18n.core.admin.common.MsgConstants.field.kind.label');
			const labelLevel = t('msghub.i18n.core.admin.common.MsgConstants.field.level.label');
			const labelLifecycle = t('msghub.i18n.core.admin.common.MsgConstants.field.lifecycle.state.label');
			const labelIcon = t('msghub.i18n.core.admin.common.MsgConstants.field.icon.label');
			const labelTitle = t('msghub.i18n.core.admin.common.MsgConstants.field.title.label');
			const labelText = t('msghub.i18n.core.admin.common.MsgConstants.field.text.label');
			const labelLocation = t('msghub.i18n.core.admin.common.MsgConstants.field.details.location.label');
			const labelCreated = t('msghub.i18n.core.admin.common.MsgConstants.field.timing.createdAt.label');
			const labelUpdated = t('msghub.i18n.core.admin.common.MsgConstants.field.timing.updatedAt.label');
			const labelOrigin = t('msghub.i18n.core.admin.common.MsgConstants.field.origin.system.label');
			const labelProgress = t('msghub.i18n.core.admin.common.MsgConstants.field.progress.percentage.label');

			const makeSelectAllTh = () => {
				if (!expertMode) {
					return h(
						'th',
						{ class: 'msghub-th msghub-messages-select msghub-colCell msghub-colCell--select' },
						[],
					);
				}
				const input = h('input', {
					type: 'checkbox',
					checked: null,
					onchange: e => {
						e?.preventDefault?.();
						const refs = Array.from(tbodyEl.querySelectorAll('tr[data-ref]'))
							.map(tr => String(tr.getAttribute('data-ref') || '').trim())
							.filter(Boolean);
						const allSelected = refs.length > 0 && refs.every(r => selectedRefs.has(r));
						if (allSelected) {
							for (const r of refs) {
								selectedRefs.delete(r);
							}
						} else {
							for (const r of refs) {
								selectedRefs.add(r);
							}
						}
						syncSelectionUI();
						updateDeleteButton();
					},
				});
				headerSelectAllInput = input;
				return h('th', { class: 'msghub-th msghub-messages-select msghub-colCell msghub-colCell--select' }, [
					input,
				]);
			};

			theadEl.replaceChildren(
				h('tr', null, [
					...(expertMode ? [makeSelectAllTh()] : []),
					makeThClickTarget(makeSortBtn('icon', labelIcon, labelIcon), 'icon'),
					makeThClickTarget(makeSortBtn('title', labelTitle, labelTitle), 'title'),
					makeThClickTarget(makeSortBtn('text', labelText, labelText), 'text'),
					makeThClickTarget(
						makeFilterBtn('details.location', labelLocation, labelLocation, () =>
							listDistinctFromItems('details.location'),
						),
						'location',
					),
					makeThClickTarget(
						makeFilterBtn('kind', labelKind, labelKind, () => listEnumValues(getConstantsEnum('kind'))),
						'kind',
					),
					makeThClickTarget(
						makeFilterBtn('level', labelLevel, labelLevel, () => listEnumKeys(getConstantsEnum('level'))),
						'level',
					),
					makeThClickTarget(
						makeFilterBtn('lifecycle.state', labelLifecycle, labelLifecycle, () =>
							listEnumValues(getConstantsEnum('lifecycle.state')),
						),
						'lifecycle',
					),
					makeThClickTarget(makeSortBtn('timing.createdAt', labelCreated, labelCreated), 'created'),
					makeThClickTarget(makeSortBtn('timing.updatedAt', labelUpdated, labelUpdated), 'updated'),
					makeThClickTarget(
						makeFilterBtn('origin.system', labelOrigin, labelOrigin, () =>
							listDistinctFromItems('origin.system'),
						),
						'origin',
					),
					makeThClickTarget(makeSortBtn('progress.percentage', labelProgress, labelProgress), 'progress'),
				]),
			);
		};

		renderThead();

		root.replaceChildren(head, progress, errorEl, metaEl, tableWrap, emptyEl);

		const updateDeleteButton = () => {
			deleteBtn.classList.toggle('is-hidden', !expertMode);
			if (!expertMode) {
				deleteBtn.disabled = true;
				deleteBtn.textContent = 'Delete';
				return;
			}
			const count = selectedRefs.size;
			deleteBtn.textContent = count > 0 ? `Delete (${count})` : 'Delete';
			deleteBtn.disabled = count === 0 || (loading && !silentLoading);
		};

		const isTabVisible = () => {
			const tab = root.closest('#tab-messages');
			return !document.hidden && !!tab && tab.offsetParent !== null;
		};

		const stopAuto = () => {
			if (autoTimer) {
				clearTimeout(autoTimer);
				autoTimer = null;
			}
		};

		const canAutoRefresh = () => {
			if (!isTabVisible()) {
				return false;
			}
			if (ui?.contextMenu?.isOpen?.()) {
				return false;
			}
			if (ui?.overlayLarge?.isOpen?.()) {
				return false;
			}
			return true;
		};

		const setProgressVisible = isVisible => {
			progress.classList.toggle('is-hidden', !isVisible);
		};

		const updateHeaderButtons = () => {
			const labelLocation = t('msghub.i18n.core.admin.common.MsgConstants.field.details.location.label');
			const labelKind = t('msghub.i18n.core.admin.common.MsgConstants.field.kind.label');
			const labelLifecycle = t('msghub.i18n.core.admin.common.MsgConstants.field.lifecycle.state.label');
			const labelLevel = t('msghub.i18n.core.admin.common.MsgConstants.field.level.label');
			const labelOrigin = t('msghub.i18n.core.admin.common.MsgConstants.field.origin.system.label');

			const locationCount = getFilterSet('details.location')?.size || 0;
			const kindCount = getFilterSet('kind')?.size || 0;
			const lifecycleCount = getFilterSet('lifecycle.state')?.size || 0;
			const levelCount = getFilterSet('level')?.size || 0;
			const originCount = getFilterSet('origin.system')?.size || 0;

			const updateFilterBtn = (field, label, count) => {
				const btn = headerBtns[`filter:${field}`];
				if (!btn) {
					return;
				}
				btn.classList.toggle('is-active', count > 0);
				const labelEl = btn.querySelector('.msghub-th-label');
				if (labelEl) {
					labelEl.textContent = label;
				}
				const badgeEl = btn.querySelector('.msghub-th-badge');
				if (badgeEl) {
					badgeEl.textContent = count > 0 ? String(count) : '';
				}
				if (count > 0) {
					btn.setAttribute('data-filter-count', String(count));
				} else {
					btn.removeAttribute('data-filter-count');
				}
			};

			updateFilterBtn('details.location', labelLocation, locationCount);
			updateFilterBtn('kind', labelKind, kindCount);
			updateFilterBtn('lifecycle.state', labelLifecycle, lifecycleCount);
			updateFilterBtn('level', labelLevel, levelCount);
			updateFilterBtn('origin.system', labelOrigin, originCount);

			const setSortDirAttr = (btn, active) => {
				if (!btn) {
					return;
				}
				if (active) {
					btn.setAttribute('data-sort-dir', sortDir);
				} else {
					btn.removeAttribute('data-sort-dir');
				}
			};

			const updateSortBtn = field => {
				const btn = headerBtns[`sort:${field}`];
				if (!btn) {
					return;
				}
				const active = sortField === field;
				btn.classList.toggle('is-active', active);
				setSortDirAttr(btn, active);
			};

			const updateFilterSortDir = field => {
				const btn = headerBtns[`filter:${field}`];
				setSortDirAttr(btn, sortField === field);
			};

			for (const field of ['kind', 'level', 'lifecycle.state', 'origin.system', 'details.location']) {
				updateFilterSortDir(field);
			}

			for (const field of [
				'icon',
				'title',
				'text',
				'timing.createdAt',
				'timing.updatedAt',
				'progress.percentage',
			]) {
				updateSortBtn(field);
			}
		};

		const updatePaging = () => {
			const p = pages || 1;
			const idx = Math.min(Math.max(1, pageIndex), p);
			pageInfoEl.textContent = t('msghub.i18n.core.admin.ui.pagination.pageOf.text', idx, p);
			prevBtn.disabled = idx <= 1;
			nextBtn.disabled = idx >= p;
			pageSizeSelect.value = String(pageSize);
		};

		const updateButtons = () => {
			refreshBtn.disabled = loading && !silentLoading;
			refreshBtn.classList.toggle('msghub-btn-loading', loading && silentLoading);
			autoBtn.textContent = autoRefresh ? 'Auto: on' : 'Auto: off';
			updateDeleteButton();
		};

		function pruneSelectionToVisibleRows() {
			if (!expertMode) {
				return;
			}
			try {
				const visible = new Set(
					Array.from(tbodyEl.querySelectorAll('tr[data-ref]'))
						.map(tr => String(tr.getAttribute('data-ref') || '').trim())
						.filter(Boolean),
				);
				let changed = false;
				for (const ref of Array.from(selectedRefs)) {
					if (!visible.has(ref)) {
						selectedRefs.delete(ref);
						changed = true;
					}
				}
				if (changed) {
					updateDeleteButton();
				}
			} catch {
				// ignore
			}
		}

		const updateTbody = (rows, { showLoadingRow = false } = {}) => {
			const fragment = document.createDocumentFragment();
			if (showLoadingRow) {
				fragment.appendChild(
					h('tr', null, [
						h('td', {
							class: 'msghub-muted',
							text: t('msghub.i18n.core.admin.ui.loading.text'),
							colspan: String(tableColCount),
						}),
					]),
				);
			} else {
				for (const r of rows || []) {
					fragment.appendChild(r);
				}
			}
			tbodyEl.replaceChildren(fragment);
			pruneSelectionToVisibleRows();
		};

		function updateSelectAllCheckboxState() {
			if (!expertMode || !headerSelectAllInput) {
				return;
			}
			try {
				const refs = Array.from(tbodyEl.querySelectorAll('tr[data-ref]'))
					.map(tr => String(tr.getAttribute('data-ref') || '').trim())
					.filter(Boolean);
				const selectedCount = refs.reduce((sum, r) => sum + (selectedRefs.has(r) ? 1 : 0), 0);
				headerSelectAllInput.indeterminate = selectedCount > 0 && selectedCount < refs.length;
				headerSelectAllInput.checked = refs.length > 0 && selectedCount === refs.length;
			} catch {
				// ignore
			}
		}

		syncSelectionUI = () => {
			try {
				const rows = Array.from(tbodyEl.querySelectorAll('tr'));
				for (const tr of rows) {
					const rowRef = String(tr.getAttribute('data-ref') || '');
					const on = !!rowRef && selectedRefs.has(rowRef);
					tr.classList.toggle('is-selected', on);
					try {
						const input = tr.querySelector('input[type="checkbox"]');
						if (input) {
							input.checked = on;
						}
					} catch {
						// ignore
					}
				}
			} catch {
				// ignore
			}
			updateSelectAllCheckboxState();
		};

		function render({ forceRows = false } = {}) {
			updateButtons();
			updateHeaderButtons();
			updatePaging();

			setProgressVisible(loading && !silentLoading);

			errorEl.textContent = lastError ? String(lastError) : '';
			errorEl.classList.toggle('is-hidden', !lastError);

			const meta = isObject(lastMeta) ? lastMeta : {};
			const generatedAt = formatTs(meta.generatedAt) || 'n/a';
			const tz = typeof meta.tz === 'string' && meta.tz.trim() ? meta.tz.trim() : null;
			serverTz = tz;
			metaEl.replaceChildren(
				h('div', { text: `generatedAt: ${generatedAt}` }),
				h('div', { text: tz ? `tz: ${tz}` : 'tz: n/a' }),
				h('div', { text: `messages: ${items.length} / ${total}` }),
			);

			const showEmpty = !loading && !lastError && items.length === 0;
			emptyEl.classList.toggle('is-hidden', !showEmpty);

			if (!hasLoadedOnce && loading) {
				updateTbody([], { showLoadingRow: true });
				return;
			}

			if (loading && !forceRows) {
				return;
			}

			updateTbody(renderTable(items));
			syncSelectionUI();
		}

		async function loadConstants() {
			try {
				if (!constantsApi?.get) {
					throw new Error('Constants API is not available');
				}
				constants = await constantsApi.get();
				// Canonicalize default lifecycle filter to enum values (if available)
				const enumStates = getConstantsEnum('lifecycle.state');
				if (enumStates) {
					const canonical = ['acked', 'closed', 'open', 'snoozed']
						.map(k => enumStates[k])
						.filter(v => typeof v === 'string' && v.trim());
					if (canonical.length > 0) {
						setFilterSet('lifecycle.state', new Set(canonical));
					}
				}
			} catch {
				constants = null;
			}
		}

		async function loadMessages({ keepPopover = false, silent = false } = {}) {
			void keepPopover;
			const reqId = ++requestSeq;
			loading = true;
			silentLoading = silent === true;
			lastError = null;
			render({ forceRows: !hasLoadedOnce });

			try {
				if (!messagesApi?.query) {
					throw new Error('Messages API is not available');
				}
				const res = await messagesApi.query({
					query: {
						where: buildWhereFromFilters(),
						page: { index: pageIndex, size: pageSize },
						sort: [{ field: sortField, dir: sortDir }],
					},
				});
				if (reqId !== requestSeq) {
					return;
				}
				lastMeta = isObject(res?.meta) ? res.meta : null;
				items = Array.isArray(res?.items) ? res.items : [];
				total =
					typeof res?.total === 'number' && Number.isFinite(res.total)
						? Math.max(0, Math.trunc(res.total))
						: items.length;
				pages =
					typeof res?.pages === 'number' && Number.isFinite(res.pages)
						? Math.max(1, Math.trunc(res.pages))
						: 1;
				pageIndex = Math.min(Math.max(1, pageIndex), pages);
			} catch (e) {
				if (reqId !== requestSeq) {
					return;
				}
				lastError = String(e?.message || e);
				if (!silentLoading) {
					toast(lastError);
				}
			} finally {
				if (reqId === requestSeq) {
					loading = false;
					silentLoading = false;
					hasLoadedOnce = true;
					render({ forceRows: true });
				}
			}
		}

		deleteBtn.addEventListener('click', async e => {
			e.preventDefault();
			if (!expertMode) {
				return;
			}
			const refs = Array.from(selectedRefs);
			if (refs.length === 0) {
				return;
			}
			const text = t('msghub.i18n.core.admin.ui.messages.delete.confirm.text', refs.length);
			const ok = ui?.dialog?.confirm
				? await ui.dialog.confirm({
						title: t('msghub.i18n.core.admin.ui.messages.delete.confirm.title'),
						text,
						danger: true,
						confirmText: t('msghub.i18n.core.admin.ui.action.delete'),
						cancelText: t('msghub.i18n.core.admin.ui.action.cancel'),
					})
				: win.confirm(text);
			if (!ok) {
				return;
			}
			try {
				if (!messagesApi?.delete) {
					throw new Error('Messages API is not available');
				}
				await messagesApi.delete(refs);
				selectedRefs.clear();
				updateDeleteButton();
				await loadMessages({ silent: false });
			} catch (err) {
				toast(String(err?.message || err));
			}
		});

		const applyExpertMode = next => {
			const on = next === true;
			if (expertMode === on) {
				return;
			}
			expertMode = on;
			const tab = root.closest('#tab-messages');
			tab?.classList?.toggle?.('is-expert', expertMode);
			if (!expertMode) {
				selectedRefs.clear();
			}
			renderThead();
			updateDeleteButton();
			render({ forceRows: true });
		};

		applyExpertMode(detectExpertMode());
		win.setInterval(() => applyExpertMode(detectExpertMode()), 1500);

		const scheduleAuto = () => {
			stopAuto();
			if (!autoRefresh) {
				return;
			}
			if (!isTabVisible()) {
				return;
			}
			autoTimer = setTimeout(
				() => {
					autoTimer = null;
					if (autoRefresh && canAutoRefresh()) {
						loadMessages({ keepPopover: true, silent: true }).catch(() => undefined);
					}
					scheduleAuto();
				},
				AUTO_REFRESH_MS + Math.trunc(Math.random() * 1200),
			);
		};

		refreshBtn.addEventListener('click', e => {
			e.preventDefault();
			loadMessages({ silent: false }).catch(() => undefined);
		});
		autoBtn.addEventListener('click', e => {
			e.preventDefault();
			autoRefresh = !autoRefresh;
			updateButtons();
			scheduleAuto();
		});
		prevBtn.addEventListener('click', e => {
			e.preventDefault();
			pageIndex = Math.max(1, pageIndex - 1);
			loadMessages({ silent: false }).catch(() => undefined);
		});
		nextBtn.addEventListener('click', e => {
			e.preventDefault();
			pageIndex = Math.min(pages || 1, pageIndex + 1);
			loadMessages({ silent: false }).catch(() => undefined);
		});
		document.addEventListener('visibilitychange', () => {
			if (autoRefresh && canAutoRefresh()) {
				loadMessages({ keepPopover: true, silent: true }).catch(() => undefined);
			}
			scheduleAuto();
		});

		document.addEventListener('msghub:tabSwitch', e => {
			if (!(e instanceof CustomEvent)) {
				return;
			}
			const from = String(e.detail?.from || '');
			const to = String(e.detail?.to || '');
			if (from === 'tab-messages' && to && to !== 'tab-messages') {
				stopAuto();
				return;
			}
			if (to === 'tab-messages') {
				if (autoRefresh && canAutoRefresh()) {
					loadMessages({ keepPopover: true, silent: true }).catch(() => undefined);
				}
				scheduleAuto();
			}
		});

		updateDeleteButton();
		render();

		return {
			onConnect: async () => {
				await loadConstants();
				await loadMessages({ silent: false });
				scheduleAuto();
				return undefined;
			},
		};
	}

	win.MsghubAdminTabMessages = Object.freeze({
		init: initMessagesSection,
	});
})();
