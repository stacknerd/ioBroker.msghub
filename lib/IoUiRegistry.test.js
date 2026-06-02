'use strict';

const { expect } = require('chai');
const { uiRegistry } = require('./IoUiRegistry');

describe('IoUiRegistry', () => {
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
			expect(panel.description).to.be.a('string').and.not.equal('');
			expect(panel.surface).to.equal(undefined);
			expect(panel.category).to.be.a('string').and.not.equal('');
			expect(panel.ui).to.equal(undefined);
			expect(Object.isFrozen(panel)).to.equal(true);

			if (panel.app !== undefined) {
				expect(panel.app).to.be.an('object');
				expect(panel.app.name).to.be.a('string').and.not.equal('');
				expect(panel.app.url).to.be.a('string').and.match(/^\?panel=tab-/);
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
			expect(panel.ui).to.equal(undefined);
		}
	});

	it('ships web and messagesSingle as pure compositions without composition-level app metadata', () => {
		expect(uiRegistry.compositions.messagesSingle).to.include({
			id: 'messagesSingle',
			layout: 'single',
			defaultPanel: 'messages',
		});
		expect(uiRegistry.compositions.messagesSingle.panels).to.deep.equal([
			{ type: 'corePanel', panelId: 'messages' },
		]);

		expect(uiRegistry.compositions.web).to.include({
			id: 'web',
			layout: 'tabs',
			defaultPanel: 'messages',
			deviceMode: 'pc',
		});
		expect(uiRegistry.compositions.web.app).to.equal(undefined);
		expect(uiRegistry.compositions.messagesSingle.app).to.equal(undefined);
	});
});
