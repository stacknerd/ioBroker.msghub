/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const { createElement, createH, loadPanelModule } = require('./_test.utils');

describe('admin/tab/panels/messages/render.table.js', function () {
	function buildMessage(overrides = {}) {
		return {
			ref: 'ref.1',
			title: 'Title',
			text: 'Text',
			kind: 'task',
			level: 3,
			icon: 'icon',
			lifecycle: { state: 'open' },
			origin: { system: 'sys.1' },
			details: { location: 'kitchen' },
			timing: { createdAt: 1700000000000, updatedAt: 1700000000100 },
			progress: { percentage: 101.2 },
			...overrides,
		};
	}

	function createFixture({ expertMode = false } = {}) {
		const state = {
			expertMode,
			selectedRefs: new Set(),
			suppressRowClickUntil: 0,
		};
		let selectionChangedCalls = 0;
		let openJsonCalls = 0;
		let openContextCalls = 0;
		const openContextArgs = [];
		const api = {
			i18n: {
				tOr: (_key, fallback) => fallback,
			},
		};
		const options = {
			h: createH(),
			api,
			state,
			safeStr: value => (value == null ? '' : String(value)),
			pick: (obj, path) => path.split('.').reduce((cur, key) => (cur ? cur[key] : undefined), obj),
			formatTs: value => `ts:${value}`,
			getLevelLabel: value => (value === 3 ? 'HIGH' : String(value)),
			openMessageJson() {
				openJsonCalls += 1;
			},
			openRowContextMenu(event, message) {
				openContextCalls += 1;
				openContextArgs.push({ event, message });
			},
			onSelectionChanged() {
				selectionChangedCalls += 1;
			},
		};
		return {
			state,
			options,
			get selectionChangedCalls() {
				return selectionChangedCalls;
			},
			get openJsonCalls() {
				return openJsonCalls;
			},
			get openContextCalls() {
				return openContextCalls;
			},
			openContextArgs,
		};
	}

	it('renders rows with translated cells and clamped progress', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/render.table.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesRenderTable;
		const fixture = createFixture();
		const renderer = moduleApi.createTableRenderer(fixture.options);
		const rows = renderer.renderRows([buildMessage()]);

		assert.equal(rows.length, 1);
		const progressCell = rows[0].children[10];
		const progressEl = progressCell.children[0];
		assert.equal(progressEl.tagName, 'PROGRESS');
		assert.equal(progressEl.getAttribute('value'), '100');
		assert.equal(progressCell.children[1].textContent, '100%');
		assert.equal(rows[0].children[7].textContent, 'ts:1700000000000');
	});

	it('applies non-expert click and context selection rules', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/render.table.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesRenderTable;
		const fixture = createFixture({ expertMode: false });
		const renderer = moduleApi.createTableRenderer(fixture.options);
		const row = renderer.renderRows([buildMessage()])[0];

		row.dispatchEvent({ type: 'click', target: createElement('span') });
		assert.deepEqual(Array.from(fixture.state.selectedRefs), ['ref.1']);
		assert.equal(fixture.selectionChangedCalls, 1);

		row.dispatchEvent({ type: 'click', target: createElement('span') });
		assert.deepEqual(Array.from(fixture.state.selectedRefs), []);
		assert.equal(fixture.selectionChangedCalls, 2);

		let prevented = false;
		row.dispatchEvent({
			type: 'contextmenu',
			target: createElement('span'),
			clientX: 11,
			clientY: 22,
			preventDefault() {
				prevented = true;
			},
		});
		assert.equal(prevented, true);
		assert.equal(fixture.openContextCalls, 1);
		assert.equal(fixture.openContextArgs[0].message.ref, 'ref.1');
	});

	it('supports expert checkbox selection and double click open json', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/render.table.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesRenderTable;
		const fixture = createFixture({ expertMode: true });
		const renderer = moduleApi.createTableRenderer(fixture.options);
		const row = renderer.renderRows([buildMessage()])[0];
		const checkboxInput = row.children[0].children[0].children[0];

		checkboxInput.dispatchEvent({
			type: 'change',
			target: { checked: true },
		});
		assert.deepEqual(Array.from(fixture.state.selectedRefs), ['ref.1']);
		assert.equal(fixture.selectionChangedCalls, 1);

		checkboxInput.dispatchEvent({
			type: 'change',
			target: { checked: false },
		});
		assert.deepEqual(Array.from(fixture.state.selectedRefs), []);

		row.dispatchEvent({ type: 'dblclick' });
		assert.equal(fixture.openJsonCalls, 1);
	});

	it('ignores row clicks from interactive controls', async function () {
		const sandbox = await loadPanelModule('admin/tab/panels/messages/render.table.js');
		const moduleApi = sandbox.window.MsghubAdminTabMessagesRenderTable;
		const fixture = createFixture();
		const renderer = moduleApi.createTableRenderer(fixture.options);
		const row = renderer.renderRows([buildMessage()])[0];
		const target = {
			closest(selector) {
				return selector.includes('input') ? {} : null;
			},
		};

		row.dispatchEvent({ type: 'click', target });
		assert.equal(fixture.selectionChangedCalls, 0);
		assert.equal(fixture.state.selectedRefs.size, 0);
	});
});
