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
		const { sendTo, h, M, elements } = ctx;
		const root = elements.messagesRoot;
		if (!root) {
			throw new Error('MsghubAdminTabMessages: missing messagesRoot element');
		}

		const t = (en, de) => {
			const lang = typeof ctx?.lang === 'string' ? ctx.lang : '';
			return lang.toLowerCase().startsWith('de') ? de : en;
		};

		let loading = false;
		let lastError = null;
		let constants = null;
		let items = [];
		let total = 0;
		let pages = 1;

		let pageIndex = 1;
		let pageSize = 50;

		let sortField = 'timing.updatedAt';
		let sortDir = 'desc';

		/** @type {Record<string, Set<string>>} */
		const columnFilters = Object.create(null);
		// Default lifecycle filter:
		// acked=true, closed=true, deleted=false, expired=false, open=true, snoozed=true
		setFilterSet('lifecycle.state', new Set(['acked', 'closed', 'open', 'snoozed']));

		const toast = message => {
			try {
				M.toast({ html: String(message) });
			} catch (_err) {
				// ignore
			}
		};

		let overlay = null;
		function ensureOverlay() {
			if (overlay) {
				return overlay;
			}

			const mount = document.querySelector('.msghub-root') || document.body;
			const el = h('div', { class: 'msghub-overlay', 'aria-hidden': 'true' }, [
				h('div', { class: 'msghub-overlay-card', role: 'dialog', 'aria-modal': 'true' }, [
					h('div', { class: 'msghub-overlay-head' }, [
						h('div', { class: 'msghub-overlay-title', text: 'Message JSON' }),
						h('a', { href: '#', class: 'btn-flat', id: 'msghub-overlay-close', text: 'Close' }),
					]),
					h('pre', { class: 'msghub-overlay-pre', id: 'msghub-overlay-pre' }),
				]),
			]);

			mount.appendChild(el);

			const btn = el.querySelector('#msghub-overlay-close');
			const pre = el.querySelector('#msghub-overlay-pre');

			const setOpen = isOpen => {
				el.classList.toggle('is-open', isOpen);
				el.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
			};

			const close = () => setOpen(false);
			if (btn) {
				btn.addEventListener('click', e => {
					e.preventDefault();
					close();
				});
			}
			el.addEventListener('click', e => {
				if (e?.target === el) {
					close();
				}
			});
			document.addEventListener('keydown', e => {
				if (el.classList.contains('is-open') && (e.key === 'Escape' || e.key === 'Esc')) {
					e.preventDefault();
					close();
				}
			});

			overlay = {
				open: msg => {
					try {
						const text = JSON.stringify(msg, null, 2);
						if (pre) {
							pre.textContent = text;
						}
					} catch (e) {
						if (pre) {
							pre.textContent = String(e?.message || e);
						}
					}
					setOpen(true);
				},
				close,
			};
			return overlay;
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
			}

			const level = getFilterSet('level');
			if (level && level.size > 0) {
				where.level = { in: Array.from(level).map(x => getLevelNumber(x)).filter(n => Number.isFinite(n)) };
			}

			const origin = getFilterSet('origin.system');
			if (origin && origin.size > 0) {
				where.origin = { system: { in: Array.from(origin) } };
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
					h('a', {
						href: '#',
						class: 'btn-flat',
						onclick: e => {
							e.preventDefault();
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
							class: 'btn-flat msghub-popover-sort',
							type: 'button',
							'data-sort': 'asc',
							onclick: () => setSort('asc'),
							text: t('Sort ascending', 'Aufsteigend sortieren'),
						}),
						h('button', {
							class: 'btn-flat msghub-popover-sort',
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
				key === 'kind' || key === 'lifecycle.state' || key === 'level' || key === 'origin.system' ? key : null;

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
					h('a', {
						href: '#',
						class: 'btn-flat',
						onclick: e => {
							e.preventDefault();
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
							class: 'btn-flat',
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
							class: 'btn-flat',
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
									class: 'btn-flat msghub-popover-sort',
									type: 'button',
									'data-sort': 'asc',
									onclick: () => setSort('asc'),
									text: t('Sort ascending', 'Aufsteigend sortieren'),
								}),
								h('button', {
									class: 'btn-flat msghub-popover-sort',
									type: 'button',
									'data-sort': 'desc',
									onclick: () => setSort('desc'),
									text: t('Sort descending', 'Absteigend sortieren'),
								}),
							])
						: null,
					h('div', { class: 'msghub-popover-footer' }, [
						h('div', { class: 'msghub-popover-selected msghub-muted', text: selectionLabel() }),
						h('button', { class: 'btn', type: 'button', onclick: applyAndReload, text: t('Apply', 'Übernehmen') }),
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
			const kindCount = getFilterSet('kind')?.size || 0;
			const lifecycleCount = getFilterSet('lifecycle.state')?.size || 0;
			const levelCount = getFilterSet('level')?.size || 0;
			const originCount = getFilterSet('origin.system')?.size || 0;

			const head = h('thead', null, [
				h('tr', null, [
					h('th', { class: 'msghub-th' }, [
						h('button', {
							class: `btn-flat msghub-th-sort${sortField === 'ref' ? ' is-active' : ''}`,
							type: 'button',
							onclick: e => openSortPopover(e.target, { field: 'ref', title: 'Ref' }),
							text: '(Ref)',
						}),
					]),
					h('th', { class: 'msghub-th' }, [
						h('button', {
							class: `btn-flat msghub-th-sort${sortField === 'title' ? ' is-active' : ''}`,
							type: 'button',
							onclick: e => openSortPopover(e.target, { field: 'title', title: 'Title' }),
							text: '(Title)',
						}),
					]),
					h('th', { class: 'msghub-th' }, [
						h('button', {
							class: `btn-flat msghub-th-filter${kindCount > 0 ? ' is-active' : ''}`,
							type: 'button',
							onclick: e => openFilterPopover(e.target, { key: 'kind', title: 'Kind', options: listEnumValues(getConstantsEnum('kind')) }),
							text: kindCount > 0 ? `Kind (${kindCount})` : 'Kind',
						}),
					]),
					h('th', { class: 'msghub-th' }, [
						h('button', {
							class: `btn-flat msghub-th-filter${lifecycleCount > 0 ? ' is-active' : ''}`,
							type: 'button',
							onclick: e =>
								openFilterPopover(e.target, {
									key: 'lifecycle.state',
									title: 'Lifecycle state',
									options: listEnumValues(getConstantsEnum('lifecycle.state')),
								}),
							text: lifecycleCount > 0 ? `Lifecycle (${lifecycleCount})` : 'Lifecycle',
						}),
					]),
					h('th', { class: 'msghub-th' }, [
						h('button', {
							class: `btn-flat msghub-th-filter${levelCount > 0 ? ' is-active' : ''}`,
							type: 'button',
							onclick: e => openFilterPopover(e.target, { key: 'level', title: 'Level', options: listEnumKeys(getConstantsEnum('level')) }),
							text: levelCount > 0 ? `Level (${levelCount})` : 'Level',
						}),
					]),
					h('th', { class: 'msghub-th' }, [
						h('button', {
							class: `btn-flat msghub-th-filter${originCount > 0 ? ' is-active' : ''}`,
							type: 'button',
							onclick: e =>
								openFilterPopover(e.target, {
									key: 'origin.system',
									title: 'Origin system',
									options: listDistinctFromItems('origin.system'),
								}),
							text: originCount > 0 ? `(Origin ${originCount})` : '(Origin)',
						}),
					]),
					h('th', { class: 'msghub-th' }, [
						h('button', {
							class: `btn-flat msghub-th-sort${sortField === 'timing.createdAt' ? ' is-active' : ''}`,
							type: 'button',
							onclick: e => openSortPopover(e.target, { field: 'timing.createdAt', title: 'Created' }),
							text: '(Created)',
						}),
					]),
					h('th', { class: 'msghub-th' }, [
						h('button', {
							class: `btn-flat msghub-th-sort${sortField === 'timing.updatedAt' ? ' is-active' : ''}`,
							type: 'button',
							onclick: e => openSortPopover(e.target, { field: 'timing.updatedAt', title: 'Updated' }),
							text: '(Updated)',
						}),
					]),
				]),
			]);

			const rows = itemsToRender.map(msg => {
				const ref = safeStr(pick(msg, 'ref'));
				const title = safeStr(pick(msg, 'title'));
				const kind = safeStr(pick(msg, 'kind'));
				const lifecycle = safeStr(pick(msg, 'lifecycle.state'));
				const level = pick(msg, 'level');
				const origin = safeStr(pick(msg, 'origin.system')) || safeStr(pick(msg, 'origin.type'));
				const createdAt = pick(msg, 'timing.createdAt');
				const updatedAt = pick(msg, 'timing.updatedAt');

				return h('tr', {
					ondblclick: () => ensureOverlay().open(msg),
				}, [
					h('td', { class: 'msghub-mono', text: ref }),
					h('td', { text: title }),
					h('td', { text: kind }),
					h('td', { text: lifecycle }),
					h('td', { text: getLevelLabel(level) }),
					h('td', { text: origin }),
					h('td', { class: 'msghub-muted', text: formatTs(typeof createdAt === 'number' ? createdAt : NaN) }),
					h('td', { class: 'msghub-muted', text: formatTs(typeof updatedAt === 'number' ? updatedAt : NaN) }),
				]);
			});

			return h('table', { class: 'striped highlight msghub-table' }, [head, h('tbody', null, rows)]);
		}

		function render() {
			root.innerHTML = '';

			const sizeOptions = [10, 25, 50, 100, 250];
			const paging = h('div', { class: 'msghub-messages-paging' }, [
				h('button', {
					class: 'btn-flat',
					type: 'button',
					disabled: loading || pageIndex <= 1 ? 'true' : null,
					onclick: () => (pageIndex = Math.max(1, pageIndex - 1), loadMessages().catch(() => undefined)),
					text: 'Prev',
				}),
				h('div', { class: 'msghub-muted', text: `Page ${pageIndex} / ${pages || 1}` }),
				h('button', {
					class: 'btn-flat',
					type: 'button',
					disabled: loading || pageIndex >= (pages || 1) ? 'true' : null,
					onclick: () => (pageIndex = Math.min(pages || 1, pageIndex + 1), loadMessages().catch(() => undefined)),
					text: 'Next',
				}),
				h('div', { class: 'msghub-field msghub-messages-pagesize' }, [
					h('label', { class: 'msghub-muted', text: 'Items / page' }),
					h('select', {
						onchange: e => {
							const n = Number(e?.target?.value);
							pageSize = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 50;
							pageIndex = 1;
							loadMessages().catch(() => undefined);
						},
					}, sizeOptions.map(n =>
						h('option', { value: String(n), selected: pageSize === n ? 'true' : null, text: String(n) }),
					)),
				]),
			]);

			const actions = h('div', { class: 'msghub-actions' }, [
				h('button', {
					class: 'btn',
					type: 'button',
					disabled: loading ? 'true' : null,
					onclick: () => loadMessages().catch(() => undefined),
					text: 'Refresh',
				}),
			]);

			root.appendChild(h('div', { class: 'msghub-messages-head' }, [actions, paging]));

			if (loading) {
				root.appendChild(h('div', { class: 'progress' }, h('div', { class: 'indeterminate' })));
				return;
			}

			if (lastError) {
				root.appendChild(h('div', { class: 'msghub-error', text: String(lastError) }));
				return;
			}

			root.appendChild(
				h('div', {
					class: 'msghub-muted msghub-messages-meta',
					text: `messages: ${items.length} / ${total}`,
				}),
			);

			if (items.length === 0) {
				root.appendChild(h('div', { class: 'msghub-table-wrap' }, renderTable([])));
				root.appendChild(h('div', { class: 'msghub-muted', text: t('No messages.', 'Keine Messages.') }));
				return;
			}

			root.appendChild(h('div', { class: 'msghub-table-wrap' }, renderTable(items)));
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

		async function loadMessages({ keepPopover = false } = {}) {
			if (loading) {
				return;
			}
			loading = true;
			lastError = null;
			if (!keepPopover) {
				closePopover();
			}
			render();

			try {
				const res = await sendTo('admin.messages.query', {
					query: {
						where: buildWhereFromFilters(),
						page: { index: pageIndex, size: pageSize },
						sort: [{ field: sortField, dir: sortDir }],
					},
				});
				items = Array.isArray(res?.items) ? res.items : [];
				total = typeof res?.total === 'number' && Number.isFinite(res.total) ? Math.max(0, Math.trunc(res.total)) : items.length;
				pages = typeof res?.pages === 'number' && Number.isFinite(res.pages) ? Math.max(1, Math.trunc(res.pages)) : 1;
				pageIndex = Math.min(Math.max(1, pageIndex), pages);
			} catch (e) {
				lastError = String(e?.message || e);
				toast(lastError);
			} finally {
				loading = false;
				render();
			}
		}

		render();

		return {
			onConnect: async () => {
				await loadConstants();
				return await loadMessages();
			},
		};
	}

	win.MsghubAdminTabMessages = Object.freeze({
		init: initMessagesSection,
	});
})();
