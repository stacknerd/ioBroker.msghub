/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRepoFile, extractFunctionSource } = require('./_test.utils');

const NativeURL = URL;

function createClassList(initial = '') {
	const set = new Set(String(initial || '').split(/\s+/g).filter(Boolean));
	return {
		add: (...tokens) => tokens.forEach(token => set.add(String(token))),
		remove: (...tokens) => tokens.forEach(token => set.delete(String(token))),
		contains: token => set.has(String(token)),
		toggle: (token, force) => {
			const normalized = String(token);
			if (force === true) {
				set.add(normalized);
				return true;
			}
			if (force === false) {
				set.delete(normalized);
				return false;
			}
			if (set.has(normalized)) {
				set.delete(normalized);
				return false;
			}
			set.add(normalized);
			return true;
		},
		toString: () => Array.from(set).join(' '),
	};
}

function createElement(tagName) {
	const attributes = new Map();
	const listeners = new Map();
	const element = {
		tagName: String(tagName || '').toUpperCase(),
		children: [],
		style: {},
		className: '',
		classList: createClassList(),
		appendChild(child) {
			if (child?.parentNode && Array.isArray(child.parentNode.children)) {
				const idx = child.parentNode.children.indexOf(child);
				if (idx >= 0) {
					child.parentNode.children.splice(idx, 1);
				}
			}
			if (child) {
				child.parentNode = this;
			}
			this.children.push(child);
			return child;
		},
		replaceChildren(...children) {
			this.children = [...children];
			for (const child of children) {
				if (child) {
					child.parentNode = this;
				}
			}
		},
		setAttribute(name, value) {
			const key = String(name);
			attributes.set(key, String(value));
			if (key === 'class') {
				this.className = String(value);
				this.classList = createClassList(this.className);
			}
		},
		getAttribute(name) {
			return attributes.get(String(name)) || null;
		},
		removeAttribute(name) {
			attributes.delete(String(name));
		},
		toggleAttribute(name, force) {
			const key = String(name);
			if (force === false) {
				attributes.delete(key);
				return false;
			}
			attributes.set(key, '');
			return true;
		},
		addEventListener(type, handler) {
			const key = String(type);
			const list = listeners.get(key) || [];
			list.push(handler);
			listeners.set(key, list);
		},
		dispatchEvent(event) {
			const list = listeners.get(String(event?.type || '')) || [];
			for (const handler of list) {
				handler(event);
			}
		},
		get firstChild() {
			return this.children[0] || null;
		},
		remove() {
			if (this.parentNode && Array.isArray(this.parentNode.children)) {
				const idx = this.parentNode.children.indexOf(this);
				if (idx >= 0) {
					this.parentNode.children.splice(idx, 1);
				}
			}
		},
		querySelector(selector) {
			const attrMatch = String(selector).match(/^(\w+)\[(\w[\w-]*)\s*=\s*["']([^"']*)["']\]$/);
			if (attrMatch) {
				const [, tag, attr, val] = attrMatch;
				for (const child of this.children) {
					if (
						child &&
						String(child.tagName || '').toLowerCase() === tag.toLowerCase() &&
						child.getAttribute(attr) === val
					) {
						return child;
					}
				}
				return null;
			}
			return null;
		},
	};
	return element;
}

function createScrollStripStub(documentObject) {
	return {
		initStrip(hostEl) {
			if (!hostEl || typeof hostEl !== 'object' || typeof hostEl.appendChild !== 'function') {
				return { viewport: null, disconnect() {} };
			}
			if (hostEl.classList?.contains?.('msghub-strip-host')) {
				return hostEl.__msghubStripHandle || { viewport: null, disconnect() {} };
			}
			hostEl.classList?.add?.('msghub-strip-host');
			const viewport = documentObject.createElement('div');
			viewport.setAttribute('class', 'msghub-strip-viewport');
			while (hostEl.children && hostEl.children.length > 0) {
				viewport.appendChild(hostEl.children[0]);
			}
			hostEl.appendChild(viewport);
			const edgeLeft = documentObject.createElement('span');
			edgeLeft.setAttribute('class', 'msghub-strip-edge msghub-strip-edge--left');
			const edgeRight = documentObject.createElement('span');
			edgeRight.setAttribute('class', 'msghub-strip-edge msghub-strip-edge--right');
			hostEl.appendChild(edgeLeft);
			hostEl.appendChild(edgeRight);
			const handle = { viewport, disconnect() {} };
			hostEl.__msghubStripHandle = handle;
			return handle;
		},
	};
}

function createTestUrlClass(options, blobUrls, revokedUrls) {
	class TestURL extends NativeURL {}
	TestURL.createObjectURL =
		options.createObjectURL ||
		(blob => {
			const url = `blob:test-${blobUrls.length + 1}`;
			blobUrls.push({ url, blob });
			return url;
		});
	TestURL.revokeObjectURL =
		options.revokeObjectURL ||
		(url => {
			revokedUrls.push(String(url));
		});
	return TestURL;
}

function createLocationStub(locationOptions = {}) {
	const fallbackHref = 'http://localhost:8081/adapter/msghub/tab.html';
	const href = typeof locationOptions.href === 'string' && locationOptions.href.trim() ? locationOptions.href.trim() : fallbackHref;
	const parsed = new NativeURL(href, fallbackHref);
	return {
		hash: locationOptions.hash ?? parsed.hash ?? '',
		pathname: locationOptions.pathname ?? parsed.pathname ?? '/adapter/msghub/tab.html',
		search: locationOptions.search ?? parsed.search ?? '',
		origin: locationOptions.origin ?? parsed.origin ?? 'http://localhost:8081',
		href,
	};
}

async function loadLayoutSandbox(options = {}) {
	const source = await readRepoFile('admin/tab/layout.js');
	const expose = `
	window.__layoutFns = {
		initTabs,
		activatePanel,
		updateDocumentTitle,
		generateManifest,
		h,
		resolveViewRequest,
		setActiveView,
		getActiveView,
		resolveViewId,
		getActiveComposition,
		buildLayoutFromRegistry,
		loadCssFiles,
		loadJsFilesSequential,
		renderPanelBootError,
		normalizePluginPanel,
		registerPanelDescriptor,
		resolveIconUrl,
		renderPanelModeError
	};
	`;

	const headElement = createElement('head');
	const appendToHead = headElement.appendChild.bind(headElement);
	headElement.appendChild = child => {
		const result = appendToHead(child);
		if (child && typeof child.onload === 'function') {
			child.onload();
		}
		return result;
	};
	const rootElement = createElement('div');
	rootElement.className = 'msghub-root';
	rootElement.classList = createClassList('msghub-root');
	const layoutHost = createElement('div');
	layoutHost.id = 'msghub-layout';

	const allLinks = [];
	const allScripts = [];

	const listeners = new Map();
	const intervalCallbacks = [];
	const observerCallbacks = [];
	const appliedThemes = [];
	const blobUrls = [];
	const revokedUrls = [];
	const fetchCalls = [];
	const documentObject = {
		title: '',
		head: headElement,
		documentElement: {
			getAttribute: key =>
				key === 'data-msghub-view'
					? (Object.prototype.hasOwnProperty.call(options, 'viewIdAttr') ? options.viewIdAttr : 'adminTab')
					: '',
		},
		querySelector: selector => {
			if (selector === '.msghub-root') {
				return rootElement;
			}
			return null;
		},
		querySelectorAll: selector => {
			if (selector === '.msghub-tab') {
				return [];
			}
			if (selector === '.msghub-panel') {
				return [];
			}
			if (selector === 'link[rel="stylesheet"]') {
				return allLinks;
			}
			if (selector === 'script[src]') {
				return allScripts;
			}
			return [];
		},
		getElementById: id => {
			if (id === 'msghub-layout') {
				return layoutHost;
			}
			return null;
		},
		getElementsByTagName: tag => (String(tag).toLowerCase() === 'head' ? [headElement] : []),
		createElement: tag => {
			const element = createElement(tag);
			if (String(tag).toLowerCase() === 'link') {
				allLinks.push(element);
			}
			if (String(tag).toLowerCase() === 'script') {
				allScripts.push(element);
			}
			return element;
		},
		createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
		createDocumentFragment: () => createElement('fragment'),
		addEventListener() {},
		dispatchEvent() {},
	};

	const defaultFetch = async url => {
		fetchCalls.push(String(url));
		return {
			ok: true,
			headers: {
				get(name) {
					return String(name || '').toLowerCase() === 'content-type' ? 'image/png' : null;
				},
			},
			async arrayBuffer() {
				return Uint8Array.from([137, 80, 78, 71]).buffer;
			},
		};
	};

	const windowObject = {
		addEventListener(type, handler) {
			const list = listeners.get(String(type)) || [];
			list.push(handler);
			listeners.set(String(type), list);
		},
		setInterval(handler) {
			intervalCallbacks.push(handler);
			return intervalCallbacks.length;
		},
	};
	windowObject.top = options.topDocument ? { document: options.topDocument } : windowObject;
	windowObject.MsghubScrollStrip = createScrollStripStub(documentObject);

	const sandbox = {
		window: windowObject,
		document: documentObject,
		location: createLocationStub(options.location),
		history: { replaceState() {} },
		t: key => key,
		MutationObserver: class {
			observe() {}
		},
		CustomEvent: class {
			constructor(type, init) {
				this.type = type;
				this.detail = init?.detail;
			}
		},
		MsghubScrollStrip: windowObject.MsghubScrollStrip,
		msghubRequest: options.msghubRequest || (async () => {
			throw new Error('unexpected request');
		}),
		win: {},
		args: options.args || {},
		urlThemeLocked: options.urlThemeLocked === true,
		applyTheme: options.applyTheme || (theme => appliedThemes.push(String(theme))),
		detectTheme: options.detectTheme || (() => 'light'),
		readThemeFromTopWindow: options.readThemeFromTopWindow || (() => null),
		t: options.t || (key => key),
		fetch: options.fetch || defaultFetch,
		Blob: class {
			constructor(parts, init = {}) {
				this.parts = parts;
				this.type = init.type || '';
			}
		},
		URL: createTestUrlClass(options, blobUrls, revokedUrls),
		atob: options.atob || (input => Buffer.from(String(input || ''), 'base64').toString('binary')),
		btoa: options.btoa || (input => Buffer.from(String(input || ''), 'binary').toString('base64')),
		MutationObserver: class {
			constructor(callback) {
				this.callback = callback;
				observerCallbacks.push(callback);
			}
			observe() {}
		},
	};

	vm.runInNewContext(`${source}\n${expose}`, sandbox, { filename: 'admin/tab/layout.js' });
	sandbox.window.__layoutFns.setActiveView(
		Object.prototype.hasOwnProperty.call(options, 'activeView')
			? options.activeView
			: {
			composition: {
				id: 'adminTab',
				layout: 'tabs',
				panels: ['stats', 'messages'],
				defaultPanel: 'messages',
			},
			corePanels: {
				stats: {
					id: 'stats',
					label: 'stats.key',
				},
				messages: {
					id: 'messages',
					label: 'messages.key',
				},
			},
			request: { mode: 'composition', targetId: 'adminTab' },
		},
	);
	return {
		sandbox,
		layoutHost,
		allLinks,
		allScripts,
		headElement,
		listeners,
		intervalCallbacks,
		observerCallbacks,
		appliedThemes,
		blobUrls,
		revokedUrls,
		fetchCalls,
	};
}

