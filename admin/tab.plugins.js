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

		const api = ctx.api;
		const constantsApi = api?.constants;
		const pluginsApi = api?.plugins;
		const ingestStatesApi = api?.ingestStates;
		const h = ctx.h;
		const pickText = api.i18n.pickText;
		const tOr = api.i18n.tOr;
		const t = api.i18n.t;
		const ui = api?.ui || ctx.ui;

		let cachedConstants = null;
		let cachedIngestStatesConstants = null;

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

		async function ensureConstantsLoaded() {
			if (cachedConstants) {
				return cachedConstants;
			}
			try {
				if (!constantsApi?.get) {
					throw new Error('Constants API is not available');
				}
				cachedConstants = await constantsApi.get();
			} catch {
				cachedConstants = null;
			}
			return cachedConstants;
		}

		async function ensureIngestStatesConstantsLoaded() {
			if (cachedIngestStatesConstants) {
				return cachedIngestStatesConstants;
			}
			try {
				if (!ingestStatesApi?.constants?.get) {
					throw new Error('IngestStates constants API is not available');
				}
				cachedIngestStatesConstants = await ingestStatesApi.constants.get();
			} catch {
				cachedIngestStatesConstants = null;
			}
			return cachedIngestStatesConstants;
		}

		function resolveDynamicOptions(options) {
			if (Array.isArray(options)) {
				return options;
			}
			const src = typeof options === 'string' ? options.trim() : '';
			if (!src || !src.startsWith('MsgConstants.')) {
				return [];
			}

			const path = src.slice('MsgConstants.'.length);
			const obj = cachedConstants && typeof cachedConstants === 'object' ? pick(cachedConstants, path) : null;
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

		const toast = message => {
			try {
				ui?.toast?.(String(message));
			} catch {
				// ignore
			}
		};

		const CATEGORY_ORDER = Object.freeze(['ingest', 'notify', 'bridge', 'engage']);
		const CATEGORY_I18N = Object.freeze({
			ingest: Object.freeze({
				titleKey: 'msghub.i18n.core.admin.ui.plugins.category.ingest.title',
				descKey: 'msghub.i18n.core.admin.ui.plugins.category.ingest.desc',
				fallbackTitle: 'Ingest',
			}),
			notify: Object.freeze({
				titleKey: 'msghub.i18n.core.admin.ui.plugins.category.notify.title',
				descKey: 'msghub.i18n.core.admin.ui.plugins.category.notify.desc',
				fallbackTitle: 'Notify',
			}),
			bridge: Object.freeze({
				titleKey: 'msghub.i18n.core.admin.ui.plugins.category.bridge.title',
				descKey: 'msghub.i18n.core.admin.ui.plugins.category.bridge.desc',
				fallbackTitle: 'Bridge',
			}),
			engage: Object.freeze({
				titleKey: 'msghub.i18n.core.admin.ui.plugins.category.engage.title',
				descKey: 'msghub.i18n.core.admin.ui.plugins.category.engage.desc',
				fallbackTitle: 'Engage',
			}),
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
			return (
				String(s || '')
					.trim()
					.toLowerCase()
					.replace(/[^a-z0-9_-]+/g, '-')
					.replace(/^-+|-+$/g, '') || 'unknown'
			);
		}

			const confirmDialog = opts => {
				if (ui?.dialog?.confirm) {
					return ui.dialog.confirm(opts);
				}
				const text = typeof opts?.text === 'string' && opts.text.trim() ? opts.text : String(opts?.title || '');
				return Promise.resolve(window.confirm(text));
			};

			const isTextEditableElement = el => {
				if (!el || typeof el !== 'object') {
					return false;
				}
				if (el instanceof HTMLTextAreaElement) {
					return true;
				}
				if (el instanceof HTMLInputElement) {
					const type = String(el.type || '').toLowerCase();
					return ![
						'button',
						'submit',
						'reset',
						'image',
						'checkbox',
						'radio',
						'range',
						'color',
						'file',
						'hidden',
					].includes(type);
				}
				if (el instanceof HTMLElement && el.isContentEditable === true) {
					return true;
				}
				return false;
			};

			const isTextEditableTarget = target => {
				if (!target || typeof target !== 'object' || typeof target.closest !== 'function') {
					return false;
				}
				const el =
					target.closest('textarea, input, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') ||
					null;
				return isTextEditableElement(el);
			};

			const getAllInstanceWraps = () => Array.from(elRoot.querySelectorAll('.msghub-plugin-instance')).filter(Boolean);

			const getCategoryTitle = categoryRaw => {
				const raw = typeof categoryRaw === 'string' ? categoryRaw : '';
				const cfg = CATEGORY_I18N[raw] || null;
				if (cfg) {
					return tOr(cfg.titleKey, cfg.fallbackTitle || raw);
				}
				return tOr(`msghub.i18n.core.admin.ui.plugins.category.${raw}.title`, raw);
			};

			const setAccordionChecked = (wraps, checked) => {
				const list = Array.isArray(wraps) ? wraps : [];
				for (const w of list) {
					const input = w?.querySelector?.('.msghub-acc-input--instance');
					if (!(input instanceof HTMLInputElement)) {
						continue;
					}
					if (input.checked === checked) {
						continue;
					}
					input.checked = checked;
					try {
						input.dispatchEvent(new Event('change', { bubbles: true }));
					} catch {
						// ignore
					}
				}
			};

			const getEnabledStats = wraps => {
				const list = Array.isArray(wraps) ? wraps : [];
				let enabledCount = 0;
				let disabledCount = 0;
				for (const w of list) {
					const curEnabled = w?.getAttribute?.('data-enabled') === '1';
					if (curEnabled) {
						enabledCount += 1;
					} else {
						disabledCount += 1;
					}
				}
				return { enabledCount, disabledCount, total: enabledCount + disabledCount };
			};

			const setEnabledForWraps = async (wraps, enabled) => {
				const list = Array.isArray(wraps) ? wraps : [];
				const tasks = [];
				for (const w of list) {
					const type = String(w?.getAttribute?.('data-plugin-type') || '').trim();
					const iid = Number(w?.getAttribute?.('data-instance-id'));
					if (!type || !Number.isFinite(iid)) {
						continue;
					}
					const curEnabled = w?.getAttribute?.('data-enabled') === '1';
					if (curEnabled === enabled) {
						continue;
					}
					tasks.push({ type, instanceId: Math.trunc(iid) });
				}
				for (const task of tasks) {
					if (!pluginsApi?.setEnabled) {
						throw new Error('Plugins API is not available');
					}
					await pluginsApi.setEnabled({
						type: task.type,
						instanceId: task.instanceId,
						enabled,
					});
				}
				await refreshAll();
			};

			const openPluginsContextMenu = (e, ctx) => {
				if (!e || typeof e !== 'object') {
					return;
				}
				const context = ctx && typeof ctx === 'object' ? ctx : {};
				const kind = typeof context.kind === 'string' ? context.kind : 'all';

				// Secret bypass: Ctrl+RightClick opens the native browser context menu (global handler).
				if (e.ctrlKey === true) {
					return;
				}
				// Keep the global input context menu for text-like editables.
				if (isTextEditableTarget(e?.target)) {
					return;
				}
				if (!ui?.contextMenu?.open) {
					return;
				}
				if (typeof e.preventDefault === 'function') {
					e.preventDefault();
				}

				const wrapsAll = getAllInstanceWraps();
				const wrapsThis = kind === 'instance' && context.instWrap ? [context.instWrap] : [];
				const wrapsType =
					kind === 'instance' && context.pluginType
						? wrapsAll.filter(w => String(w.getAttribute('data-plugin-type') || '') === String(context.pluginType))
						: [];
				const wrapsCategory =
					(kind === 'instance' || kind === 'category') && context.categorySafe
						? wrapsAll.filter(w => String(w.getAttribute('data-plugin-category') || '') === String(context.categorySafe))
						: [];

				const canExpandAll = wrapsAll.some(w => w?.querySelector?.('.msghub-acc-input--instance'));
				const canExpandCategory = wrapsCategory.some(w => w?.querySelector?.('.msghub-acc-input--instance'));
				const canExpandType = wrapsType.some(w => w?.querySelector?.('.msghub-acc-input--instance'));
				const canExpandThis = wrapsThis.some(w => w?.querySelector?.('.msghub-acc-input--instance'));

				const categoryTitle = context.categoryRaw ? getCategoryTitle(context.categoryRaw) : '';
				const categoryLabel =
					kind === 'category'
						? t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.this.label', categoryTitle || String(context.categoryRaw))
						: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.category.label', categoryTitle);

				const expandItems =
					kind === 'instance'
						? [
								{
									id: 'expand_this',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.this.label', context.instanceName),
									disabled: !canExpandThis,
									onSelect: () => setAccordionChecked(wrapsThis, true),
								},
								{
									id: 'expand_type',
									label: t(
										'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.type.label',
										String(context.pluginType || ''),
									),
									disabled: !canExpandType,
									onSelect: () => setAccordionChecked(wrapsType, true),
								},
								{
									id: 'expand_category',
									label: categoryLabel,
									disabled: !canExpandCategory,
									onSelect: () => setAccordionChecked(wrapsCategory, true),
								},
								{
									id: 'expand_all',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
									disabled: !canExpandAll,
									onSelect: () => setAccordionChecked(wrapsAll, true),
								},
							]
						: kind === 'category'
							? [
									{
										id: 'expand_category',
										label: categoryLabel,
										disabled: !canExpandCategory,
										onSelect: () => setAccordionChecked(wrapsCategory, true),
									},
									{
										id: 'expand_all',
										label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
										disabled: !canExpandAll,
										onSelect: () => setAccordionChecked(wrapsAll, true),
									},
								]
							: [
									{
										id: 'expand_all',
										label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
										disabled: !canExpandAll,
										onSelect: () => setAccordionChecked(wrapsAll, true),
									},
								];

				const collapseItems =
					kind === 'instance'
						? [
								{
									id: 'collapse_this',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.this.label', context.instanceName),
									disabled: !canExpandThis,
									onSelect: () => setAccordionChecked(wrapsThis, false),
								},
								{
									id: 'collapse_type',
									label: t(
										'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.type.label',
										String(context.pluginType || ''),
									),
									disabled: !canExpandType,
									onSelect: () => setAccordionChecked(wrapsType, false),
								},
								{
									id: 'collapse_category',
									label: categoryLabel,
									disabled: !canExpandCategory,
									onSelect: () => setAccordionChecked(wrapsCategory, false),
								},
								{
									id: 'collapse_all',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
									disabled: !canExpandAll,
									onSelect: () => setAccordionChecked(wrapsAll, false),
								},
							]
						: kind === 'category'
							? [
									{
										id: 'collapse_category',
										label: categoryLabel,
										disabled: !canExpandCategory,
										onSelect: () => setAccordionChecked(wrapsCategory, false),
									},
									{
										id: 'collapse_all',
										label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
										disabled: !canExpandAll,
										onSelect: () => setAccordionChecked(wrapsAll, false),
									},
								]
							: [
									{
										id: 'collapse_all',
										label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
										disabled: !canExpandAll,
										onSelect: () => setAccordionChecked(wrapsAll, false),
									},
								];

				const statsAll = getEnabledStats(wrapsAll);
				const statsCategory = getEnabledStats(wrapsCategory);
				const statsType = getEnabledStats(wrapsType);
				const statsThis = getEnabledStats(wrapsThis);

				const disableItems =
					kind === 'instance'
						? [
								{
									id: 'disable_this',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.this.label', context.instanceName),
									disabled: statsThis.enabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsThis, false),
								},
								{
									id: 'disable_type',
									label: t(
										'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.type.label',
										String(context.pluginType || ''),
									),
									disabled: statsType.enabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsType, false),
								},
								{
									id: 'disable_category',
									label: categoryLabel,
									disabled: statsCategory.enabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsCategory, false),
								},
								{
									id: 'disable_all',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
									disabled: statsAll.enabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsAll, false),
								},
							]
						: kind === 'category'
							? [
									{
										id: 'disable_category',
										label: categoryLabel,
										disabled: statsCategory.enabledCount === 0,
										onSelect: () => setEnabledForWraps(wrapsCategory, false),
									},
									{
										id: 'disable_all',
										label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
										disabled: statsAll.enabledCount === 0,
										onSelect: () => setEnabledForWraps(wrapsAll, false),
									},
								]
							: [
									{
										id: 'disable_all',
										label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
										disabled: statsAll.enabledCount === 0,
										onSelect: () => setEnabledForWraps(wrapsAll, false),
									},
								];

				const enableItems =
					kind === 'instance'
						? [
								{
									id: 'enable_this',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.this.label', context.instanceName),
									disabled: statsThis.disabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsThis, true),
								},
								{
									id: 'enable_type',
									label: t(
										'msghub.i18n.core.admin.ui.plugins.contextMenu.scope.type.label',
										String(context.pluginType || ''),
									),
									disabled: statsType.disabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsType, true),
								},
								{
									id: 'enable_category',
									label: categoryLabel,
									disabled: statsCategory.disabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsCategory, true),
								},
								{
									id: 'enable_all',
									label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
									disabled: statsAll.disabledCount === 0,
									onSelect: () => setEnabledForWraps(wrapsAll, true),
								},
							]
						: kind === 'category'
							? [
									{
										id: 'enable_category',
										label: categoryLabel,
										disabled: statsCategory.disabledCount === 0,
										onSelect: () => setEnabledForWraps(wrapsCategory, true),
									},
									{
										id: 'enable_all',
										label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
										disabled: statsAll.disabledCount === 0,
										onSelect: () => setEnabledForWraps(wrapsAll, true),
									},
								]
							: [
									{
										id: 'enable_all',
										label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.scope.all.label'),
										disabled: statsAll.disabledCount === 0,
										onSelect: () => setEnabledForWraps(wrapsAll, true),
									},
								];

				/** @type {any[]} */
				const items = [];
				if (kind === 'instance') {
					items.push(
						{
							id: 'help',
							label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.help.label', String(context.pluginType || '')),
							icon: 'help',
							disabled: context.hasReadme !== true,
							onSelect: () => context.openReadme?.(),
						},
						{
							id: 'tools',
							label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.tools.label', String(context.pluginType || '')),
							icon: 'tools',
							disabled: context.hasToolsAvailable !== true,
							items: Array.isArray(context.toolsItems) ? context.toolsItems : [],
						},
						{ type: 'separator' },
					);
				}

				items.push(
					{
						id: 'expand',
						label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.expand.label'),
						items: expandItems,
					},
					{
						id: 'collapse',
						label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.collapse.label'),
						items: collapseItems,
					},
					{ type: 'separator' },
					{
						id: 'disable',
						label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.disable.label'),
						icon: 'pause',
						items: disableItems,
					},
					{
						id: 'enable',
						label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.enable.label'),
						icon: 'play',
						items: enableItems,
					},
				);

				if (kind === 'instance') {
					items.push(
						{ type: 'separator' },
						{
							id: 'remove',
							label: t('msghub.i18n.core.admin.ui.plugins.contextMenu.remove.label'),
							danger: true,
							onSelect: () => context.removeInstance?.(),
						},
					);
				}

					ui.contextMenu.open({
						anchorPoint: { x: e.clientX, y: e.clientY },
						ariaLabel: 'Plugin context menu',
						placement: 'bottom-start',
						items,
					});
				};

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

		const openViewer = opts => {
			const title = typeof opts?.title === 'string' ? opts.title : '';
			const bodyEl = opts?.bodyEl;
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

		let pluginReadmesByType = new Map();
		let pluginReadmesLoadPromise = null;
			async function ensurePluginReadmesLoaded() {
			if (pluginReadmesLoadPromise) {
				return pluginReadmesLoadPromise;
			}

			elRoot.addEventListener('contextmenu', e => {
				try {
					if (e?.defaultPrevented) {
						return;
					}
					openPluginsContextMenu(e, { kind: 'all' });
				} catch {
					// ignore
				}
			});
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
			const t = String(type || '').trim();
			const iid = Number.isFinite(instanceId) ? Math.trunc(instanceId) : null;
			if (!k || !t) {
				return '';
			}
			return iid === null ? `${k}:${adapterNamespace}:${t}` : `${k}:${adapterNamespace}:${t}:${iid}`;
		};

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
				const hasReadme = readmesByType instanceof Map ? !!readmesByType.get(type)?.md?.trim?.() : false;
				metaByType.set(
					type,
					Object.freeze({
						type,
						category,
						hasSchema,
						discoverable,
						supportsMultiple,
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

		function parseCsvValues(csv) {
			const s = typeof csv === 'string' ? csv : csv == null ? '' : String(csv);
			return s
				.split(',')
				.map(x => x.trim())
				.filter(Boolean);
		}

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

		let ingestStatesSchemaPromise = null;
		async function ensureIngestStatesSchema() {
			if (ingestStatesSchemaPromise) {
				return ingestStatesSchemaPromise;
			}
			ingestStatesSchemaPromise = (async () => {
				if (!ingestStatesApi?.schema?.get) {
					throw new Error('IngestStates schema API is not available');
				}
				const schema = await ingestStatesApi.schema.get();
				if (!schema || typeof schema !== 'object') {
					throw new Error('Invalid schema response');
				}
				return schema;
			})();
			return ingestStatesSchemaPromise;
		}

		function renderIngestStatesBulkApply({ instances, schema, ingestConstants }) {
			const inst = Array.isArray(instances) ? instances.find(x => x?.instanceId === 0) : null;
			const enabled = inst?.enabled === true;
			const fallbackDefaults =
				ingestConstants && typeof ingestConstants.jsonCustomDefaults === 'object'
					? ingestConstants.jsonCustomDefaults
					: null;

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
				return cfg[path];
			}

			function isPlainObject(value) {
				return !!value && typeof value === 'object' && !Array.isArray(value);
			}

			function sanitizeIngestStatesCustom(custom) {
				const out = JSON.parse(JSON.stringify(custom || {}));
				if (!isPlainObject(out)) {
					return {};
				}

				for (const [key, value] of Object.entries(out)) {
					if (typeof key !== 'string' || !key || key.includes('.') || isPlainObject(value)) {
						delete out[key];
					}
				}

				return out;
			}

			function joinOptions(list) {
				return (Array.isArray(list) ? list : []).map(v => String(v)).join('|');
			}

			function collectWarnings(cfg) {
				const warnings = [];

				const fields = schema?.fields && typeof schema.fields === 'object' ? schema.fields : {};
				const mode = readCfg(cfg, 'mode');
				const modeInfo = fields?.mode && typeof fields.mode === 'object' ? fields.mode : null;
				const modeOptions = Array.isArray(modeInfo?.options) ? modeInfo.options : [];
				const allowedModes = modeOptions.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
				if (allowedModes.length === 0) {
					allowedModes.push('threshold', 'cycle', 'freshness', 'triggered', 'nonSettling', 'session');
				}
				const modeStr = typeof mode === 'string' ? mode.trim() : '';
				if (!modeStr) {
					warnings.push(`WARNING: missing mode detected. valid options are: ${allowedModes.join('|')}`);
				} else if (!allowedModes.includes(modeStr)) {
					warnings.push(
						`WARNING: invalid mode detected ('${modeStr}'). valid options are: ${allowedModes.join('|')}`,
					);
				}

				if (modeStr === 'triggered') {
					const trgId = String(readCfg(cfg, 'trg-id') || '').trim();
					if (!trgId) {
						warnings.push('WARNING: missing trg-id detected. This field is required for triggered rules.');
					}
				}

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

				const title = String(readCfg(cfg, 'msg-title') || '').trim();
				const text = String(readCfg(cfg, 'msg-text') || '').trim();
				lines.push(`Message title: ${title ? `"${title}"` : 'default'}`);
				lines.push(`Message text: ${text ? `"${text}"` : 'default'}`);

				const tags = String(readCfg(cfg, 'msg-audienceTags') || '').trim();
				const channels = String(readCfg(cfg, 'msg-audienceChannels') || '').trim();
				if (tags || channels) {
					lines.push(
						`Audience: ${[tags ? `tags=[${tags}]` : null, channels ? `channels=[${channels}]` : null].filter(Boolean).join(' ')}`,
					);
				} else {
					lines.push('Audience: default');
				}

				const resetOnNormal = readCfg(cfg, 'msg-resetOnNormal');
				lines.push(`Auto-remove on normal: ${resetOnNormal === false ? 'off' : 'on'}`);
				const remind = formatDurationValueUnit(readCfg(cfg, 'msg-remindValue'), readCfg(cfg, 'msg-remindUnit'));
				lines.push(`Reminder: ${remind ? `every ${remind}` : 'off'}`);
				const cooldown = formatDurationValueUnit(
					readCfg(cfg, 'msg-cooldownValue'),
					readCfg(cfg, 'msg-cooldownUnit'),
				);
				if (cooldown) {
					lines.push(`Cooldown after close: ${cooldown}`);
				}

				lines.push('');
				lines.push('Rule behavior:');

				if (mode === 'threshold') {
					const thrMode = String(readCfg(cfg, 'thr-mode') || '').trim() || 'lt';
					const h = readCfg(cfg, 'thr-hysteresis');
					const minDur = formatDurationValueUnit(
						readCfg(cfg, 'thr-minDurationValue'),
						readCfg(cfg, 'thr-minDurationUnit'),
					);
					const value = readCfg(cfg, 'thr-value');
					const min = readCfg(cfg, 'thr-min');
					const max = readCfg(cfg, 'thr-max');

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
					const evaluateBy = readCfg(cfg, 'fresh-evaluateBy') === 'lc' ? 'change (lc)' : 'update (ts)';
					const thr = formatDurationValueUnit(
						readCfg(cfg, 'fresh-everyValue'),
						readCfg(cfg, 'fresh-everyUnit'),
					);
					lines.push(`- Alerts when the state has no ${evaluateBy} for longer than ${thr || '(not set)'}.`);
					lines.push('- Actions: ack, snooze (4h), close (only when auto-remove is off).');
				} else if (mode === 'cycle') {
					const period = readCfg(cfg, 'cyc-period');
					const time = formatDurationValueUnit(readCfg(cfg, 'cyc-time'), readCfg(cfg, 'cyc-timeUnit'));
					lines.push(`- Cycle rule: triggers after ${period || '(period not set)'} steps.`);
					if (time) {
						lines.push(`- Resets/periods are aligned to ${time}.`);
					}
					lines.push('- Actions: ack, snooze (4h), close (only when auto-remove is off).');
				} else if (mode === 'triggered') {
					const windowDur = formatDurationValueUnit(
						readCfg(cfg, 'trg-windowValue'),
						readCfg(cfg, 'trg-windowUnit'),
					);
					const exp = String(readCfg(cfg, 'trg-expectation') || '').trim();
					lines.push('- Starts a time window when the trigger becomes active.');
					lines.push(
						`- If the expectation is not met within ${windowDur || '(not set)'}, it creates a message.`,
					);
					if (exp) {
						lines.push(`- Expectation: ${exp}.`);
					}
					lines.push('- Actions: ack, snooze (4h), close (only when auto-remove is off).');
				} else if (mode === 'nonSettling') {
					const profile = String(readCfg(cfg, 'nonset-profile') || '').trim();
					lines.push(`- Non-settling profile: ${profile || '(not set)'}.`);
					lines.push(
						'- Creates a message when the value is not stable/trending as configured, and closes on recovery.',
					);
					lines.push('- Actions: ack, snooze (4h), close (only when auto-remove is off).');
				} else if (mode === 'session') {
					lines.push('- Tracks a start and an end message (two refs).');
					lines.push('- The start message is soft-deleted when the end message is created.');
					lines.push('- Actions: start=ack+snooze(4h)+delete, end=ack+snooze(4h).');
				} else {
					lines.push('- Select a rule type to see a detailed description.');
				}

				lines.push('');
				lines.push('Note: Bulk Apply never reads/writes managedMeta-*.');
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
					: fallbackDefaults || { enabled: true, mode: 'threshold' };

			const elCustom = h('textarea', {
				class: 'msghub-bulk-apply-textarea',
				rows: '24',
				disabled: enabled ? undefined : '',
			});
			{
				const raw = typeof initial.customJson === 'string' ? initial.customJson : '';
				if (raw && raw.trim()) {
					try {
						elCustom.value = JSON.stringify(sanitizeIngestStatesCustom(JSON.parse(raw)), null, 2);
					} catch {
						elCustom.value = raw;
					}
				} else {
					elCustom.value = JSON.stringify(sanitizeIngestStatesCustom(defaultCustom), null, 2);
				}
			}

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
					b.disabled = busy === true;
				}
			};

			const btnLoad = h('button', {
				type: 'button',
				text: 'Load from object',
			});

			const btnGenerateEmpty = h('button', {
				type: 'button',
				text: 'Generate empty',
			});

			const btnPreview = h('button', {
				type: 'button',
				text: 'Generate preview',
			});

			const btnApply = h('button', {
				type: 'button',
				disabled: true,
				'aria-disabled': 'true',
				text: 'Apply settings',
			});

			const setApplyEnabled = ok => {
				btnApply.disabled = ok !== true;
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
				toast('IngestStates is disabled. Enable the plugin to use Bulk Apply.');
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
					if (!ingestStatesApi?.custom?.read) {
						throw new Error('IngestStates custom API is not available');
					}
					const res = await ingestStatesApi.custom.read({ id });
					if (!res?.custom) {
						setStatus('No MsgHub Custom config found on that object.');
						return;
					}
					elCustom.value = JSON.stringify(sanitizeIngestStatesCustom(res.custom), null, 2);
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
				elCustom.value = JSON.stringify(sanitizeIngestStatesCustom(defaultCustom), null, 2);
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
					custom = sanitizeIngestStatesCustom(parseCustom());
					elCustom.value = JSON.stringify(custom, null, 2);
					updateLs();
					updateDescription();
				} catch (err) {
					setStatus(`Invalid JSON: ${String(err?.message || err)}`);
					return;
				}

				setBusy(true, [btnLoad, btnPreview, btnApply]);
				setStatus('Previewing…');
				invalidatePreview();
				try {
					if (!ingestStatesApi?.bulkApply?.preview) {
						throw new Error('IngestStates bulkApply API is not available');
					}
					const res = await ingestStatesApi.bulkApply.preview({
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
				if (btnApply.disabled) {
					return;
				}
				const pattern = String(elPattern.value || '').trim();
				if (!pattern) {
					setStatus('Enter an object id pattern first.');
					return;
				}
				let custom;
				try {
					custom = sanitizeIngestStatesCustom(parseCustom());
					elCustom.value = JSON.stringify(custom, null, 2);
					updateLs();
					updateDescription();
				} catch (err) {
					setStatus(`Invalid JSON: ${String(err?.message || err)}`);
					return;
				}
				const count = Number(lastPreview?.willChange) || 0;
				if (
					!(await confirmDialog({
						title: 'Apply bulk changes?',
						text: `Apply MsgHub Custom config to ${count} object(s) as previewed?`,
						danger: true,
						confirmText: 'Apply',
						cancelText: 'Cancel',
					}))
				) {
					return;
				}

				setBusy(true, [btnLoad, btnPreview, btnApply]);
				setStatus('Applying…');
				try {
					if (!ingestStatesApi?.bulkApply?.apply) {
						throw new Error('IngestStates bulkApply API is not available');
					}
					const res = await ingestStatesApi.bulkApply.apply({
						pattern,
						custom,
						replace: elReplace.checked === true,
					});
					setStatus(
						`Done: updated=${res.updated}, unchanged=${res.unchanged}, errors=${(res.errors || []).length}`,
					);
					setPreview(null);
					toast(`Bulk apply done: updated=${res.updated}`);
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
					h('div', null, [
						h('div', { class: 'msghub-field' }, [
							elSource,
							h('label', { class: 'active', text: 'Import from existing config (object id)' }),
						]),
						h('div', { class: 'msghub-actions msghub-actions--inline' }, [btnLoad, btnGenerateEmpty]),
					]),
				]),
				h('div', { class: 'msghub-bulk-step' }, [
					h('div', { class: 'msghub-bulk-step-title', text: 'Step 2: define target' }),
					h('div', null, [
						h('div', { class: 'msghub-field' }, [
							elPattern,
							h('label', {
								class: 'active',
								text: 'Export to ids matching the following target pattern',
							}),
						]),
					]),
				]),
				h('div', { class: 'msghub-bulk-step' }, [
					h('div', { class: 'msghub-bulk-step-title', text: 'Step 3: review / modify settings' }),
					h('div', null, [
						h('div', null, [
							h('div', { class: 'msghub-bulk-apply-cols' }, [
								h('div', { class: 'msghub-bulk-apply-col' }, [
									h('div', { class: 'msghub-field' }, [
										elCustom,
										h('label', {
											class: 'active',
											text: `Custom config JSON (${adapterNamespace})`,
										}),
									]),
								]),
								h('div', { class: 'msghub-bulk-apply-col' }, [
									h('div', { class: 'msghub-field' }, [
										elDescription,
										h('label', { class: 'active', text: 'Output of rule description' }),
									]),
								]),
							]),
						]),
						h('div', null, [h('label', null, [elReplace, h('span', { text: ' ' }), elReplaceLabel])]),
					]),
				]),
				h('div', { class: 'msghub-bulk-step' }, [
					h('div', { class: 'msghub-bulk-step-title', text: 'Step 4: generate preview' }),
					h('div', null, [
						h('div', { class: 'msghub-actions msghub-actions--inline' }, [btnPreview]),
						h('div', null, [elStatus]),
						h('div', null, [elPreview]),
					]),
				]),
				h('div', { class: 'msghub-bulk-step' }, [
					h('div', { class: 'msghub-bulk-step-title', text: 'Step 5: apply settings' }),
					h('div', null, [h('div', { class: 'msghub-actions msghub-actions--inline' }, [btnApply])]),
				]),
			]);
		}

		function renderIngestStatesMessagePresetsTool(options) {
			const root = options && typeof options === 'object' ? options : null;
			const ingestConstants =
				root && root.ingestConstants && typeof root.ingestConstants === 'object' ? root.ingestConstants : null;
			const presetSchema =
				ingestConstants && typeof ingestConstants.presetSchema === 'string' ? ingestConstants.presetSchema : '';
			const presetTemplate =
				ingestConstants && typeof ingestConstants.presetTemplateV1 === 'object'
					? ingestConstants.presetTemplateV1
					: null;

			if (!presetSchema || !presetTemplate) {
				return h('div', {
					class: 'msghub-error',
					text: 'Preset editor unavailable: IngestStates constants not loaded.',
				});
			}

			const isPresetId = value => {
				const s = typeof value === 'string' ? value.trim() : '';
				return /^[A-Za-z0-9_-]+$/.test(s);
			};

			const parseCsvList = value => {
				const s = typeof value === 'string' ? value : value == null ? '' : String(value);
				return s
					.split(',')
					.map(x => x.trim())
					.filter(Boolean);
			};

			const formatCsvList = list => (Array.isArray(list) ? list : []).filter(Boolean).join(', ');

			const cloneJson = value => JSON.parse(JSON.stringify(value ?? null));

			const buildPresetBase = () => cloneJson(presetTemplate);

			const defaultPreset = ({
				presetId = '',
				description = '',
				ownedBy = '',
				kind = 'status',
				level = 20,
			} = {}) => {
				const preset = buildPresetBase();
				preset.schema = presetSchema;
				preset.presetId = String(presetId || '').trim();
				preset.description = typeof description === 'string' ? description : '';
				preset.ownedBy = typeof ownedBy === 'string' && ownedBy.trim() ? ownedBy.trim() : null;
				if (!preset.message || typeof preset.message !== 'object') {
					preset.message = {};
				}
				preset.message.kind = kind;
				preset.message.level = level;
				preset.message.icon = typeof preset.message.icon === 'string' ? preset.message.icon : '';
				preset.message.title = typeof preset.message.title === 'string' ? preset.message.title : '';
				preset.message.text = typeof preset.message.text === 'string' ? preset.message.text : '';
				if (!preset.message.timing || typeof preset.message.timing !== 'object') {
					preset.message.timing = { timeBudget: 0, dueInMs: 0, expiresInMs: 0, cooldown: 0, remindEvery: 0 };
				}
				if (!preset.message.details || typeof preset.message.details !== 'object') {
					preset.message.details = { task: '', reason: '', tools: [], consumables: [] };
				}
				if (!preset.message.audience || typeof preset.message.audience !== 'object') {
					preset.message.audience = { tags: [], channels: { include: [], exclude: [] } };
				}
				if (!Array.isArray(preset.message.actions)) {
					preset.message.actions = [];
				}
				if (!preset.policy || typeof preset.policy !== 'object') {
					preset.policy = { resetOnNormal: true };
				}
				if (!preset.ui || typeof preset.ui !== 'object') {
					preset.ui = {
						timingUnits: {
							timeBudgetUnit: 60000,
							dueInUnit: 3600000,
							cooldownUnit: 1000,
							remindEveryUnit: 3600000,
						},
					};
				}
				return preset;
			};

			let presets = [];

			let selectedId = '';
			let original = null;
			let draft = cloneJson(original);
			let isNew = false;
			let listLoading = true;
			let presetLoading = false;
			let saving = false;
			let lastError = '';

			const el = h('div', { class: 'msghub-tools-presets' });
			const elList = h('div', {
				class: 'msghub-tools-presets-list',
				style: 'flex: 0 0 38%; min-width: 260px;',
			});
			const elEditor = h('div', { class: 'msghub-tools-presets-editor', style: 'flex: 1 1 auto;' });

			const isDirty = () => JSON.stringify(original) !== JSON.stringify(draft);

			const presetLabel = p => {
				const id = String(p?.presetId || '').trim();
				const desc = typeof p?.description === 'string' ? p.description.trim() : '';
				const kind = String(p?.message?.kind || '').trim();
				const level = p?.message?.level;
				const lvl = typeof level === 'number' && Number.isFinite(level) ? String(level) : '';
				const name = desc || id;
				return `${kind || 'msg'}, ${lvl || '?'}: ${name || '(unnamed)'}`;
			};

			const sortPresets = () => {
				presets.sort((a, b) => presetLabel(a).localeCompare(presetLabel(b)));
			};

			const loadList = async ({ selectPresetId = '' } = {}) => {
				listLoading = true;
				render();

				if (!ingestStatesApi?.presets?.list) {
					throw new Error('IngestStates presets API is not available');
				}
				const opts = await ingestStatesApi.presets.list();
				const items = Array.isArray(opts) ? opts : [];

				const next = [];
				for (const o of items) {
					const id = typeof o?.value === 'string' ? o.value.trim() : '';
					if (!isPresetId(id)) {
						continue;
					}
					const label = typeof o?.label === 'string' ? o.label.trim() : '';
					next.push(
						defaultPreset({
							presetId: id,
							description: label && label !== id ? label : '',
							ownedBy: '',
						}),
					);
				}

				presets = next;
				sortPresets();
				selectedId = '';
				original = null;
				draft = null;
				isNew = false;
				listLoading = false;

				const desired = typeof selectPresetId === 'string' ? selectPresetId.trim() : '';
				if (desired && presets.some(p => p?.presetId === desired)) {
					await setSelected(desired);
				} else {
					render();
				}
			};

			const loadPreset = async presetId => {
				const id = String(presetId || '').trim();
				if (!isPresetId(id)) {
					return null;
				}
				if (!ingestStatesApi?.presets?.get) {
					throw new Error('IngestStates presets API is not available');
				}
				const res = await ingestStatesApi.presets.get({ presetId: id });
				const preset = res?.preset;
				if (!preset || typeof preset !== 'object') {
					return null;
				}
				return preset;
			};

			const toast = msg => {
				try {
					console.warn(`Msghub presets: ${String(msg || '')}`);
				} catch {
					// ignore
				}
				try {
					ui?.toast?.(String(msg || ''));
				} catch {
					// ignore
				}
			};

			const setError = msg => {
				lastError = typeof msg === 'string' ? msg : msg == null ? '' : String(msg);
			};

			const confirmDiscardIfNeeded = async () => {
				if (!isDirty()) {
					return true;
				}
				return await confirmDialog({
					title: 'Discard changes?',
					text: 'Discard unsaved changes?',
					danger: true,
					confirmText: 'Discard',
					cancelText: 'Cancel',
				});
			};

			const setSelected = async presetId => {
				if (!(await confirmDiscardIfNeeded())) {
					return;
				}
				const nextId = String(presetId || '').trim();
				if (!nextId) {
					return;
				}
				setError('');
				presetLoading = true;
				render();
				try {
					const preset = await loadPreset(nextId);
					if (!preset) {
						const msg = `Preset '${nextId}' could not be loaded`;
						setError(msg);
						toast(msg);
						return;
					}
					selectedId = nextId;
					original = cloneJson(preset);
					draft = cloneJson(original);
					isNew = false;
				} catch (e) {
					const msg = String(e?.message || e);
					setError(msg);
					toast(msg);
				} finally {
					presetLoading = false;
					render();
				}
			};

			const createNew = async () => {
				if (!(await confirmDiscardIfNeeded())) {
					return;
				}
				setError('');
				original = null;
				draft = defaultPreset({ presetId: '', description: '', ownedBy: '', kind: 'status', level: 20 });
				isNew = true;
				render();
			};

			const duplicateSelected = async () => {
				if (!(await confirmDiscardIfNeeded())) {
					return;
				}
				if (!original || typeof original !== 'object') {
					toast('No preset selected');
					return;
				}
				setError('');
				original = null;
				draft = cloneJson(draft);
				draft.presetId = '';
				draft.ownedBy = null;
				isNew = true;
				render();
			};

			const deleteSelected = async () => {
				const id = String(selectedId || '').trim();
				if (!id) {
					return;
				}
				if (
					!(await confirmDialog({
						title: 'Delete preset?',
						text: `Delete preset '${id}'?`,
						danger: true,
						confirmText: 'Delete',
						cancelText: 'Cancel',
					}))
				) {
					return;
				}
				setError('');
				saving = true;
				render();
				Promise.resolve()
					.then(() => {
						if (!ingestStatesApi?.presets?.delete) {
							throw new Error('IngestStates presets API is not available');
						}
						return ingestStatesApi.presets.delete({ presetId: id });
					})
					.then(() => loadList())
					.catch(e => {
						const msg = String(e?.message || e);
						setError(msg);
						toast(msg);
					})
					.finally(() => {
						saving = false;
						render();
					});
			};

			const validateDraft = () => {
				if (!draft || typeof draft !== 'object') {
					return 'Invalid preset';
				}
				if (draft.schema !== presetSchema) {
					return `Invalid schema (expected '${presetSchema}')`;
				}
				if (!isPresetId(draft.presetId)) {
					return 'Invalid presetId (allowed: A-Z a-z 0-9 _ -)';
				}
				if (!draft?.message?.kind) {
					return 'Missing required field: message.kind';
				}
				if (typeof draft?.message?.level !== 'number' || !Number.isFinite(draft.message.level)) {
					return 'Missing/invalid required field: message.level';
				}
				const title = typeof draft?.message?.title === 'string' ? draft.message.title.trim() : '';
				const text = typeof draft?.message?.text === 'string' ? draft.message.text.trim() : '';
				if (!title) {
					return 'Missing required field: message.title';
				}
				if (!text) {
					return 'Missing required field: message.text';
				}
				return null;
			};

			const saveDraft = () => {
				const err = validateDraft();
				if (err) {
					setError(err);
					toast(err);
					render();
					return;
				}

				setError('');
				saving = true;
				render();
				Promise.resolve()
					.then(() => {
						try {
							console.debug('Msghub presets: upsert start', { presetId: draft?.presetId });
						} catch {
							// ignore
						}
					})
					.then(() => {
						if (!ingestStatesApi?.presets?.upsert) {
							throw new Error('IngestStates presets API is not available');
						}
						return ingestStatesApi.presets.upsert({ preset: cloneJson(draft) });
					})
					.then(() => loadList({ selectPresetId: draft.presetId }))
					.then(() => {
						try {
							console.debug('Msghub presets: upsert ok', { presetId: draft?.presetId });
						} catch {
							// ignore
						}
					})
					.catch(e => {
						const msg = String(e?.message || e);
						setError(msg);
						toast(msg);
					})
					.finally(() => {
						saving = false;
						render();
					});
			};

			const abortEdit = () => {
				if (!confirmDiscardIfNeeded()) {
					return;
				}
				setError('');
				draft = cloneJson(original);
				isNew = false;
				render();
			};

			const updateDraft = patch => {
				draft = { ...(draft || {}), ...(patch || {}) };
			};

			const updateMessage = patch => {
				const cur = draft?.message && typeof draft.message === 'object' ? draft.message : {};
				updateDraft({ message: { ...cur, ...(patch || {}) } });
			};

			const updateMessageNested = (path, value) => {
				const parts = String(path || '')
					.split('.')
					.filter(Boolean);
				if (parts.length === 0) {
					return;
				}

				const next = cloneJson(draft?.message || {});
				let cur = next;
				for (let i = 0; i < parts.length - 1; i++) {
					const k = parts[i];
					if (!cur[k] || typeof cur[k] !== 'object') {
						cur[k] = {};
					}
					cur = cur[k];
				}
				cur[parts[parts.length - 1]] = value;
				updateMessage(next);
			};

			const updatePolicy = patch => {
				const cur = draft?.policy && typeof draft.policy === 'object' ? draft.policy : {};
				updateDraft({ policy: { ...cur, ...(patch || {}) } });
			};

			const resolveOptions = src =>
				resolveDynamicOptions(src).map(o => ({ value: o.value, label: pickText(o.label) }));

			const renderList = () => {
				sortPresets();

				const btnNew = h('button', {
					type: 'button',
					title: 'New',
					onclick: () => void createNew(),
					text: '+',
				});
				const btnReload = h('button', {
					type: 'button',
					title: 'Reload',
					onclick: e => {
						void loadList().catch(err => {
							const msg = String(err?.message || err);
							setError(msg);
							toast(msg);
						});
					},
					text: '⟳',
				});
				const btnDup = h('button', {
					type: 'button',
					title: 'Duplicate',
					onclick: () => void duplicateSelected(),
					text: '⧉',
				});
				const btnDel = h('button', {
					type: 'button',
					title: 'Delete',
					onclick: () => void deleteSelected(),
					text: '×',
				});

				const listHeader = h('div', { class: 'msghub-tools-presets-list-head' }, [
					h('div', { class: 'msghub-actions msghub-actions--inline' }, [btnNew, btnReload, btnDup, btnDel]),
				]);

				let items = null;
				if (listLoading) {
					items = h('div', { class: 'msghub-muted', text: 'Loading…' });
				} else if (presets.length === 0) {
					items = h('div', { class: 'msghub-muted', text: 'No presets yet. Click + to create one.' });
				} else {
					items = h(
						'div',
						{ class: 'msghub-tools-presets-list-items', style: 'max-height: 60vh; overflow: auto;' },
						presets.map(p =>
							h('button', {
								type: 'button',
								class: `msghub-tools-presets-item${p?.presetId === selectedId && !isNew ? ' active' : ''}`,
								onclick: () => void setSelected(p.presetId),
								text: presetLabel(p),
							}),
						),
					);
				}

				elList.replaceChildren(listHeader, items);
			};

			const renderEditor = () => {
				if (presetLoading) {
					elEditor.replaceChildren(h('p', { class: 'msghub-muted', text: 'Loading preset…' }));
					return;
				}
				if (!draft) {
					elEditor.replaceChildren(
						h('p', { class: 'msghub-muted', text: 'Select a preset or create a new one.' }),
					);
					return;
				}

				const ownedBy =
					typeof draft?.ownedBy === 'string' && draft.ownedBy.trim() ? draft.ownedBy.trim() : null;
				const disabled = !!ownedBy || saving === true;

				const fields = [];

				const fPresetId = buildFieldInput({
					type: 'string',
					key: 'presetId',
					label: 'Preset ID',
					value: draft.presetId,
					help: 'Storage id (A-Z a-z 0-9 _ -).',
				});
				if (fPresetId?.input) {
					fPresetId.input.disabled = disabled || isNew !== true;
				}
				fields.push(fPresetId);

				const fDescription = buildFieldInput({
					type: 'string',
					key: 'description',
					label: 'Display name',
					value: draft.description,
					help: 'Shown as common.name later.',
				});
				if (fDescription?.input) {
					fDescription.input.disabled = disabled;
				}
				fields.push(fDescription);

				const fSchema = buildFieldInput({
					type: 'string',
					key: 'schema',
					label: 'Schema',
					value: draft.schema,
					help: '',
				});
				if (fSchema?.input) {
					fSchema.input.disabled = true;
				}
				fields.push(fSchema);

				const fOwnedBy = buildFieldInput({
					type: 'string',
					key: 'ownedBy',
					label: 'Owned by (default preset)',
					value: ownedBy || '',
					help: '',
				});
				if (fOwnedBy?.input) {
					fOwnedBy.input.disabled = true;
				}
				fields.push(fOwnedBy);

				const kindOptions = resolveOptions('MsgConstants.kind');
				const levelOptions = resolveOptions('MsgConstants.level');

				fields.push(buildFieldInput({ type: 'header', key: '_h_msg', label: 'Message' }));
				const fKind = buildFieldInput({
					type: 'string',
					key: 'message_kind',
					label: 'Kind',
					value: draft?.message?.kind,
					options: kindOptions.length ? kindOptions : undefined,
				});
				if (fKind?.input) {
					fKind.input.disabled = disabled;
				}
				fields.push(fKind);

				const fLevel = buildFieldInput({
					type: 'number',
					key: 'message_level',
					label: 'Level',
					value: draft?.message?.level,
					options: levelOptions.length ? levelOptions : undefined,
				});
				if (fLevel?.input) {
					fLevel.input.disabled = disabled;
				}
				fields.push(fLevel);

				const titleField = (() => {
					const id = `f_title_${Math.random().toString(36).slice(2, 8)}`;
					const input = h('input', { type: 'text', id, value: draft?.message?.title ?? '' });
					if (disabled) {
						input.disabled = true;
					}
					return {
						input,
						getValue: () => input.value,
						wrapper: h('div', { class: 'msghub-field' }, [input, h('label', { for: id, text: 'Title' })]),
					};
				})();

				const iconField = (() => {
					const id = `f_icon_${Math.random().toString(36).slice(2, 8)}`;
					const input = h('input', { type: 'text', id, value: draft?.message?.icon ?? '' });
					if (disabled) {
						input.disabled = true;
					}
					return {
						input,
						getValue: () => input.value,
						wrapper: h('div', { class: 'msghub-field' }, [
							input,
							h('label', { for: id, text: 'Icon' }),
							h('div', { class: 'msghub-muted', text: 'Optional. Usually an emoji.' }),
						]),
					};
				})();

				const textField = (() => {
					const id = `f_text_${Math.random().toString(36).slice(2, 8)}`;
					const textarea = h('textarea', {
						id,
						class: '',
						text: draft?.message?.text ?? '',
					});
					if (disabled) {
						textarea.disabled = true;
					}
					return {
						textarea,
						getValue: () => textarea.value,
						wrapper: h('div', { class: 'msghub-field' }, [
							textarea,
							h('label', { for: id, text: 'Text' }),
							h('div', {
								class: 'msghub-muted',
								text: 'Templates (placeholder): {{m.state-value}}, {{m.lastSeenAt|datetime}}',
							}),
						]),
					};
				})();

				fields.push(titleField);
				fields.push(iconField);
				fields.push(textField);

				fields.push(buildFieldInput({ type: 'header', key: '_h_timing', label: 'Timing' }));
				const fTimeBudget = buildFieldInput({
					type: 'number',
					key: 'timing_timeBudget',
					label: 'Time budget',
					value: draft?.message?.timing?.timeBudget,
					unit: 'ms',
				});
				if (fTimeBudget?.input) {
					fTimeBudget.input.disabled = disabled;
				}
				if (fTimeBudget?.select) {
					fTimeBudget.select.disabled = disabled;
				}
				fields.push(fTimeBudget);

				const fDueIn = buildFieldInput({
					type: 'number',
					key: 'timing_dueInMs',
					label: 'Due in',
					value: draft?.message?.timing?.dueInMs,
					unit: 'ms',
				});
				if (fDueIn?.input) {
					fDueIn.input.disabled = disabled;
				}
				if (fDueIn?.select) {
					fDueIn.select.disabled = disabled;
				}
				fields.push(fDueIn);

				const fExpiresIn = buildFieldInput({
					type: 'number',
					key: 'timing_expiresInMs',
					label: 'Expires in',
					value: draft?.message?.timing?.expiresInMs,
					unit: 'ms',
				});
				if (fExpiresIn?.input) {
					fExpiresIn.input.disabled = disabled;
				}
				if (fExpiresIn?.select) {
					fExpiresIn.select.disabled = disabled;
				}
				fields.push(fExpiresIn);

				const fCooldown = buildFieldInput({
					type: 'number',
					key: 'timing_cooldown',
					label: 'Cooldown',
					value: draft?.message?.timing?.cooldown,
					unit: 'ms',
				});
				if (fCooldown?.input) {
					fCooldown.input.disabled = disabled;
				}
				if (fCooldown?.select) {
					fCooldown.select.disabled = disabled;
				}
				fields.push(fCooldown);

				const fRemindEvery = buildFieldInput({
					type: 'number',
					key: 'timing_remindEvery',
					label: 'Reminder',
					value: draft?.message?.timing?.remindEvery,
					unit: 'ms',
				});
				if (fRemindEvery?.input) {
					fRemindEvery.input.disabled = disabled;
				}
				if (fRemindEvery?.select) {
					fRemindEvery.select.disabled = disabled;
				}
				fields.push(fRemindEvery);

				fields.push(buildFieldInput({ type: 'header', key: '_h_details', label: 'Details' }));
				const fDetailsTask = buildFieldInput({
					type: 'string',
					key: 'details_task',
					label: 'Task',
					value: draft?.message?.details?.task ?? '',
				});
				if (fDetailsTask?.input) {
					fDetailsTask.input.disabled = disabled;
				}
				fields.push(fDetailsTask);

				const fDetailsReason = buildFieldInput({
					type: 'string',
					key: 'details_reason',
					label: 'Reason',
					value: draft?.message?.details?.reason ?? '',
				});
				if (fDetailsReason?.input) {
					fDetailsReason.input.disabled = disabled;
				}
				fields.push(fDetailsReason);

				const toolsField = (() => {
					const id = `f_tools_${Math.random().toString(36).slice(2, 8)}`;
					const input = h('input', {
						type: 'text',
						id,
						value: formatCsvList(draft?.message?.details?.tools),
					});
					if (disabled) {
						input.disabled = true;
					}
					return {
						input,
						getValue: () => parseCsvList(input.value),
						wrapper: h('div', { class: 'msghub-field' }, [
							input,
							h('label', { for: id, text: 'Tools (CSV)' }),
						]),
					};
				})();
				const consumablesField = (() => {
					const id = `f_consumables_${Math.random().toString(36).slice(2, 8)}`;
					const input = h('input', {
						type: 'text',
						id,
						value: formatCsvList(draft?.message?.details?.consumables),
					});
					if (disabled) {
						input.disabled = true;
					}
					return {
						input,
						getValue: () => parseCsvList(input.value),
						wrapper: h('div', { class: 'msghub-field' }, [
							input,
							h('label', { for: id, text: 'Consumables (CSV)' }),
						]),
					};
				})();
				fields.push(toolsField);
				fields.push(consumablesField);

				fields.push(buildFieldInput({ type: 'header', key: '_h_audience', label: 'Audience' }));
				const tagsField = (() => {
					const id = `f_tags_${Math.random().toString(36).slice(2, 8)}`;
					const input = h('input', {
						type: 'text',
						id,
						value: formatCsvList(draft?.message?.audience?.tags),
					});
					if (disabled) {
						input.disabled = true;
					}
					return {
						input,
						getValue: () => parseCsvList(input.value),
						wrapper: h('div', { class: 'msghub-field' }, [
							input,
							h('label', { for: id, text: 'Tags (CSV)' }),
						]),
					};
				})();
				const channelsIncludeField = (() => {
					const id = `f_chinc_${Math.random().toString(36).slice(2, 8)}`;
					const input = h('input', {
						type: 'text',
						id,
						value: formatCsvList(draft?.message?.audience?.channels?.include),
					});
					if (disabled) {
						input.disabled = true;
					}
					return {
						input,
						getValue: () => parseCsvList(input.value),
						wrapper: h('div', { class: 'msghub-field' }, [
							input,
							h('label', { for: id, text: 'Channels include (CSV)' }),
						]),
					};
				})();
				const channelsExcludeField = (() => {
					const id = `f_chexc_${Math.random().toString(36).slice(2, 8)}`;
					const input = h('input', {
						type: 'text',
						id,
						value: formatCsvList(draft?.message?.audience?.channels?.exclude),
					});
					if (disabled) {
						input.disabled = true;
					}
					return {
						input,
						getValue: () => parseCsvList(input.value),
						wrapper: h('div', { class: 'msghub-field' }, [
							input,
							h('label', { for: id, text: 'Channels exclude (CSV)' }),
						]),
					};
				})();
				fields.push(tagsField);
				fields.push(channelsIncludeField);
				fields.push(channelsExcludeField);

				fields.push(buildFieldInput({ type: 'header', key: '_h_actions', label: 'Actions (JSON)' }));
				const actionsField = (() => {
					const id = `f_actions_${Math.random().toString(36).slice(2, 8)}`;
					const textarea = h('textarea', {
						id,
						class: '',
						text: JSON.stringify(draft?.message?.actions || [], null, 2),
					});
					if (disabled) {
						textarea.disabled = true;
					}
					return {
						textarea,
						getValue: () => {
							const raw = typeof textarea.value === 'string' ? textarea.value.trim() : '';
							if (!raw) {
								return [];
							}
							try {
								const parsed = JSON.parse(raw);
								return Array.isArray(parsed) ? parsed : [];
							} catch {
								return null;
							}
						},
						wrapper: h('div', { class: 'msghub-field' }, [
							textarea,
							h('label', { for: id, text: 'Actions array' }),
							h('div', { class: 'msghub-muted', text: 'Optional; must be valid JSON array.' }),
						]),
					};
				})();
				fields.push(actionsField);

				fields.push(buildFieldInput({ type: 'header', key: '_h_policy', label: 'Policy' }));
				const fResetOnNormal = buildFieldInput({
					type: 'boolean',
					key: 'policy_resetOnNormal',
					label: 'Reset on normal (auto-close)',
					value: draft?.policy?.resetOnNormal === true,
				});
				if (fResetOnNormal?.input) {
					fResetOnNormal.input.disabled = disabled;
				}
				fields.push(fResetOnNormal);

				const btnSave = h('button', {
					type: 'button',
					disabled: disabled ? true : undefined,
					onclick: () => saveDraft(),
					text: 'Save',
				});
				const btnAbort = h('button', {
					type: 'button',
					disabled: saving ? true : undefined,
					onclick: () => abortEdit(),
					text: 'Cancel',
				});

				const elError = lastError
					? h('div', { class: 'msghub-error', text: String(lastError) })
					: saving
						? h('div', { class: 'msghub-muted', text: 'Saving…' })
						: null;

				const wrapper = h('div', null, [
					h('div', null, [
						ownedBy
							? h('div', {
									class: 'msghub-muted',
									text: `This is a default preset owned by '${ownedBy}' (view-only in this editor).`,
								})
							: null,
						elError,
						...fields.map(f => f.wrapper),
						h('div', { class: 'msghub-actions msghub-actions--inline' }, [btnSave, btnAbort]),
					]),
				]);

				// Wire field changes into draft
				const apply = () => {
					updateDraft({
						presetId: String(fPresetId?.getValue ? fPresetId.getValue() : '').trim(),
						description: String(fDescription?.getValue ? fDescription.getValue() : ''),
						schema: String(fSchema?.getValue ? fSchema.getValue() : ''),
						ownedBy: ownedBy,
					});
					updateMessage({
						kind: fKind?.getValue ? fKind.getValue() : undefined,
						level: fLevel?.getValue ? fLevel.getValue() : undefined,
					});
					updateMessageNested('title', titleField.getValue());
					updateMessageNested('icon', iconField.getValue());
					updateMessageNested('text', textField.getValue());
					updateMessageNested('timing.timeBudget', fTimeBudget?.getValue ? fTimeBudget.getValue() || 0 : 0);
					updateMessageNested('timing.dueInMs', fDueIn?.getValue ? fDueIn.getValue() || 0 : 0);
					updateMessageNested('timing.expiresInMs', fExpiresIn?.getValue ? fExpiresIn.getValue() || 0 : 0);
					updateMessageNested('timing.cooldown', fCooldown?.getValue ? fCooldown.getValue() || 0 : 0);
					updateMessageNested(
						'timing.remindEvery',
						fRemindEvery?.getValue ? fRemindEvery.getValue() || 0 : 0,
					);
					updateMessageNested('details.task', fDetailsTask?.getValue ? fDetailsTask.getValue() : '');
					updateMessageNested('details.reason', fDetailsReason?.getValue ? fDetailsReason.getValue() : '');
					updateMessageNested('details.tools', toolsField.getValue());
					updateMessageNested('details.consumables', consumablesField.getValue());
					updateMessageNested('audience.tags', tagsField.getValue());
					updateMessageNested('audience.channels.include', channelsIncludeField.getValue());
					updateMessageNested('audience.channels.exclude', channelsExcludeField.getValue());
					const actions = actionsField.getValue();
					if (actions !== null) {
						updateMessageNested('actions', actions);
					}
					updatePolicy({
						resetOnNormal: fResetOnNormal?.getValue ? fResetOnNormal.getValue() === true : false,
					});

					const kind = String(draft?.message?.kind || '');
					const isTask = kind === 'task';
					fTimeBudget.wrapper.style.display = isTask ? '' : 'none';
					fDueIn.wrapper.style.display = isTask ? '' : 'none';
					fDetailsTask.wrapper.style.display = isTask ? '' : 'none';
				};

				const watch = input => {
					if (!input) {
						return;
					}
					input.addEventListener('change', apply);
					input.addEventListener('input', apply);
				};

				// Basic fields
				watch(fPresetId.input);
				watch(fDescription.input);
				watch(fKind.input);
				watch(fLevel.input);
				watch(titleField.input);
				watch(iconField.input);
				watch(textField.textarea);

				// Timing fields
				watch(fTimeBudget.input);
				watch(fTimeBudget.select);
				watch(fDueIn.input);
				watch(fDueIn.select);
				watch(fExpiresIn.input);
				watch(fExpiresIn.select);
				watch(fCooldown.input);
				watch(fCooldown.select);
				watch(fRemindEvery.input);
				watch(fRemindEvery.select);

				// Details + audience + policy
				watch(fDetailsTask.input);
				watch(fDetailsReason.input);
				watch(toolsField.input);
				watch(consumablesField.input);
				watch(tagsField.input);
				watch(channelsIncludeField.input);
				watch(channelsExcludeField.input);
				watch(actionsField.textarea);
				watch(fResetOnNormal.input);

				apply();

				elEditor.replaceChildren(wrapper);
			};

			const render = () => {
				renderList();
				renderEditor();
			};

			el.appendChild(
				h(
					'div',
					{ class: 'msghub-tools-presets-grid', style: 'display: flex; gap: 16px; align-items: flex-start;' },
					[elList, elEditor],
				),
			);
			render();
			void loadList().catch(e => {
				const msg = String(e?.message || e);
				setError(msg);
				toast(msg);
			});
			return el;
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

		function renderInstanceRow({ plugin, inst, instList, expandedById, readmesByType }) {
			const statusSafe = cssSafe(inst?.status || 'unknown');
			const stateClass = `msghub-plugin-state-${statusSafe}`;
			const categoryRaw = typeof plugin?.category === 'string' ? plugin.category : 'unknown';
			const categorySafe = cssSafe(categoryRaw);

			const fields = getPluginFields(plugin);
			const instanceTitleKey = getInstanceTitleFieldKey(fields);
			const hasOptions = fields.length > 0;
			const instAccKey = toAccKey({ kind: 'inst', type: plugin.type, instanceId: inst.instanceId });
			const instExpanded = expandedById instanceof Map ? expandedById.get(instAccKey) : undefined;

			const readme = readmesByType instanceof Map ? readmesByType.get(String(plugin?.type || '')) : null;
			const hasReadme = !!readme?.md?.trim?.();

			const instanceTitleValue = formatInstanceTitleValue({ inst, fieldKey: instanceTitleKey, plugin });
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
					renderMarkdownLite(readme.md),
				]);
				openViewer({
					title: `${plugin.type} · User Guide`,
					bodyEl: body,
				});
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
					openViewer({
						title: `${plugin.type} · Tools`,
						bodyEl: body,
					});

					Promise.resolve()
						.then(async () => {
							await ensureConstantsLoaded();
							const ingestConstants = await ensureIngestStatesConstantsLoaded();
							if (toolId === 'bulk') {
								const schema = await ensureIngestStatesSchema();
								body.replaceChildren(
									renderIngestStatesBulkApply({ instances: instList, schema, ingestConstants }),
								);
								return;
							}
							if (toolId === 'presets') {
								body.replaceChildren(renderIngestStatesMessagePresetsTool({ ingestConstants }));
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
					ui.contextMenu.open({
						anchorEl: anchorEl instanceof HTMLElement ? anchorEl : null,
						anchorPoint: !anchorEl && e ? { x: e.clientX, y: e.clientY } : null,
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
					if (!pluginsApi?.setEnabled) {
						throw new Error('Plugins API is not available');
					}
					await pluginsApi.setEnabled({
						type: plugin.type,
						instanceId: inst.instanceId,
						enabled: inst?.enabled !== true,
					});
					await refreshAll();
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
								if (!pluginsApi?.updateInstance) {
									throw new Error('Plugins API is not available');
								}
								await pluginsApi.updateInstance({
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
					if (!pluginsApi?.deleteInstance) {
						throw new Error('Plugins API is not available');
					}
					await pluginsApi.deleteInstance({ type: plugin.type, instanceId: inst.instanceId });
					await refreshAll();
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

				head.oncontextmenu = e => openPluginsContextMenu(e, instanceMenuCtx);

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
					accInput.dispatchEvent(new Event('change', { bubbles: true }));
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
					bodyWrap.oncontextmenu = e => openPluginsContextMenu(e, instanceMenuCtx);
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
					const { input, select, wrapper, getValue, skipSave } = buildFieldInput({
						type: field.type,
						key,
						label:
							field.type === 'header' ? pickText(field.label) || '' : pickText(field.label) || field.key,
						help: pickText(field.help) || '',
						value: effectiveValue,
						unit,
						min: field.min,
						max: field.max,
						step: field.step,
						options: field.options,
						multiOptions: field.multiOptions,
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
						if (!pluginsApi?.updateInstance) {
							throw new Error('Plugins API is not available');
						}
						saveBtn.setAttribute('data-saving', '1');
						saveBtn.disabled = true;
						saveBtn.setAttribute('aria-disabled', 'true');
						try {
							await pluginsApi.updateInstance({
								type: plugin.type,
								instanceId: inst.instanceId,
								nativePatch: patch,
							});

							for (const [k, info] of Object.entries(inputs)) {
								initial[k] = normalize(info.getValue());
							}
						} catch (e) {
							toast(String(e?.message || e));
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

		async function refreshAll() {
			try {
				await ensureConstantsLoaded();
				const expandedById = captureAccordionState();
				if (!pluginsApi?.getCatalog || !pluginsApi?.listInstances) {
					throw new Error('Plugins API is not available');
				}
				const { plugins } = await pluginsApi.getCatalog();
				const { instances } = await pluginsApi.listInstances();

				const readmesByType = await ensurePluginReadmesLoaded();

				const vm = buildPluginsViewModel({ plugins, instances, readmesByType });
				const withUi = (vm.plugins || []).filter(p => p && p.options && typeof p.options === 'object');
				cachedPluginsWithUi = withUi;

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

				const allEntries = Array.from(entriesByCategory.values()).reduce((acc, v) => acc + (v?.length || 0), 0);

				const fragment = document.createDocumentFragment();

				if (allEntries === 0) {
					fragment.appendChild(
						h('p', { class: 'msghub-muted', text: t('msghub.i18n.core.admin.ui.plugins.empty.text') }),
					);
				}

				for (const category of CATEGORY_ORDER) {
					const entries = entriesByCategory.get(category) || [];
					entries.sort(
						(a, b) =>
							String(a?.plugin?.type || '').localeCompare(String(b?.plugin?.type || '')) ||
							(a?.inst?.instanceId ?? 0) - (b?.inst?.instanceId ?? 0),
					);
					if (entries.length === 0) {
						continue;
					}

						const section = h('div', { class: 'msghub-plugin-category', 'data-category': category }, [
							(() => {
								const cfg = CATEGORY_I18N[category] || null;
								const title = cfg
									? tOr(cfg.titleKey, cfg.fallbackTitle || category)
									: tOr(`msghub.i18n.core.admin.ui.plugins.category.${category}.title`, category);
								const desc = cfg
									? tOr(cfg.descKey, '')
									: tOr(`msghub.i18n.core.admin.ui.plugins.category.${category}.desc`, '');
								const categorySafe = cssSafe(category);
								const row = h('div', { class: 'msghub-plugin-category-row' }, [
									h('h6', {
										class: 'msghub-plugin-category-title',
										text: title || category,
									}),
									desc
										? h('div', { class: 'msghub-muted msghub-plugin-category-desc', text: desc })
										: null,
								]);
								row.oncontextmenu = e =>
									openPluginsContextMenu(e, { kind: 'category', categoryRaw: category, categorySafe });
								return row;
							})(),
						]);

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

				elRoot.replaceChildren(fragment);
			} catch (e) {
				elRoot.replaceChildren(
					h('div', {
						class: 'msghub-error',
						text: t('msghub.i18n.core.admin.ui.plugins.loadFailed.text', String(e?.message || e)),
					}),
				);
			}
		}

		async function refreshPlugin(type) {
			return refreshAll();
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
