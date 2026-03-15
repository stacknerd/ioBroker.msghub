/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/* global window */
(function () {
	'use strict';

	const win = window;

	/**
	 * Creates the instance-row rendering API used by the plugins panel.
	 *
	 * @param {object} options Factory options.
	 * @returns {object} Frozen instance API.
	 */
	function createPluginsInstanceApi(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const h = typeof opts.h === 'function' ? opts.h : () => ({});
		const t = typeof opts.t === 'function' ? opts.t : k => k;
		const cssSafe = typeof opts.cssSafe === 'function' ? opts.cssSafe : s => String(s || '');
		const pickText = typeof opts.pickText === 'function' ? opts.pickText : v => String(v ?? '');
		const formApi = opts.formApi || null;
		const catalogApi = opts.catalogApi || null;
		const openContextMenu = typeof opts.openContextMenu === 'function' ? opts.openContextMenu : () => {};
		const pluginsDataApi = opts.pluginsDataApi || null;
		const ingestStatesDataApi = opts.ingestStatesDataApi || null;
		const ui = opts.ui || null;
		const toast = typeof opts.toast === 'function' ? opts.toast : () => {};
		const confirmDialog = typeof opts.confirmDialog === 'function' ? opts.confirmDialog : async () => false;
		const onRefreshAll = typeof opts.onRefreshAll === 'function' ? opts.onRefreshAll : async () => {};
		const adapterInstance = Number.isFinite(opts.adapterInstance) ? Math.trunc(opts.adapterInstance) : 0;
		// renderBulkApply and renderPresets are inline stubs until Etappe 7 extracts them.
		const renderBulkApply = typeof opts.renderBulkApply === 'function' ? opts.renderBulkApply : () => h('div');
		const renderPresets = typeof opts.renderPresets === 'function' ? opts.renderPresets : () => h('div');

		function renderInstanceRow({ plugin, inst, instList, expandedById, readmesByType }) {
			const statusSafe = cssSafe(inst?.status || 'unknown');
			const stateClass = `msghub-plugin-state-${statusSafe}`;
			const categoryRaw = typeof plugin?.category === 'string' ? plugin.category : 'unknown';
			const categorySafe = cssSafe(categoryRaw);

			const fields = formApi ? formApi.getPluginFields(plugin) : [];
			const instanceTitleKey = formApi ? formApi.getInstanceTitleFieldKey(fields) : '';
			const hasOptions = fields.length > 0;
			const instAccKey = catalogApi
				? catalogApi.toAccKey({ kind: 'inst', type: plugin.type, instanceId: inst.instanceId })
				: '';
			const hasExpandedById = expandedById && typeof expandedById.get === 'function';
			const instExpanded = hasExpandedById ? expandedById.get(instAccKey) : undefined;

			const hasReadmeMap = readmesByType && typeof readmesByType.get === 'function';
			const readme = hasReadmeMap ? readmesByType.get(String(plugin?.type || '')) : null;
			const hasReadme = !!readme?.md?.trim?.();

			const instanceTitleValue = formApi
				? formApi.formatInstanceTitleValue({ inst, fieldKey: instanceTitleKey, plugin })
				: '';
			const wantsChannel = plugin.supportsChannelRouting === true;
			const instanceName = `${plugin.type}.${inst.instanceId}`;

			const openReadme = () => {
				if (!hasReadme) {
					return;
				}
				const body = h('div', null, [
					readme?.source
						? h('div', { class: 'msghub-muted msghub-readme-source', text: `Source: ${readme.source}` })
						: null,
					catalogApi ? catalogApi.renderMarkdownLite(readme.md) : null,
				]);
				if (catalogApi) {
					catalogApi.openViewer({
						title: `${plugin.type} · User Guide`,
						bodyEl: body,
					});
				}
			};

			const hasToolsAvailable = (() => {
				if (plugin?.type !== 'IngestStates') {
					return false;
				}
				const inst0 = Array.isArray(instList) ? instList.find(i => i?.instanceId === 0) : null;
				return inst0?.enabled === true;
			})();

			const getToolsMenuConfig = () => {
				if (plugin?.type !== 'IngestStates' || !hasToolsAvailable) {
					return { isAvailable: false, items: [] };
				}

				const openIngestStatesTool = toolId => {
					const body = h('div', null, [
						h('p', {
							class: 'msghub-muted',
							text: t('msghub.i18n.core.admin.ui.plugins.tools.loading.text'),
						}),
					]);
					if (catalogApi) {
						catalogApi.openViewer({
							title: `${plugin.type} · Tools`,
							bodyEl: body,
						});
					}

					Promise.resolve()
						.then(async () => {
							await pluginsDataApi?.ensureConstantsLoaded?.();
							const ingestConstants = await ingestStatesDataApi?.ensureIngestStatesConstantsLoaded?.();
							if (toolId === 'bulk') {
								const schema = await ingestStatesDataApi?.ensureIngestStatesSchema?.();
								body.replaceChildren(renderBulkApply({ instances: instList, schema, ingestConstants }));
								return;
							}
							if (toolId === 'presets') {
								body.replaceChildren(renderPresets({ ingestConstants }));
								return;
							}
							body.replaceChildren(h('p', { class: 'msghub-muted', text: '' }));
						})
						.catch(err => {
							body.replaceChildren(
								h('div', {
									class: 'msghub-error',
									text: t(
										'msghub.i18n.core.admin.ui.plugins.tools.loadFailed.text',
										String(err?.message || err),
									),
								}),
							);
						});
				};

				return {
					isAvailable: true,
					items: [
						{
							id: 'ingeststates_bulk',
							label: t('msghub.i18n.core.admin.ui.plugins.tools.ingestStates.bulk.label'),
							onSelect: () => openIngestStatesTool('bulk'),
						},
						{
							id: 'ingeststates_presets',
							label: t('msghub.i18n.core.admin.ui.plugins.tools.ingestStates.presets.label'),
							onSelect: () => openIngestStatesTool('presets'),
						},
					],
				};
			};

			const openToolsMenu = (anchorEl, e) => {
				const cfg = getToolsMenuConfig();
				if (!cfg.isAvailable) {
					return;
				}
				if (!ui?.contextMenu?.open) {
					return;
				}
				const menuAnchor = anchorEl && typeof anchorEl === 'object' ? anchorEl : null;
				ui.contextMenu.open({
					anchorEl: menuAnchor,
					anchorPoint: !menuAnchor && e ? { x: e.clientX, y: e.clientY } : null,
					ariaLabel: 'Plugin context menu',
					placement: 'bottom-start',
					items: cfg.items,
				});
			};

			const instWrap = h('div', {
				class: [
					'msghub-instance',
					'msghub-plugin-instance',
					plugin.supportsMultiple === true ? 'msghub-instance--multi' : 'msghub-instance--single',
					`msghub-run-${statusSafe}`,
					stateClass,
				].join(' '),
				'data-instance-id': String(inst.instanceId),
				'data-run-status': statusSafe,
				'data-enabled': inst?.enabled === true ? '1' : '0',
				'data-plugin-type': String(plugin.type || ''),
				'data-plugin-category': categorySafe,
			});

			const accId = `acc_inst_${String(plugin.type || 'plugin').replace(/[^A-Za-z0-9_-]/g, '_')}_${String(inst.instanceId).replace(/[^0-9]/g, '') || '0'}_${adapterInstance}`;
			let accInput = null;
			if (hasOptions) {
				accInput = h('input', {
					class: 'msghub-acc-input msghub-acc-input--instance',
					type: 'checkbox',
					id: accId,
					'data-acc-key': instAccKey,
					checked: instExpanded === true ? '' : undefined,
				});
				instWrap.appendChild(accInput);
			}

			const statusRaw = typeof inst?.status === 'string' ? inst.status.trim() : '';
			const statusText = statusRaw || t('msghub.i18n.core.admin.ui.plugins.instance.status.unknown');
			const statusTitle = t('msghub.i18n.core.admin.ui.plugins.instance.status.title', statusText);
			const statusEl = h('div', {
				class: 'msghub-instance-status',
				title: statusTitle,
				'aria-label': statusTitle,
			});
			const iconSlot = h('div', { class: 'msghub-instance-icon-slot', 'aria-hidden': 'true' });
			const nameEl = h('div', { class: 'msghub-instance-name', text: `${plugin.type}.${inst.instanceId}` });

			const toggleLabel =
				inst?.enabled === true
					? t('msghub.i18n.core.admin.ui.plugins.instance.action.stop')
					: t('msghub.i18n.core.admin.ui.plugins.instance.action.start');
			const toggleBtn = h('button', {
				type: 'button',
				class: 'msghub-instance-toggle msghub-uibutton-icon',
				title: toggleLabel,
				'aria-label': toggleLabel,
				text: inst?.enabled === true ? '⏸' : '▶',
				onclick: async () => {
					await pluginsDataApi?.setEnabled?.({
						type: plugin.type,
						instanceId: inst.instanceId,
						enabled: inst?.enabled !== true,
					});
					await onRefreshAll();
				},
			});

			const helpBtn = h('button', {
				type: 'button',
				class: `msghub-instance-help msghub-uibutton-icon${hasReadme ? '' : ' is-invisible'}`,
				disabled: hasReadme ? undefined : true,
				title: hasReadme ? t('msghub.i18n.core.admin.ui.plugins.instance.help.button') : '',
				'aria-label': t('msghub.i18n.core.admin.ui.plugins.instance.help.button'),
				text: 'i',
				onclick: () => openReadme(),
			});

			const toolsBtn = h('button', {
				type: 'button',
				class: `msghub-instance-tools msghub-uibutton-icon${hasToolsAvailable ? '' : ' is-invisible'}`,
				disabled: hasToolsAvailable ? undefined : true,
				title: hasToolsAvailable ? t('msghub.i18n.core.admin.ui.plugins.instance.tools.button') : '',
				'aria-label': t('msghub.i18n.core.admin.ui.plugins.instance.tools.button'),
				text: t('msghub.i18n.core.admin.ui.plugins.instance.tools.button'),
				onclick: e => openToolsMenu(toolsBtn, e),
				oncontextmenu: e => {
					e?.preventDefault?.();
					e?.stopPropagation?.();
					openToolsMenu(toolsBtn, e);
				},
			});

			const channelId = `ch_${plugin.type}_${inst.instanceId}_${adapterInstance}`;
			const channelValue = typeof inst.native?.channel === 'string' ? inst.native.channel : '';
			const channelEl = wantsChannel
				? (() => {
						const input = h('input', {
							type: 'text',
							id: channelId,
							class: 'msghub-instance-channel-input',
							// Intentionally hard-coded: this is also the default filter value (must be "all", not translated).
							placeholder: 'all',
							value: channelValue,
						});
						input.setAttribute('data-prev', channelValue);

						const saveChannel = async () => {
							const prev = input.getAttribute('data-prev') || '';
							const next = String(input.value || '').trim();
							if (next === prev) {
								return;
							}
							try {
								input.setAttribute('data-prev', next);
								await pluginsDataApi?.updateInstance?.({
									type: plugin.type,
									instanceId: inst.instanceId,
									nativePatch: { channel: next || null },
								});
							} catch (e) {
								input.value = prev;
								input.setAttribute('data-prev', prev);
								toast(
									t(
										'msghub.i18n.core.admin.ui.plugins.instance.channel.saveFailed.text',
										String(e?.message || e),
									),
									'danger',
								);
							}
						};

						input.addEventListener('keydown', e => {
							if (e.key === 'Enter') {
								e.preventDefault();
								input.blur();
							}
						});
						input.addEventListener('blur', () => saveChannel());
						input.addEventListener('change', () => saveChannel());

						return input;
					})()
				: h('span', { class: 'msghub-instance-channel-text' });

			const titleValueEl = h('div', {
				class: `msghub-instance-titlevalue${instanceTitleValue ? '' : ' is-invisible'}`,
				text: instanceTitleValue || '—',
				title: instanceTitleValue || '',
			});

			const chevron = hasOptions
				? h('label', { class: 'msghub-acc-toggle msghub-acc-toggle--instance', for: accId, text: '▾' })
				: h('span', { class: 'msghub-acc-toggle msghub-acc-toggle--instance is-invisible', text: '▾' });

			const head = h('div', { class: 'msghub-instance-head' }, [
				statusEl,
				iconSlot,
				nameEl,
				toggleBtn,
				helpBtn,
				toolsBtn,
				titleValueEl,
				channelEl,
				chevron,
			]);

			const removeInstance = async () => {
				const name = instanceName;
				const ok = await confirmDialog({
					title: t('msghub.i18n.core.admin.ui.plugins.contextMenu.remove.title'),
					text: t('msghub.i18n.core.admin.ui.plugins.contextMenu.remove.text', name),
				});
				if (!ok) {
					return;
				}
				await pluginsDataApi?.deleteInstance?.({ type: plugin.type, instanceId: inst.instanceId });
				await onRefreshAll();
			};

			const instanceMenuCtx = Object.freeze({
				kind: 'instance',
				instWrap,
				instanceName,
				pluginType: String(plugin.type || ''),
				categoryRaw,
				categorySafe,
				hasReadme: hasReadme === true,
				hasToolsAvailable: hasToolsAvailable === true,
				toolsItems: getToolsMenuConfig().items,
				openReadme,
				removeInstance,
			});

			head.oncontextmenu = e => openContextMenu(e, instanceMenuCtx);

			if (accInput) {
				head.setAttribute('role', 'button');
				head.setAttribute('tabindex', '0');
				head.setAttribute('aria-controls', accId);

				const syncAriaExpanded = () => {
					head.setAttribute('aria-expanded', accInput.checked === true ? 'true' : 'false');
				};
				syncAriaExpanded();
				accInput.addEventListener('change', syncAriaExpanded);

				const shouldIgnoreToggle = target => {
					if (!target || typeof target !== 'object' || typeof target.closest !== 'function') {
						return false;
					}
					return !!target.closest('button, a, input, select, textarea, label');
				};

				const toggle = () => {
					accInput.checked = accInput.checked !== true;
					try {
						accInput.dispatchEvent(new Event('change', { bubbles: true }));
					} catch {
						// ignore
					}
				};

				head.addEventListener('click', e => {
					if (e?.defaultPrevented) {
						return;
					}
					if (shouldIgnoreToggle(e?.target)) {
						return;
					}
					toggle();
				});

				head.addEventListener('keydown', e => {
					if (e?.defaultPrevented) {
						return;
					}
					if (shouldIgnoreToggle(e?.target)) {
						return;
					}
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						toggle();
					}
				});
			}

			instWrap.appendChild(head);

			if (hasOptions) {
				const bodyWrap = h('div', { class: 'msghub-instance-body' });
				bodyWrap.oncontextmenu = e => openContextMenu(e, instanceMenuCtx);
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
					saveBtn.disabled = enabled !== true;
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
					const { input, select, wrapper, getValue, skipSave } = formApi
						? formApi.buildFieldInput({
								type: field.type,
								key,
								label:
									field.type === 'header'
										? pickText(field.label) || ''
										: pickText(field.label) || field.key,
								help: pickText(field.help) || '',
								value: effectiveValue,
								unit,
								min: field.min,
								max: field.max,
								step: field.step,
								options: field.options,
								multiOptions: field.multiOptions,
							})
						: { input: null, select: null, wrapper: null, getValue: null, skipSave: true };

					if (skipSave === true) {
						if (wrapper) {
							fieldsContainer.appendChild(wrapper);
						}
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

					if (wrapper) {
						fieldsContainer.appendChild(wrapper);
					}
				}

				saveBtn = h('button', {
					type: 'button',
					disabled: true,
					'aria-disabled': 'true',
					onclick: async () => {
						if (saveBtn.disabled) {
							return;
						}
						if (saveBtn.getAttribute('data-saving') === '1') {
							return;
						}
						const patch = {};
						for (const [k, info] of Object.entries(inputs)) {
							patch[k] = info.getValue();
						}
						saveBtn.setAttribute('data-saving', '1');
						saveBtn.disabled = true;
						saveBtn.setAttribute('aria-disabled', 'true');
						try {
							await pluginsDataApi?.updateInstance?.({
								type: plugin.type,
								instanceId: inst.instanceId,
								nativePatch: patch,
							});

							for (const [k, info] of Object.entries(inputs)) {
								initial[k] = normalize(info.getValue());
							}
						} catch (e) {
							toast(String(e?.message || e), 'danger');
						} finally {
							saveBtn.removeAttribute('data-saving');
							updateDirtyUi();
						}
					},
					text: 'Save options',
				});

				updateDirtyUi();

				bodyWrap.appendChild(fieldsContainer);
				bodyWrap.appendChild(h('div', { class: 'msghub-instance-save' }, [saveBtn]));
				instWrap.appendChild(bodyWrap);
			}

			return instWrap;
		}

		return Object.freeze({ renderInstanceRow });
	}

	win.MsghubAdminTabPluginsInstance = Object.freeze({ createPluginsInstanceApi });
})();