async function loadRuntimeBackedLayoutSandbox(options = {}) {
	const runtimeSource = await readRepoFile('admin/tab/runtime.js');
	const layoutSource = await readRepoFile('admin/tab/layout.js');
	const runtimePrelude = [
		`let adminDict = Object.freeze(${JSON.stringify(options.adminDict || {})});`,
		extractFunctionSource(runtimeSource, 'hasAdminKey'),
		extractFunctionSource(runtimeSource, 'mergePluginI18n'),
		extractFunctionSource(runtimeSource, 't'),
	].join('\n\n');
	const expose = `
	window.__layoutFns = {
		activatePanel,
		updateDocumentTitle,
		registerPanelDescriptor
	};
	window.__runtimeFns = {
		mergePluginI18n
	};
	`;

	const headElement = createElement('head');
	const rootElement = createElement('div');
	rootElement.className = 'msghub-root';
	rootElement.classList = createClassList('msghub-root');
	const layoutHost = createElement('div');
	layoutHost.id = 'msghub-layout';
	const elementsById = new Map([['msghub-layout', layoutHost]]);
	const blobUrls = [];
	const revokedUrls = [];
	const documentObject = {
		title: '',
		head: headElement,
		documentElement: {
			getAttribute: () => '',
		},
		querySelector: selector => {
			if (selector === '.msghub-root') {
				return rootElement;
			}
			return null;
		},
		querySelectorAll: selector => {
			if (selector === '.msghub-tab') {
				return [];
			}
			if (selector === '.msghub-panel') {
				return Array.from(elementsById.values()).filter(el => el?.classList?.contains?.('msghub-panel'));
			}
			return [];
		},
		getElementById: id => elementsById.get(id) || null,
		getElementsByTagName: tag => (String(tag).toLowerCase() === 'head' ? [headElement] : []),
		createElement,
		createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
		createDocumentFragment: () => createElement('fragment'),
		addEventListener() {},
		dispatchEvent() {},
	};
	const windowObject = {
		addEventListener() {},
		setInterval() {
			return 1;
		},
	};
	windowObject.top = windowObject;
	windowObject.MsghubScrollStrip = createScrollStripStub(documentObject);

	const sandbox = {
		window: windowObject,
		document: documentObject,
		location: createLocationStub(options.location),
		history: { replaceState() {} },
		msghubRequest: options.msghubRequest || (async () => ({ mimeType: 'image/png', content: 'AQID' })),
		win: {},
		args: {},
		urlThemeLocked: false,
		applyTheme() {},
		detectTheme: () => 'light',
		readThemeFromTopWindow: () => null,
		Blob: class {
			constructor(parts, init = {}) {
				this.parts = parts;
				this.type = init.type || '';
			}
		},
		URL: createTestUrlClass({}, blobUrls, revokedUrls),
		atob: input => Buffer.from(String(input || ''), 'base64').toString('binary'),
		btoa: input => Buffer.from(String(input || ''), 'binary').toString('base64'),
		CustomEvent: class {
			constructor(type, init) {
				this.type = type;
				this.detail = init?.detail;
			}
		},
		MutationObserver: class {
			observe() {}
		},
	};

	vm.runInNewContext(`${runtimePrelude}\n\n${layoutSource}\n${expose}`, sandbox, {
		filename: 'admin/tab/runtime-layout.integration.js',
	});
	return {
		sandbox,
		blobUrls,
		revokedUrls,
		registerElement(element) {
			elementsById.set(element.id, element);
		},
	};
}

