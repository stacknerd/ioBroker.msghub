/* eslint-env mocha */
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readRepoFile } = require('./_test.utils');

describe('admin/tab/globals.js', function () {
	it('binds win and io from window', async function () {
		const source = await readRepoFile('admin/tab/globals.js');
		const script = `${source}\nwindow.__globals = { win, io };`;
		const sandbox = {
			window: { io: { connected: true } },
		};

		vm.runInNewContext(script, sandbox, { filename: 'admin/tab/globals.js' });

		assert.equal(sandbox.window.__globals.win, sandbox.window);
		assert.equal(sandbox.window.__globals.io, sandbox.window.io);
	});

	it('keeps io undefined when window.io is not present', async function () {
		const source = await readRepoFile('admin/tab/globals.js');
		const script = `${source}\nwindow.__globals = { io };`;
		const sandbox = { window: {} };

		vm.runInNewContext(script, sandbox, { filename: 'admin/tab/globals.js' });

		assert.equal(sandbox.window.__globals.io, undefined);
	});
});
