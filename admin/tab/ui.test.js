/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRepoFile } = require('../../test/adminTabCoreTestUtils');

function createClassList(initial = '') {
	const values = new Set(String(initial || '').split(/\s+/g).filter(Boolean));
	return {
		add: (...tokens) => tokens.forEach(token => values.add(String(token))),
		remove: (...tokens) => tokens.forEach(token => values.delete(String(token))),
		contains: token => values.has(String(token)),
		toggle: (token, force) => {
			const normalized = String(token);
			if (force === true) {
				values.add(normalized);
				return true;
			}
			if (force === false) {
				values.delete(normalized);
				return false;
			}
			if (values.has(normalized)) {
				values.delete(normalized);
				return false;
			}
			values.add(normalized);
			return true;
		},
		toString: () => Array.from(values).join(' '),
	};
}

function createElement(tagName) {
	const attributes = new Map();
	const listeners = new Map();
	const element = {
		tagName: String(tagName || '').toUpperCase(),
		children: [],
		style: {
			setProperty(name, value) {
				this[String(name)] = String(value);
			},
		},
		className: '',
		classList: createClassList(),
		parentNode: null,
		appendChild(child) {
			if (child && typeof child === 'object') {
				child.parentNode = this;
			}
			this.children.push(child);
			return child;
		},
		replaceChildren(...children) {
			this.children = [];
			for (const child of children) {
				this.appendChild(child);
			}
		},
		remove() {
			if (!this.parentNode || !Array.isArray(this.parentNode.children)) {
				return;
			}
			const index = this.parentNode.children.indexOf(this);
			if (index >= 0) {
				this.parentNode.children.splice(index, 1);
			}
		},
		setAttribute(name, value) {
			const key = String(name);
			attributes.set(key, String(value));
			if (key === 'class') {
				this.className = String(value);
				this.classList = createClassList(this.className);
			}
			if (key === 'id') {
				this.id = String(value);
			}
		},
		getAttribute(name) {
			return attributes.get(String(name)) || null;
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
		contains(node) {
			if (!node) {
				return false;
			}
			if (node === this) {
				return true;
			}
			for (const child of this.children) {
				if (child && typeof child.contains === 'function' && child.contains(node)) {
					return true;
				}
			}
			return false;
		},
		querySelectorAll(selector) {
			const out = [];
			const normalized = String(selector || '').trim();
			const visit = node => {
				if (!node || !node.tagName) {
					return;
				}
				if (normalized === 'button[role="menuitem"]') {
					if (node.tagName === 'BUTTON' && node.getAttribute('role') === 'menuitem') {
						out.push(node);
					}
				}
				for (const child of node.children || []) {
					visit(child);
				}
			};
			visit(this);
			return out;
		},
		focus() {},
		blur() {},
		getBoundingClientRect() {
			return { left: 20, top: 20, right: 120, bottom: 60, width: 100, height: 40 };
		},
	};
	Object.defineProperty(element, 'childElementCount', {
		get() {
			return element.children.filter(child => child && child.tagName).length;
		},
	});
	return element;
}

async function loadUiSandbox() {
	const source = await readRepoFile('admin/tab/ui.js');
	const expose = '\nwindow.__uiFactory = createUi;';

	const body = createElement('body');
	const root = createElement('div');
	root.className = 'msghub-root';
	root.classList = createClassList('msghub-root');
	body.appendChild(root);

	const documentObject = {
		body,
		createElement,
		createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
		getElementById(id) {
			const visit = node => {
				if (node && node.id === id) {
					return node;
				}
				for (const child of node.children || []) {
					const found = visit(child);
					if (found) {
						return found;
					}
				}
				return null;
			};
			return visit(body);
		},
		querySelector(selector) {
			if (selector === '.msghub-root') {
				return root;
			}
			return null;
		},
		querySelectorAll(selector) {
			return body.querySelectorAll(selector);
		},
		addEventListener() {},
		activeElement: null,
		visibilityState: 'visible',
	};

	const windowObject = {
		innerWidth: 1200,
		innerHeight: 900,
		setTimeout: fn => {
			fn();
			return 1;
		},
		clearTimeout() {},
		requestAnimationFrame: fn => {
			fn();
			return 1;
		},
		matchMedia: () => ({ matches: false }),
		addEventListener() {},
		getComputedStyle: () => ({ transitionDuration: '0s', transitionDelay: '0s' }),
	};
	windowObject.window = windowObject;

	const sandbox = {
		window: windowObject,
		document: documentObject,
		Node: function Node() {},
		HTMLElement: function HTMLElement() {},
		HTMLButtonElement: function HTMLButtonElement() {},
		computeContextMenuPosition: () => ({ x: 16, y: 24 }),
		toContextMenuIconVar: iconName => `var(--msghub-icon-${iconName})`,
	};

	vm.runInNewContext(`${source}${expose}`, sandbox, { filename: 'admin/tab/ui.js' });
	return { sandbox, root, documentObject };
}

describe('admin/tab/ui.js', function () {
	it('creates the UI facade with expected primitives', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();

		assert.ok(ui && typeof ui === 'object');
		assert.ok(typeof ui.toast === 'function');
		assert.ok(ui.contextMenu && typeof ui.contextMenu.open === 'function');
		assert.ok(ui.overlayLarge && typeof ui.overlayLarge.open === 'function');
		assert.ok(ui.dialog && typeof ui.dialog.confirm === 'function');
		assert.ok(typeof ui.closeAll === 'function');
	});

	it('opens and closes context menus through the public API', async function () {
		const { sandbox, documentObject } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();

		ui.contextMenu.open({
			items: [{ label: 'Open', icon: 'help' }],
			anchorPoint: { x: 10, y: 10 },
		});
		assert.equal(ui.contextMenu.isOpen(), true);

		const menuHost = documentObject.getElementById('msghub-contextmenu');
		assert.ok(menuHost);
		assert.equal(menuHost.getAttribute('aria-hidden'), 'false');

		ui.contextMenu.close();
		assert.equal(ui.contextMenu.isOpen(), false);
		assert.equal(menuHost.getAttribute('aria-hidden'), 'true');
	});

	it('supports dialog lifecycle via confirm/close', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();

		const promise = ui.dialog.confirm({
			title: 'Confirm',
			text: 'Proceed?',
		});
		assert.equal(ui.dialog.isOpen(), true);
		ui.dialog.close(true);
		const result = await promise;
		assert.equal(result, true);
		assert.equal(ui.dialog.isOpen(), false);
	});

	it('supports overlay lifecycle via open/close', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();

		ui.overlayLarge.open({
			title: 'Details',
			bodyText: 'Body',
		});
		assert.equal(ui.overlayLarge.isOpen(), true);
		ui.overlayLarge.close();
		assert.equal(ui.overlayLarge.isOpen(), false);
	});
});
