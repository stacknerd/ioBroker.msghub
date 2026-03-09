/// <reference lib="dom" />
/* global window */
(function () {
	'use strict';

	const win = window;

	/**
	 * Form builder module for the plugins panel.
	 *
	 * Contains:
	 * - `resolveDynamicOptions` — resolves MsgConstants references to option arrays.
	 * - `parseCsvValues` — splits a comma-separated string into trimmed tokens.
	 * - `buildFieldInput` — builds a typed form field DOM element with getValue accessor.
	 * - `getPluginFields` — extracts and sorts the field list from a plugin spec.
	 * - `getInstanceTitleFieldKey` — finds the field key flagged as the instance title.
	 * - `formatInstanceTitleValue` — formats the instance title value for display.
	 *
	 * Integration:
	 * - Depends on `state.js` utilities injected via factory options.
	 * - Consumed by `index.js` via the formApi instance.
	 * - Loaded before `index.js` (registry load order).
	 *
	 * Public API:
	 * - `createPluginsFormApi(options)`
	 */

	/**
	 * Creates the plugins form builder facade for one panel instance.
	 *
	 * @param {object} options - Factory options.
	 * @param {Function} options.h - DOM element builder (ctx.h).
	 * @param {Function} options.pickText - i18n pick-text helper (api.i18n.pickText).
	 * @param {Function} options.getConstants - Lazy getter returning the current cached
	 *   MsgConstants object (or null). Called at resolution time, not factory creation.
	 * @param {Function} options.normalizeUnit - From state.js.
	 * @param {Function} options.isUnitless - From state.js.
	 * @param {Function} options.pickDefaultTimeUnit - From state.js.
	 * @param {Function} options.getTimeFactor - From state.js.
	 * @param {Array}    options.TIME_UNITS - From state.js.
	 * @param {Function} options.pick - Deep-path getter from state.js.
	 * @returns {object} Frozen form builder facade.
	 */
	function createPluginsFormApi(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const h = opts.h;
		const pickText = opts.pickText;
		const getConstants = typeof opts.getConstants === 'function' ? opts.getConstants : () => null;
		const normalizeUnit = typeof opts.normalizeUnit === 'function' ? opts.normalizeUnit : () => '';
		const isUnitless = typeof opts.isUnitless === 'function' ? opts.isUnitless : () => true;
		const pickDefaultTimeUnit =
			typeof opts.pickDefaultTimeUnit === 'function' ? opts.pickDefaultTimeUnit : () => 'ms';
		const getTimeFactor = typeof opts.getTimeFactor === 'function' ? opts.getTimeFactor : () => 1;
		const TIME_UNITS = Array.isArray(opts.TIME_UNITS) ? opts.TIME_UNITS : [];
		const pick = typeof opts.pick === 'function' ? opts.pick : () => undefined;

		/**
		 * Infers the effective time unit for a number field from legacy schema hints.
		 *
		 * @param {object} params - Destructured field descriptor.
		 * @param {string} params.key - Field key (e.g. "delayMs").
		 * @param {object} params.field - Field spec object.
		 * @returns {string} Normalized unit string, or empty string if none detected.
		 */
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

		/**
		 * Resolves a MsgConstants reference or plain array into a normalized option list.
		 *
		 * Reads `MsgConstants` lazily via `getConstants()` at call time.
		 *
		 * @param {Array|string} options - Plain option array or "MsgConstants.some.path" string.
		 * @returns {Array<{label:string,value:*,fallbackLabel?:string}>} Resolved options.
		 */
		function resolveDynamicOptions(options) {
			if (Array.isArray(options)) {
				return options;
			}
			const src = typeof options === 'string' ? options.trim() : '';
			if (!src || !src.startsWith('MsgConstants.')) {
				return [];
			}

			const path = src.slice('MsgConstants.'.length);
			const constants = getConstants();
			const obj = constants && typeof constants === 'object' ? pick(constants, path) : null;
			if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
				return [];
			}

			const entries = Object.entries(obj).filter(([_k, v]) => typeof v === 'string' || typeof v === 'number');

			const allNumbers = entries.every(([_k, v]) => typeof v === 'number' && Number.isFinite(v));
			if (allNumbers) {
				entries.sort((a, b) => Number(a[1]) - Number(b[1]));
			} else {
				entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
			}

			return entries.map(([k, v]) => ({
				label: `msghub.i18n.core.admin.common.${src}.${k}.label`,
				value: v,
				fallbackLabel: k,
			}));
		}

		/**
		 * Splits a comma-separated string into an array of trimmed, non-empty tokens.
		 *
		 * @param {string|*} csv - Input value.
		 * @returns {string[]} Trimmed tokens.
		 */
		function parseCsvValues(csv) {
			const s = typeof csv === 'string' ? csv : csv == null ? '' : String(csv);
			return s
				.split(',')
				.map(x => x.trim())
				.filter(Boolean);
		}

		/**
		 * Builds a typed form field element with a getValue accessor.
		 *
		 * Supported field types: header, string (plain/multiselect/select), number
		 * (plain/time-unit), boolean, and a plain text fallback.
		 *
		 * The first argument is the field config object with: type, key, label, value,
		 * help, unit, min, max, step, options, multiOptions.
		 *
		 * @param {...any} args - Positional arguments; args[0] is the field config object.
		 * @returns {{input?:object,select?:object,wrapper:object,getValue?:Function,skipSave?:boolean}} Field element bundle.
		 */
		function buildFieldInput(...args) {
			const cfg = args && args.length ? args[0] : null;
			const c = cfg && typeof cfg === 'object' ? cfg : {};

			const type = c && typeof c === 'object' && 'type' in c ? c.type : '';
			const keyRaw = c && typeof c === 'object' && 'key' in c ? c.key : '';
			const key = typeof keyRaw === 'string' ? keyRaw : String(keyRaw ?? '');

			const label = c && typeof c === 'object' && 'label' in c ? c.label : '';
			const value = c && typeof c === 'object' && 'value' in c ? c.value : '';
			const help = c && typeof c === 'object' && 'help' in c ? c.help : '';
			const unit = c && typeof c === 'object' && 'unit' in c ? c.unit : '';
			const min = c && typeof c === 'object' && 'min' in c ? c.min : undefined;
			const max = c && typeof c === 'object' && 'max' in c ? c.max : undefined;
			const step = c && typeof c === 'object' && 'step' in c ? c.step : undefined;
			const options = c && typeof c === 'object' && 'options' in c ? c.options : undefined;
			const multiOptions = c && typeof c === 'object' && 'multiOptions' in c ? c.multiOptions : undefined;

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

			const multiOptionList =
				typeof multiOptions === 'string'
					? resolveDynamicOptions(multiOptions).filter(o => o && typeof o === 'object')
					: [];
			if (type === 'string' && multiOptionList.length > 0) {
				const input = h('select', { id, multiple: 'multiple' });

				const normalized = multiOptionList
					.map(o => ({
						label: (() => {
							const raw = pickText(o.label);
							if (raw === o.label && typeof o.fallbackLabel === 'string' && o.fallbackLabel.trim()) {
								return o.fallbackLabel.trim();
							}
							return raw || (o.value !== undefined ? String(o.value) : '');
						})(),
						value: o.value,
					}))
					.filter(o => o.value !== undefined && o.value !== null);

				const valueSet = new Set(normalized.map(o => String(o.value)));
				const selected = new Set(parseCsvValues(value).map(String));

				for (const v of selected) {
					if (!valueSet.has(v)) {
						input.appendChild(h('option', { value: v, text: v }));
					}
				}

				for (const opt of normalized) {
					input.appendChild(h('option', { value: String(opt.value), text: opt.label }));
				}

				for (const opt of input.options) {
					opt.selected = selected.has(String(opt.value));
				}

				return {
					input,
					getValue: () =>
						Array.from(input.selectedOptions || [])
							.map(o => String(o.value))
							.filter(Boolean)
							.join(','),
					wrapper: h('div', { class: 'msghub-field msghub-field-select' }, [
						input,
						h('label', { for: id, text: label || key }),
						help ? h('div', { class: 'msghub-muted', text: help }) : null,
					]),
				};
			}

			const optionList = resolveDynamicOptions(options).filter(o => o && typeof o === 'object');
			if ((type === 'string' || type === 'number') && optionList.length > 0) {
				const input = h('select', { id });

				const normalized = optionList
					.map(o => ({
						label: (() => {
							const raw = pickText(o.label);
							if (raw === o.label && typeof o.fallbackLabel === 'string' && o.fallbackLabel.trim()) {
								return o.fallbackLabel.trim();
							}
							return raw || (o.value !== undefined ? String(o.value) : '');
						})(),
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
					value === undefined || value === null || value === ''
						? ''
						: valueSet.has(String(value))
							? String(value)
							: String(value);
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
					wrapper: h('div', { class: 'msghub-field msghub-field-select' }, [
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
						wrapper: h('div', { class: 'msghub-field msghub-field-time' }, [
							h('div', { class: 'msghub-field-time-row' }, [input, select]),
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
					wrapper: h('div', { class: 'msghub-field msghub-field-number' }, [
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
				wrapper: h('div', { class: 'msghub-field' }, [
					input,
					h('label', { for: id, text: label || key }),
					help ? h('div', { class: 'msghub-muted', text: help }) : null,
				]),
			};
		}

		/**
		 * Extracts and sorts the field list from a plugin catalog entry.
		 *
		 * @param {object} plugin - Plugin catalog entry with an `options` object.
		 * @returns {Array<object>} Fields sorted by `order` then key.
		 */
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

		/**
		 * Returns the key of the first field flagged as `holdsInstanceTitle`.
		 *
		 * @param {Array<object>} fields - Sorted field list from getPluginFields.
		 * @returns {string} Field key, or empty string if none is flagged.
		 */
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

		/**
		 * Formats the instance title value for display in the instance card header.
		 *
		 * @param {object} params - Destructured instance descriptor.
		 * @param {object} params.inst - Plugin instance object with a `native` map.
		 * @param {string} params.fieldKey - Field key holding the title value.
		 * @param {object} params.plugin - Plugin catalog entry (used to look up defaults).
		 * @returns {string} Formatted title, truncated at 60 characters.
		 */
		function formatInstanceTitleValue({ inst, fieldKey, plugin }) {
			if (!fieldKey) {
				return '';
			}
			const spec = plugin?.options?.[fieldKey];
			const fallback = spec && typeof spec === 'object' ? spec.default : undefined;
			const raw =
				inst?.native?.[fieldKey] !== undefined && inst?.native?.[fieldKey] !== null
					? inst.native[fieldKey]
					: fallback;
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

		return Object.freeze({
			buildFieldInput,
			parseCsvValues,
			getPluginFields,
			getInstanceTitleFieldKey,
			formatInstanceTitleValue,
			resolveDynamicOptions,
		});
	}

	win.MsghubAdminTabPluginsForm = Object.freeze({ createPluginsFormApi });
})();
