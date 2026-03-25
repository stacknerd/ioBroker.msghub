/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRepoFile } = require('./_test.utils');

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
			this.children.push(child);
			return child;
		},
		replaceChildren(...children) {
			this.children = [...children];
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
		remove() {},
	};
	return element;
}

async function loadLayoutSandbox(options = {}) {
	const source = await readRepoFile('admin/tab/layout.js');
	const expose = `
	window.__layoutFns = {
		initTabs,
		h,
		resolveViewId,
		getActiveComposition,
		buildLayoutFromRegistry,
		loadCssFiles,
	loadJsFilesSequential,
	computeAssetsForComposition,
	getPanelDefinition,
	renderPanelBootError
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
	const documentObject = {
		head: headElement,
		documentElement: {
			getAttribute: key => (key === 'data-msghub-view' ? (options.viewIdAttr || 'adminTab') : ''),
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

	const sandbox = {
		window: windowObject,
		document: documentObject,
		location: { hash: '' },
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
			win: {
				MsghubAdminTabRegistry: {
				panels: {
					stats: {
						mountId: 'stats-root',
						titleKey: 'stats.key',
						assets: { css: ['tab/panels/stats/styles.css'], js: ['tab/panels/stats/index.js'] },
					},
					messages: {
						mountId: 'messages-root',
						titleKey: 'messages.key',
						assets: { css: ['tab/panels/messages/styles.css'], js: ['tab/panels/messages/index.js'] },
					},
				},
				compositions: {
					adminTab: {
						layout: 'tabs',
						panels: ['stats', 'messages'],
						defaultPanel: 'messages',
					},
				},
				},
			},
			args: options.args || {},
			urlThemeLocked: options.urlThemeLocked === true,
			applyTheme: options.applyTheme || (theme => appliedThemes.push(String(theme))),
			detectTheme: options.detectTheme || (() => 'light'),
			readThemeFromTopWindow: options.readThemeFromTopWindow || (() => null),
			MutationObserver: class {
				constructor(callback) {
					this.callback = callback;
					observerCallbacks.push(callback);
				}
				observe() {}
			},
		};

	vm.runInNewContext(`${source}\n${expose}`, sandbox, { filename: 'admin/tab/layout.js' });
	return { sandbox, layoutHost, allLinks, allScripts, headElement, listeners, intervalCallbacks, observerCallbacks, appliedThemes };
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

	it('builds composition assets without duplicates', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const computeAssetsForComposition = sandbox.window.__layoutFns.computeAssetsForComposition;

		const assets = computeAssetsForComposition(['stats', 'messages', 'stats']);
		assert.deepEqual(JSON.parse(JSON.stringify(assets.css)), [
			'tab/panels/stats/styles.css',
			'tab/panels/messages/styles.css',
		]);
		assert.deepEqual(JSON.parse(JSON.stringify(assets.js)), [
			'tab/panels/stats/index.js',
			'tab/panels/messages/index.js',
		]);
	});

	it('returns panel definitions, resolved view id, and active composition from registry defaults', async function () {
		const { sandbox } = await loadLayoutSandbox();

		const getPanelDefinition = sandbox.window.__layoutFns.getPanelDefinition;
		const resolveViewId = sandbox.window.__layoutFns.resolveViewId;
		const getActiveComposition = sandbox.window.__layoutFns.getActiveComposition;

		assert.ok(getPanelDefinition('stats'));
		assert.equal(getPanelDefinition('unknown'), null);
		assert.equal(resolveViewId(), 'adminTab');
		assert.equal(getActiveComposition().defaultPanel, 'messages');
	});

	it('resolveViewId() prefers a valid URL composition over data-msghub-view', async function () {
		const { sandbox } = await loadLayoutSandbox({
			args: { composition: 'customView' },
			viewIdAttr: 'adminTab',
		});
		sandbox.win.MsghubAdminTabRegistry.compositions.customView = {
			layout: 'single',
			panels: ['messages'],
			defaultPanel: 'messages',
		};

		assert.equal(sandbox.window.__layoutFns.resolveViewId(), 'customView');
		assert.equal(sandbox.window.__layoutFns.getActiveComposition().layout, 'single');
	});

	it('resolveViewId() falls back from invalid URL composition to a valid data-msghub-view', async function () {
		const { sandbox } = await loadLayoutSandbox({
			args: { composition: 'does-not-exist' },
			viewIdAttr: 'adminTab',
		});

		assert.equal(sandbox.window.__layoutFns.resolveViewId(), 'adminTab');
		assert.equal(sandbox.window.__layoutFns.getActiveComposition().defaultPanel, 'messages');
	});

	it('resolveViewId() falls back to adminTab when URL and markup views are invalid', async function () {
		const { sandbox } = await loadLayoutSandbox({
			args: { composition: 'does-not-exist' },
			viewIdAttr: 'also-missing',
		});

		assert.equal(sandbox.window.__layoutFns.resolveViewId(), 'adminTab');
		assert.equal(sandbox.window.__layoutFns.getActiveComposition().defaultPanel, 'messages');
	});

	it('resolveViewId() allows wildcard compositions only when explicitly selected and registered', async function () {
		const { sandbox } = await loadLayoutSandbox({
			args: { composition: 'allPlugins' },
		});
		sandbox.win.MsghubAdminTabRegistry.compositions.allPlugins = {
			layout: 'tabs',
			panels: ['*'],
			defaultPanel: 'messages',
		};

		assert.equal(sandbox.window.__layoutFns.resolveViewId(), 'allPlugins');
		assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.__layoutFns.getActiveComposition().panels)), ['*']);
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

		// Override registry with a mixed composition: one native panel + one plugin panel ref.
		sandbox.win.MsghubAdminTabRegistry = {
			panels: {
				messages: { mountId: 'messages-root', titleKey: 'messages.key', assets: { css: [], js: [] } },
			},
			compositions: {
				adminTab: {
					id: 'adminTab',
					layout: 'tabs',
					panels: [
						'messages',
						{ type: 'pluginPanel', pluginType: 'IngestStates', instanceId: 0, panelId: 'presets' },
					],
					defaultPanel: 'messages',
				},
			},
		};

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
		const pluginTab = nav.children[1]; // native tab is [0], plugin tab is [1]
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

	it('buildLayoutFromRegistry() with wildcard panels renders native + contribution plugin tabs', async function () {
		const { sandbox, layoutHost } = await loadLayoutSandbox();

		sandbox.win.MsghubAdminTabRegistry = {
			panels: {
				messages: { mountId: 'messages-root', titleKey: 'messages.key', assets: { css: [], js: [] } },
			},
			compositions: {
				adminTab: {
					id: 'adminTab',
					layout: 'tabs',
					panels: ['*'],
					defaultPanel: 'messages',
				},
			},
		};

		const contributions = [
			{ pluginType: 'IngestStates', instanceId: 0, panelId: 'presets', title: { en: 'Presets' } },
		];

		const { buildLayoutFromRegistry } = sandbox.window.__layoutFns;
		const result = buildLayoutFromRegistry({ contributions });

		// Native panel IDs come from registry.panels.
		assert.deepEqual(JSON.parse(JSON.stringify(result.panelIds)), ['messages']);

		// pluginPanelRefs derived from contributions.
		assert.equal(result.pluginPanelRefs.length, 1);
		assert.equal(result.pluginPanelRefs[0].pluginType, 'IngestStates');
		assert.equal(result.pluginPanelRefs[0].instanceId, 0);

		// DOM: both a native tab and a plugin tab rendered.
		const fragment = layoutHost.children[0];
		const nav = fragment.children[0];
		assert.equal(nav.children.length, 2);
		const pluginTab = nav.children[1];
		assert.equal(pluginTab.getAttribute('aria-disabled'), 'true');
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
});
