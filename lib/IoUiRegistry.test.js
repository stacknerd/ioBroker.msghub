'use strict';

const { expect } = require('chai');
const fs = require('node:fs/promises');
const path = require('node:path');

const { uiRegistry } = require('./IoUiRegistry');

describe('IoUiRegistry', () => {
	const repoRoot = path.resolve(__dirname, '..');

	it('exports a consistent frozen registry', async () => {
		expect(uiRegistry).to.be.an('object');
		expect(Object.isFrozen(uiRegistry)).to.equal(true);
		expect(Object.isFrozen(uiRegistry.panels)).to.equal(true);
		expect(Object.isFrozen(uiRegistry.compositions)).to.equal(true);

		const panelIds = Object.keys(uiRegistry.panels);
		expect(panelIds).to.include.members(['messages', 'plugins']);
		expect(panelIds).to.not.include('stats');

		for (const panelId of panelIds) {
			const panel = uiRegistry.panels[panelId];
			expect(panel.id).to.equal(panelId);
			expect(panel.id.startsWith('tab-')).to.equal(false);
			expect(panel.label).to.be.a('string').and.not.equal('');
			expect(panel.surface).to.equal(undefined);
			expect(panel.category).to.be.a('string').and.not.equal('');
			expect(panel.ui).to.be.an('object');
			expect(panel.ui.kind).to.equal('core');
			expect(panel.ui.loader).to.equal('globals');
			expect(panel.ui.initGlobal).to.be.a('string').and.not.equal('');
			expect(panel.ui.css).to.be.an('array');
			expect(panel.ui.js).to.be.an('array');
			expect(Object.isFrozen(panel)).to.equal(true);
			expect(Object.isFrozen(panel.ui)).to.equal(true);
			expect(Object.isFrozen(panel.ui.css)).to.equal(true);
			expect(Object.isFrozen(panel.ui.js)).to.equal(true);

			if (panel.app !== undefined) {
				expect(panel.app).to.be.an('object');
				expect(panel.app.name).to.be.a('string').and.not.equal('');
				expect(panel.app.url).to.be.a('string').and.match(/^\?panel=tab-/);
			}

			for (const asset of [...panel.ui.css, ...panel.ui.js]) {
				const fullPath = path.join(repoRoot, 'admin', String(asset));
				try {
					await fs.access(fullPath);
				} catch {
					expect.fail(`missing panel asset: ${asset}`);
				}
			}
		}

		for (const [compositionId, composition] of Object.entries(uiRegistry.compositions)) {
			expect(composition.id).to.equal(compositionId);
			expect(['tabs', 'single']).to.include(composition.layout);
			expect(composition.panels).to.be.an('array').and.not.empty;
			expect(composition.defaultPanel).to.be.a('string').and.not.equal('');
		}
	});

	it('keeps plugin-owned panels out of uiRegistry.panels', () => {
		const adminTab = uiRegistry.compositions.adminTab;
		const pluginEntry = adminTab.panels.find(p => p && typeof p === 'object' && p.type === 'pluginPanel');
		expect(pluginEntry).to.deep.equal({
			type: 'pluginPanel',
			pluginType: 'IngestStates',
			instanceId: 0,
			panelId: 'presets',
		});
		expect(Object.isFrozen(pluginEntry)).to.equal(true);

		for (const panel of Object.values(uiRegistry.panels)) {
			expect(panel.ui?.kind).to.equal('core');
		}
	});

	it('ships the web composition app exception and messages single composition', () => {
		expect(uiRegistry.compositions.messagesSingle).to.include({
			id: 'messagesSingle',
			layout: 'single',
			defaultPanel: 'messages',
		});
		expect(uiRegistry.compositions.messagesSingle.panels).to.deep.equal(['messages']);

		expect(uiRegistry.compositions.web).to.include({
			id: 'web',
			layout: 'tabs',
			defaultPanel: 'messages',
			deviceMode: 'pc',
		});
		expect(uiRegistry.compositions.web.app).to.include({
			name: 'msghub.i18n.core.admin.webRoot.app.name',
			shortName: 'msghub.i18n.core.admin.webRoot.app.shortName',
			url: '?composition=web',
			display: 'standalone',
			themeColor: '#1f6a53',
			backgroundColor: '#ffffff',
		});
	});
});
