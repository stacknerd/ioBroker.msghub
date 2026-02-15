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
		assert.match(source, /\bsocket\.on\(\s*['"]connect['"]/);
		assert.match(source, /\bsocket\.on\(\s*['"]disconnect['"]/);
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
${applyRuntimeAboutPayloadSource}
globalThis.__applyRuntimeAboutPayload = applyRuntimeAboutPayload;
`,
			{
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
					toast: msg => toasts.push(String(msg)),
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
${applyRuntimeAboutPayloadSource}
globalThis.__applyRuntimeAboutPayload = applyRuntimeAboutPayload;
`,
			{
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
					toast: msg => toasts.push(String(msg)),
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
});
