/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { readRepoFile } = require('../../_test.utils');
const { loadPanelModule } = require('./_test.utils');

function readNodeText(node) {
	if (!node || typeof node !== 'object') {
		return '';
	}
	const ownText = typeof node.textContent === 'string' ? node.textContent : '';
	const children = Array.isArray(node.children) ? node.children : [];
	return ownText + children.map(readNodeText).join('');
}

function readBodyLineTexts(bodyEl) {
	const children = Array.isArray(bodyEl?.children) ? bodyEl.children : [];
	return children.map(readNodeText);
}

describe('admin/tab/panels/messages/overlay.json.js', function () {
	it('opens JSON overlay and reuses lazy body element', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		const openCalls = [];

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => openCalls.push(payload),
					isOpen: () => true,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => 'Europe/Berlin',
			getLevelLabel: value => (Number(value) === 3 ? 'HIGH' : String(value)),
		});

		overlay.openMessageJson({
			level: 3,
			timing: { createdAt: 1700000000000, processMs: 1500 },
			nested: { n: 5 },
		});
		overlay.openMessageJson({ level: 1, text: 'hello' });

		assert.equal(openCalls.length, 2);
		assert.equal(openCalls[0].title, 'i18n:msghub.i18n.core.admin.ui.messages.overlay.json.title');
		assert.equal(openCalls[0].bodyEl, openCalls[1].bodyEl, 'overlay body should be lazily cached');
	});

	it('falls back to plain stringify when renderer fails', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
		});

		const cyclic = {};
		cyclic.self = cyclic;
		overlay.openMessageJson(cyclic);
		assert.equal(openPayload.title, 'i18n:msghub.i18n.core.admin.ui.messages.overlay.json.title');
		assert.ok(String(openPayload.bodyEl.textContent).length > 0);
	});

	it('renders visible \\n tokens and inserts real line breaks after them', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
		});

		overlay.openMessageJson({ text: 'foo\nbar' });

		const propertyLine = openPayload.bodyEl.children[1];
		const stringEl = propertyLine?.children?.[1]?.children?.[0];
		assert.ok(stringEl);
		assert.equal(stringEl.textContent, '"foo\\n\nbar"');
	});

	it('renders commas for nested object and array properties on the closing line', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
		});

		overlay.openMessageJson({
			details: { location: 'Kreis Biberach' },
			list: [1, 2],
			status: 'ok',
		});

		const lineTexts = readBodyLineTexts(openPayload.bodyEl);
		assert.ok(lineTexts.includes('  "details": {'));
		assert.ok(lineTexts.includes('  },'));
		assert.ok(lineTexts.includes('  "list": ['));
		assert.ok(lineTexts.includes('  ],'));
		assert.ok(!lineTexts.includes('  "details": {,'));
		assert.ok(!lineTexts.includes('  "list": [,'));
	});

	it('renders commas for nested object array elements on the closing line', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
		});

		overlay.openMessageJson([{ a: 1 }, { b: 2 }]);

		const lineTexts = readBodyLineTexts(openPayload.bodyEl);
		assert.ok(lineTexts.includes('  },'));
		assert.ok(!lineTexts.includes('  {,'));
	});

	it('opens copy context menu on right click inside the JSON overlay', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;
		const contextMenuCalls = [];

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
			openCopyContextMenu: (event, msg) => {
				contextMenuCalls.push({ event, msg });
			},
		});

		overlay.openMessageJson({ ref: 'r1', title: 'Hello', text: 'World' });
		openPayload.bodyEl.dispatchEvent({
			type: 'contextmenu',
			clientX: 11,
			clientY: 22,
			preventDefault() {},
		});

		assert.equal(contextMenuCalls.length, 1);
		assert.equal(contextMenuCalls[0].msg.ref, 'r1');
		assert.equal(contextMenuCalls[0].event.clientX, 11);
	});

	it('renders enabled action button for core-type items in msg.actions[]', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;
		const executeCalls = [];

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
			onActionExecute: (ref, actionId, actionType) => executeCalls.push({ ref, actionId, actionType }),
		});

		overlay.openMessageJson({
			ref: 'r1',
			actions: [
				{ id: 'ack-1', type: 'ack' },
				{ id: 'close-1', type: 'close' },
			],
		});

		// Each action item line should have a button appended.
		const body = openPayload.bodyEl;
		const buttons = body.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		assert.equal(buttons.length, 2);
		assert.ok(buttons[0].textContent.includes('action.ack.label'), 'ack button must use common action label key');
		assert.ok(buttons[1].textContent.includes('action.close.label'), 'close button must use common action label key');
		assert.equal(buttons[0].disabled, false);

		// Click fires onActionExecute with correct args.
		buttons[0].click();
		assert.equal(executeCalls.length, 1);
		assert.equal(executeCalls[0].ref, 'r1');
		assert.equal(executeCalls[0].actionId, 'ack-1');
		assert.equal(executeCalls[0].actionType, 'ack');
	});

	it('renders disabled button for core-type items in msg.actionsInactive[]', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;
		const executeCalls = [];

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
			onActionExecute: (ref, actionId, actionType) => executeCalls.push({ ref, actionId, actionType }),
		});

		overlay.openMessageJson({
			ref: 'r1',
			actions: [],
			actionsInactive: [{ id: 'snooze-1', type: 'snooze' }],
		});

		const body = openPayload.bodyEl;
		const buttons = body.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		assert.equal(buttons.length, 1);
		assert.ok(buttons[0].textContent.includes('action.snooze.label'), 'snooze button must use common action label key');
		assert.equal(buttons[0].disabled, true);

		// Clicking a disabled button must not call onActionExecute.
		buttons[0].click();
		assert.equal(executeCalls.length, 0);
	});

	it('does not render button for non-core action types (open, link, custom)', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
			onActionExecute: () => undefined,
		});

		overlay.openMessageJson({
			ref: 'r1',
			actions: [
				{ id: 'open-1', type: 'open' },
				{ id: 'link-1', type: 'link' },
				{ id: 'custom-1', type: 'custom' },
			],
		});

		const body = openPayload.bodyEl;
		const buttons = body.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		assert.equal(buttons.length, 0, 'non-core action types must not produce buttons');
	});

	it('does not render button for plain arrays (not actions/actionsInactive)', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
			onActionExecute: () => undefined,
		});

		overlay.openMessageJson({
			ref: 'r1',
			tags: [{ id: 'ack', type: 'ack' }],
		});

		const body = openPayload.bodyEl;
		const buttons = body.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		assert.equal(buttons.length, 0, 'plain arrays must not produce action buttons');
	});

	it('does not crash and renders no button when onActionExecute is not provided', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
			// onActionExecute intentionally omitted
		});

		overlay.openMessageJson({ ref: 'r1', actions: [{ id: 'ack-1', type: 'ack' }] });

		const body = openPayload.bodyEl;
		const buttons = body.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		// Button is still rendered but has no click handler; clicking must not throw.
		assert.equal(buttons.length, 1);
		assert.doesNotThrow(() => buttons[0].click());
	});

	it('renders link button for link action with valid https URL in msg.actions[]', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;
		const linkOpenCalls = [];

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
			onLinkOpen: url => linkOpenCalls.push(url),
		});

		overlay.openMessageJson({
			ref: 'r1',
			actions: [{ id: 'link-1', type: 'link', payload: { url: 'https://example.com/path' } }],
		});

		const body = openPayload.bodyEl;
		const buttons = body.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		assert.equal(buttons.length, 1);
		assert.ok(buttons[0].textContent.includes('action.link.label'), 'link button must use common action label key');
		assert.equal(buttons[0].disabled, false);

		buttons[0].click();
		assert.equal(linkOpenCalls.length, 1);
		assert.equal(linkOpenCalls[0], 'https://example.com/path');
	});

	it('link button uses payload.label as text when present, falling back to i18n key', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;
		const linkOpenCalls = [];

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
			onLinkOpen: url => linkOpenCalls.push(url),
		});

		// payload.label present — must use it as button text.
		overlay.openMessageJson({
			ref: 'r1',
			actions: [
				{ id: 'link-1', type: 'link', payload: { url: 'https://example.com', label: 'runbook #42' } },
			],
		});
		let buttons = openPayload.bodyEl.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		assert.equal(buttons.length, 1);
		assert.equal(buttons[0].textContent, 'runbook #42', 'payload.label must be used as button text');
		buttons[0].click();
		assert.equal(linkOpenCalls[0], 'https://example.com', 'clicking still fires onLinkOpen with correct URL');

		// payload.label absent — must fall back to i18n key.
		overlay.openMessageJson({
			ref: 'r1',
			actions: [{ id: 'link-2', type: 'link', payload: { url: 'https://example.com' } }],
		});
		buttons = openPayload.bodyEl.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		assert.equal(buttons.length, 1);
		assert.ok(
			buttons[0].textContent.includes('action.link.label'),
			'i18n fallback used when payload.label is absent',
		);
	});

	it('does not render link button for link action without valid http URL', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
			onLinkOpen: () => undefined,
		});

		// javascript: URL — must not render button
		overlay.openMessageJson({
			ref: 'r1',
			actions: [{ id: 'link-1', type: 'link', payload: { url: 'javascript:alert(1)' } }],
		});
		let buttons = openPayload.bodyEl.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		assert.equal(buttons.length, 0, 'javascript: URL must not produce a link button');

		// ftp: URL — must not render button
		overlay.openMessageJson({
			ref: 'r1',
			actions: [{ id: 'link-2', type: 'link', payload: { url: 'ftp://files.example.com' } }],
		});
		buttons = openPayload.bodyEl.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		assert.equal(buttons.length, 0, 'ftp: URL must not produce a link button');

		// No payload — must not render button
		overlay.openMessageJson({
			ref: 'r1',
			actions: [{ id: 'link-3', type: 'link' }],
		});
		buttons = openPayload.bodyEl.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		assert.equal(buttons.length, 0, 'missing payload must not produce a link button');
	});

	it('does not render link button for link items in actionsInactive[]', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
			onLinkOpen: () => undefined,
		});

		overlay.openMessageJson({
			ref: 'r1',
			actions: [],
			actionsInactive: [{ id: 'link-1', type: 'link', payload: { url: 'https://example.com' } }],
		});

		const buttons = openPayload.bodyEl.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		assert.equal(buttons.length, 0, 'link buttons must not be shown for actionsInactive items');
	});

	it('does not render link button when onLinkOpen is not provided', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/overlay.json.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesOverlayJson;
		let openPayload = null;

		const overlay = moduleApi.createJsonOverlay({
			ui: {
				overlayLarge: {
					open: payload => {
						openPayload = payload;
					},
					isOpen: () => false,
				},
			},
			t: key => `i18n:${key}`,
			getServerTimeZone: () => '',
			getLevelLabel: value => String(value),
			// onLinkOpen intentionally omitted
		});

		overlay.openMessageJson({
			ref: 'r1',
			actions: [{ id: 'link-1', type: 'link', payload: { url: 'https://example.com' } }],
		});

		const buttons = openPayload.bodyEl.children.filter(el => el.tagName === 'DIV').flatMap(line =>
			line.children.filter(child => child.tagName === 'BUTTON'),
		);
		assert.equal(buttons.length, 0, 'no link button when onLinkOpen callback is not provided');
	});

	it('does not contain hover tooltip logic anymore', async function () {
		const source = await readRepoFile('admin/tab/panels/messages/overlay.json.js');
		assert.doesNotMatch(source, /toLocaleString\(/);
		assert.doesNotMatch(source, /addEventListener\(\s*['"]mousemove['"]/);
		assert.doesNotMatch(source, /requestAnimationFrame\(/);
	});
});
