'use strict';

const { expect } = require('chai');

const { createI18nReporter } = require('./i18nReporter');

describe('i18nReporter', () => {
	function makeAdapter() {
		const calls = [];
		const adapter = {
			namespace: 'msghub.0',
			log: { debug: () => undefined },
			async writeFileAsync(metaId, fileName, data) {
				calls.push({ metaId, fileName, data });
			},
		};
		return { adapter, calls };
	}

	it('tracks used keys and flags missing keys when output equals key (non-en)', async () => {
		const { adapter, calls } = makeAdapter();
		const r = createI18nReporter(adapter, { enabled: true, lang: 'de', writeIntervalMs: 1_000_000 });

		const t = r.wrapTranslate((key, arg) => {
			if (key === 'HELLO') {
				return `Hallo ${arg}`;
			}
			return String(key);
		});

		expect(t('HELLO', 'Welt')).to.equal('Hallo Welt');
		expect(t('MISSING_KEY')).to.equal('MISSING_KEY');
		expect(t('MISSING_KEY')).to.equal('MISSING_KEY');

		const stats = r.getStats();
		expect(stats.usedCalls).to.equal(3);
		expect(stats.missingCalls).to.equal(2);

		await r.flush();
		expect(calls).to.have.length(1);

		const report = JSON.parse(calls[0].data);
		expect(report.used).to.have.property('HELLO');
		expect(report.used).to.have.property('MISSING_KEY');
		expect(report.missing).to.have.property('MISSING_KEY');
		expect(report.missing).to.not.have.property('HELLO');
	});

	it('does not flag missing keys in en', async () => {
		const { adapter, calls } = makeAdapter();
		const r = createI18nReporter(adapter, { enabled: true, lang: 'en', writeIntervalMs: 1_000_000 });
		const t = r.wrapTranslate(key => String(key));

		t('OK');
		t('MISSING_KEY');
		await r.flush();

		const report = JSON.parse(calls[0].data);
		expect(report.used).to.have.property('OK');
		expect(report.used).to.have.property('MISSING_KEY');
		expect(Object.keys(report.missing)).to.have.length(0);
	});
});

