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
		assert.match(source, /visibilitychange/);
		assert.match(source, /pageshow/);
		assert.match(source, /window\.addEventListener\(\s*['"]focus['"]/);
		assert.match(source, /window\.addEventListener\(\s*['"]online['"]/);
	});

	it('keeps composition resolution delegated to shared layout helpers', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		assert.match(source, /\bgetActiveComposition\s*\(/);
		assert.doesNotMatch(source, /data-msghub-view/);
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
				args: { locale: 'de-DE' },
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
		assert.equal(elMap['msghub-conn-host'].textContent, '—');
		assert.equal(elMap['msghub-conn-adapter'].textContent, '—');
		// serverTz=Europe/Berlin, browserTz=Europe/Berlin → same → hint hidden
		assert.equal(tzHintHidden, true);
		assert.equal(tzHintAriaHidden, 'true');
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
				pickText: key => `T:${key}`,
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

	it('acquireAutoReloadLease throttles automatic reloads per tab session', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'acquireAutoReloadLease');
		const sessionStorage = createStorage();
		const sandbox = runInSandbox(
			`
const AUTO_RELOAD_SESSION_KEY = 'msghub.adminTab.autoReloadAt';
const AUTO_RELOAD_COOLDOWN_MS = 120000;
${fnSource}
globalThis.__fn = acquireAutoReloadLease;
`,
			{
				window: { sessionStorage },
				Date: { now: () => 1000 },
				Number,
			},
			'boot-acquireAutoReloadLease.js',
		);

		assert.equal(sandbox.__fn(), true);
		assert.equal(sandbox.__fn(), false);
	});

	it('reloadForCriticalBoot reloads only for hard boot failures within the budget', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'reloadForCriticalBoot');
		let reloadCalls = 0;
		const warnings = [];
		const sandbox = runInSandbox(
			`
${fnSource}
globalThis.__fn = reloadForCriticalBoot;
`,
			{
				hasCriticalBootFailure: () => true,
				acquireAutoReloadLease: () => true,
				api: { log: { warn: msg => warnings.push(String(msg)) } },
				window: { location: { reload: () => reloadCalls++ } },
			},
			'boot-reloadForCriticalBoot.js',
		);

		assert.equal(sandbox.__fn('resume'), true);
		assert.equal(reloadCalls, 1);
		assert.equal(warnings.length, 1);
	});

	it('triggerResumeRecovery debounces clustered resume events and schedules reconnect bursts', async function () {
		const source = await readRepoFile('admin/tab/boot.js');
		const fnSource = extractFunctionSource(source, 'triggerResumeRecovery');
		const timers = [];
		let reconnectCalls = 0;
		let pingCalls = 0;
		let reloadChecks = 0;
		const sandbox = runInSandbox(
			`
let lastResumeRecoveryAt = 0;
let resumeRecoveryToken = 0;
const RESUME_RECOVERY_DEBOUNCE_MS = 750;
const RESUME_RECOVERY_BURSTS_MS = Object.freeze([0, 1000, 4000]);
const RESUME_RELOAD_DELAY_MS = 2500;
${fnSource}
globalThis.__fn = triggerResumeRecovery;
`,
			{
				Date: { now: (() => {
					let now = 1000;
					return () => now;
				})() },
				setTimeout: (fn, delay) => {
					timers.push({ fn, delay });
					return timers.length;
				},
				attemptSocketReconnect: () => {
					reconnectCalls++;
				},
				sendPing: () => {
					pingCalls++;
					return Promise.resolve();
				},
				reloadForCriticalBoot: () => {
					reloadChecks++;
					return false;
				},
				Object,
				Promise,
			},
			'boot-triggerResumeRecovery.js',
		);

		sandbox.__fn('focus');
		sandbox.__fn('pageshow');

		assert.deepEqual(
			timers.map(t => t.delay),
			[0, 1000, 4000, 2500],
		);
		for (const timer of timers) {
			timer.fn();
		}
		assert.equal(reconnectCalls, 3);
		assert.equal(pingCalls, 3);
		assert.equal(reloadChecks, 1);
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
					Promise.resolve([
						{
							pluginType: 'IngestStates',
							instanceId: 0,
							panelId: 'presets',
							title: { en: 'Presets', de: 'Vorlagen' },
							bundle: { hash: 'abc123' },
						},
					]),
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
					Promise.resolve([
						// instanceId: 99 does not match ref.instanceId: 0
						{ pluginType: 'IngestStates', instanceId: 99, panelId: 'presets', title: { en: 'Presets' }, bundle: { hash: 'x' } },
					]),
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
				msghubRequest: () => Promise.resolve([]),
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

	it('boot.js wires plugin panel lifecycle: discover hydration, spinner, activation, lazy-load', async function () {
		const source = await readRepoFile('admin/tab/boot.js');

		// Discover hydration is wired.
		assert.match(source, /\bhydratePluginPanels\s*\(/, 'hydratePluginPanels must be called');
		assert.match(source, /['"]admin\.pluginUi\.discover['"]/, 'admin.pluginUi.discover must be used');

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
		const hydrateSource = 'async ' + extractFunctionSource(source, 'hydratePluginPanels');
		const resolveSource = extractFunctionSource(source, 'resolveHydratedPluginTabId');
		const mountSource = extractFunctionSource(source, 'mountPluginPanelIfNeeded');
		const activatedIds = [];
		const mountCalls = [];
		const container = {};
		const tabEl = {
			removeAttribute: () => {},
			classList: { remove: () => {} },
			querySelector: () => null,
		};
		const sandbox = runInSandbox(
			`
const pluginPanelTabMap = new Map();
${hydrateSource}
${resolveSource}
${mountSource}
globalThis.__test = async function() {
	const enabledTabIds = await hydratePluginPanels(
		[{ pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' }],
		pluginUiHost,
		null,
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
				msghubRequest: () =>
					Promise.resolve([
						{
							pluginType: 'IngestStates',
							instanceId: 0,
							panelId: 'presets',
							title: { en: 'Presets' },
							bundle: { hash: 'h1' },
						},
					]),
				document: {
					getElementById: id => (id === 'plugin-IngestStates-0-presets' ? container : null),
					querySelector: () => tabEl,
				},
				location: { hash: '#tab-plugin-IngestStates-0-presets' },
				api: { i18n: { pickText: v => (v && typeof v === 'object' ? v.en || '' : String(v || '')) } },
				pluginUiHost: {
					mount(opts) {
						mountCalls.push(opts);
						return { mounted: true };
					},
				},
				tabSetActive: id => activatedIds.push(id),
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
});
