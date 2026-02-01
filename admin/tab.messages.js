/* global window, document */
(function () {
	'use strict';

	/** @type {any} */
	const win = /** @type {any} */ (window);

	function isObject(v) {
		return !!v && typeof v === 'object' && !Array.isArray(v);
	}

	function safeStr(v) {
		return typeof v === 'string' ? v : v == null ? '' : String(v);
	}

	function truncateStr(s, maxLen) {
		const str = safeStr(s);
		const n = Number(maxLen);
		if (!Number.isFinite(n) || n <= 0) {
			return '';
		}
		return str.length > n ? `${str.slice(0, n)}[...]` : str;
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
			return new Date(ts).toLocaleString();
		} catch (_err) {
			return String(ts);
		}
	}

		function initMessagesSection(ctx) {
			const { sendTo, h, elements, ui } = ctx;
			const root = elements.messagesRoot;
			if (!root) {
				throw new Error('MsghubAdminTabMessages: missing messagesRoot element');
			}

			const AUTO_REFRESH_MS = 15000;

			const t = (en, de) => {
				const lang = typeof ctx?.lang === 'string' ? ctx.lang : '';
				return lang.toLowerCase().startsWith('de') ? de : en;
			};

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

			/** @type {Record<string, Set<string>>} */
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
				} catch (_err) {
					// ignore
				}
				try {
					const sys = win._system || win.top?._system;
					return !!sys?.expertMode;
				} catch (_err) {
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

			const pre = h('pre', { class: 'msghub-overlay-pre msghub-messages-json' });

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
				} catch (_e) {
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
				} catch (_e) {
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

					const renderValue = (val, p, level, isInline) => {
						if (val === null) {
							appendSpan(pre, 'msghub-json-null', 'null');
							return;
						}
						if (typeof val === 'string') {
							appendSpan(pre, 'msghub-json-string', JSON.stringify(val));
							return;
						}
						if (typeof val === 'number') {
							appendSpan(pre, 'msghub-json-number', String(val));
							return;
						}
						if (typeof val === 'boolean') {
							appendSpan(pre, 'msghub-json-bool', val ? 'true' : 'false');
							return;
						}
						if (Array.isArray(val)) {
							if (val.length === 0) {
								appendSpan(pre, 'msghub-json-punct', '[]');
								return;
							}
							appendSpan(pre, 'msghub-json-punct', '[');
							appendSpan(pre, '', '\n');
							for (let i = 0; i < val.length; i++) {
								appendSpan(pre, '', IND.repeat(level + 1));
								renderValue(val[i], p.concat(String(i)), level + 1, false);
								if (i < val.length - 1) {
									appendSpan(pre, 'msghub-json-punct', ',');
								}
								appendSpan(pre, '', '\n');
							}
							appendSpan(pre, '', IND.repeat(level));
							appendSpan(pre, 'msghub-json-punct', ']');
							return;
						}
						if (val && typeof val === 'object') {
							const entries = Object.entries(val);
							if (entries.length === 0) {
								appendSpan(pre, 'msghub-json-punct', '{}');
								return;
							}
							appendSpan(pre, 'msghub-json-punct', '{');
							appendSpan(pre, '', '\n');
							for (let i = 0; i < entries.length; i++) {
								const [k, v] = entries[i];
								appendSpan(pre, '', IND.repeat(level + 1));
								appendSpan(pre, 'msghub-json-key', JSON.stringify(k));
								appendSpan(pre, 'msghub-json-punct', ': ');
								renderValue(v, p.concat(k), level + 1, false);

								const comment = resolveAnnotation(p, k, v);
								if (i < entries.length - 1) {
									appendSpan(pre, 'msghub-json-punct', ',');
								}
								if (comment) {
									appendSpan(pre, 'msghub-json-comment', ` // ${comment}`);
								}
								appendSpan(pre, '', '\n');
							}
							appendSpan(pre, '', IND.repeat(level));
							appendSpan(pre, 'msghub-json-punct', '}');
							return;
						}
						appendSpan(pre, 'msghub-json-null', JSON.stringify(val));
					};

					// reset target and render
					pre.replaceChildren();
					renderValue(value, pathParts, indent, false);
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

		function getConstantsEnum(path) {
			const o = constants && typeof constants === 'object' ? pick(constants, path) : null;
			return isObject(o) ? o : null;
		}

		function listEnumValues(enumObj) {
			const vals = [];
			for (const v of Object.values(enumObj || {})) {
				if (typeof v === 'string' && v.trim()) {
					vals.push(v.trim());
				}
				if (typeof v === 'number' && Number.isFinite(v)) {
					vals.push(String(v));
				}
			}
			return Array.from(new Set(vals)).sort((a, b) => String(a).localeCompare(String(b)));
		}

		function listEnumKeys(enumObj) {
			const keys = [];
			for (const k of Object.keys(enumObj || {})) {
				if (typeof k === 'string' && k.trim()) {
					keys.push(k.trim());
				}
			}
			return Array.from(new Set(keys)).sort((a, b) => String(a).localeCompare(String(b)));
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
					where.level = { in: Array.from(level).map(x => getLevelNumber(x)).filter(n => Number.isFinite(n)) };
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

			let popover = null;
			function closePopover() {
				if (popover?.el) {
					popover.el.remove();
			}
			popover = null;
		}

		function openSortPopover(anchorEl, { field, title }) {
			closePopover();

			const sortableField = typeof field === 'string' && field.trim() ? field.trim() : '';
			if (!sortableField) {
				return;
			}

			const mount = document.querySelector('.msghub-root') || document.body;
			const rect = anchorEl.getBoundingClientRect();
			const el = h('div', { class: 'msghub-popover' });
			el.style.left = `${Math.max(10, Math.min(rect.left, window.innerWidth - 340))}px`;
			el.style.top = `${rect.bottom + 6}px`;

			const setSort = dir => {
				sortField = sortableField;
				sortDir = dir === 'desc' ? 'desc' : 'asc';
				pageIndex = 1;
				loadMessages({ keepPopover: true }).catch(() => undefined);
				updateSortButtons();
			};

			const updateSortButtons = () => {
				const isSorted = sortField === sortableField;
				const btnAsc = el.querySelector('[data-sort="asc"]');
				const btnDesc = el.querySelector('[data-sort="desc"]');
				if (btnAsc) {
					btnAsc.classList.toggle('is-active', isSorted && sortDir === 'asc');
				}
				if (btnDesc) {
					btnDesc.classList.toggle('is-active', isSorted && sortDir === 'desc');
				}
			};

			el.appendChild(
				h('div', { class: 'msghub-popover-head' }, [
					h('div', { class: 'msghub-popover-title', text: title }),
					h('button', {
						type: 'button',
						onclick: e => {
							closePopover();
						},
						text: '×',
					}),
				]),
			);

			el.appendChild(
					h('div', { class: 'msghub-popover-controls' }, [
						h('div', { class: 'msghub-popover-sortrow' }, [
							h('button', {
								class: 'msghub-popover-sort',
								type: 'button',
								'data-sort': 'asc',
								onclick: () => setSort('asc'),
								text: t('Sort ascending', 'Aufsteigend sortieren'),
							}),
							h('button', {
								class: 'msghub-popover-sort',
								type: 'button',
								'data-sort': 'desc',
								onclick: () => setSort('desc'),
								text: t('Sort descending', 'Absteigend sortieren'),
							}),
						]),
					]),
			);

			el.appendChild(h('div', { class: 'msghub-popover-body' }));

			mount.appendChild(el);
			popover = { el };
			updateSortButtons();

			const onDocClick = ev => {
				if (!popover?.el) {
					return;
				}
				if (popover.el.contains(ev.target) || anchorEl.contains(ev.target)) {
					return;
				}
				closePopover();
				document.removeEventListener('click', onDocClick, true);
			};
			document.addEventListener('click', onDocClick, true);
		}

			function openFilterPopover(anchorEl, { key, title, options }) {
				closePopover();

				const selected = new Set(getFilterSet(key) || []);
				const sortableField =
					key === 'kind' ||
					key === 'lifecycle.state' ||
					key === 'level' ||
					key === 'origin.system' ||
					key === 'details.location'
						? key
						: null;

			const mount = document.querySelector('.msghub-root') || document.body;
			const rect = anchorEl.getBoundingClientRect();
			const el = h('div', { class: 'msghub-popover' });
			el.style.left = `${Math.max(10, Math.min(rect.left, window.innerWidth - 340))}px`;
			el.style.top = `${rect.bottom + 6}px`;

			const selectionLabel = () => (selected.size > 0 ? `${selected.size} selected` : t('No filter', 'Kein Filter'));

			const applyAndReload = () => {
				setFilterSet(key, new Set(selected));
				pageIndex = 1;
				closePopover();
				loadMessages().catch(() => undefined);
			};

			const setSort = dir => {
				if (!sortableField) {
					return;
				}
				sortField = sortableField;
				sortDir = dir === 'desc' ? 'desc' : 'asc';
				pageIndex = 1;
				loadMessages({ keepPopover: true }).catch(() => undefined);
				updateSortButtons();
			};

			const updateSortButtons = () => {
				if (!sortableField) {
					return;
				}
				const isSorted = sortField === sortableField;
				const btnAsc = el.querySelector('[data-sort="asc"]');
				const btnDesc = el.querySelector('[data-sort="desc"]');
				if (btnAsc) {
					btnAsc.classList.toggle('is-active', isSorted && sortDir === 'asc');
				}
				if (btnDesc) {
					btnDesc.classList.toggle('is-active', isSorted && sortDir === 'desc');
				}
			};

			const updateSelectedInfo = () => {
				const selectionInfo = el.querySelector('.msghub-popover-selected');
				if (selectionInfo) {
					selectionInfo.textContent = selectionLabel();
				}
			};

			const renderList = () => {
				const list = options || [];
				updateSelectedInfo();
				const checkboxes = list.map(v => {
					return h('div', { class: 'msghub-popover-item' }, [
						h('label', null, [
							h('input', {
								type: 'checkbox',
								class: 'msghub-filter-checkbox',
								checked: selected.has(v) ? 'true' : null,
								onchange: e => {
									const on = !!e?.target?.checked;
									if (on) {
										selected.add(v);
									} else {
										selected.delete(v);
									}
									renderList();
								},
							}),
							h('span', { class: 'msghub-mono', text: v }),
						]),
					]);
				});

				const body = el.querySelector('.msghub-popover-body');
				if (body) {
					body.innerHTML = '';
					body.appendChild(h('div', { class: 'msghub-popover-list' }, checkboxes));
				}
			};

			el.appendChild(
				h('div', { class: 'msghub-popover-head' }, [
					h('div', { class: 'msghub-popover-title', text: title }),
					h('button', {
						type: 'button',
						onclick: e => {
							closePopover();
						},
						text: '×',
					}),
				]),
			);
			el.appendChild(
					h('div', { class: 'msghub-popover-controls' }, [
						h('div', { class: 'msghub-popover-actions' }, [
							h('button', {
								type: 'button',
								onclick: () => {
									for (const v of options || []) {
										selected.add(v);
								}
								renderList();
							},
								text: t('Select all', 'Alle anwählen'),
							}),
							h('button', {
								type: 'button',
								onclick: () => {
									selected.clear();
									renderList();
							},
								text: t('Select none', 'Alle abwählen'),
							}),
						]),
					sortableField
						? h('div', { class: 'msghub-popover-sortrow' }, [
								h('button', {
									class: 'msghub-popover-sort',
									type: 'button',
									'data-sort': 'asc',
									onclick: () => setSort('asc'),
									text: t('Sort ascending', 'Aufsteigend sortieren'),
								}),
								h('button', {
									class: 'msghub-popover-sort',
									type: 'button',
									'data-sort': 'desc',
									onclick: () => setSort('desc'),
									text: t('Sort descending', 'Absteigend sortieren'),
								}),
							])
						: null,
					h('div', { class: 'msghub-popover-footer' }, [
						h('div', { class: 'msghub-popover-selected msghub-muted', text: selectionLabel() }),
						h('button', { type: 'button', onclick: applyAndReload, text: t('Apply', 'Übernehmen') }),
					]),
				]),
			);
			el.appendChild(h('div', { class: 'msghub-popover-body' }));

			mount.appendChild(el);
			popover = { el };
			renderList();
			updateSortButtons();

			const onDocClick = ev => {
				if (!popover?.el) {
					return;
				}
				if (popover.el.contains(ev.target) || anchorEl.contains(ev.target)) {
					return;
				}
				closePopover();
				document.removeEventListener('click', onDocClick, true);
			};
			document.addEventListener('click', onDocClick, true);
		}

			function renderTable(itemsToRender) {
				const rows = itemsToRender.map(msg => {
					const title = truncateStr(pick(msg, 'title'), 40);
					const text = truncateStr(pick(msg, 'text'), 70);
					const location = safeStr(pick(msg, 'details.location'));
					const kind = safeStr(pick(msg, 'kind'));
					const lifecycle = safeStr(pick(msg, 'lifecycle.state'));
					const level = pick(msg, 'level');
					const origin = safeStr(pick(msg, 'origin.system')) || safeStr(pick(msg, 'origin.type'));
					const progressPercentage = pick(msg, 'progress.percentage');
					const createdAt = pick(msg, 'timing.createdAt');
					const updatedAt = pick(msg, 'timing.updatedAt');

					const ref = expertMode ? safeStr(pick(msg, 'ref')) : '';
					const checkboxCell = expertMode
						? h('td', { class: 'msghub-messages-select' }, [
								h('label', null, [
									h('input', {
										type: 'checkbox',
										checked: selectedRefs.has(ref) ? 'true' : null,
										onchange: e => {
											const on = !!e?.target?.checked;
											if (on) {
												selectedRefs.add(ref);
											} else {
												selectedRefs.delete(ref);
											}
											updateDeleteButton();
										},
									}),
									h('span', { text: '' }),
								]),
							])
						: null;

					return h(
						'tr',
						{
							ondblclick: () => openMessageJson(msg),
						},
						[
							...(checkboxCell ? [checkboxCell] : []),
							h('td', { text: kind }),
							h('td', { text: getLevelLabel(level) }),
							h('td', { text: lifecycle }),
							h('td', { text: title }),
							h('td', { text: text }),
							h('td', { text: location }),
							h('td', { class: 'msghub-muted', text: formatTs(typeof createdAt === 'number' ? createdAt : NaN) }),
							h('td', { class: 'msghub-muted', text: formatTs(typeof updatedAt === 'number' ? updatedAt : NaN) }),
							h('td', { text: origin }),
							h('td', { text: typeof progressPercentage === 'number' && Number.isFinite(progressPercentage) ? String(progressPercentage) : '' }),
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
			const pageInfoEl = h('div', { class: 'msghub-muted', text: 'Page 1 / 1' });
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
			const progress = h('div', { class: 'msghub-progress is-hidden' }, h('div', { class: 'msghub-muted', text: 'Loading…' }));
			const errorEl = h('div', { class: 'msghub-error' });
			const metaEl = h('div', { class: 'msghub-muted msghub-messages-meta' });
			const emptyEl = h('div', { class: 'msghub-muted', text: t('No messages.', 'Keine Messages.') });
			emptyEl.style.display = 'none';

			const tableWrap = h('div', { class: 'msghub-table-wrap' });
			const tableEl = h('table', { class: 'msghub-table' });
			const theadEl = h('thead');
			const tbodyEl = h('tbody');
			tableEl.appendChild(theadEl);
			tableEl.appendChild(tbodyEl);
			tableWrap.appendChild(tableEl);

			/** @type {Record<string, HTMLButtonElement>} */
			const headerBtns = Object.create(null);

			const clearHeaderBtns = () => {
				for (const k of Object.keys(headerBtns)) {
					delete headerBtns[k];
				}
			};

			let tableColCount = 10;
			const updateTableColCount = () => {
				tableColCount = expertMode ? 11 : 10;
			};

			const makeSortBtn = (field, title, label) => {
				const btn = h('button', {
					class: 'msghub-th-sort',
					type: 'button',
					onclick: e => {
						e.preventDefault();
						openSortPopover(e.currentTarget || e.target, { field, title });
					},
					text: label,
				});
				headerBtns[`sort:${field}`] = btn;
				return btn;
			};

			const makeFilterBtn = (key, title, label, getOptions) => {
				const btn = h('button', {
					class: 'msghub-th-filter',
					type: 'button',
					onclick: e => {
						e.preventDefault();
						const options = typeof getOptions === 'function' ? getOptions() : [];
						openFilterPopover(e.currentTarget || e.target, { key, title, options });
					},
					text: label,
				});
				headerBtns[`filter:${key}`] = btn;
				return btn;
			};

			const renderThead = () => {
				clearHeaderBtns();
				updateTableColCount();
				theadEl.replaceChildren(
					h('tr', null, [
						...(expertMode ? [h('th', { class: 'msghub-th msghub-messages-select' }, [])] : []),
						h('th', { class: 'msghub-th' }, [
							makeFilterBtn('kind', 'Kind', 'Kind', () => listEnumValues(getConstantsEnum('kind'))),
						]),
						h('th', { class: 'msghub-th' }, [
							makeFilterBtn('level', 'Level', 'Level', () => listEnumKeys(getConstantsEnum('level'))),
						]),
						h('th', { class: 'msghub-th' }, [
							makeFilterBtn('lifecycle.state', 'Lifecycle state', 'Lifecycle', () =>
								listEnumValues(getConstantsEnum('lifecycle.state')),
							),
						]),
						h('th', { class: 'msghub-th' }, [
							makeSortBtn('title', 'Title', 'Title'),
						]),
						h('th', { class: 'msghub-th' }, [h('span', { text: 'Text' })]),
						h('th', { class: 'msghub-th' }, [
							makeFilterBtn('details.location', 'Location', 'Location', () =>
								listDistinctFromItems('details.location'),
							),
						]),
						h('th', { class: 'msghub-th' }, [makeSortBtn('timing.createdAt', 'Created', 'Created')]),
						h('th', { class: 'msghub-th' }, [makeSortBtn('timing.updatedAt', 'Updated', 'Updated')]),
						h('th', { class: 'msghub-th' }, [
							makeFilterBtn('origin.system', 'Origin system', 'Origin', () => listDistinctFromItems('origin.system')),
						]),
						h('th', { class: 'msghub-th' }, [makeSortBtn('progress.percentage', 'Progress', 'Progress')]),
					]),
				);
			};

			renderThead();

			root.replaceChildren(head, progress, errorEl, metaEl, tableWrap, emptyEl);

			const updateDeleteButton = () => {
				deleteBtn.style.display = expertMode ? '' : 'none';
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

			const canAutoRefresh = () => {
				if (!isTabVisible()) {
					return false;
				}
				if (popover?.el) {
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
				const locationCount = getFilterSet('details.location')?.size || 0;
				const kindCount = getFilterSet('kind')?.size || 0;
				const lifecycleCount = getFilterSet('lifecycle.state')?.size || 0;
				const levelCount = getFilterSet('level')?.size || 0;
				const originCount = getFilterSet('origin.system')?.size || 0;

				const btnLocation = headerBtns['filter:details.location'];
				if (btnLocation) {
					btnLocation.classList.toggle('is-active', locationCount > 0);
					btnLocation.textContent = locationCount > 0 ? `Location (${locationCount})` : 'Location';
				}
				const btnKind = headerBtns['filter:kind'];
				if (btnKind) {
					btnKind.classList.toggle('is-active', kindCount > 0);
					btnKind.textContent = kindCount > 0 ? `Kind (${kindCount})` : 'Kind';
				}
				const btnLifecycle = headerBtns['filter:lifecycle.state'];
				if (btnLifecycle) {
					btnLifecycle.classList.toggle('is-active', lifecycleCount > 0);
					btnLifecycle.textContent = lifecycleCount > 0 ? `Lifecycle (${lifecycleCount})` : 'Lifecycle';
				}
				const btnLevel = headerBtns['filter:level'];
				if (btnLevel) {
					btnLevel.classList.toggle('is-active', levelCount > 0);
					btnLevel.textContent = levelCount > 0 ? `Level (${levelCount})` : 'Level';
				}
				const btnOrigin = headerBtns['filter:origin.system'];
				if (btnOrigin) {
					btnOrigin.classList.toggle('is-active', originCount > 0);
					btnOrigin.textContent = originCount > 0 ? `Origin (${originCount})` : 'Origin';
				}

				for (const field of ['title', 'timing.createdAt', 'timing.updatedAt', 'progress.percentage']) {
					const btn = headerBtns[`sort:${field}`];
					if (btn) {
						btn.classList.toggle('is-active', sortField === field);
					}
				}
			};

			const updatePaging = () => {
				const p = pages || 1;
				const idx = Math.min(Math.max(1, pageIndex), p);
				pageInfoEl.textContent = `Page ${idx} / ${p}`;
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

			const updateTbody = (rows, { showLoadingRow = false } = {}) => {
				const fragment = document.createDocumentFragment();
				if (showLoadingRow) {
					fragment.appendChild(
						h('tr', null, [
							h('td', { class: 'msghub-muted', text: t('Loading…', 'Lade…'), colspan: String(tableColCount) }),
						]),
					);
				} else {
					for (const r of rows || []) {
						fragment.appendChild(r);
					}
				}
				tbodyEl.replaceChildren(fragment);
			};

				function render({ forceRows = false } = {}) {
					updateButtons();
					updateHeaderButtons();
					updatePaging();

					setProgressVisible(loading && !silentLoading);

					errorEl.textContent = lastError ? String(lastError) : '';
					errorEl.style.display = lastError ? 'block' : 'none';

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
					emptyEl.style.display = showEmpty ? 'block' : 'none';

				if (!hasLoadedOnce && loading) {
					updateTbody([], { showLoadingRow: true });
					return;
				}

				if (loading && !forceRows) {
					return;
				}

				updateTbody(renderTable(items));
			}

			async function loadConstants() {
				try {
					constants = await sendTo('admin.constants.get', {});
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
				} catch (_e) {
					constants = null;
				}
			}

			async function loadMessages({ keepPopover = false, silent = false } = {}) {
				const reqId = ++requestSeq;
				loading = true;
				silentLoading = silent === true;
				lastError = null;
				if (!keepPopover) {
					closePopover();
				}
				render({ forceRows: !hasLoadedOnce });

					try {
						const res = await sendTo('admin.messages.query', {
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
						total = typeof res?.total === 'number' && Number.isFinite(res.total) ? Math.max(0, Math.trunc(res.total)) : items.length;
						pages = typeof res?.pages === 'number' && Number.isFinite(res.pages) ? Math.max(1, Math.trunc(res.pages)) : 1;
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
					if (reqId !== requestSeq) {
						return;
					}
					loading = false;
					silentLoading = false;
					hasLoadedOnce = true;
					render({ forceRows: true });
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
				const text = t(
					`Are you sure you want to delete ${refs.length} messages?`,
					`Sicher, dass du ${refs.length} Nachrichten löschen möchtest?`,
				);
				const ok = ui?.dialog?.confirm
					? await ui.dialog.confirm({
							title: t('Delete messages?', 'Nachrichten löschen?'),
							text,
							danger: true,
							confirmText: 'Delete',
							cancelText: 'Cancel',
						})
					: win.confirm(text);
				if (!ok) {
					return;
				}
				try {
					await sendTo('admin.messages.delete', { refs });
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
				if (!expertMode) {
					selectedRefs.clear();
				}
				closePopover();
				renderThead();
				updateDeleteButton();
				render({ forceRows: true });
			};

			applyExpertMode(detectExpertMode());
			win.setInterval(() => applyExpertMode(detectExpertMode()), 1500);

			const scheduleAuto = () => {
				if (autoTimer) {
					clearTimeout(autoTimer);
					autoTimer = null;
				}
				if (!autoRefresh) {
					return;
				}
				autoTimer = setTimeout(() => {
					autoTimer = null;
					if (autoRefresh && canAutoRefresh()) {
						loadMessages({ keepPopover: true, silent: true }).catch(() => undefined);
					}
					scheduleAuto();
				}, AUTO_REFRESH_MS + Math.trunc(Math.random() * 1200));
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