describe('admin/tab/layout.js', function () {
	it('creates DOM nodes via h()', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const element = sandbox.window.__layoutFns.h(
			'div',
			{
				class: 'a b',
				id: 'demo',
				'data-x': 1,
			},
			['hello'],
		);

		assert.equal(element.className, 'a b');
		assert.equal(element.getAttribute('id'), 'demo');
		assert.equal(element.getAttribute('data-x'), '1');
		assert.equal(element.children.length, 1);
		assert.equal(element.children[0].textContent, 'hello');
	});

	it('returns resolved view id and active composition from loaded view defaults', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const resolveViewId = sandbox.window.__layoutFns.resolveViewId;
		const getActiveComposition = sandbox.window.__layoutFns.getActiveComposition;

		assert.equal(resolveViewId(), 'adminTab');
		assert.equal(getActiveComposition().defaultPanel, 'messages');
	});

	it('resolveViewRequest() prefers panel mode over composition and markup', async function () {
		const { sandbox } = await loadLayoutSandbox({
			args: { panel: 'tab-messages', composition: 'customView' },
			viewIdAttr: 'adminTab',
			activeView: null,
		});
		assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.__layoutFns.resolveViewRequest())), {
			mode: 'panel',
			targetId: 'tab-messages',
		});
	});

	it('resolveViewRequest() prefers URL composition over data-msghub-view when panel mode is absent', async function () {
		const { sandbox } = await loadLayoutSandbox({
			args: { composition: 'customView' },
			viewIdAttr: 'adminTab',
			activeView: null,
		});
		assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.__layoutFns.resolveViewRequest())), {
			mode: 'composition',
			targetId: 'customView',
		});
	});

	it('resolveViewRequest() falls back to markup composition when URL composition is absent', async function () {
		const { sandbox } = await loadLayoutSandbox({
			args: {},
			viewIdAttr: 'adminTab',
			activeView: null,
		});
		assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.__layoutFns.resolveViewRequest())), {
			mode: 'composition',
			targetId: 'adminTab',
		});
	});

	it('resolveViewRequest() falls back to backend default composition when URL and markup are empty', async function () {
		const { sandbox } = await loadLayoutSandbox({
			args: {},
			viewIdAttr: '',
			activeView: null,
		});
		assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.__layoutFns.resolveViewRequest())), {
			mode: 'composition',
		});
	});

	it('blocks all dynamic theme update paths when a URL theme override is locked', async function () {
		const topDocument = { documentElement: {} };
		const { listeners, intervalCallbacks, observerCallbacks, appliedThemes } = await loadLayoutSandbox({
			urlThemeLocked: true,
			topDocument,
			detectTheme: () => 'light',
			readThemeFromTopWindow: () => 'dark',
		});

		listeners.get('message')[0]({ data: 'dark' });
		listeners.get('storage')[0]();
		intervalCallbacks[0]();
		observerCallbacks[0]();

		assert.deepEqual(appliedThemes, []);
	});

	it('keeps dynamic theme update paths active when no URL theme override is locked', async function () {
		const topDocument = { documentElement: {} };
		const { listeners, intervalCallbacks, observerCallbacks, appliedThemes } = await loadLayoutSandbox({
			urlThemeLocked: false,
			topDocument,
			detectTheme: () => 'light',
			readThemeFromTopWindow: () => 'dark',
		});

		listeners.get('message')[0]({ data: 'dark' });
		listeners.get('storage')[0]();
		intervalCallbacks[0]();
		observerCallbacks[0]();

		assert.deepEqual(appliedThemes, ['dark', 'light', 'light', 'dark']);
	});

	it('buildLayoutFromRegistry() separates native panelIds from plugin panel refs', async function () {
		const { sandbox, layoutHost } = await loadLayoutSandbox();

		sandbox.window.__layoutFns.setActiveView({
			composition: {
				id: 'adminTab',
				layout: 'tabs',
				panels: ['messages', { type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' }],
				defaultPanel: 'messages',
			},
			corePanels: {
				messages: { id: 'messages', label: 'messages.key' },
			},
			request: { mode: 'composition', targetId: 'adminTab' },
		});

		const { buildLayoutFromRegistry } = sandbox.window.__layoutFns;
		const result = buildLayoutFromRegistry();

		// panelIds must contain only string IDs.
		assert.deepEqual(JSON.parse(JSON.stringify(result.panelIds)), ['messages']);

		// pluginPanelRefs must contain the structured ref.
		assert.equal(result.pluginPanelRefs.length, 1);
		const ref = result.pluginPanelRefs[0];
		assert.equal(ref.type, 'pluginPanel');
		assert.equal(ref.pluginType, 'IngestStates');
		assert.equal(ref.instanceId, 0);
		assert.equal(ref.panelId, 'presets');

		// DOM: plugin tab must be rendered with aria-disabled and is-disabled.
		const fragment = layoutHost.children[0];
		const nav = fragment.children[0];
		const pluginTab = nav.children[0].children[1]; // native tab is [0], plugin tab is [1]
		assert.equal(pluginTab.getAttribute('aria-disabled'), 'true');
		assert.ok(pluginTab.className.includes('is-disabled'));
		assert.equal(pluginTab.getAttribute('href'), '#tab-plugin-IngestStates-0-presets');

		// DOM: plugin panel container has required data attributes.
		const pluginPanel = fragment.children[2]; // nav[0], nativePanel[1], pluginPanel[2]
		assert.equal(pluginPanel.getAttribute('data-plugin-panel'), 'true');
		assert.equal(pluginPanel.getAttribute('data-plugin-type'), 'IngestStates');
		assert.equal(pluginPanel.getAttribute('data-plugin-instance-id'), '0');
		assert.equal(pluginPanel.getAttribute('data-panel-id'), 'presets');
	});

	it('buildLayoutFromRegistry() returns empty pluginPanelRefs for string-only panels', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const { buildLayoutFromRegistry } = sandbox.window.__layoutFns;

		// Default sandbox has a string-only composition.
		const result = buildLayoutFromRegistry();

		assert.deepEqual(JSON.parse(JSON.stringify(result.pluginPanelRefs)), []);
		assert.ok(result.panelIds.length > 0);
		for (const id of result.panelIds) {
			assert.equal(typeof id, 'string');
		}
	});

	it('buildLayoutFromRegistry() reports missing native panel definitions and leaves the layout untouched', async function () {
		const { sandbox, layoutHost } = await loadLayoutSandbox({
			activeView: {
				composition: {
					id: 'broken',
					layout: 'single',
					panels: ['unknown'],
					defaultPanel: 'unknown',
				},
				corePanels: {},
				request: { mode: 'panel', targetId: 'tab-unknown' },
			},
		});
		const { buildLayoutFromRegistry } = sandbox.window.__layoutFns;

		const result = buildLayoutFromRegistry();

		assert.deepEqual(JSON.parse(JSON.stringify(result.missingNativePanelIds)), ['unknown']);
		assert.deepEqual(JSON.parse(JSON.stringify(result.panelIds)), []);
		assert.equal(layoutHost.children.length, 0, 'layout must not render partial DOM when a native panel definition is missing');
	});

	it('buildLayoutFromRegistry() uses the materialized backend view for wildcard-like compositions', async function () {
		const { sandbox, layoutHost } = await loadLayoutSandbox();

		sandbox.window.__layoutFns.setActiveView({
			composition: {
				id: 'adminTab',
				layout: 'tabs',
				panels: [
					'messages',
					{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
				],
				defaultPanel: 'messages',
			},
			corePanels: {
				messages: { id: 'messages', label: 'messages.key' },
			},
			pluginPanels: {
				'plugin-IngestStates-0-presets': {
					id: 'plugin-IngestStates-0-presets',
					label: 'presets.label',
					ui: { kind: 'plugin', loader: 'esm', apiVersion: '1', bundle: { hash: 'h1' } },
				},
			},
			request: { mode: 'composition', targetId: 'adminTab' },
		});

		const { buildLayoutFromRegistry } = sandbox.window.__layoutFns;
		const result = buildLayoutFromRegistry();

		assert.deepEqual(JSON.parse(JSON.stringify(result.panelIds)), ['messages']);
		assert.equal(result.pluginPanelRefs.length, 1);
		assert.equal(result.pluginPanelRefs[0].pluginType, 'IngestStates');
		assert.equal(result.pluginPanelRefs[0].instanceId, 0);

		// DOM: both a native tab and a plugin tab rendered.
		const fragment = layoutHost.children[0];
		const nav = fragment.children[0];
		assert.equal(nav.classList.contains('msghub-strip-host'), true);
		assert.equal(nav.children.length, 3);
		assert.equal(nav.children[0].classList.contains('msghub-strip-viewport'), true);
		assert.equal(nav.children[1].classList.contains('msghub-strip-edge--left'), true);
		assert.equal(nav.children[2].classList.contains('msghub-strip-edge--right'), true);
		assert.equal(nav.children[0].children.length, 2);
		const pluginTab = nav.children[0].children[1];
		assert.equal(pluginTab.getAttribute('aria-disabled'), null);
		assert.equal(pluginTab.getAttribute('data-i18n'), 'presets.label');
	});

	it('resolveIconUrl() returns a static admin icon path for core panels', async function () {
		const { sandbox } = await loadLayoutSandbox();

		const url = await sandbox.window.__layoutFns.resolveIconUrl(
			{
				id: 'tab-messages',
				app: { icons: { any192: 'messages-192.png' } },
				_registryKey: 'messages',
			},
			'any192',
		);

		assert.equal(url, 'icons/messages/messages-192.png');
	});

	it('resolveIconUrl() returns the generic static host icon path for plugin panels', async function () {
		const requests = [];
		const { sandbox, blobUrls } = await loadLayoutSandbox({
			msghubRequest: async (command, payload) => {
				requests.push({ command, payload });
				return { command, payload };
			},
		});

		const url = await sandbox.window.__layoutFns.resolveIconUrl(
			{
				id: 'tab-plugin-IngestStates-0-presets',
				ui: { kind: 'plugin' },
				app: { name: 'presets.app.name', url: '?panel=tab-plugin-IngestStates-0-presets' },
			},
			'any192',
		);

		assert.equal(url, 'icons/pluginUI/pluginUI-192.png');
		assert.deepEqual(JSON.parse(JSON.stringify(requests)), []);
		assert.equal(blobUrls.length, 0);
	});

	it('resolveIconUrl() returns null when the slot is missing', async function () {
		const { sandbox } = await loadLayoutSandbox();

		const url = await sandbox.window.__layoutFns.resolveIconUrl(
			{
				id: 'tab-messages',
				app: { icons: {} },
				_registryKey: 'messages',
			},
			'any192',
		);

		assert.equal(url, null);
	});

	it('resolveIconUrl() returns null when no app block exists', async function () {
		const { sandbox } = await loadLayoutSandbox();

		const url = await sandbox.window.__layoutFns.resolveIconUrl(
			{
				id: 'tab-messages',
			},
			'any192',
		);

		assert.equal(url, null);
	});

	it('resolveIconUrl() returns the generic plugin host icon path even without plugin app.icons', async function () {
		const { sandbox } = await loadLayoutSandbox();

		const url = await sandbox.window.__layoutFns.resolveIconUrl(
			{
				id: 'tab-plugin-IngestStates-0-presets',
				ui: { kind: 'plugin' },
				app: { name: 'presets.app.name', url: '?panel=tab-plugin-IngestStates-0-presets' },
			},
			'any192',
		);

		assert.equal(url, 'icons/pluginUI/pluginUI-192.png');
	});

	it('resolveIconUrl() keeps the core owner key in the path and never uses the runtime tab id as a directory', async function () {
		const { sandbox } = await loadLayoutSandbox();

		const url = await sandbox.window.__layoutFns.resolveIconUrl(
			{
				id: 'tab-messages',
				app: { icons: { any192: 'messages-192.png' } },
				_registryKey: 'messages',
			},
			'any192',
		);

		assert.equal(url, 'icons/messages/messages-192.png');
		assert.equal(url.includes('tab-messages'), false);
		assert.equal(url.includes('/tab-'), false);
	});

	it('initTabs() returns null initial when all tabs are disabled', async function () {
		const { sandbox } = await loadLayoutSandbox();

		const tab1 = createElement('a');
		tab1.setAttribute('href', '#tab-messages');
		tab1.setAttribute('aria-disabled', 'true');
		tab1.classList = createClassList('msghub-tab is-disabled');

		const tab2 = createElement('a');
		tab2.setAttribute('href', '#tab-plugins');
		tab2.setAttribute('aria-disabled', 'true');
		tab2.classList = createClassList('msghub-tab is-disabled');

		const panel1 = createElement('div');
		const panel2 = createElement('div');

		sandbox.document.querySelectorAll = selector =>
			selector === '.msghub-tab' ? [tab1, tab2] : [];
		sandbox.document.getElementById = id => {
			if (id === 'tab-messages') return panel1;
			if (id === 'tab-plugins') return panel2;
			return null;
		};
		sandbox.location.hash = '';

		const result = sandbox.window.__layoutFns.initTabs({ defaultPanelId: 'messages' });

		assert.equal(result.initial, null, 'initial must be null when all tabs are disabled');
		assert.ok(typeof result.setActive === 'function', 'setActive must be returned even when no tab was activated');
		// Calling setActive must not throw.
		assert.doesNotThrow(() => result.setActive('tab-messages'));
	});

	it('initTabs() skips disabled hash candidate and activates first non-disabled tab', async function () {
		const { sandbox } = await loadLayoutSandbox();

		// tab1 is disabled; tab2 is enabled.
		const tab1 = createElement('a');
		tab1.setAttribute('href', '#tab-messages');
		tab1.setAttribute('aria-disabled', 'true');
		tab1.classList = createClassList('msghub-tab is-disabled');

		const tab2 = createElement('a');
		tab2.setAttribute('href', '#tab-plugins');
		tab2.classList = createClassList('msghub-tab');

		const panel1 = createElement('div');
		const panel2 = createElement('div');

		sandbox.document.querySelectorAll = selector =>
			selector === '.msghub-tab' ? [tab1, tab2] : [];
		sandbox.document.getElementById = id => {
			if (id === 'tab-messages') return panel1;
			if (id === 'tab-plugins') return panel2;
			return null;
		};
		// Hash points to the disabled tab.
		sandbox.location.hash = '#tab-messages';

		const result = sandbox.window.__layoutFns.initTabs({ defaultPanelId: 'messages' });

		// disabled hash candidate must be skipped; last-resort selects tab2.
		assert.notEqual(result.initial, 'tab-messages', 'disabled tab must not be chosen as initial');
		assert.equal(result.initial, 'tab-plugins', 'first non-disabled tab must be the initial selection');
		assert.ok(tab2.classList.contains('is-active'), 'non-disabled tab must be marked is-active');
	});

	it('loads CSS/JS assets and keeps ordering stable', async function () {
		const { sandbox, headElement } = await loadLayoutSandbox();
		const loadCssFiles = sandbox.window.__layoutFns.loadCssFiles;
		const loadJsFilesSequential = sandbox.window.__layoutFns.loadJsFilesSequential;

		const cssResult = await loadCssFiles(['a.css', 'b.css', 'a.css']);
		assert.deepEqual(JSON.parse(JSON.stringify(cssResult.failed)), []);

		await loadJsFilesSequential(['a.js', 'b.js', 'a.js']);
	});

	it('updateDocumentTitle() resolves descriptor label via t() and uses hyphen-MessageHub format', async function () {
		const { sandbox } = await loadLayoutSandbox({
			t: key => (key === 'messages.key' ? 'Messages' : key),
		});

		sandbox.window.__layoutFns.updateDocumentTitle({ id: 'tab-messages', label: 'messages.key' });
		assert.equal(sandbox.document.title, 'Messages - MessageHub');
	});

	it('updateDocumentTitle() ignores legacy language maps for descriptor labels', async function () {
		const { sandbox } = await loadLayoutSandbox({
			t: key => (key === 'messages.key' ? 'Messages' : key),
		});

		sandbox.window.__layoutFns.updateDocumentTitle({ id: 'tab-messages', label: { en: 'Messages' } });
		assert.equal(sandbox.document.title, 'MessageHub');
	});

	it('updateDocumentTitle() falls back to plain MessageHub when descriptor is undefined', async function () {
		const { sandbox } = await loadLayoutSandbox();

		sandbox.window.__layoutFns.updateDocumentTitle(undefined);
		assert.equal(sandbox.document.title, 'MessageHub');
	});

	it('updateDocumentTitle() uses panelDescriptors default lookup when called with no args', async function () {
		const { sandbox } = await loadLayoutSandbox({
			t: key => (key === 'messages.key' ? 'Messages' : key),
		});
		const { registerPanelDescriptor, activatePanel, updateDocumentTitle } = sandbox.window.__layoutFns;

		// Register descriptor and set the active panel id via activatePanel (needs panel in DOM).
		const panel = createElement('div');
		panel.id = 'tab-messages';
		panel.classList = createClassList('msghub-panel');
		sandbox.document.querySelectorAll = selector => (selector === '.msghub-panel' ? [panel] : []);

		registerPanelDescriptor({ id: 'tab-messages', label: 'messages.key' });
		activatePanel('tab-messages');

		// Now reset the title to verify the no-arg call re-applies it.
		sandbox.document.title = '';
		updateDocumentTitle();
		assert.equal(sandbox.document.title, 'Messages - MessageHub');
	});

	it('activatePanel() sets title from panelDescriptors via updateDocumentTitle', async function () {
		const { sandbox } = await loadLayoutSandbox({
			t: key => (key === 'messages.key' ? 'Messages' : key),
		});
		const activePanel = createElement('div');
		activePanel.id = 'tab-messages';
		activePanel.classList = createClassList('msghub-panel');
		const inactivePanel = createElement('div');
		inactivePanel.id = 'tab-stats';
		inactivePanel.classList = createClassList('msghub-panel');
		const toggleCalls = [];
		activePanel.toggleAttribute = (name, force) => {
			toggleCalls.push({ id: activePanel.id, name, force });
			return force !== false;
		};
		inactivePanel.toggleAttribute = (name, force) => {
			toggleCalls.push({ id: inactivePanel.id, name, force });
			return force !== false;
		};

		sandbox.document.querySelectorAll = selector => {
			if (selector === '.msghub-tab') { return []; }
			if (selector === '.msghub-panel') { return [activePanel, inactivePanel]; }
			return [];
		};

		// Register descriptor so activatePanel can resolve the title.
		sandbox.window.__layoutFns.registerPanelDescriptor({ id: 'tab-messages', label: 'messages.key' });
		sandbox.window.__layoutFns.activatePanel('tab-messages');

		assert.equal(sandbox.document.title, 'Messages - MessageHub');
		assert.deepEqual(JSON.parse(JSON.stringify(toggleCalls)), [
			{ id: 'tab-messages', name: 'hidden', force: false },
			{ id: 'tab-stats', name: 'hidden', force: true },
		]);
	});

	it('initTabs() activates first panel and resolves title via panelDescriptors', async function () {
		const { sandbox } = await loadLayoutSandbox({
			t: key => (key === 'messages.key' ? 'Messages' : key),
		});
		const tab = createElement('a');
		tab.setAttribute('href', '#tab-messages');
		tab.classList = createClassList('msghub-tab');
		const panel = createElement('div');
		panel.id = 'tab-messages';
		panel.classList = createClassList('msghub-panel');

		sandbox.document.querySelectorAll = selector => {
			if (selector === '.msghub-tab') { return [tab]; }
			if (selector === '.msghub-panel') { return [panel]; }
			return [];
		};
		sandbox.document.getElementById = id => (id === 'tab-messages' ? panel : null);

		// Register descriptor before initTabs so the first activation resolves the title.
		sandbox.window.__layoutFns.registerPanelDescriptor({ id: 'tab-messages', label: 'messages.key' });
		sandbox.window.__layoutFns.initTabs({ defaultPanelId: 'messages' });

		assert.equal(sandbox.document.title, 'Messages - MessageHub');
	});

	it('buildLayoutFromRegistry() stores the correct core panel descriptor and mount ids', async function () {
		// normalizeCorePanel is layout-internal. Its effects are tested through real consumers:
		// - activatePanel resolves title via panelDescriptors (proves id + label were stored correctly)
		// - the panel container and mount div ids prove the canonical id and mountId derivation
		const { sandbox, layoutHost } = await loadLayoutSandbox({
			t: key => (key === 'messages.key' ? 'Messages' : key),
		});
		const { buildLayoutFromRegistry, activatePanel } = sandbox.window.__layoutFns;

		buildLayoutFromRegistry();

		// id + label: panelDescriptors.get('tab-messages') must exist and carry label 'messages.key'.
		// If id normalization were wrong, the lookup would miss and title would be 'MessageHub'.
		activatePanel('tab-messages');
		assert.equal(sandbox.document.title, 'Messages - MessageHub');

		// Mount container derivation: buildLayoutFromRegistry creates a div[id="messages-root"]
		// inside the panel container, derived from the local producer id.
		const fragment = layoutHost.children[0];
		const messagesPanel = fragment?.children?.find(c => c?.getAttribute?.('id') === 'tab-messages');
		assert.ok(messagesPanel, 'panel container div with id="tab-messages" must be created');
		const mountDiv = messagesPanel?.children?.find(c => c?.getAttribute?.('id') === 'messages-root');
		assert.ok(mountDiv, 'mount container with id="messages-root" must exist inside the panel div');
	});

	it('buildLayoutFromRegistry() passes category from core panel def through to stored descriptors but strips surface', async function () {
		const { sandbox } = await loadLayoutSandbox({
			t: key => (key === 'messages.key' ? 'Messages' : key),
		});
		const { buildLayoutFromRegistry, activatePanel } = sandbox.window.__layoutFns;

		const currentView = sandbox.window.__layoutFns.getActiveView();
		sandbox.window.__layoutFns.setActiveView({
			...currentView,
			corePanels: {
				...currentView.corePanels,
				messages: {
					...currentView.corePanels.messages,
					surface: 'admin',
					category: 'dashboard',
				},
			},
		});

		// Spy: buildLayoutFromRegistry resolves registerPanelDescriptor via the sandbox global.
		// Replacing it after load intercepts the internal call without altering the stored result.
		const registeredDescriptors = [];
		const originalRegister = sandbox.registerPanelDescriptor;
		sandbox.registerPanelDescriptor = d => {
			registeredDescriptors.push(d);
			originalRegister(d);
		};

		buildLayoutFromRegistry();

		// Non-regression: title resolves correctly after normalization.
		activatePanel('tab-messages');
		assert.equal(sandbox.document.title, 'Messages - MessageHub');

		const messageDescriptor = registeredDescriptors.find(d => d.id === 'tab-messages');
		assert.ok(messageDescriptor, 'descriptor for tab-messages must have been registered');
		assert.equal(messageDescriptor.surface, undefined, 'surface must not be normalized into panel descriptors');
		assert.equal(messageDescriptor.category, 'dashboard', 'category must be passed through from panel def');
	});

	it('renderPanelModeError() uses t() to resolve the error key and renders it', async function () {
		const tCalls = [];
		const { sandbox, layoutHost } = await loadLayoutSandbox({
			t: key => { tCalls.push(key); return `TRANSLATED:${key}`; },
		});
		sandbox.window.__layoutFns.renderPanelModeError('msghub.i18n.core.admin.ui.panel.error.unknownTarget.text');

		assert.ok(
			tCalls.includes('msghub.i18n.core.admin.ui.panel.error.unknownTarget.text'),
			't() must be called with the error key',
		);
		assert.equal(layoutHost.children.length, 1, 'layout host must contain the error element');
		const errorEl = layoutHost.children[0];
		assert.ok(String(errorEl.className || '').includes('msghub-panel-mode-error'), 'error element must carry msghub-panel-mode-error class');
		assert.equal(
			errorEl.getAttribute('text') || errorEl.textContent || '',
			'TRANSLATED:msghub.i18n.core.admin.ui.panel.error.unknownTarget.text',
			'error text must come from t(), not a raw string',
		);
	});

	it('normalizePluginPanel() produces a canonical PanelDescriptor for a plugin contribution', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const { normalizePluginPanel } = sandbox.window.__layoutFns;

		const contrib = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets', label: 'msghub.i18n.IngestStates.ui.panels.presets.label' };
		const pluginRef = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' };
		const descriptor = normalizePluginPanel(contrib, pluginRef);

		assert.equal(descriptor.id, 'tab-plugin-IngestStates-0-presets');
		assert.equal(descriptor.label, 'msghub.i18n.IngestStates.ui.panels.presets.label');
		assert.equal(descriptor.ui.kind, 'plugin');
		assert.equal(descriptor.ui.loader, 'esm');
	});

	it('normalizePluginPanel() passes contrib.app through to descriptor', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const { normalizePluginPanel } = sandbox.window.__layoutFns;

		const app = { name: 'msghub.i18n.IngestStates.ui.panels.presets.app.name', url: '?panel=tab-plugin-IngestStates-0-presets' };
		const contrib = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets', label: 'key', app };
		const descriptor = normalizePluginPanel(contrib, { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' });

		assert.strictEqual(descriptor.app, app);
	});

	it('normalizePluginPanel() with no contrib.app yields descriptor.app === undefined', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const { normalizePluginPanel } = sandbox.window.__layoutFns;

		const contrib = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets', label: 'key' };
		const descriptor = normalizePluginPanel(contrib, { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' });

		assert.equal(descriptor.app, undefined, 'descriptor.app must be undefined when contrib carries no app block');
	});

	it('normalizePluginPanel() strips contrib.surface from the descriptor', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const { normalizePluginPanel } = sandbox.window.__layoutFns;

		const contrib = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets', label: 'key', surface: 'web' };
		const descriptor = normalizePluginPanel(contrib, { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' });

		assert.equal(descriptor.surface, undefined);
	});

	it('normalizePluginPanel() passes contrib.category through to descriptor', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const { normalizePluginPanel } = sandbox.window.__layoutFns;

		const contrib = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets', label: 'key', category: 'dashboard' };
		const descriptor = normalizePluginPanel(contrib, { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' });

		assert.equal(descriptor.category, 'dashboard');
	});

	it('normalizePluginPanel() leaves category undefined when absent from contrib', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const { normalizePluginPanel } = sandbox.window.__layoutFns;

		const contrib = { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets', label: 'key' };
		const descriptor = normalizePluginPanel(contrib, { pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' });

		assert.equal(descriptor.category, undefined);
	});

	it('registerPanelDescriptor() + updateDocumentTitle() round-trip (panelDescriptors map verified indirectly)', async function () {
		const { sandbox } = await loadLayoutSandbox({
			t: key => (key === 'presets.label' ? 'Presets' : key),
		});
		const { registerPanelDescriptor, activatePanel, updateDocumentTitle } = sandbox.window.__layoutFns;

		const panel = createElement('div');
		panel.id = 'tab-plugin-IngestStates-0-presets';
		panel.classList = createClassList('msghub-panel');
		sandbox.document.querySelectorAll = selector => (selector === '.msghub-panel' ? [panel] : []);

		registerPanelDescriptor({ id: 'tab-plugin-IngestStates-0-presets', label: 'presets.label' });
		activatePanel('tab-plugin-IngestStates-0-presets');

		// Verify round-trip: no-arg updateDocumentTitle resolves registered descriptor.
		sandbox.document.title = '';
		updateDocumentTitle();
		assert.equal(sandbox.document.title, 'Presets - MessageHub');
	});

	it('buildLayoutFromRegistry() registers descriptors and sets data-i18n to label', async function () {
		const { sandbox, layoutHost } = await loadLayoutSandbox({
			t: key => (key === 'stats.key' ? 'Stats' : key),
		});
		const { buildLayoutFromRegistry, updateDocumentTitle, activatePanel } = sandbox.window.__layoutFns;

		buildLayoutFromRegistry();

		// After build, activating a native panel should resolve title via registered descriptor.
		const panel = layoutHost.children[0]?.children[1]; // nav[0], first panel[1]
		if (panel) {
			panel.classList = createClassList('msghub-panel');
			sandbox.document.querySelectorAll = selector => (selector === '.msghub-panel' ? [panel] : []);
		}

		activatePanel('tab-stats');
		assert.equal(sandbox.document.title, 'Stats - MessageHub');
	});

	it('buildLayoutFromRegistry() keeps unresolved plugin tabs neutral before admin i18n has loaded', async function () {
		const { sandbox, layoutHost } = await loadLayoutSandbox({
			t: key => String(key || ''),
		});
		sandbox.window.__layoutFns.setActiveView({
			composition: {
				id: 'adminTab',
				layout: 'tabs',
				panels: ['messages', { type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' }],
				defaultPanel: 'messages',
			},
			corePanels: {
				messages: {
					id: 'messages',
					label: 'messages.key',
				},
			},
			request: { mode: 'composition', targetId: 'adminTab' },
		});

		sandbox.window.__layoutFns.buildLayoutFromRegistry();

		const fragment = layoutHost.children[0];
		const nav = fragment?.children?.[0];
		const pluginTab = nav?.children?.[0]?.children?.[1] || null;
		assert.ok(pluginTab, 'plugin loading tab must be rendered');
		assert.equal(pluginTab.getAttribute('data-i18n'), null);
		assert.equal(pluginTab.textContent, '...');
		assert.equal(
			pluginTab.textContent.includes('msghub.i18n.'),
			false,
			'plugin loading tab must not expose a raw i18n key before admin i18n has loaded',
		);
	});

	it('updateDocumentTitle() sets theme-color meta when descriptor.app.themeColor is present', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const { updateDocumentTitle } = sandbox.window.__layoutFns;

		await updateDocumentTitle({
			id: 'tab-messages',
			label: 'messages.key',
			_registryKey: 'messages',
			app: { themeColor: '#1f6a53', name: 'App', icons: { any192: 'messages-192.png' } },
		});

		const meta = sandbox.document.head.querySelector('meta[name="theme-color"]');
		assert.ok(meta, 'theme-color meta must exist in head after applyAppHeadMeta');
		assert.equal(meta.getAttribute('content'), '#1f6a53');
	});

	it('updateDocumentTitle() sets application-name meta with t()-resolved name', async function () {
		const { sandbox } = await loadLayoutSandbox({
			t: key => (key === 'some.name.key' ? 'App Name' : key),
		});
		const { updateDocumentTitle } = sandbox.window.__layoutFns;

		await updateDocumentTitle({
			id: 'tab-messages',
			label: 'messages.key',
			_registryKey: 'messages',
			app: { name: 'some.name.key', icons: { any192: 'messages-192.png' } },
		});

		const meta = sandbox.document.head.querySelector('meta[name="application-name"]');
		assert.ok(meta, 'application-name meta must exist');
		assert.equal(meta.getAttribute('content'), 'App Name');
	});

	it('updateDocumentTitle() uses shortName for apple-mobile-web-app-title when present', async function () {
		const { sandbox } = await loadLayoutSandbox({
			t: key => {
				if (key === 'short.key') return 'Short';
				if (key === 'name.key') return 'Name';
				return key;
			},
		});
		const { updateDocumentTitle } = sandbox.window.__layoutFns;

		await updateDocumentTitle({
			id: 'tab-messages',
			label: 'messages.key',
			_registryKey: 'messages',
			app: { name: 'name.key', shortName: 'short.key', icons: { any192: 'messages-192.png' } },
		});

		const meta = sandbox.document.head.querySelector('meta[name="apple-mobile-web-app-title"]');
		assert.ok(meta, 'apple-mobile-web-app-title meta must exist');
		assert.equal(meta.getAttribute('content'), 'Short');
	});

	it('updateDocumentTitle() falls back apple-mobile-web-app-title to name when shortName absent', async function () {
		const { sandbox } = await loadLayoutSandbox({
			t: key => (key === 'name.key' ? 'Name' : key),
		});
		const { updateDocumentTitle } = sandbox.window.__layoutFns;

		await updateDocumentTitle({
			id: 'tab-messages',
			label: 'messages.key',
			_registryKey: 'messages',
			app: { name: 'name.key', icons: { any192: 'messages-192.png' } },
		});

		const meta = sandbox.document.head.querySelector('meta[name="apple-mobile-web-app-title"]');
		assert.ok(meta, 'apple-mobile-web-app-title meta must exist');
		assert.equal(meta.getAttribute('content'), 'Name');
	});

	it('updateDocumentTitle() removes all three meta tags when descriptor has no app block', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const { updateDocumentTitle } = sandbox.window.__layoutFns;

		// First apply meta tags via a descriptor with app.
		await updateDocumentTitle({
			id: 'tab-messages',
			label: 'messages.key',
			_registryKey: 'messages',
			app: { themeColor: '#1f6a53', name: 'App', icons: { any192: 'messages-192.png' } },
		});
		assert.ok(
			sandbox.document.head.querySelector('meta[name="theme-color"]'),
			'theme-color must exist before panel switch',
		);

		// Switch to a descriptor without app — all three managed meta tags must be removed.
		await updateDocumentTitle({ id: 'tab-stats', label: 'stats.key' });

		assert.equal(sandbox.document.head.querySelector('meta[name="theme-color"]'), null, 'theme-color must be removed');
		assert.equal(
			sandbox.document.head.querySelector('meta[name="application-name"]'),
			null,
			'application-name must be removed',
		);
		assert.equal(
			sandbox.document.head.querySelector('meta[name="apple-mobile-web-app-title"]'),
			null,
			'apple-mobile-web-app-title must be removed',
		);
	});

	it('applyAppHeadMeta is idempotent: repeated calls overwrite without creating duplicate tags', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const { updateDocumentTitle } = sandbox.window.__layoutFns;

		await updateDocumentTitle({
			id: 'tab-messages',
			label: 'messages.key',
			_registryKey: 'messages',
			app: { themeColor: '#111', name: 'First', icons: { any192: 'messages-192.png' } },
		});
		await updateDocumentTitle({
			id: 'tab-messages',
			label: 'messages.key',
			_registryKey: 'messages',
			app: { themeColor: '#222', name: 'Second', icons: { any192: 'messages-192.png' } },
		});

		const metas = sandbox.document.head.children.filter(c => c.getAttribute('name') === 'theme-color');
		assert.equal(metas.length, 1, 'must have exactly one theme-color meta tag after two calls');
		assert.equal(metas[0].getAttribute('content'), '#222', 'content must be from the second call');
	});

	it('resetAppHeadMeta() is idempotent: no error when meta tags are absent', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const { updateDocumentTitle } = sandbox.window.__layoutFns;

		// Call with no app block on a fresh head — tags are absent; must not throw.
		assert.doesNotThrow(() => {
			void updateDocumentTitle({ id: 'tab-messages', label: 'messages.key' });
		});
	});

	it('updateDocumentTitle() removes app head tags again when switching from an app panel to a plain panel', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const { updateDocumentTitle } = sandbox.window.__layoutFns;

		await updateDocumentTitle({
			id: 'tab-plugin-IngestStates-0-presets',
			label: 'Presets',
			ui: { kind: 'plugin' },
			app: {
				name: 'Ingest States',
				themeColor: '#333',
			},
		});

		assert.equal(sandbox.document.title, 'Presets - MessageHub');
		const nameMeta = sandbox.document.head.querySelector('meta[name="application-name"]');
		assert.ok(nameMeta, 'application-name meta must exist');
		assert.equal(nameMeta.getAttribute('content'), 'Ingest States');

		// Switch to a no-app panel — all three tags must be removed.
		await updateDocumentTitle({ id: 'tab-messages', label: 'messages.key' });

		assert.equal(
			sandbox.document.head.querySelector('meta[name="theme-color"]'),
			null,
			'theme-color must be removed after panel switch',
		);
		assert.equal(
			sandbox.document.head.querySelector('meta[name="application-name"]'),
			null,
			'application-name must be removed after panel switch',
		);
	});

	it('generateManifest() resolves localized app text, keeps only install-manifest slots, and falls back short_name to name', async function () {
		const { sandbox } = await loadLayoutSandbox({
			t: key => {
				if (key === 'app.name') return 'Messages';
				if (key === 'app.short') return 'Msgs';
				return key;
			},
			location: {
				href: 'http://192.168.4.4:8081/adapter/msghub/tab.html?instance=0&theme=light&lang=es#tab-plugins',
			},
		});
		const { generateManifest } = sandbox.window.__layoutFns;

		const descriptor = {
			id: 'tab-messages',
			app: {
				name: 'app.name',
				shortName: 'app.short',
				url: '?panel=tab-messages',
				display: 'standalone',
				themeColor: '#123456',
				backgroundColor: '#abcdef',
			},
		};
		const manifest = generateManifest(descriptor, {
			any192: {
				src: 'http://192.168.4.4:8081/adapter/msghub/icons/messages/messages-192.png',
				mimeType: 'image/png',
			},
			any512: {
				src: 'http://192.168.4.4:8081/adapter/msghub/icons/messages/messages-512.png',
				mimeType: 'image/png',
			},
			maskable192: {
				src: 'http://192.168.4.4:8081/adapter/msghub/icons/messages/messages-maskable-192.png',
				mimeType: 'image/png',
			},
			maskable512: {
				src: 'http://192.168.4.4:8081/adapter/msghub/icons/messages/messages-maskable-512.png',
				mimeType: 'image/png',
			},
			apple180: {
				src: 'http://192.168.4.4:8081/adapter/msghub/icons/messages/messages-apple-180.png',
				mimeType: 'image/png',
			},
		});

		assert.equal(manifest.name, 'Messages');
		assert.equal(manifest.short_name, 'Msgs');
		assert.equal(manifest.start_url, 'http://192.168.4.4:8081/adapter/msghub/tab.html?panel=tab-messages');
		assert.equal(manifest.id, 'http://192.168.4.4:8081/adapter/msghub/tab.html?panel=tab-messages');
		assert.equal(manifest.display, 'standalone');
		assert.equal(manifest.theme_color, '#123456');
		assert.equal(manifest.background_color, '#abcdef');
		assert.equal(manifest.icons.length, 4);
		assert.deepEqual(
			JSON.parse(JSON.stringify(manifest.icons.map(icon => ({ sizes: icon.sizes, purpose: icon.purpose || 'any' })))),
			[
				{ sizes: '192x192', purpose: 'any' },
				{ sizes: '512x512', purpose: 'any' },
				{ sizes: '192x192', purpose: 'maskable' },
				{ sizes: '512x512', purpose: 'maskable' },
			],
		);
		assert.equal(
			manifest.icons.every(icon => String(icon.src).startsWith('http://192.168.4.4:8081/adapter/msghub/icons/')),
			true,
		);
		assert.equal(manifest.icons.some(icon => icon.src.includes('apple-180')), false);

		const fallbackManifest = generateManifest(
			{
				id: 'tab-messages',
				app: {
					name: 'app.name',
					url: '?panel=tab-messages',
				},
			},
			{
				any192: {
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/messages/messages-192.png',
					mimeType: 'image/png',
				},
			},
		);
		assert.equal(fallbackManifest.short_name, 'Messages');
		assert.equal(fallbackManifest.start_url, 'http://192.168.4.4:8081/adapter/msghub/tab.html?panel=tab-messages');
		assert.equal(fallbackManifest.icons.length, 1);
	});

	it('generateManifest() resolves an absolute runtime app URL from the current shell entry context', async function () {
		const { sandbox } = await loadLayoutSandbox({
			location: { href: 'https://example.test:8443/web/msg-hub/index.html?instance=0#tab-messages' },
		});
		const { generateManifest } = sandbox.window.__layoutFns;

		const manifest = generateManifest(
			{
				id: 'tab-messages',
				app: {
					name: 'app.name',
					url: '?panel=tab-messages',
				},
			},
			{},
		);

		assert.equal(manifest.start_url, 'https://example.test:8443/web/msg-hub/index.html?panel=tab-messages');
		assert.equal(manifest.id, 'https://example.test:8443/web/msg-hub/index.html?panel=tab-messages');
	});

	it('generateManifest() uses the same absolute consumer path for core and plugin app targets', async function () {
		const { sandbox } = await loadLayoutSandbox({
			location: { href: 'http://192.168.4.4:8081/adapter/msghub/tab.html?instance=0&theme=light#tab-plugins' },
		});
		const { generateManifest } = sandbox.window.__layoutFns;

		const messagesManifest = generateManifest(
			{
				id: 'tab-messages',
				app: {
					name: 'app.name',
					url: '?panel=tab-messages',
				},
			},
			{},
		);
		const presetsManifest = generateManifest(
			{
				id: 'tab-plugin-IngestStates-0-presets',
				app: {
					name: 'app.name',
					url: '?panel=tab-plugin-IngestStates-0-presets',
				},
			},
			{},
		);

		assert.equal(messagesManifest.start_url, 'http://192.168.4.4:8081/adapter/msghub/tab.html?panel=tab-messages');
		assert.equal(messagesManifest.id, messagesManifest.start_url);
		assert.equal(
			presetsManifest.start_url,
			'http://192.168.4.4:8081/adapter/msghub/tab.html?panel=tab-plugin-IngestStates-0-presets',
		);
		assert.equal(presetsManifest.id, presetsManifest.start_url);
	});

	it('updateDocumentTitle() writes manifest, Apple icon, and all four managed meta tags for a core app descriptor', async function () {
		const { sandbox, blobUrls, fetchCalls } = await loadLayoutSandbox({
			t: key => {
				if (key === 'app.name') return 'Messages';
				if (key === 'app.short') return 'Msgs';
				return key;
			},
			location: {
				href: 'http://192.168.4.4:8081/adapter/msghub/tab.html?instance=0&theme=light&lang=es#tab-messages',
			},
		});
		const { updateDocumentTitle } = sandbox.window.__layoutFns;

		await updateDocumentTitle({
			id: 'tab-messages',
			label: 'messages.key',
			_registryKey: 'messages',
			app: {
				name: 'app.name',
				shortName: 'app.short',
				url: '?panel=tab-messages',
				display: 'standalone',
				themeColor: '#1f6a53',
				backgroundColor: '#0c1014',
				icons: {
					any192: 'messages-192.png',
					any512: 'messages-512.png',
					maskable192: 'messages-maskable-192.png',
					maskable512: 'messages-maskable-512.png',
					apple180: 'messages-apple-180.png',
				},
			},
		});

		assert.equal(sandbox.document.head.querySelector('meta[name="theme-color"]').getAttribute('content'), '#1f6a53');
		assert.equal(sandbox.document.head.querySelector('meta[name="application-name"]').getAttribute('content'), 'Messages');
		assert.equal(sandbox.document.head.querySelector('meta[name="apple-mobile-web-app-title"]').getAttribute('content'), 'Msgs');
		assert.equal(sandbox.document.head.querySelector('meta[name="apple-mobile-web-app-capable"]').getAttribute('content'), 'yes');

		const appleLink = sandbox.document.head.querySelector('link[rel="apple-touch-icon"]');
		assert.ok(appleLink);
		assert.equal(appleLink.getAttribute('href'), 'icons/messages/messages-apple-180.png');
		assert.equal(appleLink.getAttribute('href').includes('tab-messages'), false);

		const manifestLink = sandbox.document.head.querySelector('link[rel="manifest"]');
		assert.ok(manifestLink);
		assert.equal(manifestLink.getAttribute('href'), 'blob:test-1');
		assert.equal(blobUrls.length, 1);
		assert.equal(blobUrls[0].blob.type, 'application/manifest+json');

		const manifest = JSON.parse(blobUrls[0].blob.parts[0]);
		assert.equal(manifest.name, 'Messages');
		assert.equal(manifest.short_name, 'Msgs');
		assert.equal(manifest.start_url, 'http://192.168.4.4:8081/adapter/msghub/tab.html?panel=tab-messages');
		assert.equal(manifest.id, 'http://192.168.4.4:8081/adapter/msghub/tab.html?panel=tab-messages');
		assert.equal(manifest.icons.length, 4);
		assert.deepEqual(
			JSON.parse(JSON.stringify(manifest.icons.map(icon => ({ src: icon.src, sizes: icon.sizes, purpose: icon.purpose || 'any' })))),
			[
				{
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/messages/messages-192.png',
					sizes: '192x192',
					purpose: 'any',
				},
				{
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/messages/messages-512.png',
					sizes: '512x512',
					purpose: 'any',
				},
				{
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/messages/messages-maskable-192.png',
					sizes: '192x192',
					purpose: 'maskable',
				},
				{
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/messages/messages-maskable-512.png',
					sizes: '512x512',
					purpose: 'maskable',
				},
			],
		);
		assert.equal(manifest.icons.some(icon => icon.src.includes('/tab-')), false);
		assert.deepEqual(fetchCalls, []);
	});

	it('updateDocumentTitle() uses generic static host icons for a plugin app descriptor and only revokes the manifest blob', async function () {
		const requests = [];
		const { sandbox, blobUrls, revokedUrls } = await loadLayoutSandbox({
			msghubRequest: async (command, payload) => {
				requests.push({ command, payload });
				return { command, payload };
			},
			location: {
				href: 'http://192.168.4.4:8081/adapter/msghub/tab.html?instance=0&theme=light&lang=es#tab-plugins',
			},
		});
		const { updateDocumentTitle } = sandbox.window.__layoutFns;

		await updateDocumentTitle({
			id: 'tab-plugin-IngestStates-0-presets',
			label: 'presets.label',
			ui: { kind: 'plugin' },
			app: {
				name: 'presets.app.name',
				url: '?panel=tab-plugin-IngestStates-0-presets',
			},
		});

		const appleLink = sandbox.document.head.querySelector('link[rel="apple-touch-icon"]');
		const manifestLink = sandbox.document.head.querySelector('link[rel="manifest"]');
		assert.ok(appleLink);
		assert.ok(manifestLink);
		assert.equal(appleLink.getAttribute('href'), 'icons/pluginUI/pluginUI-apple-180.png');
		assert.equal(manifestLink.getAttribute('href'), 'blob:test-1');
		assert.deepEqual(JSON.parse(JSON.stringify(revokedUrls)), []);
		assert.equal(requests.length, 0);

		const manifest = JSON.parse(blobUrls[0].blob.parts[0]);
		assert.equal(
			manifest.start_url,
			'http://192.168.4.4:8081/adapter/msghub/tab.html?panel=tab-plugin-IngestStates-0-presets',
		);
		assert.equal(manifest.id, 'http://192.168.4.4:8081/adapter/msghub/tab.html?panel=tab-plugin-IngestStates-0-presets');
		assert.equal(manifest.icons.length, 4);
		assert.deepEqual(
			JSON.parse(JSON.stringify(manifest.icons.map(icon => ({ src: icon.src, sizes: icon.sizes, purpose: icon.purpose || 'any' })))),
			[
				{
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/pluginUI/pluginUI-192.png',
					sizes: '192x192',
					purpose: 'any',
				},
				{
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/pluginUI/pluginUI-512.png',
					sizes: '512x512',
					purpose: 'any',
				},
				{
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/pluginUI/pluginUI-maskable-192.png',
					sizes: '192x192',
					purpose: 'maskable',
				},
				{
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/pluginUI/pluginUI-maskable-512.png',
					sizes: '512x512',
					purpose: 'maskable',
				},
			],
		);
		assert.equal(manifest.icons.some(icon => icon.src.includes('/tab-')), false);

		await updateDocumentTitle({ id: 'tab-stats', label: 'stats.key' });

		assert.equal(sandbox.document.head.querySelector('link[rel="apple-touch-icon"]'), null);
		assert.equal(sandbox.document.head.querySelector('link[rel="manifest"]'), null);
		assert.equal(sandbox.document.head.querySelector('meta[name="apple-mobile-web-app-capable"]'), null);
		assert.deepEqual(JSON.parse(JSON.stringify(revokedUrls)), ['blob:test-1']);
	});

	it('plugin bundle i18n merge feeds the real shell head/manifest path with visible plugin text', async function () {
		const { sandbox, blobUrls, registerElement } = await loadRuntimeBackedLayoutSandbox({
			location: {
				href: 'http://192.168.4.4:8081/adapter/msghub/tab.html?instance=0&theme=light&lang=es&locale=en-US&expert=true#tab-plugins',
			},
		});
		const descriptor = {
			id: 'tab-plugin-IngestStates-0-presets',
			label: 'msghub.i18n.IngestStates.ui.panels.presets.label',
			ui: { kind: 'plugin' },
			app: {
				name: 'msghub.i18n.IngestStates.ui.panels.presets.app.name',
				shortName: 'msghub.i18n.IngestStates.ui.panels.presets.app.shortName',
				url: '?panel=tab-plugin-IngestStates-0-presets',
			},
		};
		const panel = createElement('div');
		panel.id = descriptor.id;
		panel.className = 'msghub-panel';
		panel.classList = createClassList('msghub-panel');
		registerElement(panel);

		sandbox.window.__runtimeFns.mergePluginI18n('IngestStates', {
			'msghub.i18n.IngestStates.ui.panels.presets.label': 'Preset Editor',
			'msghub.i18n.IngestStates.ui.panels.presets.app.name': 'Preset Editor',
			'msghub.i18n.IngestStates.ui.panels.presets.app.shortName': 'Presets',
		});
		sandbox.window.__layoutFns.registerPanelDescriptor(descriptor);
		sandbox.window.__layoutFns.activatePanel(descriptor.id);
		await sandbox.window.__layoutFns.updateDocumentTitle();

		assert.equal(sandbox.document.title, 'Preset Editor - MessageHub');
		assert.equal(
			sandbox.document.head.querySelector('meta[name="application-name"]').getAttribute('content'),
			'Preset Editor',
		);
		assert.equal(
			sandbox.document.head.querySelector('meta[name="apple-mobile-web-app-title"]').getAttribute('content'),
			'Presets',
		);
		assert.equal(
			sandbox.document.title.includes('msghub.i18n.'),
			false,
			'document.title must not expose the raw plugin i18n key',
		);

		const manifest = JSON.parse(blobUrls[blobUrls.length - 1].blob.parts[0]);
		assert.equal(manifest.name, 'Preset Editor');
		assert.equal(manifest.short_name, 'Presets');
		assert.equal(
			manifest.start_url,
			'http://192.168.4.4:8081/adapter/msghub/tab.html?panel=tab-plugin-IngestStates-0-presets',
		);
		assert.equal(manifest.id, 'http://192.168.4.4:8081/adapter/msghub/tab.html?panel=tab-plugin-IngestStates-0-presets');
		assert.deepEqual(
			JSON.parse(JSON.stringify(manifest.icons.map(icon => ({ src: icon.src, sizes: icon.sizes, purpose: icon.purpose || 'any' })))),
			[
				{
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/pluginUI/pluginUI-192.png',
					sizes: '192x192',
					purpose: 'any',
				},
				{
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/pluginUI/pluginUI-512.png',
					sizes: '512x512',
					purpose: 'any',
				},
				{
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/pluginUI/pluginUI-maskable-192.png',
					sizes: '192x192',
					purpose: 'maskable',
				},
				{
					src: 'http://192.168.4.4:8081/adapter/msghub/icons/pluginUI/pluginUI-maskable-512.png',
					sizes: '512x512',
					purpose: 'maskable',
				},
			],
		);
		assert.equal(
			manifest.name.includes('msghub.i18n.'),
			false,
			'manifest text must come from the merged runtime dictionary, not the raw key',
		);
	});

	it('buildLayoutFromRegistry() renders a category marker for native and resolved plugin panels', async function () {
		const { sandbox, layoutHost } = await loadLayoutSandbox();
		sandbox.window.__layoutFns.setActiveView({
			composition: {
				id: 'adminTab',
				layout: 'tabs',
				panels: [
					'messages',
					{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
				],
				defaultPanel: 'messages',
			},
			corePanels: {
				messages: {
					id: 'messages',
					label: 'messages.key',
					category: 'dashboard',
				},
			},
			pluginPanels: {
				'plugin-IngestStates-0-presets': {
					id: 'plugin-IngestStates-0-presets',
					label: 'presets.label',
					category: 'user',
					ui: { kind: 'plugin', loader: 'esm', apiVersion: '1', bundle: { hash: 'h1' } },
				},
			},
			request: { mode: 'composition', targetId: 'adminTab' },
		});

		sandbox.window.__layoutFns.buildLayoutFromRegistry();

		const fragment = layoutHost.children[0];
		const nativePanel = fragment.children[1];
		const pluginPanel = fragment.children[2];
		assert.ok(nativePanel.children.find(child => String(child.className || '').includes('msghub-paneltype-dashboard')));
		assert.ok(pluginPanel.children.find(child => String(child.className || '').includes('msghub-paneltype-user')));
	});

});
