'use strict';

const { expect } = require('chai');

const WebExtensionEntry = require('./web.js');

describe('web.js entry', () => {
	it('uses the production MessageHub mount prefix', () => {
		const entry = new WebExtensionEntry(
			null,
			null,
			{ log: null },
			{ _id: 'system.adapter.msghub.0' },
			{
				_router: { stack: [] },
				use(handler) {
					this._router.stack.push({ handle: handler });
				},
			},
		);

		expect(entry.extension.routePath).to.equal('/MessageHub/0/test');
	});

	it('calls waitForReady immediately after synchronous route installation', done => {
		const entry = new WebExtensionEntry(
			null,
			null,
			{ log: null },
			{ _id: 'system.adapter.msghub.0' },
			{
				_router: { stack: [] },
				use(handler) {
					this._router.stack.push({ handle: handler });
				},
			},
		);

		entry.waitForReady(instance => {
			expect(instance).to.equal(entry);
			done();
		});
	});

	it('unload removes the installed middleware', async () => {
		const app = {
			_router: { stack: [] },
			use(handler) {
				this._router.stack.push({ handle: handler });
			},
		};

		const entry = new WebExtensionEntry(null, null, { log: null }, { _id: 'system.adapter.msghub.0' }, app);
		expect(app._router.stack).to.have.length(1);

		await entry.unload();
		expect(app._router.stack).to.have.length(0);
	});
});
