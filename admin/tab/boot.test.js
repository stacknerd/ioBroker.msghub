/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const {
	readRepoFile,
	extractFunctionSource,
	runInSandbox,
	createStorage,
} = require('./_test.utils');

describe('admin/tab/boot.js', function () {
	it('pickText resolves raw strings, i18n keys, and language maps', async function () {
		const source = await readRepoFile('admin/tab/runtime.js');
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
		assert.match(source, /\bloadCorePanelEntry\s*\(/);
		assert.match(source, /\bloadCssFiles\s*\(/);
		assert.match(source, /\bloadJsFilesSequential\s*\(/);
		assert.match(source, /\binitPanelById\s*\(/);
		assert.match(source, /\binitTabs\s*\(/);
		assert.match(source, /\bmsghubSocket\.on\(\s*['"]connect['"]/);
		assert.match(source, /\bmsghubSocket\.on\(\s*['"]disconnect['"]/);
		assert.match(source, /visibilitychange/);
		assert.match(source, /pageshow/);
	});

	it('routes late critical boot failures through the shell-level hard-reload helper', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		assert.match(source, /function maybeHardReloadForLateCriticalBootFailure\(_reason\)/);
		assert.match(source, /Failed to load CSS:[\s\S]*maybeHardReloadForLateCriticalBootFailure\(`css:/);
		assert.match(source, /renderPanelBootError\(panelId, err\);[\s\S]*maybeHardReloadForLateCriticalBootFailure\(`panel-js:/);
		assert.match(source, /renderPanelBootError\(panelId, err\);[\s\S]*maybeHardReloadForLateCriticalBootFailure\(`panel-init:/);
		assert.match(source, /catch\(err => \{[\s\S]*maybeHardReloadForLateCriticalBootFailure\('boot-catch'\)/);
	});

	it('keeps view resolution delegated to shared layout helpers and backend view loading', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		assert.match(source, /\bresolveViewRequest\s*\(/);
		assert.match(source, /web\.view\.get/);
		assert.match(source, /\bsetActiveView\s*\(/);
		assert.match(source, /\bgetActiveComposition\s*\(/);
		assert.doesNotMatch(source, /data-msghub-view/);
	});

	it('applies ui.bootstrap.about payload to branding and timezone policy', async function () {
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
				msghubRequest: () => Promise.resolve([]),
				mergePluginI18n: () => {},
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
				msghubRequest: () => Promise.resolve([]),
				mergePluginI18n: () => {},
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
		const mergeCalls = [];
		const sandbox = runInSandbox(
			`
let timezoneFallbackToastShown = false;
let connPanelData = {};
${applyRuntimeAboutPayloadSource}
globalThis.__applyRuntimeAboutPayload = applyRuntimeAboutPayload;
`,
			{
				isEmbeddedInAdmin: true,
				lang: 'de',
				overrideLang: lang => overrideCalls.push(lang),
				ensureAdminI18nLoaded: () => { i18nCalls.push(1); return Promise.resolve(); },
				msghubRequest: () => Promise.resolve([]),
				mergePluginI18n: (pluginType, translations) => mergeCalls.push({ pluginType, translations }),
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
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepEqual(mergeCalls, []);
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
			'msghub-conn-transport':    makeEl(),
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
				transport: 'socket',
				msghubSocket: { url: 'http://localhost:8081', io: { uri: 'http://localhost:8081' } },
				adapterInstance: 'msghub.0',
				args: {},
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
		assert.equal(elMap['msghub-conn-transport'].textContent, 'socket');
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

	it('updateConnectionPanel shows the effective frontend format locale after a valid URL override', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'updateConnectionPanel');

		const makeEl = () => ({ textContent: '' });
		const elMap = {
			'msghub-conn-status':       makeEl(),
			'msghub-conn-core-connection': makeEl(),
			'msghub-conn-transport':    makeEl(),
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
			'msghub-conn-tz-hint': {
				classList: { toggle() {} },
				setAttribute() {},
			},
		};

		const sandbox = runInSandbox(
			`
let connOnline = true;
let lastPingLatencyMs = null;
let connPanelData = {};
${fnSource}
globalThis.__fn = updateConnectionPanel;
`,
			{
				document: { getElementById: id => elMap[id] || null },
				t: key => key,
				msghubSocket: null,
				adapterInstance: 'msghub.0',
				args: { locale: 'de-DE', transport: 'http' },
				lang: 'en',
				navigator: { language: 'en-US' },
				Intl: {
					DateTimeFormat: function (locale) {
						return {
						resolvedOptions: () => ({
							timeZone: 'UTC',
							locale: locale || 'en-US',
						}),
						};
					},
				},
			},
			'boot-updateConnectionPanel-localeOverride.js',
		);

		sandbox.__fn();
		assert.equal(elMap['msghub-conn-transport'].textContent, 'http');
		assert.equal(elMap['msghub-conn-fe-fmt'].textContent, 'de-DE');
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
			'msghub-conn-transport':    makeEl(),
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
				transport: 'socket',
				msghubSocket: null,
				adapterInstance: null,
				args: {},
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
		assert.equal(elMap['msghub-conn-transport'].textContent, 'socket');
		assert.equal(elMap['msghub-conn-host'].textContent, '—');
		assert.equal(elMap['msghub-conn-adapter'].textContent, '—');
		// serverTz=Europe/Berlin, browserTz=Europe/Berlin → same → hint hidden
		assert.equal(tzHintHidden, true);
		assert.equal(tzHintAriaHidden, 'true');
	});

	it('uses the static transport row from admin/tab.html and no longer injects it dynamically', async function () {
		const bootSource = await readRepoFile('admin/tab/boot.js');
		const htmlSource = await readRepoFile('admin/tab.html');

		assert.doesNotMatch(bootSource, /ensureConnectionPanelTransportRow/);
		assert.match(htmlSource, /msghub\.i18n\.core\.admin\.ui\.connection\.panel\.field\.transport/);
		assert.match(htmlSource, /id="msghub-conn-transport"/);
	});

	it('applyStaticI18n() refreshes the document title after translating visible text', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const applyStaticI18nSource = extractFunctionSource(source, 'applyStaticI18n');
		const updateDocumentTitleCalls = [];
		const i18nElements = [{ getAttribute: () => 'msghub.i18n.core.sample', textContent: '' }];
		const sandbox = runInSandbox(
			`
${applyStaticI18nSource}
globalThis.__applyStaticI18n = applyStaticI18n;
`,
			{
				t: key => `T:${key}`,
				updateDocumentTitle: () => updateDocumentTitleCalls.push(1),
				document: { querySelectorAll: () => i18nElements },
			},
			'boot-applyStaticI18n.js',
		);

		sandbox.__applyStaticI18n();
		assert.equal(updateDocumentTitleCalls.length, 1, 'applyStaticI18n must refresh the document title once');
		assert.equal(i18nElements[0].textContent, 'T:msghub.i18n.core.sample');
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

	it('sendPing starts reconnect recovery when health checks fail while already offline', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = 'async ' + extractFunctionSource(source, 'sendPing');
		const recoveryReasons = [];
		const sandbox = runInSandbox(
			`
let pingToken = 0;
let connOnline = false;
let lastPingLatencyMs = 50;
const PING_TIMEOUT_MS = 5000;
${fnSource}
globalThis.__sendPing = sendPing;
globalThis.__getLatency = () => lastPingLatencyMs;
`,
			{
				msghubRequest: () => Promise.reject(new Error('fail')),
				onBecomeOnline: () => {},
				onBecomeOffline: () => {},
				startReconnectRecovery: reason => recoveryReasons.push(String(reason)),
				updateConnectionPanel: () => {},
				Promise,
				setTimeout,
				clearTimeout,
				Date,
			},
			'boot-sendPing-offline-recovery.js',
		);

		await sandbox.__sendPing();
		assert.equal(sandbox.__getLatency(), null, 'RTT should be cleared on ping failure');
		assert.deepEqual(recoveryReasons, ['ping-failure']);
	});

	it('attemptSocketReconnect actively reconnects a disconnected socket', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'attemptSocketReconnect');
		let connectCalls = 0;
		const sandbox = runInSandbox(
			`
${fnSource}
globalThis.__fn = attemptSocketReconnect;
`,
			{
				msghubSocket: {
					connected: false,
					connect: () => {
						connectCalls++;
					},
				},
			},
			'boot-attemptSocketReconnect.js',
		);

		assert.equal(sandbox.__fn(), true);
		assert.equal(connectCalls, 1);
	});

	it('getReconnectRecoveryDelay returns bounded progressive backoff', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'getReconnectRecoveryDelay');
		const sandbox = runInSandbox(
			`
const RECONNECT_RECOVERY_DELAYS_MS = Object.freeze([1000, 4000, 10000]);
const RECONNECT_RECOVERY_MAX_DELAY_MS = 15000;
${fnSource}
globalThis.__fn = getReconnectRecoveryDelay;
`,
			{
				Math,
				Number,
				Object,
			},
			'boot-getReconnectRecoveryDelay.js',
		);

		assert.equal(sandbox.__fn(0), 1000);
		assert.equal(sandbox.__fn(1), 4000);
		assert.equal(sandbox.__fn(2), 10000);
		assert.equal(sandbox.__fn(99), 15000);
	});

	it('startReconnectRecovery keeps restart and dedupe guards in the source contract', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		assert.match(source, /function startReconnectRecovery\(reason, options = \{\}\)/);
		assert.match(source, /options\.restart === true/);
		assert.match(source, /reconnectRecoveryTimer != null/);
		assert.match(source, /runReconnectRecoveryStep\(normalizedReason\)/);
	});

	it('requestResumeRecovery debounces clustered resume events and restarts the runner', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'requestResumeRecovery');
		let now = 1000;
		const starts = [];
		const sandbox = runInSandbox(
			`
let lastResumeRecoveryAt = 0;
const RESUME_RECOVERY_DEBOUNCE_MS = 750;
${fnSource}
globalThis.__fn = requestResumeRecovery;
`,
			{
				Date: { now: () => now },
				startReconnectRecovery: (reason, options) => starts.push([String(reason), options?.restart === true]),
			},
			'boot-requestResumeRecovery.js',
		);

		sandbox.__fn('visibilitychange');
		sandbox.__fn('pageshow');
		now = 2000;
		sandbox.__fn('pageshow');

		assert.deepEqual(starts, [
			['visibilitychange', true],
			['pageshow', true],
		]);
	});

	it('markShellHealthy stores the first healthy timestamp and clears the session reload guard', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'markShellHealthy');
		const localStorage = createStorage();
		const sessionStorage = createStorage({
			'msghub.adminTab.criticalBootReloadUsed': '1',
		});
		let now = 123456;
		const sandbox = runInSandbox(
			`
let healthyShellSinceMs = 0;
let healthyShellMarked = false;
const HEALTHY_SHELL_SINCE_STORAGE_KEY = 'msghub.adminTab.healthyShellSince';
const CRITICAL_BOOT_RELOAD_USED_SESSION_KEY = 'msghub.adminTab.criticalBootReloadUsed';
${fnSource}
globalThis.__fn = markShellHealthy;
globalThis.__state = () => ({ healthyShellSinceMs, healthyShellMarked });
`,
			{
				Date: { now: () => now },
				hasCriticalBootFailure: () => false,
				window: { localStorage, sessionStorage },
			},
			'boot-markShellHealthy.js',
		);

		sandbox.__fn();
		now = 999999;
		sandbox.__fn();

		assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__state())), {
			healthyShellSinceMs: 123456,
			healthyShellMarked: true,
		});
		assert.equal(localStorage.getItem('msghub.adminTab.healthyShellSince'), '123456');
		assert.equal(sessionStorage.getItem('msghub.adminTab.criticalBootReloadUsed'), null);
	});

	it('maybeHardReloadForLateCriticalBootFailure reloads once after a healthy shell older than three minutes', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'maybeHardReloadForLateCriticalBootFailure');
		const localStorage = createStorage({
			'msghub.adminTab.healthyShellSince': String(500000 - (3 * 60 * 1000 + 1)),
		});
		const sessionStorage = createStorage();
		let reloadCalls = 0;
		const sandbox = runInSandbox(
			`
let healthyShellSinceMs = 0;
const CRITICAL_BOOT_RELOAD_MIN_AGE_MS = 3 * 60_000;
const HEALTHY_SHELL_SINCE_STORAGE_KEY = 'msghub.adminTab.healthyShellSince';
const CRITICAL_BOOT_RELOAD_USED_SESSION_KEY = 'msghub.adminTab.criticalBootReloadUsed';
${fnSource}
globalThis.__fn = maybeHardReloadForLateCriticalBootFailure;
globalThis.__state = () => ({ healthyShellSinceMs });
`,
			{
				Date: { now: () => 500000 },
				hasCriticalBootFailure: () => true,
				window: {
					localStorage,
					sessionStorage,
					location: {
						reload: () => {
							reloadCalls++;
						},
					},
				},
			},
			'boot-maybeHardReloadForLateCriticalBootFailure-aged.js',
		);

		assert.equal(sandbox.__fn('panel-init:messages'), true);
		assert.equal(sandbox.__fn('panel-init:messages'), false);
		assert.equal(reloadCalls, 1);
		assert.equal(sessionStorage.getItem('msghub.adminTab.criticalBootReloadUsed'), '1');
		assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__state())), {
			healthyShellSinceMs: 319999,
		});
	});

	it('maybeHardReloadForLateCriticalBootFailure stays inactive before the three-minute gate', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'maybeHardReloadForLateCriticalBootFailure');
		const localStorage = createStorage({
			'msghub.adminTab.healthyShellSince': String(600000 - 179999),
		});
		const sessionStorage = createStorage();
		let reloadCalls = 0;
		const sandbox = runInSandbox(
			`
let healthyShellSinceMs = 0;
const CRITICAL_BOOT_RELOAD_MIN_AGE_MS = 3 * 60_000;
const HEALTHY_SHELL_SINCE_STORAGE_KEY = 'msghub.adminTab.healthyShellSince';
const CRITICAL_BOOT_RELOAD_USED_SESSION_KEY = 'msghub.adminTab.criticalBootReloadUsed';
${fnSource}
globalThis.__fn = maybeHardReloadForLateCriticalBootFailure;
globalThis.__state = () => ({ healthyShellSinceMs });
`,
			{
				Date: { now: () => 600000 },
				hasCriticalBootFailure: () => true,
				window: {
					localStorage,
					sessionStorage,
					location: {
						reload: () => {
							reloadCalls++;
						},
					},
				},
			},
			'boot-maybeHardReloadForLateCriticalBootFailure-young.js',
		);

		assert.equal(sandbox.__fn('css:tab/table.css'), false);
		assert.equal(reloadCalls, 0);
		assert.equal(sessionStorage.getItem('msghub.adminTab.criticalBootReloadUsed'), null);
		assert.deepEqual(JSON.parse(JSON.stringify(sandbox.__state())), {
			healthyShellSinceMs: 420001,
		});
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
		const renderSource = extractFunctionSource(source, 'renderPluginPanelTabLabel');
		// extractFunctionSource starts at 'function', stripping 'async' — prepend it back.
		const fnSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');

		const removedAttrs = [];
		const removedClasses = [];
		const setAttrs = [];
		let tabLabel = '';
		const tabEl = {
			removeAttribute: attr => removedAttrs.push(attr),
			classList: { remove: cls => removedClasses.push(cls) },
			setAttribute: (name, value) => setAttrs.push([name, value]),
			get textContent() {
				return tabLabel;
			},
			set textContent(v) {
				tabLabel = v;
			},
		};
		const container = { id: 'plugin-IngestStates-0-presets' };

		const registeredDescriptors = [];
		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${renderSource}
${fnSource}
globalThis.__fn = hydratePluginPanels;
globalThis.__map = pluginPanelTabMap;
`,
			{
				lang: 'en',
				hasAdminKey: key => key === 'msghub.i18n.IngestStates.ui.panels.presets.label',
				document: {
					getElementById: id => (id === 'plugin-IngestStates-0-presets' ? container : null),
					querySelector: () => tabEl,
				},
				t: key => (key === 'msghub.i18n.IngestStates.ui.panels.presets.label' ? 'Presets' : String(key || '')),
				applyCategoryMarker: () => {},
				normalizePluginPanel: (panelDef, ref) => ({
					id: `tab-plugin-${ref.pluginType}-${ref.instanceId}-${ref.panelId}`,
					label: panelDef.label,
					ui: { kind: 'plugin', loader: 'esm' },
				}),
				registerPanelDescriptor: d => registeredDescriptors.push(d),
				Promise,
			},
			'boot-hydrate-happy.js',
		);

		const ref = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		const enabledTabIds = await sandbox.__fn([ref], {}, {
			'plugin-IngestStates-0-presets': {
				id: 'plugin-IngestStates-0-presets',
				label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
				ui: {
					kind: 'plugin',
					loader: 'esm',
					bundle: { hash: 'abc123' },
				},
			},
		});

		assert.deepEqual(JSON.parse(JSON.stringify(enabledTabIds)), ['tab-plugin-IngestStates-0-presets']);
		assert.ok(removedAttrs.includes('aria-disabled'), 'aria-disabled must be removed from enabled tab');
		assert.ok(removedClasses.includes('is-disabled'), 'is-disabled class must be removed from enabled tab');
		assert.deepEqual(setAttrs, [['data-i18n', 'msghub.i18n.IngestStates.ui.panels.presets.label']]);
		assert.equal(tabLabel, 'Presets', 'tab text must be translated from the contribution i18n key');
		assert.ok(sandbox.__map.has('tab-plugin-IngestStates-0-presets'), 'entry must be registered in pluginPanelTabMap');
		const entry = sandbox.__map.get('tab-plugin-IngestStates-0-presets');
		assert.equal(entry.hash, 'abc123');
		assert.equal(entry.mountHandle, null);
		// Etappe 2 extension: descriptor must be registered for the enabled panel.
		assert.equal(registeredDescriptors.length, 1, 'registerPanelDescriptor must be called once');
		assert.equal(registeredDescriptors[0].id, 'tab-plugin-IngestStates-0-presets');
	});

	it('hydratePluginPanels: missing pluginPanels entry leaves the slot unresolved', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const renderSource = extractFunctionSource(source, 'renderPluginPanelTabLabel');
		// extractFunctionSource starts at 'function', stripping 'async' — prepend it back.
		const fnSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');

		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${renderSource}
${fnSource}
globalThis.__fn = hydratePluginPanels;
globalThis.__map = pluginPanelTabMap;
`,
			{
				lang: 'en',
				document: { getElementById: () => ({}), querySelector: () => null },
				t: key => String(key || ''),
				normalizePluginPanel: () => ({}),
				registerPanelDescriptor: () => {},
				Promise,
			},
			'boot-hydrate-wrong-id.js',
		);

		const ref = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		const enabledTabIds = await sandbox.__fn([ref], {}, {});

		assert.deepEqual(JSON.parse(JSON.stringify(enabledTabIds)), [], 'missing pluginPanels entry must produce no match');
		assert.equal(sandbox.__map.size, 0, 'tabMap must remain empty on no match');
	});

	it('hydratePluginPanels: empty pluginPanels map leaves all slots unresolved without crashing', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const renderSource = extractFunctionSource(source, 'renderPluginPanelTabLabel');
		// extractFunctionSource starts at 'function', stripping 'async' — prepend it back.
		const fnSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');

		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${renderSource}
${fnSource}
globalThis.__fn = hydratePluginPanels;
`,
			{
				lang: 'en',
				document: { getElementById: () => null, querySelector: () => null },
				t: () => '',
				normalizePluginPanel: () => ({}),
				registerPanelDescriptor: () => {},
				Promise,
			},
			'boot-hydrate-empty.js',
		);

		const ref = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		const enabledTabIds = await sandbox.__fn([ref], {}, {});

		assert.deepEqual(JSON.parse(JSON.stringify(enabledTabIds)), [], 'empty pluginPanels map must leave all slots unresolved');
	});

	it('hydratePluginPanels: missing active view pluginPanels does not crash', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const renderSource = extractFunctionSource(source, 'renderPluginPanelTabLabel');
		// extractFunctionSource starts at 'function', stripping 'async' — prepend it back.
		const fnSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');

		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${renderSource}
${fnSource}
globalThis.__fn = hydratePluginPanels;
`,
			{
				document: { getElementById: () => null, querySelector: () => null },
				t: () => '',
				normalizePluginPanel: () => ({}),
				registerPanelDescriptor: () => {},
				Promise,
			},
			'boot-hydrate-fail.js',
		);

		const ref = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		const enabledTabIds = await sandbox.__fn([ref], {}, null);

		assert.deepEqual(JSON.parse(JSON.stringify(enabledTabIds)), [], 'missing active view pluginPanels must leave all slots unresolved');
	});

	it('hydratePluginPanels: contrib.app flows through normalizePluginPanel to registered descriptor', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const renderSource = extractFunctionSource(source, 'renderPluginPanelTabLabel');
		const fnSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');

		const app = { name: 'msghub.i18n.some.app.label', url: 'https://example.com' };
		const tabId = 'tab-plugin-IngestStates-0-presets';
		const registeredDescriptors = [];

		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${renderSource}
${fnSource}
globalThis.__fn = hydratePluginPanels;
`,
			{
				Promise,
				lang: 'en',
				document: {
					getElementById: id => (id === 'plugin-IngestStates-0-presets' ? {} : null),
					querySelector: () => null,
				},
				t: key => String(key || ''),
				normalizePluginPanel: (panelDef, ref) => ({
					id: `tab-plugin-${ref.pluginType}-${ref.instanceId}-${ref.panelId}`,
					label: panelDef.label,
					ui: { kind: 'plugin', loader: 'esm' },
					app: panelDef.app,
				}),
				registerPanelDescriptor: d => registeredDescriptors.push(d),
			},
			'boot-hydrate-app-passthrough.js',
		);

		const ref = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		await sandbox.__fn([ref], {}, {
			'plugin-IngestStates-0-presets': {
				id: 'plugin-IngestStates-0-presets',
				label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
				ui: { kind: 'plugin', loader: 'esm', bundle: { hash: 'abc123' } },
				app,
			},
		});

		assert.equal(registeredDescriptors.length, 1, 'registerPanelDescriptor must be called once');
		assert.equal(registeredDescriptors[0].id, tabId);
		assert.strictEqual(registeredDescriptors[0].app, app, 'registered descriptor must carry contrib.app');
	});

	it('hydratePluginPanels: contrib without app yields descriptor.app === undefined, no crash', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const renderSource = extractFunctionSource(source, 'renderPluginPanelTabLabel');
		const fnSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');

		const registeredDescriptors = [];

		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${renderSource}
${fnSource}
globalThis.__fn = hydratePluginPanels;
`,
			{
				Promise,
				lang: 'en',
				document: {
					getElementById: id => (id === 'plugin-IngestStates-0-presets' ? {} : null),
					querySelector: () => null,
				},
				t: key => String(key || ''),
				normalizePluginPanel: (panelDef, ref) => ({
					id: `tab-plugin-${ref.pluginType}-${ref.instanceId}-${ref.panelId}`,
					label: panelDef.label,
					ui: { kind: 'plugin', loader: 'esm' },
					app: panelDef.app,
				}),
				registerPanelDescriptor: d => registeredDescriptors.push(d),
			},
			'boot-hydrate-app-absent.js',
		);

		const ref = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		await sandbox.__fn([ref], {}, {
			'plugin-IngestStates-0-presets': {
				id: 'plugin-IngestStates-0-presets',
				label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
				ui: { kind: 'plugin', loader: 'esm', bundle: { hash: 'abc123' } },
			},
		});

		assert.equal(registeredDescriptors.length, 1, 'registerPanelDescriptor must be called even without app');
		assert.equal(registeredDescriptors[0].app, undefined, 'descriptor.app must be undefined when contrib has no app block');
	});

	it('rerenderPluginPanelTabLabels reapplies the existing label render path after plugin i18n merge', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const renderSource = extractFunctionSource(source, 'renderPluginPanelTabLabel');
		const rerenderSource = extractFunctionSource(source, 'rerenderPluginPanelTabLabels');

		const setAttrs = [];
		let tabLabel = 'msghub.i18n.IngestStates.ui.panels.presets.label';
		let titleUpdates = 0;
		const tabEl = {
			setAttribute: (name, value) => setAttrs.push([name, value]),
			get textContent() {
				return tabLabel;
			},
			set textContent(value) {
				tabLabel = value;
			},
		};

		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${renderSource}
${rerenderSource}
globalThis.__rerender = rerenderPluginPanelTabLabels;
globalThis.__map = pluginPanelTabMap;
`,
			{
				document: {
					querySelector: selector =>
						selector === 'a.msghub-tab[href="#tab-plugin-IngestStates-0-presets"]' ? tabEl : null,
				},
				getActiveView: () => ({
					pluginPanels: {
						'plugin-IngestStates-0-presets': {
							label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
						},
					},
				}),
				hasAdminKey: key => key === 'msghub.i18n.IngestStates.ui.panels.presets.label',
				t: key => (key === 'msghub.i18n.IngestStates.ui.panels.presets.label' ? 'Preset Editor' : String(key || '')),
				updateDocumentTitle: () => {
					titleUpdates += 1;
				},
			},
			'boot-rerender-plugin-labels.js',
		);

		sandbox.__map.set('tab-plugin-IngestStates-0-presets', {
			ref: { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
		});

		sandbox.__rerender('IngestStates');

		assert.deepEqual(setAttrs, [['data-i18n', 'msghub.i18n.IngestStates.ui.panels.presets.label']]);
		assert.equal(tabLabel, 'Preset Editor');
		assert.equal(titleUpdates, 1, 'active document title should be refreshed alongside the tab label');
	});

	it('renderPluginPanelTabLabel keeps the existing loading state until plugin-owned i18n is available', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const renderSource = extractFunctionSource(source, 'renderPluginPanelTabLabel');

		const setAttrs = [];
		let tabLabel = 'Lädt…';
		const tabEl = {
			setAttribute: (name, value) => setAttrs.push([name, value]),
			get textContent() {
				return tabLabel;
			},
			set textContent(value) {
				tabLabel = value;
			},
		};

		const sandbox = runInSandbox(
			`
${renderSource}
globalThis.__render = renderPluginPanelTabLabel;
`,
			{
				hasAdminKey: () => false,
				t: key => String(key || ''),
			},
			'boot-render-plugin-label-guard.js',
		);

		const changed = sandbox.__render(tabEl, {
			label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
		});

		assert.equal(changed, false);
		assert.deepEqual(setAttrs, []);
		assert.equal(tabLabel, 'Lädt…');
	});

	it('preloadPluginPanelI18n only preloads resolved plugin panels for the current view', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = 'async ' + extractFunctionSource(source, 'preloadPluginPanelI18n');
		const preloadCalls = [];

		const sandbox = runInSandbox(
			`
${fnSource}
globalThis.__preload = preloadPluginPanelI18n;
`,
			{
				Promise,
				getActiveView: () => null,
			},
			'boot-preload-plugin-i18n.js',
		);

		await sandbox.__preload(
			[
				{ pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
				{ pluginType: 'Missing', instanceId: 0, panelId: 'ghost' },
			],
			{
				preloadI18n: opts => {
					preloadCalls.push(opts);
					return Promise.resolve();
				},
			},
			{
				'plugin-IngestStates-0-presets': {
					ui: { bundle: { hash: 'abc123' } },
				},
			},
		);

		assert.deepEqual(JSON.parse(JSON.stringify(preloadCalls)), [
			{
				pluginType: 'IngestStates',
				instanceId: '0',
				panelId: 'presets',
				hash: 'abc123',
			},
		]);
	});

	it('resolveHydratedPluginTabId() prefers a hydrated hash tab over the composition default', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'resolveHydratedPluginTabId');
		const sandbox = runInSandbox(
			`
${fnSource}
globalThis.__fn = resolveHydratedPluginTabId;
`,
			{
				location: { hash: '#tab-plugin-IngestStates-0-presets' },
			},
			'boot-resolveHydratedPluginTabId.js',
		);

		const resolved = sandbox.__fn('messages', ['tab-plugin-IngestStates-0-presets', 'tab-plugin-IngestStates-0-bulkapply']);
		assert.equal(resolved, 'tab-plugin-IngestStates-0-presets');
	});

	it('resolveHydratedPluginTabId() falls back to defaultPanel and then first enabled when allowed', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'resolveHydratedPluginTabId');
		const sandbox = runInSandbox(
			`
${fnSource}
globalThis.__fn = resolveHydratedPluginTabId;
`,
			{
				location: { hash: '#tab-plugin-IngestStates-0-missing' },
			},
			'boot-resolveHydratedPluginTabId-fallback.js',
		);

		assert.equal(sandbox.__fn('plugin-IngestStates-0-presets', ['tab-plugin-IngestStates-0-presets']), 'tab-plugin-IngestStates-0-presets');
		assert.equal(
			sandbox.__fn('messages', ['tab-plugin-IngestStates-0-presets'], { allowFirstEnabled: true }),
			'tab-plugin-IngestStates-0-presets',
		);
		assert.equal(sandbox.__fn('messages', ['tab-plugin-IngestStates-0-presets']), null);
	});

	it('mountPluginPanelIfNeeded() mounts a hydrated plugin panel only once', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'mountPluginPanelIfNeeded');
		const mountCalls = [];
		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${fnSource}
pluginPanelTabMap.set('tab-plugin-IngestStates-0-presets', {
	ref: { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
	hash: 'hash-1',
	container: { id: 'plugin-IngestStates-0-presets' },
	mountHandle: null,
});
globalThis.__fn = mountPluginPanelIfNeeded;
globalThis.__map = pluginPanelTabMap;
`,
			{
				String,
			},
			'boot-mountPluginPanelIfNeeded.js',
		);

		const pluginUiHost = {
			mount(opts) {
				mountCalls.push(opts);
				return { mounted: true };
			},
		};

		sandbox.__fn('tab-plugin-IngestStates-0-presets', pluginUiHost);
		sandbox.__fn('tab-plugin-IngestStates-0-presets', pluginUiHost);

		assert.equal(mountCalls.length, 1, 'plugin panel must mount only once');
		assert.equal(mountCalls[0].panelId, 'presets');
		assert.ok(sandbox.__map.get('tab-plugin-IngestStates-0-presets').mountHandle);
	});

	it('boot.js wires plugin panel lifecycle from the loaded view, plus spinner, activation, and lazy-load', async function () {
		const source = await readRepoFile('admin/tab/boot.js');

		assert.match(source, /\bhydratePluginPanels\s*\(/, 'hydratePluginPanels must be called');
		assert.doesNotMatch(source, /pluginUi\.[a-z]+/, 'legacy plugin-ui command strings must not appear in boot.js');
		assert.match(source, /viewData\?\.pluginPanels/, 'plugin panel hydration must consume pluginPanels from the loaded view');

		// Spinner is shown only for plugin-only compositions (initial === null).
		assert.match(source, /const needsSpinner = initialTabId === null/, 'spinner condition must be initialTabId === null');
		assert.match(source, /ui\?\.spinner\?\.show\?\./, 'blocking spinner must be shown in plugin-only path');
		assert.match(source, /ui\?\.spinner\?\.hide\?\./, 'spinner must be hidden after activation');

		// Post-hydration activation logic must resolve plugin targets from hash/default state.
		assert.match(source, /\bresolveHydratedPluginTabId\s*\(/, 'post-hydration activation must resolve the preferred plugin tab');
		assert.match(source, /location\.hash/, 'hydrated plugin resolution must consider the URL hash');

		// Persistent toast when all plugin panels unavailable.
		assert.match(source, /persist:\s*true/, 'persistent toast must be shown when no panels available');

		// Lazy-load wired via msghub:tabSwitch and initial plugin mount fallback.
		assert.match(source, /['"]msghub:tabSwitch['"]/, 'lazy-load must listen to msghub:tabSwitch');
		assert.match(source, /\bmountPluginPanelIfNeeded\s*\(/, 'boot must mount initially selected plugin panels explicitly when needed');

		// ingestStates warmup must be gone.
		assert.doesNotMatch(source, /ingestStates\s*\?\s*\.constants/, 'ingestStates warmup must be removed from boot');
	});

	it('single composition activation uses the shared panel activation path', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		assert.match(source, /if \(layout === 'tabs'\)/, 'boot must still branch by layout mode');
		assert.match(source, /initialTabId = activatePanel\(singlePanelId\)/, 'single layouts must activate their panel via activatePanel');
	});

	it('mixed composition prefers a hydrated hash plugin tab over the default panel', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const renderSource = extractFunctionSource(source, 'renderPluginPanelTabLabel');
		const hydrateSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');
		const resolveSource = extractFunctionSource(source, 'resolveHydratedPluginTabId');
		const mountSource = extractFunctionSource(source, 'mountPluginPanelIfNeeded');
		const activatedIds = [];
		const mountCalls = [];
		const container = {};
		const tabEl = {
			removeAttribute: () => {},
			classList: { remove: () => {} },
			setAttribute: () => {},
			querySelector: () => null,
		};
		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${renderSource}
${hydrateSource}
${resolveSource}
${mountSource}
globalThis.__test = async function() {
	const enabledTabIds = await hydratePluginPanels(
		[{ pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' }],
		pluginUiHost,
		pluginPanels,
	);
	const defaultPanelId = 'messages';
	const chosenTabId = resolveHydratedPluginTabId(defaultPanelId, enabledTabIds);
	if (chosenTabId && tabSetActive) {
		tabSetActive(chosenTabId);
		mountPluginPanelIfNeeded(chosenTabId, pluginUiHost);
	}
	return enabledTabIds;
};`,
			{
				document: {
					getElementById: id => (id === 'plugin-IngestStates-0-presets' ? container : null),
					querySelector: () => tabEl,
				},
				location: { hash: '#tab-plugin-IngestStates-0-presets' },
				t: key => (key === 'msghub.i18n.IngestStates.ui.panels.presets.label' ? 'Presets' : String(key || '')),
				pluginPanels: {
					'plugin-IngestStates-0-presets': {
						id: 'plugin-IngestStates-0-presets',
						label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
						ui: { kind: 'plugin', loader: 'esm', bundle: { hash: 'h1' } },
					},
				},
				pluginUiHost: {
					mount(opts) {
						mountCalls.push(opts);
						return { mounted: true };
					},
				},
				applyCategoryMarker: () => {},
				tabSetActive: id => activatedIds.push(id),
				normalizePluginPanel: (panelDef, ref) => ({
					id: `tab-plugin-${ref.pluginType}-${ref.instanceId}-${ref.panelId}`,
					label: panelDef.label,
					ui: { kind: 'plugin', loader: 'esm' },
				}),
				registerPanelDescriptor: () => {},
				Promise,
			},
			'boot-mixed-hashPanel.js',
		);

		await sandbox.__test();

		assert.deepEqual(
			activatedIds,
			['tab-plugin-IngestStates-0-presets'],
			'tabSetActive must prefer the hydrated hash plugin tab in mixed composition',
		);
		assert.equal(mountCalls.length, 1, 'initially selected plugin tab must mount immediately');
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

	it('ensureBooted(): loads the active view via web.view.get before building the shell', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'ensureBooted');

		const requestCalls = [];
		const setActiveViewCalls = [];
		const loadCorePanelEntryCalls = [];
		const initPanelsForCompositionCalls = [];
		const activatePanelCalls = [];
		let activeComposition = null;

		const viewData = {
			composition: {
				id: 'comp-tab-messages',
				layout: 'single',
				panels: [{ type: 'corePanel', panelId: 'messages' }],
				defaultPanel: 'messages',
				deviceMode: 'pc',
			},
			corePanels: {
				messages: {
					id: 'messages',
				},
			},
			request: { mode: 'panel', targetId: 'tab-messages' },
		};

		const sandbox = runInSandbox(
			`
let bootCssFailures = [];
const bootPanelFailures = new Map();
let bootFatalErrorMessage = '';
let bootPromise = null;

function setConnLayout() {}
async function ensureAdminI18nLoaded() {}
async function loadCssFiles() { return { failed: [] }; }
function applyStaticI18n() {}
function updateConnectionPanel() {}
function initConnectionPanelInteraction() {}

${fnSource}
globalThis.__ensureBooted = ensureBooted;
`,
			{
				Promise,
				lang: 'en',
				resolveViewRequest: () => ({ mode: 'panel', targetId: 'tab-messages' }),
				msghubRequest: async (cmd, payload) => {
					requestCalls.push({ cmd, payload });
					return viewData;
				},
				setActiveView: view => {
					setActiveViewCalls.push(view);
					activeComposition = view.composition;
				},
				getActiveComposition: () => activeComposition,
				buildLayoutFromRegistry: () => ({
					layout: 'single',
					panelIds: ['messages'],
					pluginPanelRefs: [],
					defaultPanelId: 'messages',
				}),
				loadCorePanelEntry: async panelId => {
					loadCorePanelEntryCalls.push(panelId);
					return { css: [], js: [], panelInit() { return null; } };
				},
				activatePanel: id => {
					activatePanelCalls.push(id);
					return id;
				},
				initPanelsForComposition: async keys => {
					initPanelsForCompositionCalls.push([...keys]);
				},
				preloadPluginPanelI18n: async () => {},
				maybeHardReloadForLateCriticalBootFailure: () => false,
				ui: null,
			},
			'boot-view-load-core.js',
		);

		await sandbox.__ensureBooted();

		assert.deepEqual(
			JSON.parse(JSON.stringify(requestCalls)),
			[{ cmd: 'web.view.get', payload: { mode: 'panel', targetId: 'tab-messages' } }],
		);
		assert.equal(setActiveViewCalls.length, 1, 'setActiveView must be called once');
		assert.strictEqual(setActiveViewCalls[0], viewData, 'setActiveView must receive the loaded view payload');
		assert.deepEqual(loadCorePanelEntryCalls, ['messages']);
		assert.deepEqual(initPanelsForCompositionCalls, [['messages']]);
		assert.deepEqual(activatePanelCalls, ['tab-messages']);
	});

	it('ensureBooted(): hydrates and mounts plugin single-panel views from the loaded view payload', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'ensureBooted');

		const setActiveViewCalls = [];
		const hydratePluginPanelsCalls = [];
		const mountPluginPanelIfNeededCalls = [];
		const activatePanelCalls = [];
		let activeComposition = null;
		const tabId = 'tab-plugin-IngestStates-0-presets';
		const pluginRef = { type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };

		const sandbox = runInSandbox(
			`
let bootCssFailures = [];
const bootPanelFailures = new Map();
let bootFatalErrorMessage = '';
let bootPromise = null;

function setConnLayout() {}
async function ensureAdminI18nLoaded() {}
async function loadCssFiles() { return { failed: [] }; }
function applyStaticI18n() {}
function updateConnectionPanel() {}
function initConnectionPanelInteraction() {}

${fnSource}
globalThis.__ensureBooted = ensureBooted;
`,
			{
				Promise,
				lang: 'en',
				location: { hash: '' },
				resolveViewRequest: () => ({ mode: 'panel', targetId: tabId }),
				msghubRequest: async () => ({
					composition: {
						id: 'comp-tab-plugin-IngestStates-0-presets',
						layout: 'single',
						panels: [pluginRef],
						defaultPanel: 'plugin-IngestStates-0-presets',
						deviceMode: 'pc',
					},
					corePanels: {},
					request: { mode: 'panel', targetId: tabId },
				}),
				setActiveView: view => {
					setActiveViewCalls.push(view);
					activeComposition = view.composition;
				},
				getActiveComposition: () => activeComposition,
				buildLayoutFromRegistry: () => ({
					layout: 'single',
					panelIds: [],
					pluginPanelRefs: [pluginRef],
					defaultPanelId: 'plugin-IngestStates-0-presets',
					missingNativePanelIds: [],
				}),
				loadCorePanelEntry: async () => ({ css: [], js: [], panelInit() { return null; } }),
				activatePanel: id => {
					activatePanelCalls.push(id);
					return id;
				},
				initPanelsForComposition: async () => {},
				hydratePluginPanels: async refs => {
					hydratePluginPanelsCalls.push(refs);
					return [tabId];
				},
				preloadPluginPanelI18n: async () => {},
				createMsghubPluginUiHost: () => ({}),
				mountPluginPanelIfNeeded: id => {
					mountPluginPanelIfNeededCalls.push(id);
				},
				resolveHydratedPluginTabId: () => tabId,
				maybeHardReloadForLateCriticalBootFailure: () => false,
				document: { addEventListener() {} },
				ui: { spinner: { show() {}, hide() {} } },
				api: {},
			},
			'boot-view-load-plugin.js',
		);

		await sandbox.__ensureBooted();

		assert.equal(setActiveViewCalls.length, 1, 'setActiveView must be called once');
		assert.deepEqual(hydratePluginPanelsCalls, [[pluginRef]]);
		assert.deepEqual(activatePanelCalls, [tabId]);
		assert.deepEqual(mountPluginPanelIfNeededCalls, [tabId]);
	});

	it('ensureBooted(): plugin single-panel view renders unavailableTarget when hydration resolves nothing', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'ensureBooted');

		const renderPanelModeErrorCalls = [];
		const mountPluginPanelIfNeededCalls = [];
		const activatePanelCalls = [];
		const spinnerCalls = [];
		let activeComposition = null;
		const tabId = 'tab-plugin-IngestStates-0-presets';
		const pluginRef = { type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };

		const sandbox = runInSandbox(
			`
let bootCssFailures = [];
const bootPanelFailures = new Map();
let bootFatalErrorMessage = '';
let bootPromise = null;

function setConnLayout() {}
async function ensureAdminI18nLoaded() {}
async function loadCssFiles() { return { failed: [] }; }
function applyStaticI18n() {}
function updateConnectionPanel() {}
function initConnectionPanelInteraction() {}

${fnSource}
globalThis.__ensureBooted = ensureBooted;
`,
			{
				Promise,
				lang: 'en',
				location: { hash: '' },
				resolveViewRequest: () => ({ mode: 'panel', targetId: tabId }),
				msghubRequest: async () => ({
					composition: {
						id: 'comp-tab-plugin-IngestStates-0-presets',
						layout: 'single',
						panels: [pluginRef],
						defaultPanel: 'plugin-IngestStates-0-presets',
						deviceMode: 'pc',
					},
					corePanels: {},
					request: { mode: 'panel', targetId: tabId },
				}),
				setActiveView: view => {
					activeComposition = view.composition;
				},
				getActiveComposition: () => activeComposition,
				buildLayoutFromRegistry: () => ({
					layout: 'single',
					panelIds: [],
					pluginPanelRefs: [pluginRef],
					defaultPanelId: 'plugin-IngestStates-0-presets',
					missingNativePanelIds: [],
				}),
				loadCorePanelEntry: async () => ({ css: [], js: [], panelInit() { return null; } }),
				activatePanel: id => {
					activatePanelCalls.push(id);
					return id;
				},
				initPanelsForComposition: async () => {},
				hydratePluginPanels: async () => [],
				preloadPluginPanelI18n: async () => {},
				createMsghubPluginUiHost: () => ({}),
				mountPluginPanelIfNeeded: id => {
					mountPluginPanelIfNeededCalls.push(id);
				},
				resolveHydratedPluginTabId: () => null,
				renderPanelModeError: key => {
					renderPanelModeErrorCalls.push(key);
				},
				maybeHardReloadForLateCriticalBootFailure: () => false,
				document: { addEventListener() {} },
				ui: {
					spinner: {
						show() {
							spinnerCalls.push('show');
						},
						hide() {
							spinnerCalls.push('hide');
						},
					},
				},
				api: {},
				t: key => key,
			},
			'boot-plugin-single-unavailable.js',
		);

		await sandbox.__ensureBooted();

		assert.deepEqual(activatePanelCalls, [], 'single plugin views must not activate before hydration succeeds');
		assert.deepEqual(mountPluginPanelIfNeededCalls, [], 'mount must not run without a hydrated plugin tab');
		assert.deepEqual(spinnerCalls, ['show', 'hide'], 'blocking spinner must wrap the hydration attempt');
		assert.deepEqual(renderPanelModeErrorCalls, ['msghub.i18n.core.admin.ui.panel.error.unavailableTarget.text']);
	});

	it('ensureBooted(): missing native panel definitions render unknownTarget for panel mode', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'ensureBooted');

		const callOrder = [];
		const renderPanelModeErrorCalls = [];
		let activeComposition = null;

		const sandbox = runInSandbox(
			`
let bootCssFailures = [];
const bootPanelFailures = new Map();
let bootFatalErrorMessage = '';
let bootPromise = null;

function setConnLayout() {}
function applyStaticI18n() {}
function updateConnectionPanel() {}
function initConnectionPanelInteraction() {}

${fnSource}
globalThis.__ensureBooted = ensureBooted;
`,
			{
				Promise,
				lang: 'en',
				resolveViewRequest: () => ({ mode: 'panel', targetId: 'tab-unknown' }),
				msghubRequest: async () => ({
					composition: {
						id: 'comp-tab-unknown',
						layout: 'single',
						panels: [{ type: 'corePanel', panelId: 'unknown' }],
						defaultPanel: 'unknown',
						deviceMode: 'pc',
					},
					corePanels: {},
					request: { mode: 'panel', targetId: 'tab-unknown' },
				}),
				setActiveView: view => {
					activeComposition = view.composition;
				},
				getActiveComposition: () => activeComposition,
				buildLayoutFromRegistry: () => ({
					layout: 'single',
					panelIds: [],
					pluginPanelRefs: [],
					defaultPanelId: 'unknown',
					missingNativePanelIds: ['unknown'],
				}),
				ensureAdminI18nLoaded: async () => {
					callOrder.push('ensureAdminI18nLoaded');
				},
				renderPanelModeError: key => {
					callOrder.push('renderPanelModeError');
					renderPanelModeErrorCalls.push(key);
				},
				maybeHardReloadForLateCriticalBootFailure: () => false,
				ui: null,
				t: key => key,
			},
			'boot-missing-native-panel.js',
		);

		await sandbox.__ensureBooted();

		assert.deepEqual(renderPanelModeErrorCalls, ['msghub.i18n.core.admin.ui.panel.error.unknownTarget.text']);
		assert.deepEqual(callOrder, ['ensureAdminI18nLoaded', 'renderPanelModeError']);
	});

	it('hydratePluginPanels + mountPluginPanelIfNeeded: single-shell — container without tabEl, map populated, mount succeeds', async function () {
		// Integration test for the single-layout contract:
		// the shell creates the container div, hydratePluginPanels runs next and
		// finds the container even though no tab anchor exists in the DOM, pluginPanelTabMap
		// is populated, and mountPluginPanelIfNeeded mounts via that entry.
		// This test uses the real hydratePluginPanels and mountPluginPanelIfNeeded code paths
		// rather than stubs, to verify the contract directly.
		const source = await readRepoFile('admin/tab/boot.js');
		const renderSource = extractFunctionSource(source, 'renderPluginPanelTabLabel');
		// extractFunctionSource captures from 'function', missing the 'async' prefix.
		// Prepend 'async' to restore the original declaration — the function body uses
		// 'await' in its else branch, so the async declaration is required for parsing.
		const hydrateSource = `async ${extractFunctionSource(source, 'hydratePluginPanels')}`;
		const mountSource = extractFunctionSource(source, 'mountPluginPanelIfNeeded');

		const tabId = 'tab-plugin-IngestStates-0-presets';
		const key = 'plugin-IngestStates-0-presets';
		const panelDef = {
			id: 'plugin-IngestStates-0-presets',
			label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
			ui: { kind: 'plugin', loader: 'esm', bundle: { hash: 'abc123' } },
		};

		// Minimal container stub — represents the div created by the single-layout shell.
		const container = { id: key };
		const descriptorCalls = [];

		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();

${renderSource}
${hydrateSource}

${mountSource}

globalThis.__hydratePluginPanels = hydratePluginPanels;
globalThis.__mountPluginPanelIfNeeded = mountPluginPanelIfNeeded;
globalThis.__pluginPanelTabMap = pluginPanelTabMap;
`,
			{
				Promise,
				document: {
					// Single-panel shell: container exists, but no tab anchor element.
					getElementById: id => (id === key ? container : null),
					querySelector: () => null,
				},
				t: key => String(key || ''),
				applyCategoryMarker: () => {},
				normalizePluginPanel: (resolvedPanelDef, ref) => ({ id: tabId, label: resolvedPanelDef.label, ui: { kind: 'plugin' } }),
				registerPanelDescriptor: d => {
					descriptorCalls.push(d);
				},
			},
			'boot-hydrate-mount-integration.js',
		);

		const hydrateRef = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };

		const pluginUiHost = {
			mount: opts => ({ mountedWith: opts }),
		};

		const enabledIds = await sandbox.__hydratePluginPanels([hydrateRef], pluginUiHost, {
			'plugin-IngestStates-0-presets': panelDef,
		});

		// Hydration must succeed without a tab element.
		// Use element-level checks rather than deepEqual: the returned array is from the vm
		// realm and has a different Array.prototype, which deepStrictEqual would reject.
		assert.equal(enabledIds.length, 1, 'hydratePluginPanels must return exactly one enabled tabId');
		assert.equal(enabledIds[0], tabId, 'returned tabId must match the plugin tabId');

		// pluginPanelTabMap must be populated with the correct entry.
		const entry = sandbox.__pluginPanelTabMap.get(tabId);
		assert.ok(entry, 'pluginPanelTabMap must contain an entry after hydration');
		assert.equal(entry.container, container, 'entry.container must be the div found by getElementById');
		assert.equal(entry.hash, 'abc123', 'entry.hash must come from panelDef.ui.bundle.hash');
		assert.strictEqual(entry.mountHandle, null, 'entry.mountHandle must be null before mount');
		assert.equal(entry.ref, hydrateRef, 'entry.ref must be the hydrateRef passed to hydratePluginPanels');

		// Descriptor must have been registered.
		assert.equal(descriptorCalls.length, 1, 'registerPanelDescriptor must be called once during hydration');

		// Step 2: mount via the map entry — same as mountPluginPanelIfNeeded(tabId, pluginUiHost) in ensureBooted.
		sandbox.__mountPluginPanelIfNeeded(tabId, pluginUiHost);

		const updatedEntry = sandbox.__pluginPanelTabMap.get(tabId);
		assert.ok(updatedEntry.mountHandle, 'entry.mountHandle must be set after mount');
		assert.equal(updatedEntry.mountHandle.mountedWith.pluginType, 'IngestStates');
		assert.equal(updatedEntry.mountHandle.mountedWith.instanceId, '0', 'instanceId must be stringified in the mount call');
		assert.equal(updatedEntry.mountHandle.mountedWith.panelId, 'presets');
		assert.equal(updatedEntry.mountHandle.mountedWith.hash, 'abc123');
		assert.equal(updatedEntry.mountHandle.mountedWith.container, container, 'mount must receive the container from the map entry');
	});

	it('ensureBooted(): invalid panel request — i18n loaded before error is rendered, boot stops', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'ensureBooted');

		// Track call order to verify ensureAdminI18nLoaded precedes renderPanelModeError.
		const callOrder = [];
		const renderPanelModeErrorCalls = [];

		const sandbox = runInSandbox(
			`
let bootCssFailures = [];
const bootPanelFailures = new Map();
let bootFatalErrorMessage = '';
let bootPromise = null;

${fnSource}
globalThis.__ensureBooted = ensureBooted;
`,
			{
				Promise,
				lang: 'en',
				resolveViewRequest: () => ({ mode: 'panel', targetId: 'bad-target' }),
				msghubRequest: async () => {
					throw Object.assign(new Error('Invalid panel target'), { code: 'BAD_REQUEST' });
				},
				ensureAdminI18nLoaded: async () => {
					callOrder.push('ensureAdminI18nLoaded');
				},
				renderPanelModeError: key => {
					callOrder.push('renderPanelModeError');
					renderPanelModeErrorCalls.push(key);
				},
				maybeHardReloadForLateCriticalBootFailure: () => false,
				ui: null,
			},
			'boot-panel-mode-error.js',
		);

		await sandbox.__ensureBooted();

		assert.equal(renderPanelModeErrorCalls.length, 1, 'renderPanelModeError must be called once for invalid panel requests');
		assert.equal(
			renderPanelModeErrorCalls[0],
			'msghub.i18n.core.admin.ui.panel.error.unknownTarget.text',
			'renderPanelModeError must receive the unknownTarget i18n key',
		);
		// i18n must be loaded before the error is rendered so t() produces a translated string.
		assert.deepEqual(
			callOrder,
			['ensureAdminI18nLoaded', 'renderPanelModeError'],
			'ensureAdminI18nLoaded must complete before renderPanelModeError is called',
		);
	});
});
