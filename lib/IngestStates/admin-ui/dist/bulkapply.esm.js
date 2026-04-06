/**
 * bulkapply.esm.js
 * ================
 *
 * Light-DOM plugin panel bundle for the IngestStates bulk apply tool.
 *
 * UI text is intentionally hard-coded in this intermediate work state.
 * i18n wiring will follow once the UI/UX shape is stable.
 */

/**
 * Mount the bulk apply panel into the provided Light-DOM root.
 *
 * Initialises the runtime, bootstrap model, form sections, and action factory,
 * then renders the initial panel state.
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
	 *   dataApi: object
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
		 * Execute one bulk apply RPC command through the host-bound plugin request path.
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
			 * Load the static bulk apply bootstrap payload.
			 *
			 * @returns {Promise<any>} Bootstrap RPC payload.
			 */
			bootstrap() {
				return call('admin.bulkapply.bootstrap', null);
			},
			/**
			 * Read the current IngestStates custom config for a single ioBroker object.
			 *
			 * @param {any} payload Config read payload.
			 * @returns {Promise<any>} Config read RPC payload.
			 */
			configRead(payload) {
				return call('admin.bulkapply.configRead', payload);
			},
			/**
			 * Preview the effect of applying a custom config patch to all matching objects.
			 *
			 * @param {any} payload Preview payload.
			 * @returns {Promise<any>} Preview RPC payload.
			 */
			preview(payload) {
				return call('admin.bulkapply.preview', payload);
			},
			/**
			 * Apply a custom config patch to all matching ioBroker state objects.
			 *
			 * @param {any} payload Apply payload.
			 * @returns {Promise<any>} Apply RPC payload.
			 */
			apply(payload) {
				return call('admin.bulkapply.apply', payload);
			},
		});

		return { root, h, t, api, dataApi };
	}

	/**
	 * Load and validate the static bootstrap payload for the bulk apply panel.
	 *
	 * On failure (RPC error or empty namespace), renders an error node in root
	 * and returns null to abort the mount.
	 *
	 * @param {{
	 *   root: any,
	 *   h: Function,
	 *   dataApi: object
	 * }} runtime Host-bound runtime.
	 * @returns {Promise<object|null>} Valid bootstrap model or null on visible bootstrap failure.
	 */
	async function loadBootstrapModel(runtime) {
		try {
			const bootstrap = await runtime.dataApi.bootstrap();
			const namespace = bootstrap && typeof bootstrap.namespace === 'string' ? bootstrap.namespace.trim() : '';
			const jsonCustomDefaults =
				bootstrap && bootstrap.jsonCustomDefaults && typeof bootstrap.jsonCustomDefaults === 'object'
					? bootstrap.jsonCustomDefaults
					: {};
			if (!namespace) {
				runtime.root.replaceChildren(
					// Hard-coded: intermediate work state — i18n wiring deferred.
					runtime.h('div', {
						class: 'msghub-error',
						text: 'Bulk apply unavailable: configuration could not be loaded.',
					}),
				);
				return null;
			}
			return { namespace, jsonCustomDefaults };
		} catch {
			runtime.root.replaceChildren(
				// Hard-coded: intermediate work state — i18n wiring deferred.
				runtime.h('div', {
					class: 'msghub-error',
					text: 'Bulk apply unavailable: configuration could not be loaded.',
				}),
			);
			return null;
		}
	}

	const runtime = createPanelRuntime();
	runtime.root.replaceChildren();
	const bootstrapModel = await loadBootstrapModel(runtime);
	if (!bootstrapModel) {
		return;
	}

	// ── Inline helpers ────────────────────────────────────────────────────────

	/**
	 * Parse and validate a raw JSON string as a non-null plain object.
	 *
	 * @param {string} rawString Raw JSON input.
	 * @returns {object} Parsed plain object.
	 * @throws {Error} When the string is empty, not valid JSON, or not a plain object.
	 */
	function sanitizeCustomJson(rawString) {
		const trimmed = typeof rawString === 'string' ? rawString.trim() : '';
		if (!trimmed) {
			throw new Error('Custom JSON is empty');
		}
		const parsed = JSON.parse(trimmed);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('Custom JSON must be a plain object');
		}
		return parsed;
	}

	/**
	 * Build a pretty-printed JSON string from the jsonCustomDefaults bootstrap value.
	 *
	 * @param {object} jsonCustomDefaults Default values from bootstrap.
	 * @returns {string} Pretty-printed JSON string.
	 */
	function buildDefaultJson(jsonCustomDefaults) {
		return JSON.stringify(jsonCustomDefaults, null, 2);
	}

	/**
	 * Safely load and parse a JSON value from localStorage.
	 *
	 * @param {string} key localStorage key.
	 * @returns {any} Parsed value or null on any error.
	 */
	function loadFromLocalStorage(key) {
		try {
			const raw = localStorage.getItem(key);
			return raw ? JSON.parse(raw) : null;
		} catch {
			return null;
		}
	}

	// ── State ─────────────────────────────────────────────────────────────────

	/**
	 * Create the bulk apply panel state with localStorage persistence for form values.
	 *
	 * Persisted: pattern, sourceId, customJson, useReplace.
	 * Not persisted: previewResult (cleared on mount and on form changes), busy.
	 *
	 * @param {object} bModel Valid bootstrap model with namespace and jsonCustomDefaults.
	 * @returns {object} State accessors and mutation helpers.
	 */
	function createBulkApplyState(bModel) {
		const storageKey = `msghub.bulkApply.${bModel.namespace}`;
		const persisted = loadFromLocalStorage(storageKey) || {};

		let pattern = typeof persisted.pattern === 'string' ? persisted.pattern : '';
		let sourceId = typeof persisted.sourceId === 'string' ? persisted.sourceId : '';
		let customJson = typeof persisted.customJson === 'string' ? persisted.customJson : '';
		let useReplace = persisted.useReplace === true;
		let previewResult = null;
		let busy = false;

		/**
		 * Persist current form values to localStorage.
		 *
		 * @returns {void}
		 */
		function persist() {
			try {
				localStorage.setItem(storageKey, JSON.stringify({ pattern, sourceId, customJson, useReplace }));
			} catch {
				// Ignore persistence failures.
			}
		}

		/**
		 * Return the current state snapshot.
		 *
		 * @returns {{ pattern: string, sourceId: string, customJson: string, useReplace: boolean, previewResult: object|null, busy: boolean }} Current state snapshot.
		 */
		function getSnapshot() {
			return { pattern, sourceId, customJson, useReplace, previewResult, busy };
		}

		/**
		 * Update the object id input value and persist.
		 *
		 * @param {string} value New source object id.
		 * @returns {void}
		 */
		function setSourceId(value) {
			sourceId = typeof value === 'string' ? value : '';
			persist();
		}

		/**
		 * Update the glob pattern value, clear preview result, and persist.
		 *
		 * @param {string} value New pattern.
		 * @returns {void}
		 */
		function setPattern(value) {
			pattern = typeof value === 'string' ? value : '';
			previewResult = null;
			persist();
		}

		/**
		 * Update the custom JSON textarea value, clear preview result, and persist.
		 *
		 * @param {string} value New custom JSON string.
		 * @returns {void}
		 */
		function setCustomJson(value) {
			customJson = typeof value === 'string' ? value : '';
			previewResult = null;
			persist();
		}

		/**
		 * Update the replace-mode flag, clear preview result, and persist.
		 *
		 * @param {boolean} value New replace flag.
		 * @returns {void}
		 */
		function setUseReplace(value) {
			useReplace = value === true;
			previewResult = null;
			persist();
		}

		/**
		 * Store the latest successful preview result.
		 *
		 * @param {object|null} result Preview result or null to clear.
		 * @returns {void}
		 */
		function setPreviewResult(result) {
			previewResult = result && typeof result === 'object' ? result : null;
		}

		/**
		 * Clear the preview result.
		 *
		 * @returns {void}
		 */
		function clearPreviewResult() {
			previewResult = null;
		}

		/**
		 * Set or clear the busy flag.
		 *
		 * When busy, all action buttons are disabled to prevent overlapping async operations.
		 *
		 * @param {boolean} value New busy flag.
		 * @returns {void}
		 */
		function setBusy(value) {
			busy = value === true;
		}

		return {
			getSnapshot,
			setSourceId,
			setPattern,
			setCustomJson,
			setUseReplace,
			setPreviewResult,
			clearPreviewResult,
			setBusy,
		};
	}

	// ── Section factories ─────────────────────────────────────────────────────

	/**
	 * Create the source section: object id input + load + generate-empty buttons.
	 *
	 * Load button is disabled when the source id field is empty or when busy.
	 * Generate button is disabled when busy.
	 *
	 * @param {object} runtime Host-bound runtime.
	 * @param {object} state Bulk apply state.
	 * @param {object} callbacks Deferred action callbacks.
	 * @returns {{ node: any, render: Function }} Source section.
	 */
	function createSourceSection(runtime, state, callbacks) {
		const { h } = runtime;
		const snapshot = state.getSnapshot();

		const inputSourceId = h('input', {
			type: 'text',
			id: 'msghub-bulk-sourceId',
			class: 'msghub-bulk-input',
			value: snapshot.sourceId,
			oninput: e => state.setSourceId(e?.target?.value ?? ''),
		});

		// Hard-coded: intermediate work state — i18n wiring deferred.
		const btnLoad = h('button', {
			type: 'button',
			class: 'msghub-bulk-action',
			text: 'Load config from object',
			onclick: () => callbacks.onLoad?.(),
		});

		// Hard-coded: intermediate work state — i18n wiring deferred.
		const btnGenerate = h('button', {
			type: 'button',
			class: 'msghub-bulk-action',
			text: 'Generate empty config',
			onclick: () => callbacks.onGenerate?.(),
		});

		// Hard-coded: intermediate work state — i18n wiring deferred.
		const node = h('section', { class: 'msghub-bulk-section', 'data-section': 'source' }, [
			h('div', { class: 'msghub-bulk-section-head', text: 'Source object' }),
			h('label', { for: 'msghub-bulk-sourceId', text: 'Source object ID' }),
			inputSourceId,
			h('div', { class: 'msghub-bulk-actions' }, [btnLoad, btnGenerate]),
		]);

		/**
		 * Re-render the source section: update button disabled states from current state.
		 *
		 * Both buttons are disabled when busy. Load is also disabled when source id is empty.
		 *
		 * @returns {void}
		 */
		function render() {
			const s = state.getSnapshot();
			btnLoad.disabled = s.busy || !s.sourceId.trim();
			btnGenerate.disabled = s.busy;
		}

		return { node, render };
	}

	/**
	 * Create the config section: pattern input, custom JSON textarea, replace-mode checkbox.
	 *
	 * Exposes setCustomJsonValue to allow action handlers to update the textarea imperatively.
	 *
	 * @param {object} runtime Host-bound runtime.
	 * @param {object} state Bulk apply state.
	 * @param {object} _callbacks Reserved.
	 * @returns {{ node: any, render: Function, setCustomJsonValue: Function }} Config section.
	 */
	function createConfigSection(runtime, state, _callbacks) {
		const { h } = runtime;
		const snapshot = state.getSnapshot();

		const inputPattern = h('input', {
			type: 'text',
			id: 'msghub-bulk-pattern',
			class: 'msghub-bulk-input',
			value: snapshot.pattern,
			oninput: e => state.setPattern(e?.target?.value ?? ''),
		});

		const textareaCustomJson = h('textarea', {
			id: 'msghub-bulk-customJson',
			class: 'msghub-bulk-textarea',
			oninput: e => state.setCustomJson(e?.target?.value ?? ''),
		});
		if (snapshot.customJson) {
			textareaCustomJson.value = snapshot.customJson;
		}

		const checkboxReplace = h('input', {
			type: 'checkbox',
			id: 'msghub-bulk-useReplace',
			onchange: e => state.setUseReplace(e?.target?.checked === true),
		});
		if (snapshot.useReplace) {
			checkboxReplace.checked = true;
		}

		// Hard-coded: intermediate work state — i18n wiring deferred.
		const node = h('section', { class: 'msghub-bulk-section', 'data-section': 'config' }, [
			h('div', { class: 'msghub-bulk-section-head', text: 'Configuration' }),
			h('label', { for: 'msghub-bulk-pattern', text: 'Object ID pattern (glob)' }),
			inputPattern,
			h('label', { for: 'msghub-bulk-customJson', text: 'Custom config (JSON)' }),
			textareaCustomJson,
			h('div', { class: 'msghub-bulk-check-row' }, [
				checkboxReplace,
				h('label', { for: 'msghub-bulk-useReplace', text: 'Replace entire custom config (instead of merge)' }),
			]),
		]);

		/**
		 * Imperatively set the textarea DOM value and update state.
		 *
		 * Used by action handlers that programmatically fill the config field.
		 *
		 * @param {string} val New JSON string value.
		 * @returns {void}
		 */
		function setCustomJsonValue(val) {
			textareaCustomJson.value = val;
			state.setCustomJson(val);
		}

		/**
		 * Re-render the config section. No dynamic disabled states in this section.
		 *
		 * @returns {void}
		 */
		function render() {
			// No dynamic disabled state in this section.
		}

		return { node, render, setCustomJsonValue };
	}

	/**
	 * Create the preview section: preview button + human-readable result container.
	 *
	 * Preview button is disabled when busy.
	 *
	 * @param {object} runtime Host-bound runtime.
	 * @param {object} state Bulk apply state.
	 * @param {object} callbacks Deferred action callbacks.
	 * @returns {{ node: any, render: Function }} Preview section.
	 */
	function createPreviewSection(runtime, state, callbacks) {
		const { h } = runtime;

		// Hard-coded: intermediate work state — i18n wiring deferred.
		const btnPreview = h('button', {
			type: 'button',
			class: 'msghub-bulk-action',
			text: 'Preview',
			onclick: () => callbacks.onPreview?.(),
		});

		const previewContainer = h('div', { class: 'msghub-bulk-preview' });

		// Hard-coded: intermediate work state — i18n wiring deferred.
		const node = h('section', { class: 'msghub-bulk-section', 'data-section': 'preview' }, [
			h('div', { class: 'msghub-bulk-section-head', text: 'Preview' }),
			h('div', { class: 'msghub-bulk-actions' }, [btnPreview]),
			previewContainer,
		]);

		/**
		 * Render human-readable preview result DOM into the preview container.
		 *
		 * Builds paragraph summaries and sample id lists from the preview payload.
		 * Clears the container when data is null.
		 *
		 * @param {object|null} data Preview result or null to clear.
		 * @returns {void}
		 */
		function renderPreview(data) {
			if (!data) {
				previewContainer.replaceChildren();
				return;
			}

			const changedSamples = Array.isArray(data.sample) ? data.sample.filter(s => s?.changed === true) : [];
			const unchangedSamples = Array.isArray(data.sample) ? data.sample.filter(s => s?.changed === false) : [];

			// Hard-coded: intermediate work state — i18n wiring deferred.
			const nodes = [
				h('p', { text: `Pattern: ${String(data.pattern ?? '')}` }),
				h('p', {
					text: `${String(data.matchedStates ?? 0)} of ${String(data.totalObjects ?? 0)} objects match the pattern`,
				}),
				h('p', {
					text: `${String(data.willChange ?? 0)} objects will change, ${String(data.unchanged ?? 0)} unchanged`,
				}),
			];

			if (changedSamples.length > 0) {
				nodes.push(
					// Hard-coded: intermediate work state — i18n wiring deferred.
					h('div', { class: 'msghub-bulk-sample-label', text: 'Will change:' }),
					h(
						'ul',
						{ class: 'msghub-bulk-sample-list' },
						changedSamples.map(s => h('li', { text: String(s.id ?? '') })),
					),
				);
			}
			if (unchangedSamples.length > 0) {
				nodes.push(
					// Hard-coded: intermediate work state — i18n wiring deferred.
					h('div', { class: 'msghub-bulk-sample-label', text: 'Unchanged:' }),
					h(
						'ul',
						{ class: 'msghub-bulk-sample-list' },
						unchangedSamples.map(s => h('li', { text: String(s.id ?? '') })),
					),
				);
			}

			previewContainer.replaceChildren(...nodes);
		}

		/**
		 * Re-render the preview section from current state.
		 *
		 * @returns {void}
		 */
		function render() {
			const s = state.getSnapshot();
			btnPreview.disabled = s.busy;
			renderPreview(s.previewResult);
		}

		return { node, render };
	}

	/**
	 * Create the apply section: apply button.
	 *
	 * Apply button is disabled when busy, when no preview result is present,
	 * or when the preview result shows willChange === 0.
	 *
	 * @param {object} runtime Host-bound runtime.
	 * @param {object} state Bulk apply state.
	 * @param {object} callbacks Deferred action callbacks.
	 * @returns {{ node: any, render: Function }} Apply section.
	 */
	function createApplySection(runtime, state, callbacks) {
		const { h } = runtime;

		// Hard-coded: intermediate work state — i18n wiring deferred.
		const btnApply = h('button', {
			type: 'button',
			class: 'msghub-bulk-action',
			text: 'Apply',
			onclick: () => callbacks.onApply?.(),
		});

		// Hard-coded: intermediate work state — i18n wiring deferred.
		const node = h('section', { class: 'msghub-bulk-section', 'data-section': 'apply' }, [
			h('div', { class: 'msghub-bulk-section-head', text: 'Apply' }),
			h('div', { class: 'msghub-bulk-actions' }, [btnApply]),
		]);

		/**
		 * Re-render the apply section: enable apply only when not busy, preview exists,
		 * and willChange > 0.
		 *
		 * @returns {void}
		 */
		function render() {
			const s = state.getSnapshot();
			btnApply.disabled = s.busy || !s.previewResult || s.previewResult.willChange === 0;
		}

		return { node, render };
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	/**
	 * Create the action factory wiring bulk apply operations to the backend.
	 *
	 * @param {object} runtime Host-bound runtime.
	 * @param {object} bModel Valid bootstrap model.
	 * @param {object} state Bulk apply state.
	 * @param {{ sourceSection: object, configSection: object, previewSection: object, applySection: object }} sections Form sections.
	 * @returns {{ loadConfig: Function, generateEmpty: Function, runPreview: Function, runApply: Function }} Action handlers.
	 */
	function createBulkApplyActions(runtime, bModel, state, sections) {
		/**
		 * Re-render all sections.
		 *
		 * @returns {void}
		 */
		function renderAll() {
			sections.sourceSection.render();
			sections.configSection.render();
			sections.previewSection.render();
			sections.applySection.render();
		}

		/**
		 * Load the existing IngestStates config for the given source object id.
		 *
		 * Fills the custom JSON textarea with the object's current custom config.
		 * Sets busy during the async operation to prevent overlapping actions.
		 * No-op when the source id field is empty.
		 *
		 * @returns {Promise<void>}
		 */
		async function loadConfig() {
			const { sourceId } = state.getSnapshot();
			const id = typeof sourceId === 'string' ? sourceId.trim() : '';
			if (!id) {
				return;
			}

			state.setBusy(true);
			renderAll();

			let spinnerId = null;
			try {
				spinnerId =
					runtime.api?.ui?.spinner?.show?.({
						id: 'msghub-bulk-load',
						message: runtime.t('msghub.i18n.core.admin.ui.loadingWithSubject.text', id),
					}) ?? null;
			} catch {
				spinnerId = null;
			}

			try {
				const data = await runtime.dataApi.configRead({ id });
				const custom = data?.custom && typeof data.custom === 'object' ? data.custom : {};
				sections.configSection.setCustomJsonValue(JSON.stringify(custom, null, 2));
			} catch (e) {
				const msg = String(e?.message || e);
				try {
					runtime.api?.ui?.toast?.({ text: msg, variant: 'danger' });
				} catch {
					// ignore
				}
			} finally {
				if (spinnerId) {
					try {
						runtime.api?.ui?.spinner?.hide?.(spinnerId);
					} catch {
						// ignore
					}
				}
				state.setBusy(false);
				renderAll();
			}
		}

		/**
		 * Fill the custom JSON textarea with the default empty config from bootstrap.
		 *
		 * Synchronous — no busy state required.
		 *
		 * @returns {void}
		 */
		function generateEmpty() {
			sections.configSection.setCustomJsonValue(buildDefaultJson(bModel.jsonCustomDefaults));
			renderAll();
		}

		/**
		 * Run a dry-run preview of the bulk apply operation.
		 *
		 * Clears any previous preview result before fetching a new one.
		 * Sets busy during the async operation to prevent overlapping actions.
		 * No-op when pattern is empty or custom JSON is invalid.
		 *
		 * @returns {Promise<void>}
		 */
		async function runPreview() {
			const { pattern, customJson, useReplace } = state.getSnapshot();
			const patternTrimmed = typeof pattern === 'string' ? pattern.trim() : '';
			if (!patternTrimmed) {
				return;
			}

			let custom;
			try {
				custom = sanitizeCustomJson(customJson);
			} catch {
				return;
			}

			state.clearPreviewResult();
			state.setBusy(true);
			renderAll();

			let spinnerId = null;
			try {
				spinnerId =
					runtime.api?.ui?.spinner?.show?.({
						id: 'msghub-bulk-preview',
						message: runtime.t('msghub.i18n.core.admin.ui.loadingWithSubject.text', patternTrimmed),
					}) ?? null;
			} catch {
				spinnerId = null;
			}

			try {
				const data = await runtime.dataApi.preview({
					pattern: patternTrimmed,
					custom,
					replace: useReplace,
				});
				state.setPreviewResult(data);
			} catch (e) {
				const msg = String(e?.message || e);
				state.clearPreviewResult();
				try {
					runtime.api?.ui?.toast?.({ text: msg, variant: 'danger' });
				} catch {
					// ignore
				}
			} finally {
				if (spinnerId) {
					try {
						runtime.api?.ui?.spinner?.hide?.(spinnerId);
					} catch {
						// ignore
					}
				}
				state.setBusy(false);
				renderAll();
			}
		}

		/**
		 * Confirm and execute the bulk apply operation.
		 *
		 * Requires a valid preview result with willChange > 0 and user confirmation.
		 * Sets busy after confirmation (before the API call) to prevent overlapping actions.
		 * Shows a success toast on completion, or an error toast on failure.
		 * Clears the preview result after a successful apply.
		 *
		 * @returns {Promise<void>}
		 */
		async function runApply() {
			const { pattern, customJson, useReplace, previewResult } = state.getSnapshot();
			if (!previewResult || previewResult.willChange === 0) {
				return;
			}

			const patternTrimmed = typeof pattern === 'string' ? pattern.trim() : '';
			let custom;
			try {
				custom = sanitizeCustomJson(customJson);
			} catch {
				return;
			}

			// Confirm before setting busy — the dialog itself must remain interactive.
			// Hard-coded: intermediate work state — i18n wiring deferred.
			const confirmed = await (runtime.api?.ui?.dialog?.confirm?.({
				title: 'Apply to all matching objects?',
				text: `Apply custom config to all objects matching pattern '${patternTrimmed}'?`,
				danger: true,
				confirmText: 'Apply',
				cancelText: 'Cancel',
			}) ?? false);
			if (!confirmed) {
				return;
			}

			state.setBusy(true);
			renderAll();

			let spinnerId = null;
			try {
				spinnerId =
					runtime.api?.ui?.spinner?.show?.({
						id: 'msghub-bulk-apply',
						message: runtime.t('msghub.i18n.core.admin.ui.loadingWithSubject.text', patternTrimmed),
					}) ?? null;
			} catch {
				spinnerId = null;
			}

			try {
				const data = await runtime.dataApi.apply({ pattern: patternTrimmed, custom, replace: useReplace });
				state.clearPreviewResult();
				const applyErrors = Array.isArray(data?.errors) ? data.errors : [];
				try {
					if (applyErrors.length > 0) {
						// Hard-coded: intermediate work state — i18n wiring deferred.
						runtime.api?.ui?.toast?.({
							text: `Bulk apply completed with ${applyErrors.length} error(s).`,
							variant: 'danger',
						});
					} else {
						// Hard-coded: intermediate work state — i18n wiring deferred.
						runtime.api?.ui?.toast?.({ text: 'Bulk apply completed.' });
					}
				} catch {
					// ignore
				}
			} catch (e) {
				const msg = String(e?.message || e);
				try {
					runtime.api?.ui?.toast?.({ text: msg, variant: 'danger' });
				} catch {
					// ignore
				}
			} finally {
				if (spinnerId) {
					try {
						runtime.api?.ui?.spinner?.hide?.(spinnerId);
					} catch {
						// ignore
					}
				}
				state.setBusy(false);
				renderAll();
			}
		}

		return { loadConfig, generateEmpty, runPreview, runApply };
	}

	// ── Wire up ───────────────────────────────────────────────────────────────

	const state = createBulkApplyState(bootstrapModel);
	const sourceCallbacks = {};
	const configCallbacks = {};
	const previewCallbacks = {};
	const applyCallbacks = {};

	const sourceSection = createSourceSection(runtime, state, sourceCallbacks);
	const configSection = createConfigSection(runtime, state, configCallbacks);
	const previewSection = createPreviewSection(runtime, state, previewCallbacks);
	const applySection = createApplySection(runtime, state, applyCallbacks);

	const actions = createBulkApplyActions(runtime, bootstrapModel, state, {
		sourceSection,
		configSection,
		previewSection,
		applySection,
	});

	sourceCallbacks.onLoad = actions.loadConfig;
	sourceCallbacks.onGenerate = actions.generateEmpty;
	previewCallbacks.onPreview = actions.runPreview;
	applyCallbacks.onApply = actions.runApply;

	sourceSection.render();
	configSection.render();
	previewSection.render();
	applySection.render();

	runtime.root.replaceChildren(
		runtime.h('div', { class: 'msghub-bulk-apply' }, [
			sourceSection.node,
			configSection.node,
			previewSection.node,
			applySection.node,
		]),
	);

	runtime.root.__msghubReady = Promise.resolve();
}

/**
 * Unmount the bulk apply bundle and clear the mount root.
 *
 * @param {object} ctx Host-provided bundle context.
 * @returns {Promise<void>}
 */
export async function unmount(ctx) {
	if (ctx?.root && typeof ctx.root.replaceChildren === 'function') {
		ctx.root.replaceChildren();
	}
}
