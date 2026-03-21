/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const {
	readRepoFile,
	extractFunctionSource,
	runInSandbox,
} = require('./_test.utils');

describe('admin/tab/boot.js', function () {
	it('pickText resolves raw strings, i18n keys, and language maps', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const pickTextSource = extractFunctionSource(source, 'pickText');
		const sandbox = runInSandbox(
			`
${pickTextSource}
globalThis.__pickText = pickText;
`,
			{
				hasAdminKey: key => key === 'known.key',
				t: key => `T:${key}`,
				lang: 'de',
			},
			'boot-pickText.js',
		);
		const pickText = sandbox.__pickText;

		assert.equal(pickText('plain text'), 'plain text');
		assert.equal(pickText('msghub.i18n.core.sample'), 'T:msghub.i18n.core.sample');
		assert.equal(pickText('known.key'), 'T:known.key');
		assert.equal(pickText({ de: 'Hallo', en: 'Hello' }), 'Hallo');
		assert.equal(pickText({ en: 'Hello' }), 'Hello');
		assert.equal(pickText(null), '');
	});

	it('findEditableTarget picks supported editable elements only', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const findEditableTargetSource = extractFunctionSource(source, 'findEditableTarget');

		class FakeHTMLElement {
			constructor(map = {}) {
				this._map = map;
				this.isContentEditable = false;
			}
			closest(selector) {
				return this._map[selector] || null;
			}
		}
		class FakeInput extends FakeHTMLElement {
			constructor(type = 'text') {
				super();
				this.type = type;
				this.readOnly = false;
				this.disabled = false;
			}
		}
		class FakeTextArea extends FakeHTMLElement {
			constructor() {
				super();
				this.readOnly = false;
				this.disabled = false;
			}
		}

		const sandbox = runInSandbox(
			`
${findEditableTargetSource}
globalThis.__findEditableTarget = findEditableTarget;
`,
			{
				HTMLElement: FakeHTMLElement,
				HTMLInputElement: FakeInput,
				HTMLTextAreaElement: FakeTextArea,
			},
			'boot-findEditableTarget.js',
		);
		const findEditableTarget = sandbox.__findEditableTarget;

		const textInput = new FakeInput('text');
		const hostInput = new FakeHTMLElement({ input: textInput });
		assert.equal(findEditableTarget(hostInput), textInput);

		const checkboxInput = new FakeInput('checkbox');
		const hostCheckbox = new FakeHTMLElement({ input: checkboxInput });
		assert.equal(findEditableTarget(hostCheckbox), null);

		const textArea = new FakeTextArea();
		const hostTextarea = new FakeHTMLElement({ textarea: textArea });
		assert.equal(findEditableTarget(hostTextarea), textArea);

		const editable = new FakeHTMLElement({ '[contenteditable]': null });
		editable.isContentEditable = true;
		const hostContentEditable = new FakeHTMLElement({ '[contenteditable]': editable });
		assert.equal(findEditableTarget(hostContentEditable), editable);
	});

	it('selection helpers return stable metadata for input/textarea', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const selectionSource = [
			extractFunctionSource(source, 'getEditableSelectionInfo'),
			extractFunctionSource(source, 'selectAllInEditable'),
		].join('\n');

		class FakeHTMLElement {
			constructor() {
				this.focusCalls = 0;
			}
			focus() {
				this.focusCalls++;
			}
		}
		class FakeInput extends FakeHTMLElement {
			constructor(value) {
				super();
				this.value = value;
				this.selectionStart = 1;
				this.selectionEnd = 4;
				this.selectCalls = 0;
			}
			select() {
				this.selectCalls++;
			}
		}
		class FakeTextArea extends FakeInput {}

		const sandbox = runInSandbox(
			`
${selectionSource}
globalThis.__selectionFns = { getEditableSelectionInfo, selectAllInEditable };
`,
			{
				HTMLElement: FakeHTMLElement,
				HTMLInputElement: FakeInput,
				HTMLTextAreaElement: FakeTextArea,
				window: {
					getSelection: () => ({
						rangeCount: 0,
					}),
				},
				document: {
					createRange: () => ({
						selectNodeContents() {},
					}),
				},
			},
			'boot-selection.js',
		);
		const { getEditableSelectionInfo, selectAllInEditable } = sandbox.__selectionFns;

		const input = new FakeInput('abcdef');
		const info = getEditableSelectionInfo(input);
		assert.deepEqual(JSON.parse(JSON.stringify(info)), {
			hasSelection: true,
			selectedText: 'bcd',
			start: 1,
			end: 4,
		});

		selectAllInEditable(input);
		assert.equal(input.focusCalls, 1);
		assert.equal(input.selectCalls, 1);
	});

	it('uses defensive execCommand wrapper', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const execSource = extractFunctionSource(source, 'execCommandSafe');
		const sandbox = runInSandbox(
			`
${execSource}
globalThis.__execCommandSafe = execCommandSafe;
`,
			{
				document: {
					execCommand: command => command === 'copy',
				},
			},
			'boot-execCommandSafe.js',
		);
		const execCommandSafe = sandbox.__execCommandSafe;

		assert.equal(execCommandSafe('copy'), true);
		assert.equal(execCommandSafe('cut'), false);
	});

	it('keeps boot orchestration flow wired to composition + assets + panels', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		assert.match(source, /\bbuildLayoutFromRegistry\s*\(/);
		assert.match(source, /\bcomputeAssetsForComposition\s*\(/);
		assert.match(source, /\bloadCssFiles\s*\(/);
		assert.match(source, /\bloadJsFilesSequential\s*\(/);
		assert.match(source, /\binitPanelById\s*\(/);
		assert.match(source, /\binitTabs\s*\(/);
		assert.match(source, /\bmsghubSocket\.on\(\s*['"]connect['"]/);
		assert.match(source, /\bmsghubSocket\.on\(\s*['"]disconnect['"]/);
	});

	it('applies runtime.about payload to branding and timezone policy', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const applyRuntimeAboutPayloadSource = extractFunctionSource(source, 'applyRuntimeAboutPayload');
		const toasts = [];
		const warnings = [];
		const policyCalls = [];
		let branding = '';
		const sandbox = runInSandbox(
			`
let timezoneFallbackToastShown = false;
let connPanelData = {};
${applyRuntimeAboutPayloadSource}
globalThis.__applyRuntimeAboutPayload = applyRuntimeAboutPayload;
`,
			{
				isEmbeddedInAdmin: false,
				overrideLang: () => {},
				ensureAdminI18nLoaded: () => Promise.resolve(),
				applyStaticI18n: () => {},
				updateConnectionPanel: () => {},
				api: {
					time: {
						setPolicy: payload => {
							policyCalls.push(payload);
							return { isFallbackUtc: false, warning: '' };
						},
					},
					log: {
						warn: msg => warnings.push(String(msg)),
					},
				},
				ui: {
					contextMenu: {
						setBrandingText: value => {
							branding = String(value);
						},
					},
					toast: opts => toasts.push(opts && typeof opts === 'object' ? opts.text : String(opts)),
				},
				t: (key, arg) => `${key}:${arg || ''}`,
			},
			'boot-applyRuntimeAboutPayload.js',
		);
		const applyRuntimeAboutPayload = sandbox.__applyRuntimeAboutPayload;
		applyRuntimeAboutPayload({
			title: 'Message Hub',
			version: '1.2.3',
			time: { timeZone: 'Europe/Berlin', source: 'server' },
		});

		assert.equal(branding, 'Message Hub v1.2.3');
		assert.equal(policyCalls.length, 1);
		assert.equal(policyCalls[0].timeZone, 'Europe/Berlin');
		assert.equal(toasts.length, 0);
		assert.equal(warnings.length, 0);
	});

	it('shows fallback timezone warning only once', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const applyRuntimeAboutPayloadSource = extractFunctionSource(source, 'applyRuntimeAboutPayload');
		const toasts = [];
		const warnings = [];
		const sandbox = runInSandbox(
			`
let timezoneFallbackToastShown = false;
let connPanelData = {};
${applyRuntimeAboutPayloadSource}
globalThis.__applyRuntimeAboutPayload = applyRuntimeAboutPayload;
`,
			{
				isEmbeddedInAdmin: false,
				overrideLang: () => {},
				ensureAdminI18nLoaded: () => Promise.resolve(),
				applyStaticI18n: () => {},
				updateConnectionPanel: () => {},
				api: {
					time: {
						setPolicy: () => ({ isFallbackUtc: true, warning: 'timezone_fallback_utc:missing_timezone' }),
					},
					log: {
						warn: msg => warnings.push(String(msg)),
					},
				},
				ui: {
					contextMenu: { setBrandingText() {} },
					toast: opts => toasts.push(opts && typeof opts === 'object' ? opts.text : String(opts)),
				},
				t: (key, arg) => `${key}:${arg || ''}`,
			},
			'boot-timezoneFallbackOnce.js',
		);
		const applyRuntimeAboutPayload = sandbox.__applyRuntimeAboutPayload;
		applyRuntimeAboutPayload({ title: 'Message Hub', version: '1.2.3', time: {} });
		applyRuntimeAboutPayload({ title: 'Message Hub', version: '1.2.3', time: {} });

		assert.equal(toasts.length, 1);
		assert.equal(warnings.length, 1);
		assert.match(toasts[0], /timezone\.fallbackUtc\.text/);
	});

	it('overrides lang from backendTextLanguage when embedded in admin', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const applyRuntimeAboutPayloadSource = extractFunctionSource(source, 'applyRuntimeAboutPayload');
		const overrideCalls = [];
		const i18nCalls = [];
		const sandbox = runInSandbox(
			`
let timezoneFallbackToastShown = false;
let connPanelData = {};
${applyRuntimeAboutPayloadSource}
globalThis.__applyRuntimeAboutPayload = applyRuntimeAboutPayload;
`,
			{
				isEmbeddedInAdmin: true,
				overrideLang: lang => overrideCalls.push(lang),
				ensureAdminI18nLoaded: () => { i18nCalls.push(1); return Promise.resolve(); },
				applyStaticI18n: () => {},
				updateConnectionPanel: () => {},
				api: { time: { setPolicy: () => ({ isFallbackUtc: false }) }, log: { warn() {} } },
				ui: { contextMenu: { setBrandingText() {} }, toast() {} },
				t: key => key,
			},
			'boot-langOverride.js',
		);
		sandbox.__applyRuntimeAboutPayload({
			title: 'MsgHub',
			version: '0.0.3',
			time: { timeZone: 'Europe/Berlin', source: 'server' },
			lang: { backendTextLanguage: 'de', coreTextLanguage: 'de' },
		});

		assert.equal(overrideCalls.length, 1);
		assert.equal(overrideCalls[0], 'de');
		assert.equal(i18nCalls.length, 1);
	});

	it('updateConnectionPanel fills value spans from current state', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'updateConnectionPanel');

		const makeEl = () => ({ textContent: '' });
		let tzHintHidden = false;
		let tzHintAriaHidden = 'false';
		const tzHintEl = {
			classList: {
				toggle(cls, force) {
					if (cls === 'is-hidden') { tzHintHidden = force; }
				},
			},
			setAttribute(attr, val) {
				if (attr === 'aria-hidden') { tzHintAriaHidden = val; }
			},
		};
		const elMap = {
			'msghub-conn-status':       makeEl(),
			'msghub-conn-core-connection': makeEl(),
			'msghub-conn-host':         makeEl(),
			'msghub-conn-adapter':      makeEl(),
			'msghub-conn-latency':      makeEl(),
			'msghub-conn-server-tz':    makeEl(),
			'msghub-conn-core-lang':    makeEl(),
			'msghub-conn-core-fmt':     makeEl(),
			'msghub-conn-backend-lang': makeEl(),
			'msghub-conn-version':      makeEl(),
			'msghub-conn-fe-tz':        makeEl(),
			'msghub-conn-fe-lang':      makeEl(),
			'msghub-conn-fe-fmt':       makeEl(),
			'msghub-conn-tz-hint':      tzHintEl,
		};

		const sandbox = runInSandbox(
			`
let connOnline = true;
let lastPingLatencyMs = 42;
let connPanelData = {
    serverTz: 'Europe/Berlin',
    coreTextLang: 'de',
    coreFormatLocale: 'de-DE',
    backendTextLang: 'en',
    version: '1.2.3',
    coreConnectionConnected: true,
};
${fnSource}
globalThis.__fn = updateConnectionPanel;
`,
			{
				document: { getElementById: id => elMap[id] || null },
				t: (key, arg) => arg != null ? `${key}:${arg}` : key,
				msghubSocket: { url: 'http://localhost:8081', io: { uri: 'http://localhost:8081' } },
				adapterInstance: 'msghub.0',
				lang: 'de',
				navigator: { language: 'de-DE' },
				Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'UTC' }) }) },
			},
			'boot-updateConnectionPanel.js',
		);

		sandbox.__fn();

		assert.equal(elMap['msghub-conn-status'].textContent,
			'msghub.i18n.core.admin.ui.connection.panel.connected.text');
		assert.equal(elMap['msghub-conn-core-connection'].textContent,
			'msghub.i18n.core.admin.ui.connection.panel.connected.text');
		assert.equal(elMap['msghub-conn-host'].textContent, 'http://localhost:8081');
		assert.equal(elMap['msghub-conn-adapter'].textContent, 'msghub.0');
		assert.match(elMap['msghub-conn-latency'].textContent, /42/);
		assert.equal(elMap['msghub-conn-server-tz'].textContent, 'Europe/Berlin');
		assert.equal(elMap['msghub-conn-core-lang'].textContent, 'de');
		assert.equal(elMap['msghub-conn-core-fmt'].textContent, 'de-DE');
		assert.equal(elMap['msghub-conn-backend-lang'].textContent, 'en');
		assert.equal(elMap['msghub-conn-version'].textContent, '1.2.3');
		assert.equal(elMap['msghub-conn-fe-lang'].textContent, 'de');
		assert.equal(elMap['msghub-conn-fe-fmt'].textContent, 'de-DE');
		// serverTz=Europe/Berlin, browserTz=UTC → differ → hint visible (not hidden)
		assert.equal(tzHintHidden, false);
		assert.equal(tzHintAriaHidden, 'false');
	});

	it('updateConnectionPanel shows dash for null latency and hides tz-hint when TZs match', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'updateConnectionPanel');

		const makeEl = () => ({ textContent: '' });
		let tzHintHidden = false;
		let tzHintAriaHidden = 'false';
		const tzHintEl = {
			classList: {
				toggle(cls, force) {
					if (cls === 'is-hidden') { tzHintHidden = force; }
				},
			},
			setAttribute(attr, val) {
				if (attr === 'aria-hidden') { tzHintAriaHidden = val; }
			},
		};
		const elMap = {
			'msghub-conn-status':       makeEl(),
			'msghub-conn-core-connection': makeEl(),
			'msghub-conn-host':         makeEl(),
			'msghub-conn-adapter':      makeEl(),
			'msghub-conn-latency':      makeEl(),
			'msghub-conn-server-tz':    makeEl(),
			'msghub-conn-core-lang':    makeEl(),
			'msghub-conn-core-fmt':     makeEl(),
			'msghub-conn-backend-lang': makeEl(),
			'msghub-conn-version':      makeEl(),
			'msghub-conn-fe-tz':        makeEl(),
			'msghub-conn-fe-lang':      makeEl(),
			'msghub-conn-fe-fmt':       makeEl(),
			'msghub-conn-tz-hint':      tzHintEl,
		};

		const sandbox = runInSandbox(
			`
let connOnline = false;
let lastPingLatencyMs = null;
let connPanelData = {
    serverTz: 'Europe/Berlin',
    coreTextLang: '',
    coreFormatLocale: '',
    backendTextLang: '',
    version: '',
    coreConnectionConnected: false
};
${fnSource}
globalThis.__fn = updateConnectionPanel;
`,
			{
				document: { getElementById: id => elMap[id] || null },
				t: key => key,
				msghubSocket: null,
				adapterInstance: null,
				lang: 'en',
				navigator: { language: 'en-US' },
				Intl: { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/Berlin' }) }) },
			},
			'boot-updateConnectionPanel-dash.js',
		);

		sandbox.__fn();

		assert.equal(elMap['msghub-conn-latency'].textContent, '—');
		assert.equal(elMap['msghub-conn-core-connection'].textContent,
			'msghub.i18n.core.admin.ui.connection.panel.disconnected.text');
		assert.equal(elMap['msghub-conn-host'].textContent, '—');
		assert.equal(elMap['msghub-conn-adapter'].textContent, '—');
		// serverTz=Europe/Berlin, browserTz=Europe/Berlin → same → hint hidden
		assert.equal(tzHintHidden, true);
		assert.equal(tzHintAriaHidden, 'true');
	});

	it('applyRuntimeAboutPayload populates connPanelData and calls updateConnectionPanel', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'applyRuntimeAboutPayload');
		const panelUpdates = [];

		const sandbox = runInSandbox(
			`
let timezoneFallbackToastShown = false;
let connPanelData = {};
${fnSource}
globalThis.__fn = applyRuntimeAboutPayload;
globalThis.__connPanelData = () => connPanelData;
`,
			{
				isEmbeddedInAdmin: false,
				overrideLang: () => {},
				ensureAdminI18nLoaded: () => Promise.resolve(),
				applyStaticI18n: () => {},
				updateConnectionPanel: () => panelUpdates.push(1),
				api: { time: { setPolicy: () => ({ isFallbackUtc: false }) }, log: { warn() {} } },
				ui: { contextMenu: { setBrandingText() {} }, toast() {} },
				t: key => key,
			},
			'boot-connPanelData.js',
		);

		sandbox.__fn({
			title: 'MsgHub',
			version: '1.2.3',
			time: { timeZone: 'Europe/Berlin', source: 'server' },
			connection: { scope: 'core-link', connected: true, mode: 'local' },
			lang: { coreTextLanguage: 'de', coreFormatLocale: 'de-DE', backendTextLanguage: 'en' },
		});

		const data = sandbox.__connPanelData();
		assert.equal(data.serverTz, 'Europe/Berlin');
		assert.equal(data.coreTextLang, 'de');
		assert.equal(data.coreFormatLocale, 'de-DE');
		assert.equal(data.backendTextLang, 'en');
		assert.equal(data.version, '1.2.3');
		assert.equal(data.coreConnectionConnected, true);
		assert.equal(panelUpdates.length, 1);
	});

	it('sendPing stores RTT on success and clears it on failure', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		// extractFunctionSource starts at 'function', stripping 'async' — prepend it back
		const fnSource = 'async ' + extractFunctionSource(source, 'sendPing');

		// Success path
		const onlineCalls = [];
		const sbSuccess = runInSandbox(
			`
let pingToken = 0;
let connOnline = false;
let lastPingLatencyMs = null;
const PING_TIMEOUT_MS = 5000;
${fnSource}
globalThis.__sendPing = sendPing;
globalThis.__getLatency = () => lastPingLatencyMs;
`,
			{
				msghubRequest: () => Promise.resolve({ ok: true }),
				onBecomeOnline: () => onlineCalls.push(1),
				onBecomeOffline: () => {},
				updateConnectionPanel: () => {},
				Promise,
				setTimeout,
				clearTimeout,
				Date,
			},
			'boot-sendPing-success.js',
		);

		await sbSuccess.__sendPing();
		assert.ok(sbSuccess.__getLatency() != null, 'RTT should be stored after successful ping');
		assert.ok(sbSuccess.__getLatency() >= 0, 'RTT should be non-negative');
		assert.equal(onlineCalls.length, 1);

		// Failure path
		const offlineCalls = [];
		const sbFail = runInSandbox(
			`
let pingToken = 0;
let connOnline = true;
let lastPingLatencyMs = 50;
const PING_TIMEOUT_MS = 5000;
${fnSource}
globalThis.__sendPing = sendPing;
globalThis.__getLatency = () => lastPingLatencyMs;
`,
			{
				msghubRequest: () => Promise.reject(new Error('fail')),
				onBecomeOnline: () => {},
				onBecomeOffline: () => offlineCalls.push(1),
				updateConnectionPanel: () => {},
				Promise,
				setTimeout,
				clearTimeout,
				Date,
			},
			'boot-sendPing-fail.js',
		);

		await sbFail.__sendPing();
		assert.equal(sbFail.__getLatency(), null, 'RTT should be cleared on ping failure');
		assert.equal(offlineCalls.length, 1);
	});

	it('initConnectionPanelInteraction registers hover, touch, and outside-click handlers', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'initConnectionPanelInteraction');

		assert.match(fnSource, /pill\.addEventListener\(\s*['"]mouseenter['"]/);
		assert.match(fnSource, /pill\.addEventListener\(\s*['"]mouseleave['"]/);
		assert.match(fnSource, /panel\.addEventListener\(\s*['"]mouseenter['"]/);
		assert.match(fnSource, /panel\.addEventListener\(\s*['"]mouseleave['"]/);
		assert.match(fnSource, /trigger\.addEventListener\(\s*['"]touchstart['"]/);
		assert.match(fnSource, /document\.addEventListener\(\s*['"]click['"]/);
		assert.match(fnSource, /setPanelOpen/);
		assert.match(fnSource, /updateConnectionPanel\s*\(/);
	});

	it('hydratePluginPanels enables tab for matching contribution and registers entry in tabMap', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		// extractFunctionSource starts at 'function', stripping 'async' — prepend it back.
		const fnSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');

		const removedAttrs = [];
		const removedClasses = [];
		let tabLabel = '';
		const tabEl = {
			removeAttribute: attr => removedAttrs.push(attr),
			classList: { remove: cls => removedClasses.push(cls) },
			get textContent() {
				return tabLabel;
			},
			set textContent(v) {
				tabLabel = v;
			},
		};
		const container = { id: 'plugin-IngestStates-0-presets' };

		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${fnSource}
globalThis.__fn = hydratePluginPanels;
globalThis.__map = pluginPanelTabMap;
`,
			{
				msghubRequest: () =>
					Promise.resolve({
						data: [
							{
								pluginType: 'IngestStates',
								instanceId: 0,
								panelId: 'presets',
								title: { en: 'Presets', de: 'Vorlagen' },
								bundle: { hash: 'abc123' },
							},
						],
					}),
				document: {
					getElementById: id => (id === 'plugin-IngestStates-0-presets' ? container : null),
					querySelector: () => tabEl,
				},
				api: { i18n: { pickText: v => (v && typeof v === 'object' ? v.en || '' : String(v || '')) } },
				Promise,
			},
			'boot-hydrate-happy.js',
		);

		const ref = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		const enabledTabIds = await sandbox.__fn([ref], {}, null);

		assert.deepEqual(JSON.parse(JSON.stringify(enabledTabIds)), ['tab-plugin-IngestStates-0-presets']);
		assert.ok(removedAttrs.includes('aria-disabled'), 'aria-disabled must be removed from enabled tab');
		assert.ok(removedClasses.includes('is-disabled'), 'is-disabled class must be removed from enabled tab');
		assert.equal(tabLabel, 'Presets', 'tab text must be updated from contribution title');
		assert.ok(sandbox.__map.has('tab-plugin-IngestStates-0-presets'), 'entry must be registered in pluginPanelTabMap');
		const entry = sandbox.__map.get('tab-plugin-IngestStates-0-presets');
		assert.equal(entry.hash, 'abc123');
		assert.equal(entry.mountHandle, null);
	});

	it('hydratePluginPanels: wrong instanceId — no match, slot stays disabled, enabledTabIds empty', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		// extractFunctionSource starts at 'function', stripping 'async' — prepend it back.
		const fnSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');

		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${fnSource}
globalThis.__fn = hydratePluginPanels;
globalThis.__map = pluginPanelTabMap;
`,
			{
				msghubRequest: () =>
					Promise.resolve({
						data: [
							// instanceId: 99 does not match ref.instanceId: 0
							{ pluginType: 'IngestStates', instanceId: 99, panelId: 'presets', title: { en: 'Presets' }, bundle: { hash: 'x' } },
						],
					}),
				document: { getElementById: () => ({}), querySelector: () => null },
				api: { i18n: { pickText: v => String(v || '') } },
				Promise,
			},
			'boot-hydrate-wrong-id.js',
		);

		const ref = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		const enabledTabIds = await sandbox.__fn([ref], {}, null);

		assert.deepEqual(JSON.parse(JSON.stringify(enabledTabIds)), [], 'wrong instanceId must produce no match');
		assert.equal(sandbox.__map.size, 0, 'tabMap must remain empty on no match');
	});

	it('hydratePluginPanels: empty discover response — all slots disabled, no crash', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		// extractFunctionSource starts at 'function', stripping 'async' — prepend it back.
		const fnSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');

		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${fnSource}
globalThis.__fn = hydratePluginPanels;
`,
			{
				msghubRequest: () => Promise.resolve({ data: [] }),
				document: { getElementById: () => null, querySelector: () => null },
				api: { i18n: { pickText: () => '' } },
				Promise,
			},
			'boot-hydrate-empty.js',
		);

		const ref = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		const enabledTabIds = await sandbox.__fn([ref], {}, null);

		assert.deepEqual(JSON.parse(JSON.stringify(enabledTabIds)), [], 'empty discover must leave all slots disabled');
	});

	it('hydratePluginPanels: discover failure — all slots disabled, no crash', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		// extractFunctionSource starts at 'function', stripping 'async' — prepend it back.
		const fnSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');

		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${fnSource}
globalThis.__fn = hydratePluginPanels;
`,
			{
				msghubRequest: () => Promise.reject(new Error('network error')),
				document: { getElementById: () => null, querySelector: () => null },
				api: { i18n: { pickText: () => '' } },
				Promise,
			},
			'boot-hydrate-fail.js',
		);

		const ref = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		// Must not throw even on network failure.
		const enabledTabIds = await sandbox.__fn([ref], {}, null);

		assert.deepEqual(JSON.parse(JSON.stringify(enabledTabIds)), [], 'discover failure must leave all slots disabled without crashing');
	});

	it('boot.js wires plugin panel lifecycle: discover hydration, spinner, activation, lazy-load', async function () {
		const source = await readRepoFile('admin/tab/boot.js');

		// Discover hydration is wired.
		assert.match(source, /\bhydratePluginPanels\s*\(/, 'hydratePluginPanels must be called');
		assert.match(source, /['"]admin\.pluginUi\.discover['"]/, 'admin.pluginUi.discover must be used');

		// Spinner is shown only for plugin-only compositions (initial === null).
		assert.match(source, /const needsSpinner = initialTabId === null/, 'spinner condition must be initialTabId === null');
		assert.match(source, /ui\?\.spinner\?\.show\?\./, 'blocking spinner must be shown in plugin-only path');
		assert.match(source, /ui\?\.spinner\?\.hide\?\./, 'spinner must be hidden after activation');

		// Post-hydration activation logic present for both paths.
		assert.match(source, /enabledTabIds\.includes\(wantedTabId\)/, 'defaultPanel activation must check enabledTabIds');

		// Persistent toast when all plugin panels unavailable.
		assert.match(source, /persist:\s*true/, 'persistent toast must be shown when no panels available');

		// Lazy-load wired via msghub:tabSwitch.
		assert.match(source, /['"]msghub:tabSwitch['"]/, 'lazy-load must listen to msghub:tabSwitch');
		assert.match(source, /pluginPanelTabMap\.get\(/, 'lazy-load must look up entry in pluginPanelTabMap');
		assert.match(source, /pluginUiHost\.mount\s*\(/, 'lazy-load must call pluginUiHost.mount');

		// ingestStates warmup must be gone.
		assert.doesNotMatch(source, /ingestStates\s*\?\s*\.constants/, 'ingestStates warmup must be removed from boot');
	});

	it('mixed composition defaultPanel: tabSetActive called when defaultPanel is a hydrated plugin tab', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');

		// Extract the else-branch (mixed-composition activation) from production source.
		// The anchor `tabSetActive(wantedTabId)` is unique to this branch (the spinner branch uses chosenTabId).
		const anchor = 'tabSetActive(wantedTabId)';
		const anchorPos = source.indexOf(anchor);
		assert.ok(anchorPos >= 0, 'mixed-composition else-branch must exist in boot.js');
		const beforeAnchor = source.slice(0, anchorPos);
		const elseStart = source.indexOf('{', beforeAnchor.lastIndexOf('} else {'));
		assert.ok(elseStart >= 0, 'else-branch opening brace must be found');

		// Simple brace counter — all braces in this block are balanced (including ${...} in template literals).
		let depth = 0;
		let elseEnd = -1;
		for (let i = elseStart; i < source.length; i++) {
			if (source[i] === '{') depth++;
			else if (source[i] === '}') {
				depth--;
				if (depth === 0) {
					elseEnd = i;
					break;
				}
			}
		}
		assert.ok(elseEnd > elseStart, 'else-branch closing brace must be found');
		const elseBody = source.slice(elseStart + 1, elseEnd);

		// Behavioral: run hydratePluginPanels from source, then run the extracted else-branch.
		// This covers the full mixed-composition path: native panel active pre-hydration,
		// defaultPanel points to the plugin tab, post-hydration switch activates it.
		const activatedIds = [];
		const container = {};
		const tabEl = {
			removeAttribute: () => {},
			classList: { remove: () => {} },
			querySelector: () => null,
		};
		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${fnSource}
globalThis.__test = async function() {
	const enabledTabIds = await hydratePluginPanels(
		[{ pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' }],
		{},
		null,
	);
	const defaultPanelId = 'plugin-IngestStates-0-presets';
	${elseBody}
	return enabledTabIds;
};`,
			{
				msghubRequest: () =>
					Promise.resolve({
						data: [
							{
								pluginType: 'IngestStates',
								instanceId: 0,
								panelId: 'presets',
								title: { en: 'Presets' },
								bundle: { hash: 'h1' },
							},
						],
					}),
				document: {
					getElementById: id => (id === 'plugin-IngestStates-0-presets' ? container : null),
					querySelector: () => tabEl,
				},
				api: { i18n: { pickText: v => (v && typeof v === 'object' ? v.en || '' : String(v || '')) } },
				tabSetActive: id => activatedIds.push(id),
				Promise,
			},
			'boot-mixed-defaultPanel.js',
		);

		await sandbox.__test();

		assert.deepEqual(
			activatedIds,
			['tab-plugin-IngestStates-0-presets'],
			'tabSetActive must be called with the plugin defaultPanel tab ID in mixed composition',
		);
	});

	it('does not override lang when not embedded in admin', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const applyRuntimeAboutPayloadSource = extractFunctionSource(source, 'applyRuntimeAboutPayload');
		const overrideCalls = [];
		const sandbox = runInSandbox(
			`
let timezoneFallbackToastShown = false;
let connPanelData = {};
${applyRuntimeAboutPayloadSource}
globalThis.__applyRuntimeAboutPayload = applyRuntimeAboutPayload;
`,
			{
				isEmbeddedInAdmin: false,
				overrideLang: lang => overrideCalls.push(lang),
				ensureAdminI18nLoaded: () => Promise.resolve(),
				applyStaticI18n: () => {},
				updateConnectionPanel: () => {},
				api: { time: { setPolicy: () => ({ isFallbackUtc: false }) }, log: { warn() {} } },
				ui: { contextMenu: { setBrandingText() {} }, toast() {} },
				t: key => key,
			},
			'boot-langOverrideSkip.js',
		);
		sandbox.__applyRuntimeAboutPayload({
			title: 'MsgHub',
			version: '0.0.3',
			time: { timeZone: 'Europe/Berlin', source: 'server' },
			lang: { backendTextLanguage: 'de', coreTextLanguage: 'de' },
		});

		assert.equal(overrideCalls.length, 0);
	});
});
