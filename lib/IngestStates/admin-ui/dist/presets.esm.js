/**
 * presets.esm.js
 * ==============
 *
 * Light-DOM plugin panel bundle for the IngestStates preset editor.
 */

/**
 * Mount the preset panel into the provided Light-DOM root.
 *
 * Initialises the runtime, bootstrap model, list pane, editor pane, field factory,
 * and action factory, then performs the initial preset list load.
 *
 * @param {object} ctx Host-provided bundle context.
 * @returns {Promise<void>}
 */
export async function mount(ctx) {
	/**
	 * Build the host-bound runtime used by later factories.
	 *
	 * @returns {{
	 *   root: any,
	 *   h: Function,
	 *   t: Function,
	 *   api: object,
	 *   dataApi: object,
	 *   tField: Function,
	 *   tSection: Function
	 * }} Host-bound runtime primitives for later factories.
	 */
	function createPanelRuntime() {
		const root = ctx?.root;
		if (!root || typeof root.appendChild !== 'function') {
			// Intentionally hard-coded: host integration guard, not a user-facing plugin i18n string.
			throw new Error('Invalid plugin panel root');
		}

		const h = typeof ctx?.dom?.h === 'function' ? ctx.dom.h : null;
		if (!h) {
			// Intentionally hard-coded: host integration guard, not a user-facing plugin i18n string.
			throw new Error('Invalid plugin panel DOM helper');
		}

		const api = ctx?.api && typeof ctx.api === 'object' ? ctx.api : {};
		const t = typeof api?.i18n?.t === 'function' ? api.i18n.t : key => key;

		/**
		 * Execute one preset RPC command through the host-bound plugin request path.
		 *
		 * @param {string} command RPC command name.
		 * @param {any} payload RPC payload.
		 * @returns {Promise<any>} Successful RPC payload.
		 */
		async function call(command, payload) {
			const res = await api.request(command, payload);
			if (!res?.ok) {
				// Intentionally hard-coded: internal admin fallback when the RPC error shape is incomplete.
				throw new Error(String(res?.error?.message || 'Unknown RPC error'));
			}
			return res.data;
		}

		const dataApi = Object.freeze({
			/**
			 * Load the static preset bootstrap payload.
			 *
			 * @returns {Promise<any>} Bootstrap RPC payload.
			 */
			bootstrap() {
				return call('presets.bootstrap', null);
			},
			/**
			 * Load the preset summary rows for the list pane.
			 *
			 * @param {any} payload List query payload.
			 * @returns {Promise<any>} Preset list RPC payload.
			 */
			listPresets(payload) {
				return call('presets.list', payload);
			},
			/**
			 * Load one complete preset by identifier.
			 *
			 * @param {any} payload Preset lookup payload.
			 * @returns {Promise<any>} Single preset RPC payload.
			 */
			getPreset(payload) {
				return call('presets.get', payload);
			},
			/**
			 * Create one new preset.
			 *
			 * @param {any} payload Create payload.
			 * @returns {Promise<any>} Created preset RPC payload.
			 */
			createPreset(payload) {
				return call('presets.create', payload);
			},
			/**
			 * Update one existing preset.
			 *
			 * @param {any} payload Update payload.
			 * @returns {Promise<any>} Updated preset RPC payload.
			 */
			updatePreset(payload) {
				return call('presets.update', payload);
			},
			/**
			 * Delete one preset.
			 *
			 * @param {any} payload Delete payload.
			 * @returns {Promise<any>} Delete RPC payload.
			 */
			deletePreset(payload) {
				return call('presets.delete', payload);
			},
		});

		return {
			root,
			h,
			t,
			api,
			dataApi,
			/**
			 * Resolve one preset field label key.
			 *
			 * @param {string} path Preset field path suffix.
			 * @returns {string} Resolved translated field label.
			 */
			tField(path) {
				return t(`msghub.i18n.IngestStates.ui.presets.field.${path}.label`);
			},
			/**
			 * Resolve one preset section label key.
			 *
			 * @param {string} key Preset section key.
			 * @returns {string} Resolved translated section label.
			 */
			tSection(key) {
				return t(`msghub.i18n.IngestStates.ui.presets.section.${key}.label`);
			},
		};
	}

	/**
	 * Load and validate the static bootstrap payload for the preset editor.
	 *
	 * @param {{
	 *   root: any,
	 *   h: Function,
	 *   t: Function,
	 *   dataApi: object
	 * }} runtime Host-bound runtime.
	 * @returns {Promise<object|null>} Valid bootstrap model or null on visible bootstrap failure.
	 */
	async function loadBootstrapModel(runtime) {
		const bootstrap = await runtime.dataApi.bootstrap();
		const ingestConstants =
			bootstrap && bootstrap.ingestConstants && typeof bootstrap.ingestConstants === 'object'
				? bootstrap.ingestConstants
				: null;
		const msgConstants =
			bootstrap && bootstrap.msgConstants && typeof bootstrap.msgConstants === 'object'
				? bootstrap.msgConstants
				: null;
		const presetSchema =
			ingestConstants && typeof ingestConstants.presetSchema === 'string' ? ingestConstants.presetSchema : '';
		const presetTemplate =
			ingestConstants && typeof ingestConstants.presetTemplate === 'object'
				? ingestConstants.presetTemplate
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
			runtime.root.replaceChildren(
				runtime.h('div', {
					class: 'msghub-error',
					text: runtime.t('msghub.i18n.IngestStates.ui.presets.bootstrap.missingConstants.text'),
				}),
			);
			return null;
		}

		return {
			bootstrap,
			ingestConstants,
			msgConstants,
			presetSchema,
			presetTemplate,
			presetBindingCatalog,
			ruleTemplateCatalog,
		};
	}

	const runtime = createPanelRuntime();
	runtime.root.replaceChildren();

	const bootstrapModel = await loadBootstrapModel(runtime);
	if (!bootstrapModel) {
		return;
	}

	/**
	 * Create the editor state factory used by later editor/action blocks.
	 *
	 * @param {object} bootstrapModel Valid bootstrap model.
	 * @returns {object} State accessors and mutation helpers.
	 */
	function createPresetsState(bootstrapModel) {
		let selectedId = '';
		let original = null;
		let draft = null;
		let isNew = false;
		let presetLoading = false;
		let saving = false;
		let lastError = '';

		/**
		 * Deep-clone JSON-compatible editor payloads.
		 *
		 * @param {any} value Source value.
		 * @returns {any} Deep-cloned value.
		 */
		function cloneJson(value) {
			return JSON.parse(JSON.stringify(value ?? null));
		}

		/**
		 * Check whether a value is a non-array object.
		 *
		 * @param {any} value Candidate value.
		 * @returns {boolean} True when the value is a plain object.
		 */
		function isPlainObject(value) {
			return value !== null && typeof value === 'object' && !Array.isArray(value);
		}

		/**
		 * Build a fresh preset base from the bootstrap template.
		 *
		 * @returns {object} Fresh preset object.
		 */
		function buildPresetBase() {
			return cloneJson(bootstrapModel.presetTemplate);
		}

		/**
		 * Create a normalized editable preset draft.
		 *
		 * @param {any} patch Optional patch to merge into the base preset.
		 * @returns {object} Editable preset draft.
		 */
		function createDraftPreset(patch) {
			const preset = buildPresetBase();
			preset.schema = bootstrapModel.presetSchema;
			preset.presetId = '';
			preset.source = 'user';
			preset.ownedBy = null;
			preset.subset = null;
			if (Object.prototype.hasOwnProperty.call(preset, 'ui')) {
				delete preset.ui;
			}
			if (!isPlainObject(patch)) {
				return preset;
			}
			const next = { ...preset, ...cloneJson(patch) };
			if (isPlainObject(preset.message) || isPlainObject(patch.message)) {
				next.message = {
					...(isPlainObject(preset.message) ? preset.message : {}),
					...(isPlainObject(patch.message) ? patch.message : {}),
				};
			}
			if (isPlainObject(preset.policy) || isPlainObject(patch.policy)) {
				next.policy = {
					...(isPlainObject(preset.policy) ? preset.policy : {}),
					...(isPlainObject(patch.policy) ? patch.policy : {}),
				};
			}
			return next;
		}

		/**
		 * Normalize a preset for coarse dirty-check comparisons.
		 *
		 * @param {any} preset Candidate preset.
		 * @returns {any} Comparable normalized value.
		 */
		function normalizePresetForDirtyCheck(preset) {
			if (!preset || typeof preset !== 'object') {
				return preset ?? null;
			}
			const next = cloneJson(preset);
			next.presetId = typeof next.presetId === 'string' ? next.presetId.trim() : '';
			next.description = typeof next.description === 'string' ? next.description : '';
			next.source = next.source === 'builtin' ? 'builtin' : 'user';
			next.ownedBy = typeof next.ownedBy === 'string' && next.ownedBy.trim() ? next.ownedBy.trim() : null;
			next.subset = typeof next.subset === 'string' && next.subset.trim() ? next.subset.trim() : null;
			return next;
		}

		/**
		 * Compare the persisted snapshot and current draft.
		 *
		 * @returns {boolean} True when the current draft differs from the loaded preset.
		 */
		function isDirty() {
			return (
				JSON.stringify(normalizePresetForDirtyCheck(original)) !==
				JSON.stringify(normalizePresetForDirtyCheck(draft))
			);
		}

		/**
		 * Return the current state snapshot.
		 *
		 * @returns {object} Current editor state snapshot.
		 */
		function getSnapshot() {
			return { selectedId, original, draft, isNew, presetLoading, saving, lastError };
		}

		/**
		 * Store the selected preset identifier.
		 *
		 * @param {any} presetId Selected preset identifier.
		 * @returns {void}
		 */
		function setSelectedId(presetId) {
			selectedId = typeof presetId === 'string' ? presetId.trim() : '';
		}

		/**
		 * Store the current loaded preset and its editable draft.
		 *
		 * @param {any} preset Candidate preset.
		 * @returns {void}
		 */
		function setLoadedPreset(preset) {
			original = cloneJson(preset);
			draft = cloneJson(preset);
			isNew = false;
		}

		/**
		 * Start a fresh user-owned draft.
		 *
		 * @param {any} patch Optional draft patch.
		 * @returns {void}
		 */
		function startNewDraft(patch) {
			original = null;
			draft = createDraftPreset(patch);
			isNew = true;
		}

		/**
		 * Reset the editor payload state.
		 *
		 * @returns {void}
		 */
		function resetEditorState() {
			original = null;
			draft = null;
			isNew = false;
		}

		/**
		 * Restore the draft from the last loaded original snapshot.
		 *
		 * @returns {void}
		 */
		function discardChanges() {
			draft = cloneJson(original);
			isNew = false;
		}

		/**
		 * Update the preset-loading flag.
		 *
		 * @param {boolean} value Next flag value.
		 * @returns {void}
		 */
		function setPresetLoading(value) {
			presetLoading = value === true;
		}

		/**
		 * Update the save-in-progress flag.
		 *
		 * @param {boolean} value Next flag value.
		 * @returns {void}
		 */
		function setSaving(value) {
			saving = value === true;
		}

		/**
		 * Store the latest visible error text.
		 *
		 * @param {any} value Next error text.
		 * @returns {void}
		 */
		function setError(value) {
			lastError = typeof value === 'string' ? value : value == null ? '' : String(value);
		}

		/**
		 * Merge a patch into the draft root object.
		 *
		 * @param {object} patch Draft patch.
		 * @returns {void}
		 */
		function updateDraft(patch) {
			draft = { ...(draft || {}), ...(patch || {}) };
		}

		/**
		 * Merge a patch into the draft message object.
		 *
		 * @param {object} patch Message patch.
		 * @returns {void}
		 */
		function updateMessage(patch) {
			const cur = draft?.message && typeof draft.message === 'object' ? draft.message : {};
			updateDraft({ message: { ...cur, ...(patch || {}) } });
		}

		/**
		 * Write a nested value into the draft message object.
		 *
		 * @param {string} path Dotted message path.
		 * @param {any} value Value to store.
		 * @returns {void}
		 */
		function updateMessageNested(path, value) {
			const parts = String(path || '')
				.split('.')
				.filter(Boolean);
			if (parts.length === 0) {
				return;
			}
			const next = cloneJson(draft?.message || {});
			let cur = next;
			for (let i = 0; i < parts.length - 1; i++) {
				const key = parts[i];
				if (!cur[key] || typeof cur[key] !== 'object') {
					cur[key] = {};
				}
				cur = cur[key];
			}
			cur[parts[parts.length - 1]] = value;
			updateMessage(next);
		}

		/**
		 * Merge a patch into the draft policy object.
		 *
		 * @param {object} patch Policy patch.
		 * @returns {void}
		 */
		function updatePolicy(patch) {
			const cur = draft?.policy && typeof draft.policy === 'object' ? draft.policy : {};
			updateDraft({ policy: { ...cur, ...(patch || {}) } });
		}

		return {
			buildPresetBase,
			createDraftPreset,
			isDirty,
			getSnapshot,
			setSelectedId,
			setLoadedPreset,
			startNewDraft,
			resetEditorState,
			discardChanges,
			setPresetLoading,
			setSaving,
			setError,
			updateDraft,
			updateMessage,
			updateMessageNested,
			updatePolicy,
		};
	}

	/**
	 * Create the isolated list pane for the preset editor.
	 *
	 * @param {object} runtime Host-bound runtime primitives.
	 * @param {object} bootstrapModel Valid bootstrap model.
	 * @param {{
	 *   onSelect?: Function,
	 *   onCreate?: Function,
	 *   onReload?: Function,
	 *   onDuplicate?: Function,
	 *   onDelete?: Function
	 * }} [cfg] List pane callbacks.
	 * @returns {{ node: any, loadList: Function, setSelectedId: Function, getRowById: Function }} List pane API.
	 */
	function createListPane(runtime, bootstrapModel, cfg = {}) {
		let presetRows = [];
		let listLoading = false;
		let selectedId = '';

		const node = runtime.h('div', { class: 'msghub-tools-presets-list' });
		const levelMap =
			bootstrapModel.msgConstants?.level && typeof bootstrapModel.msgConstants.level === 'object'
				? bootstrapModel.msgConstants.level
				: null;
		const levelKeyMap = levelMap
			? Object.keys(levelMap).reduce((acc, key) => {
					const value = levelMap[key];
					if (typeof value === 'number') {
						acc[value] = key;
					}
					return acc;
				}, {})
			: {};

		/**
		 * Resolve one binding catalog entry by ownedBy key.
		 *
		 * @param {any} ownedBy Binding ownedBy value.
		 * @returns {object|null} Matching binding entry or null.
		 */
		function getBindingEntryByOwnedBy(ownedBy) {
			const ownedByText =
				typeof ownedBy === 'string'
					? ownedBy.trim().toLowerCase()
					: String(ownedBy ?? '')
							.trim()
							.toLowerCase();
			if (!ownedByText) {
				return null;
			}
			return (
				Object.values(bootstrapModel.presetBindingCatalog || {}).find(entry => {
					const candidate = typeof entry?.ownedBy === 'string' ? entry.ownedBy.trim().toLowerCase() : '';
					return candidate === ownedByText;
				}) || null
			);
		}

		/**
		 * Resolve the translated subset label for one ownedBy/subset pair.
		 *
		 * @param {any} ownedBy Binding ownedBy value.
		 * @param {any} subsetRaw Raw subset value.
		 * @returns {string} Visible subset text.
		 */
		function getSubsetText(ownedBy, subsetRaw) {
			const subset = typeof subsetRaw === 'string' ? subsetRaw.trim() : '';
			if (!subset) {
				return runtime.t('msghub.i18n.IngestStates.ui.presets.subset.none.label');
			}
			const entry = getBindingEntryByOwnedBy(ownedBy);
			const subsets = Array.isArray(entry?.subsets) ? entry.subsets : [];
			const match = subsets.find(option => String(option?.value ?? '').trim() === subset) || null;
			return typeof match?.labelKey === 'string' && match.labelKey ? runtime.t(match.labelKey) : subset;
		}

		/**
		 * Validate the supported preset identifier format.
		 *
		 * @param {any} value Candidate preset identifier.
		 * @returns {boolean} True when the identifier is valid.
		 */
		function isPresetId(value) {
			const s = typeof value === 'string' ? value.trim() : '';
			return /^[A-Za-z0-9_-]+$/.test(s);
		}

		/**
		 * Normalize one preset summary row from the list RPC.
		 *
		 * @param {any} value Raw list row.
		 * @returns {object|null} Normalized row or null.
		 */
		function toPresetRow(value) {
			const row = value && typeof value === 'object' ? value : {};
			const presetId = typeof row.value === 'string' ? row.value.trim() : '';
			if (!isPresetId(presetId)) {
				return null;
			}
			return {
				presetId,
				source: row.source === 'builtin' ? 'builtin' : 'user',
				ownedBy: typeof row.ownedBy === 'string' && row.ownedBy.trim() ? row.ownedBy.trim() : null,
				subset: typeof row.subset === 'string' && row.subset.trim() ? row.subset.trim() : null,
				kind: typeof row.kind === 'string' ? row.kind.trim() : '',
				level: typeof row.level === 'number' && Number.isFinite(row.level) ? row.level : null,
				name: typeof row.name === 'string' ? row.name.trim() : '',
				usageCount:
					typeof row.usageCount === 'number' && Number.isFinite(row.usageCount)
						? Math.max(0, Math.trunc(row.usageCount))
						: 0,
			};
		}

		/**
		 * Sort preset rows in-place by source, ownedBy, subset and display name.
		 *
		 * @returns {void}
		 */
		function sortPresetRows() {
			presetRows.sort((a, b) => {
				const bySource = String(a?.source || '').localeCompare(String(b?.source || ''));
				if (bySource !== 0) {
					return bySource;
				}
				const byOwnedBy = String(a?.ownedBy || '').localeCompare(String(b?.ownedBy || ''));
				if (byOwnedBy !== 0) {
					return byOwnedBy;
				}
				const bySubset = String(a?.subset || '').localeCompare(String(b?.subset || ''));
				if (bySubset !== 0) {
					return bySubset;
				}
				return String(a?.name || a?.presetId || '').localeCompare(String(b?.name || b?.presetId || ''));
			});
		}

		/**
		 * Split preset rows into user and builtin groups.
		 *
		 * @returns {{ userRows: object[], builtinRows: object[] }} Grouped rows.
		 */
		function splitPresetRowsBySource() {
			return {
				userRows: presetRows.filter(row => row?.source !== 'builtin'),
				builtinRows: presetRows.filter(row => row?.source === 'builtin'),
			};
		}

		/**
		 * Render one normalized preset row.
		 *
		 * @param {object} row Normalized preset row.
		 * @returns {any} Table row DOM node.
		 */
		function renderPresetRow(row) {
			const ownedBy = row?.ownedBy;
			const entry = getBindingEntryByOwnedBy(ownedBy);
			const ownedByText = ownedBy
				? typeof entry?.headerKey === 'string' && entry.headerKey
					? runtime.t(entry.headerKey)
					: ownedBy
				: runtime.t('msghub.i18n.IngestStates.ui.presets.ownedBy.none.label');
			const subsetText = getSubsetText(ownedBy, row?.subset);
			const kindKey = String(row?.kind || '').trim();
			const kindText = kindKey
				? runtime.t(`msghub.i18n.core.admin.common.MsgConstants.kind.${kindKey}.label`)
				: kindKey;
			const level = row?.level;
			const levelKey = typeof level === 'number' ? levelKeyMap[level] : undefined;
			const levelText = levelKey
				? runtime.t(`msghub.i18n.core.admin.common.MsgConstants.level.${levelKey}.label`)
				: String(level ?? '');
			const usageCount = typeof row?.usageCount === 'number' ? row.usageCount : 0;
			const usageText = usageCount > 0 ? String(usageCount) : '';
			const isSelected = row?.presetId === selectedId;

			return runtime.h(
				'tr',
				{
					class: `msghub-table-data-row${isSelected ? ' is-selected' : ''}`.trim(),
					onclick: () => cfg.onSelect?.(row.presetId),
				},
				[
					runtime.h('td', {
						class: 'msghub-colCell msghub-col--preset-usage',
						text: usageText,
						title: usageText,
					}),
					runtime.h('td', {
						class: 'msghub-colCell msghub-col--preset-ownedBy',
						text: ownedByText,
						title: ownedByText,
					}),
					runtime.h('td', {
						class: 'msghub-colCell msghub-col--preset-subset',
						text: subsetText,
						title: subsetText,
					}),
					runtime.h('td', {
						class: 'msghub-colCell msghub-col--preset-kind',
						text: kindText,
						title: kindText,
					}),
					runtime.h('td', {
						class: 'msghub-colCell msghub-col--preset-level',
						text: levelText,
						title: levelText,
					}),
					runtime.h('td', {
						class: 'msghub-colCell msghub-col--preset-name',
						text: row?.name || row?.presetId || '',
						title: row?.name || row?.presetId || '',
					}),
				],
			);
		}

		/**
		 * Render one grouped table section.
		 *
		 * @param {string} label Group label.
		 * @param {object[]} rows Group rows.
		 * @returns {any} Table body DOM node.
		 */
		function renderPresetGroup(label, rows) {
			const groupRows = Array.isArray(rows) ? rows : [];
			return runtime.h('tbody', { class: 'msghub-table-group' }, [
				runtime.h('tr', { class: 'msghub-table-group-row' }, [
					runtime.h('th', {
						class: 'msghub-colCell msghub-table-group-title',
						colspan: 6,
						text: label,
					}),
				]),
				...(groupRows.length
					? groupRows.map(renderPresetRow)
					: [
							runtime.h('tr', { class: 'msghub-table-empty-row' }, [
								runtime.h('td', {
									class: 'msghub-colCell msghub-muted',
									colspan: 6,
									text: runtime.t('msghub.i18n.IngestStates.ui.presets.group.empty.text'),
								}),
							]),
						]),
			]);
		}

		/**
		 * Render the current list pane contents into the pane root.
		 *
		 * @returns {void}
		 */
		function renderListPane() {
			const btnNew = runtime.h('button', {
				type: 'button',
				class: 'msghub-uibutton-text',
				onclick: () => cfg.onCreate?.(),
				text: '+',
			});
			const btnReload = runtime.h('button', {
				type: 'button',
				class: 'msghub-uibutton-text',
				onclick: () => {
					const task = cfg.onReload
						? cfg.onReload()
						: loadList({ renderLoading: false, showLoadingToast: true });
					void Promise.resolve(task).catch(err => {
						const msg = String(err?.message || err);
						try {
							runtime.api?.ui?.toast?.({ text: msg, variant: 'danger' });
						} catch {
							// ignore
						}
					});
				},
				text: '⟳',
			});
			const btnDup = runtime.h('button', {
				type: 'button',
				class: 'msghub-uibutton-text',
				onclick: () => cfg.onDuplicate?.(),
				text: '⧉',
			});
			const btnDel = runtime.h('button', {
				type: 'button',
				class: 'msghub-uibutton-text',
				onclick: () => cfg.onDelete?.(),
				text: '×',
			});

			const head = runtime.h('div', { class: 'msghub-tools-presets-list-head' }, [
				runtime.h('div', { class: 'msghub-toolbar__group' }, [btnNew, btnReload, btnDup, btnDel]),
			]);

			let items = null;
			if (listLoading) {
				items = runtime.h('div', {
					class: 'msghub-muted',
					text: runtime.t('msghub.i18n.core.admin.ui.loading.text'),
				});
			} else if (presetRows.length === 0) {
				items = runtime.h('div', {
					class: 'msghub-muted',
					text: runtime.t('msghub.i18n.IngestStates.ui.presets.emptyList.text'),
				});
			} else {
				const { userRows, builtinRows } = splitPresetRowsBySource();
				items = runtime.h('div', { class: 'msghub-tools-presets-list-items' }, [
					runtime.h('table', { class: 'msghub-table msghub-presets-table' }, [
						runtime.h('colgroup', null, [
							runtime.h('col', { class: 'msghub-col--preset-usage' }),
							runtime.h('col', { class: 'msghub-col--preset-ownedBy' }),
							runtime.h('col', { class: 'msghub-col--preset-subset' }),
							runtime.h('col', { class: 'msghub-col--preset-kind' }),
							runtime.h('col', { class: 'msghub-col--preset-level' }),
							runtime.h('col', { class: 'msghub-col--preset-name' }),
						]),
						runtime.h('thead', null, [
							runtime.h('tr', null, [
								runtime.h('th', {
									class: 'msghub-th msghub-colCell msghub-col--preset-usage',
									text: runtime.t('msghub.i18n.IngestStates.ui.presets.usageCount.label'),
									title: runtime.t('msghub.i18n.IngestStates.ui.presets.usageCount.label'),
								}),
								runtime.h('th', {
									class: 'msghub-th msghub-colCell msghub-col--preset-ownedBy',
									text: runtime.t('msghub.i18n.IngestStates.ui.presets.ownedBy.label'),
									title: runtime.t('msghub.i18n.IngestStates.ui.presets.ownedBy.label'),
								}),
								runtime.h('th', {
									class: 'msghub-th msghub-colCell msghub-col--preset-subset',
									text: runtime.t('msghub.i18n.IngestStates.ui.presets.subset.label'),
									title: runtime.t('msghub.i18n.IngestStates.ui.presets.subset.label'),
								}),
								runtime.h('th', {
									class: 'msghub-th msghub-colCell msghub-col--preset-kind',
									text: runtime.tField('message.kind'),
									title: runtime.tField('message.kind'),
								}),
								runtime.h('th', {
									class: 'msghub-th msghub-colCell msghub-col--preset-level',
									text: runtime.tField('message.level'),
									title: runtime.tField('message.level'),
								}),
								runtime.h('th', {
									class: 'msghub-th msghub-colCell msghub-col--preset-name',
									text: runtime.t('msghub.i18n.IngestStates.ui.presets.name.label'),
									title: runtime.t('msghub.i18n.IngestStates.ui.presets.name.label'),
								}),
							]),
						]),
						renderPresetGroup(runtime.t('msghub.i18n.IngestStates.ui.presets.group.user.label'), userRows),
						renderPresetGroup(
							runtime.t('msghub.i18n.IngestStates.ui.presets.group.builtin.label'),
							builtinRows,
						),
					]),
				]);
			}

			node.replaceChildren(head, items);
		}

		/**
		 * Load the preset list and refresh the pane.
		 *
		 * @param {{ renderLoading?: boolean, showLoadingToast?: boolean }} [cfg] List loading options.
		 * @returns {Promise<void>}
		 */
		async function loadList({ renderLoading = true, showLoadingToast = false } = {}) {
			let spinnerId = null;
			if (showLoadingToast) {
				try {
					spinnerId =
						runtime.api?.ui?.spinner?.show?.({
							id: 'msghub-presets-list-load',
							message: runtime.t(
								'msghub.i18n.core.admin.ui.loadingWithSubject.text',
								runtime.t('msghub.i18n.IngestStates.ui.presets.list.subject'),
							),
						}) ?? null;
				} catch {
					spinnerId = null;
				}
			}

			listLoading = true;
			if (renderLoading) {
				renderListPane();
			}

			try {
				const items = await runtime.dataApi.listPresets({ includeUsage: true });
				presetRows = (Array.isArray(items) ? items : []).map(toPresetRow).filter(Boolean);
				sortPresetRows();
			} finally {
				listLoading = false;
				renderListPane();
				if (spinnerId) {
					try {
						runtime.api?.ui?.spinner?.hide?.(spinnerId);
					} catch {
						// ignore
					}
				}
			}
		}

		renderListPane();

		/**
		 * Update the selected row marker and re-render the list pane.
		 *
		 * @param {any} presetId Selected preset identifier.
		 * @returns {void}
		 */
		function setSelectedId(presetId) {
			selectedId = typeof presetId === 'string' ? presetId.trim() : '';
			renderListPane();
		}

		/**
		 * Resolve one normalized row by preset identifier.
		 *
		 * @param {any} presetId Candidate preset identifier.
		 * @returns {object|null} Matching normalized row or null.
		 */
		function getRowById(presetId) {
			const id = typeof presetId === 'string' ? presetId.trim() : '';
			return presetRows.find(row => row?.presetId === id) || null;
		}

		return { node, loadList, setSelectedId, getRowById };
	}

	/**
	 * Create the isolated editor pane for the preset editor.
	 *
	 * @param {object} runtime Host-bound runtime primitives.
	 * @param {object} bootstrapModel Valid bootstrap model.
	 * @param {object} presetsState Editor state factory.
	 * @param {object} fieldFactory Field builder factory.
	 * @param {{ onSave?: Function, onAbort?: Function }} [cfg] Editor action callbacks.
	 * @returns {{ node: any, render: Function }} Editor pane node plus renderer.
	 */
	function createEditorPane(runtime, bootstrapModel, presetsState, fieldFactory, cfg = {}) {
		const node = runtime.h('div', { class: 'msghub-tools-presets-editor' });
		const BINDING_NONE_VALUE = '__msghub_none__';

		/**
		 * Build the passive help-slot cell used by each editor row.
		 *
		 * @param {any} helpText Help text.
		 * @returns {any} Help-slot node.
		 */
		function buildHelpSlot(helpText) {
			const text = typeof helpText === 'string' ? helpText.trim() : '';
			const attrs = { class: 'msghub-preset-editor-helpSlot' };
			if (text) {
				attrs['data-help-text'] = text;
			}
			return runtime.h('div', attrs);
		}

		/**
		 * Build a labeled editor row.
		 *
		 * @param {{ key: string, label: string, labelFor?: string, required?: boolean, help?: string, control: any }} cfg
		 *   Row configuration.
		 * @returns {any} Editor row node.
		 */
		function buildEditorRow({ key, label, labelFor = '', required = false, help = '', control }) {
			const labelAttrs = { class: 'msghub-preset-editor-rowLabelText', text: String(label || '') };
			if (labelFor) {
				labelAttrs.for = labelFor;
			}
			const labelNode = runtime.h(labelFor ? 'label' : 'div', labelAttrs);
			return runtime.h('div', { class: 'msghub-preset-editor-row', 'data-row-key': String(key || '') }, [
				runtime.h('div', { class: 'msghub-preset-editor-rowLabel' }, [
					labelNode,
					required ? runtime.h('span', { class: 'msghub-preset-editor-rowRequired', text: ' *' }) : null,
				]),
				runtime.h(
					'div',
					{ class: 'msghub-preset-editor-rowField' },
					Array.isArray(control) ? control.filter(Boolean) : [control].filter(Boolean),
				),
				buildHelpSlot(help),
			]);
		}

		/**
		 * Rewrap a primitive field builder result into the editor row layout.
		 *
		 * @param {object} field Built field descriptor.
		 * @param {{ key: string, label: string, help?: string, required?: boolean, control?: any }} cfg Row metadata.
		 * @returns {object} Updated field descriptor.
		 */
		function adoptBuiltField(field, { key, label, help = '', required = false, control = null }) {
			const controlNodes = Array.isArray(control)
				? control
				: control
					? [control]
					: field?.select
						? [
								runtime.h('div', { class: 'msghub-preset-editor-controlGroup' }, [
									field.input,
									field.select,
								]),
							]
						: field?.input
							? [field.input]
							: field?.textarea
								? [field.textarea]
								: [];
			const labelFor = field?.input?.id || field?.textarea?.id || field?.select?.id || '';
			field.wrapper = buildEditorRow({ key, label, labelFor, required, help, control: controlNodes });
			return field;
		}

		/**
		 * Build a read-only display row.
		 *
		 * @param {{ key: string, label: string, value: any, muted?: boolean, help?: string }} cfg Row configuration.
		 * @returns {{ wrapper: any }} Static row descriptor.
		 */
		function createStaticValueRow({ key, label, value, muted = false, help = '' }) {
			return {
				wrapper: buildEditorRow({
					key,
					label,
					help,
					control: runtime.h('div', {
						class: muted ? 'msghub-muted' : '',
						text: String(value || ''),
					}),
				}),
			};
		}

		/**
		 * Build a collapsible editor section.
		 *
		 * @param {{ key: string, label: string, rows: Array<any>, defaultOpen?: string }} cfg Section configuration.
		 * @returns {any} Section node.
		 */
		function buildSection({ key, label, rows, defaultOpen = 'auto' }) {
			const isInitiallyOpen = true;
			const body = runtime.h(
				'div',
				{ class: 'msghub-preset-editor-sectionBody', 'data-section-body': key },
				rows.map(row => row?.wrapper).filter(Boolean),
			);
			body.hidden = !isInitiallyOpen;
			body.classList?.toggle?.('is-hidden', !isInitiallyOpen);

			/**
			 * Toggle one editor section body in place.
			 *
			 * @param {any} event Click event from the section toggle button.
			 * @returns {void}
			 */
			function toggleSection(event) {
				const button = event?.currentTarget || event?.target || null;
				const currentExpanded = String(button?.getAttribute?.('aria-expanded') || 'true') === 'true';
				const nextExpanded = !currentExpanded;
				if (button?.setAttribute) {
					button.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');
				}
				body.hidden = !nextExpanded;
				body.classList?.toggle?.('is-hidden', !nextExpanded);
			}

			return runtime.h(
				'section',
				{
					class: 'msghub-preset-editor-section',
					'data-section-key': key,
					'data-default-open': defaultOpen,
				},
				[
					runtime.h('div', { class: 'msghub-preset-editor-sectionHeader' }, [
						runtime.h('button', {
							type: 'button',
							class: 'msghub-preset-editor-sectionToggle',
							'data-section-toggle': key,
							'aria-expanded': isInitiallyOpen ? 'true' : 'false',
							onclick: toggleSection,
							text: label,
						}),
					]),
					body,
				],
			);
		}

		/**
		 * Apply the disabled flag to the known field controls.
		 *
		 * @param {object} field Field descriptor.
		 * @param {boolean} disabled Disabled flag.
		 * @returns {void}
		 */
		function setFieldDisabled(field, disabled) {
			if (field?.input) {
				field.input.disabled = disabled;
			}
			if (field?.textarea) {
				field.textarea.disabled = disabled;
			}
			if (field?.select) {
				field.select.disabled = disabled;
			}
		}

		/**
		 * Resolve one binding catalog entry by ownedBy key.
		 *
		 * @param {any} ownedByValue Binding ownedBy value.
		 * @returns {object|null} Matching binding entry.
		 */
		function getBindingEntryByOwnedBy(ownedByValue) {
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
				Object.values(bootstrapModel.presetBindingCatalog || {}).find(entry => {
					const candidate = typeof entry?.ownedBy === 'string' ? entry.ownedBy.trim().toLowerCase() : '';
					return candidate === ownedByText;
				}) || null
			);
		}

		/**
		 * Build ownedBy select options.
		 *
		 * @returns {Array<{ value: string, label: string }>} Select options.
		 */
		function getOwnedByOptions() {
			const options = [
				{
					value: '__msghub_none__',
					label: runtime.t('msghub.i18n.IngestStates.ui.presets.ownedBy.none.label'),
				},
			];
			for (const entry of Object.values(bootstrapModel.presetBindingCatalog || {}).filter(Boolean)) {
				const value = typeof entry?.ownedBy === 'string' ? entry.ownedBy.trim() : '';
				if (!value) {
					continue;
				}
				const labelKey = typeof entry?.headerKey === 'string' ? entry.headerKey : '';
				options.push({ value, label: labelKey ? runtime.t(labelKey) : value });
			}
			return options;
		}

		/**
		 * Build subset select options for the active binding.
		 *
		 * @param {any} ownedByValue Raw ownedBy value.
		 * @returns {Array<{ value: string, label: string }>} Select options.
		 */
		function getSubsetOptions(ownedByValue) {
			const entry = getBindingEntryByOwnedBy(ownedByValue);
			const options = [
				{
					value: '__msghub_none__',
					label: runtime.t('msghub.i18n.IngestStates.ui.presets.subset.none.label'),
				},
			];
			if (!entry || !Array.isArray(entry.subsets) || entry.subsets.length === 0) {
				return options;
			}
			for (const subset of entry.subsets) {
				const value = typeof subset?.value === 'string' ? subset.value : '';
				if (!value) {
					continue;
				}
				const labelKey = typeof subset?.labelKey === 'string' ? subset.labelKey : '';
				options.push({ value, label: labelKey ? runtime.t(labelKey) : value });
			}
			return options;
		}

		/**
		 * Build the derived-template help block for the active binding context.
		 *
		 * @param {any} ownedByValue Raw ownedBy value.
		 * @param {any} subsetValue Raw subset value.
		 * @returns {{ wrapper: any }} Static row descriptor.
		 */
		function createAllowedTemplatesRow(ownedByValue, subsetValue) {
			const bindingEntry = getBindingEntryByOwnedBy(ownedByValue);
			const subsetText = typeof subsetValue === 'string' ? subsetValue.trim() : '';
			const content = runtime.h('div', { class: 'msghub-muted' });
			if (
				!bindingEntry ||
				!bootstrapModel.ruleTemplateCatalog ||
				typeof bootstrapModel.ruleTemplateCatalog !== 'object'
			) {
				content.replaceChildren(
					runtime.h('div', {
						class: 'msghub-muted',
						text: runtime.t('msghub.i18n.IngestStates.ui.presets.allowedTemplates.empty.text'),
					}),
				);
			} else {
				const ruleEntry =
					bootstrapModel.ruleTemplateCatalog[
						Object.keys(bootstrapModel.presetBindingCatalog || {}).find(
							key => bootstrapModel.presetBindingCatalog[key] === bindingEntry,
						) || ''
					];
				const metrics = ruleEntry && typeof ruleEntry.metrics === 'object' ? ruleEntry.metrics : null;
				const entries = [];
				for (const [metricKey, metricEntry] of Object.entries(metrics || {})) {
					const metricSubsets = Array.isArray(metricEntry?.subset) ? metricEntry.subset : null;
					if (!subsetText && metricSubsets) {
						continue;
					}
					if (subsetText && metricSubsets && !metricSubsets.includes(subsetText)) {
						continue;
					}
					entries.push(
						runtime.h('div', {
							class: 'msghub-muted',
							text: `{{m.${metricKey}}} - ${runtime.t(metricEntry?.labelKey || metricKey)}`,
						}),
					);
				}
				content.replaceChildren(
					...(entries.length
						? entries
						: [
								runtime.h('div', {
									class: 'msghub-muted',
									text: runtime.t('msghub.i18n.IngestStates.ui.presets.allowedTemplates.empty.text'),
								}),
							]),
				);
			}
			return {
				content,
				/**
				 * Refresh the visible template entries for the current binding.
				 *
				 * @param {any} nextOwnedByValue Raw ownedBy value.
				 * @param {any} nextSubsetValue Raw subset value.
				 * @returns {void}
				 */
				update(nextOwnedByValue, nextSubsetValue) {
					const nextRow = createAllowedTemplatesRow(nextOwnedByValue, nextSubsetValue);
					content.replaceChildren(
						...(Array.isArray(nextRow.content?.children) ? nextRow.content.children : []),
					);
					content.textContent = nextRow.content?.textContent || '';
				},
				wrapper: buildEditorRow({
					key: 'message_allowedTemplates',
					label: runtime.t('msghub.i18n.IngestStates.ui.presets.allowedTemplates.label'),
					control: content,
				}),
			};
		}

		/**
		 * Normalize the select sentinel used for global bindings.
		 *
		 * @param {any} value Raw select value.
		 * @returns {string} Normalized binding value without the sentinel.
		 */
		function normalizeBindingValue(value) {
			const text = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
			return text === BINDING_NONE_VALUE ? '' : text;
		}

		/**
		 * Replace one select element's options with the provided visible choices.
		 *
		 * @param {any} select Select element.
		 * @param {Array<{ value: string, label: string }>} options Option descriptors.
		 * @param {string} selectedValue Selected option value.
		 * @param {{ disabled?: boolean }} [cfg] Select update flags.
		 * @returns {void}
		 */
		function syncSelectOptions(select, options, selectedValue, { disabled = false } = {}) {
			if (!select || typeof select.replaceChildren !== 'function') {
				return;
			}
			select.replaceChildren(
				...(Array.isArray(options) ? options : []).map(option =>
					runtime.h('option', {
						value: String(option?.value ?? ''),
						text: String(option?.label ?? ''),
					}),
				),
			);
			select.value = String(selectedValue || '');
			select.disabled = disabled === true;
		}

		/**
		 * Render the current editor snapshot into the pane root.
		 *
		 * @returns {void}
		 */
		function render() {
			const { draft, saving, lastError } = presetsState.getSnapshot();
			if (!draft) {
				node.replaceChildren(
					runtime.h('p', {
						class: 'msghub-muted',
						text: runtime.t('msghub.i18n.IngestStates.ui.presets.emptyEditor.text'),
					}),
				);
				return;
			}

			const ownedBy = typeof draft?.ownedBy === 'string' && draft.ownedBy.trim() ? draft.ownedBy.trim() : null;
			const source = draft?.source === 'builtin' ? 'builtin' : 'user';
			const disabled = source !== 'user' || saving === true;

			const generalRows = [];
			const messageRows = [];
			const timingRows = [];
			const detailsRows = [];
			const audienceRows = [];
			const actionsRows = [];
			const policyRows = [];

			const presetIdText = String(draft?.presetId || '').trim();
			generalRows.push(
				createStaticValueRow({
					key: 'presetId',
					label: runtime.t('msghub.i18n.IngestStates.ui.presets.presetId.label'),
					value: presetIdText || runtime.t('msghub.i18n.IngestStates.ui.presets.presetId.pending.text'),
					muted: !presetIdText,
				}),
			);

			const fDescription = adoptBuiltField(
				fieldFactory.createTextField({
					key: 'description',
					label: runtime.tField('description'),
					value: draft.description,
				}),
				{ key: 'description', label: runtime.tField('description'), required: true },
			);
			setFieldDisabled(fDescription, disabled);
			generalRows.push(fDescription);

			const fSchema = adoptBuiltField(
				fieldFactory.createTextField({
					key: 'schema',
					label: runtime.tField('schema'),
					value: draft.schema,
				}),
				{ key: 'schema', label: runtime.tField('schema') },
			);
			setFieldDisabled(fSchema, true);
			generalRows.push(fSchema);

			const fOwnedBy = adoptBuiltField(
				fieldFactory.createSelectField({
					key: 'ownedBy',
					label: runtime.tField('ownedBy'),
					value: ownedBy || BINDING_NONE_VALUE,
					options: getOwnedByOptions(),
				}),
				{ key: 'ownedBy', label: runtime.tField('ownedBy') },
			);
			setFieldDisabled(fOwnedBy, disabled);
			generalRows.push(fOwnedBy);

			const fSubset = adoptBuiltField(
				fieldFactory.createSelectField({
					key: 'subset',
					label: runtime.tField('subset'),
					value: typeof draft?.subset === 'string' && draft.subset ? draft.subset : BINDING_NONE_VALUE,
					options: getSubsetOptions(ownedBy),
				}),
				{ key: 'subset', label: runtime.tField('subset') },
			);
			setFieldDisabled(fSubset, disabled);
			generalRows.push(fSubset);

			const fKind = adoptBuiltField(
				fieldFactory.createSelectField({
					key: 'message_kind',
					label: runtime.tField('message.kind'),
					value: draft?.message?.kind,
					options: 'MsgConstants.kind',
				}),
				{ key: 'message_kind', label: runtime.tField('message.kind'), required: true },
			);
			setFieldDisabled(fKind, disabled);
			messageRows.push(fKind);

			const fLevel = adoptBuiltField(
				fieldFactory.createSelectField({
					key: 'message_level',
					label: runtime.tField('message.level'),
					value: draft?.message?.level,
					options: 'MsgConstants.level',
				}),
				{ key: 'message_level', label: runtime.tField('message.level'), required: true },
			);
			setFieldDisabled(fLevel, disabled);
			messageRows.push(fLevel);

			const titleField = adoptBuiltField(
				fieldFactory.createTextField({
					key: 'message_title',
					label: runtime.tField('message.title'),
					value: draft?.message?.title ?? '',
				}),
				{ key: 'message_title', label: runtime.tField('message.title'), required: true },
			);
			setFieldDisabled(titleField, disabled);
			const iconField = adoptBuiltField(
				fieldFactory.createTextField({
					key: 'message_icon',
					label: runtime.tField('message.icon'),
					value: draft?.message?.icon ?? '',
				}),
				{ key: 'message_icon', label: runtime.tField('message.icon') },
			);
			setFieldDisabled(iconField, disabled);
			const textField = adoptBuiltField(
				fieldFactory.createTextareaField({
					key: 'message_text',
					label: runtime.tField('message.text'),
					value: draft?.message?.text ?? '',
				}),
				{ key: 'message_text', label: runtime.tField('message.text'), required: true },
			);
			setFieldDisabled(textField, disabled);
			const textRecoveredField = adoptBuiltField(
				fieldFactory.createTextareaField({
					key: 'message_textRecovered',
					label: runtime.tField('message.textRecovered'),
					value: draft?.message?.textRecovered ?? '',
				}),
				{ key: 'message_textRecovered', label: runtime.tField('message.textRecovered') },
			);
			setFieldDisabled(textRecoveredField, disabled);
			const allowedTemplatesField = createAllowedTemplatesRow(ownedBy, draft?.subset);
			messageRows.push(titleField, iconField, textField, allowedTemplatesField, textRecoveredField);

			const fTimeBudget = adoptBuiltField(
				fieldFactory.createTimingField({
					key: 'timing_timeBudget',
					label: runtime.tField('message.timing.timeBudget'),
					value: draft?.message?.timing?.timeBudget,
					unit: 'ms',
				}),
				{ key: 'timing_timeBudget', label: runtime.tField('message.timing.timeBudget') },
			);
			setFieldDisabled(fTimeBudget, disabled);
			timingRows.push(fTimeBudget);

			const fDueIn = adoptBuiltField(
				fieldFactory.createTimingField({
					key: 'timing_dueInMs',
					label: runtime.tField('message.timing.dueIn'),
					value: draft?.message?.timing?.dueInMs,
					unit: 'ms',
				}),
				{ key: 'timing_dueInMs', label: runtime.tField('message.timing.dueIn') },
			);
			setFieldDisabled(fDueIn, disabled);
			timingRows.push(fDueIn);

			const fExpiresIn = adoptBuiltField(
				fieldFactory.createTimingField({
					key: 'timing_expiresInMs',
					label: runtime.tField('message.timing.expiresIn'),
					value: draft?.message?.timing?.expiresInMs,
					unit: 'ms',
				}),
				{ key: 'timing_expiresInMs', label: runtime.tField('message.timing.expiresIn') },
			);
			setFieldDisabled(fExpiresIn, disabled);
			timingRows.push(fExpiresIn);

			const fCooldown = adoptBuiltField(
				fieldFactory.createTimingField({
					key: 'timing_cooldown',
					label: runtime.tField('message.timing.cooldown'),
					value: draft?.message?.timing?.cooldown,
					unit: 'ms',
				}),
				{ key: 'timing_cooldown', label: runtime.tField('message.timing.cooldown') },
			);
			setFieldDisabled(fCooldown, disabled);
			timingRows.push(fCooldown);

			const fRemindEvery = adoptBuiltField(
				fieldFactory.createTimingField({
					key: 'timing_remindEvery',
					label: runtime.tField('message.timing.remindEvery'),
					value: draft?.message?.timing?.remindEvery,
					unit: 'ms',
				}),
				{ key: 'timing_remindEvery', label: runtime.tField('message.timing.remindEvery') },
			);
			setFieldDisabled(fRemindEvery, disabled);
			timingRows.push(fRemindEvery);

			const fDetailsTask = adoptBuiltField(
				fieldFactory.createTextField({
					key: 'details_task',
					label: runtime.tField('message.details.task'),
					value: draft?.message?.details?.task ?? '',
				}),
				{ key: 'details_task', label: runtime.tField('message.details.task') },
			);
			setFieldDisabled(fDetailsTask, disabled);
			detailsRows.push(fDetailsTask);

			const fDetailsReason = adoptBuiltField(
				fieldFactory.createTextField({
					key: 'details_reason',
					label: runtime.tField('message.details.reason'),
					value: draft?.message?.details?.reason ?? '',
				}),
				{ key: 'details_reason', label: runtime.tField('message.details.reason') },
			);
			setFieldDisabled(fDetailsReason, disabled);
			detailsRows.push(fDetailsReason);

			const toolsField = adoptBuiltField(
				fieldFactory.createCsvField({
					key: 'details_tools',
					label: runtime.tField('message.details.toolsCsv'),
					value: draft?.message?.details?.tools,
				}),
				{ key: 'details_tools', label: runtime.tField('message.details.toolsCsv') },
			);
			setFieldDisabled(toolsField, disabled);
			const consumablesField = adoptBuiltField(
				fieldFactory.createCsvField({
					key: 'details_consumables',
					label: runtime.tField('message.details.consumablesCsv'),
					value: draft?.message?.details?.consumables,
				}),
				{ key: 'details_consumables', label: runtime.tField('message.details.consumablesCsv') },
			);
			setFieldDisabled(consumablesField, disabled);
			detailsRows.push(toolsField, consumablesField);

			const tagsField = adoptBuiltField(
				fieldFactory.createCsvField({
					key: 'audience_tags',
					label: runtime.tField('message.audience.tagsCsv'),
					value: draft?.message?.audience?.tags,
				}),
				{ key: 'audience_tags', label: runtime.tField('message.audience.tagsCsv') },
			);
			setFieldDisabled(tagsField, disabled);
			const channelsIncludeField = adoptBuiltField(
				fieldFactory.createCsvField({
					key: 'audience_channelsInclude',
					label: runtime.tField('message.audience.channelsIncludeCsv'),
					value: draft?.message?.audience?.channels?.include,
				}),
				{ key: 'audience_channelsInclude', label: runtime.tField('message.audience.channelsIncludeCsv') },
			);
			setFieldDisabled(channelsIncludeField, disabled);
			const channelsExcludeField = adoptBuiltField(
				fieldFactory.createCsvField({
					key: 'audience_channelsExclude',
					label: runtime.tField('message.audience.channelsExcludeCsv'),
					value: draft?.message?.audience?.channels?.exclude,
				}),
				{ key: 'audience_channelsExclude', label: runtime.tField('message.audience.channelsExcludeCsv') },
			);
			setFieldDisabled(channelsExcludeField, disabled);
			audienceRows.push(tagsField, channelsIncludeField, channelsExcludeField);

			const actionsField = adoptBuiltField(
				fieldFactory.createJsonField({
					key: 'actions_json',
					label: runtime.tField('message.actions'),
					value: draft?.message?.actions || [],
				}),
				{ key: 'actions_json', label: runtime.tField('message.actions') },
			);
			setFieldDisabled(actionsField, disabled);
			actionsRows.push(actionsField);

			const fResetOnNormal = adoptBuiltField(
				fieldFactory.createCheckboxField({
					key: 'policy_resetOnNormal',
					label: runtime.tField('policy.resetOnNormal'),
					value: draft?.policy?.resetOnNormal === true,
				}),
				{ key: 'policy_resetOnNormal', label: runtime.tField('policy.resetOnNormal') },
			);
			setFieldDisabled(fResetOnNormal, disabled);
			policyRows.push(fResetOnNormal);

			const sections = [
				buildSection({
					key: 'general',
					label: runtime.tSection('general'),
					rows: generalRows,
					defaultOpen: 'always',
				}),
				buildSection({ key: 'message', label: runtime.tSection('message'), rows: messageRows }),
				buildSection({ key: 'timing', label: runtime.tSection('timing'), rows: timingRows }),
				buildSection({ key: 'details', label: runtime.tSection('details'), rows: detailsRows }),
				buildSection({ key: 'audience', label: runtime.tSection('audience'), rows: audienceRows }),
				buildSection({ key: 'policy', label: runtime.tSection('policy'), rows: policyRows }),
				buildSection({ key: 'actions', label: runtime.tSection('actions'), rows: actionsRows }),
			];

			const btnSave = runtime.h('button', {
				type: 'button',
				class: 'msghub-uibutton-text',
				disabled: disabled ? true : undefined,
				onclick: () => cfg.onSave?.(),
				text: runtime.t('msghub.i18n.core.admin.ui.action.save'),
			});
			const btnAbort = runtime.h('button', {
				type: 'button',
				class: 'msghub-uibutton-text',
				disabled: saving ? true : undefined,
				onclick: () => cfg.onAbort?.(),
				text: runtime.t('msghub.i18n.core.admin.ui.action.cancel'),
			});

			const errorNode = lastError
				? runtime.h('div', { class: 'msghub-error', text: String(lastError) })
				: saving
					? runtime.h('div', {
							class: 'msghub-muted',
							text: runtime.t('msghub.i18n.core.admin.ui.saving.text'),
						})
					: null;

			const wrapper = runtime.h('div', { class: 'msghub-preset-editor' }, [
				runtime.h('div', { class: 'msghub-preset-editor-content' }, [
					source === 'builtin'
						? runtime.h('div', {
								class: 'msghub-muted',
								text: runtime.t('msghub.i18n.IngestStates.ui.presets.builtinReadonly.text'),
							})
						: null,
					errorNode,
					...sections,
					runtime.h('div', { class: 'msghub-preset-editor-actions msghub-toolbar__group' }, [
						btnSave,
						btnAbort,
					]),
				]),
			]);

			/**
			 * Read a text value from a field descriptor.
			 *
			 * @param {any} field Field descriptor.
			 * @param {string} [fallback] Fallback value.
			 * @returns {string} Current text value.
			 */
			function readTextValue(field, fallback = '') {
				const raw = field?.getValue ? field.getValue() : fallback;
				if (raw === undefined) {
					return String(fallback ?? '');
				}
				return raw == null ? '' : String(raw);
			}

			/**
			 * Read a numeric value from a field descriptor.
			 *
			 * @param {any} field Field descriptor.
			 * @param {number} [fallback] Fallback value.
			 * @returns {number} Current numeric value.
			 */
			function readNumberValue(field, fallback = 0) {
				const raw = field?.getValue ? field.getValue() : fallback;
				if (raw === undefined || raw === null || raw === '') {
					return fallback;
				}
				const n = Number(raw);
				return Number.isFinite(n) ? n : fallback;
			}

			/**
			 * Read a boolean value from a field descriptor.
			 *
			 * @param {any} field Field descriptor.
			 * @param {boolean} [fallback] Fallback value.
			 * @returns {boolean} Current boolean value.
			 */
			function readBooleanValue(field, fallback = false) {
				const raw = field?.getValue ? field.getValue() : fallback;
				return raw === undefined ? fallback : raw === true;
			}

			/**
			 * Recompute the draft from the current widgets and refresh dependent controls.
			 *
			 * @returns {void}
			 */
			function apply() {
				const currentDraft = presetsState.getSnapshot().draft || {};
				const nextOwnedBy = normalizeBindingValue(fOwnedBy?.getValue ? fOwnedBy.getValue() : '');
				let nextSubset = normalizeBindingValue(fSubset?.getValue ? fSubset.getValue() : '');
				const allowedSubsetOptions = getSubsetOptions(nextOwnedBy);
				const allowedSubsetValues = new Set(allowedSubsetOptions.map(option => String(option?.value ?? '')));
				const nextSubsetSelectValue = nextSubset || BINDING_NONE_VALUE;
				if (!allowedSubsetValues.has(nextSubsetSelectValue)) {
					nextSubset = '';
				}
				syncSelectOptions(fSubset?.input, allowedSubsetOptions, nextSubset || BINDING_NONE_VALUE, { disabled });

				presetsState.updateDraft({
					description: readTextValue(fDescription, currentDraft?.description || ''),
					schema: String(currentDraft?.schema || bootstrapModel.presetSchema || ''),
					source,
					ownedBy: nextOwnedBy || null,
					subset: nextSubset || null,
				});
				const nextKindRaw = fKind?.getValue ? fKind.getValue() : undefined;
				const nextLevelRaw = fLevel?.getValue ? fLevel.getValue() : undefined;
				const nextKind =
					typeof nextKindRaw === 'string' && nextKindRaw.trim()
						? nextKindRaw
						: String(currentDraft?.message?.kind || '');
				const nextLevel =
					typeof nextLevelRaw === 'number' && Number.isFinite(nextLevelRaw)
						? nextLevelRaw
						: typeof nextLevelRaw === 'string' &&
							  nextLevelRaw.trim() !== '' &&
							  Number.isFinite(Number(nextLevelRaw))
							? Number(nextLevelRaw)
							: currentDraft?.message?.level;
				presetsState.updateMessage({ kind: nextKind, level: nextLevel });
				presetsState.updateMessageNested('title', titleField.getValue());
				presetsState.updateMessageNested('icon', iconField.getValue());
				presetsState.updateMessageNested('text', textField.getValue());
				presetsState.updateMessageNested('textRecovered', textRecoveredField.getValue());
				presetsState.updateMessageNested(
					'timing.timeBudget',
					readNumberValue(fTimeBudget, currentDraft?.message?.timing?.timeBudget || 0),
				);
				presetsState.updateMessageNested(
					'timing.dueInMs',
					readNumberValue(fDueIn, currentDraft?.message?.timing?.dueInMs || 0),
				);
				presetsState.updateMessageNested(
					'timing.expiresInMs',
					readNumberValue(fExpiresIn, currentDraft?.message?.timing?.expiresInMs || 0),
				);
				presetsState.updateMessageNested(
					'timing.cooldown',
					readNumberValue(fCooldown, currentDraft?.message?.timing?.cooldown || 0),
				);
				presetsState.updateMessageNested(
					'timing.remindEvery',
					readNumberValue(fRemindEvery, currentDraft?.message?.timing?.remindEvery || 0),
				);
				presetsState.updateMessageNested(
					'details.task',
					readTextValue(fDetailsTask, currentDraft?.message?.details?.task || ''),
				);
				presetsState.updateMessageNested(
					'details.reason',
					readTextValue(fDetailsReason, currentDraft?.message?.details?.reason || ''),
				);
				presetsState.updateMessageNested('details.tools', toolsField.getValue());
				presetsState.updateMessageNested('details.consumables', consumablesField.getValue());
				presetsState.updateMessageNested('audience.tags', tagsField.getValue());
				presetsState.updateMessageNested('audience.channels.include', channelsIncludeField.getValue());
				presetsState.updateMessageNested('audience.channels.exclude', channelsExcludeField.getValue());
				const rawActions = String(actionsField?.input?.value || '').trim();
				if (!rawActions) {
					presetsState.updateMessageNested('actions', []);
				} else {
					const actions = actionsField.getValue();
					if (actions !== null) {
						presetsState.updateMessageNested('actions', actions);
					}
				}
				presetsState.updatePolicy({
					resetOnNormal: readBooleanValue(fResetOnNormal, currentDraft?.policy?.resetOnNormal === true),
				});
				allowedTemplatesField.update(nextOwnedBy, nextSubset);

				const nextDraft = presetsState.getSnapshot().draft || {};
				const kind = String(nextDraft?.message?.kind || '');
				const isTask = kind === 'task';
				fTimeBudget.wrapper.classList.toggle('is-hidden', !isTask);
				fDueIn.wrapper.classList.toggle('is-hidden', !isTask);
				fDetailsTask.wrapper.classList.toggle('is-hidden', !isTask);
			}

			/**
			 * Bind live synchronization handlers to a field widget.
			 *
			 * @param {any} input Field widget.
			 * @returns {void}
			 */
			function watch(input) {
				if (!input || typeof input.addEventListener !== 'function') {
					return;
				}
				input.addEventListener('change', apply);
				input.addEventListener('input', apply);
			}

			watch(fDescription.input);
			watch(fOwnedBy.input);
			watch(fSubset.input);
			watch(fKind.input);
			watch(fLevel.input);
			watch(titleField.input);
			watch(iconField.input);
			watch(textField.input);
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
			watch(fDetailsTask.input);
			watch(fDetailsReason.input);
			watch(toolsField.input);
			watch(consumablesField.input);
			watch(tagsField.input);
			watch(channelsIncludeField.input);
			watch(channelsExcludeField.input);
			watch(actionsField.input);
			watch(fResetOnNormal.input);

			apply();
			node.replaceChildren(wrapper);
		}

		return { node, render };
	}

	const presetsState = createPresetsState(bootstrapModel);
	const fieldFactory = createFieldFactory(runtime, bootstrapModel);
	const listCallbacks = {};
	const editorCallbacks = {};
	const listPane = createListPane(runtime, bootstrapModel, listCallbacks);
	const editorPane = createEditorPane(runtime, bootstrapModel, presetsState, fieldFactory, editorCallbacks);

	/**
	 * Create the field rendering factory used by later editor blocks.
	 *
	 * @param {object} runtime Host-bound runtime primitives.
	 * @param {object} bootstrapModel Valid bootstrap model.
	 * @returns {object} Field builder functions for later editor rendering.
	 */
	function createFieldFactory(runtime, bootstrapModel) {
		const timeUnits = Object.freeze([
			{ key: 'ms', label: 'msghub.i18n.core.admin.common.time.ms.label', factor: 1 },
			{ key: 's', label: 'msghub.i18n.core.admin.common.time.s.label', factor: 1000 },
			{ key: 'min', label: 'msghub.i18n.core.admin.common.time.min.label', factor: 60 * 1000 },
			{ key: 'h', label: 'msghub.i18n.core.admin.common.time.h.label', factor: 60 * 60 * 1000 },
		]);

		/**
		 * Resolve a dotted object path.
		 *
		 * @param {any} obj Source object.
		 * @param {string} path Dotted lookup path.
		 * @returns {any} Resolved value.
		 */
		function pick(obj, path) {
			if (typeof path !== 'string') {
				return undefined;
			}
			let cur = obj;
			for (const key of path.split('.')) {
				if (!cur || typeof cur !== 'object') {
					return undefined;
				}
				cur = cur[key];
			}
			return cur;
		}

		/**
		 * Translate an i18n key if one is provided, otherwise stringify the value.
		 *
		 * @param {any} value Raw value or translation key.
		 * @returns {string} Display text.
		 */
		function pickText(value) {
			if (typeof value !== 'string') {
				return String(value ?? '');
			}
			const translated = runtime.t(value);
			return translated === value ? value : String(translated || '');
		}

		/**
		 * Parse a comma-separated input into a trimmed string list.
		 *
		 * @param {any} value Raw field value.
		 * @returns {string[]} Parsed list.
		 */
		function parseCsvList(value) {
			const s = typeof value === 'string' ? value : value == null ? '' : String(value);
			return s
				.split(',')
				.map(x => x.trim())
				.filter(Boolean);
		}

		/**
		 * Format an array of strings for CSV editor fields.
		 *
		 * @param {any} list Raw list value.
		 * @returns {string} Comma-separated display value.
		 */
		function formatCsvList(list) {
			return (Array.isArray(list) ? list : []).filter(Boolean).join(', ');
		}

		/**
		 * Normalize a unit label for comparisons.
		 *
		 * @param {any} unit Raw unit text.
		 * @returns {string} Normalized unit key.
		 */
		function normalizeUnit(unit) {
			return typeof unit === 'string' ? unit.trim().toLowerCase() : '';
		}

		/**
		 * Pick a readable default display unit for millisecond values.
		 *
		 * @param {any} ms Raw millisecond value.
		 * @returns {string} Display unit key.
		 */
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

		/**
		 * Resolve the conversion factor for a time unit.
		 *
		 * @param {string} unitKey Unit key.
		 * @returns {number} Multiplication factor relative to milliseconds.
		 */
		function getTimeFactor(unitKey) {
			const found = timeUnits.find(x => x.key === normalizeUnit(unitKey));
			return found ? found.factor : 1;
		}

		/**
		 * Infer a display unit from field metadata.
		 *
		 * @param {{ key?: string, field?: { unit?: string, label?: string } }} info Field metadata.
		 * @returns {string} Inferred unit key.
		 */
		function inferUnitFromFieldMetadata({ key, field }) {
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
		 * Resolve editor option definitions from inline values or MsgConstants paths.
		 *
		 * @param {any} options Raw option source.
		 * @returns {Array<{ label: string, value: any, fallbackLabel?: string }>} Resolved options.
		 */
		function resolveOptions(options) {
			if (Array.isArray(options)) {
				return options;
			}
			const src = typeof options === 'string' ? options.trim() : '';
			if (!src || !src.startsWith('MsgConstants.')) {
				return [];
			}
			const path = src.slice('MsgConstants.'.length);
			const obj = pick(bootstrapModel.msgConstants, path);
			if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
				return [];
			}
			const entries = Object.entries(obj).filter(
				([_key, value]) => typeof value === 'string' || typeof value === 'number',
			);
			const allNumbers = entries.every(([_key, value]) => typeof value === 'number' && Number.isFinite(value));
			if (allNumbers) {
				entries.sort((a, b) => Number(a[1]) - Number(b[1]));
			} else {
				entries.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
			}
			return entries.map(([key, value]) => ({
				label: `msghub.i18n.core.admin.common.${src}.${key}.label`,
				value,
				fallbackLabel: key,
			}));
		}

		/**
		 * Build a text input field descriptor.
		 *
		 * @param {object} cfg Field configuration.
		 * @returns {object} Built field descriptor.
		 */
		function createTextField(cfg) {
			const id = String(cfg?.id || `f_${Math.random().toString(36).slice(2, 8)}`);
			const label = String(cfg?.label || '');
			const help = String(cfg?.help || '');
			const input = runtime.h('input', { type: 'text', id, value: cfg?.value ?? '' });
			return {
				input,
				/**
				 * Return the current text input value.
				 *
				 * @returns {string} Current field value.
				 */
				getValue() {
					return input.value;
				},
				wrapper: runtime.h('div', { class: 'msghub-field' }, [
					input,
					runtime.h('label', { for: id, text: label }),
					help ? runtime.h('div', { class: 'msghub-muted', text: help }) : null,
				]),
			};
		}

		/**
		 * Build a textarea field descriptor.
		 *
		 * @param {object} cfg Field configuration.
		 * @returns {object} Built field descriptor.
		 */
		function createTextareaField(cfg) {
			const id = String(cfg?.id || `f_${Math.random().toString(36).slice(2, 8)}`);
			const label = String(cfg?.label || '');
			const help = String(cfg?.help || '');
			const input = runtime.h('textarea', { id, text: cfg?.value ?? '' });
			input.value = cfg?.value ?? '';
			return {
				input,
				/**
				 * Return the current textarea value.
				 *
				 * @returns {string} Current field value.
				 */
				getValue() {
					return input.value;
				},
				wrapper: runtime.h('div', { class: 'msghub-field msghub-field-textarea' }, [
					input,
					runtime.h('label', { for: id, text: label }),
					help ? runtime.h('div', { class: 'msghub-muted', text: help }) : null,
				]),
			};
		}

		/**
		 * Build a select field descriptor.
		 *
		 * @param {object} cfg Field configuration.
		 * @returns {object} Built field descriptor.
		 */
		function createSelectField(cfg) {
			const id = String(cfg?.id || `f_${Math.random().toString(36).slice(2, 8)}`);
			const label = String(cfg?.label || '');
			const help = String(cfg?.help || '');
			const input = runtime.h('select', { id });
			const optionList = resolveOptions(cfg?.options).filter(option => option && typeof option === 'object');
			for (const option of optionList) {
				const rawLabel = pickText(option?.label);
				const fallbackLabel =
					typeof option?.fallbackLabel === 'string' && option.fallbackLabel.trim()
						? option.fallbackLabel.trim()
						: '';
				input.appendChild(
					runtime.h('option', {
						value: String(option?.value ?? ''),
						text:
							rawLabel === option?.label && fallbackLabel
								? fallbackLabel
								: rawLabel || String(option?.value ?? ''),
					}),
				);
			}
			input.value = cfg?.value == null ? '' : String(cfg.value);
			return {
				input,
				/**
				 * Return the current selected option value.
				 *
				 * @returns {string} Current field value.
				 */
				getValue() {
					return input.value;
				},
				wrapper: runtime.h('div', { class: 'msghub-field msghub-field-select' }, [
					input,
					runtime.h('label', { for: id, text: label }),
					help ? runtime.h('div', { class: 'msghub-muted', text: help }) : null,
				]),
			};
		}

		/**
		 * Build a checkbox field descriptor.
		 *
		 * @param {object} cfg Field configuration.
		 * @returns {object} Built field descriptor.
		 */
		function createCheckboxField(cfg) {
			const id = String(cfg?.id || `f_${Math.random().toString(36).slice(2, 8)}`);
			const label = String(cfg?.label || '');
			const help = String(cfg?.help || '');
			const input = runtime.h('input', { type: 'checkbox', id });
			input.checked = cfg?.value === true;
			return {
				input,
				/**
				 * Return the current checkbox state.
				 *
				 * @returns {boolean} Current field value.
				 */
				getValue() {
					return input.checked === true;
				},
				wrapper: runtime.h('div', { class: 'msghub-field msghub-field-checkbox' }, [
					runtime.h('p', null, [input, runtime.h('label', { for: id, text: label })]),
					help ? runtime.h('div', { class: 'msghub-muted', text: help }) : null,
				]),
			};
		}

		/**
		 * Build a CSV field descriptor.
		 *
		 * @param {object} cfg Field configuration.
		 * @returns {object} Built field descriptor.
		 */
		function createCsvField(cfg) {
			const field = createTextField({ ...cfg, value: formatCsvList(cfg?.value) });
			/**
			 * Return the parsed CSV input value.
			 *
			 * @returns {string[]} Parsed CSV list.
			 */
			field.getValue = function getCsvValue() {
				return parseCsvList(field.input.value);
			};
			return field;
		}

		/**
		 * Build a JSON textarea field descriptor.
		 *
		 * @param {object} cfg Field configuration.
		 * @returns {object} Built field descriptor.
		 */
		function createJsonField(cfg) {
			const field = createTextareaField({
				...cfg,
				value: cfg?.value == null ? '' : JSON.stringify(cfg.value, null, 2),
			});
			/**
			 * Return the parsed JSON input value.
			 *
			 * @returns {any} Parsed JSON value, or null when input is empty.
			 */
			field.getValue = function getJsonValue() {
				const raw = String(field.input.value || '').trim();
				if (!raw) {
					return null;
				}
				try {
					return JSON.parse(raw);
				} catch {
					return null;
				}
			};
			return field;
		}

		/**
		 * Build a timing field descriptor that edits milliseconds via a display unit.
		 *
		 * @param {object} cfg Field configuration.
		 * @returns {object} Built field descriptor.
		 */
		function createTimingField(cfg) {
			const key = String(cfg?.key || '');
			const label = String(cfg?.label || '');
			const help = String(cfg?.help || '');
			const id = String(cfg?.id || `f_${Math.random().toString(36).slice(2, 8)}`);
			const input = runtime.h('input', { type: 'number', id });
			const selectId = `u_${Math.random().toString(36).slice(2, 8)}`;
			const select = runtime.h('select', { id: selectId, class: 'msghub-time-unit' });
			for (const unit of timeUnits) {
				select.appendChild(runtime.h('option', { value: unit.key, text: pickText(unit.label) }));
			}
			const msNum = cfg?.value === '' || cfg?.value == null ? NaN : Number(cfg.value);
			const unitKey =
				inferUnitFromFieldMetadata({ key, field: { unit: cfg?.unit, label } }) || pickDefaultTimeUnit(msNum);
			select.value = unitKey;
			input.value = Number.isFinite(msNum) ? String(msNum / getTimeFactor(unitKey)) : '';
			return {
				input,
				select,
				/**
				 * Return the current timing input as milliseconds.
				 *
				 * @returns {number|null} Milliseconds value, or null when input is empty.
				 */
				getValue() {
					const raw = input.value;
					if (raw === '') {
						return null;
					}
					const n = Number(raw);
					return Number.isFinite(n) ? Math.round(n * getTimeFactor(select.value)) : null;
				},
				wrapper: runtime.h('div', { class: 'msghub-field msghub-field-time' }, [
					runtime.h('div', { class: 'msghub-field-time-row' }, [input, select]),
					runtime.h('label', { for: id, text: label }),
					help ? runtime.h('div', { class: 'msghub-muted', text: help }) : null,
				]),
			};
		}

		return {
			createTextField,
			createTextareaField,
			createSelectField,
			createCheckboxField,
			createCsvField,
			createJsonField,
			createTimingField,
			parseCsvList,
			formatCsvList,
		};
	}

	/**
	 * Create the action factory that binds list selection, state transitions and persistence.
	 *
	 * @param {object} runtime Host-bound runtime primitives.
	 * @param {object} bootstrapModel Valid bootstrap model.
	 * @param {object} presetsState Editor state factory.
	 * @param {object} listPane List pane API.
	 * @param {object} editorPane Editor pane API.
	 * @returns {object} Action callbacks for list and editor integration.
	 */
	function createEditorActions(runtime, bootstrapModel, presetsState, listPane, editorPane) {
		/**
		 * Deep-clone JSON-compatible editor payloads.
		 *
		 * @param {any} value Source value.
		 * @returns {any} Deep-cloned value.
		 */
		function cloneJson(value) {
			return JSON.parse(JSON.stringify(value ?? null));
		}

		/**
		 * Load one complete preset payload.
		 *
		 * @param {any} presetId Preset identifier.
		 * @returns {Promise<object|null>} Loaded preset or null.
		 */
		async function loadPreset(presetId) {
			const id = String(presetId || '').trim();
			if (!/^[A-Za-z0-9_-]+$/.test(id)) {
				return null;
			}
			const res = await runtime.dataApi.getPreset({ presetId: id });
			const preset = res?.preset;
			return preset && typeof preset === 'object' ? preset : null;
		}

		/**
		 * Format the shared required-field validation message with a visible field label.
		 *
		 * @param {string} label Field label shown in the editor.
		 * @returns {string} Formatted validation message.
		 */
		function requiredFieldMessage(label) {
			return runtime.t('msghub.i18n.core.admin.ui.form.requiredFieldInvalid.text', String(label || ''));
		}

		/**
		 * Confirm whether the current draft may be discarded.
		 *
		 * @returns {Promise<boolean>} True when navigation may continue.
		 */
		async function confirmDiscardIfNeeded() {
			if (!presetsState.isDirty()) {
				return true;
			}
			return await (runtime.api?.ui?.dialog?.confirm?.({
				title: runtime.t('msghub.i18n.core.admin.ui.discardChanges.title'),
				text: runtime.t('msghub.i18n.core.admin.ui.discardChanges.text'),
				danger: true,
				confirmText: runtime.t('msghub.i18n.core.admin.ui.action.discard'),
				cancelText: runtime.t('msghub.i18n.core.admin.ui.action.cancel'),
			}) ?? false);
		}

		/**
		 * Validate the current draft before saving.
		 *
		 * @returns {string|null} Validation error text or null.
		 */
		function validateDraft() {
			const { draft } = presetsState.getSnapshot();
			if (!draft || typeof draft !== 'object') {
				return runtime.t('msghub.i18n.IngestStates.ui.presets.invalid.text');
			}
			const description = typeof draft.description === 'string' ? draft.description.trim() : '';
			if (!description) {
				return requiredFieldMessage(runtime.tField('description'));
			}
			if (!draft?.message?.kind) {
				return requiredFieldMessage(runtime.tField('message.kind'));
			}
			if (typeof draft?.message?.level !== 'number' || !Number.isFinite(draft.message.level)) {
				return requiredFieldMessage(runtime.tField('message.level'));
			}
			const title = typeof draft?.message?.title === 'string' ? draft.message.title.trim() : '';
			const text = typeof draft?.message?.text === 'string' ? draft.message.text.trim() : '';
			if (!title) {
				return requiredFieldMessage(runtime.tField('message.title'));
			}
			if (!text) {
				return requiredFieldMessage(runtime.tField('message.text'));
			}
			return null;
		}

		/**
		 * Select one preset and load its editable payload into the editor state.
		 *
		 * @param {any} presetId Preset identifier.
		 * @param {{ skipDiscard?: boolean }} [cfg] Selection options.
		 * @returns {Promise<void>}
		 */
		async function setSelected(presetId, { skipDiscard = false } = {}) {
			const snapshot = presetsState.getSnapshot();
			if (snapshot.presetLoading) {
				return;
			}
			if (!skipDiscard && !(await confirmDiscardIfNeeded())) {
				return;
			}
			const nextId = String(presetId || '').trim();
			if (!nextId) {
				return;
			}
			presetsState.setError('');
			presetsState.setPresetLoading(true);
			editorPane.render();

			const selectedRow = listPane.getRowById(nextId);
			let spinnerId = null;
			try {
				spinnerId =
					runtime.api?.ui?.spinner?.show?.({
						id: 'msghub-presets-item-load',
						message: runtime.t(
							'msghub.i18n.core.admin.ui.loadingWithSubject.text',
							String(selectedRow?.name || nextId),
						),
					}) ?? null;
			} catch {
				spinnerId = null;
			}

			try {
				const preset = await loadPreset(nextId);
				if (!preset) {
					const msg = runtime.t('msghub.i18n.IngestStates.ui.presets.load.failed.text', nextId);
					presetsState.setError(msg);
					try {
						runtime.api?.ui?.toast?.({ text: msg, variant: 'danger' });
					} catch {
						// ignore
					}
					return;
				}
				presetsState.setSelectedId(nextId);
				presetsState.setLoadedPreset(preset);
				listPane.setSelectedId(nextId);
			} catch (e) {
				const msg = String(e?.message || e);
				presetsState.setError(msg);
				try {
					runtime.api?.ui?.toast?.({ text: msg, variant: 'danger' });
				} catch {
					// ignore
				}
			} finally {
				presetsState.setPresetLoading(false);
				if (spinnerId) {
					try {
						runtime.api?.ui?.spinner?.hide?.(spinnerId);
					} catch {
						// ignore
					}
				}
				editorPane.render();
			}
		}

		/**
		 * Start editing a fresh user-owned preset.
		 *
		 * @returns {Promise<void>}
		 */
		async function createNew() {
			if (!(await confirmDiscardIfNeeded())) {
				return;
			}
			presetsState.setError('');
			presetsState.setSelectedId('');
			presetsState.startNewDraft();
			listPane.setSelectedId('');
			editorPane.render();
		}

		/**
		 * Duplicate the current draft into a fresh user-owned preset.
		 *
		 * @returns {Promise<void>}
		 */
		async function duplicateSelected() {
			if (!(await confirmDiscardIfNeeded())) {
				return;
			}
			const snapshot = presetsState.getSnapshot();
			if (!snapshot.original || typeof snapshot.original !== 'object') {
				try {
					runtime.api?.ui?.toast?.({
						text: runtime.t('msghub.i18n.IngestStates.ui.presets.selection.missing.text'),
						variant: 'warning',
					});
				} catch {
					// ignore
				}
				return;
			}
			const nextDraft = cloneJson(snapshot.draft || snapshot.original);
			nextDraft.presetId = '';
			nextDraft.source = 'user';
			presetsState.setError('');
			presetsState.setSelectedId('');
			presetsState.startNewDraft(nextDraft);
			listPane.setSelectedId('');
			editorPane.render();
		}

		/**
		 * Reload the preset list and reset the current editor selection.
		 *
		 * @returns {Promise<void>}
		 */
		async function reloadList() {
			presetsState.setError('');
			presetsState.setSelectedId('');
			presetsState.resetEditorState();
			listPane.setSelectedId('');
			editorPane.render();
			await listPane.loadList({ renderLoading: false, showLoadingToast: true });
		}

		/**
		 * Delete the selected preset and refresh the list.
		 *
		 * @returns {Promise<void>}
		 */
		async function deleteSelected() {
			const { selectedId } = presetsState.getSnapshot();
			const id = String(selectedId || '').trim();
			if (!id) {
				return;
			}
			if (
				!(await (runtime.api?.ui?.dialog?.confirm?.({
					title: runtime.t('msghub.i18n.IngestStates.ui.presets.delete.confirm.title'),
					text: runtime.t('msghub.i18n.IngestStates.ui.presets.delete.confirm.text', id),
					danger: true,
					confirmText: runtime.t('msghub.i18n.core.admin.ui.action.delete'),
					cancelText: runtime.t('msghub.i18n.core.admin.ui.action.cancel'),
				}) ?? false))
			) {
				return;
			}
			presetsState.setError('');
			presetsState.setSaving(true);
			editorPane.render();
			try {
				await runtime.dataApi.deletePreset({ presetId: id });
				presetsState.setSelectedId('');
				presetsState.resetEditorState();
				listPane.setSelectedId('');
				editorPane.render();
				await listPane.loadList({ renderLoading: false, showLoadingToast: true });
			} catch (e) {
				const msg = String(e?.message || e);
				presetsState.setError(msg);
				try {
					runtime.api?.ui?.toast?.({ text: msg, variant: 'danger' });
				} catch {
					// ignore
				}
			} finally {
				presetsState.setSaving(false);
				editorPane.render();
			}
		}

		/**
		 * Persist the current draft through create or update RPC calls.
		 *
		 * @returns {Promise<void>}
		 */
		async function saveDraft() {
			const err = validateDraft();
			if (err) {
				presetsState.setError(err);
				try {
					runtime.api?.ui?.toast?.({ text: err, variant: 'danger' });
				} catch {
					// ignore
				}
				editorPane.render();
				return;
			}

			const snapshot = presetsState.getSnapshot();
			presetsState.setError('');
			presetsState.setSaving(true);
			editorPane.render();

			try {
				const preset = cloneJson(snapshot.draft);
				if (preset && typeof preset === 'object' && Object.prototype.hasOwnProperty.call(preset, 'ui')) {
					delete preset.ui;
				}
				if (preset && typeof preset === 'object' && Object.prototype.hasOwnProperty.call(preset, 'presetId')) {
					delete preset.presetId;
				}

				let nextPresetId = '';
				if (snapshot.isNew) {
					const result = await runtime.dataApi.createPreset({ preset });
					nextPresetId =
						typeof result?.presetId === 'string'
							? result.presetId.trim()
							: typeof result?.data?.presetId === 'string'
								? result.data.presetId.trim()
								: '';
				} else {
					nextPresetId = String(snapshot.draft?.presetId || '').trim();
					await runtime.dataApi.updatePreset({ presetId: nextPresetId, preset });
				}

				await listPane.loadList({ renderLoading: false, showLoadingToast: true });
				await setSelected(nextPresetId, { skipDiscard: true });
			} catch (e) {
				const msg = String(e?.message || e);
				presetsState.setError(msg);
				try {
					runtime.api?.ui?.toast?.({ text: msg, variant: 'danger' });
				} catch {
					// ignore
				}
			} finally {
				presetsState.setSaving(false);
				editorPane.render();
			}
		}

		/**
		 * Abort the current edit and restore the last stable editor state.
		 *
		 * @returns {Promise<void>}
		 */
		async function abortEdit() {
			if (!(await confirmDiscardIfNeeded())) {
				return;
			}
			const snapshot = presetsState.getSnapshot();
			presetsState.setError('');
			if (snapshot.isNew) {
				presetsState.setSelectedId('');
				presetsState.resetEditorState();
				listPane.setSelectedId('');
			} else {
				presetsState.discardChanges();
			}
			editorPane.render();
		}

		return {
			setSelected,
			createNew,
			reloadList,
			duplicateSelected,
			deleteSelected,
			saveDraft,
			abortEdit,
		};
	}

	const editorActions = createEditorActions(runtime, bootstrapModel, presetsState, listPane, editorPane);
	listCallbacks.onSelect = editorActions.setSelected;
	listCallbacks.onCreate = editorActions.createNew;
	listCallbacks.onReload = editorActions.reloadList;
	listCallbacks.onDuplicate = editorActions.duplicateSelected;
	listCallbacks.onDelete = editorActions.deleteSelected;
	editorCallbacks.onSave = editorActions.saveDraft;
	editorCallbacks.onAbort = editorActions.abortEdit;
	editorPane.render();
	runtime.root.replaceChildren(
		runtime.h('div', { class: 'msghub-tools-presets-grid' }, [listPane.node, editorPane.node]),
	);
	const initialReady = listPane.loadList();
	runtime.root.__msghubReady = initialReady;
	void initialReady.catch(e => {
		const msg = String(e?.message || e);
		presetsState.setError(msg);
		try {
			runtime.api?.ui?.toast?.({ text: msg, variant: 'danger' });
		} catch {
			// ignore
		}
		editorPane.render();
	});
	await initialReady;
}

/**
 * Unmount the preset bundle and clear the mount root.
 *
 * @param {object} ctx Host-provided bundle context.
 * @returns {Promise<void>}
 */
export async function unmount(ctx) {
	if (ctx?.root && typeof ctx.root.replaceChildren === 'function') {
		ctx.root.replaceChildren();
	}
}
