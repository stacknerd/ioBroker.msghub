/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRepoFile } = require('./_test.utils');

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
			// Support simple single-class selectors (e.g. '.msghub-spinner-msg')
			if (typeof selector === 'string' && /^\.[a-z][a-z0-9-]*$/i.test(selector)) {
				const cls = selector.slice(1);
				const find = node => {
					if (!node || !node.tagName) {
						return null;
					}
					if (node.classList?.contains(cls)) {
						return node;
					}
					for (const child of node.children || []) {
						const found = find(child);
						if (found) {
							return found;
						}
					}
					return null;
				};
				return find(body);
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

	it('toast applies variant class and adds a close button', async function () {
		const { sandbox } = await loadUiSandbox();
		// Deferred setTimeout so toasts stay in DOM for inspection
		const timers = [];
		sandbox.window.setTimeout = fn => {
			timers.push(fn);
			return timers.length;
		};
		sandbox.window.clearTimeout = () => {};
		const ui = sandbox.window.__uiFactory();

		ui.toast({ text: 'ok msg', variant: 'ok' });
		ui.toast({ text: 'warn msg', variant: 'warning' });
		ui.toast({ text: 'err msg', variant: 'danger' });
		ui.toast({ text: 'plain msg' });

		const toastHost = sandbox.document.getElementById('msghub-toast-host');
		assert.equal(toastHost.children.length, 4);
		assert.ok(toastHost.children[0].className.includes('is-ok'), 'ok variant');
		assert.ok(toastHost.children[1].className.includes('is-warning'), 'warning variant');
		assert.ok(toastHost.children[2].className.includes('is-danger'), 'danger variant');
		assert.ok(toastHost.children[3].className.includes('is-neutral'), 'neutral default');
		for (const toastEl of toastHost.children) {
			const closeBtn = toastEl.children[toastEl.children.length - 1];
			assert.ok(closeBtn.className.includes('msghub-toast-close'), 'has close button');
		}
	});

	it('toast close button removes the toast from DOM', async function () {
		const { sandbox } = await loadUiSandbox();
		const timers = [];
		sandbox.window.setTimeout = fn => {
			timers.push(fn);
			return timers.length;
		};
		sandbox.window.clearTimeout = () => {};
		sandbox.clearTimeout = () => {};
		const ui = sandbox.window.__uiFactory();

		ui.toast({ text: 'closeable', variant: 'danger' });

		const toastHost = sandbox.document.getElementById('msghub-toast-host');
		assert.equal(toastHost.children.length, 1);

		const toastEl = toastHost.children[0];
		const closeBtn = toastEl.children[toastEl.children.length - 1];
		closeBtn.dispatchEvent({ type: 'click' });

		// is-exiting set; DOM removal happens after animationend (not immediately)
		assert.ok(toastEl.classList.contains('is-exiting'), 'is-exiting class set after close click');
		assert.equal(toastHost.children.length, 1, 'toast still in DOM while animating out');

		toastEl.dispatchEvent({ type: 'animationend' });
		assert.equal(toastHost.children.length, 0, 'toast removed after animationend');
	});
});

