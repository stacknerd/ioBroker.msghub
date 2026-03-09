/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

/* global window */
(function () {
	'use strict';

	const win = window;

	function createPluginsBulkApplyApi(options) {
		const opts = options && typeof options === 'object' ? options : {};
		const h = typeof opts.h === 'function' ? opts.h : () => ({});
		const toast = typeof opts.toast === 'function' ? opts.toast : () => {};
		const confirmDialog = typeof opts.confirmDialog === 'function' ? opts.confirmDialog : async () => false;
		const ingestStatesDataApi = opts.ingestStatesDataApi || null;
		const adapterNamespace = typeof opts.adapterNamespace === 'string' ? opts.adapterNamespace : 'msghub.0';

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
				class: 'msghub-uibutton-text',
				text: 'Load from object',
			});

			const btnGenerateEmpty = h('button', {
				type: 'button',
				class: 'msghub-uibutton-text',
				text: 'Generate empty',
			});

			const btnPreview = h('button', {
				type: 'button',
				class: 'msghub-uibutton-text',
				text: 'Generate preview',
			});

			const btnApply = h('button', {
				type: 'button',
				class: 'msghub-uibutton-text',
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
				toast('IngestStates is disabled. Enable the plugin to use Bulk Apply.', 'warning');
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
					const res = await ingestStatesDataApi.customRead({ id });
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
					const res = await ingestStatesDataApi.bulkApplyPreview({
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
					const res = await ingestStatesDataApi.bulkApplyApply({
						pattern,
						custom,
						replace: elReplace.checked === true,
					});
					setStatus(
						`Done: updated=${res.updated}, unchanged=${res.unchanged}, errors=${(res.errors || []).length}`,
					);
					setPreview(null);
					toast(`Bulk apply done: updated=${res.updated}`, 'ok');
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
						h('div', { class: 'msghub-toolbar__group' }, [btnLoad, btnGenerateEmpty]),
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
						h('div', { class: 'msghub-toolbar__group' }, [btnPreview]),
						h('div', null, [elStatus]),
						h('div', null, [elPreview]),
					]),
				]),
				h('div', { class: 'msghub-bulk-step' }, [
					h('div', { class: 'msghub-bulk-step-title', text: 'Step 5: apply settings' }),
					h('div', null, [h('div', { class: 'msghub-toolbar__group' }, [btnApply])]),
				]),
			]);
		}

		return Object.freeze({ renderIngestStatesBulkApply });
	}

	win.MsghubAdminTabPluginsBulkApply = Object.freeze({ createPluginsBulkApplyApi });
})();
