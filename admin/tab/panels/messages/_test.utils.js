'use strict';

const vm = require('node:vm');
const { readRepoFile } = require('../../../../test/adminTabCoreTestUtils');

/**
 * Messages panel test utility module.
 *
 * Provides minimal DOM/VM helpers used by co-located panel tests so tests can
 * execute browser-oriented modules in Node without global test-folder coupling.
 */

/**
 * Creates a mutable classList-like object backed by a Set.
 *
 * @param {string} [initial] Initial class string.
 * @returns {{add:Function,remove:Function,contains:Function,toggle:Function,toString:Function}} Class list facade.
 */
function createClassList(initial = '') {
	const set = new Set(
		String(initial || '')
			.split(/\s+/g)
			.filter(Boolean),
	);
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

/**
 * Creates a lightweight mock element used by panel tests.
 *
 * @param {string} [tagName] Element tag name.
 * @returns {object} Mock element with basic DOM APIs.
 */
function createElement(tagName = 'div') {
	const attributes = new Map();
	const listeners = new Map();
	const element = {
		tagName: String(tagName).toUpperCase(),
		children: [],
		style: {},
		className: '',
		classList: createClassList(),
		dataset: {},
		textContent: '',
		disabled: false,
		checked: false,
		indeterminate: false,
		offsetParent: {},
		appendChild(child) {
			if (child) {
				child.parentNode = this;
			}
			this.children.push(child);
			return child;
		},
		replaceChildren(...children) {
			this.children = [];
			for (const child of children) {
				if (child) {
					child.parentNode = this;
				}
				this.children.push(child);
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
		addEventListener(type, handler) {
			const key = String(type);
			const list = listeners.get(key) || [];
			list.push(handler);
			listeners.set(key, list);
		},
		dispatchEvent(event) {
			const nextEvent = event && typeof event === 'object' ? event : {};
			if (!Object.prototype.hasOwnProperty.call(nextEvent, 'target')) {
				nextEvent.target = this;
			}
			if (!Object.prototype.hasOwnProperty.call(nextEvent, 'currentTarget')) {
				nextEvent.currentTarget = this;
			}
			const list = listeners.get(String(nextEvent?.type || '')) || [];
			for (const handler of list) {
				handler(nextEvent);
			}
		},
		click() {
			this.dispatchEvent({
				type: 'click',
				preventDefault() {},
			});
		},
		querySelectorAll() {
			return [];
		},
		querySelector() {
			return null;
		},
		closest() {
			return null;
		},
		contains(node) {
			return this.children.includes(node);
		},
		remove() {},
		focus() {},
		select() {},
	};
	return element;
}

/**
 * Creates a lightweight document mock with event support.
 *
 * @returns {{documentObject:object,listeners:Map<string,Function[]>}} Document mock and listener registry.
 */
function createDocumentMock() {
	const listeners = new Map();
	const documentObject = {
		hidden: false,
		createElement: tag => createElement(tag),
		createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
		createDocumentFragment: () => createElement('fragment'),
		body: createElement('body'),
		addEventListener(type, handler) {
			const key = String(type);
			const list = listeners.get(key) || [];
			list.push(handler);
			listeners.set(key, list);
		},
		removeEventListener(type, handler) {
			const key = String(type);
			const list = listeners.get(key) || [];
			listeners.set(
				key,
				list.filter(fn => fn !== handler),
			);
		},
		dispatchEvent(event) {
			const list = listeners.get(String(event?.type || '')) || [];
			for (const handler of list) {
				handler(event);
			}
		},
		querySelectorAll() {
			return [];
		},
	};
	return { documentObject, listeners };
}

/**
 * Loads a panel module into a VM sandbox and returns globals.
 *
 * @param {string} relPath Repository-relative file path.
 * @param {object} [extras] Additional sandbox globals.
 * @returns {Promise<object>} Sandbox object after execution.
 */
async function loadPanelModule(relPath, extras = {}) {
	const source = await readRepoFile(relPath);
	const { documentObject } = createDocumentMock();
	const windowObject = {
		window: {},
		top: {},
		setTimeout: fn => {
			if (typeof fn === 'function') {
				fn();
			}
			return 1;
		},
		clearTimeout() {},
		setInterval() {
			return 1;
		},
		clearInterval() {},
		requestAnimationFrame: fn => {
			if (typeof fn === 'function') {
				fn();
			}
			return 1;
		},
	};
	windowObject.window = windowObject;
	const sandbox = {
		window: windowObject,
		document: documentObject,
		console,
		...extras,
	};
	vm.runInNewContext(source, sandbox, { filename: relPath });
	return sandbox;
}

/**
 * Creates the `h(...)` helper compatible with panel rendering code.
 *
 * @returns {Function} Element factory used by panel render tests.
 */
function createH() {
	return function h(tag, attrs, children) {
		const el = createElement(tag);
		if (attrs) {
			for (const [key, value] of Object.entries(attrs)) {
				if (value == null) {
					continue;
				}
				if (key === 'class') {
					el.className = value;
					el.classList = createClassList(value);
					continue;
				}
				if (key === 'text') {
					el.textContent = String(value);
					continue;
				}
				if (key.startsWith('on') && typeof value === 'function') {
					el.addEventListener(key.slice(2), value);
					continue;
				}
				el.setAttribute(key, String(value));
			}
		}
		if (children) {
			const list = Array.isArray(children) ? children : [children];
			for (const child of list) {
				if (child == null) {
					continue;
				}
				el.appendChild(typeof child === 'string' ? { nodeType: 3, textContent: child } : child);
			}
		}
		return el;
	};
}

module.exports = {
	createClassList,
	createElement,
	createDocumentMock,
	createH,
	loadPanelModule,
};
