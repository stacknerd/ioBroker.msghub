/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/* global window */
(function () {
	'use strict';

	const win = window;

	function createPluginsPresetsApi(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const h = typeof opts.h === 'function' ? opts.h : () => ({});
		const ui = opts.ui || null;
		const confirmDialog = typeof opts.confirmDialog === 'function' ? opts.confirmDialog : async () => false;
		const formApi = opts.formApi || null;
		const pickText = typeof opts.pickText === 'function' ? opts.pickText : v => String(v ?? '');
		const ingestStatesDataApi = opts.ingestStatesDataApi || null;
		const t = typeof opts.t === 'function' ? opts.t : k => k;
		const getMsgConstants = typeof opts.getMsgConstants === 'function' ? opts.getMsgConstants : () => null;

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
			const presetBindingCatalog =
				ingestConstants && typeof ingestConstants.presetBindingCatalog === 'object'
					? ingestConstants.presetBindingCatalog
					: null;
			const ruleTemplateCatalog =
				ingestConstants && typeof ingestConstants.ruleTemplateCatalog === 'object'
					? ingestConstants.ruleTemplateCatalog
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
			const BINDING_NONE_VALUE = '__msghub_none__';

			const defaultPreset = ({
				presetId = '',
				description = '',
				source = 'user',
				ownedBy = '',
				kind = 'status',
				level = 20,
				subset = null,
			} = {}) => {
				const preset = buildPresetBase();
				preset.schema = presetSchema;
				preset.presetId = String(presetId || '').trim();
				preset.description = typeof description === 'string' ? description : '';
				preset.source = source === 'builtin' ? 'builtin' : 'user';
				preset.ownedBy = typeof ownedBy === 'string' && ownedBy.trim() ? ownedBy.trim() : null;
				preset.subset = String(subset ?? '').trim() || null;
				if (!preset.message || typeof preset.message !== 'object') {
					preset.message = {};
				}
				preset.message.kind = kind;
				preset.message.level = level;
				preset.message.icon = typeof preset.message.icon === 'string' ? preset.message.icon : '';
				preset.message.title = typeof preset.message.title === 'string' ? preset.message.title : '';
				preset.message.text = typeof preset.message.text === 'string' ? preset.message.text : '';
				preset.message.textRecovered =
					typeof preset.message.textRecovered === 'string' ? preset.message.textRecovered : '';
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
				if (Object.prototype.hasOwnProperty.call(preset, 'ui')) {
					delete preset.ui;
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
			const elList = h('div', { class: 'msghub-tools-presets-list' });
			const elEditor = h('div', { class: 'msghub-tools-presets-editor' });

			const isDirty = () => JSON.stringify(original) !== JSON.stringify(draft);

			const sortPresets = () => {
				const sortText = value =>
					typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
				const compareText = (a, b) =>
					sortText(a).localeCompare(sortText(b), undefined, { sensitivity: 'base' });

				presets.sort((a, b) => {
					const aOwnedBy = sortText(a?.ownedBy);
					const bOwnedBy = sortText(b?.ownedBy);
					const aIsCustom = !aOwnedBy;
					const bIsCustom = !bOwnedBy;

					if (aIsCustom !== bIsCustom) {
						return aIsCustom ? -1 : 1;
					}

					if (aIsCustom && bIsCustom) {
						return compareText(a?.description, b?.description);
					}

					const ownedByCmp = compareText(aOwnedBy, bOwnedBy);
					if (ownedByCmp !== 0) {
						return ownedByCmp;
					}

					const subsetCmp = compareText(a?.subset, b?.subset);
					if (subsetCmp !== 0) {
						return subsetCmp;
					}

					return compareText(a?.description, b?.description);
				});
			};

			const loadList = async ({ selectPresetId = '', renderLoading = true, showLoadingToast = false } = {}) => {
				const spinnerId = showLoadingToast ? showSpinner('msghub-presets-list-load') : null;
				listLoading = true;
				if (renderLoading) {
					render();
				}

				try {
					const opts = await ingestStatesDataApi.listPresets();
					const items = Array.isArray(opts) ? opts : [];

					const next = [];
					for (const o of items) {
						const id = typeof o?.value === 'string' ? o.value.trim() : '';
						if (!isPresetId(id)) {
							continue;
						}
						next.push(
							defaultPreset({
								presetId: id,
								description: typeof o.name === 'string' ? o.name.trim() : '',
								source: typeof o.source === 'string' ? o.source.trim() : 'user',
								ownedBy: typeof o.ownedBy === 'string' ? o.ownedBy.trim() : '',
								kind: typeof o.kind === 'string' ? o.kind : 'status',
								level: typeof o.level === 'number' ? o.level : 20,
								subset: typeof o.subset === 'string' ? o.subset.trim() || null : null,
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
				} finally {
					hideSpinner(spinnerId);
				}
			};

			const loadPreset = async presetId => {
				const id = String(presetId || '').trim();
				if (!isPresetId(id)) {
					return null;
				}
				const res = await ingestStatesDataApi.getPreset({ presetId: id });
				const preset = res?.preset;
				if (!preset || typeof preset !== 'object') {
					return null;
				}
				return preset;
			};

			const toast = (text, variant = 'neutral') => {
				try {
					console.warn(`Msghub presets: ${String(text || '')}`);
				} catch {
					// ignore
				}
				try {
					ui?.toast?.({ text: String(text || ''), variant });
				} catch {
					// ignore
				}
			};

			const showSpinner = spinnerId => {
				try {
					return (
						ui?.spinner?.show?.({
							id: spinnerId,
							message: t('msghub.i18n.core.admin.ui.loading.text'),
						}) ?? null
					);
				} catch {
					return null;
				}
			};

			const hideSpinner = spinnerId => {
				if (!spinnerId) {
					return;
				}
				try {
					ui?.spinner?.hide?.(spinnerId);
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
				if (presetLoading) {
					return;
				}
				if (!(await confirmDiscardIfNeeded())) {
					return;
				}
				const nextId = String(presetId || '').trim();
				if (!nextId) {
					return;
				}
				setError('');
				presetLoading = true;
				const spinnerId = showSpinner('msghub-presets-item-load');
				try {
					const preset = await loadPreset(nextId);
					if (!preset) {
						const msg = `Preset '${nextId}' could not be loaded`;
						setError(msg);
						toast(msg, 'danger');
						return;
					}
					selectedId = nextId;
					original = cloneJson(preset);
					draft = cloneJson(original);
					isNew = false;
				} catch (e) {
					const msg = String(e?.message || e);
					setError(msg);
					toast(msg, 'danger');
				} finally {
					presetLoading = false;
					hideSpinner(spinnerId);
					render();
				}
			};

			const createNew = async () => {
				if (!(await confirmDiscardIfNeeded())) {
					return;
				}
				setError('');
				original = null;
				draft = defaultPreset({
					presetId: '',
					description: '',
					source: 'user',
					ownedBy: '',
					kind: 'status',
					level: 20,
				});
				isNew = true;
				render();
			};

			const duplicateSelected = async () => {
				if (!(await confirmDiscardIfNeeded())) {
					return;
				}
				if (!original || typeof original !== 'object') {
					toast('No preset selected', 'warning');
					return;
				}
				setError('');
				original = null;
				draft = cloneJson(draft);
				draft.presetId = '';
				draft.source = 'user';
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
						return ingestStatesDataApi.deletePreset({ presetId: id });
					})
					.then(() => loadList({ renderLoading: false, showLoadingToast: true }))
					.catch(e => {
						const msg = String(e?.message || e);
						setError(msg);
						toast(msg, 'danger');
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
				if (draft?.source !== 'user' && draft?.source !== 'builtin') {
					return 'Missing/invalid required field: source';
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
					toast(err, 'danger');
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
						const preset = cloneJson(draft);
						if (
							preset &&
							typeof preset === 'object' &&
							Object.prototype.hasOwnProperty.call(preset, 'ui')
						) {
							delete preset.ui;
						}
						return ingestStatesDataApi.upsertPreset({ preset });
					})
					.then(() =>
						loadList({ selectPresetId: draft.presetId, renderLoading: false, showLoadingToast: true }),
					)
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
						toast(msg, 'danger');
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
				formApi.resolveDynamicOptions(src).map(o => ({ value: o.value, label: pickText(o.label) }));

			const getBindingEntries = () => Object.values(presetBindingCatalog || {}).filter(Boolean);
			const normalizeBindingValue = value => {
				const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
				return text === BINDING_NONE_VALUE ? '' : text;
			};

			const getBindingEntryByOwnedBy = ownedByValue => {
				const ownedByText =
					typeof ownedByValue === 'string'
						? ownedByValue.trim().toLowerCase()
						: String(ownedByValue ?? '')
								.trim()
								.toLowerCase();
				if (!ownedByText) {
					return null;
				}
				return (
					getBindingEntries().find(entry => {
						const candidate = typeof entry?.ownedBy === 'string' ? entry.ownedBy.trim().toLowerCase() : '';
						return candidate === ownedByText;
					}) || null
				);
			};

			const getBindingCatalogEntry = ownedByValue => {
				const ownedByText = normalizeBindingValue(ownedByValue).toLowerCase();
				if (!ownedByText) {
					return null;
				}
				return (
					Object.entries(presetBindingCatalog || {}).find(([, entry]) => {
						const candidate = typeof entry?.ownedBy === 'string' ? entry.ownedBy.trim().toLowerCase() : '';
						return candidate === ownedByText;
					}) || null
				);
			};

			const getOwnedByOptions = () => {
				const opts = [
					{
						value: BINDING_NONE_VALUE,
						label: '(keine spezifische Regel)',
					},
				];
				for (const entry of getBindingEntries()) {
					const value = typeof entry?.ownedBy === 'string' ? entry.ownedBy.trim() : '';
					if (!value) {
						continue;
					}
					const labelKey = typeof entry?.headerKey === 'string' ? entry.headerKey : '';
					opts.push({
						value,
						label: labelKey ? t(labelKey) : value,
					});
				}
				return opts;
			};

			const getSubsetOptions = ownedByValue => {
				const entry = getBindingEntryByOwnedBy(ownedByValue);
				const opts = [
					{
						value: BINDING_NONE_VALUE,
						label: '(keine weitere Eingrenzung)',
					},
				];
				if (!entry || !Array.isArray(entry.subsets) || entry.subsets.length === 0) {
					return opts;
				}
				for (const subset of entry.subsets) {
					const value = typeof subset?.value === 'string' ? subset.value : '';
					if (!value) {
						continue;
					}
					const labelKey = typeof subset?.labelKey === 'string' ? subset.labelKey : '';
					opts.push({
						value,
						label: labelKey ? t(labelKey) : value,
					});
				}
				return opts;
			};

			const getSubsetText = (ownedByValue, subsetValue) => {
				const subsetText = typeof subsetValue === 'string' ? subsetValue.trim() : '';
				if (!subsetText) {
					return '';
				}
				const entry = getBindingEntryByOwnedBy(ownedByValue);
				if (!entry || !Array.isArray(entry.subsets)) {
					return subsetText;
				}
				const match =
					entry.subsets.find(option => {
						const value = typeof option?.value === 'string' ? option.value.trim() : '';
						return value === subsetText;
					}) || null;
				if (!match) {
					return subsetText;
				}
				return typeof match?.labelKey === 'string' && match.labelKey ? t(match.labelKey) : subsetText;
			};

			const getAllowedTemplateEntries = (ownedByValue, subsetValue) => {
				const bindingEntry = getBindingCatalogEntry(ownedByValue);
				if (!bindingEntry) {
					return [];
				}
				const [ruleId] = bindingEntry;
				const ruleEntry =
					ruleTemplateCatalog && typeof ruleTemplateCatalog === 'object' ? ruleTemplateCatalog[ruleId] : null;
				const metrics =
					ruleEntry && ruleEntry.metrics && typeof ruleEntry.metrics === 'object' ? ruleEntry.metrics : null;
				if (!metrics) {
					return [];
				}
				const subsetText = normalizeBindingValue(subsetValue);
				const out = [];
				for (const [metricKey, metricEntry] of Object.entries(metrics)) {
					if (!metricEntry || typeof metricEntry !== 'object') {
						continue;
					}
					const metricSubsets = Array.isArray(metricEntry.subset) ? metricEntry.subset : null;
					if (!subsetText && metricSubsets) {
						continue;
					}
					if (subsetText && metricSubsets && !metricSubsets.includes(subsetText)) {
						continue;
					}
					out.push({
						metricKey,
						template: `{{m.${metricKey}}}`,
						label:
							typeof metricEntry.labelKey === 'string' && metricEntry.labelKey
								? t(metricEntry.labelKey)
								: metricKey,
						help:
							typeof metricEntry.helpKey === 'string' && metricEntry.helpKey
								? t(metricEntry.helpKey)
								: '',
					});
				}
				return out;
			};

			const syncSelectOptions = (input, options, selectedValue, { disabled: isDisabled = false } = {}) => {
				if (!input || input.tagName !== 'SELECT') {
					return;
				}
				const nextOptions = Array.isArray(options) ? options : [];
				input.replaceChildren(
					...nextOptions.map(option =>
						h('option', {
							value: String(option?.value ?? ''),
							text: String(option?.label ?? option?.value ?? ''),
						}),
					),
				);
				const normalizedSelected =
					selectedValue === undefined || selectedValue === null ? BINDING_NONE_VALUE : String(selectedValue);
				const allowedValues = new Set(nextOptions.map(option => String(option?.value ?? '')));
				input.value = allowedValues.has(normalizedSelected) ? normalizedSelected : BINDING_NONE_VALUE;
				input.disabled = isDisabled;
			};

			const renderList = () => {
				sortPresets();

				const btnNew = h('button', {
					type: 'button',
					class: 'msghub-uibutton-text',
					title: 'New',
					onclick: () => void createNew(),
					text: '+',
				});
				const btnReload = h('button', {
					type: 'button',
					class: 'msghub-uibutton-text',
					title: 'Reload',
					onclick: _e => {
						void loadList({ renderLoading: false, showLoadingToast: true }).catch(err => {
							const msg = String(err?.message || err);
							setError(msg);
							toast(msg, 'danger');
						});
					},
					text: '⟳',
				});
				const btnDup = h('button', {
					type: 'button',
					class: 'msghub-uibutton-text',
					title: 'Duplicate',
					onclick: () => void duplicateSelected(),
					text: '⧉',
				});
				const btnDel = h('button', {
					type: 'button',
					class: 'msghub-uibutton-text',
					title: 'Delete',
					onclick: () => void deleteSelected(),
					text: '×',
				});

				const listHeader = h('div', { class: 'msghub-tools-presets-list-head' }, [
					h('div', { class: 'msghub-toolbar__group' }, [btnNew, btnReload, btnDup, btnDel]),
				]);

				let items = null;
				if (listLoading) {
					items = h('div', { class: 'msghub-muted', text: 'Loading…' });
				} else if (presets.length === 0) {
					items = h('div', { class: 'msghub-muted', text: 'No presets yet. Click + to create one.' });
				} else {
					const constants = getMsgConstants();
					const levelMap = constants?.level && typeof constants.level === 'object' ? constants.level : null;
					const levelKeyMap = levelMap
						? Object.keys(levelMap).reduce((acc, key) => {
								const val = levelMap[key];
								if (typeof val === 'number') {
									acc[val] = key;
								}
								return acc;
							}, {})
						: {};

					const rows = presets.map(p => {
						const ownedBy = p?.ownedBy;
						const entry = getBindingEntryByOwnedBy(ownedBy);
						const ownedByText = ownedBy
							? typeof entry?.headerKey === 'string' && entry.headerKey
								? t(entry.headerKey)
								: ownedBy
							: t('msghub.i18n.IngestStates.admin.jsonCustom.preset.global.label');
						const subsetRaw = typeof p?.subset === 'string' ? p.subset : '';
						const subsetText = getSubsetText(ownedBy, subsetRaw);
						const kindKey = String(p?.message?.kind || '').trim();
						const kindText = kindKey
							? t(`msghub.i18n.core.admin.common.MsgConstants.kind.${kindKey}.label`)
							: kindKey;
						const level = p?.message?.level;
						const levelKey = typeof level === 'number' ? levelKeyMap[level] : undefined;
						const levelText = levelKey
							? t(`msghub.i18n.core.admin.common.MsgConstants.level.${levelKey}.label`)
							: String(level ?? '');
						const isSelected = p?.presetId === selectedId && !isNew;
						return h(
							'tr',
							{ class: isSelected ? 'is-selected' : '', onclick: () => void setSelected(p.presetId) },
							[
								h('td', {
									class: 'msghub-colCell msghub-col--preset-ownedBy',
									text: ownedByText,
									title: ownedByText,
								}),
								h('td', {
									class: 'msghub-colCell msghub-col--preset-subset',
									text: subsetText,
									title: subsetText,
								}),
								h('td', {
									class: 'msghub-colCell msghub-col--preset-kind',
									text: kindText,
									title: kindText,
								}),
								h('td', {
									class: 'msghub-colCell msghub-col--preset-level',
									text: levelText,
									title: levelText,
								}),
								h('td', {
									class: 'msghub-colCell msghub-col--preset-name',
									text: p?.description || '',
									title: p?.description || '',
								}),
							],
						);
					});

					items = h('div', { class: 'msghub-tools-presets-list-items' }, [
						h('table', { class: 'msghub-table msghub-presets-table' }, [
							h('colgroup', null, [
								h('col', { class: 'msghub-col--preset-ownedBy' }),
								h('col', { class: 'msghub-col--preset-subset' }),
								h('col', { class: 'msghub-col--preset-kind' }),
								h('col', { class: 'msghub-col--preset-level' }),
								h('col', { class: 'msghub-col--preset-name' }),
							]),
							h('thead', null, [
								h('tr', null, [
									h('th', {
										class: 'msghub-th msghub-colCell msghub-col--preset-ownedBy',
										text: t('msghub.i18n.IngestStates.admin.presets.ownedBy.label'),
										title: t('msghub.i18n.IngestStates.admin.presets.ownedBy.label'),
									}),
									h('th', {
										class: 'msghub-th msghub-colCell msghub-col--preset-subset',
										text: t('msghub.i18n.IngestStates.admin.presets.subset.label'),
										title: t('msghub.i18n.IngestStates.admin.presets.subset.label'),
									}),
									h('th', {
										class: 'msghub-th msghub-colCell msghub-col--preset-kind',
										text: t('msghub.i18n.core.admin.common.MsgConstants.field.kind.label'),
										title: t('msghub.i18n.core.admin.common.MsgConstants.field.kind.label'),
									}),
									h('th', {
										class: 'msghub-th msghub-colCell msghub-col--preset-level',
										text: t('msghub.i18n.core.admin.common.MsgConstants.field.level.label'),
										title: t('msghub.i18n.core.admin.common.MsgConstants.field.level.label'),
									}),
									h('th', {
										class: 'msghub-th msghub-colCell msghub-col--preset-name',
										text: t('msghub.i18n.IngestStates.admin.presets.name.label'),
										title: t('msghub.i18n.IngestStates.admin.presets.name.label'),
									}),
								]),
							]),
							h('tbody', null, rows),
						]),
					]);
				}

				elList.replaceChildren(listHeader, items);
			};

			const renderEditor = () => {
				if (!draft) {
					elEditor.replaceChildren(
						h('p', { class: 'msghub-muted', text: 'Select a preset or create a new one.' }),
					);
					return;
				}

				const ownedBy =
					typeof draft?.ownedBy === 'string' && draft.ownedBy.trim() ? draft.ownedBy.trim() : null;
				const source = draft?.source === 'builtin' ? 'builtin' : 'user';
				const disabled = source !== 'user' || saving === true;

				const fields = [];

				const fPresetId = formApi.buildFieldInput({
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

				const fDescription = formApi.buildFieldInput({
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

				const fSchema = formApi.buildFieldInput({
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

				const fOwnedBy = formApi.buildFieldInput({
					type: 'string',
					key: 'ownedBy',
					label: t('msghub.i18n.IngestStates.admin.presets.ownedBy.label'),
					value: ownedBy || BINDING_NONE_VALUE,
					options: getOwnedByOptions(),
					help: '',
				});
				if (fOwnedBy?.input) {
					fOwnedBy.input.disabled = disabled;
				}
				fields.push(fOwnedBy);

				const fSubset = formApi.buildFieldInput({
					type: 'string',
					key: 'subset',
					label: t('msghub.i18n.IngestStates.admin.presets.subset.label'),
					value: typeof draft?.subset === 'string' && draft.subset ? draft.subset : BINDING_NONE_VALUE,
					options: getSubsetOptions(ownedBy),
					help: '',
				});
				if (fSubset?.input) {
					fSubset.input.disabled = disabled;
				}
				fields.push(fSubset);

				const kindOptions = resolveOptions('MsgConstants.kind');
				const levelOptions = resolveOptions('MsgConstants.level');

				fields.push(formApi.buildFieldInput({ type: 'header', key: '_h_msg', label: 'Message' }));
				const fKind = formApi.buildFieldInput({
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

				const fLevel = formApi.buildFieldInput({
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
						wrapper: h('div', { class: 'msghub-field' }, [textarea, h('label', { for: id, text: 'Text' })]),
					};
				})();

				const allowedTemplatesField = (() => {
					const content = h('div', { class: 'msghub-muted' });
					return {
						content,
						update(nextOwnedBy, nextSubset) {
							const entries = getAllowedTemplateEntries(nextOwnedBy, nextSubset);
							if (!entries.length) {
								content.replaceChildren(
									h('div', {
										class: 'msghub-muted',
										text: t('msghub.i18n.IngestStates.admin.presets.allowedTemplates.empty.text'),
									}),
								);
								return;
							}
							content.replaceChildren(
								...entries.map(entry =>
									h('div', { class: 'msghub-muted' }, [
										h('div', {
											text: `${entry.template} - ${entry.label}`,
										}),
										entry.help
											? h('div', {
													text: entry.help,
												})
											: null,
										h('br'),
									]),
								),
							);
						},
						wrapper: h('div', { class: 'msghub-field' }, [
							h('div', {
								class: 'msghub-field-header-label',
								text: t('msghub.i18n.IngestStates.admin.presets.allowedTemplates.label'),
							}),
							content,
						]),
					};
				})();

				const textRecoveredField = (() => {
					const id = `f_textRecovered_${Math.random().toString(36).slice(2, 8)}`;
					const textarea = h('textarea', {
						id,
						class: '',
						text: draft?.message?.textRecovered ?? '',
					});
					if (disabled) {
						textarea.disabled = true;
					}
					return {
						textarea,
						getValue: () => textarea.value,
						wrapper: h('div', { class: 'msghub-field' }, [
							textarea,
							h('label', { for: id, text: 'Text (recovered)' }),
							h('div', {
								class: 'msghub-muted',
								text: 'Optional. Shown when the condition that triggered this message has been resolved.',
							}),
						]),
					};
				})();

				fields.push(titleField);
				fields.push(iconField);
				fields.push(textField);
				fields.push(allowedTemplatesField);
				fields.push(textRecoveredField);

				fields.push(formApi.buildFieldInput({ type: 'header', key: '_h_timing', label: 'Timing' }));
				const fTimeBudget = formApi.buildFieldInput({
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

				const fDueIn = formApi.buildFieldInput({
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

				const fExpiresIn = formApi.buildFieldInput({
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

				const fCooldown = formApi.buildFieldInput({
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

				const fRemindEvery = formApi.buildFieldInput({
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

				fields.push(formApi.buildFieldInput({ type: 'header', key: '_h_details', label: 'Details' }));
				const fDetailsTask = formApi.buildFieldInput({
					type: 'string',
					key: 'details_task',
					label: 'Task',
					value: draft?.message?.details?.task ?? '',
				});
				if (fDetailsTask?.input) {
					fDetailsTask.input.disabled = disabled;
				}
				fields.push(fDetailsTask);

				const fDetailsReason = formApi.buildFieldInput({
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

				fields.push(formApi.buildFieldInput({ type: 'header', key: '_h_audience', label: 'Audience' }));
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

				fields.push(formApi.buildFieldInput({ type: 'header', key: '_h_actions', label: 'Actions (JSON)' }));
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

				fields.push(formApi.buildFieldInput({ type: 'header', key: '_h_policy', label: 'Policy' }));
				const fResetOnNormal = formApi.buildFieldInput({
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
					class: 'msghub-uibutton-text',
					disabled: disabled ? true : undefined,
					onclick: () => saveDraft(),
					text: 'Save',
				});
				const btnAbort = h('button', {
					type: 'button',
					class: 'msghub-uibutton-text',
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
						source === 'builtin'
							? h('div', {
									class: 'msghub-muted',
									text: `This is a built-in preset${ownedBy ? ` for '${ownedBy}'` : ''} (view-only in this editor).`,
								})
							: null,
						elError,
						...fields.map(f => f.wrapper),
						h('div', { class: 'msghub-toolbar__group' }, [btnSave, btnAbort]),
					]),
				]);

				// Wire field changes into draft
				const apply = () => {
					const nextOwnedBy = normalizeBindingValue(fOwnedBy?.getValue ? fOwnedBy.getValue() : '');
					let nextSubset = normalizeBindingValue(fSubset?.getValue ? fSubset.getValue() : '');
					const allowedSubsetOptions = getSubsetOptions(nextOwnedBy);
					const allowedSubsetValues = new Set(
						allowedSubsetOptions.map(option => String(option?.value ?? '')),
					);
					const nextSubsetSelectValue = nextSubset || BINDING_NONE_VALUE;
					if (!allowedSubsetValues.has(nextSubsetSelectValue)) {
						nextSubset = '';
					}
					syncSelectOptions(fSubset?.input, allowedSubsetOptions, nextSubset || BINDING_NONE_VALUE, {
						disabled: disabled,
					});

					updateDraft({
						presetId: String(fPresetId?.getValue ? fPresetId.getValue() : '').trim(),
						description: String(fDescription?.getValue ? fDescription.getValue() : ''),
						schema: String(fSchema?.getValue ? fSchema.getValue() : ''),
						source: source,
						ownedBy: nextOwnedBy || null,
						subset: nextSubset || null,
					});
					updateMessage({
						kind: fKind?.getValue ? fKind.getValue() : undefined,
						level: fLevel?.getValue ? fLevel.getValue() : undefined,
					});
					updateMessageNested('title', titleField.getValue());
					updateMessageNested('icon', iconField.getValue());
					updateMessageNested('text', textField.getValue());
					updateMessageNested('textRecovered', textRecoveredField.getValue());
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
					allowedTemplatesField.update(nextOwnedBy, nextSubset);

					const kind = String(draft?.message?.kind || '');
					const isTask = kind === 'task';
					fTimeBudget.wrapper.classList.toggle('is-hidden', !isTask);
					fDueIn.wrapper.classList.toggle('is-hidden', !isTask);
					fDetailsTask.wrapper.classList.toggle('is-hidden', !isTask);
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
				watch(fOwnedBy.input);
				watch(fSubset.input);
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

			el.appendChild(h('div', { class: 'msghub-tools-presets-grid' }, [elList, elEditor]));
			render();
			const initialReady = loadList();
			el.__msghubReady = initialReady;
			void initialReady.catch(e => {
				const msg = String(e?.message || e);
				setError(msg);
				toast(msg, 'danger');
			});
			return el;
		}

		return Object.freeze({ renderIngestStatesMessagePresetsTool });
	}

	win.MsghubAdminTabPluginsPresets = Object.freeze({ createPluginsPresetsApi });
})();