describe('spinner', function () {
	it('starts hidden — isOpen false, host hidden', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		assert.equal(ui.spinner.isOpen(), false);
		const host = sandbox.document.getElementById('msghub-spinner-host');
		assert.ok(host.classList.contains('is-hidden'), 'host hidden initially');
	});

	it('show() returns a string id', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		const id = ui.spinner.show({ message: 'Loading…' });
		assert.ok(typeof id === 'string' && id.length > 0, 'show() returns non-empty string id');
	});

	it('show({ id }) uses the provided id', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		const id = ui.spinner.show({ id: 'my-spinner', message: 'Loading…' });
		assert.equal(id, 'my-spinner');
		assert.equal(ui.spinner.isOpen('my-spinner'), true);
	});

	it('non-blocking show() sets isOpen; host stays hidden; toast appears', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		ui.spinner.show({ message: 'Loading…' });
		assert.equal(ui.spinner.isOpen(), true);
		const host = sandbox.document.getElementById('msghub-spinner-host');
		assert.ok(host.classList.contains('is-hidden'), 'host stays hidden for non-blocking');
		const toastHost = sandbox.document.getElementById('msghub-toast-host');
		assert.equal(toastHost.childElementCount, 1, 'toast created for non-blocking spinner');
	});

	it('non-blocking hide(id) removes only the targeted spinner', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		const id = ui.spinner.show({ message: 'Loading…' });
		ui.spinner.hide(id);
		assert.equal(ui.spinner.isOpen(), false);
		const toastHost = sandbox.document.getElementById('msghub-toast-host');
		assert.equal(toastHost.childElementCount, 0, 'spinner toast removed after hide(id)');
	});

	it('non-blocking show({ message }) toast carries message text', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		ui.spinner.show({ message: 'Loading...' });
		const toastHost = sandbox.document.getElementById('msghub-toast-host');
		const span = toastHost.children[0]?.children?.[0];
		assert.equal(span?.textContent, 'Loading...', 'message text in toast span');
	});

	it('multiple non-blocking spinners coexist as separate toasts', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		const id1 = ui.spinner.show({ message: 'Lade Daten…' });
		const id2 = ui.spinner.show({ message: 'Aktualisiere JSON…' });
		const toastHost = sandbox.document.getElementById('msghub-toast-host');
		assert.equal(toastHost.childElementCount, 2, 'two toasts in stack');
		assert.equal(ui.spinner.isOpen(id1), true, 'id1 open');
		assert.equal(ui.spinner.isOpen(id2), true, 'id2 open');
		ui.spinner.hide(id1);
		assert.equal(toastHost.childElementCount, 1, 'one toast after hiding id1');
		assert.equal(ui.spinner.isOpen(id1), false, 'id1 closed');
		assert.equal(ui.spinner.isOpen(id2), true, 'id2 still open');
	});

	it('isOpen(id) checks a specific spinner', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		const id = ui.spinner.show({ message: 'Loading…' });
		assert.equal(ui.spinner.isOpen(id), true, 'specific spinner open');
		assert.equal(ui.spinner.isOpen('unknown-id'), false, 'unknown id not open');
	});

	it('show({ blocking: true }) adds is-blocking class and shows host', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		ui.spinner.show({ blocking: true, message: 'Please wait' });
		const host = sandbox.document.getElementById('msghub-spinner-host');
		assert.ok(host.classList.contains('is-blocking'), 'is-blocking class present');
		assert.ok(!host.classList.contains('is-hidden'), 'host visible for blocking');
	});

	it('blocking show({ message }) sets visible message text', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		ui.spinner.show({ blocking: true, message: 'Working…' });
		const msg = sandbox.document.querySelector('.msghub-spinner-msg');
		assert.ok(msg !== null, 'spinner-msg element exists');
		assert.equal(msg?.textContent, 'Working…');
		assert.ok(!msg?.classList.contains('is-hidden'), 'message visible');
	});

	it('blocking show() without message hides message element', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		ui.spinner.show({ blocking: true });
		const msg = sandbox.document.querySelector('.msghub-spinner-msg');
		assert.ok(msg !== null, 'spinner-msg element exists');
		assert.ok(msg?.classList.contains('is-hidden'), 'message hidden when no text given');
	});

	it('hide(id) removes blocking spinner; overlay hides when last blocking closes', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		const id1 = ui.spinner.show({ blocking: true, message: 'Warte…' });
		const id2 = ui.spinner.show({ blocking: true, message: 'Noch mehr…' });
		const host = sandbox.document.getElementById('msghub-spinner-host');
		ui.spinner.hide(id1);
		assert.ok(!host.classList.contains('is-hidden'), 'overlay still visible (id2 active)');
		ui.spinner.hide(id2);
		assert.ok(host.classList.contains('is-hidden'), 'overlay hidden after last blocking closes');
		assert.ok(!host.classList.contains('is-blocking'), 'is-blocking removed');
	});

	it('hide() with no arg closes all spinners', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		ui.spinner.show({ message: 'A' });
		ui.spinner.show({ message: 'B' });
		assert.equal(ui.spinner.isOpen(), true);
		ui.spinner.hide();
		assert.equal(ui.spinner.isOpen(), false);
		const toastHost = sandbox.document.getElementById('msghub-toast-host');
		assert.equal(toastHost.childElementCount, 0, 'all toasts removed');
	});

	it('hide() is idempotent when nothing is open', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		assert.doesNotThrow(() => ui.spinner.hide());
	});

	it('closeAll() hides spinner', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		ui.spinner.show({ message: 'working', blocking: true });
		ui.closeAll();
		assert.equal(ui.spinner.isOpen(), false);
	});
});

describe('toast extensions', function () {
	it('exposes toastClose in the public API', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		assert.ok(typeof ui.toastClose === 'function', 'toastClose is a function');
	});

	it('toast({ persist: true }) is not auto-removed', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		ui.toast({ text: 'hello', persist: true });
		const toastHost = sandbox.document.getElementById('msghub-toast-host');
		assert.equal(toastHost.childElementCount, 1, 'persistent toast stays in DOM');
	});

	it('toast({ persist: true }) close button still present', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		ui.toast({ text: 'hello', persist: true });
		const toastHost = sandbox.document.getElementById('msghub-toast-host');
		const toastEl = toastHost.children[0];
		const hasCloseBtn = toastEl?.children?.some(c => c.tagName === 'BUTTON');
		assert.ok(hasCloseBtn, 'close button present when persist without closeEl');
	});

	it('toast({ closeEl }) inserts closeEl instead of close button', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		const customEl = sandbox.document.createElement('div');
		ui.toast({ text: 'loading', persist: true, closeEl: customEl });
		const toastHost = sandbox.document.getElementById('msghub-toast-host');
		const toastEl = toastHost.children[0];
		const hasCloseBtn = toastEl?.children?.some(c => c.tagName === 'BUTTON');
		assert.ok(!hasCloseBtn, 'no close button when closeEl provided');
		assert.ok(toastEl?.children?.includes(customEl), 'closeEl appended to toast');
	});

	it('toastClose(id) removes named toast', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		ui.toast({ id: 'my-toast', text: 'hello', persist: true });
		const toastHost = sandbox.document.getElementById('msghub-toast-host');
		assert.equal(toastHost.childElementCount, 1, 'toast present before close');
		ui.toastClose('my-toast');
		assert.equal(toastHost.childElementCount, 0, 'toast removed by toastClose');
	});

	it('toast with same id replaces the existing toast', async function () {
		const { sandbox } = await loadUiSandbox();
		const ui = sandbox.window.__uiFactory();
		ui.toast({ id: 'dup', text: 'first', persist: true });
		ui.toast({ id: 'dup', text: 'second', persist: true });
		const toastHost = sandbox.document.getElementById('msghub-toast-host');
		assert.equal(toastHost.childElementCount, 1, 'only one toast after replace');
		const span = toastHost.children[0]?.children?.[0];
		assert.equal(span?.textContent, 'second', 'replaced toast shows new text');
	});
});
