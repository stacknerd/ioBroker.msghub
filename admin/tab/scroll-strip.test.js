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

function createElement(tagName = 'div') {
	const attributes = new Map();
	const listeners = new Map();
	const element = {
		tagName: String(tagName).toUpperCase(),
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
			this.children = [];
			for (const child of children) {
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
		addEventListener(type, handler) {
			const key = String(type);
			const list = listeners.get(key) || [];
			list.push(handler);
			listeners.set(key, list);
		},
		removeEventListener(type, handler) {
			const key = String(type);
			const list = listeners.get(key) || [];
			listeners.set(key, list.filter(fn => fn !== handler));
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
		get firstChild() {
			return this.children[0] || null;
		},
	};
	return element;
}

function createDocumentMock() {
	return {
		createElement: tag => createElement(tag),
		createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
		createDocumentFragment: () => createElement('fragment'),
		body: createElement('body'),
	};
}

function createObserverController() {
	const resizeObservers = [];
	const mutationObservers = [];

	class ResizeObserverMock {
		constructor(callback) {
			this.callback = callback;
			this.observed = null;
			this.options = null;
			this.disconnected = false;
			resizeObservers.push(this);
		}
		observe(target, options) {
			this.observed = target;
			this.options = options || null;
		}
		disconnect() {
			this.disconnected = true;
		}
	}

	class MutationObserverMock {
		constructor(callback) {
			this.callback = callback;
			this.observed = null;
			this.options = null;
			this.disconnected = false;
			mutationObservers.push(this);
		}
		observe(target, options) {
			this.observed = target;
			this.options = options || null;
		}
		disconnect() {
			this.disconnected = true;
		}
	}

	return {
		ResizeObserverMock,
		MutationObserverMock,
		resizeObservers,
		mutationObservers,
	};
}

async function loadScrollStripSandbox() {
	const source = await readRepoFile('admin/tab/scroll-strip.js');
	const documentObject = createDocumentMock();
	const observers = createObserverController();
	const windowObject = {
		window: null,
		top: {},
		document: documentObject,
		setTimeout: fn => {
			if (typeof fn === 'function') {
				fn();
			}
			return 1;
		},
		clearTimeout() {},
		requestAnimationFrame: fn => {
			if (typeof fn === 'function') {
				fn();
			}
			return 1;
		},
		ResizeObserver: observers.ResizeObserverMock,
		MutationObserver: observers.MutationObserverMock,
	};
	windowObject.window = windowObject;

	const sandbox = {
		window: windowObject,
		document: documentObject,
		ResizeObserver: observers.ResizeObserverMock,
		MutationObserver: observers.MutationObserverMock,
		console,
	};
	vm.runInNewContext(source, sandbox, { filename: 'admin/tab/scroll-strip.js' });
	return { sandbox, observers };
}

describe('admin/tab/scroll-strip.js', function () {
	it('returns a no-op handle for invalid input', async function () {
		const { sandbox } = await loadScrollStripSandbox();
		const result = sandbox.window.MsghubScrollStrip.initStrip(null);
		assert.equal(result.viewport, null);
		assert.doesNotThrow(() => result.disconnect());
	});

	it('returns a no-op handle for undefined input', async function () {
		const { sandbox } = await loadScrollStripSandbox();
		const result = sandbox.window.MsghubScrollStrip.initStrip(undefined);
		assert.equal(result.viewport, null);
		assert.doesNotThrow(() => result.disconnect());
	});

	it('wraps host children and appends overflow edges', async function () {
		const { sandbox } = await loadScrollStripSandbox();
		const host = createElement('div');
		const first = createElement('button');
		const second = createElement('span');
		host.appendChild(first);
		host.appendChild(second);

		const handle = sandbox.window.MsghubScrollStrip.initStrip(host);

		assert.equal(host.classList.contains('msghub-strip-host'), true);
		assert.equal(host.children.length, 3);
		assert.equal(host.children[0].classList.contains('msghub-strip-viewport'), true);
		assert.equal(host.children[1].classList.contains('msghub-strip-edge--left'), true);
		assert.equal(host.children[2].classList.contains('msghub-strip-edge--right'), true);
		assert.equal(handle.viewport, host.children[0]);
		assert.equal(handle.viewport.children.length, 2);
		assert.equal(handle.viewport.children[0], first);
		assert.equal(handle.viewport.children[1], second);
	});

	it('supports an empty host and keeps both edges present', async function () {
		const { sandbox } = await loadScrollStripSandbox();
		const host = createElement('div');

		const handle = sandbox.window.MsghubScrollStrip.initStrip(host);

		assert.equal(host.children.length, 3);
		assert.equal(host.children[0].classList.contains('msghub-strip-viewport'), true);
		assert.equal(host.children[0].children.length, 0);
		assert.equal(host.children[1].classList.contains('msghub-strip-edge--left'), true);
		assert.equal(host.children[2].classList.contains('msghub-strip-edge--right'), true);
		assert.equal(handle.viewport.children.length, 0);
	});

	it('leaves overflow classes unset when content fits', async function () {
		const { sandbox, observers } = await loadScrollStripSandbox();
		const host = createElement('div');
		host.appendChild(createElement('button'));

		const handle = sandbox.window.MsghubScrollStrip.initStrip(host);
		const viewport = handle.viewport;
		viewport.scrollWidth = 120;
		viewport.clientWidth = 120;
		viewport.scrollLeft = 0;
		observers.resizeObservers[0].callback();

		assert.equal(host.classList.contains('has-overflow-left'), false);
		assert.equal(host.classList.contains('has-overflow-right'), false);
	});

	it('updates overflow classes from scroll and observer callbacks', async function () {
		const { sandbox, observers } = await loadScrollStripSandbox();
		const host = createElement('div');
		host.appendChild(createElement('button'));

		const handle = sandbox.window.MsghubScrollStrip.initStrip(host);
		const viewport = handle.viewport;
		viewport.scrollWidth = 320;
		viewport.clientWidth = 200;
		viewport.scrollLeft = 0;
		observers.resizeObservers[0].callback();

		assert.equal(host.classList.contains('has-overflow-left'), false);
		assert.equal(host.classList.contains('has-overflow-right'), true);

		viewport.scrollLeft = 80;
		viewport.dispatchEvent({ type: 'scroll' });
		assert.equal(host.classList.contains('has-overflow-left'), true);
		assert.equal(host.classList.contains('has-overflow-right'), true);

		viewport.scrollLeft = 120;
		viewport.clientWidth = 210;
		observers.resizeObservers[0].callback();
		assert.equal(host.classList.contains('has-overflow-left'), true);
		assert.equal(host.classList.contains('has-overflow-right'), false);

		viewport.scrollLeft = 0;
		viewport.clientWidth = 150;
		observers.mutationObservers[0].callback();
		assert.equal(host.classList.contains('has-overflow-left'), false);
		assert.equal(host.classList.contains('has-overflow-right'), true);
	});

	it('is idempotent and disconnects observers', async function () {
		const { sandbox, observers } = await loadScrollStripSandbox();
		const host = createElement('div');
		host.appendChild(createElement('button'));

		const firstHandle = sandbox.window.MsghubScrollStrip.initStrip(host);
		const secondHandle = sandbox.window.MsghubScrollStrip.initStrip(host);

		assert.equal(secondHandle, firstHandle);
		assert.equal(observers.resizeObservers.length, 1);
		assert.equal(observers.mutationObservers.length, 1);

		firstHandle.disconnect();
		assert.equal(observers.resizeObservers[0].disconnected, true);
		assert.equal(observers.mutationObservers[0].disconnected, true);
		assert.doesNotThrow(() => observers.resizeObservers[0].callback());
	});
});
