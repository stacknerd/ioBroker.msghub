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

async function loadLayoutSandbox() {
	const source = await readRepoFile('admin/tab/layout.js');
	const expose = `
window.__layoutFns = {
	initTabs,
	sendTo,
	h,
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

	const documentObject = {
		head: headElement,
		documentElement: {
			getAttribute: key => (key === 'data-msghub-view' ? 'adminTab' : ''),
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
		addEventListener() {},
		setInterval() {
			return 1;
		},
		top: null,
	};

	const sandbox = {
		window: windowObject,
		document: documentObject,
		location: { hash: '' },
		history: { replaceState() {} },
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
		applyTheme() {},
		detectTheme() {
			return 'light';
		},
		readThemeFromTopWindow() {
			return null;
		},
		socket: {
			emit(event, adapter, command, message, callback) {
				callback({ ok: true, data: { event, adapter, command, message } });
			},
		},
		adapterInstance: 'msghub.0',
	};

	vm.runInNewContext(`${source}\n${expose}`, sandbox, { filename: 'admin/tab/layout.js' });
	return { sandbox, layoutHost, allLinks, allScripts, headElement };
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

	it('returns panel definitions and active composition from registry', async function () {
		const { sandbox } = await loadLayoutSandbox();

		const getPanelDefinition = sandbox.window.__layoutFns.getPanelDefinition;
		const getActiveComposition = sandbox.window.__layoutFns.getActiveComposition;

		assert.ok(getPanelDefinition('stats'));
		assert.equal(getPanelDefinition('unknown'), null);
		assert.equal(getActiveComposition().defaultPanel, 'messages');
	});

	it('sends backend commands via socket emit wrapper', async function () {
		const { sandbox } = await loadLayoutSandbox();
		const sendTo = sandbox.window.__layoutFns.sendTo;
		const result = await sendTo('admin.stats.get', { quick: true });

		assert.equal(result.command, 'admin.stats.get');
		assert.deepEqual(result.message, { quick: true });
		assert.equal(result.adapter, 'msghub.0');
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
