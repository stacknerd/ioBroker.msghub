/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/* global window, document, HTMLElement */
(function () {
	'use strict';

	const win = window;

	/**
	 * Creates the catalog rendering API used by the plugins panel.
	 *
	 * @param {object} options Factory options.
	 * @returns {object} Frozen catalog API.
	 */
	function createPluginsCatalogApi(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const h = typeof opts.h === 'function' ? opts.h : () => ({});
		const t = typeof opts.t === 'function' ? opts.t : k => k;
		const tOr = typeof opts.tOr === 'function' ? opts.tOr : (k, fb) => fb || k;
		const cssSafe = typeof opts.cssSafe === 'function' ? opts.cssSafe : s => String(s || '');
		const CATEGORY_ORDER = Array.isArray(opts.CATEGORY_ORDER) ? opts.CATEGORY_ORDER : [];
		const CATEGORY_I18N = opts.CATEGORY_I18N && typeof opts.CATEGORY_I18N === 'object' ? opts.CATEGORY_I18N : {};
		const getCategoryTitle = typeof opts.getCategoryTitle === 'function' ? opts.getCategoryTitle : k => k;
		const openContextMenu = typeof opts.openContextMenu === 'function' ? opts.openContextMenu : () => {};
		const pluginsDataApi = opts.pluginsDataApi || null;
		const ui = opts.ui || null;
		const toast = typeof opts.toast === 'function' ? opts.toast : () => {};
		const onRefreshAll = typeof opts.onRefreshAll === 'function' ? opts.onRefreshAll : async () => {};
		const elRoot = opts.elRoot || null;
		const adapterNamespace = typeof opts.adapterNamespace === 'string' ? opts.adapterNamespace : 'msghub.0';

		// --- internal helpers ---

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

		// --- catalog functions ---

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

		const openViewer = optsArg => {
			const title = typeof optsArg?.title === 'string' ? optsArg.title : '';
			const bodyEl = optsArg?.bodyEl;
			ui?.overlayLarge?.open?.({
				title: title && title.trim() ? title.trim() : t('msghub.i18n.core.admin.ui.plugins.viewer.title'),
				bodyEl:
					bodyEl ||
					h('p', {
						class: 'msghub-muted',
						text: t('msghub.i18n.core.admin.ui.plugins.viewer.empty.text'),
					}),
			});
		};

		const captureAccordionState = () => {
			const map = new Map();
			if (!elRoot) {
				return map;
			}
			for (const el of elRoot.querySelectorAll('.msghub-acc-input')) {
				if (!el) {
					continue;
				}
				const key = typeof el.getAttribute === 'function' ? el.getAttribute('data-acc-key') || '' : '';
				if (key) {
					map.set(key, el.checked === true);
					continue;
				}
				if (typeof el.id === 'string' && el.id) {
					map.set(el.id, el.checked === true);
				}
			}
			return map;
		};

		const toAccKey = ({ kind, type, instanceId }) => {
			const k = String(kind || '').trim();
			const tp = String(type || '').trim();
			const iid = Number.isFinite(instanceId) ? Math.trunc(instanceId) : null;
			if (!k || !tp) {
				return '';
			}
			return iid === null ? `${k}:${adapterNamespace}:${tp}` : `${k}:${adapterNamespace}:${tp}:${iid}`;
		};

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

		const buildPluginsViewModel = ({ plugins, instances, readmesByType }) => {
			const pluginList = Array.isArray(plugins) ? plugins.filter(Boolean) : [];
			const instList = Array.isArray(instances) ? instances.filter(Boolean) : [];

			const byType = buildInstancesByType(instList);
			const metaByType = new Map();
			for (const p of pluginList) {
				const type = String(p?.type || '').trim();
				if (!type) {
					continue;
				}
				const hasSchema = !!(p?.options && typeof p.options === 'object');
				const discoverable = p?.discoverable === false ? false : true;
				const supportsMultiple = p?.supportsMultiple === true;
				const category = typeof p?.category === 'string' ? p.category : 'unknown';
				const iconRef = typeof p?.icon === 'string' && p.icon.trim() ? p.icon.trim() : '';
				const hasReadme =
					readmesByType && typeof readmesByType.get === 'function'
						? !!readmesByType.get(type)?.md?.trim?.()
						: false;
				metaByType.set(
					type,
					Object.freeze({
						type,
						category,
						hasSchema,
						discoverable,
						supportsMultiple,
						iconRef,
						hasReadme,
					}),
				);
			}

			return Object.freeze({
				byType,
				metaByType,
				plugins: pluginList,
			});
		};

		function buildAddMenuItems(viewModel) {
			const vm = viewModel && typeof viewModel === 'object' ? viewModel : null;
			const pluginList = Array.isArray(vm?.plugins) ? vm.plugins.filter(Boolean) : [];
			const byType = vm?.byType && typeof vm.byType.get === 'function' ? vm.byType : new Map();

			const grouped = new Map();
			for (const plugin of pluginList) {
				const type = typeof plugin?.type === 'string' ? plugin.type.trim() : '';
				if (!type) {
					continue;
				}
				if (plugin?.discoverable === false) {
					continue;
				}
				const categoryRaw = typeof plugin?.category === 'string' ? plugin.category : 'unknown';
				const list = grouped.get(categoryRaw) || [];
				const existing = Array.isArray(byType.get(type)) ? byType.get(type) : [];
				const canAdd = plugin?.supportsMultiple === true || existing.length === 0;
				list.push({
					type,
					category: categoryRaw,
					canAdd,
				});
				grouped.set(categoryRaw, list);
			}

			const categoriesOrdered = [
				...CATEGORY_ORDER.filter(category => grouped.has(category)),
				...Array.from(grouped.keys())
					.filter(category => !CATEGORY_ORDER.includes(category))
					.sort((a, b) => String(a).localeCompare(String(b))),
			];

			const menuItems = [];
			for (const category of categoriesOrdered) {
				const entries = grouped.get(category) || [];
				entries.sort((a, b) => String(a.type).localeCompare(String(b.type)));
				const categoryLabel = getCategoryTitle(category);

				menuItems.push({
					id: `add:${category}`,
					label: categoryLabel,
					items: entries.map(entry => ({
						id: `add:${entry.category}:${entry.type}`,
						label: entry.type,
						disabled: entry.canAdd !== true,
						onSelect: async () => {
							try {
								const created = await pluginsDataApi.createInstance({
									category: entry.category,
									type: entry.type,
								});
								await onRefreshAll();
								const instanceId = Number.isFinite(created?.instanceId)
									? Math.trunc(created.instanceId)
									: NaN;
								if (!Number.isFinite(instanceId)) {
									return;
								}
								const target = elRoot?.querySelector?.(
									`.msghub-plugin-instance[data-plugin-type="${entry.type}"][data-instance-id="${instanceId}"]`,
								);
								if (!(target instanceof HTMLElement)) {
									return;
								}
								target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
							} catch (err) {
								toast(String(err?.message || err), 'danger');
							}
						},
					})),
				});
			}

			return menuItems;
		}

		function renderAddToolbar(viewModel) {
			const menuItems = buildAddMenuItems(viewModel);
			if (!menuItems.length) {
				return null;
			}
			const addLabel = tOr('msghub.i18n.core.admin.ui.plugins.add.button', 'Plugin hinzufügen');
			const addBtn = h('button', {
				type: 'button',
				class: 'msghub-plugin-toolbar-add msghub-uibutton-iconandtext msghub-toolbarbutton-text',
				text: addLabel,
				title: addLabel,
				'aria-label': addLabel,
			});
			addBtn.onclick = e => {
				e?.preventDefault?.();
				if (!ui?.contextMenu?.open) {
					return;
				}
				ui.contextMenu.open({
					anchorEl: addBtn,
					ariaLabel: 'Plugin context menu',
					placement: 'bottom-start',
					items: menuItems,
				});
			};
			addBtn.oncontextmenu = e => {
				e?.preventDefault?.();
				if (!ui?.contextMenu?.open) {
					return;
				}
				ui.contextMenu.open({
					anchorEl: addBtn,
					ariaLabel: 'Plugin context menu',
					placement: 'bottom-start',
					items: menuItems,
				});
			};
			return h('div', { class: 'msghub-toolbar msghub-plugin-toolbar' }, [
				h('div', { class: 'msghub-toolbar__group' }, [addBtn]),
			]);
		}

		/**
		 * Renders the full plugin catalog DOM into a DocumentFragment.
		 *
		 * @param {object} args Render arguments.
		 * @param {object} args.vm ViewModel from buildPluginsViewModel.
		 * @param {Map<string,boolean>} args.expandedById Accordion state snapshot.
		 * @param {Map<string,object>} args.readmesByType Readme data keyed by plugin type.
		 * @param {Function} args.renderInstanceRow Callback to render a single instance row.
		 * @returns {DocumentFragment} Populated catalog fragment.
		 */
		const renderCatalog = ({ vm, expandedById, readmesByType, renderInstanceRow }) => {
			const withUi = (vm.plugins || []).filter(p => p && p.options && typeof p.options === 'object');

			const entriesByCategory = new Map();
			for (const plugin of withUi) {
				const list = vm.byType.get(plugin.type) || [];
				if (!Array.isArray(list) || list.length === 0) {
					continue;
				}
				const category = typeof plugin?.category === 'string' ? plugin.category : 'unknown';
				const entries = entriesByCategory.get(category) || [];
				for (const inst of list) {
					entries.push({ plugin, inst, instList: list });
				}
				entriesByCategory.set(category, entries);
			}

			const fragment = document.createDocumentFragment();
			const toolbar = renderAddToolbar(vm);
			if (toolbar) {
				fragment.appendChild(toolbar);
			}

			const categoriesToRender = [
				...CATEGORY_ORDER,
				...Array.from(entriesByCategory.keys()).filter(category => !CATEGORY_ORDER.includes(category)),
			];

			for (const category of categoriesToRender) {
				const entries = entriesByCategory.get(category) || [];
				entries.sort(
					(a, b) =>
						String(a?.plugin?.type || '').localeCompare(String(b?.plugin?.type || '')) ||
						(a?.inst?.instanceId ?? 0) - (b?.inst?.instanceId ?? 0),
				);

				const categorySafe = cssSafe(category);
				const cfg = CATEGORY_I18N[category] || null;
				const title = cfg
					? tOr(cfg.titleKey, cfg.fallbackTitle || category)
					: tOr(`msghub.i18n.core.admin.ui.plugins.category.${category}.title`, category);
				const desc = cfg
					? tOr(cfg.descKey, '')
					: tOr(`msghub.i18n.core.admin.ui.plugins.category.${category}.desc`, '');

				const row = h('div', { class: 'msghub-plugin-category-row' }, [
					h('h6', {
						class: 'msghub-plugin-category-title',
						text: title || category,
					}),
					desc ? h('div', { class: 'msghub-muted msghub-plugin-category-desc', text: desc }) : null,
				]);
				row.oncontextmenu = e =>
					openContextMenu(e, {
						kind: 'category',
						categoryRaw: category,
						categorySafe,
					});

				const section = h('div', { class: 'msghub-plugin-category', 'data-category': category }, [row]);

				if (entries.length === 0) {
					section.appendChild(
						h('p', { class: 'msghub-muted', text: t('msghub.i18n.core.admin.ui.plugins.empty.text') }),
					);
				}

				for (const entry of entries) {
					section.appendChild(
						renderInstanceRow({
							plugin: entry.plugin,
							inst: entry.inst,
							instList: entry.instList,
							expandedById,
							readmesByType,
						}),
					);
				}

				fragment.appendChild(section);
			}

			return fragment;
		};

		return Object.freeze({
			renderMarkdownLite,
			openViewer,
			captureAccordionState,
			toAccKey,
			buildInstancesByType,
			buildPluginsViewModel,
			buildAddMenuItems,
			renderAddToolbar,
			renderCatalog,
		});
	}

	win.MsghubAdminTabPluginsCatalog = Object.freeze({ createPluginsCatalogApi });
})();
