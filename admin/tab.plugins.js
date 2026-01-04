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

		const captureAccordionState = () => {
			const map = new Map();
			for (const el of elRoot.querySelectorAll('.msghub-acc-input')) {
				if (el && typeof el.id === 'string' && el.id) {
					map.set(el.id, el.checked === true);
				}
			}
			return map;
		};

		function buildFieldInput({ type, key, label, value, help, unit, min, max, step }) {
			const id = `f_${key}_${Math.random().toString(36).slice(2, 8)}`;

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

		function renderPluginCard({ plugin, instances, refreshAll, refreshPlugin, expandedById }) {
			const label = formatPluginLabel(plugin);
			const desc = pickText(plugin?.description) || '';

			const instList = Array.isArray(instances) ? instances : [];
			const fields = getPluginFields(plugin);
			const instanceTitleKey = getInstanceTitleFieldKey(fields);
			const hasOptions = fields.length > 0;

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
					h('label', { class: 'msghub-acc-toggle', for: accId, text: 'Details' }),
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

				const head = h('div', { class: 'msghub-instance-head' }, [
					h('div', { class: 'msghub-instance-title', text: `#${inst.instanceId}` }),
					h('div', { class: 'msghub-instance-enabled' }, [enabledWrap]),
					h('div', {
						class: 'msghub-instance-status msghub-muted',
						text: `Status: ${inst.status || 'unknown'}`,
					}),
					h('div', {
						class: 'msghub-instance-detail msghub-muted',
						text: instanceTitleValue,
					}),
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
						const { input, select, wrapper, getValue } = buildFieldInput({
							type: field.type,
							key,
							label: pickText(field.label) || field.key,
							help: pickText(field.help) || '',
							value: effectiveValue,
							unit,
							min: field.min,
							max: field.max,
							step: field.step,
						});

						const valueGetter = typeof getValue === 'function' ? getValue : () => null;
						inputs[key] = { input, select, field, getValue: valueGetter };
						initial[key] = normalize(valueGetter());

						if (field.type === 'boolean') {
							input.addEventListener('change', updateDirtyUi);
						} else {
							input.addEventListener('input', updateDirtyUi);
							input.addEventListener('change', updateDirtyUi);
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

				const nextCard = renderPluginCard({
					plugin,
					instances: byType.get(plugin.type) || [],
					refreshAll,
					refreshPlugin,
					expandedById,
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
