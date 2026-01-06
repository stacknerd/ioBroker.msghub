'use strict';

const { expect } = require('chai');

const { IoAdminTab } = require('./IoAdminTab');

describe('IoAdminTab IngestStates bulk apply sanitization', () => {
	function createAdminTab() {
		const adapter = {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
		return new IoAdminTab(adapter, null);
	}

	it('drops dot keys and nested objects', () => {
		const tab = createAdminTab();

		const out = tab._sanitizeIngestStatesCustom({
			enabled: true,
			mode: 'threshold',
			'thr-mode': 'gt',
			'thr-value': 10,
			'thr.mode': 'lt',
			thr: { mode: 'outside' },
			'foo.bar': 1,
		});

		expect(out).to.deep.equal({
			enabled: true,
			mode: 'threshold',
			'thr-mode': 'gt',
			'thr-value': 10,
		});
	});
});
