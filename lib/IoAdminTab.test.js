'use strict';

const { expect } = require('chai');

const { IoAdminTab } = require('./IoAdminTab');

describe('IoAdminTab IngestStates bulk apply canonicalization', () => {
	function createAdminTab() {
		const adapter = {
			namespace: 'msghub.0',
			log: { warn: () => undefined, info: () => undefined, debug: () => undefined, error: () => undefined },
		};
		return new IoAdminTab(adapter, null);
	}

	it('moves known dot keys to nested objects and removes them', () => {
		const tab = createAdminTab();

		const out = tab._canonicalizeIngestStatesCustom({
			enabled: true,
			mode: 'threshold',
			'thr.mode': 'gt',
			'thr.value': 10,
		});

		expect(out).to.deep.equal({
			enabled: true,
			mode: 'threshold',
			thr: { mode: 'gt', value: 10 },
		});
	});

	it('keeps nested objects on conflict (nested wins)', () => {
		const tab = createAdminTab();

		const out = tab._canonicalizeIngestStatesCustom({
			enabled: true,
			mode: 'threshold',
			thr: { mode: 'gt', value: 21 },
			'thr.mode': 'lt',
			'thr.value': 10,
		});

		expect(out).to.deep.equal({
			enabled: true,
			mode: 'threshold',
			thr: { mode: 'gt', value: 21 },
		});
	});

	it('does not touch unrelated dotted keys', () => {
		const tab = createAdminTab();

		const out = tab._canonicalizeIngestStatesCustom({
			enabled: true,
			mode: 'threshold',
			'foo.bar': 1,
			'thr.mode': 'gt',
			thr: { value: 5 },
		});

		expect(out).to.deep.equal({
			enabled: true,
			mode: 'threshold',
			'foo.bar': 1,
			thr: { mode: 'gt', value: 5 },
		});
	});
});

