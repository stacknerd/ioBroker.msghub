/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/* global window, document */
(function () {
	'use strict';

	/** @type {any} */
	const win = /** @type {any} */ (window);

	function initPluginConfigSection(ctx) {
		const elRoot = ctx?.elements?.pluginsRoot;
		if (!elRoot) {
			throw new Error('MsghubAdminTabPlugins: missing pluginsRoot element');
		}

		const adapterInstance = Number.isFinite(ctx?.adapterInstance) ? Math.trunc(ctx.adapterInstance) : 0;
		const adapterNamespace =
			typeof ctx?.adapterInstance === 'string' && ctx.adapterInstance.trim()
				? ctx.adapterInstance.trim()
				: `msghub.${adapterInstance}`;

		const sendTo = ctx.sendTo;
		const h = ctx.h;
		const pickText = ctx.pickText;
		const M = ctx.M;

		const CATEGORY_ORDER = Object.freeze(['ingest', 'notify', 'bridge', 'engage']);
		const CATEGORY_TITLES = Object.freeze({
			ingest: 'Ingest',
			notify: 'Notify',
			bridge: 'Bridge',
			engage: 'Engage',
		});

		const TIME_UNITS = Object.freeze([
			{ key: 'ms', label: 'ms', factor: 1 },
			{ key: 's', label: 's', factor: 1000 },
			{ key: 'min', label: 'min', factor: 60 * 1000 },
			{ key: 'h', label: 'h', factor: 60 * 60 * 1000 },
		]);

		function normalizeUnit(unit) {
			const u = typeof unit === 'string' ? unit.trim().toLowerCase() : '';
			return u;
		}

		function isUnitless(unit) {
			const u = normalizeUnit(unit);
			return !u || u === 'none';
		}

		function inferUnitFromLegacyHints({ key, field }) {
			if (normalizeUnit(field?.unit)) {
				return normalizeUnit(field.unit);
			}
			if (typeof key === 'string' && /Ms$/.test(key)) {
				return 'ms';
			}
			const label = pickText(field?.label);
			if (typeof label === 'string' && /\(\s*ms\s*\)/i.test(label)) {
				return 'ms';
			}
			return '';
		}

		function pickDefaultTimeUnit(ms) {
			const n = typeof ms === 'number' ? ms : Number(ms);
			if (!Number.isFinite(n) || n <= 0) {
				return 'ms';
			}
			if (n % (60 * 60 * 1000) === 0) {
				return 'h';
			}
			if (n % (60 * 1000) === 0) {
				return 'min';
			}
			if (n % 1000 === 0) {
				return 's';
			}
			return 'ms';
		}

		function getTimeFactor(unitKey) {
			const u = normalizeUnit(unitKey);
			const found = TIME_UNITS.find(x => x.key === u);
			return found ? found.factor : 1;
		}

		function formatPluginLabel(plugin) {
			const type = String(plugin?.type || '');
			const title = pickText(plugin?.title);
			if (title && title !== type) {
				return { primary: type, secondary: title };
			}
			return { primary: type, secondary: '' };
		}

		function cssSafe(s) {
			return String(s || '')
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9_-]+/g, '-')
				.replace(/^-+|-+$/g, '') || 'unknown';
		}

		let deleteModalApi = null;
		function ensureDeleteModal() {
			if (deleteModalApi) {
				return deleteModalApi;
			}

			const mount = document.querySelector('.msghub-root') || document.body;

			const titleId = 'msghub-dialog-delete-title';
			const descId = 'msghub-dialog-delete-desc';

			const el = h('div', { id: 'msghub-dialog-delete-instance', class: 'msghub-dialog-backdrop', 'aria-hidden': 'true' }, [
				h('div', { class: 'msghub-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': descId }, [
					h('h6', { id: titleId, class: 'msghub-dialog-title', text: 'Delete instance?' }),
					h('p', {
						id: descId,
						class: 'msghub-muted',
						text: 'Options of this instance will be lost and states will be deleted.',
					}),
					h('div', { class: 'msghub-dialog-actions' }, [
						h('a', { href: '#', class: 'btn-flat', id: 'msghub-dialog-delete-cancel', text: 'Cancel' }),
						h('a', { href: '#', class: 'btn red', id: 'msghub-dialog-delete-confirm', text: 'Delete' }),
					]),
				]),
			]);

			mount.appendChild(el);

			let pendingResolve = null;
			let prevOverflow = null;

			const setOpen = isOpen => {
				el.classList.toggle('is-open', isOpen);
				el.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
				if (isOpen) {
					try {
						prevOverflow = document.body.style.overflow;
						document.body.style.overflow = 'hidden';
					} catch {
						// ignore
					}
				} else {
					try {
						document.body.style.overflow = prevOverflow || '';
					} catch {
						// ignore
					}
					prevOverflow = null;
				}
			};

			const close = ok => {
				if (typeof pendingResolve === 'function') {
					const r = pendingResolve;
					pendingResolve = null;
					setOpen(false);
					r(ok === true);
					return;
				}
				setOpen(false);
			};

			const btnCancel = el.querySelector('#msghub-dialog-delete-cancel');
			if (btnCancel) {
				btnCancel.addEventListener('click', e => {
					e.preventDefault();
					close(false);
				});
			}

			const btnConfirm = el.querySelector('#msghub-dialog-delete-confirm');
			if (btnConfirm) {
				btnConfirm.addEventListener('click', e => {
					e.preventDefault();
					close(true);
				});
			}

			el.addEventListener('click', e => {
				if (e?.target === el) {
					close(false);
				}
			});

			document.addEventListener('keydown', e => {
				if (el.classList.contains('is-open') && (e.key === 'Escape' || e.key === 'Esc')) {
					e.preventDefault();
					close(false);
				}
			});

			deleteModalApi = {
				confirm: () =>
					new Promise(resolve => {
						if (typeof pendingResolve === 'function') {
							resolve(false);
							return;
						}
						pendingResolve = resolve;
						setOpen(true);
						try {
							if (btnCancel?.blur) {
								btnCancel.blur();
							}
							if (btnConfirm?.focus) {
								btnConfirm.focus();
							}
						} catch {
							// ignore
						}
					}),
			};

			return deleteModalApi;
		}

		function appendInlineCodeAware(parent, text) {
			const s = String(text ?? '');
			const parts = s.split(/(`[^`]+`)/g).filter(Boolean);
			for (const part of parts) {
				if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
					parent.appendChild(h('code', { text: part.slice(1, -1) }));
				} else {
					parent.appendChild(document.createTextNode(part));
				}
			}
		}

		function renderMarkdownLite(md) {
			const root = h('div', { class: 'msghub-readme' });
			const text = String(md || '').replace(/\r\n/g, '\n');
			const lines = text.split('\n');

			let inCode = false;
			let codeLines = [];
			let listEl = null;
			let paraLines = [];

			const flushPara = () => {
				if (paraLines.length === 0) {
					return;
				}
				const p = h('p');
				appendInlineCodeAware(p, paraLines.join(' ').trim());
				root.appendChild(p);
				paraLines = [];
			};

			const flushCode = () => {
				if (!inCode) {
					return;
				}
				const pre = h('pre', { class: 'msghub-readme-code' });
				pre.appendChild(h('code', { text: codeLines.join('\n') }));
				root.appendChild(pre);
				codeLines = [];
			};

			const closeList = () => {
				listEl = null;
			};

			for (const rawLine of lines) {
				const line = String(rawLine ?? '');
				const trimmed = line.trim();

				if (/^```/.test(trimmed)) {
					flushPara();
					closeList();
					if (inCode) {
						flushCode();
						inCode = false;
					} else {
						inCode = true;
						codeLines = [];
					}
					continue;
				}

				if (inCode) {
					codeLines.push(line);
					continue;
				}

				if (/^---+$/.test(trimmed)) {
					flushPara();
					closeList();
					root.appendChild(h('hr', { class: 'msghub-readme-hr' }));
					continue;
				}

				const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
				if (headingMatch) {
					flushPara();
					closeList();
					const level = headingMatch[1].length;
					const title = headingMatch[2].trim();
					const el = h('h6', { class: `msghub-readme-h msghub-readme-h${level}`.trim() });
					appendInlineCodeAware(el, title);
					root.appendChild(el);
					continue;
				}

				const listMatch = trimmed.match(/^[-*]\s+(.*)$/);
				if (listMatch) {
					flushPara();
					if (!listEl) {
						listEl = h('ul', { class: 'msghub-readme-list' });
						root.appendChild(listEl);
					}
					const li = h('li');
					appendInlineCodeAware(li, listMatch[1].trim());
					listEl.appendChild(li);
					continue;
				}

				if (!trimmed) {
					flushPara();
					closeList();
					continue;
				}

				paraLines.push(trimmed);
			}

			if (inCode) {
				flushCode();
			}
			flushPara();

			return root;
		}

		let readmeModalApi = null;
		function ensureReadmeModal() {
			if (readmeModalApi) {
				return readmeModalApi;
			}

			const mount = document.querySelector('.msghub-root') || document.body;

			const titleId = 'msghub-dialog-readme-title';
			const bodyId = 'msghub-dialog-readme-body';

			const el = h('div', { id: 'msghub-dialog-plugin-readme', class: 'msghub-dialog-backdrop', 'aria-hidden': 'true' }, [
				h('div', { class: 'msghub-dialog msghub-dialog--readme', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
					h('h6', { id: titleId, class: 'msghub-dialog-title', text: 'Plugin guide' }),
					h('div', { id: bodyId, class: 'msghub-dialog-body' }),
					h('div', { class: 'msghub-dialog-actions' }, [
						h('a', { href: '#', class: 'btn-flat', id: 'msghub-dialog-readme-close', text: 'Close' }),
					]),
				]),
			]);

			mount.appendChild(el);

			let prevOverflow = null;

			const setOpen = isOpen => {
				el.classList.toggle('is-open', isOpen);
				el.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
				if (isOpen) {
					try {
						prevOverflow = document.body.style.overflow;
						document.body.style.overflow = 'hidden';
					} catch {
						// ignore
					}
				} else {
					try {
						document.body.style.overflow = prevOverflow || '';
					} catch {
						// ignore
					}
					prevOverflow = null;
				}
			};

			const close = () => setOpen(false);

			const btnClose = el.querySelector('#msghub-dialog-readme-close');
			if (btnClose) {
				btnClose.addEventListener('click', e => {
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

			readmeModalApi = {
				open: opts => {
					const title = typeof opts?.title === 'string' ? opts.title : '';
					const bodyEl = opts?.bodyEl;
					const t = title && title.trim() ? title.trim() : 'Plugin guide';
					const titleEl = el.querySelector(`#${titleId}`);
					if (titleEl) {
						titleEl.textContent = t;
					}
					const body = el.querySelector(`#${bodyId}`);
					if (body) {
						body.replaceChildren(bodyEl || h('p', { class: 'msghub-muted', text: 'No guide available.' }));
					}
					setOpen(true);
				},
			};

			return readmeModalApi;
		}

		let pluginReadmesByType = new Map();
		let pluginReadmesLoadPromise = null;
		async function ensurePluginReadmesLoaded() {
			if (pluginReadmesLoadPromise) {
				return pluginReadmesLoadPromise;
			}
			pluginReadmesLoadPromise = (async () => {
				try {
					const res = await fetch('plugin-readmes.json', { cache: 'no-store' });
					if (!res?.ok) {
						return pluginReadmesByType;
					}
					const data = await res.json();
					if (!data || typeof data !== 'object') {
						return pluginReadmesByType;
					}
					const map = new Map();
					for (const [k, v] of Object.entries(data)) {
						if (typeof k !== 'string' || !k.trim()) {
							continue;
						}
						if (!v || typeof v !== 'object') {
							continue;
						}
						const md = typeof v.md === 'string' ? v.md : '';
						const source = typeof v.source === 'string' ? v.source : '';
						if (!md.trim()) {
							continue;
						}
						map.set(k.trim(), { md, source });
					}
					pluginReadmesByType = map;
					return pluginReadmesByType;
				} catch {
					return pluginReadmesByType;
				}
			})();
			return pluginReadmesLoadPromise;
		}

		const captureAccordionState = () => {
			const map = new Map();
			for (const el of elRoot.querySelectorAll('.msghub-acc-input')) {
				if (el && typeof el.id === 'string' && el.id) {
					map.set(el.id, el.checked === true);
				}
			}
			return map;
		};

		function buildFieldInput({ type, key, label, value, help, unit, min, max, step, options }) {
			const id = `f_${key}_${Math.random().toString(36).slice(2, 8)}`;

			if (type === 'header') {
				const labelText = typeof label === 'string' ? label.trim() : '';
				const hasLabel = !!labelText;
				return {
					skipSave: true,
					wrapper: h('div', { class: 'msghub-field msghub-field--header' }, [
						h('hr', { class: 'msghub-field-hr' }),
						hasLabel ? h('p', { class: 'msghub-field-header-label', text: labelText }) : null,
					]),
				};
			}

			const optionList = Array.isArray(options) ? options.filter(o => o && typeof o === 'object') : [];
			if ((type === 'string' || type === 'number') && optionList.length > 0) {
				const input = h('select', { id });

				const normalized = optionList
					.map(o => ({
						label: pickText(o.label) || (o.value !== undefined ? String(o.value) : ''),
						value: o.value,
					}))
					.filter(o => o.value !== undefined && o.value !== null);

				const valueSet = new Set(normalized.map(o => String(o.value)));

				if (value === undefined || value === null || value === '') {
					input.appendChild(h('option', { value: '', text: '' }));
				} else if (!valueSet.has(String(value))) {
					input.appendChild(h('option', { value: String(value), text: String(value) }));
				}

				for (const opt of normalized) {
					input.appendChild(h('option', { value: String(opt.value), text: opt.label }));
				}

				const initial =
					value === undefined || value === null || value === '' ? '' : valueSet.has(String(value)) ? String(value) : String(value);
				input.value = initial;

				return {
					input,
					getValue: () => {
						const raw = input.value;
						if (raw === '') {
							return null;
						}
						if (type === 'number') {
							const n = Number(raw);
							return Number.isFinite(n) ? n : null;
						}
						return raw;
					},
					wrapper: h('div', { class: 'input-field msghub-field msghub-field-select' }, [
						input,
						h('label', { for: id, text: label || key }),
						help ? h('div', { class: 'msghub-muted', text: help }) : null,
					]),
				};
			}

			if (type === 'boolean') {
				const input = h('input', { type: 'checkbox', id });
				input.checked = value === true;
				return {
					input,
					getValue: () => input.checked === true,
					wrapper: h('div', null, [
						h('p', null, [input, h('label', { for: id, text: label || key })]),
						help ? h('div', { class: 'msghub-muted', text: help }) : null,
					]),
				};
			}

			if (type === 'number') {
				const effectiveUnit = inferUnitFromLegacyHints({ key, field: { unit, label } });

				if (effectiveUnit === 'ms') {
					const input = h('input', { type: 'number', id });
					const selectId = `u_${key}_${Math.random().toString(36).slice(2, 8)}`;
					const select = h('select', { id: selectId, class: 'msghub-time-unit' });
					for (const u of TIME_UNITS) {
						select.appendChild(h('option', { value: u.key, text: u.label }));
					}

					const msRaw = value ?? '';
					const msNum = msRaw === '' ? NaN : Number(msRaw);
					const initialUnit = pickDefaultTimeUnit(msNum);
					select.value = initialUnit;

					const updateConstraints = unitKey => {
						const factor = getTimeFactor(unitKey);
						if (min !== undefined) {
							input.setAttribute('min', String(Number(min) / factor));
						}
						if (max !== undefined) {
							input.setAttribute('max', String(Number(max) / factor));
						}
						if (step !== undefined) {
							input.setAttribute('step', String(Number(step) / factor));
						}
					};

					const initialFactor = getTimeFactor(initialUnit);
					if (Number.isFinite(msNum)) {
						input.value = String(msNum / initialFactor);
					} else {
						input.value = '';
					}
					updateConstraints(initialUnit);

					select.addEventListener('change', () => {
						const prevUnit = select.getAttribute('data-prev') || initialUnit;
						const prevFactor = getTimeFactor(prevUnit);
						const nextUnit = select.value;
						const nextFactor = getTimeFactor(nextUnit);

						const raw = input.value;
						const cur = raw === '' ? NaN : Number(raw);
						const curMs = Number.isFinite(cur) ? cur * prevFactor : NaN;
						if (Number.isFinite(curMs)) {
							input.value = String(curMs / nextFactor);
						}
						updateConstraints(nextUnit);
						select.setAttribute('data-prev', nextUnit);
					});
					select.setAttribute('data-prev', initialUnit);

					return {
						input,
						select,
						getValue: () => {
							const raw = input.value;
							if (raw === '') {
								return null;
							}
							const n = Number(raw);
							if (!Number.isFinite(n)) {
								return null;
							}
							const factor = getTimeFactor(select.value);
							return Math.round(n * factor);
						},
						wrapper: h('div', { class: 'input-field msghub-field msghub-field-time' }, [
							h('div', { class: 'msghub-field-time-row' }, [
								input,
								select,
							]),
							h('label', { for: id, text: label || key }),
							help ? h('div', { class: 'msghub-muted', text: help }) : null,
						]),
					};
				}

				const input = h('input', { type: 'number', id, value: value ?? '' });
				if (min !== undefined) {
					input.setAttribute('min', String(min));
				}
				if (max !== undefined) {
					input.setAttribute('max', String(max));
				}
				if (step !== undefined) {
					input.setAttribute('step', String(step));
				}
				const labelText = typeof label === 'string' ? label : '';
				const esc = String(effectiveUnit).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const alreadyInLabel =
					!!effectiveUnit &&
					(new RegExp(`\\(\\s*${esc}\\s*\\)`, 'i').test(labelText) || labelText.includes(effectiveUnit));
				const suffix =
					!isUnitless(effectiveUnit) && !alreadyInLabel
						? h('span', { class: 'msghub-unit-suffix', text: effectiveUnit })
						: null;
				return {
					input,
					getValue: () => {
						const raw = input.value;
						if (raw === '') {
							return null;
						}
						const n = Number(raw);
						return Number.isFinite(n) ? n : null;
					},
					wrapper: h('div', { class: 'input-field msghub-field msghub-field-number' }, [
						input,
						suffix,
						h('label', { for: id, text: label || key }),
						help ? h('div', { class: 'msghub-muted', text: help }) : null,
					]),
				};
			}

			const input = h('input', { type: 'text', id, value: value ?? '' });
			return {
				input,
				getValue: () => input.value,
				wrapper: h('div', { class: 'input-field msghub-field' }, [
					input,
					h('label', { for: id, text: label || key }),
					help ? h('div', { class: 'msghub-muted', text: help }) : null,
				]),
			};
		}

		function getPluginFields(plugin) {
			const fields = [];
			for (const [key, spec] of Object.entries(plugin?.options || {})) {
				if (!key || !spec || typeof spec !== 'object') {
					continue;
				}
				fields.push({ key, ...spec });
			}
			fields.sort((a, b) => {
				const ao = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
				const bo = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
				return ao - bo || String(a.key).localeCompare(String(b.key));
			});
			return fields;
		}

		function getInstanceTitleFieldKey(fields) {
			const list = Array.isArray(fields) ? fields : [];
			const flagged = list.filter(f => f?.holdsInstanceTitle === true && f?.key);
			if (flagged.length === 0) {
				return '';
			}
			flagged.sort((a, b) => {
				const ao = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
				const bo = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
				return ao - bo || String(a.key).localeCompare(String(b.key));
			});
			return String(flagged[0].key || '');
		}

		function formatInstanceTitleValue({ inst, fieldKey, plugin }) {
			if (!fieldKey) {
				return '';
			}
			const spec = plugin?.options?.[fieldKey];
			const fallback = spec && typeof spec === 'object' ? spec.default : undefined;
			const raw =
				inst?.native?.[fieldKey] !== undefined && inst?.native?.[fieldKey] !== null ? inst.native[fieldKey] : fallback;
			if (raw === undefined || raw === null) {
				return '';
			}
			const s = typeof raw === 'string' ? raw.trim() : String(raw);
			if (!s) {
				return '';
			}
			const maxLen = 60;
			return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
		}

		let ingestStatesSchemaPromise = null;
		async function ensureIngestStatesSchema() {
			if (ingestStatesSchemaPromise) {
				return ingestStatesSchemaPromise;
			}
			ingestStatesSchemaPromise = (async () => {
				const schema = await sendTo('admin.ingestStates.schema.get', {});
				if (!schema || typeof schema !== 'object') {
					throw new Error('Invalid schema response');
				}
				return schema;
			})();
			return ingestStatesSchemaPromise;
		}

		function renderIngestStatesBulkApply({ instances, schema }) {
			const inst = Array.isArray(instances) ? instances.find(x => x?.instanceId === 0) : null;
			const enabled = inst?.enabled === true;

			const lsKey = `msghub.bulkApply.${adapterNamespace}`;
			const loadState = () => {
				try {
					const raw = window?.localStorage?.getItem?.(lsKey);
					if (!raw) {
						return null;
					}
					const parsed = JSON.parse(raw);
					return parsed && typeof parsed === 'object' ? parsed : null;
				} catch {
					return null;
				}
			};
			const saveState = next => {
				try {
					window?.localStorage?.setItem?.(lsKey, JSON.stringify(next || {}));
				} catch {
					// ignore
				}
			};

			const initial = loadState() || {};

			function readCfg(cfg, path) {
				if (!cfg || typeof cfg !== 'object') {
					return undefined;
				}
				if (cfg[path] !== undefined) {
					return cfg[path];
				}
				const parts = String(path || '').split('.').filter(Boolean);
				if (parts.length === 0) {
					return undefined;
				}
				let cur = cfg;
				for (const p of parts) {
					if (!cur || typeof cur !== 'object' || cur[p] === undefined) {
						return undefined;
					}
					cur = cur[p];
				}
				return cur;
			}

			function joinOptions(list) {
				return (Array.isArray(list) ? list : []).map(v => String(v)).join('|');
			}

			function collectWarnings(cfg) {
				const warnings = [];

				const mode = readCfg(cfg, 'mode');
				const allowedModes = ['threshold', 'freshness', 'triggered', 'nonSettling', 'session'];
				const modeStr = typeof mode === 'string' ? mode.trim() : '';
				if (!modeStr) {
					warnings.push(`WARNING: missing mode detected. valid options are: ${allowedModes.join('|')}`);
				} else if (!allowedModes.includes(modeStr)) {
					warnings.push(`WARNING: invalid mode detected ('${modeStr}'). valid options are: ${allowedModes.join('|')}`);
				}

				if (modeStr === 'triggered') {
					const trgId = String(readCfg(cfg, 'trg.id') || '').trim();
					if (!trgId) {
						warnings.push('WARNING: missing trg.id detected. This field is required for triggered rules.');
					}
				}

				const fields = schema?.fields && typeof schema.fields === 'object' ? schema.fields : {};
				for (const [key, info] of Object.entries(fields)) {
					if (!info || typeof info !== 'object') {
						continue;
					}
					const val = readCfg(cfg, key);
					if (val === undefined) {
						continue;
					}
					const type = typeof info.type === 'string' ? info.type : '';

					if (type === 'select') {
						const opts = Array.isArray(info.options) ? info.options : [];
						if (opts.length && !opts.includes(val)) {
							warnings.push(
								`WARNING: invalid ${key} detected ('${String(val)}'). valid options are: ${joinOptions(opts)}`,
							);
						}
						continue;
					}
					if (type === 'checkbox') {
						if (typeof val !== 'boolean') {
							warnings.push(`WARNING: invalid ${key} detected. expected a boolean.`);
						}
						continue;
					}
					if (type === 'number') {
						if (typeof val !== 'number' || !Number.isFinite(val)) {
							warnings.push(`WARNING: invalid ${key} detected. expected a number.`);
							continue;
						}
						const min = typeof info.min === 'number' && Number.isFinite(info.min) ? info.min : null;
						const max = typeof info.max === 'number' && Number.isFinite(info.max) ? info.max : null;
						if (min !== null && val < min) {
							warnings.push(`WARNING: invalid ${key} detected. expected >= ${min}.`);
						}
						if (max !== null && val > max) {
							warnings.push(`WARNING: invalid ${key} detected. expected <= ${max}.`);
						}
						continue;
					}
				}

				return warnings;
			}

			function formatMs(ms) {
				const n = typeof ms === 'number' ? ms : Number(ms);
				if (!Number.isFinite(n) || n <= 0) {
					return '';
				}
				const totalSeconds = Math.round(n / 1000);
				if (totalSeconds < 60) {
					return `${totalSeconds}s`;
				}
				const totalMinutes = Math.round(totalSeconds / 60);
				if (totalMinutes < 60) {
					return `${totalMinutes}m`;
				}
				const totalHours = Math.round(totalMinutes / 60);
				if (totalHours < 24) {
					const hours = totalHours;
					const minutes = Math.round((totalMinutes - hours * 60) / 5) * 5;
					if (!minutes) {
						return `${hours}h`;
					}
					return `${hours}:${String(minutes).padStart(2, '0')}h`;
				}
				const days = Math.floor(totalHours / 24);
				const hours = totalHours - days * 24;
				if (!hours) {
					return `${days}d`;
				}
				return `${days}d ${hours}h`;
			}

			function formatDurationValueUnit(value, unitSeconds) {
				const v = typeof value === 'number' ? value : Number(value);
				const u = typeof unitSeconds === 'number' ? unitSeconds : Number(unitSeconds);
				if (!Number.isFinite(v) || !Number.isFinite(u) || v <= 0 || u <= 0) {
					return '';
				}
				return formatMs(v * u * 1000);
			}

			function describeCustomConfig(custom) {
				const cfg = custom && typeof custom === 'object' ? custom : null;
				if (!cfg) {
					return 'No config loaded.';
				}

				const lines = [];
				const warnings = collectWarnings(cfg);
				if (warnings.length) {
					lines.push(...warnings);
					lines.push('');
				}
				const isEnabled = readCfg(cfg, 'enabled') === true;
				const mode = String(readCfg(cfg, 'mode') || '').trim();
				lines.push(`Status: ${isEnabled ? 'enabled' : 'disabled'}`);
				lines.push(`Rule type: ${mode || '(not set)'}`);
				lines.push('');

				const title = String(readCfg(cfg, 'msg.title') || '').trim();
				const text = String(readCfg(cfg, 'msg.text') || '').trim();
				lines.push(`Message title: ${title ? `"${title}"` : 'default'}`);
				lines.push(`Message text: ${text ? `"${text}"` : 'default'}`);

				const tags = String(readCfg(cfg, 'msg.audienceTags') || '').trim();
				const channels = String(readCfg(cfg, 'msg.audienceChannels') || '').trim();
				if (tags || channels) {
					lines.push(`Audience: ${[tags ? `tags=[${tags}]` : null, channels ? `channels=[${channels}]` : null].filter(Boolean).join(' ')}`);
				} else {
					lines.push('Audience: default');
				}

				const resetOnNormal = readCfg(cfg, 'msg.resetOnNormal');
				lines.push(`Auto-remove on normal: ${resetOnNormal === false ? 'off' : 'on'}`);
				const resetDelay = formatDurationValueUnit(readCfg(cfg, 'msg.resetDelayValue'), readCfg(cfg, 'msg.resetDelayUnit'));
				if (resetDelay) {
					lines.push(`Reset delay: ${resetDelay}`);
				}
				const remind = formatDurationValueUnit(readCfg(cfg, 'msg.remindValue'), readCfg(cfg, 'msg.remindUnit'));
				lines.push(`Reminder: ${remind ? `every ${remind}` : 'off'}`);
				const cooldown = formatDurationValueUnit(readCfg(cfg, 'msg.cooldownValue'), readCfg(cfg, 'msg.cooldownUnit'));
				if (cooldown) {
					lines.push(`Cooldown after close: ${cooldown}`);
				}

				lines.push('');
				lines.push('Rule behavior:');

				if (mode === 'threshold') {
					const thrMode = String(readCfg(cfg, 'thr.mode') || '').trim() || 'lt';
					const h = readCfg(cfg, 'thr.hysteresis');
					const minDur = formatDurationValueUnit(readCfg(cfg, 'thr.minDurationValue'), readCfg(cfg, 'thr.minDurationUnit'));
					const value = readCfg(cfg, 'thr.value');
					const min = readCfg(cfg, 'thr.min');
					const max = readCfg(cfg, 'thr.max');

					if (thrMode === 'gt') {
						lines.push(`- Alerts when the value is greater than ${value}.`);
					} else if (thrMode === 'lt') {
						lines.push(`- Alerts when the value is lower than ${value}.`);
					} else if (thrMode === 'outside') {
						lines.push(`- Alerts when the value is outside ${min}–${max}.`);
					} else if (thrMode === 'inside') {
						lines.push(`- Alerts when the value is inside ${min}–${max}.`);
					} else if (thrMode === 'truthy') {
						lines.push('- Alerts when the value is TRUE.');
					} else if (thrMode === 'falsy') {
						lines.push('- Alerts when the value is FALSE.');
					} else {
						lines.push(`- Alerts based on threshold mode '${thrMode}'.`);
					}
					if (typeof h === 'number' && Number.isFinite(h) && h > 0) {
						lines.push(`- Uses hysteresis (${h}) to avoid flapping.`);
					}
					if (minDur) {
						lines.push(`- Creates the message only if the condition stays true for ${minDur}.`);
					}
					lines.push('- Actions: ack, snooze (4h), close (only when auto-remove is off).');
				} else if (mode === 'freshness') {
					const evaluateBy = readCfg(cfg, 'fresh.evaluateBy') === 'lc' ? 'change (lc)' : 'update (ts)';
					const thr = formatDurationValueUnit(readCfg(cfg, 'fresh.everyValue'), readCfg(cfg, 'fresh.everyUnit'));
					lines.push(`- Alerts when the state has no ${evaluateBy} for longer than ${thr || '(not set)'}.`);
					lines.push('- Actions: ack, snooze (4h), close (only when auto-remove is off).');
				} else if (mode === 'triggered') {
					const windowDur = formatDurationValueUnit(readCfg(cfg, 'trg.windowValue'), readCfg(cfg, 'trg.windowUnit'));
					const exp = String(readCfg(cfg, 'trg.expectation') || '').trim();
					lines.push('- Starts a time window when the trigger becomes active.');
					lines.push(`- If the expectation is not met within ${windowDur || '(not set)'}, it creates a message.`);
					if (exp) {
						lines.push(`- Expectation: ${exp}.`);
					}
					lines.push('- Actions: ack, snooze (4h), close (only when auto-remove is off).');
				} else if (mode === 'nonSettling') {
					const profile = String(readCfg(cfg, 'ns.profile') || '').trim();
					lines.push(`- Non-settling profile: ${profile || '(not set)'}.`);
					lines.push('- Creates a message when the value is not stable/trending as configured, and closes on recovery.');
					lines.push('- Actions: ack, snooze (4h), close (only when auto-remove is off).');
				} else if (mode === 'session') {
					lines.push('- Tracks a start and an end message (two refs).');
					lines.push('- The start message is soft-deleted when the end message is created.');
					lines.push('- Actions: start=ack+snooze(4h)+delete, end=ack+snooze(4h).');
				} else {
					lines.push('- Select a rule type to see a detailed description.');
				}

				lines.push('');
				lines.push('Note: Bulk Apply never reads/writes managedMeta.');
				return lines.join('\n');
			}

			const elPattern = h('input', {
				type: 'text',
				placeholder: 'e.g. linkeddevices.0.*.CO2',
				value: typeof initial.pattern === 'string' ? initial.pattern : '',
				disabled: enabled ? undefined : '',
			});

			const elSource = h('input', {
				type: 'text',
				placeholder: 'e.g. linkeddevices.0.room.sensor.CO2',
				value: typeof initial.sourceId === 'string' ? initial.sourceId : '',
				disabled: enabled ? undefined : '',
			});

			const defaultCustom =
				schema?.defaults && typeof schema.defaults === 'object'
					? schema.defaults
					: {
							enabled: true,
							mode: 'threshold',

							// Threshold (thr.*)
							'thr.mode': 'lt',
							'thr.value': 10,
							'thr.min': 0,
							'thr.max': 100,
							'thr.hysteresis': 0,
							'thr.minDurationValue': 0,
							'thr.minDurationUnit': 60,

							// Freshness (fresh.*)
							'fresh.everyValue': 60,
							'fresh.everyUnit': 60,
							'fresh.evaluateBy': 'ts',

							// Triggered / dependency (trg.*)
							'trg.id': '',
							'trg.operator': 'eq',
							'trg.valueType': 'boolean',
							'trg.valueBool': true,
							'trg.valueNumber': 0,
							'trg.valueString': '',
							'trg.windowValue': 5,
							'trg.windowUnit': 60,
							'trg.expectation': 'changed',
							'trg.minDelta': 0,
							'trg.threshold': 0,

							// Non-settling (ns.*)
							'ns.profile': 'activity',
							'ns.minDelta': 0,
							'ns.maxContinuousValue': 180,
							'ns.maxContinuousUnit': 60,
							'ns.quietGapValue': 15,
							'ns.quietGapUnit': 60,
							'ns.direction': 'up',
							'ns.trendWindowValue': 6,
							'ns.trendWindowUnit': 3600,
							'ns.minTotalDelta': 0,

							// Session (sess.*)
							'sess.onOffId': '',
							'sess.onOffActive': 'truthy',
							'sess.onOffValue': 'true',
							'sess.startThreshold': 50,
							'sess.startMinHoldValue': 0,
							'sess.startMinHoldUnit': 1,
							'sess.stopThreshold': 15,
							'sess.stopDelayValue': 5,
							'sess.stopDelayUnit': 60,
							'sess.cancelStopIfAboveStopThreshold': true,
							'sess.energyCounterId': '',
							'sess.pricePerKwhId': '',

							// Message (msg.*)
							'msg.kind': 'status',
							'msg.level': 10,
							'msg.title': '',
							'msg.text': '',
							'msg.audienceTags': '',
							'msg.audienceChannels': '',
							'msg.cooldownValue': 60,
							'msg.cooldownUnit': 60,
							'msg.remindValue': 0,
							'msg.remindUnit': 3600,
							'msg.resetOnNormal': true,
							'msg.resetDelayValue': 0,
							'msg.resetDelayUnit': 60,

							// Session start message (msg.sessionStart*)
							'msg.sessionStartEnabled': false,
							'msg.sessionStartKind': 'status',
							'msg.sessionStartLevel': 10,
							'msg.sessionStartTitle': '',
							'msg.sessionStartText': '',
							'msg.sessionStartAudienceTags': '',
							'msg.sessionStartAudienceChannels': '',
						};

			const elCustom = h('textarea', {
				class: 'msghub-bulk-apply-textarea',
				rows: '24',
				disabled: enabled ? undefined : '',
			});
			elCustom.value = typeof initial.customJson === 'string' ? initial.customJson : JSON.stringify(defaultCustom, null, 2);

			const elDescription = h('textarea', {
				class: 'msghub-bulk-apply-textarea msghub-bulk-apply-textarea--desc',
				rows: '24',
				readonly: '',
				disabled: enabled ? undefined : '',
			});

			const elReplace = h('input', { type: 'checkbox', disabled: enabled ? undefined : '' });
			elReplace.checked = initial.replace === true;
			const elReplaceLabel = h('label', { text: 'Replace config (danger)' });

			const elStatus = h('div', { class: 'msghub-muted msghub-bulk-apply-status', text: '' });
			const elPreview = h('pre', { class: 'msghub-bulk-apply-preview', text: '' });

			let lastPreview = null;

			const updateLs = () =>
				saveState({
					pattern: elPattern.value,
					sourceId: elSource.value,
					customJson: elCustom.value,
					replace: elReplace.checked === true,
				});

			const updateDescription = () => {
				try {
					const parsed = parseCustom();
					elDescription.value = describeCustomConfig(parsed);
				} catch (err) {
					elDescription.value = `Invalid JSON: ${String(err?.message || err)}`;
				}
			};

			elPattern.addEventListener('input', () => {
				updateLs();
				invalidatePreview();
			});
			elSource.addEventListener('input', () => {
				updateLs();
				invalidatePreview();
			});
			elCustom.addEventListener('input', () => {
				updateLs();
				updateDescription();
				invalidatePreview();
			});
			elReplace.addEventListener('change', () => {
				updateLs();
				invalidatePreview();
			});

			const parseCustom = () => {
				const raw = String(elCustom.value || '').trim();
				if (!raw) {
					throw new Error('Custom config JSON is empty');
				}
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					throw new Error('Custom config JSON must be an object');
				}
				return parsed;
			};

			const setBusy = (busy, btns) => {
				for (const b of btns) {
					b.classList.toggle('disabled', busy === true);
				}
			};

			const btnLoad = h('a', {
				class: 'btn-flat',
				href: '#',
				text: 'Load from object',
			});

			const btnGenerateEmpty = h('a', {
				class: 'btn-flat',
				href: '#',
				text: 'Generate empty',
			});

			const btnPreview = h('a', {
				class: 'btn',
				href: '#',
				text: 'Generate preview',
			});

			const btnApply = h('a', {
				class: 'btn disabled',
				href: '#',
				text: 'Apply settings',
			});

			const setApplyEnabled = ok => {
				btnApply.classList.toggle('disabled', ok !== true);
				btnApply.setAttribute('aria-disabled', ok === true ? 'false' : 'true');
			};

			const setStatus = msg => {
				elStatus.textContent = String(msg || '');
			};

			const setPreviewText = msg => {
				elPreview.textContent = String(msg || '');
			};

			const setPreview = res => {
				lastPreview = res || null;
				if (!res) {
					setPreviewText('');
					setApplyEnabled(false);
					return;
				}

				const lines = [];
				lines.push(`Pattern: ${res.pattern}`);
				lines.push(`Matched states: ${res.matchedStates}`);
				lines.push(`Will change: ${res.willChange}`);
				lines.push(`Unchanged: ${res.unchanged}`);
				lines.push('');
				lines.push('Sample:');
				for (const s of res.sample || []) {
					lines.push(`- ${s.changed ? '✓' : '·'} ${s.id}`);
				}
				setPreviewText(lines.join('\n'));
				setApplyEnabled(res.willChange > 0);
			};

			const invalidatePreview = () => {
				lastPreview = null;
				setPreview(null);
			};

			const ensureEnabledOrWarn = () => {
				if (enabled) {
					return true;
				}
				setStatus('IngestStates is disabled. Enable the plugin to use Bulk Apply.');
				try {
					M.toast({ html: 'IngestStates is disabled. Enable the plugin to use Bulk Apply.' });
				} catch {
					// ignore
				}
				return false;
			};

			btnLoad.addEventListener('click', async e => {
				e.preventDefault();
				if (!ensureEnabledOrWarn()) {
					return;
				}
				const id = String(elSource.value || '').trim();
				if (!id) {
					setStatus('Enter a source object id first.');
					return;
				}
				setBusy(true, [btnLoad, btnPreview, btnApply]);
				setStatus('Loading…');
				try {
					const res = await sendTo('admin.ingestStates.custom.read', { id });
					if (!res?.custom) {
						setStatus('No MsgHub Custom config found on that object.');
						return;
					}
					elCustom.value = JSON.stringify(res.custom, null, 2);
					updateLs();
					updateDescription();
					invalidatePreview();
					setStatus('Loaded.');
				} catch (err) {
					setStatus(`Load failed: ${String(err?.message || err)}`);
				} finally {
					setBusy(false, [btnLoad, btnPreview, btnApply]);
				}
			});

			btnGenerateEmpty.addEventListener('click', e => {
				e.preventDefault();
				if (!ensureEnabledOrWarn()) {
					return;
				}
				elCustom.value = JSON.stringify(defaultCustom, null, 2);
				updateLs();
				updateDescription();
				invalidatePreview();
				setStatus('Generated.');
			});

			btnPreview.addEventListener('click', async e => {
				e.preventDefault();
				if (!ensureEnabledOrWarn()) {
					return;
				}
				const pattern = String(elPattern.value || '').trim();
				if (!pattern) {
					setStatus('Enter an object id pattern first.');
					return;
				}
				let custom;
				try {
					custom = parseCustom();
				} catch (err) {
					setStatus(`Invalid JSON: ${String(err?.message || err)}`);
					return;
				}

				setBusy(true, [btnLoad, btnPreview, btnApply]);
				setStatus('Previewing…');
				invalidatePreview();
				try {
					const res = await sendTo('admin.ingestStates.bulkApply.preview', {
						pattern,
						custom,
						replace: elReplace.checked === true,
						limit: 50,
					});
					setStatus('Preview ready.');
					setPreview(res);
					updateDescription();
				} catch (err) {
					setStatus(`Preview failed: ${String(err?.message || err)}`);
					setPreview(null);
				} finally {
					setBusy(false, [btnLoad, btnPreview, btnApply]);
				}
			});

			btnApply.addEventListener('click', async e => {
				e.preventDefault();
				if (!ensureEnabledOrWarn()) {
					return;
				}
				if (btnApply.classList.contains('disabled')) {
					return;
				}
				const pattern = String(elPattern.value || '').trim();
				if (!pattern) {
					setStatus('Enter an object id pattern first.');
					return;
				}
				let custom;
				try {
					custom = parseCustom();
				} catch (err) {
					setStatus(`Invalid JSON: ${String(err?.message || err)}`);
					return;
				}
				const count = Number(lastPreview?.willChange) || 0;
				if (!window.confirm(`Apply MsgHub Custom config to ${count} object(s) as previewed?`)) {
					return;
				}

				setBusy(true, [btnLoad, btnPreview, btnApply]);
				setStatus('Applying…');
				try {
					const res = await sendTo('admin.ingestStates.bulkApply.apply', {
						pattern,
						custom,
						replace: elReplace.checked === true,
					});
					setStatus(`Done: updated=${res.updated}, unchanged=${res.unchanged}, errors=${(res.errors || []).length}`);
					setPreview(null);
					try {
						M.toast({ html: `Bulk apply done: updated=${res.updated}` });
					} catch {
						// ignore
					}
				} catch (err) {
					setStatus(`Apply failed: ${String(err?.message || err)}`);
				} finally {
					setBusy(false, [btnLoad, btnPreview, btnApply]);
				}
			});

			if (!enabled) {
				setStatus('IngestStates is disabled. Enable the plugin to use Bulk Apply.');
			}

			updateDescription();

			return h('div', { class: 'msghub-bulk-apply' }, [
				h('h6', { text: 'Bulk Apply (IngestStates rules)' }),
				h('p', {
					class: 'msghub-muted',
					text: 'Apply the same MsgHub Custom config to many objects by pattern. Tip: configure one object manually, then import it and apply to a whole group.',
				}),
				h('div', { class: 'msghub-bulk-step' }, [
					h('div', { class: 'msghub-bulk-step-title', text: 'Step 1: get the base config' }),
					h('div', { class: 'row' }, [
						h('div', { class: 'input-field col s12 m8' }, [
							elSource,
							h('label', { class: 'active', text: 'Import from existing config (object id)' }),
						]),
						h('div', { class: 'col s12 m4 msghub-actions msghub-actions--inline' }, [btnLoad, btnGenerateEmpty]),
					]),
				]),
				h('div', { class: 'msghub-bulk-step' }, [
					h('div', { class: 'msghub-bulk-step-title', text: 'Step 2: define target' }),
					h('div', { class: 'row' }, [
						h('div', { class: 'input-field col s12' }, [
							elPattern,
							h('label', { class: 'active', text: 'Export to ids matching the following target pattern' }),
						]),
					]),
				]),
				h('div', { class: 'msghub-bulk-step' }, [
					h('div', { class: 'msghub-bulk-step-title', text: 'Step 3: review / modify settings' }),
					h('div', { class: 'row' }, [
						h('div', { class: 'col s12' }, [
							h('div', { class: 'msghub-bulk-apply-cols' }, [
								h('div', { class: 'msghub-bulk-apply-col' }, [
									h('div', { class: 'input-field' }, [
										elCustom,
										h('label', { class: 'active', text: `Custom config JSON (${adapterNamespace})` }),
									]),
								]),
								h('div', { class: 'msghub-bulk-apply-col' }, [
									h('div', { class: 'input-field' }, [
										elDescription,
										h('label', { class: 'active', text: 'Output of rule description' }),
									]),
								]),
							]),
						]),
						h('div', { class: 'col s12' }, [h('label', null, [elReplace, h('span', { text: ' ' }), elReplaceLabel])]),
					]),
				]),
				h('div', { class: 'msghub-bulk-step' }, [
					h('div', { class: 'msghub-bulk-step-title', text: 'Step 4: generate preview' }),
					h('div', { class: 'row' }, [
						h('div', { class: 'col s12 msghub-actions msghub-actions--inline' }, [btnPreview]),
						h('div', { class: 'col s12' }, [elStatus]),
						h('div', { class: 'col s12' }, [elPreview]),
					]),
				]),
				h('div', { class: 'msghub-bulk-step' }, [
					h('div', { class: 'msghub-bulk-step-title', text: 'Step 5: apply settings' }),
					h('div', { class: 'row' }, [
						h('div', { class: 'col s12 msghub-actions msghub-actions--inline' }, [btnApply]),
					]),
				]),
			]);
		}

		function renderPluginCard({ plugin, instances, refreshAll, refreshPlugin, expandedById, readmesByType }) {
			const label = formatPluginLabel(plugin);
			const desc = pickText(plugin?.description) || '';

			const instList = Array.isArray(instances) ? instances : [];
			const fields = getPluginFields(plugin);
			const instanceTitleKey = getInstanceTitleFieldKey(fields);
			const hasOptions = fields.length > 0;

			const readme = readmesByType instanceof Map ? readmesByType.get(String(plugin?.type || '')) : null;
			const hasReadme = !!readme?.md?.trim?.();

			const safeIdPart = String(plugin.type || 'plugin').replace(/[^A-Za-z0-9_-]/g, '_');
			const accId = `acc_${safeIdPart}_${adapterInstance}`;
			const isExpanded = expandedById instanceof Map ? expandedById.get(accId) : undefined;

			const total = instList.length;
			const runningCount = instList.filter(i => i?.status === 'running').length;
			const errorCount = instList.filter(i => i?.status === 'error').length;
			const stoppedCount = instList.filter(i => i?.status === 'stopped').length;

			const toPct = (count, denom) => {
				if (!denom || denom <= 0) {
					return 0;
				}
				return Math.max(0, Math.min(100, Math.round((count / denom) * 100)));
			};
			let pRunning = toPct(runningCount, total);
			let pError = toPct(errorCount, total);
			let pStopped = toPct(stoppedCount, total);
			if (total > 0) {
				pStopped = Math.max(0, Math.min(100, 100 - pRunning - pError));
			}

			const statusTitle = `${runningCount} running · ${errorCount} error · ${stoppedCount} stopped`;

			const openReadme = () => {
				const body = h('div', null, [
					readme?.source ? h('div', { class: 'msghub-muted msghub-readme-source', text: `Source: ${readme.source}` }) : null,
					hasReadme ? renderMarkdownLite(readme.md) : h('p', { class: 'msghub-muted', text: 'No guide available.' }),
				]);
				ensureReadmeModal().open({
					title: `${label.primary} · User Guide`,
					bodyEl: body,
				});
			};

			const openTools = () => {
				const hasInst0 = instList.some(i => i?.type === 'IngestStates' && i?.instanceId === 0);
				const inst0 = instList.find(i => i?.type === 'IngestStates' && i?.instanceId === 0) || null;
				if (!hasInst0) {
					try {
						M.toast({ html: 'IngestStates has no instance yet. Create and enable it first.' });
					} catch {
						// ignore
					}
					return;
				}
				if (inst0?.enabled !== true) {
					try {
						M.toast({ html: 'IngestStates is disabled. Enable the plugin to use Tools.' });
					} catch {
						// ignore
					}
					return;
				}

				const body = h('div', null, [h('p', { class: 'msghub-muted', text: 'Loading tools…' })]);
				ensureReadmeModal().open({
					title: `${label.primary} · Tools`,
					bodyEl: body,
				});

				Promise.resolve()
					.then(() => ensureIngestStatesSchema())
					.then(schema => {
						body.replaceChildren(renderIngestStatesBulkApply({ instances: instList, schema }));
					})
					.catch(err => {
						body.replaceChildren(
							h('div', { class: 'msghub-error', text: `Failed to load tools.\n${String(err?.message || err)}` }),
						);
					});
			};

			const header = h('div', { class: 'card-content msghub-card-head' }, [
				h('div', { class: 'msghub-card-headrow' }, [
					h('div', { class: 'msghub-card-headleft' }, [
						h('div', {
							class: 'msghub-status-ring',
							style: `--p-running: ${pRunning}; --p-error: ${pError}; --p-stopped: ${pStopped};`,
							title: statusTitle,
							'aria-label': statusTitle,
						}),
						h('span', { class: 'card-title', text: label.primary }),
					]),
					h('div', { class: 'msghub-card-headright' }, [
						h('a', {
							class: `msghub-info-btn${hasReadme ? '' : ' disabled'}`,
							href: '#',
							title: hasReadme ? 'User guide' : 'No user guide available',
							'aria-label': hasReadme ? 'User guide' : 'No user guide available',
							onclick: e => {
								e.preventDefault();
								if (!hasReadme) {
									return;
								}
								openReadme();
							},
							text: 'i',
						}),
						plugin?.type === 'IngestStates'
							? h('a', {
									class: 'msghub-tools-btn',
									href: '#',
									title: 'Tools',
									'aria-label': 'Tools',
									onclick: e => {
										e.preventDefault();
										openTools();
									},
									text: 'Tools',
								})
							: null,
						h('label', { class: 'msghub-acc-toggle', for: accId, text: 'Details' }),
					]),
				]),
				label.secondary ? h('p', { class: 'msghub-muted', text: label.secondary }) : null,
				desc ? h('p', { class: 'msghub-muted', text: desc }) : null,
			]);

			const body = h('div', { class: 'card-content' });
			const canAdd = plugin.supportsMultiple === true ? true : instList.length === 0;

			const actions = h('div', { class: 'msghub-actions' }, []);
			if (canAdd) {
				actions.appendChild(
					h('a', {
						class: 'btn',
						href: '#',
						onclick: async e => {
							e.preventDefault();
							await sendTo('admin.plugins.createInstance', {
								category: plugin.category,
								type: plugin.type,
							});
							await refreshPlugin(plugin.type);
						},
						text: 'Add instance',
					}),
				);
			}

			if (instList.length > 1) {
				const setAll = async enabled => {
					const links = Array.from(actions.querySelectorAll('a'));
					for (const a of links) {
						a.classList.add('disabled');
					}
					try {
						for (const inst of instList) {
							await sendTo('admin.plugins.setEnabled', {
								type: plugin.type,
								instanceId: inst.instanceId,
								enabled,
							});
						}
						await refreshPlugin(plugin.type);
					} finally {
						for (const a of links) {
							a.classList.remove('disabled');
						}
					}
				};

				actions.appendChild(
					h('a', {
						class: 'btn-flat',
						href: '#',
						onclick: async e => {
							e.preventDefault();
							if (e.currentTarget?.classList?.contains('disabled')) {
								return;
							}
							await setAll(true);
						},
						text: 'Enable all',
					}),
				);
				actions.appendChild(
					h('a', {
						class: 'btn-flat',
						href: '#',
						onclick: async e => {
							e.preventDefault();
							if (e.currentTarget?.classList?.contains('disabled')) {
								return;
							}
							await setAll(false);
						},
						text: 'Disable all',
					}),
				);
			}

			if (hasOptions && instList.length > 1) {
				const setAllInstances = open => {
					for (const el of body.querySelectorAll('.msghub-acc-input--instance')) {
						el.checked = open === true;
					}
				};
				actions.appendChild(
					h('a', {
						class: 'btn-flat',
						href: '#',
						onclick: e => {
							e.preventDefault();
							setAllInstances(true);
						},
						text: 'Expand instances',
					}),
				);
				actions.appendChild(
					h('a', {
						class: 'btn-flat',
						href: '#',
						onclick: e => {
							e.preventDefault();
							setAllInstances(false);
						},
						text: 'Collapse instances',
					}),
				);
			}

			body.appendChild(actions);

			if (instList.length === 0) {
				body.appendChild(h('p', { class: 'msghub-muted', text: 'No instances yet.' }));
			}

			for (const inst of instList) {
				const statusSafe = cssSafe(inst?.status || 'unknown');
				const instIdPart = String(inst.instanceId).replace(/[^0-9]/g, '') || '0';
				const instAccId = `acc_inst_${safeIdPart}_${instIdPart}_${adapterInstance}`;
				const instExpanded = expandedById instanceof Map ? expandedById.get(instAccId) : undefined;
				const instanceTitleValue = formatInstanceTitleValue({ inst, fieldKey: instanceTitleKey, plugin });

				const enabledId = `en_${plugin.type}_${inst.instanceId}`;
				const enabledInput = h('input', { type: 'checkbox', id: enabledId });
				enabledInput.checked = inst.enabled === true;
				const enabledLabel = h('label', { for: enabledId, text: 'Enabled' });
				const enabledWrap = h('p', null, [enabledInput, enabledLabel]);

				enabledInput.addEventListener('change', async () => {
					try {
						await sendTo('admin.plugins.setEnabled', {
							type: plugin.type,
							instanceId: inst.instanceId,
							enabled: enabledInput.checked,
						});
						await refreshPlugin(plugin.type);
					} catch (e) {
						enabledInput.checked = !enabledInput.checked;
						throw e;
					}
				});

				const instWrap = h('div', {
					class: [
						'msghub-instance',
						plugin.supportsMultiple === true ? 'msghub-instance--multi' : 'msghub-instance--single',
						`msghub-run-${statusSafe}`,
					].join(' '),
					'data-instance-id': String(inst.instanceId),
					'data-run-status': statusSafe,
				});

				if (hasOptions) {
					instWrap.appendChild(
						h('input', {
							class: 'msghub-acc-input msghub-acc-input--instance',
							type: 'checkbox',
							id: instAccId,
							checked: instExpanded === true ? '' : undefined,
						}),
					);
				}

				const headActions = h('div', { class: 'msghub-instance-actions' }, []);
				if (hasOptions) {
					headActions.appendChild(
						h('label', { class: 'msghub-acc-toggle msghub-acc-toggle--instance', for: instAccId, text: 'Options' }),
					);
				}
					headActions.appendChild(
						h('a', {
							class: 'btn-flat red-text',
						href: '#',
						onclick: async e => {
							e.preventDefault();
							const ok = await ensureDeleteModal().confirm();
							if (!ok) {
								return;
							}
							await sendTo('admin.plugins.deleteInstance', {
								type: plugin.type,
								instanceId: inst.instanceId,
							});
							await refreshPlugin(plugin.type);
						},
						text: 'Delete',
						}),
					);

					const wantsChannel = plugin.supportsChannelRouting === true;
					let channelRow = null;
					if (wantsChannel) {
						const channelId = `ch_${plugin.type}_${inst.instanceId}_${adapterInstance}`;
						const initialChannel = typeof inst.native?.channel === 'string' ? inst.native.channel : '';
						const channelInput = h('input', {
							type: 'text',
							id: channelId,
							class: 'msghub-instance-channel-input',
							placeholder: 'all',
						});
						channelInput.value = initialChannel;
						channelInput.setAttribute('data-prev', initialChannel);

						const saveChannel = async () => {
							const prev = channelInput.getAttribute('data-prev') || '';
							const next = String(channelInput.value || '').trim();
							if (next === prev) {
								return;
							}
							try {
								channelInput.setAttribute('data-prev', next);
								await sendTo('admin.plugins.updateInstance', {
									type: plugin.type,
									instanceId: inst.instanceId,
									nativePatch: { channel: next || null },
								});
								await refreshPlugin(plugin.type);
							} catch (e) {
								channelInput.value = prev;
								channelInput.setAttribute('data-prev', prev);
								M.toast({ html: `Failed to save channel: ${String(e?.message || e)}` });
							}
						};

						channelInput.addEventListener('keydown', e => {
							if (e.key === 'Enter') {
								e.preventDefault();
								channelInput.blur();
							}
						});
						channelInput.addEventListener('blur', () => saveChannel());
						channelInput.addEventListener('change', () => saveChannel());

						channelRow = h('div', { class: 'msghub-instance-channel' }, [
							h('span', { class: 'msghub-instance-channel-label', text: 'Channel:' }),
							channelInput,
						]);
					}

					const metaChildren = [
						h('div', { text: `Status: ${inst.status || 'unknown'}` }),
						instanceTitleValue ? h('div', { text: instanceTitleValue }) : null,
						channelRow,
					].filter(Boolean);

					const head = h('div', { class: 'msghub-instance-head' }, [
						h('div', { class: 'msghub-instance-title', text: `#${inst.instanceId}` }),
						h('div', { class: 'msghub-instance-enabled' }, [enabledWrap]),
						h('div', { class: 'msghub-instance-meta msghub-muted' }, metaChildren),
						headActions,
					]);

				instWrap.appendChild(head);

					if (hasOptions) {
						const bodyWrap = h('div', { class: 'msghub-instance-body' });
						const fieldsContainer = h('div', { class: 'msghub-instance-fields' });
						const inputs = {};
						const initial = {};

					const normalize = v => (v === undefined ? null : v);
					const isEqual = (a, b) => Object.is(a, b);

					let saveBtn = null;
					const setSaveEnabled = enabled => {
						if (!saveBtn) {
							return;
						}
						saveBtn.classList.toggle('disabled', enabled !== true);
						saveBtn.setAttribute('aria-disabled', enabled === true ? 'false' : 'true');
					};

					const isDirtyNow = () => {
						for (const [k, info] of Object.entries(inputs)) {
							const cur = normalize(info.getValue());
							const prev = normalize(initial[k]);
							if (!isEqual(cur, prev)) {
								return true;
							}
						}
						return false;
					};

					const updateDirtyUi = () => setSaveEnabled(isDirtyNow());

						for (const field of fields) {
							const key = field?.key;
							if (!key) {
								continue;
							}
							const effectiveValue =
								inst.native?.[key] !== undefined && inst.native?.[key] !== null
									? inst.native?.[key]
									: field.default;
							const unit = field?.unit;
							const { input, select, wrapper, getValue, skipSave } = buildFieldInput({
								type: field.type,
								key,
								label: field.type === 'header' ? pickText(field.label) || '' : pickText(field.label) || field.key,
								help: pickText(field.help) || '',
								value: effectiveValue,
								unit,
								min: field.min,
								max: field.max,
								step: field.step,
								options: field.options,
							});

							if (skipSave === true) {
								fieldsContainer.appendChild(wrapper);
								continue;
							}

							const valueGetter = typeof getValue === 'function' ? getValue : () => null;
							inputs[key] = { input, select, field, getValue: valueGetter };
							initial[key] = normalize(valueGetter());

							if (input?.tagName === 'SELECT') {
								input.addEventListener('change', updateDirtyUi);
							} else if (field.type === 'boolean') {
								input?.addEventListener?.('change', updateDirtyUi);
							} else {
								input?.addEventListener?.('input', updateDirtyUi);
								input?.addEventListener?.('change', updateDirtyUi);
							}
							if (select) {
								select.addEventListener('change', updateDirtyUi);
							}

							fieldsContainer.appendChild(wrapper);
					}

					saveBtn = h('a', {
						class: 'btn disabled',
						href: '#',
						onclick: async e => {
							e.preventDefault();
							if (saveBtn.classList.contains('disabled')) {
								return;
							}
							const patch = {};
							for (const [k, info] of Object.entries(inputs)) {
								patch[k] = info.getValue();
							}
							await sendTo('admin.plugins.updateInstance', {
								type: plugin.type,
								instanceId: inst.instanceId,
								nativePatch: patch,
							});
							await refreshPlugin(plugin.type);
						},
						text: 'Save options',
					});

					updateDirtyUi();

					bodyWrap.appendChild(fieldsContainer);
					bodyWrap.appendChild(h('div', { class: 'msghub-instance-save' }, [saveBtn]));
					instWrap.appendChild(bodyWrap);
				}

				body.appendChild(instWrap);
			}

			const catClass = typeof plugin?.category === 'string' ? `msghub-plugin-${cssSafe(plugin.category)}` : '';
			const multiClass = plugin.supportsMultiple === true ? 'msghub-plugin--multi' : 'msghub-plugin--single';

			return h('div', { class: `card msghub-plugin-card ${catClass} ${multiClass}`.trim(), 'data-plugin-type': plugin.type }, [
				h('input', {
					class: 'msghub-acc-input',
					type: 'checkbox',
					id: accId,
					checked: isExpanded === true ? '' : undefined,
				}),
				header,
				body,
			]);
		}

		let cachedPluginsWithUi = [];

		function buildInstancesByType(instances) {
			const byType = new Map();
			for (const inst of instances || []) {
				const list = byType.get(inst.type) || [];
				list.push(inst);
				byType.set(inst.type, list);
			}
			for (const list of byType.values()) {
				list.sort((a, b) => a.instanceId - b.instanceId);
			}
			return byType;
		}

		function getExistingCardForType(type) {
			if (!type) {
				return null;
			}
			for (const card of elRoot.querySelectorAll('.msghub-plugin-card')) {
				if (card.getAttribute('data-plugin-type') === type) {
					return card;
				}
			}
			return null;
		}

		async function refreshAll() {
			try {
				const expandedById = captureAccordionState();
				const { plugins } = await sendTo('admin.plugins.getCatalog', {});
				const { instances } = await sendTo('admin.plugins.listInstances', {});

				const readmesByType = await ensurePluginReadmesLoaded();

				const byType = buildInstancesByType(instances);

				const withUi = (plugins || []).filter(p => p && p.options && typeof p.options === 'object');
				cachedPluginsWithUi = withUi;
				const fragment = document.createDocumentFragment();

				if (withUi.length === 0) {
					fragment.appendChild(
						h('p', { class: 'msghub-muted', text: 'No plugins with Admin UI schema found yet.' }),
					);
				} else {
					const globalActions = h('div', { class: 'msghub-actions msghub-actions--global' }, [
						h('a', {
							class: 'btn-flat',
							href: '#',
							onclick: e => {
								e.preventDefault();
								for (const el of elRoot.querySelectorAll('.msghub-plugin-card > .msghub-acc-input')) {
									el.checked = true;
								}
							},
							text: 'Expand all plugins',
						}),
						h('a', {
							class: 'btn-flat',
							href: '#',
							onclick: e => {
								e.preventDefault();
								for (const el of elRoot.querySelectorAll('.msghub-plugin-card > .msghub-acc-input')) {
									el.checked = false;
								}
							},
							text: 'Collapse all plugins',
						}),
					]);
					fragment.appendChild(globalActions);

					const byCategory = new Map();
					for (const p of withUi) {
						const c = typeof p?.category === 'string' ? p.category : 'unknown';
						const list = byCategory.get(c) || [];
						list.push(p);
						byCategory.set(c, list);
					}

					for (const category of CATEGORY_ORDER) {
						const list = byCategory.get(category) || [];
						list.sort((a, b) => String(a?.type || '').localeCompare(String(b?.type || '')));
						if (list.length === 0) {
							continue;
						}

						const section = h('div', { class: 'msghub-plugin-category', 'data-category': category }, [
							h('h6', { class: 'msghub-plugin-category-title', text: CATEGORY_TITLES[category] || category }),
						]);

						for (const plugin of list) {
							section.appendChild(
								renderPluginCard({
									plugin,
									instances: byType.get(plugin.type) || [],
									refreshAll,
									refreshPlugin,
									expandedById,
									readmesByType,
								}),
							);
						}
						fragment.appendChild(section);
					}
				}

				elRoot.replaceChildren(fragment);
				M.updateTextFields();
			} catch (e) {
				elRoot.replaceChildren(
					h('div', {
						class: 'msghub-error',
						text: `Failed to load plugin config.\n${String(e?.message || e)}`,
					}),
				);
			}
		}

		async function refreshPlugin(type) {
			if (!type) {
				return refreshAll();
			}

			const plugin = cachedPluginsWithUi.find(p => p?.type === type);
			if (!plugin) {
				return refreshAll();
			}

			try {
				const expandedById = captureAccordionState();
				const { instances } = await sendTo('admin.plugins.listInstances', {});
				const byType = buildInstancesByType(instances);
				const readmesByType = await ensurePluginReadmesLoaded();

				const nextCard = renderPluginCard({
					plugin,
					instances: byType.get(plugin.type) || [],
					refreshAll,
					refreshPlugin,
					expandedById,
					readmesByType,
				});

				const existing = getExistingCardForType(type);
				if (!existing) {
					return refreshAll();
				}
				existing.replaceWith(nextCard);
				M.updateTextFields();
			} catch (e) {
				return refreshAll();
			}
		}

		return {
			onConnect: () => refreshAll().catch(() => undefined),
			refreshPlugin: type => refreshPlugin(type).catch(() => undefined),
		};
	}

	win.MsghubAdminTabPlugins = Object.freeze({
		init: initPluginConfigSection,
	});
})();
