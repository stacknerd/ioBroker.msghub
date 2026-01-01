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

		const captureAccordionState = () => {
			const map = new Map();
			for (const el of elRoot.querySelectorAll('.msghub-acc-input')) {
				if (el && typeof el.id === 'string' && el.id) {
					map.set(el.id, el.checked === true);
				}
			}
			return map;
		};

		function buildFieldInput({ type, key, label, value, help }) {
			const id = `f_${key}_${Math.random().toString(36).slice(2, 8)}`;

			if (type === 'boolean') {
				const input = h('input', { type: 'checkbox', id });
				input.checked = value === true;
				return {
					input,
					wrapper: h('div', null, [
						h('p', null, [input, h('label', { for: id, text: label || key })]),
						help ? h('div', { class: 'msghub-muted', text: help }) : null,
					]),
				};
			}

			const input = h('input', { type: type === 'number' ? 'number' : 'text', id, value: value ?? '' });
			return {
				input,
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

		function renderPluginCard({ plugin, instances, refreshAll, refreshPlugin, expandedById }) {
			const title = pickText(plugin?.title) || plugin.type;
			const desc = pickText(plugin?.description) || '';

			const instList = Array.isArray(instances) ? instances : [];

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
						h('span', { class: 'card-title', text: title }),
					]),
					h('label', { class: 'msghub-acc-toggle', for: accId, text: 'Details' }),
				]),
				desc ? h('p', { class: 'msghub-muted', text: desc }) : null,
			]);

			const body = h('div', { class: 'card-content' });
			const canAdd = plugin.supportsMultiple === true || instList.length === 0;

			const actions = h('div', { class: 'msghub-actions' }, [
				h(
					'a',
					{
						class: `btn ${canAdd ? '' : 'disabled'}`,
						href: '#',
						onclick: async e => {
							e.preventDefault();
							if (!canAdd) {
								return;
							}
							await sendTo('admin.plugins.createInstance', {
								category: plugin.category,
								type: plugin.type,
							});
							await refreshPlugin(plugin.type);
						},
						text: 'Add instance',
					},
					null,
				),
			]);
			body.appendChild(actions);

			if (instList.length === 0) {
				body.appendChild(h('p', { class: 'msghub-muted', text: 'No instances yet.' }));
			}

			for (const inst of instList) {
				const row = h('div', { class: 'msghub-instance-row' });
				row.appendChild(
					h('div', { class: 'msghub-instance-meta' }, [h('div', { text: `#${inst.instanceId}` })]),
				);

				const enabledId = `en_${plugin.type}_${inst.instanceId}`;
				const enabledInput = h('input', { type: 'checkbox', id: enabledId });
				enabledInput.checked = inst.enabled === true;
				const enabledLabel = h('label', { for: enabledId, text: 'Enabled' });
				const enabledWrap = h('p', null, [enabledInput, enabledLabel]);

				const meta = h('div', { class: 'msghub-instance-meta' }, [
					enabledWrap,
					h('div', { class: 'msghub-muted', text: `Status: ${inst.status || 'unknown'}` }),
					h(
						'a',
						{
							class: 'btn-flat red-text',
							href: '#',
							onclick: async e => {
								e.preventDefault();
								await sendTo('admin.plugins.deleteInstance', {
									type: plugin.type,
									instanceId: inst.instanceId,
								});
								await refreshPlugin(plugin.type);
							},
							text: 'Delete',
						},
						null,
					),
				]);
				row.appendChild(meta);

				const fieldsContainer = h('div', { class: 'msghub-instance-fields' });
				const inputs = {};
				const fields = getPluginFields(plugin);
				for (const field of fields) {
					const key = field?.key;
					if (!key) {
						continue;
					}
					const effectiveValue =
						inst.native?.[key] !== undefined && inst.native?.[key] !== null
							? inst.native?.[key]
							: field.default;
					const { input, wrapper } = buildFieldInput({
						type: field.type,
						key,
						label: pickText(field.label) || field.key,
						help: pickText(field.help) || '',
						value: effectiveValue,
					});
					if (field.type === 'number') {
						if (field.min !== undefined) {
							input.setAttribute('min', String(field.min));
						}
						if (field.max !== undefined) {
							input.setAttribute('max', String(field.max));
						}
						if (field.step !== undefined) {
							input.setAttribute('step', String(field.step));
						}
					}
					inputs[key] = { input, field };
					fieldsContainer.appendChild(wrapper);
				}

				const saveBtn = h('a', {
					class: 'btn',
					href: '#',
					onclick: async e => {
						e.preventDefault();
						const patch = {};
						for (const [k, info] of Object.entries(inputs)) {
							const t = info.field.type;
							if (t === 'boolean') {
								patch[k] = info.input.checked === true;
							} else if (t === 'number') {
								const raw = info.input.value;
								if (raw === '') {
									patch[k] = null;
								} else {
									const n = Number(raw);
									patch[k] = Number.isFinite(n) ? n : null;
								}
							} else {
								patch[k] = info.input.value;
							}
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

				const right = h('div', null, [fieldsContainer, h('div', { style: 'margin-top: 8px;' }, [saveBtn])]);
				row.appendChild(right);

				body.appendChild(row);
			}

			return h('div', { class: 'card msghub-plugin-card', 'data-plugin-type': plugin.type }, [
				h('input', {
					class: 'msghub-acc-input',
					type: 'checkbox',
					id: accId,
					checked: isExpanded === false ? undefined : '',
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
					for (const plugin of withUi) {
						fragment.appendChild(
							renderPluginCard({
								plugin,
								instances: byType.get(plugin.type) || [],
								refreshAll,
								refreshPlugin,
								expandedById,
							}),
						);
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
